export type Status = "inbox" | "archived" | "blocked";

export type ProviderProtocol = "openai" | "anthropic" | "gemini";

export type ProviderPresetId =
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

export interface Conversation {
  peer: string;
  name: string;
  preview: string;
  last_date: number;
  unread: number;
  count: number;
  category: string;
  is_group: boolean;
  members: GroupMember[];
  muted: boolean;
}

export interface Message {
  id: number;
  peer: string;
  from_addr: string;
  from_name: string;
  subject: string;
  body: string;
  body_full: string;
  date: number;
  outgoing: boolean;
  status: string;
  category: string;
  summary: string;
  reason: string;
  extracted_code: string;
  suggested_reply: string;
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

export interface DeclarativeBundle {
  path: string;
  toml: string;
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

export interface AgentChatResponse {
  reply: string;
  changes: string[];
  toml: string;
  secrets: SecretStatus[];
  secret_prompts: SecretPrompt[];
  suggestions: string[];
}
