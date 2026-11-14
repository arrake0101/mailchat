import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AccountEntry,
  AgentChatResponse,
  AgentConfig,
  AgentSessionSummary,
  AgentTurnRecord,
  AttachmentMeta,
  ChatTurn,
  ContactProfile,
  Conversation,
  DeclarativeBundle,
  DeclarativeConfigSpec,
  GroupInfo,
  GroupMember,
  MagpieConnectResult,
  MagpieProbeReport,
  MailboxStats,
  Message,
  ModelSwitchResult,
  ProviderPresetId,
  ProviderProtocol,
  RewindAgentResponse,
  Rule,
  RuleKind,
  SecretSaveResult,
  SecretStatus,
  SendAttachmentInput,
  Status,
  SyncReport,
  Verdict,
  WindowAction,
} from "./types";

export const api = {
  getDeclarativeConfig: () => invoke<DeclarativeBundle>("get_declarative_config"),
  applyDeclarativeConfig: (toml: string) => invoke<DeclarativeBundle>("apply_declarative_config", { toml }),
  applyDeclarativeSpec: (spec: DeclarativeConfigSpec) =>
    invoke<DeclarativeBundle>("apply_declarative_spec", { spec }),
  listSecrets: () => invoke<SecretStatus[]>("list_secrets"),
  setSecret: (key: string, value: string, verify = true) =>
    invoke<SecretSaveResult>("set_secret", { key, value, verify }),
  deleteSecret: (key: string) => invoke<SecretStatus[]>("delete_secret", { key }),
  chatWithAgent: (
    message: string,
    history: ChatTurn[],
    sessionId?: string | null,
    requestId?: string | null,
  ) =>
    invoke<AgentChatResponse>("chat_with_agent", {
      message,
      history,
      sessionId: sessionId ?? null,
      requestId: requestId ?? null,
    }),
  cancelAgentChat: (requestId?: string | null) =>
    invoke<void>("cancel_agent_chat", { requestId: requestId ?? null }),
  listAgentSessions: () => invoke<AgentSessionSummary[]>("list_agent_sessions"),
  createAgentSession: (title?: string) =>
    invoke<AgentSessionSummary>("create_agent_session", { title: title ?? null }),
  getAgentSessionTurns: (sessionId: string) =>
    invoke<AgentTurnRecord[]>("get_agent_session_turns", { sessionId }),
  deleteAgentSession: (sessionId: string) =>
    invoke<AgentSessionSummary[]>("delete_agent_session", { sessionId }),
  clearAgentSessionTurns: (sessionId: string) =>
    invoke<AgentSessionSummary[]>("clear_agent_session_turns", { sessionId }),
  rewindAgentSession: (sessionId: string, fromTurnId: number, restoreConfig: boolean) =>
    invoke<RewindAgentResponse>("rewind_agent_session", {
      sessionId,
      fromTurnId,
      restoreConfig,
    }),
  switchActiveModel: (preset: string, model?: string) =>
    invoke<ModelSwitchResult>("switch_active_model", {
      preset,
      model: model?.trim() ? model.trim() : null,
    }),
  listAccounts: () => invoke<AccountEntry[]>("list_accounts"),
  getAccount: () => invoke<Account | null>("get_account"),
  saveAccount: (account: Account, setActive = true) =>
    invoke<AccountEntry[]>("save_account", { account, setActive }),
  switchAccount: (email: string) => invoke<AccountEntry[]>("switch_account", { email }),
  removeAccount: (email: string, deleteLocalData = false) =>
    invoke<AccountEntry[]>("remove_account", { email, deleteLocalData }),
  reorderAccounts: (emails: string[]) => invoke<AccountEntry[]>("reorder_accounts", { emails }),
  getAgentConfig: () => invoke<AgentConfig>("get_agent_config"),
  saveAgentConfig: (config: AgentConfig) => invoke<void>("save_agent_config", { config }),
  testAgent: (config: AgentConfig) => invoke<Verdict>("test_agent", { config }),
  fetchModels: (config: AgentConfig) => invoke<string[]>("fetch_models", { config }),
  probeMagpie: (baseUrl?: string) =>
    invoke<MagpieProbeReport>("probe_magpie", {
      baseUrl: baseUrl?.trim() ? baseUrl.trim() : null,
    }),
  startMagpieGateway: (baseUrl?: string) =>
    invoke<MagpieProbeReport>("start_magpie_gateway", {
      baseUrl: baseUrl?.trim() ? baseUrl.trim() : null,
    }),
  connectMagpie: (opts?: { baseUrl?: string; model?: string; autoStart?: boolean }) =>
    invoke<MagpieConnectResult>("connect_magpie", {
      baseUrl: opts?.baseUrl?.trim() ? opts.baseUrl.trim() : null,
      model: opts?.model?.trim() ? opts.model.trim() : null,
      autoStart: opts?.autoStart ?? true,
    }),
  windowAction: (action: WindowAction) => invoke<boolean>("window_action", { action }),
  reclassifyMessages: (all: boolean) => invoke<number>("reclassify_messages", { all }),
  syncNow: () => invoke<SyncReport>("sync_now"),
  pokeMailSync: () => invoke<void>("poke_mail_sync").catch(() => {}),
  getStats: () => invoke<MailboxStats>("get_stats"),
  listConversations: (status: Status) => invoke<Conversation[]>("list_conversations", { status }),
  listMessages: (peer: string, status: Status) => invoke<Message[]>("list_messages", { peer, status }),
  listContacts: () => invoke<GroupMember[]>("list_contacts"),
  createGroup: (name: string, members: GroupMember[]) => invoke<GroupInfo>("create_group", { name, members }),
  getGroup: (peer: string) => invoke<GroupInfo | null>("get_group", { peer }),
  updateGroup: (peer: string, name: string, members: GroupMember[], muted: boolean) =>
    invoke<GroupInfo>("update_group", { peer, name, members, muted }),
  getContactProfile: (email: string) => invoke<ContactProfile>("get_contact_profile", { email }),
  saveContactProfile: (profile: ContactProfile) =>
    invoke<ContactProfile>("save_contact_profile", { profile }),
  previewAttachmentDataUrl: (messageId: number, attachmentId: string) =>
    invoke<string>("preview_attachment_data_url", { messageId, attachmentId }),
  saveAttachmentAs: (messageId: number, attachmentId: string) =>
    invoke<AttachmentMeta | null>("save_attachment_as", { messageId, attachmentId }),
  openSavedAttachment: (messageId: number, attachmentId: string) =>
    invoke<void>("open_saved_attachment", { messageId, attachmentId }),
  revealSavedAttachment: (messageId: number, attachmentId: string) =>
    invoke<void>("reveal_saved_attachment", { messageId, attachmentId }),
  sendMessage: (
    peer: string,
    body: string,
    customSubject?: string,
    attachments?: SendAttachmentInput[],
    replyToId?: number | null,
  ) =>
    invoke<Message>("send_message", {
      peer,
      body,
      customSubject: customSubject?.trim() ? customSubject.trim() : null,
      attachments: attachments && attachments.length > 0 ? attachments : null,
      replyToId: replyToId ?? null,
    }),
  setMessageStatus: (id: number, status: Status) => invoke<void>("set_message_status", { id, status }),
  moveConversation: (peer: string, status: Status) => invoke<void>("move_conversation", { peer, status }),
  setConversationPinned: (peer: string, pinned: boolean) =>
    invoke<void>("set_conversation_pinned", { peer, pinned }),
  setConversationRead: (peer: string, status: Status, read: boolean) =>
    invoke<void>("set_conversation_read", { peer, status, read }),
  markAllRead: (status: Status) => invoke<number>("mark_all_read", { status }),
  setConversationMuted: (peer: string, muted: boolean) =>
    invoke<void>("set_conversation_muted", { peer, muted }),
  deleteMessage: (id: number) => invoke<void>("delete_message", { id }),
  deleteConversation: (peer: string, status?: Status) =>
    invoke<number>("delete_conversation", { peer, status: status ?? null }),
  blockSender: (peer: string) => invoke<void>("block_sender", { peer }),
  allowSender: (peer: string) => invoke<void>("allow_sender", { peer }),
  listRules: () => invoke<Rule[]>("list_rules"),
  addRule: (kind: RuleKind, pattern: string) => invoke<void>("add_rule", { kind, pattern }),
  deleteRule: (id: number) => invoke<void>("delete_rule", { id }),
  applyRulesNow: () => invoke<number>("apply_rules_now"),
  draftReply: (peer: string, hint?: string) =>
    invoke<string>("draft_reply", { peer, hint: hint?.trim() ? hint.trim() : null }),
  summarizeConversation: (peer: string, title: string) =>
    invoke<string>("summarize_conversation", { peer, title }),
  loadDemoData: () => invoke<number>("load_demo_data"),
  clearDemoData: () => invoke<number>("clear_demo_data"),
  openExternalUrl: async (url: string) => {
    try {
      await invoke<void>("open_external_url", { url });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  },
  startScreenSnip: () => invoke<void>("start_screen_snip"),
};

/** 常见邮箱的服务器预设 */
export const PRESETS: Record<
  string,
  Pick<Account, "imap_host" | "imap_port" | "smtp_host" | "smtp_port"> & { label: string }
> = {
  "qq.com": { label: "QQ 邮箱", imap_host: "imap.qq.com", imap_port: 993, smtp_host: "smtp.qq.com", smtp_port: 465 },
  "foxmail.com": { label: "Foxmail", imap_host: "imap.qq.com", imap_port: 993, smtp_host: "smtp.qq.com", smtp_port: 465 },
  "163.com": { label: "网易 163", imap_host: "imap.163.com", imap_port: 993, smtp_host: "smtp.163.com", smtp_port: 465 },
  "126.com": { label: "网易 126", imap_host: "imap.126.com", imap_port: 993, smtp_host: "smtp.126.com", smtp_port: 465 },
  "yeah.net": { label: "Yeah.net", imap_host: "imap.yeah.net", imap_port: 993, smtp_host: "smtp.yeah.net", smtp_port: 465 },
  "gmail.com": { label: "Gmail", imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  "outlook.com": {
    label: "Outlook",
    imap_host: "outlook.office365.com",
    imap_port: 993,
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
  },
  "hotmail.com": {
    label: "Hotmail",
    imap_host: "outlook.office365.com",
    imap_port: 993,
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
  },
  "icloud.com": {
    label: "iCloud",
    imap_host: "imap.mail.me.com",
    imap_port: 993,
    smtp_host: "smtp.mail.me.com",
    smtp_port: 587,
  },
  "aliyun.com": {
    label: "阿里邮箱",
    imap_host: "imap.aliyun.com",
    imap_port: 993,
    smtp_host: "smtp.aliyun.com",
    smtp_port: 465,
  },
};

export interface ModelPreset {
  id: ProviderPresetId;
  name: string;
  badge: string;
  featured?: boolean;
  provider: ProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  optionalKey?: boolean;
  supportsModelFetch?: boolean;
  hint: string;
}

/** 可一键切换的模型预设：支持免配置直接沿用本机 Magpie 模型路由，以及 DeepSeek 官网、OpenCode Go 与 Ollama 远程订阅 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "magpie",
    name: "Magpie 模型路由",
    badge: "免配沿用",
    featured: true,
    provider: "openai",
    baseUrl: "http://127.0.0.1:3425/v1",
    defaultModel: "auto",
    models: ["auto"],
    needsKey: false,
    optionalKey: true,
    supportsModelFetch: true,
    hint: "自动发现并复用本机 Magpie (usemagpie.ai) 已配好的全部模型、OAuth 订阅与故障转移路由组（group/* / auto/*）；本机直连无需再配置任何 API Key，设 auto 即可动态跟随你在 Magpie 中的激活路由。",
  },
  {
    id: "deepseek",
    name: "DeepSeek 官网",
    badge: "官方首选",
    featured: true,
    provider: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4.1-flash",
    models: ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
    supportsModelFetch: true,
    hint: "DeepSeek 官方开放平台直连（api.deepseek.com/v1），默认搭载 DeepSeek 4.1 Flash（底层自动适配官方 deepseek-flash 参数），极速低成本处理中文邮件分拣与摘要。",
  },
  {
    id: "opencode_go",
    name: "OpenCode Go",
    badge: "订阅优先",
    featured: true,
    provider: "openai",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    defaultModel: "deepseek-v4.1-flash",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "glm-5.3-flash",
      "glm-5.3",
      "kimi-k3.1-pro",
      "kimi-k3",
      "kimi-k2.7-code",
      "mimo-v2.6-flash",
      "minimax-m3.1-flash",
      "qwen3.8-flash",
      "claude-haiku-5-5",
    ],
    needsKey: true,
    supportsModelFetch: true,
    hint: "OpenCode Go / Zen 官方网关（已内置 x-opencode-session 会话头与多协议自动路由），默认搭载 deepseek-v4.1-flash（注意：若开启代理调用 DeepSeek 需在 OpenCode Console → Settings › Privacy 中将 Regions 设为 Global，或直接选用 glm-5.3-flash）。",
  },
  {
    id: "ollama_cloud",
    name: "Ollama 远程订阅",
    badge: "云端订阅",
    featured: true,
    provider: "openai",
    baseUrl: "https://ollama.com/v1",
    defaultModel: "deepseek-v4.1-flash",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash:1017",
      "gpt-oss:120b-cloud",
      "gpt-oss:20b",
      "gemma4:31b",
      "qwen3:32b",
    ],
    needsKey: true,
    supportsModelFetch: true,
    hint: "Ollama 官方远程云端订阅（ollama.com/v1），填入 ollama.com/settings 生成的订阅密钥即可免显卡调用满血版 deepseek-v4.1-flash。",
  },
  {
    id: "ollama_remote",
    name: "Ollama 自建远程",
    badge: "内网算力",
    provider: "openai",
    baseUrl: "http://192.168.1.100:11434/v1",
    defaultModel: "qwen2.5:7b",
    models: ["qwen2.5:7b", "qwen3:14b", "gemma3:12b", "deepseek-r1:14b", "llama3.1:8b"],
    needsKey: false,
    optionalKey: true,
    supportsModelFetch: true,
    hint: "接入局域网 GPU 算力机、Tailscale 或自建服务器上的远程 Ollama（自动兼容省略 /v1 的地址）；直连免 Key，若配置了网关鉴权可按需填写密钥。",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    badge: "隐私离线",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    models: ["qwen2.5:7b", "llama3.1:8b", "gemma3:4b", "deepseek-r1:7b"],
    needsKey: false,
    supportsModelFetch: true,
    hint: "邮件数据 100% 不出本机！需先在本机启动 Ollama，点击「拉取远端模型」可直接读取本机已安装的模型标签。",
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "通用标准",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    needsKey: true,
    supportsModelFetch: true,
    hint: "OpenAI 官方接口，推荐日常邮件分拣使用 mini 系列以兼顾速度与费用。",
  },
  {
    id: "qwen",
    name: "通义千问 Qwen",
    badge: "阿里云百炼",
    provider: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
    needsKey: true,
    supportsModelFetch: true,
    hint: "阿里云百炼 DashScope 兼容接口，对国内账单、快递、通知类邮件理解极佳。",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    badge: "原生接口",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest", "claude-3-7-sonnet-latest"],
    needsKey: true,
    hint: "使用 Anthropic 原生 /v1/messages 接口，擅长自然得体的商务回复起草。",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "原生接口",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    needsKey: true,
    hint: "使用 Google Gemini 原生 generateContent 接口，Flash 模型响应极快。",
  },
  {
    id: "kimi",
    name: "Moonshot Kimi",
    badge: "长文本",
    provider: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2-0711-preview",
    models: ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k"],
    needsKey: true,
    supportsModelFetch: true,
    hint: "月之暗面开放平台接口，适合长邮件简报与多轮沟通摘要。",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    badge: "聚合多模",
    provider: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3", "THUDM/glm-4-9b-chat"],
    needsKey: true,
    supportsModelFetch: true,
    hint: "SiliconFlow 聚合平台，部分轻量开源模型提供免费额度。",
  },
  {
    id: "custom",
    name: "自定义兼容接口",
    badge: "任意网关",
    provider: "openai",
    baseUrl: "",
    defaultModel: "",
    models: [],
    needsKey: false,
    optionalKey: true,
    supportsModelFetch: true,
    hint: "支持任意兼容 OpenAI /v1/chat/completions 协议的企业网关、OneAPI、LM Studio 或 vLLM。",
  },
];
