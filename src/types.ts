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
  | "hide_to_tray"
  | "close"
  | "exit";

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
  reply_pending_count?: number;
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

export type ThemeMode = "light" | "dark" | "system";
export type ThemePresetId = "mist" | "paper" | "graphite" | "forest" | "midnight";
export type CommunityThemePresetId =
  | "nord"
  | "catppuccin-latte"
  | "catppuccin-mocha"
  | "tokyo-night"
  | "dracula"
  | "solarized"
  | "rose-pine"
  | "gruvbox";
export type ThemeDensity = "comfortable" | "compact";
export type ThemeFontScale = "small" | "normal" | "large";

export interface CustomThemePalette {
  id: string;
  name: string;
  author?: string;
  base_mode: "light" | "dark" | string;
  canvas: string;
  sidebar: string;
  surface: string;
  card?: string;
  ink: string;
  ink_muted?: string;
  accent?: string;
}

export interface ThemeConfig {
  mode: ThemeMode | string;
  preset: ThemePresetId | CommunityThemePresetId | string;
  density: ThemeDensity | string;
  font_scale: ThemeFontScale | string;
  custom_themes?: CustomThemePalette[];
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

export interface WindowConfig {
  close_to_tray: boolean;
  tray_flash_on_message: boolean;
  taskbar_flash_on_message: boolean;
}

export type UpdateChannel = "stable" | "beta";

export interface UpdateConfig {
  auto_check: boolean;
  auto_download: boolean;
  check_interval_hours: number;
  channel: UpdateChannel | string;
  skipped_version: string;
  custom_endpoint: string;
}

export interface InstallChannelInfo {
  channel_id: "nsis" | "scoop" | "portable" | "macos_app" | "homebrew" | "appimage" | "deb" | "dev" | string;
  channel_label: string;
  supports_hot_update: boolean;
  upgrade_command?: string | null;
  hint: string;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateStatusSnapshot {
  phase: UpdatePhase | string;
  current_version: string;
  latest_version?: string | null;
  release_notes: string;
  pub_date?: string | null;
  download_url?: string | null;
  release_page_url: string;
  downloaded_bytes: number;
  total_bytes?: number | null;
  progress_percent?: number | null;
  can_hot_install: boolean;
  signature_verified: boolean;
  last_checked_at: number;
  error?: string | null;
  is_skipped: boolean;
  install_channel: InstallChannelInfo;
}

export interface DeclarativeConfigSpec {
  active_account?: string;
  accounts?: AccountSpec[];
  agent: AgentSpec;
  theme?: ThemeConfig;
  window?: WindowConfig;
  update?: UpdateConfig;
  triage: TriageSpec;
  reply_policy?: ReplyPolicySpec;
  groups?: GroupSpec[];
}

export interface ConfigDiffItem {
  section:
    | "accounts"
    | "agent"
    | "theme"
    | "window"
    | "update"
    | "triage"
    | "reply_policy"
    | "groups"
    | "vault"
    | string;
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

export interface RedactionHit {
  placeholder: string;
  kind_label: string;
  masked_preview: string;
}

export interface PrivacyScrubPreview {
  scrubbed: string;
  redactions: RedactionHit[];
  dlp_passed: boolean;
  dlp_findings: string[];
}

export interface ComposeLaunchIntent {
  id: string;
  fromEmail?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyPlain?: string;
  bodyHtml?: string;
  replyToId?: number | null;
  replyContext?: string;
  agentPrompt?: string;
}

export interface ComposeAgentInput {
  sender_identity: string;
  to: string[];
  cc: string[];
  current_subject: string;
  current_html: string;
  current_plain: string;
  reply_context?: string | null;
  redact_pii: boolean;
  custom_redact_terms: string[];
  history: ChatTurn[];
  user_prompt: string;
}

export interface ComposeAgentStreamPayload {
  request_id: string;
  kind: "thinking" | "content" | "html_preview" | string;
  delta: string;
  thinking_ms: number;
}

export interface ComposeAgentResult {
  reply: string;
  thinking: string;
  thinking_ms: number;
  suggested_subject?: string | null;
  suggested_html?: string | null;
  suggested_plain?: string | null;
  redaction_count: number;
  redactions: RedactionHit[];
  used_offline_fallback: boolean;
}

export interface AutoReplyRuleSpec {
  id: string;
  name: string;
  enabled: boolean;
  accounts: string[];
  match_senders: string[];
  match_domains: string[];
  match_keywords: string[];
  mode: "ai" | "template" | string;
  instructions_or_template: string;
  template_html: string;
  require_review: boolean;
  cooldown_minutes: number;
}

export interface ReplyPolicySpec {
  enabled: boolean;
  auto_scan_on_sync: boolean;
  enabled_accounts: string[];
  allowed_statuses: string[];
  sender_filter_mode: "all_allowed" | "whitelist_only" | string;
  allow_senders: string[];
  allow_domains: string[];
  exclude_senders: string[];
  exclude_keywords: string[];
  skip_sensitive_mails: boolean;
  include_groups: boolean;
  max_context_chars: number;
  redact_pii: boolean;
  custom_redact_terms: string[];
  auto_send_enabled: boolean;
  auto_send_senders: string[];
  auto_send_domains: string[];
  auto_send_hourly_limit: number;
  outbound_dlp_guard: boolean;
  persona_instructions: string;
  auto_rules: AutoReplyRuleSpec[];
}

export interface ReplyQueueItem {
  id: number;
  account_email: string;
  message_id_ref: number;
  rfc_message_id: string;
  peer: string;
  sender_addr: string;
  sender_name: string;
  original_subject: string;
  original_snippet: string;
  sanitized_input: string;
  redactions: RedactionHit[];
  permission_tier: "draft_review" | "whitelisted_auto_send" | string;
  permission_reason: string;
  draft_subject: string;
  draft_body: string;
  draft_html: string;
  confidence_note: string;
  dlp_warning: string;
  status: "pending_review" | "approved_sent" | "auto_sent" | "dismissed" | "failed" | string;
  error_msg: string;
  created_at: number;
  sent_at: number;
}

export interface ReplyQueueStats {
  pending_count: number;
  approved_sent_count: number;
  auto_sent_count: number;
  dismissed_count: number;
  failed_count: number;
  auto_sent_last_hour: number;
}

export interface UnifiedScanReport {
  authorized_accounts: string[];
  isolated_accounts_count: number;
  scanned_candidates: number;
  skipped_by_privacy_count: number;
  skipped_reasons: string[];
  total_redactions: number;
  queued_review_count: number;
  auto_sent_count: number;
}

export interface BatchApproveResult {
  sent_count: number;
  failed_count: number;
  errors: string[];
}

export interface ReviseReplyQueueResult {
  item: ReplyQueueItem;
  reply: string;
  thinking: string;
  thinking_ms: number;
}

export interface ComposeAgentBridge {
  senderIdentity: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
  replyContext: string | null;
  redactPii: boolean;
  customRedactTerms: string[];
  onToggleRedactPii: (next: boolean) => void;
  onStreamHtml: (html: string) => void;
  onApplyResult: (res: ComposeAgentResult) => void;
}

export interface ReplyAgentBridge {
  selectedItem: ReplyQueueItem | null;
  onStreamHtml: (html: string) => void;
  onItemUpdated: (item: ReplyQueueItem) => void;
  onPolicyOrQueueChanged: () => void;
}

// ============================================================================
// 统一智能体内核（Unified Agent Kernel）多实例协议类型
// ============================================================================

export type AgentInstanceId = "config" | "mail";

export interface AgentInstanceDescriptor {
  instance_id: AgentInstanceId;
  title: string;
  badge: string;
  subtitle: string;
  placeholder: string;
  supports_config_rollback: boolean;
  starter_prompts: string[];
}

export interface KernelComposeDraftContext {
  sender_identity: string;
  to: string[];
  cc: string[];
  subject: string;
  body_plain: string;
  body_html: string;
  reply_context?: string | null;
}

export interface KernelWorkspaceContext {
  view: string;
  active_account_email: string;
  focused_peer?: string | null;
  compose_draft?: KernelComposeDraftContext | null;
  selected_reply_id?: number | null;
}

export interface KernelTurnRequest {
  instance_id: AgentInstanceId;
  message: string;
  session_id?: string | null;
  request_id?: string | null;
  workspace_context?: KernelWorkspaceContext | null;
}

export interface KernelStreamPayload {
  instance_id: AgentInstanceId | string;
  session_id: string;
  request_id: string;
  kind:
    | "thinking"
    | "content"
    | "tool"
    | "toml"
    | "spec_preview"
    | "compose_html_preview"
    | string;
  delta: string;
  thinking_ms: number;
}

export type KernelClientEffect =
  | {
      type: "config_updated";
      toml: string;
      spec: DeclarativeConfigSpec;
      config_diff?: ConfigDiffReport | null;
    }
  | {
      type: "compose_draft_updated";
      subject?: string | null;
      html?: string | null;
      plain?: string | null;
      redaction_count: number;
      open_compose: boolean;
      to: string[];
    }
  | {
      type: "reply_queue_item_updated";
      item: ReplyQueueItem;
    }
  | {
      type: "reply_scan_completed";
      scanned: number;
      drafted: number;
      auto_sent: number;
    }
  | {
      type: "chat_draft_updated" | "chat_draft_suggested";
      peer: string;
      text: string;
    };

export interface KernelInstanceSnapshot {
  descriptor: AgentInstanceDescriptor;
  agent_config: AgentConfig;
  sessions: AgentSessionSummary[];
  active_session_id: string;
  turns: AgentTurnRecord[];
  path: string;
  toml: string;
  spec: DeclarativeConfigSpec;
  secrets: SecretStatus[];
}

export interface KernelTurnResponse {
  instance_id: AgentInstanceId;
  session_id: string;
  reply: string;
  thinking: string;
  thinking_ms: number;
  tool_steps: string[];
  changes: string[];
  config_diff?: ConfigDiffReport | null;
  secret_prompts: SecretPrompt[];
  suggestions: string[];
  effects: KernelClientEffect[];
  turns: AgentTurnRecord[];
  sessions: AgentSessionSummary[];
  agent_config: AgentConfig;
  toml: string;
  spec: DeclarativeConfigSpec;
  secrets: SecretStatus[];
}
