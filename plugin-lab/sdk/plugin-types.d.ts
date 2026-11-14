/**
 * MailChat Plugin SDK v1 — 类型契约定义 (Zero-Build ES2022 Module)
 *
 * 设计准则：
 * 1. 双源同构：社区现成插件与内置 AI 助手自动生成的插件共享完全一致的 `plugin.toml` + `index.mjs` 结构。
 * 2. 零构建依赖：插件必须为无外部打包依赖的标准 ES2022 模块，以便在独立 `mailchat.exe` 内嵌沙盒中直接热加载。
 * 3. 最小权限与凭据隔离：网络请求受 `permissions.network` 域名白名单约束；敏感凭据通过 `{{secret:<slot>}}` 由宿主盲注入，绝不落盘明文。
 */

export type MailStatus = "inbox" | "archived" | "blocked";

export type HookName =
  | "onBeforeTriage"
  | "onAfterTriage"
  | "onBeforeSend"
  | "onSchedule";

/** 流入插件钩子的标准化邮件快照（与 src-tauri/src/mail.rs NewMessage 一一映射） */
export interface PluginMailView {
  readonly id?: number;
  readonly messageId: string;
  readonly peer: string;
  readonly isGroup: boolean;
  readonly fromAddr: string;
  readonly fromName: string;
  readonly toAddrs: string[];
  readonly subject: string;
  readonly body: string;
  readonly bodyFull: string;
  readonly date: number; // Unix 秒级时间戳
  readonly headers: Readonly<Record<string, string>>;
  /** 上游插件附加的结构化元数据标签 */
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 分拣结论（与 src-tauri/src/agent.rs Verdict 一一映射） */
export interface TriageVerdict {
  action: "inbox" | "archive" | "block";
  category: string;
  summary: string;
  reason: string;
  extractedCode: string;
  suggestedReply: string;
}

/**
 * 钩子 1：`onBeforeTriage` 返回值
 * - 若返回 `{ decision: "short_circuit", verdict }`，则直接跳过后续大模型分拣（省 Token、毫秒级响应）
 * - 若返回 `{ decision: "continue", tags?, metadata?, extractedCode? }` 或 `void`，则富化上下文后继续后续流水线
 */
export interface BeforeTriageResult {
  decision?: "continue" | "short_circuit";
  verdict?: Partial<TriageVerdict> & { action: "inbox" | "archive" | "block" };
  tags?: string[];
  metadata?: Record<string, unknown>;
  extractedCode?: string;
}

/**
 * 钩子 2：`onAfterTriage` 返回值
 * 在确定性规则或大模型完成分类后触发，可联动 Webhook、提取发票入账，或微调最终展示摘要与分类
 */
export interface AfterTriageResult {
  overrideVerdict?: Partial<TriageVerdict>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** 待发送邮件草稿（对应 send_message 入口） */
export interface OutboundDraft {
  peer: string;
  isGroup: boolean;
  to: string[];
  subject: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * 钩子 3：`onBeforeSend` 返回值
 * - `{ cancel: true, reason }`：阻断发信并在前端弹出拦截原因（如防密钥/隐私外泄）
 * - `{ subject?, body?, headers? }`：改写待发送内容（如自动追加合规签名、自定义协议头）
 */
export interface BeforeSendResult {
  cancel?: boolean;
  reason?: string;
  subject?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** 定时巡检触发上下文 */
export interface ScheduleTick {
  readonly now: number; // Unix 秒级时间戳
  readonly isoTime: string;
  readonly trigger: "interval" | "daily_at" | "manual";
}

/** 钩子 4：`onSchedule` 返回值 */
export interface ScheduleResult {
  summary?: string;
  notifications?: Array<{
    title: string;
    body: string;
    peer?: string;
    level?: "info" | "warn";
  }>;
}

/** 受白名单与 Vault 盲注入保护的 HTTP 请求参数 */
export interface PluginHttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * 支持 `{{secret:<slot>}}` 模板占位符（由宿主在校验域名白名单后注入真实凭据，插件 JS 无需接触明文）
   */
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
}

export interface PluginHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  json: unknown | null;
}

/** 受限历史邮件只读查询条件（需声明 `permissions.mail_access = "read_recent"`） */
export interface RecentMailQuery {
  status?: MailStatus;
  peer?: string;
  unreadOnly?: boolean;
  sinceSeconds?: number;
  limit?: number; // 上限 50
}

/** 注入给每个插件钩子的隔离宿主能力上下文 */
export interface PluginHostContext {
  readonly pluginId: string;
  readonly dryRun: boolean;
  /** 读取 config.toml 中针对当前插件覆盖的非敏感参数（合并 plugin.toml 默认值） */
  readonly config: Readonly<Record<string, string | number | boolean>>;

  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };

  /** 插件独占命名空间 KV 存储（需声明 `permissions.kv_storage = true`） */
  kv: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    listKeys(prefix?: string): Promise<string[]>;
  };

  /**
   * 受控外部网络请求（需在 `permissions.network` 声明目标域名）
   * URL 与 headers/body 字符串均支持 `{{secret:<slot>}}` 宿主侧盲注入
   */
  http: {
    fetch(url: string, options?: PluginHttpRequest): Promise<PluginHttpResponse>;
  };

  /** Vault 凭据状态探测（不暴露全局凭据，仅限当前插件声明的 `[secrets.<slot>]`） */
  secrets: {
    has(slot: string): boolean;
  };

  /** 受限邮箱访问能力 */
  mail: {
    /** 查询近期邮件摘要（需声明 `permissions.mail_access = "read_recent"`） */
    queryRecent(query?: RecentMailQuery): Promise<PluginMailView[]>;
  };

  /** 复用宿主已配置的 AI 模型能力（需声明 `permissions.llm_access = true`，插件无法读取底层 API Key） */
  llm: {
    complete(prompt: string, options?: { system?: string; json?: boolean; maxTokens?: number }): Promise<string>;
  };
}

/** 标准插件模块导出结构 */
export interface MailChatPluginModule {
  onBeforeTriage?(mail: PluginMailView, ctx: PluginHostContext): Promise<BeforeTriageResult | void> | BeforeTriageResult | void;
  onAfterTriage?(
    mail: PluginMailView,
    verdict: TriageVerdict,
    ctx: PluginHostContext
  ): Promise<AfterTriageResult | void> | AfterTriageResult | void;
  onBeforeSend?(draft: OutboundDraft, ctx: PluginHostContext): Promise<BeforeSendResult | void> | BeforeSendResult | void;
  onSchedule?(tick: ScheduleTick, ctx: PluginHostContext): Promise<ScheduleResult | void> | ScheduleResult | void;
}
