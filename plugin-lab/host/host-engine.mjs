/**
 * MailChat 插件宿主编排引擎 (Plugin Registry, Hot-Reloader & Mail Pipeline Orchestrator)
 *
 * 完整复现真实接入 `src-tauri` 后的插件发现、五道门禁加载、Vault 凭据映射与四级流水线调度。
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  createHostContext,
  deepFreezeClone,
  invokeSandboxHook,
  loadPluginInSandbox,
} from "./sandbox.mjs";
import { validatePluginPackage } from "./validator.mjs";

export class MockVault {
  constructor(initialEntries = {}) {
    this.entries = new Map(Object.entries(initialEntries));
  }

  get(key) {
    const clean = String(key).trim().replace(/^secret:/, "");
    return this.entries.get(clean) ?? null;
  }

  set(key, value) {
    const clean = String(key).trim().replace(/^secret:/, "");
    if (!value || !String(value).trim()) {
      this.entries.delete(clean);
    } else {
      this.entries.set(clean, String(value).trim());
    }
  }

  has(key) {
    return Boolean(this.get(key));
  }
}

export class PluginHostEngine {
  constructor({
    pluginsDir,
    vault = new MockVault(),
    httpTransport = null,
    llmAdapter = null,
  }) {
    this.pluginsDir = pluginsDir;
    this.vault = vault;
    this.httpTransport = httpTransport;
    this.llmAdapter = llmAdapter;

    /** @type {Map<string, object>} */
    this.registry = new Map();
    /** @type {Map<string, string>} */
    this.kvStore = new Map();
    /** @type {Array<object>} */
    this.recentMails = [];
    /** @type {Map<string, { enabled?: boolean, priority?: number, config?: object }>} */
    this.declarativeOverrides = new Map();
  }

  /** 应用来自 config.toml [[plugins]] 的声明式开关与参数覆盖 */
  setDeclarativeOverrides(pluginSpecs = []) {
    this.declarativeOverrides.clear();
    for (const spec of pluginSpecs) {
      if (spec?.id) {
        this.declarativeOverrides.set(spec.id, spec);
      }
    }
  }

  /** 扫描并热加载 plugins/ 目录下的全部插件包 */
  async loadAllFromDisk() {
    this.registry.clear();
    let entries = [];
    try {
      entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
    } catch {
      return { loaded: [], rejected: [] };
    }

    const loaded = [];
    const rejected = [];

    for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory()) continue;
      const dirId = dirent.name;
      const pkgDir = path.join(this.pluginsDir, dirId);
      const tomlPath = path.join(pkgDir, "plugin.toml");
      const entryPath = path.join(pkgDir, "index.mjs");

      try {
        const [pluginTomlRaw, indexMjsRaw] = await Promise.all([
          fs.readFile(tomlPath, "utf8"),
          fs.readFile(entryPath, "utf8"),
        ]);

        const report = await this.registerValidatedPackage({
          dirId,
          pkgDir,
          pluginTomlRaw,
          indexMjsRaw,
        });
        if (report.ok) {
          loaded.push(report.plugin);
        } else {
          rejected.push({ id: dirId, diagnostics: report.diagnostics });
        }
      } catch (err) {
        rejected.push({
          id: dirId,
          diagnostics: [
            {
              gate: "DiskRead",
              code: "MISSING_FILES",
              message: `读取插件目录 "${dirId}" 失败：${err.message}`,
              fixHint: "确保插件目录下同时包含 plugin.toml 与 index.mjs。",
            },
          ],
        });
      }
    }

    return { loaded, rejected };
  }

  /** 校验并在内存中注册单个插件（支持热替换） */
  async registerValidatedPackage({ dirId, pkgDir, pluginTomlRaw, indexMjsRaw, customSample = null }) {
    const check = await validatePluginPackage({
      pluginTomlRaw,
      indexMjsRaw,
      expectedDirId: dirId,
      customSample,
    });

    if (!check.ok) {
      return { ok: false, diagnostics: check.diagnostics };
    }

    const manifest = check.manifest;
    const pluginId = manifest.plugin.id;
    const { exportsObj } = loadPluginInSandbox(pluginId, indexMjsRaw);
    const override = this.declarativeOverrides.get(pluginId) ?? {};

    const record = {
      id: pluginId,
      name: manifest.plugin.name,
      version: manifest.plugin.version,
      description: manifest.plugin.description ?? "",
      author: manifest.plugin.author ?? "community",
      source: manifest.plugin.source ?? "prebuilt", // "prebuilt" | "agent"
      enabled: override.enabled ?? (manifest.plugin.enabled !== false),
      priority: override.priority ?? Number(manifest.plugin.priority ?? 100),
      pkgDir,
      manifest,
      exportsObj,
      configOverrides: override.config ?? {},
      smokeResults: check.smokeResults,
      faultCount: 0,
    };

    this.registry.set(pluginId, record);
    return {
      ok: true,
      plugin: record,
      secretPrompts: this.getMissingSecretPrompts(pluginId),
    };
  }

  /**
   * 原子写入新插件（例如内置 Agent 自动生成的插件）并即时热加载进运行时
   */
  async installAndHotLoad({ id, pluginTomlRaw, indexMjsRaw, customSample = null }) {
    // 落盘前先完整过一遍五道门禁，不合法绝不污染 plugins/ 目录
    const precheck = await validatePluginPackage({
      pluginTomlRaw,
      indexMjsRaw,
      expectedDirId: id,
      customSample,
    });
    if (!precheck.ok) {
      return { ok: false, diagnostics: precheck.diagnostics };
    }

    const pkgDir = path.join(this.pluginsDir, id);
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "plugin.toml"), pluginTomlRaw, "utf8");
    await fs.writeFile(path.join(pkgDir, "index.mjs"), indexMjsRaw, "utf8");

    return this.registerValidatedPackage({
      dirId: id,
      pkgDir,
      pluginTomlRaw,
      indexMjsRaw,
      customSample,
    });
  }

  /** 获取按 priority 排序的已启用插件列表 */
  getOrderedActivePlugins(hookName = null) {
    return [...this.registry.values()]
      .filter((p) => p.enabled)
      .filter((p) => !hookName || p.manifest.permissions?.hooks?.includes(hookName))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** 生成与 MailChat AgentWorkspace `InlineSecretVaultCard` 完全兼容的凭据提示卡描述 */
  getMissingSecretPrompts(pluginId) {
    const plugin = this.registry.get(pluginId);
    if (!plugin) return [];
    const declared = plugin.manifest.secrets ?? {};
    const prompts = [];
    for (const [slot, spec] of Object.entries(declared)) {
      const vaultKey = `plugin:${pluginId}:${slot}`;
      const configured = this.vault.has(vaultKey);
      if (!configured) {
        prompts.push({
          key: vaultKey,
          label: `${plugin.name} · ${spec.label}`,
          hint:
            spec.hint ??
            "凭据经本机 DPAPI 独立加密存储，通过宿主盲注入生效，绝不进入 config.toml 或大模型上下文。",
          configured: false,
        });
      }
    }
    return prompts;
  }

  /**
   * 收信流水线调度：
   * 1. onBeforeTriage（可短路省掉大模型调用，或附加结构化标签/验证码）
   * 2. baseClassifier（模拟 MailChat 的规则/大模型分拣结论）
   * 3. onAfterTriage（记账入 KV、飞书/Webhook 盲注入推送、微调摘要）
   */
  async runIncomingPipeline(rawMail, baseClassifier = defaultMockClassifier) {
    const trace = [];
    let workingMail = {
      id: rawMail.id ?? Date.now(),
      messageId: rawMail.messageId ?? `<msg-${Date.now()}@mailchat.local>`,
      peer: rawMail.peer ?? rawMail.fromAddr,
      isGroup: Boolean(rawMail.isGroup),
      fromAddr: String(rawMail.fromAddr ?? "").toLowerCase(),
      fromName: String(rawMail.fromName ?? ""),
      toAddrs: rawMail.toAddrs ?? ["me@mailchat.local"],
      subject: String(rawMail.subject ?? ""),
      body: String(rawMail.body ?? ""),
      bodyFull: String(rawMail.bodyFull ?? rawMail.body ?? ""),
      date: rawMail.date ?? Math.floor(Date.now() / 1000),
      headers: rawMail.headers ?? {},
      tags: [...(rawMail.tags ?? [])],
      metadata: { ...(rawMail.metadata ?? {}) },
    };

    let verdict = null;
    let shortCircuitedBy = null;

    // 阶段 1: onBeforeTriage
    for (const plugin of this.getOrderedActivePlugins("onBeforeTriage")) {
      const { ctx, logs, outboundHttpCalls } = this.#buildContext(plugin);
      const started = performance.now();
      try {
        const res = await invokeSandboxHook(
          plugin.exportsObj,
          "onBeforeTriage",
          [deepFreezeClone(workingMail), ctx]
        );
        const elapsedMs = Number((performance.now() - started).toFixed(2));

        if (res?.tags?.length) {
          workingMail.tags = [...new Set([...workingMail.tags, ...res.tags.map(String)])];
        }
        if (res?.metadata && typeof res.metadata === "object") {
          workingMail.metadata = { ...workingMail.metadata, ...res.metadata };
        }

        trace.push({
          pluginId: plugin.id,
          hook: "onBeforeTriage",
          ok: true,
          elapsedMs,
          decision: res?.decision ?? "continue",
          logs,
          outboundHttpCalls,
        });

        if (res?.decision === "short_circuit" && res.verdict) {
          shortCircuitedBy = plugin.id;
          verdict = {
            action: res.verdict.action,
            category: res.verdict.category ?? "插件分拣",
            summary: res.verdict.summary ?? workingMail.subject.slice(0, 36),
            reason: res.verdict.reason ?? `由插件 ${plugin.name} 前置分拣`,
            extractedCode: res.verdict.extractedCode ?? res.extractedCode ?? "",
            suggestedReply: res.verdict.suggestedReply ?? "",
          };
          break;
        }
      } catch (err) {
        // 故障隔离：单插件异常绝不吞掉正常来信！
        plugin.faultCount += 1;
        trace.push({
          pluginId: plugin.id,
          hook: "onBeforeTriage",
          ok: false,
          error: err.message,
          logs,
          outboundHttpCalls,
        });
      }
    }

    // 阶段 2: 若未被插件前置短路，交由内置 Agent / 基础分类器判定
    if (!verdict) {
      verdict = await baseClassifier(workingMail);
    }

    // 阶段 3: onAfterTriage
    for (const plugin of this.getOrderedActivePlugins("onAfterTriage")) {
      const { ctx, logs, outboundHttpCalls } = this.#buildContext(plugin);
      const started = performance.now();
      try {
        const res = await invokeSandboxHook(plugin.exportsObj, "onAfterTriage", [
          deepFreezeClone(workingMail),
          deepFreezeClone(verdict),
          ctx,
        ]);
        const elapsedMs = Number((performance.now() - started).toFixed(2));

        if (res?.tags?.length) {
          workingMail.tags = [...new Set([...workingMail.tags, ...res.tags.map(String)])];
        }
        if (res?.metadata && typeof res.metadata === "object") {
          workingMail.metadata = { ...workingMail.metadata, ...res.metadata };
        }
        if (res?.overrideVerdict && typeof res.overrideVerdict === "object") {
          verdict = { ...verdict, ...res.overrideVerdict };
        }

        trace.push({
          pluginId: plugin.id,
          hook: "onAfterTriage",
          ok: true,
          elapsedMs,
          logs,
          outboundHttpCalls,
        });
      } catch (err) {
        plugin.faultCount += 1;
        trace.push({
          pluginId: plugin.id,
          hook: "onAfterTriage",
          ok: false,
          error: err.message,
          logs,
          outboundHttpCalls,
        });
      }
    }

    // 记录进近期邮件缓存，供定时巡检插件只读查询
    const storedRecord = {
      ...workingMail,
      status:
        verdict.action === "block"
          ? "blocked"
          : verdict.action === "archive"
            ? "archived"
            : "inbox",
      unread: true,
    };
    this.recentMails.unshift(storedRecord);
    if (this.recentMails.length > 200) this.recentMails.length = 200;

    return {
      finalMail: workingMail,
      finalVerdict: verdict,
      shortCircuitedBy,
      trace,
    };
  }

  /**
   * 发信前置流水线调度 (onBeforeSend)：
   * 支持 DLP 敏感信息阻断发信、自动签名追加与自定义协议头注入
   */
  async runOutboundPipeline(rawDraft) {
    const trace = [];
    const workingDraft = {
      peer: rawDraft.peer ?? (rawDraft.to?.[0] || ""),
      isGroup: Boolean(rawDraft.isGroup),
      to: [...(rawDraft.to ?? [])],
      subject: String(rawDraft.subject ?? ""),
      body: String(rawDraft.body ?? ""),
      headers: { ...(rawDraft.headers ?? {}) },
    };

    for (const plugin of this.getOrderedActivePlugins("onBeforeSend")) {
      const { ctx, logs, outboundHttpCalls } = this.#buildContext(plugin);
      const started = performance.now();
      try {
        const res = await invokeSandboxHook(plugin.exportsObj, "onBeforeSend", [
          deepFreezeClone(workingDraft),
          ctx,
        ]);
        const elapsedMs = Number((performance.now() - started).toFixed(2));

        trace.push({
          pluginId: plugin.id,
          hook: "onBeforeSend",
          ok: true,
          elapsedMs,
          canceled: Boolean(res?.cancel),
          logs,
          outboundHttpCalls,
        });

        if (res?.cancel) {
          return {
            allowed: false,
            blockedBy: plugin.id,
            reason: res.reason ?? `已被插件「${plugin.name}」拦截发送`,
            finalDraft: workingDraft,
            trace,
          };
        }

        if (typeof res?.subject === "string") workingDraft.subject = res.subject;
        if (typeof res?.body === "string") workingDraft.body = res.body;
        if (res?.headers && typeof res.headers === "object") {
          for (const [hk, hv] of Object.entries(res.headers)) {
            workingDraft.headers[String(hk)] = String(hv);
          }
        }
      } catch (err) {
        plugin.faultCount += 1;
        trace.push({
          pluginId: plugin.id,
          hook: "onBeforeSend",
          ok: false,
          error: err.message,
          logs,
          outboundHttpCalls,
        });
      }
    }

    return {
      allowed: true,
      blockedBy: null,
      reason: null,
      finalDraft: workingDraft,
      trace,
    };
  }

  /**
   * 后台定时巡检调度 (onSchedule)
   */
  async runScheduledTick({ trigger = "manual", now = Math.floor(Date.now() / 1000) } = {}) {
    const tick = {
      now,
      isoTime: new Date(now * 1000).toISOString(),
      trigger,
    };

    const reports = [];
    for (const plugin of this.getOrderedActivePlugins("onSchedule")) {
      const { ctx, logs, outboundHttpCalls } = this.#buildContext(plugin);
      const started = performance.now();
      try {
        const res = await invokeSandboxHook(plugin.exportsObj, "onSchedule", [
          deepFreezeClone(tick),
          ctx,
        ]);
        const elapsedMs = Number((performance.now() - started).toFixed(2));
        reports.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          ok: true,
          elapsedMs,
          summary: res?.summary ?? "",
          notifications: res?.notifications ?? [],
          logs,
          outboundHttpCalls,
        });
      } catch (err) {
        plugin.faultCount += 1;
        reports.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          ok: false,
          error: err.message,
          notifications: [],
          logs,
          outboundHttpCalls,
        });
      }
    }

    return { tick, reports };
  }

  /** 导出与 MailChat `config.toml` 完全契合的 `[[plugins]]` 声明式片段 */
  exportDeclarativeTomlSnippet() {
    const lines = [
      "# ── 插件编排声明（与 plugins/<id>/plugin.toml 自动对账，敏感凭据独立加密于 DPAPI Vault） ──",
    ];
    const sorted = [...this.registry.values()].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
    );
    for (const p of sorted) {
      lines.push("");
      lines.push("[[plugins]]");
      lines.push(`id = "${p.id}"`);
      lines.push(`enabled = ${p.enabled}`);
      lines.push(`priority = ${p.priority}`);
      lines.push(`source = "${p.source}"`);
      const secretSlots = Object.keys(p.manifest.secrets ?? {});
      if (secretSlots.length > 0) {
        const refs = secretSlots.map((s) => `${s} = "secret:plugin:${p.id}:${s}"`).join(", ");
        lines.push(`secret_refs = { ${refs} }`);
      }
      const cfgEntries = Object.entries(p.configOverrides);
      if (cfgEntries.length > 0) {
        const pairs = cfgEntries
          .map(([k, v]) => `${k} = ${typeof v === "string" ? JSON.stringify(v) : v}`)
          .join(", ");
        lines.push(`config = { ${pairs} }`);
      }
    }
    return lines.join("\n") + "\n";
  }

  #buildContext(plugin) {
    return createHostContext({
      pluginId: plugin.id,
      manifest: plugin.manifest,
      configOverrides: plugin.configOverrides,
      vault: this.vault,
      kvStore: this.kvStore,
      httpTransport: this.httpTransport,
      llmAdapter: this.llmAdapter,
      recentMailsProvider: async (query) => {
        return this.recentMails
          .filter((m) => (!query.status || m.status === query.status))
          .filter((m) => (!query.peer || m.peer === query.peer))
          .filter((m) => (!query.unreadOnly || m.unread))
          .filter((m) => (!query.sinceSeconds || m.date >= Math.floor(Date.now() / 1000) - query.sinceSeconds))
          .slice(0, query.limit ?? 20);
      },
      dryRun: false,
    });
  }
}

async function defaultMockClassifier(mail) {
  const hay = `${mail.subject}\n${mail.bodyFull}`.toLowerCase();
  if (hay.includes("退订") && (hay.includes("折") || hay.includes("促销"))) {
    return {
      action: "block",
      category: "营销",
      summary: mail.subject.slice(0, 32),
      reason: "默认分类器：疑似商业推广邮件",
      extractedCode: "",
      suggestedReply: "",
    };
  }
  if (hay.includes("发票") || hay.includes("账单") || hay.includes("通知")) {
    return {
      action: "archive",
      category: "账单",
      summary: mail.subject.slice(0, 32),
      reason: "默认分类器：通知或电子账单折叠",
      extractedCode: "",
      suggestedReply: "",
    };
  }
  return {
    action: "inbox",
    category: "工作",
    summary: mail.subject.slice(0, 32),
    reason: "默认分类器：正常来信进入消息列表",
    extractedCode: "",
    suggestedReply: "收到，稍后回复你。",
  };
}
