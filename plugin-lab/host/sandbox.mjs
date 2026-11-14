/**
 * MailChat 零信任插件沙盒运行时 (Zero-Trust Plugin Sandbox)
 *
 * 原型实现采用 Node 内置 `node:vm` 冻结上下文 + `codeGeneration: { strings: false, wasm: false }`；
 * 正式接入 `src-tauri` 时，1:1 映射为内嵌 `rquickjs` / `boa_engine` 独立 Isolate（无需本机安装 Node）。
 */

import vm from "node:vm";

const DEFAULT_LOAD_TIMEOUT_MS = 1000;
const DEFAULT_HOOK_TIMEOUT_MS = 2500;
const MAX_KV_BYTES_PER_PLUGIN = 1024 * 1024; // 1 MB 配额

/**
 * 将标准无依赖 ES2022 模块（仅含 export function / export async function / export const）
 * 转换为可在受限 VM Context 中直接求值的闭包脚本（无需 --experimental-vm-modules）。
 */
export function transformEsmExports(source) {
  const exportedNames = new Set();
  let transformed = source;

  // 1. export async function foo(...) / export function foo(...)
  transformed = transformed.replace(
    /^\s*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    (_, asyncKw = "", fnName) => {
      exportedNames.add(fnName);
      return `${asyncKw}function ${fnName}(`;
    }
  );

  // 2. export const/let foo = ...
  transformed = transformed.replace(
    /^\s*export\s+(const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    (_, declKw, varName) => {
      exportedNames.add(varName);
      return `${declKw} ${varName} =`;
    }
  );

  // 3. export { a, b as c }
  const aliasPairs = [];
  transformed = transformed.replace(/^\s*export\s*\{([^}]+)\}\s*;?/gm, (_, body) => {
    for (const part of body.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) {
        aliasPairs.push([asMatch[2], asMatch[1]]);
      } else if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
        exportedNames.add(trimmed);
      }
    }
    return "";
  });

  // 4. export default ...
  let hasDefault = false;
  transformed = transformed.replace(/^\s*export\s+default\s+/gm, () => {
    hasDefault = true;
    return "const __mailchat_default_export__ = ";
  });

  const exportAssigns = [
    ...[...exportedNames].map((name) => `__exports.${name} = ${name};`),
    ...aliasPairs.map(([pub, local]) => `__exports.${pub} = ${local};`),
    ...(hasDefault
      ? [
          `if (__mailchat_default_export__ && typeof __mailchat_default_export__ === "object") { Object.assign(__exports, __mailchat_default_export__); }`,
        ]
      : []),
  ].join("\n  ");

  const wrapped = `(function() {\n"use strict";\nconst __exports = Object.create(null);\n${transformed}\n  ${exportAssigns}\n  return Object.freeze(__exports);\n})();`;
  return { wrapped, exportedNames: [...exportedNames, ...aliasPairs.map((p) => p[0])] };
}

/** 创建隔离且禁止 eval / Function 动态代码生成的 VM 实例并加载插件模块 */
export function loadPluginInSandbox(pluginId, sourceCode, filename = `${pluginId}/index.mjs`) {
  const { wrapped } = transformEsmExports(sourceCode);

  const safeGlobals = Object.freeze({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console: Object.freeze({
      log: () => {},
      warn: () => {},
      error: () => {},
    }),
  });

  const context = vm.createContext(
    {
      URL: safeGlobals.URL,
      URLSearchParams: safeGlobals.URLSearchParams,
      TextEncoder: safeGlobals.TextEncoder,
      TextDecoder: safeGlobals.TextDecoder,
      console: safeGlobals.console,
    },
    {
      name: `mailchat-plugin:${pluginId}`,
      codeGeneration: {
        strings: false, // V8 层硬性禁用 eval() 与 new Function()
        wasm: false,    // 禁用未授权 WebAssembly
      },
    }
  );

  // 移除 globalThis 上的潜在逃逸引用并冻结外层配置
  const hardenScript = new vm.Script(
    `"use strict"; delete globalThis.console; Object.freeze(URL.prototype);`
  );
  hardenScript.runInContext(context, { timeout: 200 });

  const script = new vm.Script(wrapped, { filename });
  const exportsObj = script.runInContext(context, {
    timeout: DEFAULT_LOAD_TIMEOUT_MS,
  });

  return { context, exportsObj };
}

/** 深拷贝并冻结传给插件沙盒的入参，防止插件篡改宿主内存对象或原型链 */
export function deepFreezeClone(value) {
  const cloned = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return freezeRecursive(cloned);
}

function freezeRecursive(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    freezeRecursive(obj[key]);
  }
  return obj;
}

/** 校验目标 URL 是否符合插件声明的域名白名单与反 SSRF 安全基线 */
export function assertUrlPermitted(rawUrl, permissions, pluginId) {
  const allowlist = Array.isArray(permissions?.network) ? permissions.network : [];
  if (allowlist.length === 0) {
    throw new Error(
      `[权限拒绝] 插件 "${pluginId}" 未声明 permissions.network，禁止调用 ctx.http.fetch`
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`[权限拒绝] 非法的请求 URL：${rawUrl}`);
  }

  const allowLan = Boolean(permissions?.allow_lan);
  const host = parsed.hostname.toLowerCase();

  if (parsed.protocol !== "https:" && !(allowLan && parsed.protocol === "http:")) {
    throw new Error(
      `[安全拦截] 插件 "${pluginId}" 仅允许发起 HTTPS 请求（当前协议：${parsed.protocol}）`
    );
  }

  if (!allowLan && isPrivateOrLoopbackHost(host)) {
    throw new Error(
      `[安全拦截] 禁止插件 "${pluginId}" 访问本机回环或内网私有地址（${host}）`
    );
  }

  const matched = allowlist.some((pattern) => {
    const p = String(pattern).trim().toLowerCase();
    if (!p || p === "*") return false; // 严禁全网通配符 '*'
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === p;
  });

  if (!matched) {
    throw new Error(
      `[权限拒绝] 域名 "${host}" 不在插件 "${pluginId}" 的 permissions.network 白名单 [${allowlist.join(", ")}] 内`
    );
  }

  return parsed;
}

function isPrivateOrLoopbackHost(host) {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  const m172 = host.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * 宿主侧盲注入 `{{secret:<slot>}}` 占位符
 * - 仅允许解析当前插件 `plugin.toml` -> `[secrets.<slot>]` 已声明的槽位
 * - 严禁跨插件读取，严禁读取 `mail_password` 或 `llm_*` 全局凭据
 */
function resolveSecretTemplates(inputStr, pluginId, declaredSecrets, vault) {
  if (typeof inputStr !== "string" || !inputStr.includes("{{secret:")) {
    return { resolved: inputStr, masked: inputStr, usedSlots: [] };
  }

  const usedSlots = [];
  let masked = inputStr;
  const resolved = inputStr.replace(/\{\{secret:([a-zA-Z0-9_-]+)\}\}/g, (_, slot) => {
    if (slot === "mail_password" || slot.startsWith("llm_")) {
      throw new Error(`[越权拦截] 插件 "${pluginId}" 严禁引用客户端核心凭据 "${slot}"`);
    }
    if (!declaredSecrets || !(slot in declaredSecrets)) {
      throw new Error(
        `[越权拦截] 插件 "${pluginId}" 使用了未在 plugin.toml [secrets.${slot}] 中声明的凭据槽`
      );
    }
    const vaultKey = `plugin:${pluginId}:${slot}`;
    const secretVal = vault.get(vaultKey);
    if (!secretVal) {
      throw new Error(
        `[凭据未就绪] 插件 "${pluginId}" 所需的加密凭据 "${slot}" (${vaultKey}) 尚未在保险箱配置`
      );
    }
    usedSlots.push(slot);
    masked = masked.replace(`{{secret:${slot}}}`, `<vault:${slot}>`);
    return secretVal;
  });

  return { resolved, masked, usedSlots };
}

/** 构建单次钩子执行的受控 Host Context，并收集执行审计轨迹 */
export function createHostContext({
  pluginId,
  manifest,
  configOverrides = {},
  vault,
  kvStore,
  recentMailsProvider,
  llmAdapter,
  httpTransport,
  dryRun = false,
}) {
  const permissions = manifest.permissions ?? {};
  const declaredSecrets = manifest.secrets ?? {};
  const logs = [];
  const outboundHttpCalls = [];

  // 合并默认配置与 config.toml 用户覆盖项
  const mergedConfig = {};
  if (manifest.config && typeof manifest.config === "object") {
    for (const [k, spec] of Object.entries(manifest.config)) {
      if (spec && typeof spec === "object" && "default" in spec) {
        mergedConfig[k] = spec.default;
      } else {
        mergedConfig[k] = spec;
      }
    }
  }
  Object.assign(mergedConfig, configOverrides);

  // 日志自动脱敏：防止任何已知 Vault 凭据意外出现在日志里
  const scrubSecrets = (text) => {
    let safe = String(text);
    for (const slot of Object.keys(declaredSecrets)) {
      const val = vault?.get(`plugin:${pluginId}:${slot}`);
      if (val && val.length >= 4 && safe.includes(val)) {
        safe = safe.split(val).join(`[REDACTED:${slot}]`);
      }
    }
    return safe;
  };

  const recordLog = (level, message, meta) => {
    logs.push({
      ts: new Date().toISOString(),
      pluginId,
      level,
      message: scrubSecrets(message),
      ...(meta ? { meta: JSON.parse(scrubSecrets(JSON.stringify(meta))) } : {}),
    });
  };

  const ensureKvPerm = () => {
    if (!permissions.kv_storage) {
      throw new Error(
        `[权限拒绝] 插件 "${pluginId}" 未声明 permissions.kv_storage = true，禁止访问 ctx.kv`
      );
    }
  };

  const nsPrefix = `${pluginId}:`;

  const ctx = deepFreezeClone({
    pluginId,
    dryRun,
    config: mergedConfig,
  });

  const fullCtx = Object.freeze({
    ...ctx,
    log: Object.freeze({
      info: (msg, meta) => recordLog("info", msg, meta),
      warn: (msg, meta) => recordLog("warn", msg, meta),
      error: (msg, meta) => recordLog("error", msg, meta),
    }),

    secrets: Object.freeze({
      has: (slot) => {
        const cleanSlot = String(slot ?? "").trim();
        if (!cleanSlot || !(cleanSlot in declaredSecrets)) {
          throw new Error(
            `[权限拒绝] 插件 "${pluginId}" 只能探测自身在 [secrets] 声明的凭据槽（请求了 "${cleanSlot}"）`
          );
        }
        return Boolean(vault?.get(`plugin:${pluginId}:${cleanSlot}`));
      },
    }),

    kv: Object.freeze({
      get: async (key) => {
        ensureKvPerm();
        const raw = kvStore.get(`${nsPrefix}${key}`);
        return raw === undefined ? null : JSON.parse(raw);
      },
      set: async (key, value) => {
        ensureKvPerm();
        if (dryRun) {
          recordLog("info", `[DryRun] 模拟写入 KV: ${key}`);
          return;
        }
        const serialized = JSON.stringify(value);
        let currentBytes = 0;
        for (const [k, v] of kvStore.entries()) {
          if (k.startsWith(nsPrefix) && k !== `${nsPrefix}${key}`) {
            currentBytes += Buffer.byteLength(k) + Buffer.byteLength(v);
          }
        }
        const nextBytes =
          currentBytes + Buffer.byteLength(`${nsPrefix}${key}`) + Buffer.byteLength(serialized);
        if (nextBytes > MAX_KV_BYTES_PER_PLUGIN) {
          throw new Error(
            `[配额超限] 插件 "${pluginId}" KV 存储超出上限 (${MAX_KV_BYTES_PER_PLUGIN} bytes)`
          );
        }
        kvStore.set(`${nsPrefix}${key}`, serialized);
      },
      delete: async (key) => {
        ensureKvPerm();
        if (!dryRun) kvStore.delete(`${nsPrefix}${key}`);
      },
      listKeys: async (prefix = "") => {
        ensureKvPerm();
        const out = [];
        for (const k of kvStore.keys()) {
          if (k.startsWith(nsPrefix)) {
            const shortKey = k.slice(nsPrefix.length);
            if (!prefix || shortKey.startsWith(prefix)) out.push(shortKey);
          }
        }
        return out.sort();
      },
    }),

    http: Object.freeze({
      fetch: async (rawUrl, options = {}) => {
        // 1. 先以安全占位值验证 URL 结构与白名单域名，杜绝通过凭据篡改 Hostname
        const probeUrl = String(rawUrl).replace(/\{\{secret:([a-zA-Z0-9_-]+)\}\}/g, "vault-token");
        assertUrlPermitted(probeUrl, permissions, pluginId);

        const method = String(options.method ?? "GET").toUpperCase();
        const rawHeaders = options.headers ?? {};
        const rawBody =
          options.body === undefined
            ? undefined
            : typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body);

        if (dryRun) {
          // DryRun 仅校验凭据引用合法性，不要求用户已填写真实凭据，也不发出真实外网请求
          validateSecretRefsOnly(String(rawUrl), pluginId, declaredSecrets);
          for (const v of Object.values(rawHeaders)) {
            validateSecretRefsOnly(String(v), pluginId, declaredSecrets);
          }
          if (rawBody) validateSecretRefsOnly(rawBody, pluginId, declaredSecrets);

          const maskedUrl = String(rawUrl).replace(
            /\{\{secret:([a-zA-Z0-9_-]+)\}\}/g,
            "<vault:$1>"
          );
          outboundHttpCalls.push({ method, url: maskedUrl, dryRun: true });
          return deepFreezeClone({
            status: 200,
            ok: true,
            headers: { "content-type": "application/json" },
            text: '{"ok":true,"dry_run":true}',
            json: { ok: true, dry_run: true },
          });
        }

        // 2. 真实运行态：执行宿主侧 DPAPI Vault 盲注入，并二次确认最终 URL 域名未发生漂移
        const urlInj = resolveSecretTemplates(String(rawUrl), pluginId, declaredSecrets, vault);
        assertUrlPermitted(urlInj.resolved, permissions, pluginId);

        const resolvedHeaders = {};
        const maskedHeaders = {};
        for (const [hk, hv] of Object.entries(rawHeaders)) {
          const hInj = resolveSecretTemplates(String(hv), pluginId, declaredSecrets, vault);
          resolvedHeaders[hk] = hInj.resolved;
          maskedHeaders[hk] = hInj.masked;
        }

        let resolvedBody;
        let maskedBody;
        if (rawBody !== undefined) {
          const bInj = resolveSecretTemplates(rawBody, pluginId, declaredSecrets, vault);
          resolvedBody = bInj.resolved;
          maskedBody = bInj.masked;
        }

        outboundHttpCalls.push({
          method,
          url: urlInj.masked,
          headers: maskedHeaders,
          bodyPreview: maskedBody ? maskedBody.slice(0, 240) : undefined,
          injectedSecrets: urlInj.usedSlots,
        });

        if (httpTransport) {
          const resp = await httpTransport({
            url: urlInj.resolved,
            method,
            headers: resolvedHeaders,
            body: resolvedBody,
            timeoutMs: Math.min(Number(options.timeoutMs) || 5000, 10000),
          });
          return deepFreezeClone(resp);
        }

        // 默认使用受超时控制的真实 fetch
        const timeoutMs = Math.min(Number(options.timeoutMs) || 5000, 10000);
        const res = await fetch(urlInj.resolved, {
          method,
          headers: resolvedHeaders,
          body: resolvedBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let parsedJson = null;
        try {
          parsedJson = JSON.parse(text);
        } catch {
          parsedJson = null;
        }
        const respHeaders = {};
        res.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });
        return deepFreezeClone({
          status: res.status,
          ok: res.ok,
          headers: respHeaders,
          text,
          json: parsedJson,
        });
      },
    }),

    mail: Object.freeze({
      queryRecent: async (query = {}) => {
        if (permissions.mail_access !== "read_recent") {
          throw new Error(
            `[权限拒绝] 插件 "${pluginId}" 未声明 permissions.mail_access = "read_recent"，禁止读取历史会话列表`
          );
        }
        if (!recentMailsProvider) return deepFreezeClone([]);
        const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
        const items = await recentMailsProvider({ ...query, limit });
        return deepFreezeClone(items);
      },
    }),

    llm: Object.freeze({
      complete: async (prompt, options = {}) => {
        if (!permissions.llm_access) {
          throw new Error(
            `[权限拒绝] 插件 "${pluginId}" 未声明 permissions.llm_access = true，禁止调用宿主大模型`
          );
        }
        if (dryRun || !llmAdapter) {
          return options.json ? '{"summary":"dry-run"}' : "[DryRun LLM Output]";
        }
        const res = await llmAdapter(String(prompt), options);
        return String(res);
      },
    }),
  });

  return { ctx: fullCtx, logs, outboundHttpCalls };
}

function validateSecretRefsOnly(str, pluginId, declaredSecrets) {
  str.replace(/\{\{secret:([a-zA-Z0-9_-]+)\}\}/g, (_, slot) => {
    if (slot === "mail_password" || slot.startsWith("llm_")) {
      throw new Error(`[越权拦截] 插件 "${pluginId}" 严禁引用客户端核心凭据 "${slot}"`);
    }
    if (!declaredSecrets || !(slot in declaredSecrets)) {
      throw new Error(
        `[越权拦截] 插件 "${pluginId}" 使用了未在 plugin.toml [secrets.${slot}] 中声明的凭据槽`
      );
    }
    return "";
  });
}

/** 带硬超时熔断的插件钩子调用器 */
export async function invokeSandboxHook(
  exportsObj,
  hookName,
  args,
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS
) {
  const fn = exportsObj[hookName];
  if (typeof fn !== "function") return undefined;

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`钩子 "${hookName}" 执行超时（超过 ${timeoutMs}ms 熔断上限）`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([Promise.resolve(fn(...args)), timeoutPromise]);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
  }
}
