/**
 * MailChat 插件五道安全与契约校验门禁 (5-Stage Verification Gate)
 *
 * 无论是用户拷入 `plugins/` 的现成插件，还是内置 AI 助手实时编写的插件，
 * 都必须 100% 通过此五道门禁后才允许挂载进邮件流水线。
 */

import { parseToml } from "./toml-lite.mjs";
import {
  createHostContext,
  deepFreezeClone,
  invokeSandboxHook,
  loadPluginInSandbox,
} from "./sandbox.mjs";

export const VALID_HOOKS = new Set([
  "onBeforeTriage",
  "onAfterTriage",
  "onBeforeSend",
  "onSchedule",
]);

const VALID_ACTIONS = new Set(["inbox", "archive", "block"]);

const FORBIDDEN_PATTERNS = [
  {
    code: "NO_EXTERNAL_IMPORT",
    regex: /^\s*import\s+[\s\S]*?\s+from\s+["'`]/m,
    message: "禁止使用外部模块 import ... from ...",
    fixHint: "请移除外部 import，插件必须为单文件零依赖 ES2022 模块，外部能力统一通过 ctx 调用。",
  },
  {
    code: "NO_DYNAMIC_IMPORT",
    regex: /\bimport\s*\(/,
    message: "禁止使用动态 import()",
    fixHint: "请移除动态 import()，所有逻辑直接写在 index.mjs 内。",
  },
  {
    code: "NO_COMMONJS_REQUIRE",
    regex: /\brequire\s*\(/,
    message: "禁止使用 CommonJS require()",
    fixHint: "请使用标准 export async function <hookName>(...)，并通过 ctx 调用宿主能力。",
  },
  {
    code: "NO_EVAL_OR_FUNCTION",
    regex: /\b(eval|Function)\s*\(/,
    message: "禁止使用 eval() 或 Function() 动态执行代码",
    fixHint: "请改用确定性的条件判断、正则或 JSON.parse 处理数据。",
  },
  {
    code: "NO_GLOBAL_ESCAPE",
    regex: /\b(process|XMLHttpRequest|WebSocket|Deno|Bun)\b|\bglobalThis\.fetch\b|__proto__|constructor\s*\.\s*constructor/,
    message: "检测到被禁止的全局逃逸标识符（process / globalThis.fetch / __proto__ 等）",
    fixHint: "网络请求请改用 ctx.http.fetch(url, options)，配置读取请改用 ctx.config。",
  },
  {
    code: "NO_HARDCODED_SECRET",
    regex: /\b(sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/,
    message: "检测到疑似硬编码的明文 API Key",
    fixHint: "严禁在插件代码中硬编码任何密钥！请在 plugin.toml 声明 [secrets.<slot>] 并使用 {{secret:<slot>}} 盲注入。",
  },
];

/** 剥离 JS 注释但保留字符串内容（用于静态扫描避免注释误报，同时仍扫描字符串中的硬编码密钥与模板） */
function stripJsComments(code) {
  return code.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted) => (quoted ? quoted : " ")
  );
}

/**
 * 执行完整五道校验门禁
 * @returns {Promise<{ ok: boolean, manifest: object | null, diagnostics: Array<{gate: string, code: string, message: string, fixHint: string}>, smokeResults: object }>}
 */
export async function validatePluginPackage({
  pluginTomlRaw,
  indexMjsRaw,
  expectedDirId = null,
  customSample = null,
}) {
  const diagnostics = [];
  const addDiag = (gate, code, message, fixHint) => {
    diagnostics.push({ gate, code, message, fixHint });
  };

  // =========================================================================
  // Gate 1: Manifest Schema & ID Sanitization (声明式清单校验)
  // =========================================================================
  let manifest = null;
  try {
    manifest = parseToml(pluginTomlRaw);
  } catch (err) {
    addDiag(
      "Gate1:Manifest",
      "TOML_PARSE_ERROR",
      `plugin.toml 语法解析失败：${err.message}`,
      "检查 plugin.toml 的括号、引号闭合与键值格式。"
    );
    return { ok: false, manifest: null, diagnostics, smokeResults: {} };
  }

  const meta = manifest?.plugin;
  if (!meta || typeof meta !== "object") {
    addDiag(
      "Gate1:Manifest",
      "MISSING_PLUGIN_SECTION",
      "缺少 [plugin] 元数据段",
      "在 plugin.toml 顶部声明 [plugin] 段，包含 id、name、version、description。"
    );
    return { ok: false, manifest, diagnostics, smokeResults: {} };
  }

  const pluginId = String(meta.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(pluginId)) {
    addDiag(
      "Gate1:Manifest",
      "INVALID_PLUGIN_ID",
      `非法的 plugin.id "${pluginId}"`,
      "plugin.id 必须为 2~49 位小写字母、数字与连字符（kebab-case），如 'invoice-feishu-sync'。"
    );
  }
  if (expectedDirId && pluginId && expectedDirId !== pluginId) {
    addDiag(
      "Gate1:Manifest",
      "DIR_ID_MISMATCH",
      `目录名 "${expectedDirId}" 与 plugin.toml 中的 id "${pluginId}" 不一致`,
      `将 plugin.id 统一为 "${expectedDirId}"。`
    );
  }
  if (!String(meta.name ?? "").trim()) {
    addDiag("Gate1:Manifest", "MISSING_NAME", "缺少 plugin.name", "填写简明中文或英文插件名称。");
  }
  if (!/^\d+\.\d+\.\d+/.test(String(meta.version ?? "").trim())) {
    addDiag(
      "Gate1:Manifest",
      "INVALID_VERSION",
      `非法的版本号 "${meta.version ?? ""}"`,
      '使用标准语义化版本号，如 version = "0.1.0"。'
    );
  }

  const perms = manifest.permissions ?? {};
  const declaredHooks = Array.isArray(perms.hooks) ? perms.hooks : [];
  if (declaredHooks.length === 0) {
    addDiag(
      "Gate1:Manifest",
      "EMPTY_HOOKS",
      "permissions.hooks 至少需声明一个挂载钩子",
      '在 [permissions] 下声明 hooks = ["onBeforeTriage"] 等标准钩子。'
    );
  }
  for (const h of declaredHooks) {
    if (!VALID_HOOKS.has(h)) {
      addDiag(
        "Gate1:Manifest",
        "UNKNOWN_HOOK",
        `未知的钩子名称 "${h}"`,
        `仅支持以下钩子：${[...VALID_HOOKS].join(", ")}。`
      );
    }
  }

  if (perms.network !== undefined) {
    if (!Array.isArray(perms.network)) {
      addDiag(
        "Gate1:Manifest",
        "INVALID_NETWORK_PERM",
        "permissions.network 必须是域名字符串数组",
        '示例：network = ["open.feishu.cn"]'
      );
    } else {
      for (const domain of perms.network) {
        const d = String(domain).trim();
        if (d === "*" || d.includes("://") || d.includes("/")) {
          addDiag(
            "Gate1:Manifest",
            "INVALID_NETWORK_DOMAIN",
            `非法的域名白名单项 "${d}"（禁止使用 '*' 通配或携带协议/路径）`,
            '请只填纯域名（如 "open.feishu.cn" 或 "*.feishu.cn"）。'
          );
        }
      }
    }
  }

  if (perms.mail_access !== undefined && !["current", "read_recent"].includes(perms.mail_access)) {
    addDiag(
      "Gate1:Manifest",
      "INVALID_MAIL_ACCESS",
      `非法的 permissions.mail_access "${perms.mail_access}"`,
      'mail_access 仅允许 "current"（默认）或 "read_recent"。'
    );
  }

  const declaredSecrets = manifest.secrets ?? {};
  for (const [slot, spec] of Object.entries(declaredSecrets)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/.test(slot)) {
      addDiag(
        "Gate1:Manifest",
        "INVALID_SECRET_SLOT",
        `非法的凭据槽名称 "${slot}"`,
        "凭据槽名称只能包含字母、数字、下划线或连字符。"
      );
    }
    if (slot === "mail_password" || slot.startsWith("llm_")) {
      addDiag(
        "Gate1:Manifest",
        "RESERVED_SECRET_SLOT",
        `禁止使用系统保留凭据名 "${slot}"`,
        "请使用插件业务专属槽名，如 webhook_token 或 api_token。"
      );
    }
    if (!spec || typeof spec !== "object" || !String(spec.label ?? "").trim()) {
      addDiag(
        "Gate1:Manifest",
        "MISSING_SECRET_LABEL",
        `[secrets.${slot}] 缺少用户可读的 label 说明`,
        `为 [secrets.${slot}] 补充 label = "..." 与 hint = "..."，以便唤起本地 DPAPI 凭据输入卡。`
      );
    }
  }

  if (manifest.schedule) {
    const sch = manifest.schedule;
    const hasInterval = typeof sch.interval_secs === "number" && sch.interval_secs >= 60;
    const hasDaily = typeof sch.daily_at === "string" && /^\d{2}:\d{2}$/.test(sch.daily_at);
    if (!hasInterval && !hasDaily) {
      addDiag(
        "Gate1:Manifest",
        "INVALID_SCHEDULE",
        "[schedule] 必须指定 interval_secs (>= 60) 或 daily_at ('HH:MM')",
        '示例：interval_secs = 3600 或 daily_at = "18:00"。'
      );
    }
  }

  // =========================================================================
  // Gate 2: Static Security & Forbidden Global Scan (静态安全扫描)
  // =========================================================================
  if (typeof indexMjsRaw !== "string" || !indexMjsRaw.trim()) {
    addDiag("Gate2:Security", "EMPTY_ENTRY", "index.mjs 内容为空", "编写并导出声明的钩子函数。");
    return { ok: false, manifest, diagnostics, smokeResults: {} };
  }

  const codeNoComments = stripJsComments(indexMjsRaw);
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.regex.test(codeNoComments)) {
      addDiag("Gate2:Security", rule.code, rule.message, rule.fixHint);
    }
  }

  // =========================================================================
  // Gate 3: Capability Consistency Audit (代码调用与声明权限一致性审计)
  // =========================================================================
  if (/\bctx\.http\.fetch\s*\(/.test(codeNoComments)) {
    if (!Array.isArray(perms.network) || perms.network.length === 0) {
      addDiag(
        "Gate3:Capability",
        "UNDECLARED_NETWORK_CALL",
        "代码中调用了 ctx.http.fetch，但未在 [permissions].network 声明目标域名白名单",
        '在 plugin.toml 的 [permissions] 中添加 network = ["目标域名"]。'
      );
    }
  }

  if (/\bctx\.kv\.(get|set|delete|listKeys)\s*\(/.test(codeNoComments) && !perms.kv_storage) {
    addDiag(
      "Gate3:Capability",
      "UNDECLARED_KV_ACCESS",
      "代码中调用了 ctx.kv，但未声明 permissions.kv_storage = true",
      "在 [permissions] 中补充 kv_storage = true。"
    );
  }

  if (/\bctx\.mail\.queryRecent\s*\(/.test(codeNoComments) && perms.mail_access !== "read_recent") {
    addDiag(
      "Gate3:Capability",
      "UNDECLARED_MAIL_HISTORY_ACCESS",
      '代码中调用了 ctx.mail.queryRecent，但未声明 permissions.mail_access = "read_recent"',
      '在 [permissions] 中补充 mail_access = "read_recent"。'
    );
  }

  if (/\bctx\.llm\.complete\s*\(/.test(codeNoComments) && !perms.llm_access) {
    addDiag(
      "Gate3:Capability",
      "UNDECLARED_LLM_ACCESS",
      "代码中调用了 ctx.llm.complete，但未声明 permissions.llm_access = true",
      "在 [permissions] 中补充 llm_access = true。"
    );
  }

  // 扫描所有 {{secret:xxx}} 与 ctx.secrets.has("xxx") 是否均已在 [secrets] 声明
  for (const m of codeNoComments.matchAll(/\{\{secret:([a-zA-Z0-9_-]+)\}\}/g)) {
    const slot = m[1];
    if (!(slot in declaredSecrets)) {
      addDiag(
        "Gate3:Capability",
        "UNDECLARED_SECRET_TEMPLATE",
        `代码中使用了模板 {{secret:${slot}}}，但未在 plugin.toml 声明 [secrets.${slot}]`,
        `在 plugin.toml 中添加 [secrets.${slot}] 段（含 label 与 hint）。`
      );
    }
  }
  for (const m of codeNoComments.matchAll(/\bctx\.secrets\.has\s*\(\s*["'`]([a-zA-Z0-9_-]+)["'`]\s*\)/g)) {
    const slot = m[1];
    if (!(slot in declaredSecrets)) {
      addDiag(
        "Gate3:Capability",
        "UNDECLARED_SECRET_HAS",
        `代码中探测了 ctx.secrets.has("${slot}")，但未在 plugin.toml 声明 [secrets.${slot}]`,
        `在 plugin.toml 中添加 [secrets.${slot}] 段。`
      );
    }
  }

  if (manifest.schedule && !declaredHooks.includes("onSchedule")) {
    addDiag(
      "Gate3:Capability",
      "SCHEDULE_HOOK_MISSING",
      '配置了 [schedule]，但未在 permissions.hooks 中包含 "onSchedule"',
      '将 "onSchedule" 加入 permissions.hooks 数组。'
    );
  }

  if (diagnostics.length > 0) {
    return { ok: false, manifest, diagnostics, smokeResults: {} };
  }

  // =========================================================================
  // Gate 4: Sandbox Compile & Export Contract (沙盒加载与钩子导出检查)
  // =========================================================================
  let exportsObj;
  try {
    const loaded = loadPluginInSandbox(pluginId, indexMjsRaw);
    exportsObj = loaded.exportsObj;
  } catch (err) {
    addDiag(
      "Gate4:SandboxLoad",
      "SANDBOX_LOAD_ERROR",
      `沙盒编译或初始化失败：${err.message}`,
      "检查 JS 语法错误、顶层未定义变量或死循环。"
    );
    return { ok: false, manifest, diagnostics, smokeResults: {} };
  }

  for (const hook of declaredHooks) {
    if (typeof exportsObj[hook] !== "function") {
      addDiag(
        "Gate4:SandboxLoad",
        "MISSING_HOOK_EXPORT",
        `plugin.toml 声明了钩子 "${hook}"，但 index.mjs 未通过 export async function ${hook} 导出该函数`,
        `在 index.mjs 中补充 export async function ${hook}(...) { ... }。`
      );
    }
  }

  for (const expKey of Object.keys(exportsObj)) {
    if (VALID_HOOKS.has(expKey) && !declaredHooks.includes(expKey)) {
      addDiag(
        "Gate4:SandboxLoad",
        "UNDECLARED_HOOK_EXPORT",
        `index.mjs 导出了钩子 "${expKey}"，但未在 permissions.hooks 中声明`,
        `在 [permissions].hooks 中补充 "${expKey}" 或移除未授权钩子。`
      );
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, manifest, diagnostics, smokeResults: {} };
  }

  // =========================================================================
  // Gate 5: Dry-Run Smoke Test (隔离干跑冒烟与返回值契约校验)
  // =========================================================================
  const mockVault = new Map();
  for (const slot of Object.keys(declaredSecrets)) {
    mockVault.set(`plugin:${pluginId}:${slot}`, "dryrun_mock_secret_token_123456");
  }
  const mockKv = new Map();

  const sampleMail = deepFreezeClone({
    id: 9001,
    messageId: "<smoke-test@mailchat.local>",
    peer: customSample?.mail?.fromAddr ?? "billing@vendor.example.com",
    isGroup: false,
    fromAddr: customSample?.mail?.fromAddr ?? "billing@vendor.example.com",
    fromName: customSample?.mail?.fromName ?? "示例服务商",
    toAddrs: ["me@mailchat.local"],
    subject: customSample?.mail?.subject ?? "【电子发票】您的云服务月度账单 ¥1,280.00（验证码 639204）",
    body: customSample?.mail?.body ?? "您好，本月增值税电子普通发票已开具，价税合计 ¥1280.00，提取码 639204。",
    bodyFull:
      customSample?.mail?.bodyFull ??
      "您好，本月增值税电子普通发票已开具，发票代码 011002300111，价税合计 ¥1280.00，提取码 639204。",
    date: Math.floor(Date.now() / 1000),
    headers: { "x-mailer": "MailChat-SmokeTest" },
    tags: [],
    metadata: {},
  });

  const sampleVerdict = deepFreezeClone({
    action: "archive",
    category: "账单",
    summary: "云服务月度电子发票 ¥1,280.00",
    reason: "电子发票通知",
    extractedCode: "639204",
    suggestedReply: "",
  });

  const sampleDraft = deepFreezeClone({
    peer: "partner@client.example.com",
    isGroup: false,
    to: ["partner@client.example.com"],
    subject: "Re: 项目进度确认",
    body: "收到，我们今天下午同步测试报告。",
    headers: {},
  });

  const sampleTick = deepFreezeClone({
    now: Math.floor(Date.now() / 1000),
    isoTime: new Date().toISOString(),
    trigger: "manual",
  });

  const smokeResults = {};

  for (const hook of declaredHooks) {
    const { ctx, logs, outboundHttpCalls } = createHostContext({
      pluginId,
      manifest,
      vault: mockVault,
      kvStore: mockKv,
      recentMailsProvider: async () => [sampleMail],
      dryRun: true,
    });

    try {
      let ret;
      if (hook === "onBeforeTriage") {
        ret = await invokeSandboxHook(exportsObj, hook, [sampleMail, ctx], 1500);
        if (ret !== undefined) {
          if (typeof ret !== "object" || ret === null) {
            throw new Error("onBeforeTriage 返回值必须为对象或 undefined");
          }
          if (ret.decision && !["continue", "short_circuit"].includes(ret.decision)) {
            throw new Error(`非法的 decision 值 "${ret.decision}"`);
          }
          if (ret.decision === "short_circuit") {
            if (!ret.verdict || !VALID_ACTIONS.has(ret.verdict.action)) {
              throw new Error('decision = "short_circuit" 时必须提供合法的 verdict.action ("inbox"|"archive"|"block")');
            }
          }
        }
      } else if (hook === "onAfterTriage") {
        ret = await invokeSandboxHook(exportsObj, hook, [sampleMail, sampleVerdict, ctx], 1500);
        if (ret !== undefined && (typeof ret !== "object" || ret === null)) {
          throw new Error("onAfterTriage 返回值必须为对象或 undefined");
        }
        if (ret?.overrideVerdict?.action && !VALID_ACTIONS.has(ret.overrideVerdict.action)) {
          throw new Error(`非法的 overrideVerdict.action "${ret.overrideVerdict.action}"`);
        }
      } else if (hook === "onBeforeSend") {
        ret = await invokeSandboxHook(exportsObj, hook, [sampleDraft, ctx], 1500);
        if (ret !== undefined && (typeof ret !== "object" || ret === null)) {
          throw new Error("onBeforeSend 返回值必须为对象或 undefined");
        }
      } else if (hook === "onSchedule") {
        ret = await invokeSandboxHook(exportsObj, hook, [sampleTick, ctx], 1500);
        if (ret !== undefined && (typeof ret !== "object" || ret === null)) {
          throw new Error("onSchedule 返回值必须为对象或 undefined");
        }
      }
      smokeResults[hook] = { ok: true, output: ret ?? null, logs, outboundHttpCalls };
    } catch (err) {
      addDiag(
        "Gate5:DryRun",
        "SMOKE_TEST_FAILED",
        `钩子 "${hook}" 冒烟干跑失败：${err.message}`,
        `检查 "${hook}" 中对空字段的防御性判空、权限声明或返回结构。`
      );
    }
  }

  return {
    ok: diagnostics.length === 0,
    manifest,
    diagnostics,
    smokeResults,
  };
}
