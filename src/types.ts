export type Status = "inbox" | "archived" | "blocked";

export type ProviderProtocol = "openai" | "anthropic" | "gemini";

export type ProviderPresetId =
  | "magpie"
  | "opencode_go"
  | "deepseek"
  | "openai"
  | "qwen"
  | "anthropic"
  | "gemini"
  | "kimi"
  | "siliconflow"
  | "ollama_remote"
  | "ollama_cloud"
  | "ollama"
  | "custom";

export type WindowAction =
  | "drag"
  | "toggle_pin"
  | "is_pinned"
  | "minimize"
  | "toggle_maximize"
  | "is_maximized"
  | "close";

export interface Account {
  email: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
}

export interface AccountEntry {
  email: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  active: boolean;
  has_password: boolean;
  inbox_unread: number;
}

export function mailSecretKey(email?: string | null): string {
  const norm = email?.trim().toLowerCase() ?? "";
  return norm ? `mail_pwd:${norm}` : "mail_password";
}

export interface ProviderProfile {
  base_url: string;
  api_key: string;
  model: string;
}

export interface AgentConfig {
  enabled: boolean;
  preset: ProviderPresetId | string;
  provider: ProviderProtocol;
  base_url: string;
  api_key: string;
  model: string;
  instructions: string;
  auto_draft: boolean;
  auto_block_sender: boolean;
  profiles: Record<string, ProviderProfile>;
}

export interface MailboxStats {
  inbox_unread: number;
  archived_unread: number;
  blocked_count: number;
  pending_count: number;
  has_demo: boolean;
}

export interface GroupMember {
  email: string;
  name: string;
}

export interface GroupInfo {
  peer: string;
  name: string;
  members: GroupMember[];
  muted: boolean;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size: number;
  is_image: boolean;
  part_id?: string;
  encoding?: string;
  att_index?: number;
  saved_path?: string;
  rel_path?: string;
}

export interface SendAttachmentInput {
  filename: string;
  mime: string;
  data_base64: string;
}

export interface ReplyQuote {
  id: number;
  message_id: string;
  sender: string;
  snippet: string;
}

export interface ContactProfile {
  email: string;
  alias: string;
  note: string;
  tag: string;
  muted: boolean;
}

export interface Conversation {
  peer: string;
  name: string;
  raw_name?: string;
  note?: string;
  preview: string;
  last_date: number;
  unread: number;
  count: number;
  category: string;
  is_group: boolean;
  members: GroupMember[];
  muted: boolean;
  pinned?: boolean;
}

export interface Message {
  id: number;
  peer: string;
  from_addr: string;
  from_name: string;
  subject: string;
  body: string;
  body_full: string;
  body_html: string;
  date: number;
  outgoing: boolean;
  status: string;
  category: string;
  summary: string;
  reason: string;
  extracted_code: string;
  suggested_reply: string;
  attachments?: AttachmentMeta[];
  reply_to?: ReplyQuote | null;
}

export type RuleKind =
  | "allow_sender"
  | "block_sender"
  | "block_domain"
  | "block_keyword"
  | "archive_sender"
  | "archive_keyword";

export interface Rule {
  id: number;
  kind: RuleKind;
  pattern: string;
}

export interface Verdict {
  action: string;
  category: string;
  summary: string;
  reason: string;
  extracted_code: string;
  suggested_reply: string;
}

export interface SyncReport {
  new_incoming: number;
  agent_processed: number;
  error: string | null;
}

export interface SecretStatus {
  key: string;
  label: string;
  category: "mail" | "llm" | string;
  configured: boolean;
  masked: string;
}

export interface SecretPrompt {
  key: string;
  label: string;
  hint: string;
  configured: boolean;
}

export interface AccountSpec {
  email: string;
  display_name: string;
  username: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  password_ref: string;
}

export interface ProfileSpec {
  base_url: string;
  model: string;
}

export interface AgentSpec {
  enabled: boolean;
  preset: string;
  provider: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  auto_draft: boolean;
  auto_block_sender: boolean;
  instructions: string;
  profiles?: Record<string, ProfileSpec>;
}

export interface TriageSpec {
  allow_senders: string[];
  block_senders: string[];
  block_domains: string[];
  block_keywords: string[];
  archive_senders: string[];
  archive_keywords: string[];
}

export interface GroupSpec {
  id: string;
  name: string;
  muted: boolean;
  members: GroupMember[];
}

export interface DeclarativeConfigSpec {
  active_account?: string;
  accounts?: AccountSpec[];
  agent: AgentSpec;
  triage: TriageSpec;
  groups?: GroupSpec[];
}

export interface ConfigDiffItem {
  section: "accounts" | "agent" | "triage" | "groups" | "vault" | string;
  section_label: string;
  target_key: string;
  kind: "added" | "modified" | "removed" | string;
  field_label: string;
  before: string;
  after: string;
}

export interface ConfigDiffReport {
  items: ConfigDiffItem[];
  before_toml: string;
  after_toml: string;
}

export interface DeclarativeBundle {
  path: string;
  toml: string;
  spec: DeclarativeConfigSpec;
  secrets: SecretStatus[];
}

export interface SecretSaveResult {
  secrets: SecretStatus[];
  verified: boolean;
  message: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  preview: string;
  turn_count: number;
  created_at: number;
  updated_at: number;
}

export interface AgentTurnRecord {
  id: number;
  session_id: string;
  role: "user" | "assistant" | string;
  content: string;
  thinking: string;
  thinking_ms: number;
  tool_steps: string[];
  changes: string[];
  config_diff?: ConfigDiffReport | null;
  snapshot_toml?: string;
  secret_prompts: SecretPrompt[];
  suggestions: string[];
  created_at: number;
}

export interface AgentStreamPayload {
  request_id: string;
  session_id: string;
  kind: "thinking" | "content" | "tool" | "toml" | "spec_preview" | string;
  delta: string;
  thinking_ms: number;
}

export interface ModelSwitchResult {
  agent_config: AgentConfig;
  bundle: DeclarativeBundle;
}

export interface MagpieAgentBinding {
  agent: string;
  model: string;
}

export interface MagpieProbeReport {
  cli_installed: boolean;
  config_found: boolean;
  gateway_online: boolean;
  base_url: string;
  port: number;
  version: string;
  recommended_model: string;
  groups: string[];
  models: string[];
  agent_bindings: MagpieAgentBinding[];
  message: string;
}

export interface MagpieConnectResult {
  probe: MagpieProbeReport;
  agent_config: AgentConfig;
  bundle: DeclarativeBundle;
}

export interface AgentChatResponse {
  session_id: string;
  reply: string;
  thinking: string;
  thinking_ms: number;
  tool_steps: string[];
  changes: string[];
  config_diff?: ConfigDiffReport | null;
  toml: string;
  spec: DeclarativeConfigSpec;
  secrets: SecretStatus[];
  secret_prompts: SecretPrompt[];
  suggestions: string[];
  sessions: AgentSessionSummary[];
  turns?: AgentTurnRecord[];
}

export interface RewindAgentResponse {
  turns: AgentTurnRecord[];
  sessions: AgentSessionSummary[];
  config_restored: boolean;
  bundle: DeclarativeBundle;
}
