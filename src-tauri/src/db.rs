//! SQLite 存储：账号、邮件、单聊与群聊聚合、群成员管理、过滤规则、多模型 Agent 配置与演示数据。

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>, pub PathBuf);

/// 归一化 Agent 实例标识：`"mail"` 为邮件处理智能体实例，其余统一归为 `"config"` 声明式配置智能体实例。
pub fn normalize_agent_instance(raw: &str) -> &'static str {
    if raw.trim().eq_ignore_ascii_case("mail") {
        "mail"
    } else {
        "config"
    }
}

pub fn default_instance_session_title(instance_id: &str) -> &'static str {
    if normalize_agent_instance(instance_id) == "mail" {
        "新邮件对话"
    } else {
        "新配置对话"
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Account {
    pub email: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

fn default_preset() -> String {
    "deepseek".into()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub enabled: bool,
    /// 预设标识：deepseek | openai | qwen | kimi | siliconflow | anthropic | gemini | ollama | custom
    #[serde(default = "default_preset")]
    pub preset: String,
    /// 协议类型：openai | anthropic | gemini
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 用户用自然语言描述的处理偏好
    pub instructions: String,
    /// 是否为需要回复的聊天邮件自动起草快捷回复建议
    #[serde(default = "default_true")]
    pub auto_draft: bool,
    /// Agent 判定为垃圾/诈骗邮件时是否自动将该发件人加入屏蔽规则
    #[serde(default)]
    pub auto_block_sender: bool,
    /// 按 preset 保存各自的连接配置，切换模型服务商时不丢失 Key 和模型名
    #[serde(default)]
    pub profiles: HashMap<String, ProviderProfile>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: "deepseek".into(),
            provider: "openai".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: String::new(),
            model: "deepseek-v4.1-flash".into(),
            instructions: "1. 屏蔽营销推广、电商促销、广告群发、钓鱼诈骗和垃圾邮件（block）。\n2. 系统通知、银行账单、登录验证码、物流动态、订阅周刊折叠进「通知」（archive）。\n3. 真人来信、同事/客户工作沟通、需要我回复的重要事项保留在「聊天」（inbox）。".into(),
            auto_draft: true,
            auto_block_sender: false,
            profiles: HashMap::new(),
        }
    }
}

fn default_theme_mode() -> String {
    "light".into()
}
fn default_theme_preset() -> String {
    "mist".into()
}
fn default_theme_density() -> String {
    "comfortable".into()
}
fn default_theme_font_scale() -> String {
    "normal".into()
}

/// 校验并规范化 `#RGB` / `#RRGGBB` / `#RRGGBBAA` 十六进制颜色字符串为小写 `#rrggbb`
pub fn normalize_hex_color(raw: &str) -> Option<String> {
    let clean = raw.trim().trim_start_matches('#');
    if clean.len() == 3 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut out = String::with_capacity(7);
        out.push('#');
        for c in clean.chars() {
            let lc = c.to_ascii_lowercase();
            out.push(lc);
            out.push(lc);
        }
        return Some(out);
    }
    if clean.len() == 6 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("#{}", clean.to_ascii_lowercase()));
    }
    if clean.len() == 8 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("#{}", clean[..6].to_ascii_lowercase()));
    }
    None
}

/// 将外部主题 ID 或名称清洗为合法 slug（仅保留小写字母、数字、`-`、`_`，最长 48 字符）
pub fn sanitize_theme_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_sep = false;
        } else if (ch == '-' || ch == '_' || ch.is_whitespace() || ch == '.') && !out.is_empty() && !prev_sep {
            out.push('-');
            prev_sep = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        let hash = raw
            .bytes()
            .fold(5381u32, |acc, b| acc.wrapping_mul(33).wrapping_add(b as u32));
        format!("theme-{:06x}", hash & 0x00ff_ffff)
    } else {
        trimmed
    }
}

/// 用户加载或分享的第三方自定义主题配色声明（对应 `[[theme.custom_themes]]`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomThemePalette {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    /// 配色基准明暗倾向：light | dark
    #[serde(default = "default_theme_mode")]
    pub base_mode: String,
    /// 窗口外框画布底色 (#rrggbb)
    #[serde(default)]
    pub canvas: String,
    /// 侧栏与会话列表底色 (#rrggbb)
    #[serde(default)]
    pub sidebar: String,
    /// 主界面底色 (#rrggbb)
    #[serde(default)]
    pub surface: String,
    /// 卡片/浮层底色 (#rrggbb，留空自动按色阶推导)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub card: String,
    /// 主正文色 (#rrggbb)
    #[serde(default)]
    pub ink: String,
    /// 次级辅助文字色 (#rrggbb，留空自动推导)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ink_muted: String,
    /// 模板配套主题色 (#rrggbb，随主题模板自动联动)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub accent: String,
}

impl CustomThemePalette {
    pub fn normalized(&self) -> Option<Self> {
        let surface = normalize_hex_color(&self.surface)
            .or_else(|| normalize_hex_color(&self.canvas))?;
        let canvas = normalize_hex_color(&self.canvas).unwrap_or_else(|| surface.clone());
        let sidebar = normalize_hex_color(&self.sidebar).unwrap_or_else(|| canvas.clone());
        let card = normalize_hex_color(&self.card).unwrap_or_default();
        let base_mode = match self.base_mode.trim().to_lowercase().as_str() {
            "dark" | "night" | "hc-dark" | "hcdark" => "dark".to_string(),
            "light" | "day" | "hc-light" | "hclight" => "light".to_string(),
            _ => {
                // 按 surface 亮度自动推断明暗基准
                let r = u8::from_str_radix(&surface[1..3], 16).unwrap_or(255) as u32;
                let g = u8::from_str_radix(&surface[3..5], 16).unwrap_or(255) as u32;
                let b = u8::from_str_radix(&surface[5..7], 16).unwrap_or(255) as u32;
                let luma = (299 * r + 587 * g + 114 * b) / 1000;
                if luma < 128 {
                    "dark".to_string()
                } else {
                    "light".to_string()
                }
            }
        };
        let ink = normalize_hex_color(&self.ink).unwrap_or_else(|| {
            if base_mode == "dark" {
                "#e6edf7".to_string()
            } else {
                "#0f172a".to_string()
            }
        });
        let ink_muted = normalize_hex_color(&self.ink_muted).unwrap_or_default();
        let accent = normalize_hex_color(&self.accent).unwrap_or_else(|| {
            if base_mode == "dark" {
                "#5b85ff".to_string()
            } else {
                "#3563e9".to_string()
            }
        });

        let raw_name = self.name.trim();
        let raw_id = self.id.trim();
        let id = if !raw_id.is_empty() {
            sanitize_theme_id(raw_id)
        } else if !raw_name.is_empty() {
            sanitize_theme_id(raw_name)
        } else {
            sanitize_theme_id(&surface)
        };
        let name = if !raw_name.is_empty() {
            raw_name.chars().take(48).collect()
        } else {
            id.clone()
        };
        let author: String = self.author.trim().chars().take(40).collect();

        Some(Self {
            id,
            name,
            author,
            base_mode,
            canvas,
            sidebar,
            surface,
            card,
            ink,
            ink_muted,
            accent,
        })
    }
}

pub fn normalize_builtin_or_community_preset(raw: &str) -> Option<&'static str> {
    match raw.trim().to_lowercase().as_str() {
        "mist" | "default" => Some("mist"),
        "paper" | "warm" | "cream" => Some("paper"),
        "graphite" | "mono" | "zinc" | "minimal" => Some("graphite"),
        "forest" | "sage" | "mint" => Some("forest"),
        "midnight" | "obsidian" | "abyss" => Some("midnight"),
        // 内置精选社区经典主题配色
        "nord" => Some("nord"),
        "catppuccin-latte" | "catppuccin_latte" | "latte" => Some("catppuccin-latte"),
        "catppuccin-mocha" | "catppuccin_mocha" | "catppuccin" | "mocha" => Some("catppuccin-mocha"),
        "tokyo-night" | "tokyo_night" | "tokyonight" => Some("tokyo-night"),
        "dracula" => Some("dracula"),
        "solarized" | "solarized-light" | "solarized-dark" | "solarized_light" | "solarized_dark" => Some("solarized"),
        "rose-pine" | "rose_pine" | "rosepine" => Some("rose-pine"),
        "gruvbox" | "gruvbox-dark" | "gruvbox-light" | "gruvbox_dark" | "gruvbox_light" => Some("gruvbox"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeConfig {
    /// 外观亮暗模式：light | dark | system
    #[serde(default = "default_theme_mode")]
    pub mode: String,
    /// 主题模板标识：官方模板 / 社区经典模板 / `custom_themes` 中的自定义模板 id（主题色随模板自动联动）
    #[serde(default = "default_theme_preset")]
    pub preset: String,
    /// 界面排版密度：comfortable | compact
    #[serde(default = "default_theme_density")]
    pub density: String,
    /// 全局字号缩放：small | normal | large
    #[serde(default = "default_theme_font_scale")]
    pub font_scale: String,
    /// 已加载的第三方外部主题模板列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_themes: Vec<CustomThemePalette>,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            mode: default_theme_mode(),
            preset: default_theme_preset(),
            density: default_theme_density(),
            font_scale: default_theme_font_scale(),
            custom_themes: Vec::new(),
        }
    }
}

impl ThemeConfig {
    pub fn normalized(&self) -> Self {
        let mode = match self.mode.trim().to_lowercase().as_str() {
            "dark" | "night" => "dark".to_string(),
            "system" | "auto" | "os" => "system".to_string(),
            _ => "light".to_string(),
        };

        let mut custom_themes: Vec<CustomThemePalette> = Vec::new();
        for item in &self.custom_themes {
            if let Some(norm) = item.normalized() {
                if let Some(existing) = custom_themes.iter_mut().find(|x| x.id == norm.id) {
                    *existing = norm;
                } else if custom_themes.len() < 32 {
                    custom_themes.push(norm);
                }
            }
        }

        let raw_preset = self.preset.trim();
        let slug_preset = sanitize_theme_id(raw_preset);
        let preset = if let Some(found) = custom_themes.iter().find(|ct| {
            ct.id.eq_ignore_ascii_case(raw_preset)
                || ct.id.eq_ignore_ascii_case(&slug_preset)
                || ct.name.eq_ignore_ascii_case(raw_preset)
        }) {
            found.id.clone()
        } else if let Some(builtin) = normalize_builtin_or_community_preset(raw_preset) {
            builtin.to_string()
        } else {
            "mist".to_string()
        };

        let density = match self.density.trim().to_lowercase().as_str() {
            "compact" | "dense" | "tight" => "compact".to_string(),
            _ => "comfortable".to_string(),
        };

        let font_scale = match self.font_scale.trim().to_lowercase().as_str() {
            "small" | "sm" => "small".to_string(),
            "large" | "lg" | "big" | "xl" => "large".to_string(),
            _ => "normal".to_string(),
        };

        Self {
            mode,
            preset,
            density,
            font_scale,
            custom_themes,
        }
    }
}

fn default_update_interval_hours() -> u32 {
    6
}

fn default_update_channel() -> String {
    "stable".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateConfig {
    /// 启动后与后台运行时是否自动检查新版本（默认开启）
    #[serde(default = "default_true")]
    pub auto_check: bool,
    /// 发现签名热更新包时是否在后台静默预下载（默认关闭：轻提示用户确认后下载并重启）
    #[serde(default)]
    pub auto_download: bool,
    /// 后台定时检查间隔（小时，取值范围 1 ~ 168，默认 6 小时）
    #[serde(default = "default_update_interval_hours")]
    pub check_interval_hours: u32,
    /// 更新通道：stable（稳定正式版） | beta（含预发布版本）
    #[serde(default = "default_update_channel")]
    pub channel: String,
    /// 用户主动标记跳过的版本号（如 "0.2.2"；手动检查更新时仍会展示）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub skipped_version: String,
    /// 自定义更新清单镜像端点（留空则默认使用 GitHub Releases 官方 latest.json）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub custom_endpoint: String,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            auto_check: true,
            auto_download: false,
            check_interval_hours: default_update_interval_hours(),
            channel: default_update_channel(),
            skipped_version: String::new(),
            custom_endpoint: String::new(),
        }
    }
}

impl UpdateConfig {
    pub fn normalized(&self) -> Self {
        let check_interval_hours = self.check_interval_hours.clamp(1, 168);
        let channel = match self.channel.trim().to_lowercase().as_str() {
            "beta" | "prerelease" | "preview" | "nightly" => "beta".to_string(),
            _ => "stable".to_string(),
        };
        let skipped_version = self
            .skipped_version
            .trim()
            .trim_start_matches(['v', 'V'])
            .to_string();
        let raw_ep = self.custom_endpoint.trim();
        let custom_endpoint = if raw_ep.is_empty() {
            String::new()
        } else if raw_ep.starts_with("https://")
            || (cfg!(debug_assertions) && raw_ep.starts_with("http://"))
        {
            raw_ep.to_string()
        } else {
            String::new()
        };

        Self {
            auto_check: self.auto_check,
            auto_download: self.auto_download,
            check_interval_hours,
            channel,
            skipped_version,
            custom_endpoint,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowConfig {
    /// 点击窗口右上角关闭按钮（×）或系统关闭时是否隐藏到系统托盘（默认 true；false 则直接退出程序）
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// 收到“消息”列表未读新来信且窗口未聚焦/隐藏时，右下角系统托盘图标是否交替闪动提醒
    #[serde(default = "default_true")]
    pub tray_flash_on_message: bool,
    /// 收到“消息”列表未读新来信且窗口在后台/最小化到任务栏时，底部任务栏图标是否高亮闪烁提醒
    #[serde(default = "default_true")]
    pub taskbar_flash_on_message: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            tray_flash_on_message: true,
            taskbar_flash_on_message: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: i64,
    /// allow_sender | block_sender | block_domain | block_keyword | archive_sender | archive_keyword
    pub kind: String,
    pub pattern: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GroupMember {
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    /// 形如 "group:<id>"
    pub peer: String,
    pub name: String,
    pub members: Vec<GroupMember>,
    pub muted: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MailboxStats {
    pub inbox_unread: i64,
    pub archived_unread: i64,
    pub blocked_count: i64,
    pub pending_count: i64,
    pub reply_pending_count: i64,
    pub has_demo: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AttachmentMeta {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: usize,
    /// 旧版字段仅作反序列化兼容保留，禁止自动落盘缓存任何邮件附件
    #[serde(default)]
    pub rel_path: String,
    #[serde(default)]
    pub is_image: bool,
    /// IMAP MIME 分段路径（如 "2"、"1.2"），仅在用户主动点击下载/预览时按需拉取
    #[serde(default)]
    pub part_id: String,
    /// IMAP 分段传输编码（如 "base64"、"quoted-printable"、"7bit"、"8bit"、"binary"）
    #[serde(default)]
    pub encoding: String,
    /// 该附件在原邮件附件列表中的 0-based 序号（供无 part_id 的历史记录回退定位）
    #[serde(default)]
    pub att_index: usize,
    /// 用户主动通过系统“另存为”确认保存后的本地绝对路径（绝不自动写入）
    #[serde(default)]
    pub saved_path: String,
}

#[derive(Debug, Clone)]
pub struct MessageAttachmentLocator {
    pub account_email: String,
    pub folder: String,
    pub uid: u32,
    pub rfc_message_id: String,
    pub meta: AttachmentMeta,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplyQuote {
    pub id: i64,
    pub message_id: String,
    pub sender: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactProfile {
    pub email: String,
    pub alias: String,
    pub note: String,
    pub tag: String,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub peer: String,
    pub name: String,
    pub raw_name: String,
    pub note: String,
    pub preview: String,
    pub last_date: i64,
    pub unread: i64,
    pub count: i64,
    pub category: String,
    pub is_group: bool,
    pub members: Vec<GroupMember>,
    pub muted: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageDto {
    pub id: i64,
    pub peer: String,
    pub from_addr: String,
    pub from_name: String,
    pub subject: String,
    pub body: String,
    pub body_full: String,
    pub body_html: String,
    pub date: i64,
    pub outgoing: bool,
    pub status: String,
    pub category: String,
    pub summary: String,
    pub reason: String,
    pub extracted_code: String,
    pub suggested_reply: String,
    pub attachments: Vec<AttachmentMeta>,
    pub reply_to: Option<ReplyQuote>,
}

/// 写入一封邮件所需的字段
pub struct NewMessage {
    pub folder: String,
    pub uid: u32,
    pub message_id: String,
    pub in_reply_to: String,
    pub references: String,
    pub from_addr: String,
    pub from_name: String,
    pub to_addrs: String,
    pub cc_addrs: String,
    pub subject: String,
    pub body: String,
    pub body_full: String,
    pub body_html: String,
    pub date: i64,
    pub outgoing: bool,
    pub peer: String,
    pub status: String,
    pub category: String,
    pub summary: String,
    pub reason: String,
    pub extracted_code: String,
    pub suggested_reply: String,
    pub read: bool,
    pub agent_done: bool,
    pub attachments: Vec<AttachmentMeta>,
    pub reply_to: Option<ReplyQuote>,
}

#[derive(Debug, Clone)]
pub struct HtmlBackfillItem {
    pub id: i64,
    pub folder: String,
    pub uid: u32,
}

pub struct ReplyContext {
    pub subject: String,
    pub message_id: String,
    pub references: String,
}

pub struct PendingItem {
    pub id: i64,
    pub from_addr: String,
    pub from_name: String,
    pub subject: String,
    pub body_full: String,
    pub existing_code: String,
}

pub struct HistoryItem {
    pub outgoing: bool,
    pub from_name: String,
    pub from_addr: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub turn_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnRecord {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub thinking: String,
    pub thinking_ms: i64,
    pub tool_steps: Vec<String>,
    pub changes: Vec<String>,
    #[serde(default)]
    pub config_diff: Option<crate::config::ConfigDiffReport>,
    #[serde(default)]
    pub snapshot_toml: String,
    pub secret_prompts: Vec<crate::vault::SecretPrompt>,
    pub suggestions: Vec<String>,
    pub created_at: i64,
}

pub struct NewAgentTurn<'a> {
    pub session_id: &'a str,
    pub role: &'a str,
    pub content: &'a str,
    pub thinking: &'a str,
    pub thinking_ms: i64,
    pub tool_steps: &'a [String],
    pub changes: &'a [String],
    pub config_diff: Option<&'a crate::config::ConfigDiffReport>,
    pub snapshot_toml: &'a str,
    pub secret_prompts: &'a [crate::vault::SecretPrompt],
    pub suggestions: &'a [String],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyQueueItem {
    pub id: i64,
    pub account_email: String,
    pub message_id_ref: i64,
    pub rfc_message_id: String,
    pub peer: String,
    pub sender_addr: String,
    pub sender_name: String,
    pub original_subject: String,
    pub original_snippet: String,
    /// 实际送入外部模型的脱敏后文本快照（供前端「入模脱敏审计视图」100% 透明核验）
    pub sanitized_input: String,
    pub redactions: Vec<crate::privacy::RedactionHit>,
    /// "draft_review" | "whitelisted_auto"
    pub permission_tier: String,
    pub permission_reason: String,
    pub draft_subject: String,
    pub draft_body: String,
    pub draft_html: String,
    pub confidence_note: String,
    pub dlp_warning: String,
    /// "pending_review" | "approved_sent" | "auto_sent" | "dismissed" | "failed"
    pub status: String,
    pub error_msg: String,
    pub created_at: i64,
    pub sent_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplyQueueStats {
    pub pending_count: i64,
    pub approved_sent_count: i64,
    pub auto_sent_count: i64,
    pub dismissed_count: i64,
    pub failed_count: i64,
    pub auto_sent_last_hour: usize,
}

#[derive(Debug, Clone)]
pub struct CandidateMetaRow {
    pub message_id_pk: i64,
    pub account_email: String,
    pub rfc_message_id: String,
    pub peer: String,
    pub from_addr: String,
    pub from_name: String,
    pub subject: String,
    pub status: String,
    pub category: String,
    pub extracted_code: String,
    pub date: i64,
}

pub struct NewReplyQueueItem<'a> {
    pub account_email: &'a str,
    pub message_id_ref: i64,
    pub rfc_message_id: &'a str,
    pub peer: &'a str,
    pub sender_addr: &'a str,
    pub sender_name: &'a str,
    pub original_subject: &'a str,
    pub original_snippet: &'a str,
    pub sanitized_input: &'a str,
    pub redactions: &'a [crate::privacy::RedactionHit],
    pub permission_tier: &'a str,
    pub permission_reason: &'a str,
    pub draft_subject: &'a str,
    pub draft_body: &'a str,
    pub draft_html: &'a str,
    pub confidence_note: &'a str,
    pub dlp_warning: &'a str,
    pub status: &'a str,
    pub error_msg: &'a str,
}

pub fn normalize_members(list: &[GroupMember], exclude_email: &str) -> Vec<GroupMember> {
    let ex = exclude_email.trim().to_lowercase();
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for m in list {
        let email = m.email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') || (!ex.is_empty() && email == ex) {
            continue;
        }
        let name = m.name.trim().to_string();
        map.entry(email)
            .and_modify(|existing| {
                if existing.is_empty() && !name.is_empty() {
                    *existing = name.clone();
                }
            })
            .or_insert(name);
    }
    map.into_iter()
        .map(|(email, name)| GroupMember { email, name })
        .collect()
}

pub fn default_group_title(subject: &str, members: &[GroupMember]) -> String {
    let cleaned = subject
        .trim()
        .trim_start_matches(|c: char| c.is_whitespace())
        .to_string();
    let stripped = regex::Regex::new(r"(?i)^((re|fwd?|回复|转发)\s*[:：]\s*)+")
        .map(|re| re.replace(&cleaned, "").trim().to_string())
        .unwrap_or(cleaned);
    if !stripped.is_empty() && stripped != "(无主题)" {
        return stripped.chars().take(36).collect();
    }
    let names: Vec<String> = members
        .iter()
        .take(3)
        .map(|m| {
            if !m.name.trim().is_empty() {
                m.name.trim().to_string()
            } else {
                m.email.split('@').next().unwrap_or(&m.email).to_string()
            }
        })
        .collect();
    if names.is_empty() {
        "未命名群聊".into()
    } else if members.len() > 3 {
        format!("{} 等 {} 人", names.join("、"), members.len() + 1)
    } else {
        format!("{} 群聊", names.join("、"))
    }
}

pub const UNBOUND_SCOPE: &str = "__unbound__";

pub fn scope_key(email: &str) -> String {
    let clean = email.trim().to_lowercase();
    if clean.is_empty() {
        UNBOUND_SCOPE.to_string()
    } else {
        clean
    }
}

fn normalize_account_record(a: &Account, keep_password: bool) -> Account {
    let email = a.email.trim().to_lowercase();
    let username = if a.username.trim().is_empty() {
        email.clone()
    } else {
        a.username.trim().to_string()
    };
    Account {
        email,
        display_name: a.display_name.trim().to_string(),
        imap_host: a.imap_host.trim().to_string(),
        imap_port: if a.imap_port == 0 { 993 } else { a.imap_port },
        smtp_host: a.smtp_host.trim().to_string(),
        smtp_port: if a.smtp_port == 0 { 465 } else { a.smtp_port },
        username,
        password: if keep_password {
            a.password.clone()
        } else {
            String::new()
        },
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL, pattern TEXT NOT NULL,
                UNIQUE(kind, pattern)
            );
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL DEFAULT 'config',
                title TEXT NOT NULL DEFAULT '新配置对话',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                thinking TEXT NOT NULL DEFAULT '',
                thinking_ms INTEGER NOT NULL DEFAULT 0,
                tool_steps_json TEXT NOT NULL DEFAULT '[]',
                changes_json TEXT NOT NULL DEFAULT '[]',
                config_diff_json TEXT NOT NULL DEFAULT '',
                snapshot_toml TEXT NOT NULL DEFAULT '',
                secret_prompts_json TEXT NOT NULL DEFAULT '[]',
                suggestions_json TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_turns_session ON agent_turns(session_id, id);
            CREATE TABLE IF NOT EXISTS contact_profiles (
                account_email TEXT NOT NULL DEFAULT '__unbound__',
                email TEXT NOT NULL,
                alias TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                tag TEXT NOT NULL DEFAULT '',
                muted INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_email, email)
            );
            "#,
        )?;
        let _ = conn.execute(
            "ALTER TABLE agent_turns ADD COLUMN config_diff_json TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE agent_turns ADD COLUMN snapshot_toml TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE agent_sessions ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'config'",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_inst ON agent_sessions(instance_id, updated_at DESC)",
            [],
        );

        let has_messages_table: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='messages'",
            [],
            |r| r.get(0),
        )?;

        if !has_messages_table {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_email TEXT NOT NULL DEFAULT '__unbound__',
                    folder TEXT NOT NULL,
                    uid INTEGER NOT NULL,
                    message_id TEXT NOT NULL,
                    in_reply_to TEXT NOT NULL DEFAULT '',
                    references_hdr TEXT NOT NULL DEFAULT '',
                    from_addr TEXT NOT NULL,
                    from_name TEXT NOT NULL DEFAULT '',
                    to_addrs TEXT NOT NULL DEFAULT '',
                    cc_addrs TEXT NOT NULL DEFAULT '',
                    subject TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL DEFAULT '',
                    body_full TEXT NOT NULL DEFAULT '',
                    body_html TEXT NOT NULL DEFAULT '',
                    date INTEGER NOT NULL,
                    outgoing INTEGER NOT NULL DEFAULT 0,
                    peer TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'inbox',
                    category TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    reason TEXT NOT NULL DEFAULT '',
                    extracted_code TEXT NOT NULL DEFAULT '',
                    suggested_reply TEXT NOT NULL DEFAULT '',
                    read INTEGER NOT NULL DEFAULT 0,
                    agent_done INTEGER NOT NULL DEFAULT 0,
                    html_checked INTEGER NOT NULL DEFAULT 0,
                    attachments_json TEXT NOT NULL DEFAULT '[]',
                    reply_to_json TEXT NOT NULL DEFAULT '',
                    UNIQUE(account_email, message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_msg_acc_peer ON messages(account_email, peer, status, date);
                CREATE TABLE IF NOT EXISTS sync_state (
                    account_email TEXT NOT NULL DEFAULT '__unbound__',
                    folder TEXT NOT NULL,
                    uidvalidity INTEGER NOT NULL,
                    last_uid INTEGER NOT NULL,
                    PRIMARY KEY (account_email, folder)
                );
                CREATE TABLE IF NOT EXISTS groups (
                    account_email TEXT NOT NULL DEFAULT '__unbound__',
                    peer TEXT NOT NULL,
                    name TEXT NOT NULL,
                    members_json TEXT NOT NULL DEFAULT '[]',
                    muted INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL DEFAULT 0,
                    is_demo INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (account_email, peer)
                );
                "#,
            )?;
        } else {
            // 确保旧表补齐所有历史增量列后再检查多账号隔离迁移
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS sync_state (
                    folder TEXT PRIMARY KEY, uidvalidity INTEGER NOT NULL, last_uid INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS groups (
                    peer TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    members_json TEXT NOT NULL DEFAULT '[]',
                    muted INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL DEFAULT 0,
                    is_demo INTEGER NOT NULL DEFAULT 0
                );
                "#,
            )?;
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN extracted_code TEXT NOT NULL DEFAULT ''", []);
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN suggested_reply TEXT NOT NULL DEFAULT ''", []);
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN cc_addrs TEXT NOT NULL DEFAULT ''", []);
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN body_html TEXT NOT NULL DEFAULT ''", []);
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN html_checked INTEGER NOT NULL DEFAULT 0", []);
            let _ = conn.execute("ALTER TABLE groups ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0", []);

            let has_account_col: bool = {
                let mut st = conn.prepare("PRAGMA table_info(messages)")?;
                let cols: Vec<String> = st
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                cols.iter().any(|c| c == "account_email")
            };

            if !has_account_col {
                let legacy_acc: Option<Account> = conn
                    .query_row("SELECT value FROM kv WHERE key='account'", [], |r| r.get::<_, String>(0))
                    .optional()?
                    .and_then(|s| serde_json::from_str::<Account>(&s).ok());
                let legacy_scope = legacy_acc
                    .as_ref()
                    .map(|a| scope_key(&a.email))
                    .unwrap_or_else(|| UNBOUND_SCOPE.to_string());

                let tx = conn.transaction()?;
                tx.execute_batch(
                    r#"
                    CREATE TABLE messages_v2 (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_email TEXT NOT NULL DEFAULT '__unbound__',
                        folder TEXT NOT NULL,
                        uid INTEGER NOT NULL,
                        message_id TEXT NOT NULL,
                        in_reply_to TEXT NOT NULL DEFAULT '',
                        references_hdr TEXT NOT NULL DEFAULT '',
                        from_addr TEXT NOT NULL,
                        from_name TEXT NOT NULL DEFAULT '',
                        to_addrs TEXT NOT NULL DEFAULT '',
                        cc_addrs TEXT NOT NULL DEFAULT '',
                        subject TEXT NOT NULL DEFAULT '',
                        body TEXT NOT NULL DEFAULT '',
                        body_full TEXT NOT NULL DEFAULT '',
                        body_html TEXT NOT NULL DEFAULT '',
                        date INTEGER NOT NULL,
                        outgoing INTEGER NOT NULL DEFAULT 0,
                        peer TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'inbox',
                        category TEXT NOT NULL DEFAULT '',
                        summary TEXT NOT NULL DEFAULT '',
                        reason TEXT NOT NULL DEFAULT '',
                        extracted_code TEXT NOT NULL DEFAULT '',
                        suggested_reply TEXT NOT NULL DEFAULT '',
                        read INTEGER NOT NULL DEFAULT 0,
                        agent_done INTEGER NOT NULL DEFAULT 0,
                        html_checked INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(account_email, message_id)
                    );
                    "#,
                )?;
                tx.execute(
                    r#"
                    INSERT OR IGNORE INTO messages_v2 (
                        id, account_email, folder, uid, message_id, in_reply_to, references_hdr,
                        from_addr, from_name, to_addrs, cc_addrs, subject, body, body_full, body_html,
                        date, outgoing, peer, status, category, summary, reason,
                        extracted_code, suggested_reply, read, agent_done, html_checked
                    )
                    SELECT
                        id, ?1, folder, uid, message_id, in_reply_to, references_hdr,
                        from_addr, from_name, to_addrs, cc_addrs, subject, body, body_full, body_html,
                        date, outgoing, peer, status, category, summary, reason,
                        extracted_code, suggested_reply, read, agent_done, html_checked
                    FROM messages
                    "#,
                    [&legacy_scope],
                )?;
                tx.execute_batch(
                    r#"
                    DROP TABLE messages;
                    ALTER TABLE messages_v2 RENAME TO messages;
                    CREATE INDEX IF NOT EXISTS idx_msg_acc_peer ON messages(account_email, peer, status, date);

                    CREATE TABLE sync_state_v2 (
                        account_email TEXT NOT NULL DEFAULT '__unbound__',
                        folder TEXT NOT NULL,
                        uidvalidity INTEGER NOT NULL,
                        last_uid INTEGER NOT NULL,
                        PRIMARY KEY (account_email, folder)
                    );
                    "#,
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO sync_state_v2 (account_email, folder, uidvalidity, last_uid)
                     SELECT ?1, folder, uidvalidity, last_uid FROM sync_state",
                    [&legacy_scope],
                )?;
                tx.execute_batch(
                    r#"
                    DROP TABLE sync_state;
                    ALTER TABLE sync_state_v2 RENAME TO sync_state;

                    CREATE TABLE groups_v2 (
                        account_email TEXT NOT NULL DEFAULT '__unbound__',
                        peer TEXT NOT NULL,
                        name TEXT NOT NULL,
                        members_json TEXT NOT NULL DEFAULT '[]',
                        muted INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL DEFAULT 0,
                        is_demo INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (account_email, peer)
                    );
                    "#,
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO groups_v2 (account_email, peer, name, members_json, muted, created_at, is_demo)
                     SELECT ?1, peer, name, members_json, muted, created_at, is_demo FROM groups",
                    [&legacy_scope],
                )?;
                tx.execute_batch(
                    r#"
                    DROP TABLE groups;
                    ALTER TABLE groups_v2 RENAME TO groups;
                    "#,
                )?;

                if let Some(acc) = legacy_acc {
                    let norm = normalize_account_record(&acc, true);
                    if !norm.email.is_empty() {
                        let has_accounts_kv: bool = tx.query_row(
                            "SELECT COUNT(*) > 0 FROM kv WHERE key='accounts'",
                            [],
                            |r| r.get(0),
                        )?;
                        if !has_accounts_kv {
                            tx.execute(
                                "INSERT INTO kv(key,value) VALUES('accounts',?1)
                                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                [serde_json::to_string(&vec![norm.clone()])?],
                            )?;
                            tx.execute(
                                "INSERT INTO kv(key,value) VALUES('active_account_email',?1)
                                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                [serde_json::to_string(&norm.email)?],
                            )?;
                        }
                    }
                }

                tx.commit()?;
            }
        }

        let _ = conn.execute("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'", []);
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT ''", []);
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS conv_prefs (
                account_email TEXT NOT NULL DEFAULT '__unbound__',
                peer TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER NOT NULL DEFAULT 0,
                manual_unread INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_email, peer)
            );
            CREATE TABLE IF NOT EXISTS reply_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_email TEXT NOT NULL DEFAULT '__unbound__',
                message_id_ref INTEGER NOT NULL,
                rfc_message_id TEXT NOT NULL DEFAULT '',
                peer TEXT NOT NULL,
                sender_addr TEXT NOT NULL,
                sender_name TEXT NOT NULL DEFAULT '',
                original_subject TEXT NOT NULL DEFAULT '',
                original_snippet TEXT NOT NULL DEFAULT '',
                sanitized_input TEXT NOT NULL DEFAULT '',
                redactions_json TEXT NOT NULL DEFAULT '[]',
                permission_tier TEXT NOT NULL DEFAULT 'draft_review',
                permission_reason TEXT NOT NULL DEFAULT '',
                draft_subject TEXT NOT NULL DEFAULT '',
                draft_body TEXT NOT NULL DEFAULT '',
                draft_html TEXT NOT NULL DEFAULT '',
                confidence_note TEXT NOT NULL DEFAULT '',
                dlp_warning TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending_review',
                error_msg TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                sent_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(account_email, message_id_ref)
            );
            CREATE INDEX IF NOT EXISTS idx_reply_queue_status ON reply_queue(status, created_at DESC);
            "#,
        )?;
        // 将早期版本滞留在不可见 pending 状态的新邮件立即恢复至 inbox（AI 分拣统一通过 agent_done=0 后台推进）
        let _ = conn.execute("UPDATE messages SET status='inbox' WHERE status='pending'", []);
        // 清理日常短句聊天气泡下方冗余生成的复读型 AI 摘要框
        let _ = conn.execute(
            "UPDATE messages SET summary='' WHERE status='inbox' AND summary<>'' AND LENGTH(TRIM(body)) > 0 AND LENGTH(TRIM(body)) <= 140",
            [],
        );
        let attachments_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("attachments");
        // 安全治理：彻底清理旧版同步期间在后台自动落盘缓存的全部邮件附件（严禁未经用户确认将任何 .exe/.docx 等附件写入本地磁盘）
        if attachments_dir.exists() {
            let _ = std::fs::remove_dir_all(&attachments_dir);
        }
        let db = Db(Mutex::new(conn), attachments_dir);
        let _ = db.ensure_accounts_migrated();
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn attachments_dir(&self) -> &Path {
        &self.1
    }

    fn kv_get<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>> {
        let c = self.0.lock().unwrap();
        let v: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
            .optional()?;
        Ok(match v {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    fn kv_set<T: Serialize + ?Sized>(&self, key: &str, v: &T) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(v)?],
        )?;
        Ok(())
    }

    fn ensure_accounts_migrated(&self) -> Result<()> {
        if self.kv_get::<Vec<Account>>("accounts")?.is_none() {
            if let Some(legacy) = self.kv_get::<Account>("account")? {
                let norm = normalize_account_record(&legacy, true);
                if !norm.email.is_empty() {
                    self.kv_set("accounts", &vec![norm.clone()])?;
                    self.kv_set("active_account_email", &norm.email)?;
                }
            }
        }
        Ok(())
    }

    fn persist_accounts_state(&self, list: &[Account], preferred_active: &str) -> Result<()> {
        let pref = preferred_active.trim().to_lowercase();
        let resolved_active = if !pref.is_empty() && list.iter().any(|a| a.email.eq_ignore_ascii_case(&pref)) {
            pref
        } else {
            list.first().map(|a| a.email.to_lowercase()).unwrap_or_default()
        };

        self.kv_set("accounts", list)?;
        self.kv_set("active_account_email", &resolved_active)?;

        if let Some(active_acc) = list.iter().find(|a| a.email.eq_ignore_ascii_case(&resolved_active)) {
            self.kv_set("account", active_acc)?;
        } else {
            self.0.lock().unwrap().execute("DELETE FROM kv WHERE key='account'", [])?;
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        if let Some(list) = self.kv_get::<Vec<Account>>("accounts")? {
            let cleaned: Vec<Account> = list
                .into_iter()
                .map(|a| normalize_account_record(&a, true))
                .filter(|a| !a.email.is_empty())
                .collect();
            return Ok(cleaned);
        }
        if let Some(single) = self.kv_get::<Account>("account")? {
            let norm = normalize_account_record(&single, true);
            if !norm.email.is_empty() {
                return Ok(vec![norm]);
            }
        }
        Ok(Vec::new())
    }

    pub fn account_emails(&self) -> Result<Vec<String>> {
        Ok(self.list_accounts()?.into_iter().map(|a| a.email).collect())
    }

    pub fn active_account_email(&self) -> Result<String> {
        let list = self.list_accounts()?;
        if list.is_empty() {
            return Ok(String::new());
        }
        if let Some(saved) = self.kv_get::<String>("active_account_email")? {
            let clean = saved.trim().to_lowercase();
            if let Some(hit) = list.iter().find(|a| a.email == clean) {
                return Ok(hit.email.clone());
            }
        }
        Ok(list[0].email.clone())
    }

    pub fn active_scope_email(&self) -> Result<String> {
        Ok(scope_key(&self.active_account_email()?))
    }

    pub fn account(&self) -> Result<Option<Account>> {
        let list = self.list_accounts()?;
        if list.is_empty() {
            return Ok(None);
        }
        let active = self.active_account_email()?;
        Ok(list
            .iter()
            .find(|a| a.email == active)
            .cloned()
            .or_else(|| list.into_iter().next()))
    }

    pub fn account_by_email(&self, email: &str) -> Result<Option<Account>> {
        let target = email.trim().to_lowercase();
        if target.is_empty() {
            return Ok(None);
        }
        Ok(self.list_accounts()?.into_iter().find(|a| a.email == target))
    }

    pub fn upsert_account(&self, a: &Account, set_active: bool) -> Result<()> {
        let norm = normalize_account_record(a, false);
        if norm.email.is_empty() {
            anyhow::bail!("邮箱地址不能为空");
        }
        let mut list = self.list_accounts()?;
        for item in &mut list {
            item.password.clear();
        }
        let prev_active = self.active_account_email()?;
        if let Some(existing) = list.iter_mut().find(|x| x.email == norm.email) {
            *existing = norm.clone();
        } else {
            list.push(norm.clone());
        }
        let next_active = if set_active || prev_active.is_empty() {
            norm.email
        } else {
            prev_active
        };
        self.persist_accounts_state(&list, &next_active)
    }

    #[allow(dead_code)]
    pub fn save_account(&self, a: &Account) -> Result<()> {
        self.upsert_account(a, true)
    }

    pub fn set_active_account(&self, email: &str) -> Result<Account> {
        let target = email.trim().to_lowercase();
        if target.is_empty() {
            anyhow::bail!("请选择有效的邮箱账号");
        }
        let mut list = self.list_accounts()?;
        for item in &mut list {
            item.password.clear();
        }
        let acc = list
            .iter()
            .find(|a| a.email == target)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("未找到已接入的邮箱账号: {target}"))?;
        self.persist_accounts_state(&list, &target)?;
        Ok(acc)
    }

    pub fn remove_account(&self, email: &str, delete_data: bool) -> Result<Option<Account>> {
        let target = email.trim().to_lowercase();
        if target.is_empty() {
            return self.account();
        }
        let prev_active = self.active_account_email()?;
        let mut list = self.list_accounts()?;
        for item in &mut list {
            item.password.clear();
        }
        list.retain(|a| a.email != target);
        let next_active = if prev_active == target {
            list.first().map(|a| a.email.clone()).unwrap_or_default()
        } else {
            prev_active
        };
        self.persist_accounts_state(&list, &next_active)?;

        if delete_data {
            let c = self.0.lock().unwrap();
            let _ = c.execute("DELETE FROM messages WHERE account_email=?1", [&target]);
            let _ = c.execute("DELETE FROM sync_state WHERE account_email=?1", [&target]);
            let _ = c.execute("DELETE FROM groups WHERE account_email=?1", [&target]);
            let _ = c.execute("DELETE FROM contact_profiles WHERE account_email=?1", [&target]);
            let _ = c.execute("DELETE FROM conv_prefs WHERE account_email=?1", [&target]);
        }

        self.account()
    }

    pub fn replace_accounts(&self, raw_list: &[Account], preferred_active: &str) -> Result<()> {
        let mut deduped: Vec<Account> = Vec::new();
        for item in raw_list {
            let norm = normalize_account_record(item, false);
            if norm.email.is_empty() {
                continue;
            }
            if let Some(existing) = deduped.iter_mut().find(|x| x.email == norm.email) {
                *existing = norm;
            } else {
                deduped.push(norm);
            }
        }
        self.persist_accounts_state(&deduped, preferred_active)
    }

    /// 调整已接入多邮箱账号的展示先后顺序（不影响当前活跃邮箱与各自数据）
    pub fn reorder_accounts(&self, ordered_emails: &[String]) -> Result<()> {
        let mut current = self.list_accounts()?;
        for item in &mut current {
            item.password.clear();
        }
        if current.len() <= 1 {
            return Ok(());
        }
        let prev_active = self.active_account_email()?;
        let mut reordered: Vec<Account> = Vec::with_capacity(current.len());
        for raw in ordered_emails {
            let target = raw.trim().to_lowercase();
            if target.is_empty() {
                continue;
            }
            if let Some(pos) = current.iter().position(|a| a.email == target) {
                reordered.push(current.remove(pos));
            }
        }
        reordered.extend(current);
        self.persist_accounts_state(&reordered, &prev_active)
    }

    pub fn clear_account(&self) -> Result<()> {
        self.persist_accounts_state(&[], "")
    }

    pub fn unread_counts_by_account(&self) -> Result<HashMap<String, i64>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT account_email, COUNT(*) FROM messages
             WHERE status='inbox' AND read=0 AND outgoing=0
             GROUP BY account_email",
        )?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut counts = rows.collect::<rusqlite::Result<HashMap<_, _>>>()?;

        let mut manual_st = c.prepare(
            "SELECT p.account_email, COUNT(*) FROM conv_prefs p
             WHERE p.manual_unread=1
               AND (
                 EXISTS (SELECT 1 FROM messages m WHERE m.account_email=p.account_email AND m.peer=p.peer AND m.status='inbox')
                 OR EXISTS (SELECT 1 FROM groups g WHERE g.account_email=p.account_email AND g.peer=p.peer AND g.muted=0
                            AND NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.account_email=p.account_email AND m2.peer=p.peer))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM messages m3
                 WHERE m3.account_email=p.account_email AND m3.peer=p.peer AND m3.status='inbox' AND m3.read=0 AND m3.outgoing=0
               )
             GROUP BY p.account_email",
        )?;
        let manual_rows = manual_st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for item in manual_rows {
            let (acc, n) = item?;
            *counts.entry(acc).or_insert(0) += n;
        }
        Ok(counts)
    }

    pub fn agent_config(&self) -> Result<AgentConfig> {
        Ok(self.kv_get("agent")?.unwrap_or_default())
    }
    pub fn save_agent_config(&self, a: &AgentConfig) -> Result<()> {
        self.kv_set("agent", a)
    }

    /// 读取指定 Agent 实例（`"config"` | `"mail"`）的独立模型配置：
    /// - `"config"` 实例绑定 `config.toml` 的 `[agent]`（存储于 `kv["agent"]`）；
    /// - `"mail"` 实例拥有独立的 `kv["mail_agent_config"]`（首次未单独指定时继承 `[agent]`，合并共享自定义 `profiles`，且互不覆盖激活模型）。
    pub fn instance_agent_config(&self, instance_id: &str) -> Result<AgentConfig> {
        if normalize_agent_instance(instance_id) == "mail" {
            let base = self.agent_config()?;
            if let Some(mut custom) = self.kv_get::<AgentConfig>("mail_agent_config")? {
                for (k, v) in base.profiles {
                    custom.profiles.entry(k).or_insert(v);
                }
                return Ok(custom);
            }
            return Ok(base);
        }
        self.agent_config()
    }

    pub fn save_instance_agent_config(&self, instance_id: &str, a: &AgentConfig) -> Result<()> {
        if normalize_agent_instance(instance_id) == "mail" {
            self.kv_set("mail_agent_config", a)
        } else {
            self.save_agent_config(a)
        }
    }

    pub fn theme_config(&self) -> Result<ThemeConfig> {
        Ok(self
            .kv_get::<ThemeConfig>("theme_config")?
            .unwrap_or_default()
            .normalized())
    }
    pub fn save_theme_config(&self, t: &ThemeConfig) -> Result<()> {
        self.kv_set("theme_config", &t.normalized())
    }

    pub fn update_config(&self) -> Result<UpdateConfig> {
        Ok(self
            .kv_get::<UpdateConfig>("update_config")?
            .unwrap_or_default()
            .normalized())
    }
    pub fn save_update_config(&self, u: &UpdateConfig) -> Result<()> {
        self.kv_set("update_config", &u.normalized())
    }

    pub fn window_config(&self) -> Result<WindowConfig> {
        Ok(self
            .kv_get::<WindowConfig>("window_config")?
            .unwrap_or_default())
    }
    pub fn save_window_config(&self, w: &WindowConfig) -> Result<()> {
        self.kv_set("window_config", w)
    }

    pub fn is_unread_inbox_message(&self, id: i64) -> bool {
        let c = self.0.lock().unwrap();
        c.query_row(
            "SELECT 1 FROM messages WHERE id=?1 AND status='inbox' AND read=0 AND outgoing=0",
            [id],
            |_| Ok(true),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or(false)
    }

    pub fn total_real_inbox_unread(&self) -> i64 {
        let Ok(accounts) = self.list_accounts() else {
            return 0;
        };
        if accounts.is_empty() {
            return 0;
        }
        let Ok(map) = self.unread_counts_by_account() else {
            return 0;
        };
        accounts
            .iter()
            .map(|a| map.get(&a.email.trim().to_lowercase()).copied().unwrap_or(0))
            .sum()
    }

    pub fn sync_state_for(&self, account_email: &str, folder: &str) -> Result<(u32, u32)> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        Ok(c
            .query_row(
                "SELECT uidvalidity, last_uid FROM sync_state WHERE account_email=?1 AND folder=?2",
                params![scope, folder],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0)))
    }

    #[allow(dead_code)]
    pub fn sync_state(&self, folder: &str) -> Result<(u32, u32)> {
        let scope = self.active_scope_email()?;
        self.sync_state_for(&scope, folder)
    }

    pub fn save_sync_state_for(
        &self,
        account_email: &str,
        folder: &str,
        validity: u32,
        last_uid: u32,
    ) -> Result<()> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO sync_state(account_email,folder,uidvalidity,last_uid) VALUES(?1,?2,?3,?4)
             ON CONFLICT(account_email,folder) DO UPDATE SET
               uidvalidity=excluded.uidvalidity,
               last_uid=CASE
                 WHEN sync_state.uidvalidity=excluded.uidvalidity AND sync_state.last_uid>excluded.last_uid
                 THEN sync_state.last_uid
                 ELSE excluded.last_uid
               END",
            params![scope, folder, validity, last_uid],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn save_sync_state(&self, folder: &str, validity: u32, last_uid: u32) -> Result<()> {
        let scope = self.active_scope_email()?;
        self.save_sync_state_for(&scope, folder, validity, last_uid)
    }

    /// 根据 In-Reply-To / References 查找是否已经属于指定账号下的某个现有群聊线程
    pub fn find_group_by_refs_for(&self, account_email: &str, ref_ids: &[String]) -> Result<Option<String>> {
        if ref_ids.is_empty() {
            return Ok(None);
        }
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        for mid in ref_ids.iter().rev() {
            let clean = mid.trim_matches(&['<', '>', ' '][..]);
            if clean.is_empty() {
                continue;
            }
            let found: Option<String> = c
                .query_row(
                    "SELECT peer FROM messages WHERE account_email=?1 AND message_id=?2 AND peer LIKE 'group:%' LIMIT 1",
                    params![scope, clean],
                    |r| r.get(0),
                )
                .optional()?;
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }

    #[allow(dead_code)]
    pub fn find_group_by_refs(&self, ref_ids: &[String]) -> Result<Option<String>> {
        let scope = self.active_scope_email()?;
        self.find_group_by_refs_for(&scope, ref_ids)
    }

    pub fn get_group_for(&self, account_email: &str, peer: &str) -> Result<Option<GroupInfo>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let row: Option<(String, String, bool)> = c
            .query_row(
                "SELECT name, members_json, muted FROM groups WHERE account_email=?1 AND peer=?2",
                params![scope, peer],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(match row {
            Some((name, json_str, muted)) => {
                let members: Vec<GroupMember> = serde_json::from_str(&json_str).unwrap_or_default();
                Some(GroupInfo {
                    peer: peer.to_string(),
                    name,
                    members,
                    muted,
                })
            }
            None => None,
        })
    }

    pub fn get_group(&self, peer: &str) -> Result<Option<GroupInfo>> {
        let scope = self.active_scope_email()?;
        self.get_group_for(&scope, peer)
    }

    fn all_groups_map_for(&self, account_email: &str) -> Result<HashMap<String, (GroupInfo, i64)>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT peer, name, members_json, muted, created_at FROM groups WHERE account_email=?1",
        )?;
        let rows = st.query_map([scope], |r| {
            let peer: String = r.get(0)?;
            let name: String = r.get(1)?;
            let json_str: String = r.get(2)?;
            let muted: bool = r.get(3)?;
            let created_at: i64 = r.get(4)?;
            let members: Vec<GroupMember> = serde_json::from_str(&json_str).unwrap_or_default();
            Ok((
                peer.clone(),
                (
                    GroupInfo {
                        peer,
                        name,
                        members,
                        muted,
                    },
                    created_at,
                ),
            ))
        })?;
        Ok(rows.collect::<std::result::Result<HashMap<_, _>, _>>()?)
    }

    /// 创建或合并更新指定账号下的群聊成员（保留用户已修改过的群名称和免打扰开关）
    pub fn upsert_group_for(
        &self,
        account_email: &str,
        peer: &str,
        default_name: &str,
        discovered_members: &[GroupMember],
        exclude_me: &str,
        is_demo: bool,
    ) -> Result<GroupInfo> {
        let scope = scope_key(account_email);
        if let Some(existing) = self.get_group_for(&scope, peer)? {
            let mut merged = existing.members;
            merged.extend_from_slice(discovered_members);
            let members = normalize_members(&merged, exclude_me);
            let c = self.0.lock().unwrap();
            c.execute(
                "UPDATE groups SET members_json=?3 WHERE account_email=?1 AND peer=?2",
                params![scope, peer, serde_json::to_string(&members)?],
            )?;
            Ok(GroupInfo {
                peer: peer.to_string(),
                name: existing.name,
                members,
                muted: existing.muted,
            })
        } else {
            let members = normalize_members(discovered_members, exclude_me);
            let name = if default_name.trim().is_empty() {
                default_group_title("", &members)
            } else {
                default_name.trim().to_string()
            };
            let now = chrono::Utc::now().timestamp();
            let c = self.0.lock().unwrap();
            c.execute(
                "INSERT INTO groups(account_email, peer, name, members_json, muted, created_at, is_demo)
                 VALUES(?1, ?2, ?3, ?4, 0, ?5, ?6)",
                params![scope, peer, name, serde_json::to_string(&members)?, now, is_demo as i32],
            )?;
            Ok(GroupInfo {
                peer: peer.to_string(),
                name,
                members,
                muted: false,
            })
        }
    }

    pub fn upsert_group(
        &self,
        peer: &str,
        default_name: &str,
        discovered_members: &[GroupMember],
        exclude_me: &str,
        is_demo: bool,
    ) -> Result<GroupInfo> {
        let scope = self.active_scope_email()?;
        self.upsert_group_for(&scope, peer, default_name, discovered_members, exclude_me, is_demo)
    }

    /// 用户手动发起群聊
    pub fn create_group(&self, name: &str, members: &[GroupMember], exclude_me: &str) -> Result<GroupInfo> {
        let scope = self.active_scope_email()?;
        let normalized = normalize_members(members, exclude_me);
        if normalized.is_empty() {
            anyhow::bail!("请至少添加 1 位有效的群成员邮箱");
        }
        let peer = format!("group:grp-{}", uuid::Uuid::new_v4());
        let final_name = if name.trim().is_empty() {
            default_group_title("", &normalized)
        } else {
            name.trim().to_string()
        };
        let now = chrono::Utc::now().timestamp();
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO groups(account_email, peer, name, members_json, muted, created_at, is_demo)
             VALUES(?1, ?2, ?3, ?4, 0, ?5, 0)",
            params![scope, peer, final_name, serde_json::to_string(&normalized)?, now],
        )?;
        Ok(GroupInfo {
            peer,
            name: final_name,
            members: normalized,
            muted: false,
        })
    }

    /// 修改群名称、群成员列表与免打扰设置
    pub fn update_group_for(
        &self,
        account_email: &str,
        peer: &str,
        name: &str,
        members: &[GroupMember],
        muted: bool,
        exclude_me: &str,
    ) -> Result<GroupInfo> {
        let scope = scope_key(account_email);
        let normalized = normalize_members(members, exclude_me);
        if normalized.is_empty() {
            anyhow::bail!("群成员不能为空");
        }
        let final_name = if name.trim().is_empty() {
            default_group_title("", &normalized)
        } else {
            name.trim().to_string()
        };
        let c = self.0.lock().unwrap();
        c.execute(
            "UPDATE groups SET name=?3, members_json=?4, muted=?5 WHERE account_email=?1 AND peer=?2",
            params![scope, peer, final_name, serde_json::to_string(&normalized)?, muted as i32],
        )?;
        Ok(GroupInfo {
            peer: peer.to_string(),
            name: final_name,
            members: normalized,
            muted,
        })
    }

    pub fn update_group(
        &self,
        peer: &str,
        name: &str,
        members: &[GroupMember],
        muted: bool,
        exclude_me: &str,
    ) -> Result<GroupInfo> {
        let scope = self.active_scope_email()?;
        self.update_group_for(&scope, peer, name, members, muted, exclude_me)
    }

    pub fn get_contact_profile_for(&self, account_email: &str, email: &str) -> Result<ContactProfile> {
        let scope = scope_key(account_email);
        let target = email.trim().to_lowercase();
        let c = self.0.lock().unwrap();
        let row: Option<ContactProfile> = c
            .query_row(
                "SELECT email, alias, note, tag, muted FROM contact_profiles WHERE account_email=?1 AND email=?2",
                params![scope, target],
                |r| {
                    Ok(ContactProfile {
                        email: r.get(0)?,
                        alias: r.get(1)?,
                        note: r.get(2)?,
                        tag: r.get(3)?,
                        muted: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row.unwrap_or(ContactProfile {
            email: target,
            alias: String::new(),
            note: String::new(),
            tag: String::new(),
            muted: false,
        }))
    }

    pub fn get_contact_profile(&self, email: &str) -> Result<ContactProfile> {
        let scope = self.active_scope_email()?;
        self.get_contact_profile_for(&scope, email)
    }

    pub fn save_contact_profile_for(
        &self,
        account_email: &str,
        profile: &ContactProfile,
    ) -> Result<ContactProfile> {
        let scope = scope_key(account_email);
        let clean = ContactProfile {
            email: profile.email.trim().to_lowercase(),
            alias: profile.alias.trim().to_string(),
            note: profile.note.trim().to_string(),
            tag: profile.tag.trim().to_string(),
            muted: profile.muted,
        };
        if clean.email.is_empty() || clean.email.starts_with("group:") {
            anyhow::bail!("无效的联系人邮箱地址");
        }
        let now = chrono::Utc::now().timestamp();
        let c = self.0.lock().unwrap();
        if clean.alias.is_empty() && clean.note.is_empty() && clean.tag.is_empty() && !clean.muted {
            c.execute(
                "DELETE FROM contact_profiles WHERE account_email=?1 AND email=?2",
                params![scope, clean.email],
            )?;
        } else {
            c.execute(
                "INSERT INTO contact_profiles(account_email, email, alias, note, tag, muted, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(account_email, email) DO UPDATE SET
                   alias=excluded.alias,
                   note=excluded.note,
                   tag=excluded.tag,
                   muted=excluded.muted,
                   updated_at=excluded.updated_at",
                params![
                    scope,
                    clean.email,
                    clean.alias,
                    clean.note,
                    clean.tag,
                    clean.muted as i32,
                    now
                ],
            )?;
        }
        Ok(clean)
    }

    pub fn save_contact_profile(&self, profile: &ContactProfile) -> Result<ContactProfile> {
        let scope = self.active_scope_email()?;
        self.save_contact_profile_for(&scope, profile)
    }

    fn all_contact_profiles_map_for(
        &self,
        account_email: &str,
    ) -> Result<HashMap<String, ContactProfile>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT email, alias, note, tag, muted FROM contact_profiles WHERE account_email=?1",
        )?;
        let rows = st.query_map([scope], |r| {
            let email: String = r.get(0)?;
            Ok((
                email.clone(),
                ContactProfile {
                    email,
                    alias: r.get(1)?,
                    note: r.get(2)?,
                    tag: r.get(3)?,
                    muted: r.get(4)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    pub fn is_contact_muted_for(&self, account_email: &str, peer: &str) -> Result<bool> {
        if peer.starts_with("group:") {
            return Ok(false);
        }
        Ok(self.get_contact_profile_for(account_email, peer)?.muted)
    }

    /// 判断某会话是否已是熟人/已建立的双向聊天线程：
    /// 1. 群聊会话；或
    /// 2. 我曾主动给该联系人发过邮件（outgoing=1）；或
    /// 3. 该邮件通过 In-Reply-To / References 回复了当前 inbox 中的既有聊天记录。
    pub fn is_established_chat_for(
        &self,
        account_email: &str,
        peer: &str,
        ref_ids: &[String],
    ) -> Result<bool> {
        if peer.starts_with("group:") {
            return Ok(true);
        }
        let scope = scope_key(account_email);
        let target = peer.trim().to_lowercase();
        if target.is_empty() {
            return Ok(false);
        }
        let c = self.0.lock().unwrap();
        let has_outgoing: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM messages WHERE account_email=?1 AND peer=?2 AND outgoing=1",
            params![scope, target],
            |r| r.get(0),
        )?;
        if has_outgoing {
            return Ok(true);
        }
        for mid in ref_ids {
            let clean = mid.trim_matches(&['<', '>', ' '][..]);
            if clean.is_empty() {
                continue;
            }
            let in_inbox_thread: bool = c.query_row(
                "SELECT COUNT(*) > 0 FROM messages WHERE account_email=?1 AND peer=?2 AND message_id=?3 AND status='inbox'",
                params![scope, target, clean],
                |r| r.get(0),
            )?;
            if in_inbox_thread {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 提取当前账号历史往来联系人，方便创建群聊时一键勾选
    pub fn known_contacts(&self, exclude_me: &str) -> Result<Vec<GroupMember>> {
        let scope = self.active_scope_email()?;
        let profiles = self.all_contact_profiles_map_for(&scope)?;
        let raw: Vec<GroupMember> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare(
                "SELECT from_addr, MAX(from_name) FROM messages
                 WHERE account_email=?1 AND outgoing=0 AND from_addr<>'' GROUP BY from_addr
                 UNION
                 SELECT peer, '' FROM messages WHERE account_email=?1 AND peer NOT LIKE 'group:%' GROUP BY peer",
            )?;
            let rows = st.query_map([scope], |r| {
                Ok(GroupMember {
                    email: r.get(0)?,
                    name: r.get(1)?,
                })
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut normalized = normalize_members(&raw, exclude_me);
        for m in &mut normalized {
            if let Some(p) = profiles.get(&m.email) {
                if !p.alias.is_empty() {
                    m.name = p.alias.clone();
                }
            }
        }
        Ok(normalized)
    }

    /// 插入邮件（绑定到指定邮箱账号）；已存在（同账号 + 同 Message-ID）则忽略。返回新行 id。
    pub fn insert_message_for(&self, account_email: &str, m: &NewMessage) -> Result<Option<i64>> {
        let scope = scope_key(account_email);
        let attachments_json = if m.attachments.is_empty() {
            "[]".to_string()
        } else {
            serde_json::to_string(&m.attachments)?
        };
        let reply_to_json = match &m.reply_to {
            Some(q) => serde_json::to_string(q)?,
            None => String::new(),
        };
        let c = self.0.lock().unwrap();
        let n = c.execute(
            "INSERT OR IGNORE INTO messages(account_email,folder,uid,message_id,in_reply_to,references_hdr,from_addr,from_name,
                to_addrs,cc_addrs,subject,body,body_full,body_html,date,outgoing,peer,status,category,summary,reason,
                extracted_code,suggested_reply,read,agent_done,html_checked,attachments_json,reply_to_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,1,?26,?27)",
            params![
                scope, m.folder, m.uid, m.message_id, m.in_reply_to, m.references, m.from_addr, m.from_name,
                m.to_addrs, m.cc_addrs, m.subject, m.body, m.body_full, m.body_html, m.date, m.outgoing, m.peer, m.status,
                m.category, m.summary, m.reason, m.extracted_code, m.suggested_reply, m.read, m.agent_done,
                attachments_json, reply_to_json
            ],
        )?;
        Ok(if n > 0 { Some(c.last_insert_rowid()) } else { None })
    }

    pub fn insert_message(&self, m: &NewMessage) -> Result<Option<i64>> {
        let scope = self.active_scope_email()?;
        self.insert_message_for(&scope, m)
    }

    pub fn rules(&self) -> Result<Vec<Rule>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare("SELECT id, kind, pattern FROM rules ORDER BY id DESC")?;
        let rows = st.query_map([], |r| {
            Ok(Rule { id: r.get(0)?, kind: r.get(1)?, pattern: r.get(2)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn add_rule(&self, kind: &str, pattern: &str) -> Result<()> {
        let c = self.0.lock().unwrap();
        let normalized = pattern.trim().to_lowercase();
        if kind == "allow_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('block_sender','archive_sender') AND pattern=?1", [&normalized])?;
        } else if kind == "block_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('allow_sender','archive_sender') AND pattern=?1", [&normalized])?;
        } else if kind == "archive_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('allow_sender','block_sender') AND pattern=?1", [&normalized])?;
        }
        c.execute(
            "INSERT OR IGNORE INTO rules(kind, pattern) VALUES(?1, ?2)",
            params![kind, normalized],
        )?;
        Ok(())
    }

    pub fn list_groups(&self) -> Result<Vec<GroupInfo>> {
        let scope = self.active_scope_email()?;
        let mut items: Vec<(GroupInfo, i64)> = self.all_groups_map_for(&scope)?.into_values().collect();
        items.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(items.into_iter().map(|(g, _)| g).collect())
    }

    pub fn delete_rule(&self, id: i64) -> Result<()> {
        self.0.lock().unwrap().execute("DELETE FROM rules WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn replace_rules(&self, items: &[(String, String)]) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute("DELETE FROM rules", [])?;
        for (kind, pattern) in items {
            let normalized = pattern.trim().to_lowercase();
            if !normalized.is_empty() {
                c.execute(
                    "INSERT OR IGNORE INTO rules(kind, pattern) VALUES(?1, ?2)",
                    params![kind, normalized],
                )?;
            }
        }
        Ok(())
    }

    fn all_conv_prefs_map_for(&self, account_email: &str) -> Result<HashMap<String, (bool, i64, bool)>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT peer, pinned, pinned_at, manual_unread FROM conv_prefs WHERE account_email=?1",
        )?;
        let rows = st.query_map([scope], |r| {
            let peer: String = r.get(0)?;
            let pinned: bool = r.get(1)?;
            let pinned_at: i64 = r.get(2)?;
            let manual_unread: bool = r.get(3)?;
            Ok((peer, (pinned, pinned_at, manual_unread)))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    pub fn stats(&self) -> Result<MailboxStats> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        let inbox_msg_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND status='inbox' AND read=0 AND outgoing=0",
            [&scope],
            |r| r.get(0),
        )?;
        let inbox_manual_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM conv_prefs p
             WHERE p.account_email=?1 AND p.manual_unread=1
               AND (
                 EXISTS (SELECT 1 FROM messages m WHERE m.account_email=?1 AND m.peer=p.peer AND m.status='inbox')
                 OR EXISTS (SELECT 1 FROM groups g WHERE g.account_email=?1 AND g.peer=p.peer AND g.muted=0
                            AND NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.account_email=?1 AND m2.peer=p.peer))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM messages m3 WHERE m3.account_email=?1 AND m3.peer=p.peer AND m3.status='inbox' AND m3.read=0 AND m3.outgoing=0
               )",
            [&scope],
            |r| r.get(0),
        )?;
        let archived_msg_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND status='archived' AND read=0 AND outgoing=0",
            [&scope],
            |r| r.get(0),
        )?;
        let archived_manual_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM conv_prefs p
             WHERE p.account_email=?1 AND p.manual_unread=1
               AND (
                 EXISTS (SELECT 1 FROM messages m WHERE m.account_email=?1 AND m.peer=p.peer AND m.status='archived')
                 OR EXISTS (SELECT 1 FROM groups g WHERE g.account_email=?1 AND g.peer=p.peer AND g.muted=1
                            AND NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.account_email=?1 AND m2.peer=p.peer))
               )
               AND NOT EXISTS (
                 SELECT 1 FROM messages m3 WHERE m3.account_email=?1 AND m3.peer=p.peer AND m3.status='archived' AND m3.read=0 AND m3.outgoing=0
               )",
            [&scope],
            |r| r.get(0),
        )?;
        let blocked_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND status='blocked'",
            [&scope],
            |r| r.get(0),
        )?;
        let pending_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND agent_done=0 AND outgoing=0",
            [&scope],
            |r| r.get(0),
        )?;
        let demo_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND folder='demo'",
            [&scope],
            |r| r.get(0),
        )?;
        let reply_pending_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM reply_queue WHERE status='pending_review'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(MailboxStats {
            inbox_unread: inbox_msg_unread + inbox_manual_unread,
            archived_unread: archived_msg_unread + archived_manual_unread,
            blocked_count,
            pending_count,
            reply_pending_count,
            has_demo: demo_count > 0,
        })
    }

    pub fn conversations(&self, status: &str) -> Result<Vec<Conversation>> {
        let scope = self.active_scope_email()?;
        let groups_map = self.all_groups_map_for(&scope)?;
        let profiles_map = self.all_contact_profiles_map_for(&scope)?;
        let prefs_map = self.all_conv_prefs_map_for(&scope)?;
        let mut list: Vec<Conversation> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare(
                r#"SELECT m.peer,
                     COALESCE((SELECT from_name FROM messages WHERE account_email=?1 AND peer=m.peer AND outgoing=0 AND from_name<>''
                               ORDER BY date DESC LIMIT 1), ''),
                     COALESCE((SELECT
                         CASE
                           WHEN peer LIKE 'group:%' AND outgoing=0 THEN
                             (CASE WHEN from_name<>'' THEN from_name ELSE from_addr END) || ': ' ||
                             (CASE WHEN summary<>'' THEN summary WHEN body<>'' THEN body ELSE '' END)
                           WHEN extracted_code<>'' THEN '🔑 验证码 ' || extracted_code || ' · ' || CASE WHEN summary<>'' THEN summary ELSE subject END
                           WHEN summary<>'' THEN summary
                           WHEN body<>'' THEN body
                           ELSE ''
                         END
                       FROM messages
                       WHERE account_email=?1 AND peer=m.peer AND status=?2 ORDER BY date DESC LIMIT 1), ''),
                     COALESCE((SELECT subject FROM messages WHERE account_email=?1 AND peer=m.peer AND status=?2 ORDER BY date DESC LIMIT 1), ''),
                     COALESCE((SELECT attachments_json FROM messages WHERE account_email=?1 AND peer=m.peer AND status=?2 ORDER BY date DESC LIMIT 1), '[]'),
                     MAX(m.date),
                     SUM(CASE WHEN m.read=0 AND m.outgoing=0 THEN 1 ELSE 0 END),
                     COUNT(*),
                     COALESCE((SELECT category FROM messages WHERE account_email=?1 AND peer=m.peer AND status=?2 AND category<>''
                               ORDER BY date DESC LIMIT 1), '')
                   FROM messages m WHERE m.account_email=?1 AND m.status=?2
                   GROUP BY m.peer ORDER BY MAX(m.date) DESC"#,
            )?;
            let rows = st.query_map(params![scope, status], |r| {
                let peer: String = r.get(0)?;
                let sender_name: String = r.get(1)?;
                let raw_preview: String = r.get(2)?;
                let last_subject: String = r.get(3)?;
                let last_atts_json: String = r.get(4)?;
                let last_date: i64 = r.get(5)?;
                let raw_unread: i64 = r.get(6)?;
                let count: i64 = r.get(7)?;
                let msg_category: String = r.get(8)?;

                let (pinned, _pinned_at, manual_unread) =
                    prefs_map.get(&peer).copied().unwrap_or((false, 0, false));
                let unread = if raw_unread == 0 && manual_unread { 1 } else { raw_unread };

                let is_group = peer.starts_with("group:");
                let att_label = attachment_preview_label(&last_atts_json);
                let resolved_preview = if is_group && raw_preview.ends_with(": ") {
                    if let Some(att) = att_label {
                        format!("{raw_preview}{att}")
                    } else {
                        format!("{raw_preview}{last_subject}")
                    }
                } else if raw_preview.trim().is_empty() {
                    att_label.unwrap_or(last_subject)
                } else {
                    raw_preview
                };

                let (name, raw_name, note, category, members, muted) =
                    if let Some((g, _)) = groups_map.get(&peer) {
                        (
                            g.name.clone(),
                            String::new(),
                            String::new(),
                            if msg_category.is_empty() { "群聊".into() } else { msg_category },
                            g.members.clone(),
                            g.muted,
                        )
                    } else {
                        let prof = profiles_map.get(&peer);
                        let alias = prof.map(|p| p.alias.as_str()).unwrap_or("");
                        let display = if !alias.is_empty() {
                            alias.to_string()
                        } else if !sender_name.is_empty() {
                            sender_name.clone()
                        } else {
                            peer.clone()
                        };
                        let note_str = prof.map(|p| p.note.clone()).unwrap_or_default();
                        let cat_str = prof
                            .map(|p| p.tag.as_str())
                            .filter(|t| !t.is_empty())
                            .map(|t| t.to_string())
                            .unwrap_or(msg_category);
                        let is_muted = prof.map(|p| p.muted).unwrap_or(false);
                        (display, sender_name, note_str, cat_str, Vec::new(), is_muted)
                    };

                Ok(Conversation {
                    peer,
                    name,
                    raw_name,
                    note,
                    preview: compact_preview(&resolved_preview),
                    last_date,
                    unread,
                    count,
                    category,
                    is_group,
                    members,
                    muted,
                    pinned,
                })
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };

        // 把新建但尚未发第一条消息的空群展示在聊天（或免打扰时展示在通知）列表中
        let c = self.0.lock().unwrap();
        for (peer, (g, created_at)) in groups_map {
            let target_view = if g.muted { "archived" } else { "inbox" };
            if status != target_view {
                continue;
            }
            let total_msgs: i64 = c.query_row(
                "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND peer=?2",
                params![scope, peer],
                |r| r.get(0),
            )?;
            if total_msgs == 0 {
                let (pinned, _pinned_at, manual_unread) =
                    prefs_map.get(&peer).copied().unwrap_or((false, 0, false));
                list.push(Conversation {
                    peer,
                    name: g.name,
                    raw_name: String::new(),
                    note: String::new(),
                    preview: format!("👥 {} 位成员，发条消息开始群聊吧", g.members.len() + 1),
                    last_date: created_at,
                    unread: if manual_unread { 1 } else { 0 },
                    count: 0,
                    category: "群聊".into(),
                    is_group: true,
                    members: g.members,
                    muted: g.muted,
                    pinned,
                });
            }
        }
        list.sort_by(|a, b| {
            b.pinned.cmp(&a.pinned).then_with(|| {
                if a.pinned && b.pinned {
                    let pa = prefs_map.get(&a.peer).map(|x| x.1).unwrap_or(0);
                    let pb = prefs_map.get(&b.peer).map(|x| x.1).unwrap_or(0);
                    pb.cmp(&pa).then_with(|| b.last_date.cmp(&a.last_date))
                } else {
                    b.last_date.cmp(&a.last_date)
                }
            })
        });
        Ok(list)
    }

    pub fn messages(&self, peer: &str, status: &str) -> Result<Vec<MessageDto>> {
        let scope = self.active_scope_email()?;
        let norm_peer = if peer.trim().starts_with("group:") {
            peer.trim().to_string()
        } else {
            peer.trim().to_lowercase()
        };
        let c = self.0.lock().unwrap();
        let _ = c.execute(
            "UPDATE conv_prefs SET manual_unread=0 WHERE account_email=?1 AND peer=?2 AND manual_unread<>0",
            params![scope, norm_peer],
        );
        if norm_peer.starts_with("group:") && status != "blocked" {
            c.execute(
                "UPDATE messages SET read=1 WHERE account_email=?1 AND peer=?2 AND status<>'blocked' AND read=0",
                params![scope, norm_peer],
            )?;
            let mut st = c.prepare(
                "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                        category,summary,reason,extracted_code,suggested_reply,body_html,attachments_json,reply_to_json
                 FROM messages WHERE account_email=?1 AND peer=?2 AND status<>'blocked' ORDER BY date ASC",
            )?;
            let rows = st.query_map(params![scope, norm_peer], row_to_dto)?;
            return Ok(rows.collect::<std::result::Result<_, _>>()?);
        }
        c.execute(
            "UPDATE messages SET read=1 WHERE account_email=?1 AND peer=?2 AND status=?3 AND read=0",
            params![scope, norm_peer, status],
        )?;
        let mut st = c.prepare(
            "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                    category,summary,reason,extracted_code,suggested_reply,body_html,attachments_json,reply_to_json
             FROM messages WHERE account_email=?1 AND peer=?2 AND status=?3 ORDER BY date ASC",
        )?;
        let rows = st.query_map(params![scope, norm_peer, status], row_to_dto)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn message(&self, id: i64) -> Result<MessageDto> {
        let c = self.0.lock().unwrap();
        Ok(c.query_row(
            "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                    category,summary,reason,extracted_code,suggested_reply,body_html,attachments_json,reply_to_json
             FROM messages WHERE id=?1",
            [id],
            row_to_dto,
        )?)
    }

    /// 回复时用的上下文：该账号下该会话最新一封邮件的主题和 Message-ID（群聊按时间取最新一封以串起完整线程）
    pub fn reply_context_for(&self, account_email: &str, peer: &str) -> Result<Option<ReplyContext>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let sql = if peer.starts_with("group:") {
            "SELECT subject, message_id, references_hdr FROM messages WHERE account_email=?1 AND peer=?2 ORDER BY date DESC LIMIT 1"
        } else {
            "SELECT subject, message_id, references_hdr FROM messages WHERE account_email=?1 AND peer=?2 ORDER BY outgoing ASC, date DESC LIMIT 1"
        };
        Ok(c.query_row(sql, params![scope, peer], |r| {
            Ok(ReplyContext {
                subject: r.get(0)?,
                message_id: r.get(1)?,
                references: r.get(2)?,
            })
        })
        .optional()?)
    }

    #[allow(dead_code)]
    pub fn reply_context(&self, peer: &str) -> Result<Option<ReplyContext>> {
        let scope = self.active_scope_email()?;
        self.reply_context_for(&scope, peer)
    }

    /// 针对用户显式点击「引用」某条历史消息（msg_id）构造精确的回复线程头与气泡引用快照
    pub fn reply_context_by_id_for(
        &self,
        account_email: &str,
        msg_id: i64,
    ) -> Result<Option<(ReplyContext, ReplyQuote)>> {
        let scope = scope_key(account_email);
        let profiles = self.all_contact_profiles_map_for(&scope)?;
        let c = self.0.lock().unwrap();
        let row: Option<(i64, String, String, String, bool, String, String, String, String)> = c
            .query_row(
                "SELECT id, message_id, references_hdr, subject, outgoing, from_addr, from_name, body, attachments_json
                 FROM messages WHERE account_email=?1 AND id=?2",
                params![scope, msg_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .optional()?;

        Ok(row.map(
            |(id, message_id, references, subject, outgoing, from_addr, from_name, body, atts_json)| {
                let alias = profiles
                    .get(&from_addr.trim().to_lowercase())
                    .map(|p| p.alias.as_str())
                    .unwrap_or("");
                let quote = build_reply_quote(
                    id,
                    &message_id,
                    outgoing,
                    &from_addr,
                    &from_name,
                    alias,
                    &subject,
                    &body,
                    &atts_json,
                );
                (
                    ReplyContext {
                        subject,
                        message_id,
                        references,
                    },
                    quote,
                )
            },
        ))
    }

    /// 入站邮件解析引用关系：
    /// 1. 若携带显式 `X-MailChat-Quote-Id`，直接精确关联目标气泡；
    /// 2. 否则若 `In-Reply-To` 指向的并非该会话紧邻的上一条消息（即跨消息回溯引用），也自动展示引用卡片。
    pub fn find_reply_quote_for(
        &self,
        account_email: &str,
        peer: &str,
        explicit_quote_mid: Option<&str>,
        in_reply_to: &str,
    ) -> Result<Option<ReplyQuote>> {
        let scope = scope_key(account_email);
        let (target_mid, is_explicit) = if let Some(q) = explicit_quote_mid
            .map(|s| s.trim_matches(&['<', '>', ' '][..]))
            .filter(|s| !s.is_empty())
        {
            (q.to_string(), true)
        } else if let Some(irt) = in_reply_to
            .split_whitespace()
            .next()
            .map(|s| s.trim_matches(&['<', '>', ' '][..]))
            .filter(|s| !s.is_empty())
        {
            (irt.to_string(), false)
        } else {
            return Ok(None);
        };

        let profiles = self.all_contact_profiles_map_for(&scope)?;
        let c = self.0.lock().unwrap();
        if !is_explicit {
            let latest_id: Option<i64> = c
                .query_row(
                    "SELECT id FROM messages WHERE account_email=?1 AND peer=?2 ORDER BY date DESC, id DESC LIMIT 1",
                    params![scope, peer],
                    |r| r.get(0),
                )
                .optional()?;
            let target_id: Option<i64> = c
                .query_row(
                    "SELECT id FROM messages WHERE account_email=?1 AND peer=?2 AND message_id=?3 LIMIT 1",
                    params![scope, peer, target_mid],
                    |r| r.get(0),
                )
                .optional()?;
            if target_id.is_none() || target_id == latest_id {
                return Ok(None);
            }
        }

        let row: Option<(i64, String, String, bool, String, String, String, String)> = c
            .query_row(
                "SELECT id, message_id, subject, outgoing, from_addr, from_name, body, attachments_json
                 FROM messages WHERE account_email=?1 AND message_id=?2 LIMIT 1",
                params![scope, target_mid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()?;

        Ok(row.map(
            |(id, message_id, subject, outgoing, from_addr, from_name, body, atts_json)| {
                let alias = profiles
                    .get(&from_addr.trim().to_lowercase())
                    .map(|p| p.alias.as_str())
                    .unwrap_or("");
                build_reply_quote(
                    id,
                    &message_id,
                    outgoing,
                    &from_addr,
                    &from_name,
                    alias,
                    &subject,
                    &body,
                    &atts_json,
                )
            },
        ))
    }

    pub fn set_message_status(&self, id: i64, status: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE messages SET status=?2, agent_done=1 WHERE id=?1",
            params![id, status],
        )?;
        Ok(())
    }

    pub fn move_peer_for(&self, account_email: &str, peer: &str, to_status: &str) -> Result<()> {
        let scope = scope_key(account_email);
        self.0.lock().unwrap().execute(
            "UPDATE messages SET status=?3, agent_done=1 WHERE account_email=?1 AND peer=?2",
            params![scope, peer, to_status],
        )?;
        Ok(())
    }

    pub fn move_peer(&self, peer: &str, to_status: &str) -> Result<()> {
        let scope = self.active_scope_email()?;
        self.move_peer_for(&scope, peer, to_status)
    }

    pub fn set_peer_pinned(&self, peer: &str, pinned: bool) -> Result<()> {
        let scope = self.active_scope_email()?;
        let norm_peer = if peer.trim().starts_with("group:") {
            peer.trim().to_string()
        } else {
            peer.trim().to_lowercase()
        };
        if norm_peer.is_empty() {
            return Ok(());
        }
        let now = if pinned { chrono::Utc::now().timestamp() } else { 0 };
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO conv_prefs(account_email, peer, pinned, pinned_at, manual_unread)
             VALUES(?1, ?2, ?3, ?4, 0)
             ON CONFLICT(account_email, peer) DO UPDATE SET
               pinned=excluded.pinned,
               pinned_at=excluded.pinned_at",
            params![scope, norm_peer, pinned as i32, now],
        )?;
        let _ = c.execute(
            "DELETE FROM conv_prefs WHERE account_email=?1 AND peer=?2 AND pinned=0 AND manual_unread=0",
            params![scope, norm_peer],
        );
        Ok(())
    }

    pub fn set_peer_read(&self, peer: &str, status: &str, read: bool) -> Result<()> {
        let scope = self.active_scope_email()?;
        let norm_peer = if peer.trim().starts_with("group:") {
            peer.trim().to_string()
        } else {
            peer.trim().to_lowercase()
        };
        if norm_peer.is_empty() {
            return Ok(());
        }
        let c = self.0.lock().unwrap();
        if read {
            if norm_peer.starts_with("group:") && status != "blocked" {
                c.execute(
                    "UPDATE messages SET read=1 WHERE account_email=?1 AND peer=?2 AND status<>'blocked' AND read=0",
                    params![scope, norm_peer],
                )?;
            } else {
                c.execute(
                    "UPDATE messages SET read=1 WHERE account_email=?1 AND peer=?2 AND status=?3 AND read=0",
                    params![scope, norm_peer, status],
                )?;
            }
            c.execute(
                "UPDATE conv_prefs SET manual_unread=0 WHERE account_email=?1 AND peer=?2",
                params![scope, norm_peer],
            )?;
            let _ = c.execute(
                "DELETE FROM conv_prefs WHERE account_email=?1 AND peer=?2 AND pinned=0 AND manual_unread=0",
                params![scope, norm_peer],
            );
        } else {
            let latest_incoming_id: Option<i64> = if norm_peer.starts_with("group:") && status != "blocked" {
                c.query_row(
                    "SELECT id FROM messages WHERE account_email=?1 AND peer=?2 AND status<>'blocked' AND outgoing=0
                     ORDER BY date DESC, id DESC LIMIT 1",
                    params![scope, norm_peer],
                    |r| r.get(0),
                )
                .optional()?
            } else {
                c.query_row(
                    "SELECT id FROM messages WHERE account_email=?1 AND peer=?2 AND status=?3 AND outgoing=0
                     ORDER BY date DESC, id DESC LIMIT 1",
                    params![scope, norm_peer, status],
                    |r| r.get(0),
                )
                .optional()?
            };

            if let Some(mid) = latest_incoming_id {
                c.execute("UPDATE messages SET read=0 WHERE id=?1", [mid])?;
                c.execute(
                    "UPDATE conv_prefs SET manual_unread=0 WHERE account_email=?1 AND peer=?2",
                    params![scope, norm_peer],
                )?;
            } else {
                c.execute(
                    "INSERT INTO conv_prefs(account_email, peer, pinned, pinned_at, manual_unread)
                     VALUES(?1, ?2, 0, 0, 1)
                     ON CONFLICT(account_email, peer) DO UPDATE SET manual_unread=1",
                    params![scope, norm_peer],
                )?;
            }
        }
        Ok(())
    }

    pub fn mark_all_read(&self, status: &str) -> Result<usize> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        let updated = c.execute(
            "UPDATE messages SET read=1 WHERE account_email=?1 AND status=?2 AND read=0",
            params![scope, status],
        )?;
        let manual_cleared = c.execute(
            "UPDATE conv_prefs SET manual_unread=0
             WHERE account_email=?1 AND manual_unread=1
               AND (
                 EXISTS (SELECT 1 FROM messages m WHERE m.account_email=?1 AND m.peer=conv_prefs.peer AND m.status=?2)
                 OR (?2='inbox' AND EXISTS (SELECT 1 FROM groups g WHERE g.account_email=?1 AND g.peer=conv_prefs.peer AND g.muted=0))
                 OR (?2='archived' AND EXISTS (SELECT 1 FROM groups g WHERE g.account_email=?1 AND g.peer=conv_prefs.peer AND g.muted=1))
               )",
            params![scope, status],
        )?;
        let _ = c.execute(
            "DELETE FROM conv_prefs WHERE account_email=?1 AND pinned=0 AND manual_unread=0",
            [&scope],
        );
        Ok(updated + manual_cleared)
    }

    pub fn set_peer_muted(&self, peer: &str, muted: bool) -> Result<()> {
        let scope = self.active_scope_email()?;
        let trimmed = peer.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        if trimmed.starts_with("group:") {
            {
                let c = self.0.lock().unwrap();
                c.execute(
                    "UPDATE groups SET muted=?3 WHERE account_email=?1 AND peer=?2",
                    params![scope, trimmed, muted as i32],
                )?;
            }
            let target = if muted { "archived" } else { "inbox" };
            let _ = self.move_peer_for(&scope, trimmed, target);
        } else {
            let clean_email = trimmed.to_lowercase();
            let mut profile = self.get_contact_profile_for(&scope, &clean_email)?;
            profile.muted = muted;
            self.save_contact_profile_for(&scope, &profile)?;
            let target = if muted { "archived" } else { "inbox" };
            let _ = self.move_peer_for(&scope, &clean_email, target);
        }
        Ok(())
    }

    pub fn delete_message(&self, id: i64) -> Result<()> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        c.execute(
            "DELETE FROM messages WHERE account_email=?1 AND id=?2",
            params![scope, id],
        )?;
        Ok(())
    }

    pub fn delete_conversation(&self, peer: &str, status: Option<&str>) -> Result<usize> {
        let scope = self.active_scope_email()?;
        let norm_peer = if peer.trim().starts_with("group:") {
            peer.trim().to_string()
        } else {
            peer.trim().to_lowercase()
        };
        if norm_peer.is_empty() {
            return Ok(0);
        }
        let c = self.0.lock().unwrap();
        let deleted = match status {
            Some(st) if !norm_peer.starts_with("group:") => c.execute(
                "DELETE FROM messages WHERE account_email=?1 AND peer=?2 AND status=?3",
                params![scope, norm_peer, st],
            )?,
            _ => c.execute(
                "DELETE FROM messages WHERE account_email=?1 AND peer=?2",
                params![scope, norm_peer],
            )?,
        };
        let remaining: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email=?1 AND peer=?2",
            params![scope, norm_peer],
            |r| r.get(0),
        )?;
        if remaining == 0 {
            let _ = c.execute(
                "DELETE FROM conv_prefs WHERE account_email=?1 AND peer=?2",
                params![scope, norm_peer],
            );
            if norm_peer.starts_with("group:") {
                let _ = c.execute(
                    "DELETE FROM groups WHERE account_email=?1 AND peer=?2",
                    params![scope, norm_peer],
                );
            }
        }
        Ok(deleted)
    }

    /// 等待 Agent 处理的邮件
    pub fn pending(&self) -> Result<Vec<PendingItem>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT id, from_addr, from_name, subject, body_full, extracted_code FROM messages
             WHERE agent_done=0 AND outgoing=0 ORDER BY date DESC LIMIT 40",
        )?;
        let rows = st.query_map([], |r| {
            Ok(PendingItem {
                id: r.get(0)?,
                from_addr: r.get(1)?,
                from_name: r.get(2)?,
                subject: r.get(3)?,
                body_full: r.get(4)?,
                existing_code: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// 将当前激活账号下的现有来信重新标记为待 Agent 分拣
    pub fn mark_for_reclassify(&self, all_incoming: bool) -> Result<usize> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        let n = if all_incoming {
            c.execute(
                "UPDATE messages SET agent_done=0 WHERE account_email=?1 AND outgoing=0",
                [&scope],
            )?
        } else {
            c.execute(
                "UPDATE messages SET agent_done=0 WHERE account_email=?1 AND outgoing=0 AND summary='' AND status='inbox' AND LENGTH(TRIM(body)) > 140",
                [&scope],
            )?
        };
        Ok(n)
    }

    /// 用当前确定性规则扫描已存在的来信，返回命中条数
    pub fn scan_existing_with_rules<F>(&self, mut matcher: F) -> Result<usize>
    where
        F: FnMut(&str, &str, &str) -> Option<(&'static str, String)>,
    {
        let items: Vec<(i64, String, String, String)> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare("SELECT id, from_addr, subject, body_full FROM messages WHERE outgoing=0")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut changed = 0;
        let c = self.0.lock().unwrap();
        for (id, from, subject, body) in items {
            if let Some((status, reason)) = matcher(&from, &subject, &body) {
                changed += c.execute(
                    "UPDATE messages SET status=?2, reason=?3, agent_done=1 WHERE id=?1",
                    params![id, status, reason],
                )?;
            }
        }
        Ok(changed)
    }

    /// 使用最新的正文清洗规则刷新库内已有邮件的聊天气泡文本（完整保留 body_full 原文）
    pub fn reclean_all_bodies<F>(&self, cleaner: F) -> Result<usize>
    where
        F: Fn(&str) -> String,
    {
        let items: Vec<(i64, String, String)> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare("SELECT id, body, body_full FROM messages WHERE body_full <> ''")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut updated = 0;
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        for (id, old_body, body_full) in items {
            let next_body = cleaner(&body_full);
            if next_body != old_body {
                updated += tx.execute(
                    "UPDATE messages SET body=?2 WHERE id=?1",
                    params![id, next_body],
                )?;
            }
        }
        tx.commit()?;
        Ok(updated)
    }

    /// 查找指定账号下旧版同步入库但尚未提取 HTML 正文的历史邮件（按聊天 -> 通知 -> 拦截及时间倒序优先回填）
    pub fn messages_needing_html_backfill_for(
        &self,
        account_email: &str,
        limit: usize,
    ) -> Result<Vec<HtmlBackfillItem>> {
        let scope = scope_key(account_email);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT id, folder, uid FROM messages
             WHERE account_email=?1 AND html_checked=0 AND body_html='' AND uid>0 AND folder NOT IN ('demo','local')
             ORDER BY CASE WHEN status='inbox' THEN 0 WHEN status='archived' THEN 1 ELSE 2 END, date DESC
             LIMIT ?2",
        )?;
        let rows = st.query_map(params![scope, limit as i64], |r| {
            Ok(HtmlBackfillItem {
                id: r.get(0)?,
                folder: r.get(1)?,
                uid: r.get::<_, i64>(2)?.max(0) as u32,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    #[allow(dead_code)]
    pub fn messages_needing_html_backfill(&self, limit: usize) -> Result<Vec<HtmlBackfillItem>> {
        let scope = self.active_scope_email()?;
        self.messages_needing_html_backfill_for(&scope, limit)
    }

    /// 批量写回历史邮件的 HTML 正文并将本批全部标记为 `html_checked=1`，返回实际补入非空 HTML 的邮件数
    pub fn save_html_backfill_batch(
        &self,
        checked_ids: &[i64],
        html_by_id: &HashMap<i64, String>,
    ) -> Result<usize> {
        if checked_ids.is_empty() {
            return Ok(0);
        }
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let mut enriched = 0usize;
        for &id in checked_ids {
            let html = html_by_id.get(&id).map(String::as_str).unwrap_or("");
            if !html.trim().is_empty() {
                tx.execute(
                    "UPDATE messages SET body_html=?2, html_checked=1 WHERE id=?1",
                    params![id, html],
                )?;
                enriched += 1;
            } else {
                tx.execute(
                    "UPDATE messages SET html_checked=1 WHERE id=?1",
                    params![id],
                )?;
            }
        }
        tx.commit()?;
        Ok(enriched)
    }

    pub fn apply_verdict(
        &self,
        id: i64,
        status: &str,
        category: &str,
        summary: &str,
        reason: &str,
        extracted_code: &str,
        suggested_reply: &str,
    ) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "UPDATE messages
             SET status=CASE WHEN agent_done=0 THEN ?2 ELSE status END,
                 category=CASE WHEN ?3<>'' THEN ?3 ELSE category END,
                 summary=CASE WHEN ?4<>'' THEN ?4 ELSE summary END,
                 reason=CASE WHEN ?5<>'' THEN ?5 ELSE reason END,
                 extracted_code=CASE WHEN ?6<>'' THEN ?6 ELSE extracted_code END,
                 suggested_reply=CASE WHEN ?7<>'' THEN ?7 ELSE suggested_reply END,
                 agent_done=1
             WHERE id=?1",
            params![id, status, category, summary, reason, extracted_code, suggested_reply],
        )?;
        Ok(())
    }

    /// 对话最近若干条（含每位发言人身份），用于单聊/群聊 AI 起草回复或 AI 群聊总结
    pub fn recent_history(&self, peer: &str, n: i64) -> Result<Vec<HistoryItem>> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT outgoing, from_name, from_addr, subject, body FROM messages
             WHERE account_email=?1 AND peer=?2 ORDER BY date DESC LIMIT ?3",
        )?;
        let mut rows: Vec<HistoryItem> = st
            .query_map(params![scope, peer, n], |r| {
                Ok(HistoryItem {
                    outgoing: r.get(0)?,
                    from_name: r.get(1)?,
                    from_addr: r.get(2)?,
                    subject: r.get(3)?,
                    body: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// 注入一套开箱即用的演示会话（含 4 人项目研发群聊、单聊、验证码/账单通知、被屏蔽广告/钓鱼邮件）
    pub fn seed_demo_data(&self, my_email: &str) -> Result<usize> {
        let me = if my_email.trim().is_empty() {
            "me@mailchat.local".to_string()
        } else {
            my_email.trim().to_lowercase()
        };
        let now = chrono::Utc::now().timestamp();

        // 预建一个 4 人产品研发群聊（我 + 林晓薇 + Alex + 王工）
        let grp_peer = "group:demo-product-team";
        let _ = self.upsert_group(
            grp_peer,
            "🚀 MailChat 产品研发群",
            &[
                GroupMember { email: "linxiaowei@team-work.cn".into(), name: "林晓薇 (产品)".into() },
                GroupMember { email: "alex.chen@opensource.dev".into(), name: "Alex Chen".into() },
                GroupMember { email: "wang.qa@team-work.cn".into(), name: "王工 (测试)".into() },
            ],
            &me,
            true,
        )?;

        let samples = vec![
            // 0. 4人研发群聊演示（多成员 Reply-All 邮件线程）
            NewMessage {
                folder: "demo".into(),
                uid: 201,
                message_id: "demo-grp-201@team-work.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: format!("{me},alex.chen@opensource.dev,wang.qa@team-work.cn"),
                cc_addrs: String::new(),
                subject: "MailChat v0.2 群聊方案对齐".into(),
                body: "大家下午好！我们准备在 MailChat 里支持邮件群聊，底层走标准多收件人 To/Cc + Reply-All 邮件线程，这样对方用普通网页邮箱也能直接参会讨论。".into(),
                body_full: "大家下午好！我们准备在 MailChat 里支持邮件群聊，底层走标准多收件人 To/Cc + Reply-All 邮件线程，这样对方用普通网页邮箱也能直接参会讨论。".into(),
                body_html: String::new(),
                date: now - 3200,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "同步 MailChat v0.2 基于多收件人协议实现群聊".into(),
                reason: "项目组多人协作讨论".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 202,
                message_id: "demo-grp-202@opensource.dev".into(),
                in_reply_to: "demo-grp-201@team-work.cn".into(),
                references: "<demo-grp-201@team-work.cn>".into(),
                from_addr: "alex.chen@opensource.dev".into(),
                from_name: "Alex Chen".into(),
                to_addrs: format!("{me},linxiaowei@team-work.cn,wang.qa@team-work.cn"),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "赞成！可以同时带上 Chat-Group-ID 扩展头并结合 In-Reply-To 线程追踪，这样哪怕外部邮箱用户中途增减抄送人，也不会裂变成两个群。".into(),
                body_full: "赞成！可以同时带上 Chat-Group-ID 扩展头并结合 In-Reply-To 线程追踪，这样哪怕外部邮箱用户中途增减抄送人，也不会裂变成两个群。".into(),
                body_html: String::new(),
                date: now - 2600,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "建议用 Chat-Group-ID 与线程头保证群会话唯一性".into(),
                reason: "技术架构补充意见".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 203,
                message_id: "demo-grp-203@mailchat.local".into(),
                in_reply_to: "demo-grp-202@opensource.dev".into(),
                references: "<demo-grp-201@team-work.cn> <demo-grp-202@opensource.dev>".into(),
                from_addr: me.clone(),
                from_name: "我".into(),
                to_addrs: "linxiaowei@team-work.cn,alex.chen@opensource.dev,wang.qa@team-work.cn".into(),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "@Alex Chen 这个方案很稳，我顺便把群免打扰（被 @ 时仍提醒）和 AI 一键总结群聊记录也加上了。".into(),
                body_full: "@Alex Chen 这个方案很稳，我顺便把群免打扰（被 @ 时仍提醒）和 AI 一键总结群聊记录也加上了。".into(),
                body_html: String::new(),
                date: now - 1900,
                outgoing: true,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: String::new(),
                summary: String::new(),
                reason: String::new(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 204,
                message_id: "demo-grp-204@team-work.cn".into(),
                in_reply_to: "demo-grp-203@mailchat.local".into(),
                references: "<demo-grp-201@team-work.cn> <demo-grp-202@opensource.dev> <demo-grp-203@mailchat.local>".into(),
                from_addr: "wang.qa@team-work.cn".into(),
                from_name: "王工 (测试)".into(),
                to_addrs: format!("{me},linxiaowei@team-work.cn,alex.chen@opensource.dev"),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "收到！今晚构建包出来后告诉我一声，我重点测一下跨 Gmail / QQ 邮箱的全员回复互通性。".into(),
                body_full: "收到！今晚构建包出来后告诉我一声，我重点测一下跨 Gmail / QQ 邮箱的全员回复互通性。".into(),
                body_html: String::new(),
                date: now - 300,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "王工准备今晚联调跨邮箱群聊互通测试".into(),
                reason: "测试排期确认".into(),
                extracted_code: String::new(),
                suggested_reply: "好的 @王工 (测试) ，桌面端刚编好，随时可以开测！".into(),
                read: false,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 1. 产品经理林晓薇单聊
            NewMessage {
                folder: "demo".into(),
                uid: 101,
                message_id: "demo-101@team-work.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "MailChat 桌面端交互走查".into(),
                body: "嗨！我刚看了一下把邮件做成微信/Telegram 气泡的设计稿，左边按联系人聚合真的清爽太多了。你这边 Tauri 原型进展怎么样啦？".into(),
                body_full: "嗨！我刚看了一下把邮件做成微信/Telegram 气泡的设计稿，左边按联系人聚合真的清爽太多了。你这边 Tauri 原型进展怎么样啦？\n\n-- \n林晓薇 | 高级产品经理\nTeamWork Studio · 北京市海淀区".into(),
                body_html: String::new(),
                date: now - 7200,
                outgoing: false,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: "工作".into(),
                summary: "询问 MailChat Tauri 原型开发进展".into(),
                reason: "同事项目沟通，需要关注与回复".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 102,
                message_id: "demo-102@mailchat.local".into(),
                in_reply_to: "demo-101@team-work.cn".into(),
                references: "<demo-101@team-work.cn>".into(),
                from_addr: me.clone(),
                from_name: "我".into(),
                to_addrs: "linxiaowei@team-work.cn".into(),
                cc_addrs: String::new(),
                subject: "Re: MailChat 桌面端交互走查".into(),
                body: "IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！".into(),
                body_full: "IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！".into(),
                body_html: String::new(),
                date: now - 5400,
                outgoing: true,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: String::new(),
                summary: String::new(),
                reason: String::new(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 103,
                message_id: "demo-103@team-work.cn".into(),
                in_reply_to: "demo-102@mailchat.local".into(),
                references: "<demo-101@team-work.cn> <demo-102@mailchat.local>".into(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "Re: MailChat 桌面端交互走查".into(),
                body: "太棒了！那我们周四下午 3:00 约个 20 分钟小会，一起过一下可运行原型可以吗？".into(),
                body_full: "太棒了！那我们周四下午 3:00 约个 20 分钟小会，一起过一下可运行原型可以吗？\n\n在 2026-11-12 21:15，我 写道：\n> IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！\n\n-- \n林晓薇 | 高级产品经理\nTeamWork Studio".into(),
                body_html: String::new(),
                date: now - 900,
                outgoing: false,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: "工作".into(),
                summary: "邀约周四下午 3:00 评审可运行原型".into(),
                reason: "真人同事来信并包含明确时间邀约".into(),
                extracted_code: String::new(),
                suggested_reply: "没问题，周四下午 3 点见，我先把演示环境准备好！".into(),
                read: false,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 2. 开源协作者 Alex Chen 单聊
            NewMessage {
                folder: "demo".into(),
                uid: 104,
                message_id: "demo-104@opensource.dev".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "alex.chen@opensource.dev".into(),
                from_name: "Alex Chen".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "关于邮件线程 In-Reply-To 兼容性的小建议".into(),
                body: "Hey! 测试了一下你发的回复邮件，在 Gmail 和 Apple Mail 里都能完美归进同一个会话线程。建议对只有 HTML 正文的通知邮件也加个纯文本提取兜底，体验会更稳。".into(),
                body_full: "Hey! 测试了一下你发的回复邮件，在 Gmail 和 Apple Mail 里都能完美归进同一个会话线程。建议对只有 HTML 正文的通知邮件也加个纯文本提取兜底，体验会更稳。\n\nBest,\nAlex".into(),
                body_html: String::new(),
                date: now - 2400,
                outgoing: false,
                peer: "alex.chen@opensource.dev".into(),
                status: "inbox".into(),
                category: "个人".into(),
                summary: "反馈邮件线程兼容正常，建议补充 HTML 正文提取".into(),
                reason: "开发者技术交流来信".into(),
                extracted_code: String::new(),
                suggested_reply: "好建议，HTML 自动转纯文本兜底已经加上了，感谢测试！".into(),
                read: false,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 3. 通知栏：GitHub 验证码
            NewMessage {
                folder: "demo".into(),
                uid: 105,
                message_id: "demo-105@github.com".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "noreply@github.com".into(),
                from_name: "GitHub".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "[GitHub] Please verify your device".into(),
                body: "检测到新设备登录验证请求。\n您的登录验证码为：849201（10 分钟内有效）。如非本人操作请忽略本邮件。".into(),
                body_full: "检测到新设备登录验证请求。\n您的登录验证码为：849201（10 分钟内有效）。如非本人操作请忽略本邮件。".into(),
                body_html: String::new(),
                date: now - 600,
                outgoing: false,
                peer: "noreply@github.com".into(),
                status: "archived".into(),
                category: "验证码".into(),
                summary: "GitHub 新设备登录验证码 849201".into(),
                reason: "Agent 自动折叠：系统安全验证码通知，已提取验证码方便复制".into(),
                extracted_code: "849201".into(),
                suggested_reply: String::new(),
                read: false,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 4. 通知栏：银行电子账单
            NewMessage {
                folder: "demo".into(),
                uid: 106,
                message_id: "demo-106@cmbchina.com".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "ccsvc@cmbchina.com".into(),
                from_name: "招商银行信用卡".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "招商银行信用卡 11 月电子账单通知".into(),
                body: "尊敬的持卡人，您本期人民币账单应还金额 ¥3,286.50，最后还款日为 11 月 25 日。已开通自动还款服务，请确保关联储蓄卡余额充足。".into(),
                body_full: "尊敬的持卡人，您本期人民币账单应还金额 ¥3,286.50，最后还款日为 11 月 25 日。已开通自动还款服务，请确保关联储蓄卡余额充足。".into(),
                body_html: r#"<div style="border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1f2937"><div style="font-size:15px;font-weight:600;color:#b91c1c;margin-bottom:10px">招商银行信用卡 · 11 月电子账单</div><table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;background:#f9fafb;border-radius:8px;font-size:13px"><tr><td style="color:#6b7280">本期应还金额</td><td align="right" style="font-weight:700;font-size:16px;color:#111827">¥3,286.50</td></tr><tr><td style="color:#6b7280">最后还款日</td><td align="right" style="font-weight:600">2026 年 11 月 25 日</td></tr><tr><td style="color:#6b7280">还款状态</td><td align="right" style="color:#059669">已开通自动还款</td></tr></table><p style="margin:12px 0 0;font-size:12px;color:#6b7280">尊敬的持卡人，请确保关联储蓄卡余额充足。</p></div>"#.into(),
                date: now - 14400,
                outgoing: false,
                peer: "ccsvc@cmbchina.com".into(),
                status: "archived".into(),
                category: "账单".into(),
                summary: "11 月信用卡账单 ¥3,286.50，11/25 到期自动还款".into(),
                reason: "Agent 自动折叠：账单通知无需即时聊天打扰，归档备查".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: false,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 5. 已屏蔽：电商促销垃圾邮件
            NewMessage {
                folder: "demo".into(),
                uid: 107,
                message_id: "demo-107@flash-sale88.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "promo@edm.flash-sale88.cn".into(),
                from_name: "云端优选商城".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "【最后24小时】超级会员返场狂欢，全场数码低至 5 折！".into(),
                body: "尊贵的 VIP 用户，您的 ¥500 专属津贴即将失效！立即戳链接抢购爆款好物，买贵双倍赔！拒收请回复 TD 退订。".into(),
                body_full: "尊贵的 VIP 用户，您的 ¥500 专属津贴即将失效！立即戳链接抢购爆款好物，买贵双倍赔！拒收请回复 TD 退订。".into(),
                body_html: String::new(),
                date: now - 3600,
                outgoing: false,
                peer: "promo@edm.flash-sale88.cn".into(),
                status: "blocked".into(),
                category: "营销".into(),
                summary: "电商促销群发广告（含退订话术）".into(),
                reason: "Agent 自动屏蔽：典型 EDM 商业促销群发邮件".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
            // 6. 已屏蔽：钓鱼诈骗邮件
            NewMessage {
                folder: "demo".into(),
                uid: 108,
                message_id: "demo-108@account-alert-login.xyz".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "security@account-alert-login.xyz".into(),
                from_name: "邮箱系统管理员".into(),
                to_addrs: me,
                cc_addrs: String::new(),
                subject: "紧急：您的企业邮箱存储已满 99.8%，即将暂停收发！".into(),
                body: "系统检测到您的账号存在异常挂起邮件，请在 2 小时内访问 http://verify-mail-quota.xyz 重新输入邮箱密码完成扩容验证，否则账号将被永久冻结。".into(),
                body_full: "系统检测到您的账号存在异常挂起邮件，请在 2 小时内访问 http://verify-mail-quota.xyz 重新输入邮箱密码完成扩容验证，否则账号将被永久冻结。".into(),
                body_html: String::new(),
                date: now - 1800,
                outgoing: false,
                peer: "security@account-alert-login.xyz".into(),
                status: "blocked".into(),
                category: "诈骗".into(),
                summary: "伪造邮箱容量告警诱导输入密码的可疑钓鱼邮件".into(),
                reason: "Agent 自动屏蔽：陌生可疑域名 + 诱导输入凭据，高危钓鱼特征".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: None,
            },
        ];

        let mut inserted = 0;
        for s in &samples {
            if self.insert_message(s)?.is_some() {
                inserted += 1;
            }
        }
        Ok(inserted)
    }

    pub fn clear_demo_data(&self) -> Result<usize> {
        let scope = self.active_scope_email()?;
        let c = self.0.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM groups WHERE account_email=?1 AND is_demo=1",
            [&scope],
        );
        Ok(c.execute(
            "DELETE FROM messages WHERE account_email=?1 AND folder='demo'",
            [&scope],
        )?)
    }

    pub fn list_agent_sessions(&self) -> Result<Vec<AgentSessionSummary>> {
        self.list_instance_sessions("config")
    }

    pub fn list_instance_sessions(&self, instance_id: &str) -> Result<Vec<AgentSessionSummary>> {
        let inst = normalize_agent_instance(instance_id);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT s.id, s.title, s.created_at, s.updated_at,
                    (SELECT COUNT(*) FROM agent_turns t WHERE t.session_id = s.id) AS turn_count,
                    COALESCE((SELECT t2.content FROM agent_turns t2 WHERE t2.session_id = s.id ORDER BY t2.id DESC LIMIT 1), '') AS last_content
             FROM agent_sessions s
             WHERE s.instance_id = ?1
             ORDER BY s.updated_at DESC, s.created_at DESC",
        )?;
        let rows = st.query_map([inst], |r| {
            let raw_preview: String = r.get(5)?;
            Ok(AgentSessionSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                turn_count: r.get(4)?,
                preview: compact_preview(&raw_preview),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_agent_session(&self, title: Option<&str>) -> Result<AgentSessionSummary> {
        self.create_instance_session("config", title)
    }

    pub fn create_instance_session(
        &self,
        instance_id: &str,
        title: Option<&str>,
    ) -> Result<AgentSessionSummary> {
        let inst = normalize_agent_instance(instance_id);
        let default_title = default_instance_session_title(inst);
        let now = chrono::Utc::now().timestamp();
        let prefix = if inst == "mail" { "agm" } else { "ags" };
        let id = format!("{prefix}-{}", uuid::Uuid::new_v4().simple());
        let clean_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(default_title)
            .to_string();
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO agent_sessions(id, instance_id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, inst, clean_title, now, now],
        )?;
        Ok(AgentSessionSummary {
            id,
            title: clean_title,
            preview: String::new(),
            turn_count: 0,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn ensure_agent_session(&self, session_id: Option<&str>) -> Result<String> {
        self.ensure_instance_session("config", session_id)
    }

    /// 确保返回的 `session_id` 严格归属于 `instance_id` 实例；
    /// 若传入了另一个实例的 `session_id`，自动在当前实例下新建独立会话，彻底杜绝跨实例串话污染。
    pub fn ensure_instance_session(
        &self,
        instance_id: &str,
        session_id: Option<&str>,
    ) -> Result<String> {
        let inst = normalize_agent_instance(instance_id);
        let default_title = default_instance_session_title(inst);
        if let Some(sid) = session_id.map(str::trim).filter(|s| !s.is_empty()) {
            let now = chrono::Utc::now().timestamp();
            let existing_owner: Option<String> = {
                let c = self.0.lock().unwrap();
                c.query_row(
                    "SELECT instance_id FROM agent_sessions WHERE id = ?1",
                    [sid],
                    |r| r.get(0),
                )
                .optional()?
            };
            match existing_owner {
                Some(owner) if owner == inst => return Ok(sid.to_string()),
                Some(_) => {
                    // 传入的会话属于另一个实例，拒绝复用并为本实例创建新会话
                    return Ok(self.create_instance_session(inst, None)?.id);
                }
                None => {
                    let c = self.0.lock().unwrap();
                    c.execute(
                        "INSERT INTO agent_sessions(id, instance_id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5)",
                        params![sid, inst, default_title, now, now],
                    )?;
                    return Ok(sid.to_string());
                }
            }
        }
        Ok(self.create_instance_session(inst, None)?.id)
    }

    pub fn get_agent_session_turns(&self, session_id: &str) -> Result<Vec<AgentTurnRecord>> {
        self.get_instance_session_turns("config", session_id)
    }

    pub fn get_instance_session_turns(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> Result<Vec<AgentTurnRecord>> {
        let inst = normalize_agent_instance(instance_id);
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT t.id, t.session_id, t.role, t.content, t.thinking, t.thinking_ms,
                    t.tool_steps_json, t.changes_json, t.config_diff_json, t.snapshot_toml,
                    t.secret_prompts_json, t.suggestions_json, t.created_at
             FROM agent_turns t
             INNER JOIN agent_sessions s ON s.id = t.session_id
             WHERE t.session_id = ?1 AND s.instance_id = ?2
             ORDER BY t.id ASC",
        )?;
        let rows = st.query_map(params![session_id, inst], |r| {
            let tool_steps_raw: String = r.get(6)?;
            let changes_raw: String = r.get(7)?;
            let config_diff_raw: String = r.get(8)?;
            let snapshot_toml: String = r.get(9)?;
            let secret_prompts_raw: String = r.get(10)?;
            let suggestions_raw: String = r.get(11)?;
            let config_diff = if config_diff_raw.trim().is_empty() {
                None
            } else {
                serde_json::from_str(&config_diff_raw).ok()
            };
            Ok(AgentTurnRecord {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                thinking: r.get(4)?,
                thinking_ms: r.get(5)?,
                tool_steps: serde_json::from_str(&tool_steps_raw).unwrap_or_default(),
                changes: serde_json::from_str(&changes_raw).unwrap_or_default(),
                config_diff,
                snapshot_toml,
                secret_prompts: serde_json::from_str(&secret_prompts_raw).unwrap_or_default(),
                suggestions: serde_json::from_str(&suggestions_raw).unwrap_or_default(),
                created_at: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn append_agent_turn(&self, turn: &NewAgentTurn<'_>) -> Result<i64> {
        self.append_instance_turn("config", turn)
    }

    pub fn append_instance_turn(&self, instance_id: &str, turn: &NewAgentTurn<'_>) -> Result<i64> {
        let inst = normalize_agent_instance(instance_id);
        let default_title = default_instance_session_title(inst);
        let now = chrono::Utc::now().timestamp();
        let tool_steps_json = serde_json::to_string(turn.tool_steps)?;
        let changes_json = serde_json::to_string(turn.changes)?;
        let config_diff_json = match turn.config_diff {
            Some(diff) => serde_json::to_string(diff)?,
            None => String::new(),
        };
        let secret_prompts_json = serde_json::to_string(turn.secret_prompts)?;
        let suggestions_json = serde_json::to_string(turn.suggestions)?;

        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT OR IGNORE INTO agent_sessions(id, instance_id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![turn.session_id, inst, default_title, now, now],
        )?;
        c.execute(
            "INSERT INTO agent_turns(
                session_id, role, content, thinking, thinking_ms,
                tool_steps_json, changes_json, config_diff_json, snapshot_toml,
                secret_prompts_json, suggestions_json, created_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                turn.session_id,
                turn.role,
                turn.content,
                turn.thinking,
                turn.thinking_ms,
                tool_steps_json,
                changes_json,
                config_diff_json,
                turn.snapshot_toml,
                secret_prompts_json,
                suggestions_json,
                now
            ],
        )?;
        let row_id = c.last_insert_rowid();

        if turn.role == "user" {
            let existing_title: Option<String> = c
                .query_row(
                    "SELECT title FROM agent_sessions WHERE id=?1 AND instance_id=?2",
                    params![turn.session_id, inst],
                    |r| r.get(0),
                )
                .optional()?;
            if existing_title
                .as_deref()
                .map(|t| {
                    let tr = t.trim();
                    tr.is_empty() || tr == "新配置对话" || tr == "新邮件对话"
                })
                .unwrap_or(true)
            {
                let single_line = turn.content.split_whitespace().collect::<Vec<_>>().join(" ");
                let char_count = single_line.chars().count();
                if char_count > 0 {
                    let short: String = single_line.chars().take(22).collect();
                    let next_title = if char_count > 22 {
                        format!("{short}…")
                    } else {
                        short
                    };
                    c.execute(
                        "UPDATE agent_sessions SET title=?1, updated_at=?2 WHERE id=?3 AND instance_id=?4",
                        params![next_title, now, turn.session_id, inst],
                    )?;
                } else {
                    c.execute(
                        "UPDATE agent_sessions SET updated_at=?1 WHERE id=?2 AND instance_id=?3",
                        params![now, turn.session_id, inst],
                    )?;
                }
            } else {
                c.execute(
                    "UPDATE agent_sessions SET updated_at=?1 WHERE id=?2 AND instance_id=?3",
                    params![now, turn.session_id, inst],
                )?;
            }
        } else {
            c.execute(
                "UPDATE agent_sessions SET updated_at=?1 WHERE id=?2 AND instance_id=?3",
                params![now, turn.session_id, inst],
            )?;
        }

        Ok(row_id)
    }

    pub fn delete_agent_session(&self, session_id: &str) -> Result<()> {
        self.delete_instance_session("config", session_id)
    }

    pub fn delete_instance_session(&self, instance_id: &str, session_id: &str) -> Result<()> {
        let inst = normalize_agent_instance(instance_id);
        let c = self.0.lock().unwrap();
        let owned: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM agent_sessions WHERE id=?1 AND instance_id=?2",
            params![session_id, inst],
            |r| r.get(0),
        )?;
        if owned {
            c.execute("DELETE FROM agent_turns WHERE session_id=?1", [session_id])?;
            c.execute(
                "DELETE FROM agent_sessions WHERE id=?1 AND instance_id=?2",
                params![session_id, inst],
            )?;
        }
        Ok(())
    }

    pub fn clear_agent_session_turns(&self, session_id: &str) -> Result<()> {
        self.clear_instance_session_turns("config", session_id)
    }

    pub fn clear_instance_session_turns(&self, instance_id: &str, session_id: &str) -> Result<()> {
        let inst = normalize_agent_instance(instance_id);
        let default_title = default_instance_session_title(inst);
        let now = chrono::Utc::now().timestamp();
        let c = self.0.lock().unwrap();
        let owned: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM agent_sessions WHERE id=?1 AND instance_id=?2",
            params![session_id, inst],
            |r| r.get(0),
        )?;
        if owned {
            c.execute("DELETE FROM agent_turns WHERE session_id=?1", [session_id])?;
            c.execute(
                "UPDATE agent_sessions SET title=?1, updated_at=?2 WHERE id=?3 AND instance_id=?4",
                params![default_title, now, session_id, inst],
            )?;
        }
        Ok(())
    }

    /// 回退指定配置对话至某条消息之前（删除 id >= from_turn_id 的所有消息），并返回该检查点前的脱敏 config.toml 快照
    pub fn rewind_agent_session(&self, session_id: &str, from_turn_id: i64) -> Result<Option<String>> {
        self.rewind_instance_session("config", session_id, from_turn_id)
    }

    pub fn rewind_instance_session(
        &self,
        instance_id: &str,
        session_id: &str,
        from_turn_id: i64,
    ) -> Result<Option<String>> {
        let inst = normalize_agent_instance(instance_id);
        let default_title = default_instance_session_title(inst);
        let now = chrono::Utc::now().timestamp();
        let c = self.0.lock().unwrap();

        let owned: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM agent_sessions WHERE id=?1 AND instance_id=?2",
            params![session_id, inst],
            |r| r.get(0),
        )?;
        if !owned {
            return Ok(None);
        }

        let mut st = c.prepare(
            "SELECT snapshot_toml, config_diff_json
             FROM agent_turns
             WHERE session_id = ?1 AND id >= ?2
             ORDER BY id ASC",
        )?;
        let candidates: Vec<(String, String)> = st
            .query_map(params![session_id, from_turn_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(st);

        let mut rollback_toml: Option<String> = None;
        if inst == "config" {
            for (snap, _) in &candidates {
                if !snap.trim().is_empty() {
                    rollback_toml = Some(snap.clone());
                    break;
                }
            }
            if rollback_toml.is_none() {
                for (_, diff_raw) in &candidates {
                    if diff_raw.trim().is_empty() {
                        continue;
                    }
                    if let Ok(diff) = serde_json::from_str::<crate::config::ConfigDiffReport>(diff_raw) {
                        if !diff.before_toml.trim().is_empty() {
                            rollback_toml = Some(diff.before_toml);
                            break;
                        }
                    }
                }
            }
        }

        c.execute(
            "DELETE FROM agent_turns WHERE session_id = ?1 AND id >= ?2",
            params![session_id, from_turn_id],
        )?;

        let remaining: i64 = c.query_row(
            "SELECT COUNT(*) FROM agent_turns WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )?;
        if remaining == 0 {
            c.execute(
                "UPDATE agent_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3 AND instance_id = ?4",
                params![default_title, now, session_id, inst],
            )?;
        } else {
            c.execute(
                "UPDATE agent_sessions SET updated_at = ?1 WHERE id = ?2 AND instance_id = ?3",
                params![now, session_id, inst],
            )?;
        }

        Ok(rollback_toml)
    }

    /// 定位指定消息下的单个附件元数据及其所属邮件在 IMAP 上的坐标（仅在用户主动触发下载/图片预览时调用）
    pub fn locate_attachment(
        &self,
        message_id_pk: i64,
        att_id: &str,
    ) -> Result<Option<MessageAttachmentLocator>> {
        let clean_target = att_id.trim();
        if clean_target.is_empty() {
            return Ok(None);
        }
        let c = self.0.lock().unwrap();
        let row: Option<(String, String, u32, String, String)> = c
            .query_row(
                "SELECT account_email, folder, uid, message_id, attachments_json FROM messages WHERE id=?1",
                [message_id_pk],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((account_email, folder, uid, rfc_message_id, atts_raw)) = row else {
            return Ok(None);
        };
        let raw_list: Vec<AttachmentMeta> = if atts_raw.trim().is_empty() || atts_raw.trim() == "[]" {
            Vec::new()
        } else {
            serde_json::from_str(&atts_raw).unwrap_or_default()
        };
        for (idx, mut item) in raw_list.into_iter().enumerate() {
            let legacy_rel = item.rel_path.clone();
            normalize_single_attachment(&mut item, idx);
            if item.id == clean_target || (!legacy_rel.is_empty() && legacy_rel == clean_target) {
                return Ok(Some(MessageAttachmentLocator {
                    account_email,
                    folder,
                    uid,
                    rfc_message_id,
                    meta: item,
                }));
            }
        }
        Ok(None)
    }

    /// 记录用户主动在“另存为”对话框确认写入后的本地保存路径
    pub fn record_attachment_saved_path(
        &self,
        message_id_pk: i64,
        att_id: &str,
        saved_path: &str,
    ) -> Result<Option<AttachmentMeta>> {
        let clean_target = att_id.trim();
        let c = self.0.lock().unwrap();
        let atts_raw: Option<String> = c
            .query_row(
                "SELECT attachments_json FROM messages WHERE id=?1",
                [message_id_pk],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = atts_raw else {
            return Ok(None);
        };
        let mut list: Vec<AttachmentMeta> = serde_json::from_str(&raw).unwrap_or_default();
        let mut updated: Option<AttachmentMeta> = None;
        for (idx, item) in list.iter_mut().enumerate() {
            let legacy_rel = item.rel_path.clone();
            normalize_single_attachment(item, idx);
            if item.id == clean_target || (!legacy_rel.is_empty() && legacy_rel == clean_target) {
                item.saved_path = saved_path.to_string();
                updated = Some(item.clone());
            }
        }
        if updated.is_some() {
            let next_json = serde_json::to_string(&list)?;
            c.execute(
                "UPDATE messages SET attachments_json=?2 WHERE id=?1",
                params![message_id_pk, next_json],
            )?;
        }
        Ok(updated)
    }

    // ── 跨邮箱统一回复：声明式隐私权限策略与待审回复队列 ──────────────────

    pub fn reply_policy(&self) -> Result<crate::privacy::ReplyPolicySpec> {
        let raw = self
            .kv_get::<crate::privacy::ReplyPolicySpec>("reply_policy")?
            .unwrap_or_default();
        Ok(crate::privacy::normalize_policy(&raw))
    }

    pub fn save_reply_policy(&self, policy: &crate::privacy::ReplyPolicySpec) -> Result<()> {
        let norm = crate::privacy::normalize_policy(policy);
        self.kv_set("reply_policy", &norm)
    }

    /// 第一阶段零信任元数据扫描：仅提取指定账号集合内「最后一封消息为对方来信」的元数据，绝不在准入前加载邮件完整正文
    pub fn unanswered_candidate_metas(
        &self,
        scopes: &[String],
        include_dismissed: bool,
        limit_total: usize,
    ) -> Result<Vec<CandidateMetaRow>> {
        if scopes.is_empty() {
            return Ok(Vec::new());
        }
        let c = self.0.lock().unwrap();
        let mut out = Vec::new();
        for raw_scope in scopes {
            let sc = scope_key(raw_scope);
            let sql = if include_dismissed {
                r#"
                SELECT m.id, m.account_email, m.message_id, m.peer, m.from_addr, m.from_name,
                       m.subject, m.status, m.category, m.extracted_code, m.date
                FROM messages m
                INNER JOIN (
                    SELECT peer, MAX(date * 1000000 + id) AS max_ord
                    FROM messages
                    WHERE account_email = ?1
                    GROUP BY peer
                ) latest ON m.peer = latest.peer AND (m.date * 1000000 + m.id) = latest.max_ord
                WHERE m.account_email = ?1
                  AND m.outgoing = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM reply_queue rq
                      WHERE rq.account_email = m.account_email
                        AND rq.message_id_ref = m.id
                        AND rq.status IN ('pending_review', 'approved_sent', 'auto_sent')
                  )
                ORDER BY m.date DESC, m.id DESC
                LIMIT 30
                "#
            } else {
                r#"
                SELECT m.id, m.account_email, m.message_id, m.peer, m.from_addr, m.from_name,
                       m.subject, m.status, m.category, m.extracted_code, m.date
                FROM messages m
                INNER JOIN (
                    SELECT peer, MAX(date * 1000000 + id) AS max_ord
                    FROM messages
                    WHERE account_email = ?1
                    GROUP BY peer
                ) latest ON m.peer = latest.peer AND (m.date * 1000000 + m.id) = latest.max_ord
                WHERE m.account_email = ?1
                  AND m.outgoing = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM reply_queue rq
                      WHERE rq.account_email = m.account_email
                        AND rq.message_id_ref = m.id
                        AND rq.status IN ('pending_review', 'approved_sent', 'auto_sent', 'dismissed')
                  )
                ORDER BY m.date DESC, m.id DESC
                LIMIT 30
                "#
            };
            let mut st = c.prepare(sql)?;
            let rows = st.query_map([&sc], |r| {
                Ok(CandidateMetaRow {
                    message_id_pk: r.get(0)?,
                    account_email: r.get(1)?,
                    rfc_message_id: r.get(2)?,
                    peer: r.get(3)?,
                    from_addr: r.get(4)?,
                    from_name: r.get(5)?,
                    subject: r.get(6)?,
                    status: r.get(7)?,
                    category: r.get(8)?,
                    extracted_code: r.get(9)?,
                    date: r.get(10)?,
                })
            })?;
            for item in rows {
                out.push(item?);
            }
        }
        out.sort_by(|a, b| b.date.cmp(&a.date));
        out.truncate(limit_total.max(1));
        Ok(out)
    }

    /// 仅对已通过第一道隐私准入校验的邮件读取去噪正文（按字符上限截断）
    pub fn load_stripped_body_by_id(&self, message_id_pk: i64, max_chars: usize) -> Result<String> {
        let c = self.0.lock().unwrap();
        let pair: Option<(String, String)> = c
            .query_row(
                "SELECT body, body_full FROM messages WHERE id=?1",
                [message_id_pk],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((body, body_full)) = pair else {
            return Ok(String::new());
        };
        let src = if !body.trim().is_empty() {
            body
        } else {
            crate::mail::clean_body(&body_full)
        };
        let cap = max_chars.clamp(120, 8000);
        let total = src.chars().count();
        if total <= cap {
            Ok(src)
        } else {
            let head: String = src.chars().take(cap).collect();
            Ok(format!("{head}\n…（已按隐私长度策略截断，仅读取前 {cap} 字）"))
        }
    }

    pub fn upsert_reply_queue_item(&self, item: &NewReplyQueueItem<'_>) -> Result<i64> {
        let now = chrono::Utc::now().timestamp();
        let redactions_json = serde_json::to_string(item.redactions)?;
        let sent_at = if item.status == "auto_sent" || item.status == "approved_sent" {
            now
        } else {
            0
        };
        let c = self.0.lock().unwrap();
        c.execute(
            r#"
            INSERT INTO reply_queue (
                account_email, message_id_ref, rfc_message_id, peer, sender_addr, sender_name,
                original_subject, original_snippet, sanitized_input, redactions_json,
                permission_tier, permission_reason, draft_subject, draft_body, draft_html,
                confidence_note, dlp_warning, status, error_msg, created_at, sent_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20, ?21
            )
            ON CONFLICT(account_email, message_id_ref) DO UPDATE SET
                sanitized_input = excluded.sanitized_input,
                redactions_json = excluded.redactions_json,
                permission_tier = excluded.permission_tier,
                permission_reason = excluded.permission_reason,
                draft_subject = excluded.draft_subject,
                draft_body = excluded.draft_body,
                draft_html = excluded.draft_html,
                confidence_note = excluded.confidence_note,
                dlp_warning = excluded.dlp_warning,
                status = excluded.status,
                error_msg = excluded.error_msg,
                created_at = excluded.created_at,
                sent_at = excluded.sent_at
            "#,
            params![
                scope_key(item.account_email),
                item.message_id_ref,
                item.rfc_message_id,
                item.peer,
                item.sender_addr,
                item.sender_name,
                item.original_subject,
                item.original_snippet,
                item.sanitized_input,
                redactions_json,
                item.permission_tier,
                item.permission_reason,
                item.draft_subject,
                item.draft_body,
                item.draft_html,
                item.confidence_note,
                item.dlp_warning,
                item.status,
                item.error_msg,
                now,
                sent_at
            ],
        )?;
        let id: i64 = c.query_row(
            "SELECT id FROM reply_queue WHERE account_email=?1 AND message_id_ref=?2",
            params![scope_key(item.account_email), item.message_id_ref],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    pub fn list_reply_queue(
        &self,
        status_filter: Option<&str>,
        account_filter: Option<&str>,
    ) -> Result<Vec<ReplyQueueItem>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            r#"
            SELECT id, account_email, message_id_ref, rfc_message_id, peer, sender_addr, sender_name,
                   original_subject, original_snippet, sanitized_input, redactions_json,
                   permission_tier, permission_reason, draft_subject, draft_body, draft_html,
                   confidence_note, dlp_warning, status, error_msg, created_at, sent_at
            FROM reply_queue
            ORDER BY
                CASE WHEN status = 'pending_review' THEN 0 WHEN status = 'failed' THEN 1 ELSE 2 END ASC,
                created_at DESC, id DESC
            LIMIT 200
            "#,
        )?;
        let sf = status_filter.map(str::trim).filter(|s| !s.is_empty() && *s != "all");
        let af = account_filter
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "all")
            .map(scope_key);

        let rows = st.query_map([], row_to_reply_queue_item)?;
        let mut list = Vec::new();
        for r in rows {
            let item = r?;
            if let Some(target_st) = sf {
                if target_st == "sent" {
                    if item.status != "approved_sent" && item.status != "auto_sent" {
                        continue;
                    }
                } else if item.status != target_st {
                    continue;
                }
            }
            if let Some(ref target_acc) = af {
                if &item.account_email != target_acc {
                    continue;
                }
            }
            list.push(item);
        }
        Ok(list)
    }

    pub fn get_reply_queue_item(&self, id: i64) -> Result<Option<ReplyQueueItem>> {
        let c = self.0.lock().unwrap();
        c.query_row(
            r#"
            SELECT id, account_email, message_id_ref, rfc_message_id, peer, sender_addr, sender_name,
                   original_subject, original_snippet, sanitized_input, redactions_json,
                   permission_tier, permission_reason, draft_subject, draft_body, draft_html,
                   confidence_note, dlp_warning, status, error_msg, created_at, sent_at
            FROM reply_queue
            WHERE id = ?1
            "#,
            [id],
            row_to_reply_queue_item,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn update_reply_queue_draft(
        &self,
        id: i64,
        draft_subject: &str,
        draft_body: &str,
        draft_html: &str,
        dlp_warning: &str,
    ) -> Result<Option<ReplyQueueItem>> {
        {
            let c = self.0.lock().unwrap();
            c.execute(
                r#"
                UPDATE reply_queue
                SET draft_subject = ?2,
                    draft_body = ?3,
                    draft_html = ?4,
                    dlp_warning = ?5,
                    error_msg = CASE WHEN status = 'failed' THEN '' ELSE error_msg END,
                    status = CASE WHEN status = 'failed' THEN 'pending_review' ELSE status END
                WHERE id = ?1
                "#,
                params![id, draft_subject, draft_body, draft_html, dlp_warning],
            )?;
        }
        self.get_reply_queue_item(id)
    }

    pub fn mark_reply_queue_status(&self, id: i64, status: &str, error_msg: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let sent_at = if status == "approved_sent" || status == "auto_sent" {
            now
        } else {
            0
        };
        let c = self.0.lock().unwrap();
        c.execute(
            "UPDATE reply_queue SET status=?2, error_msg=?3, sent_at=CASE WHEN ?4 > 0 THEN ?4 ELSE sent_at END WHERE id=?1",
            params![id, status, error_msg, sent_at],
        )?;
        Ok(())
    }

    pub fn clear_finished_reply_queue(&self) -> Result<usize> {
        let c = self.0.lock().unwrap();
        Ok(c.execute(
            "DELETE FROM reply_queue WHERE status IN ('approved_sent', 'auto_sent', 'dismissed')",
            [],
        )?)
    }

    pub fn reply_queue_stats(&self) -> Result<ReplyQueueStats> {
        let hour_ago = chrono::Utc::now().timestamp() - 3600;
        let c = self.0.lock().unwrap();
        let pending_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='pending_review'",
            [],
            |r| r.get(0),
        )?;
        let approved_sent_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='approved_sent'",
            [],
            |r| r.get(0),
        )?;
        let auto_sent_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='auto_sent'",
            [],
            |r| r.get(0),
        )?;
        let dismissed_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='dismissed'",
            [],
            |r| r.get(0),
        )?;
        let failed_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='failed'",
            [],
            |r| r.get(0),
        )?;
        let auto_sent_last_hour: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE status='auto_sent' AND sent_at >= ?1",
            [hour_ago],
            |r| r.get(0),
        )?;
        Ok(ReplyQueueStats {
            pending_count,
            approved_sent_count,
            auto_sent_count,
            dismissed_count,
            failed_count,
            auto_sent_last_hour: auto_sent_last_hour.max(0) as usize,
        })
    }

    /// 防死循环冷却检查：判断某账号是否在最近 `within_minutes` 分钟内已向同一发件人自动回复过
    pub fn has_recent_auto_reply_to_sender(
        &self,
        account_email: &str,
        sender_addr: &str,
        within_minutes: u32,
    ) -> Result<bool> {
        let mins = within_minutes.clamp(1, 10_080) as i64;
        let cutoff = chrono::Utc::now().timestamp() - mins * 60;
        let scope = scope_key(account_email);
        let sender_norm = sender_addr.trim().to_lowercase();
        let c = self.0.lock().unwrap();
        let cnt: i64 = c.query_row(
            "SELECT COUNT(*) FROM reply_queue WHERE account_email=?1 AND LOWER(sender_addr)=?2 AND status='auto_sent' AND sent_at >= ?3",
            params![scope, sender_norm, cutoff],
            |r| r.get(0),
        )?;
        Ok(cnt > 0)
    }
}

fn row_to_reply_queue_item(r: &rusqlite::Row) -> rusqlite::Result<ReplyQueueItem> {
    let red_raw: String = r.get(10).unwrap_or_default();
    let redactions: Vec<crate::privacy::RedactionHit> =
        if red_raw.trim().is_empty() || red_raw.trim() == "[]" {
            Vec::new()
        } else {
            serde_json::from_str(&red_raw).unwrap_or_default()
        };
    Ok(ReplyQueueItem {
        id: r.get(0)?,
        account_email: r.get(1)?,
        message_id_ref: r.get(2)?,
        rfc_message_id: r.get(3)?,
        peer: r.get(4)?,
        sender_addr: r.get(5)?,
        sender_name: r.get(6)?,
        original_subject: r.get(7)?,
        original_snippet: r.get(8)?,
        sanitized_input: r.get(9)?,
        redactions,
        permission_tier: r.get(11)?,
        permission_reason: r.get(12)?,
        draft_subject: r.get(13)?,
        draft_body: r.get(14)?,
        draft_html: r.get(15)?,
        confidence_note: r.get(16)?,
        dlp_warning: r.get(17)?,
        status: r.get(18)?,
        error_msg: r.get(19)?,
        created_at: r.get(20)?,
        sent_at: r.get(21)?,
    })
}

fn normalize_single_attachment(item: &mut AttachmentMeta, idx: usize) {
    if item.id.trim().is_empty() {
        if !item.rel_path.trim().is_empty() {
            item.id = format!("legacy-{}", item.rel_path.trim());
        } else {
            item.id = format!("att-idx-{idx}");
        }
    }
    if item.att_index == 0 && idx > 0 {
        item.att_index = idx;
    }
    item.rel_path.clear();
    if !item.saved_path.is_empty() && !Path::new(&item.saved_path).is_file() {
        item.saved_path.clear();
    }
}

fn normalize_loaded_attachments(mut items: Vec<AttachmentMeta>) -> Vec<AttachmentMeta> {
    for (idx, item) in items.iter_mut().enumerate() {
        normalize_single_attachment(item, idx);
    }
    items
}

fn compact_preview(raw: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    static MD_LINK: OnceLock<Regex> = OnceLock::new();
    static ANGLE_URL: OnceLock<Regex> = OnceLock::new();
    static LONG_URL: OnceLock<Regex> = OnceLock::new();
    static PIPE_BORDERS: OnceLock<Regex> = OnceLock::new();

    let md_link = MD_LINK.get_or_init(|| Regex::new(r"\[([^\]\n]{1,60})\]\(https?://[^\s)]+\)").unwrap());
    let angle_url = ANGLE_URL.get_or_init(|| Regex::new(r"<https?://([^/\s>]+)[^>]*>").unwrap());
    let long_url = LONG_URL.get_or_init(|| Regex::new(r"https?://([^/\s]+)\S{20,}").unwrap());
    let pipe_borders = PIPE_BORDERS.get_or_init(|| Regex::new(r"\s*\|\s*").unwrap());

    let s = md_link.replace_all(raw, "$1");
    let stripped_angle = angle_url.replace_all(&s, "");
    let base = if stripped_angle.trim().is_empty() {
        angle_url.replace_all(&s, "$1").into_owned()
    } else {
        stripped_angle.into_owned()
    };
    let s = long_url.replace_all(&base, "$1");
    let s = pipe_borders.replace_all(&s, " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
}

fn attachment_preview_label(raw_json: &str) -> Option<String> {
    let trimmed = raw_json.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return None;
    }
    let items: Vec<AttachmentMeta> = serde_json::from_str(trimmed).ok()?;
    if items.is_empty() {
        return None;
    }
    if items.iter().all(|a| a.is_image) {
        Some(if items.len() == 1 {
            "[图片]".to_string()
        } else {
            format!("[图片 {} 张]", items.len())
        })
    } else if items.len() == 1 {
        Some(format!("[文件] {}", items[0].filename))
    } else {
        Some(format!("[附件 {} 个] {}", items.len(), items[0].filename))
    }
}

#[allow(clippy::too_many_arguments)]
fn build_reply_quote(
    id: i64,
    message_id: &str,
    outgoing: bool,
    from_addr: &str,
    from_name: &str,
    contact_alias: &str,
    subject: &str,
    body: &str,
    attachments_json: &str,
) -> ReplyQuote {
    let sender = if outgoing {
        "我".to_string()
    } else if !contact_alias.trim().is_empty() {
        contact_alias.trim().to_string()
    } else if !from_name.trim().is_empty() {
        from_name.trim().to_string()
    } else {
        from_addr.trim().to_string()
    };

    let clean_body = compact_preview(body.trim());
    let snippet = if !clean_body.is_empty() {
        clean_body.chars().take(68).collect()
    } else if let Some(att) = attachment_preview_label(attachments_json) {
        att
    } else {
        subject.trim().chars().take(68).collect()
    };

    ReplyQuote {
        id,
        message_id: message_id.to_string(),
        sender,
        snippet,
    }
}

fn row_to_dto(r: &rusqlite::Row) -> rusqlite::Result<MessageDto> {
    let atts_raw: String = r.get(16).unwrap_or_default();
    let reply_raw: String = r.get(17).unwrap_or_default();
    let attachments: Vec<AttachmentMeta> = if atts_raw.trim().is_empty() || atts_raw.trim() == "[]" {
        Vec::new()
    } else {
        normalize_loaded_attachments(serde_json::from_str(&atts_raw).unwrap_or_default())
    };
    let reply_to: Option<ReplyQuote> = if reply_raw.trim().is_empty() {
        None
    } else {
        serde_json::from_str(&reply_raw).ok()
    };

    Ok(MessageDto {
        id: r.get(0)?,
        peer: r.get(1)?,
        from_addr: r.get(2)?,
        from_name: r.get(3)?,
        subject: r.get(4)?,
        body: r.get(5)?,
        body_full: r.get(6)?,
        date: r.get(7)?,
        outgoing: r.get(8)?,
        status: r.get(9)?,
        category: r.get(10)?,
        summary: r.get(11)?,
        reason: r.get(12)?,
        extracted_code: r.get(13)?,
        suggested_reply: r.get(14)?,
        body_html: r.get(15).unwrap_or_default(),
        attachments,
        reply_to,
    })
}
