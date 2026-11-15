//! 跨邮箱统一回复与写信工坊的隐私边界、PII/凭据脱敏引擎、分级发信权限与出站 DLP 防泄漏守卫：
//! 1. **读取范围隔离（能读哪些邮件）**：默认零授权（Opt-in），仅允许读取 `enabled_accounts` 显式开启的邮箱；
//!    硬性阻断 `blocked` 拦截槽邮件，默认跳过含验证码、账单、财务、密码重置及系统 `no-reply` 邮件；支持白名单/黑名单精细过滤。
//! 2. **正文隐私脱敏（邮件里面的隐私）**：进入外部大模型前，在本地确定性扫描并盲替换 API Key/私钥/口令、URL 鉴权令牌、
//!    身份证号、银行卡号、手机号、动态验证码与自定义敏感词为 `{{MC_*_N}}` 占位符；持久化审计仅保留掩码摘要（如 `138****5678`）。
//! 3. **分级执行权限与出站 DLP（权限控制）**：默认全部进入「人工审阅待发队列 (`draft_review`)」；
//!    仅当显式开启 `auto_send_enabled` 且发件人命中白名单、未超每小时配额、且通过出站 DLP 检查（无明文密钥、无残留脱敏占位符）时才允许受限自动发送。

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::OnceLock;

fn default_true() -> bool {
    true
}

fn default_allowed_statuses() -> Vec<String> {
    vec!["inbox".into()]
}

fn default_sender_filter_mode() -> String {
    "all_allowed".into()
}

fn default_max_context_chars() -> usize {
    1600
}

fn default_hourly_limit() -> u32 {
    10
}

fn default_rule_mode() -> String {
    "ai".into()
}

fn default_cooldown_minutes() -> u32 {
    60
}

pub fn default_persona_instructions() -> String {
    "礼貌、专业、简洁地回复来信；对需要确认排期、金额、审批或合同条款的事项，先得体确认已收到并说明将尽快核实答复，绝不擅自做出未授权承诺。".into()
}

/// 自动化条件回复规则（支持 AI 动态生成或固定文本/HTML 模板秒回，含防死循环冷却保护）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoReplyRuleSpec {
    /// 规则唯一标识（如 "rule_quote"）
    #[serde(default)]
    pub id: String,
    /// 规则名称（如 "商务询价自动接待"、"休假外出自动告知"）
    #[serde(default)]
    pub name: String,
    /// 是否启用该条自动化规则
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 限定生效的收件邮箱账号（为空则对所有已授权邮箱 enabled_accounts 生效）
    #[serde(default)]
    pub accounts: Vec<String>,
    /// 触发条件：匹配指定发件人邮箱（任一命中；若与 match_domains 均为空则不限发件人）
    #[serde(default)]
    pub match_senders: Vec<String>,
    /// 触发条件：匹配指定发件域名（如 "partner.com"）
    #[serde(default)]
    pub match_domains: Vec<String>,
    /// 触发条件：主题或正文包含任一关键词（为空则不限关键词，例如休假自动回复）
    #[serde(default)]
    pub match_keywords: Vec<String>,
    /// 回复生成模式："ai"（结合脱敏来信与指令动态生成） | "template"（固定模板秒回）
    #[serde(default = "default_rule_mode")]
    pub mode: String,
    /// mode="ai" 时为专属回复指令；mode="template" 时为纯文本回复正文
    #[serde(default)]
    pub instructions_or_template: String,
    /// mode="template" 时可选的内联样式 HTML 回复模板
    #[serde(default)]
    pub template_html: String,
    /// 是否转为人工确认后再发送（false = 自动直接发出；true = 仅自动生成待审草稿）
    #[serde(default)]
    pub require_review: bool,
    /// 防死循环冷却时间（分钟）：同一发件人在冷却窗口内最多自动回复一次，默认 60 分钟
    #[serde(default = "default_cooldown_minutes")]
    pub cooldown_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyPolicySpec {
    /// 是否启用跨邮箱统一回复工作流
    #[serde(default)]
    pub enabled: bool,
    /// 收信同步完成后是否自动扫描已授权邮箱生成待审草稿（或对白名单触发受限自动回复）
    #[serde(default)]
    pub auto_scan_on_sync: bool,
    /// 显式授权允许 Agent 读取来信的邮箱账号列表（未列入的邮箱账号 100% 物理隔离禁读）
    #[serde(default)]
    pub enabled_accounts: Vec<String>,
    /// 允许读取的邮件槽位：仅支持 "inbox" 与 "archived"，底层硬性剥离 "blocked"
    #[serde(default = "default_allowed_statuses")]
    pub allowed_statuses: Vec<String>,
    /// 发件人过滤模式："all_allowed"（允许非排除的常规来信） | "whitelist_only"（严格仅允许白名单发件人/域名）
    #[serde(default = "default_sender_filter_mode")]
    pub sender_filter_mode: String,
    /// 允许读取的白名单发件人邮箱
    #[serde(default)]
    pub allow_senders: Vec<String>,
    /// 允许读取的白名单发件域名（如 "nebula-studio.cn"）
    #[serde(default)]
    pub allow_domains: Vec<String>,
    /// 禁止读取的黑名单发件人邮箱（如人事薪酬、高管私密信箱等）
    #[serde(default)]
    pub exclude_senders: Vec<String>,
    /// 禁止读取的主题/正文敏感关键词（如 "工资条"、"体检报告"、"保密协议"）
    #[serde(default)]
    pub exclude_keywords: Vec<String>,
    /// 硬性跳过验证码、账单、财务、密码重置与自动系统通知类高敏邮件
    #[serde(default = "default_true")]
    pub skip_sensitive_mails: bool,
    /// 是否允许对多人邮件群聊生成统一回复（默认关闭以防群发打扰）
    #[serde(default)]
    pub include_groups: bool,
    /// 单封邮件送入模型的最大脱敏正文字符数
    #[serde(default = "default_max_context_chars")]
    pub max_context_chars: usize,
    /// 入模前是否在本地自动脱敏手机号、身份证、银行卡、动态码等个人隐私（密钥类始终强制脱敏）
    #[serde(default = "default_true")]
    pub redact_pii: bool,
    /// 用户自定义入模前需脱敏的敏感词（如内部项目代号、客户真名、合同编号）
    #[serde(default)]
    pub custom_redact_terms: Vec<String>,
    /// 是否允许对命中自动发信白名单的联系人执行受限自动发送（默认关闭，全部进入人工审阅队列）
    #[serde(default)]
    pub auto_send_enabled: bool,
    /// 受限自动发送：白名单发件人邮箱（必须显式列入才可自动回复）
    #[serde(default)]
    pub auto_send_senders: Vec<String>,
    /// 受限自动发送：白名单发件域名
    #[serde(default)]
    pub auto_send_domains: Vec<String>,
    /// 受限自动发送每小时最大封数配额（超出后自动降级为人工待审）
    #[serde(default = "default_hourly_limit")]
    pub auto_send_hourly_limit: u32,
    /// 出站 DLP 防泄漏守卫（拦截含明文密钥、私钥或未替换脱敏占位符的外发内容）
    #[serde(default = "default_true")]
    pub outbound_dlp_guard: bool,
    /// 跨邮箱统一回复的语气与行为边界指令
    #[serde(default = "default_persona_instructions")]
    pub persona_instructions: String,
    /// 条件触发式自动化回复规则列表
    #[serde(default)]
    pub auto_rules: Vec<AutoReplyRuleSpec>,
}

impl Default for ReplyPolicySpec {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_scan_on_sync: false,
            enabled_accounts: Vec::new(),
            allowed_statuses: default_allowed_statuses(),
            sender_filter_mode: default_sender_filter_mode(),
            allow_senders: Vec::new(),
            allow_domains: Vec::new(),
            exclude_senders: Vec::new(),
            exclude_keywords: Vec::new(),
            skip_sensitive_mails: true,
            include_groups: false,
            max_context_chars: default_max_context_chars(),
            redact_pii: true,
            custom_redact_terms: Vec::new(),
            auto_send_enabled: false,
            auto_send_senders: Vec::new(),
            auto_send_domains: Vec::new(),
            auto_send_hourly_limit: default_hourly_limit(),
            outbound_dlp_guard: true,
            persona_instructions: default_persona_instructions(),
            auto_rules: Vec::new(),
        }
    }
}

impl ReplyPolicySpec {
    pub fn is_default_like(&self) -> bool {
        let def = Self::default();
        !self.enabled
            && !self.auto_scan_on_sync
            && self.enabled_accounts.is_empty()
            && self.allow_senders.is_empty()
            && self.allow_domains.is_empty()
            && self.exclude_senders.is_empty()
            && self.exclude_keywords.is_empty()
            && self.custom_redact_terms.is_empty()
            && !self.auto_send_enabled
            && self.auto_send_senders.is_empty()
            && self.auto_send_domains.is_empty()
            && self.auto_rules.is_empty()
            && self.skip_sensitive_mails == def.skip_sensitive_mails
            && self.include_groups == def.include_groups
            && self.redact_pii == def.redact_pii
            && self.outbound_dlp_guard == def.outbound_dlp_guard
            && self.sender_filter_mode.trim() == def.sender_filter_mode
            && self.persona_instructions.trim() == def.persona_instructions.trim()
    }
}

fn norm_list_lower(items: &[String], strip_at: bool) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in items {
        let mut s = raw.trim().to_lowercase();
        if strip_at {
            s = s.trim_start_matches('@').trim().to_string();
        }
        if !s.is_empty() && seen.insert(s.clone()) {
            out.push(s);
        }
    }
    out
}

fn norm_list_preserve_case(items: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in items {
        let s = raw.trim().to_string();
        let key = s.to_lowercase();
        if !s.is_empty() && seen.insert(key) {
            out.push(s);
        }
    }
    out
}

pub fn normalize_policy(raw: &ReplyPolicySpec) -> ReplyPolicySpec {
    let mut allowed_statuses: Vec<String> = raw
        .allowed_statuses
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| matches!(s.as_str(), "inbox" | "archived"))
        .collect();
    allowed_statuses.dedup();
    if allowed_statuses.is_empty() {
        allowed_statuses.push("inbox".into());
    }

    let mode = match raw.sender_filter_mode.trim().to_lowercase().as_str() {
        "whitelist_only" | "whitelist" => "whitelist_only".to_string(),
        _ => "all_allowed".to_string(),
    };

    let persona = if raw.persona_instructions.trim().is_empty() {
        default_persona_instructions()
    } else {
        raw.persona_instructions.trim().to_string()
    };

    let mut used_ids = BTreeSet::new();
    let mut auto_rules = Vec::new();
    for (idx, r) in raw.auto_rules.iter().enumerate() {
        let base_id = {
            let cleaned: String = r
                .id
                .trim()
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                        ch.to_ascii_lowercase()
                    } else {
                        '_'
                    }
                })
                .collect();
            let trimmed = cleaned.trim_matches('_').to_string();
            if trimmed.is_empty() {
                format!("rule_{}", idx + 1)
            } else {
                trimmed
            }
        };
        let mut final_id = base_id.clone();
        let mut suffix = 2usize;
        while !used_ids.insert(final_id.clone()) {
            final_id = format!("{base_id}_{suffix}");
            suffix += 1;
        }
        let rule_mode = match r.mode.trim().to_lowercase().as_str() {
            "template" | "fixed" | "static" => "template".to_string(),
            _ => "ai".to_string(),
        };
        let name = if r.name.trim().is_empty() {
            format!("自动回复规则 #{}", idx + 1)
        } else {
            r.name.trim().to_string()
        };
        auto_rules.push(AutoReplyRuleSpec {
            id: final_id,
            name,
            enabled: r.enabled,
            accounts: norm_list_lower(&r.accounts, false),
            match_senders: norm_list_lower(&r.match_senders, false),
            match_domains: norm_list_lower(&r.match_domains, true),
            match_keywords: norm_list_lower(&r.match_keywords, false),
            mode: rule_mode,
            instructions_or_template: r.instructions_or_template.trim().to_string(),
            template_html: sanitize_outgoing_html(&r.template_html),
            require_review: r.require_review,
            cooldown_minutes: r.cooldown_minutes.clamp(5, 10_080),
        });
    }

    ReplyPolicySpec {
        enabled: raw.enabled,
        auto_scan_on_sync: raw.auto_scan_on_sync,
        enabled_accounts: norm_list_lower(&raw.enabled_accounts, false),
        allowed_statuses,
        sender_filter_mode: mode,
        allow_senders: norm_list_lower(&raw.allow_senders, false),
        allow_domains: norm_list_lower(&raw.allow_domains, true),
        exclude_senders: norm_list_lower(&raw.exclude_senders, false),
        exclude_keywords: norm_list_lower(&raw.exclude_keywords, false),
        skip_sensitive_mails: raw.skip_sensitive_mails,
        include_groups: raw.include_groups,
        max_context_chars: raw.max_context_chars.clamp(200, 6000),
        redact_pii: raw.redact_pii,
        custom_redact_terms: norm_list_preserve_case(&raw.custom_redact_terms),
        auto_send_enabled: raw.auto_send_enabled,
        auto_send_senders: norm_list_lower(&raw.auto_send_senders, false),
        auto_send_domains: norm_list_lower(&raw.auto_send_domains, true),
        auto_send_hourly_limit: raw.auto_send_hourly_limit.clamp(1, 100),
        outbound_dlp_guard: raw.outbound_dlp_guard,
        persona_instructions: persona,
        auto_rules,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReadAccessVerdict {
    Allowed,
    Denied { code: String, reason: String },
}

fn domain_matches(sender_domain: &str, rule_domain: &str) -> bool {
    let d = rule_domain.trim().trim_start_matches('@').to_lowercase();
    !d.is_empty() && (sender_domain == d || sender_domain.ends_with(&format!(".{d}")))
}

pub fn is_automated_no_reply_sender(addr: &str) -> bool {
    let lower = addr.trim().to_lowercase();
    let local = lower.split('@').next().unwrap_or("");
    let auto_locals = [
        "noreply",
        "no-reply",
        "no_reply",
        "donotreply",
        "do-not-reply",
        "mailer-daemon",
        "postmaster",
        "bounce",
        "bounces",
        "daemon",
        "auto-confirm",
        "system-notify",
    ];
    auto_locals
        .iter()
        .any(|k| local == *k || local.starts_with(&format!("{k}+")) || local.starts_with(&format!("{k}-")))
}

fn is_sensitive_mail_meta(subject: &str, category: &str, extracted_code: &str) -> Option<&'static str> {
    if !extracted_code.trim().is_empty() {
        return Some("包含提取的登录/安全验证码");
    }
    let cat = category.trim().to_lowercase();
    if matches!(
        cat.as_str(),
        "验证码" | "账单" | "财务" | "安全" | "密码" | "诈骗" | "营销" | "推广"
    ) {
        return Some("命中敏感/非沟通分类（验证码/账单/安全/营销）");
    }

    static SENSITIVE_SUBJ_RE: OnceLock<Regex> = OnceLock::new();
    let re = SENSITIVE_SUBJ_RE.get_or_init(|| {
        Regex::new(r"(?i)(验证码|校验码|动态码|找回密码|重置密码|修改密码|安全提醒|异常登录|银行账单|信用卡账单|电子发票|工资条|薪资单|薪酬明细|体检报告|verification\s*code|password\s*reset|security\s*alert|two-factor|2fa\s*code|bank\s*statement|payslip)").unwrap()
    });
    if re.is_match(subject) {
        return Some("主题涉及密码重置、验证码、账单或薪酬隐私");
    }
    None
}

/// 判定某封未回复来信是否允许被「跨邮箱统一回复 Agent」读取正文
#[allow(clippy::too_many_arguments)]
pub fn evaluate_read_access(
    policy: &ReplyPolicySpec,
    account_email: &str,
    is_group: bool,
    status: &str,
    sender_addr: &str,
    subject: &str,
    category: &str,
    extracted_code: &str,
    body_preview: &str,
) -> ReadAccessVerdict {
    let acc_norm = account_email.trim().to_lowercase();
    let enabled_match = policy
        .enabled_accounts
        .iter()
        .any(|a| a.trim().eq_ignore_ascii_case(&acc_norm));
    if !enabled_match {
        return ReadAccessVerdict::Denied {
            code: "account_isolated".into(),
            reason: format!("邮箱 {acc_norm} 未开启读取授权（已物理隔离）"),
        };
    }

    let st_norm = status.trim().to_lowercase();
    if st_norm == "blocked" {
        return ReadAccessVerdict::Denied {
            code: "blocked_slot".into(),
            reason: "硬性安全红线：禁止 Agent 读取「拦截」槽邮件".into(),
        };
    }
    if !policy.allowed_statuses.iter().any(|s| s == &st_norm) {
        return ReadAccessVerdict::Denied {
            code: "status_excluded".into(),
            reason: format!("状态槽「{st_norm}」未纳入读取范围"),
        };
    }

    if is_group && !policy.include_groups {
        return ReadAccessVerdict::Denied {
            code: "group_excluded".into(),
            reason: "默认跳过多人邮件群聊（避免群发回复打扰）".into(),
        };
    }

    let sender_norm = sender_addr.trim().to_lowercase();
    let sender_domain = sender_norm.split('@').nth(1).unwrap_or("");

    if is_automated_no_reply_sender(&sender_norm) {
        return ReadAccessVerdict::Denied {
            code: "no_reply_sender".into(),
            reason: format!("自动跳过系统免回复发件人 ({sender_norm})"),
        };
    }

    if policy.exclude_senders.iter().any(|e| e == &sender_norm) {
        return ReadAccessVerdict::Denied {
            code: "sender_excluded".into(),
            reason: format!("命中隐私禁读发件人黑名单 ({sender_norm})"),
        };
    }

    if policy.skip_sensitive_mails {
        if let Some(why) = is_sensitive_mail_meta(subject, category, extracted_code) {
            return ReadAccessVerdict::Denied {
                code: "sensitive_mail".into(),
                reason: why.to_string(),
            };
        }
    }

    if !policy.exclude_keywords.is_empty() {
        let hay = format!("{subject}\n{category}\n{body_preview}").to_lowercase();
        for kw in &policy.exclude_keywords {
            if !kw.is_empty() && hay.contains(kw) {
                return ReadAccessVerdict::Denied {
                    code: "keyword_excluded".into(),
                    reason: format!("命中隐私禁读关键词「{kw}」"),
                };
            }
        }
    }

    let in_whitelist = policy.allow_senders.iter().any(|a| a == &sender_norm)
        || policy
            .allow_domains
            .iter()
            .any(|d| domain_matches(sender_domain, d));

    if policy.sender_filter_mode == "whitelist_only" && !in_whitelist {
        return ReadAccessVerdict::Denied {
            code: "not_whitelisted".into(),
            reason: format!("开启了仅限白名单读取，{sender_norm} 未在授权名单内"),
        };
    }

    ReadAccessVerdict::Allowed
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionVerdict {
    /// 必须进入待审草稿队列，由人工确认（单封或批量批准）后方可发出
    DraftReview { reason: String },
    /// 命中显式自动发信白名单且在速率配额内，若通过出站 DLP 可自动发出
    WhitelistedAutoSend,
}

pub fn evaluate_send_permission(
    policy: &ReplyPolicySpec,
    sender_addr: &str,
    auto_sent_last_hour: usize,
) -> PermissionVerdict {
    if !policy.auto_send_enabled {
        return PermissionVerdict::DraftReview {
            reason: "默认人工审批：未开启自动发信总开关".into(),
        };
    }

    let sender_norm = sender_addr.trim().to_lowercase();
    if is_automated_no_reply_sender(&sender_norm) {
        return PermissionVerdict::DraftReview {
            reason: "防死循环保护：禁止向系统自动地址自动发信".into(),
        };
    }

    let sender_domain = sender_norm.split('@').nth(1).unwrap_or("");
    let whitelisted = policy.auto_send_senders.iter().any(|s| s == &sender_norm)
        || policy
            .auto_send_domains
            .iter()
            .any(|d| domain_matches(sender_domain, d));

    if !whitelisted {
        return PermissionVerdict::DraftReview {
            reason: "发件人未在「自动发信白名单」内，转为人工确认".into(),
        };
    }

    if auto_sent_last_hour >= policy.auto_send_hourly_limit as usize {
        return PermissionVerdict::DraftReview {
            reason: format!(
                "已达每小时自动发信上限 ({}/{})，自动降级为人工待审",
                auto_sent_last_hour, policy.auto_send_hourly_limit
            ),
        };
    }

    PermissionVerdict::WhitelistedAutoSend
}

/// 按顺序匹配已启用的「自动化回复规则」（要求已通过读取范围与敏感信准入校验）
pub fn match_auto_reply_rule<'a>(
    policy: &'a ReplyPolicySpec,
    account_email: &str,
    sender_addr: &str,
    subject: &str,
    body_preview: &str,
) -> Option<&'a AutoReplyRuleSpec> {
    let sender_norm = sender_addr.trim().to_lowercase();
    if sender_norm.is_empty() || is_automated_no_reply_sender(&sender_norm) {
        return None;
    }
    let acc_norm = account_email.trim().to_lowercase();
    let sender_domain = sender_norm.split('@').nth(1).unwrap_or("");
    let hay = format!("{subject}\n{body_preview}").to_lowercase();

    for rule in &policy.auto_rules {
        if !rule.enabled {
            continue;
        }
        if !rule.accounts.is_empty()
            && !rule
                .accounts
                .iter()
                .any(|a| a.trim().eq_ignore_ascii_case(&acc_norm))
        {
            continue;
        }

        let has_sender_cond = !rule.match_senders.is_empty() || !rule.match_domains.is_empty();
        if has_sender_cond {
            let sender_ok = rule.match_senders.iter().any(|s| s == &sender_norm)
                || rule
                    .match_domains
                    .iter()
                    .any(|d| domain_matches(sender_domain, d));
            if !sender_ok {
                continue;
            }
        }

        if !rule.match_keywords.is_empty() {
            let kw_ok = rule
                .match_keywords
                .iter()
                .any(|kw| !kw.is_empty() && hay.contains(kw));
            if !kw_ok {
                continue;
            }
        }

        return Some(rule);
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RedactionHit {
    /// 入模占位符，如 "{{MC_PHONE_1}}"
    pub placeholder: String,
    /// 隐私类别中文名，如 "手机号"、"银行卡号"、"API 密钥"
    pub kind_label: String,
    /// 脱敏掩码展示（绝不保存完整明文），如 "138****5678"
    pub masked_preview: String,
}

pub struct ScrubResult {
    pub scrubbed: String,
    pub hits: Vec<RedactionHit>,
    /// 仅驻留当前调用栈内存的 (placeholder, raw_value) 映射表，供写信工坊本地盲回填使用，绝不落盘或入模
    pub vault_map: Vec<(String, String)>,
}

pub fn mask_sensitive_preview(raw: &str) -> String {
    let trimmed = raw.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    let n = chars.len();
    if n <= 4 {
        return "****".to_string();
    }
    if n <= 8 {
        let head: String = chars[..1].iter().collect();
        let tail: String = chars[n - 1..].iter().collect();
        return format!("{head}****{tail}");
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[n - 3..].iter().collect();
    format!("{head}****{tail}")
}

/// 本地确定性隐私与密钥脱敏器：
/// - 无论 `redact_pii` 是否开启，始终强制剥离 API Key、私钥块、带密码连接串与 URL 敏感鉴权参数；
/// - 当 `redact_pii == true` 时，同时剥离身份证号、银行卡号、手机号、动态验证码及用户自定义敏感词。
pub fn scrub_text_with_vault(
    input: &str,
    redact_pii: bool,
    custom_terms: &[String],
) -> ScrubResult {
    if input.is_empty() {
        return ScrubResult {
            scrubbed: String::new(),
            hits: Vec::new(),
            vault_map: Vec::new(),
        };
    }

    static RE_PEM: OnceLock<Regex> = OnceLock::new();
    static RE_API_KEY: OnceLock<Regex> = OnceLock::new();
    static RE_DB_URI: OnceLock<Regex> = OnceLock::new();
    static RE_URL_TOKEN: OnceLock<Regex> = OnceLock::new();
    static RE_INLINE_CRED: OnceLock<Regex> = OnceLock::new();
    static RE_ID_CARD: OnceLock<Regex> = OnceLock::new();
    static RE_BANK_CARD: OnceLock<Regex> = OnceLock::new();
    static RE_PHONE: OnceLock<Regex> = OnceLock::new();
    static RE_OTP_PHRASE: OnceLock<Regex> = OnceLock::new();

    let re_pem = RE_PEM.get_or_init(|| {
        Regex::new(r"(?s)-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----").unwrap()
    });
    let re_api_key = RE_API_KEY.get_or_init(|| {
        Regex::new(r"\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{18,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{24,}|glpat-[A-Za-z0-9_-]{18,}|xox[baprs]-[A-Za-z0-9-]{16,})\b").unwrap()
    });
    let re_db_uri = RE_DB_URI.get_or_init(|| {
        Regex::new(r"(?i)\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis)://[^:\s/]+:[^@\s]{3,}@[^\s<>]+").unwrap()
    });
    let re_url_token = RE_URL_TOKEN.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:token|access_token|auth_token|reset_token|code|secret|signature|sig|api_key|apikey|jwt)=)([^&\s#<>'\x22]{6,})").unwrap()
    });
    let re_inline_cred = RE_INLINE_CRED.get_or_init(|| {
        Regex::new(r"(?i)((?:密码|授权码|登录口令|访问密钥|password|passcode|api[\s_-]*secret)\s*(?:为|是|:|：|=)\s*)([^\s,，。;；<>'\x22]{4,48})").unwrap()
    });
    let re_id_card = RE_ID_CARD.get_or_init(|| {
        Regex::new(r"(?:^|[^\d])([1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?:$|[^\d])").unwrap()
    });
    let re_bank_card = RE_BANK_CARD.get_or_init(|| {
        Regex::new(r"(?:^|[^\d])((?:62|4\d|5[1-5])\d{2}(?:[-\s]?\d{4}){3}\d{0,3})(?:$|[^\d])").unwrap()
    });
    let re_phone = RE_PHONE.get_or_init(|| {
        Regex::new(r"(?:^|[^\d])((?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})(?:$|[^\d])").unwrap()
    });
    let re_otp_phrase = RE_OTP_PHRASE.get_or_init(|| {
        Regex::new(r"(?i)((?:验证码|校验码|动态码|确认码|取件码|verification\s*code|login\s*code|otp)\s*(?:为|是|:|：|is)?\s*[\[【\s]*)([0-9]{4,8})([\]】]?)").unwrap()
    });

    let mut text = input.to_string();
    let mut hits: Vec<RedactionHit> = Vec::new();
    let mut vault_map: Vec<(String, String)> = Vec::new();
    let mut seq: usize = 0;

    let mut alloc_token = |tag: &str, kind_label: &str, raw_val: &str| -> String {
        if let Some((existing_ph, _)) = vault_map.iter().find(|(_, v)| v == raw_val) {
            return existing_ph.clone();
        }
        seq += 1;
        let ph = format!("{{{{MC_{tag}_{seq}}}}}");
        hits.push(RedactionHit {
            placeholder: ph.clone(),
            kind_label: kind_label.to_string(),
            masked_preview: mask_sensitive_preview(raw_val),
        });
        vault_map.push((ph.clone(), raw_val.to_string()));
        ph
    };

    // 1. 强制安全层：私钥块、API Key、数据库连接串、URL 令牌、显式口令
    text = re_pem
        .replace_all(&text, |caps: &regex::Captures| {
            alloc_token("PRIVKEY", "私钥证书块", &caps[0])
        })
        .into_owned();

    text = re_api_key
        .replace_all(&text, |caps: &regex::Captures| {
            alloc_token("SECRET", "API 密钥", &caps[0])
        })
        .into_owned();

    text = re_db_uri
        .replace_all(&text, |caps: &regex::Captures| {
            alloc_token("DBURI", "含密连接串", &caps[0])
        })
        .into_owned();

    text = re_url_token
        .replace_all(&text, |caps: &regex::Captures| {
            let ph = alloc_token("URLTOK", "链接鉴权令牌", &caps[2]);
            format!("{}{}", &caps[1], ph)
        })
        .into_owned();

    text = re_inline_cred
        .replace_all(&text, |caps: &regex::Captures| {
            let candidate = caps[2].trim();
            if candidate.starts_with("{{MC_") {
                return caps[0].to_string();
            }
            let ph = alloc_token("CRED", "口令/授权码", candidate);
            format!("{}{}", &caps[1], ph)
        })
        .into_owned();

    // 2. PII 个人隐私层：自定义敏感词、身份证、银行卡、手机号、动态码
    if redact_pii {
        for term in custom_terms {
            let clean_term = term.trim();
            if clean_term.chars().count() < 2 || clean_term.starts_with("{{MC_") {
                continue;
            }
            if text.contains(clean_term) {
                let ph = alloc_token("CUSTOM", "自定义隐私词", clean_term);
                text = text.replace(clean_term, &ph);
            }
        }

        text = re_otp_phrase
            .replace_all(&text, |caps: &regex::Captures| {
                let ph = alloc_token("OTP", "动态验证码", &caps[2]);
                format!("{}{}{}", &caps[1], ph, &caps[3])
            })
            .into_owned();

        // 身份证先于银行卡与手机号匹配，避免 18 位身份证中的数字子串被误拆
        text = replace_bounded_group(&text, re_id_card, |raw| {
            alloc_token("IDCARD", "身份证号", raw)
        });

        text = replace_bounded_group(&text, re_bank_card, |raw| {
            let digits_count = raw.chars().filter(|c| c.is_ascii_digit()).count();
            if (16..=19).contains(&digits_count) {
                Some(alloc_token("BANK", "银行卡号", raw))
            } else {
                None
            }
        });

        text = replace_bounded_group(&text, re_phone, |raw| {
            alloc_token("PHONE", "手机号码", raw)
        });
    }

    ScrubResult {
        scrubbed: text,
        hits,
        vault_map,
    }
}

fn replace_bounded_group<F, R>(text: &str, re: &Regex, mut make_ph: F) -> String
where
    F: FnMut(&str) -> R,
    R: Into<Option<String>>,
{
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in re.captures_iter(text) {
        let Some(m_inner) = caps.get(1) else {
            continue;
        };
        if m_inner.start() < last {
            continue;
        }
        if let Some(ph) = make_ph(m_inner.as_str()).into() {
            out.push_str(&text[last..m_inner.start()]);
            out.push_str(&ph);
            last = m_inner.end();
        }
    }
    out.push_str(&text[last..]);
    out
}

/// 在写信工坊中将模型生成的 HTML / 文本内的盲脱敏占位符在本地内存中还原为原始文本（仅限用户自己输入的草稿，绝不外发）
pub fn restore_placeholders(text: &str, vault_map: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (ph, raw_val) in vault_map {
        if out.contains(ph) {
            out = out.replace(ph, raw_val);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OutboundDlpResult {
    pub passed: bool,
    pub findings: Vec<String>,
}

/// 发信前出站 DLP 安全检查：阻断原始 API 密钥、私钥证书块、带密码数据库连接串，以及未还原的隐私占位符外泄
pub fn check_outbound_dlp(
    subject: &str,
    plain_body: &str,
    html_body: &str,
    forbid_placeholders: bool,
) -> OutboundDlpResult {
    static RE_SECRET: OnceLock<Regex> = OnceLock::new();
    static RE_PEM: OnceLock<Regex> = OnceLock::new();
    static RE_DB: OnceLock<Regex> = OnceLock::new();
    static RE_PLACEHOLDER: OnceLock<Regex> = OnceLock::new();

    let re_secret = RE_SECRET.get_or_init(|| {
        Regex::new(r"\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{18,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{24,}|glpat-[A-Za-z0-9_-]{18,})\b").unwrap()
    });
    let re_pem = RE_PEM.get_or_init(|| {
        Regex::new(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----").unwrap()
    });
    let re_db = RE_DB.get_or_init(|| {
        Regex::new(r"(?i)\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis)://[^:\s/]+:[^@\s]{4,}@").unwrap()
    });
    let re_ph = RE_PLACEHOLDER.get_or_init(|| {
        Regex::new(r"\{\{MC_[A-Z]+_\d+\}\}|\[REDACTED_[A-Z_0-9]+\]").unwrap()
    });

    let combined = format!("{subject}\n{plain_body}\n{html_body}");
    let mut findings = Vec::new();

    if re_secret.is_match(&combined) {
        findings.push("检测到疑似云平台或大模型 API Key 明文 (sk-* / AIza* / AKIA* / ghp_*)".into());
    }
    if re_pem.is_match(&combined) {
        findings.push("检测到 PEM 私钥证书块 (PRIVATE KEY)".into());
    }
    if re_db.is_match(&combined) {
        findings.push("检测到包含明文密码的数据库连接串".into());
    }
    if forbid_placeholders && re_ph.is_match(&combined) {
        findings.push("检测到未替换的隐私脱敏占位符 ({{MC_*}})，请人工核对后再发送".into());
    }

    OutboundDlpResult {
        passed: findings.is_empty(),
        findings,
    }
}

/// 服务端出站 HTML 安全净化：剥离 `<script>` / `<iframe>` / `<form>` / `<object>` 与内联 `on*` 事件处理器及 `javascript:` 协议
pub fn sanitize_outgoing_html(raw_html: &str) -> String {
    if raw_html.trim().is_empty() {
        return String::new();
    }
    static RE_BAD_BLOCKS: OnceLock<Regex> = OnceLock::new();
    static RE_BAD_SELF: OnceLock<Regex> = OnceLock::new();
    static RE_ON_EVENTS: OnceLock<Regex> = OnceLock::new();
    static RE_JS_URI: OnceLock<Regex> = OnceLock::new();

    let bad_blocks = RE_BAD_BLOCKS.get_or_init(|| {
        Regex::new(r"(?is)<(script|iframe|frame|frameset|object|embed|applet|form)[^>]*>.*?</(script|iframe|frame|frameset|object|embed|applet|form)>").unwrap()
    });
    let bad_self = RE_BAD_SELF.get_or_init(|| {
        Regex::new(r"(?i)</?(?:script|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|base|portal)\b[^>]*>").unwrap()
    });
    let on_events = RE_ON_EVENTS.get_or_init(|| {
        Regex::new(r#"(?i)\s+on[a-z0-9_]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#).unwrap()
    });
    let js_uri = RE_JS_URI.get_or_init(|| {
        Regex::new(r#"(?i)\b(href|src|action)\s*=\s*(['"]?)\s*(?:javascript|vbscript|data:text/html):[^'">\s]*(['"]?)"#).unwrap()
    });

    let s = bad_blocks.replace_all(raw_html, "");
    let s = bad_self.replace_all(&s, "");
    let s = on_events.replace_all(&s, "");
    let s = js_uri.replace_all(&s, "$1=$2#$3");
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_isolates_unlisted_accounts_and_blocks_sensitive_mails() {
        let mut policy = ReplyPolicySpec::default();
        policy.enabled = true;
        policy.enabled_accounts = vec!["work@nebula-studio.cn".into()];
        let policy = normalize_policy(&policy);

        // 未授权账号必须被隔离禁读
        let v1 = evaluate_read_access(
            &policy,
            "personal@qq.com",
            false,
            "inbox",
            "friend@qq.com",
            "周末聚餐",
            "个人",
            "",
            "周六有空吗",
        );
        assert!(matches!(v1, ReadAccessVerdict::Denied { ref code, .. } if code == "account_isolated"));

        // 拦截槽硬性禁读
        let v2 = evaluate_read_access(
            &policy,
            "work@nebula-studio.cn",
            false,
            "blocked",
            "spam@mall.com",
            "优惠",
            "营销",
            "",
            "点此领券",
        );
        assert!(matches!(v2, ReadAccessVerdict::Denied { ref code, .. } if code == "blocked_slot"));

        // 含验证码邮件硬性禁读
        let v3 = evaluate_read_access(
            &policy,
            "work@nebula-studio.cn",
            false,
            "inbox",
            "security@github.com",
            "Your login code",
            "安全",
            "839201",
            "Code is 839201",
        );
        assert!(matches!(v3, ReadAccessVerdict::Denied { ref code, .. } if code == "sensitive_mail"));

        // no-reply 自动跳过
        let v4 = evaluate_read_access(
            &policy,
            "work@nebula-studio.cn",
            false,
            "inbox",
            "no-reply@service.com",
            "构建成功通知",
            "工作",
            "",
            "CI passed",
        );
        assert!(matches!(v4, ReadAccessVerdict::Denied { ref code, .. } if code == "no_reply_sender"));

        // 合规工作来信放行
        let v5 = evaluate_read_access(
            &policy,
            "work@nebula-studio.cn",
            false,
            "inbox",
            "client@partner.com",
            "关于 v2.5 接口联调排期",
            "工作",
            "",
            "下周二下午方便对齐一下接口字段吗？",
        );
        assert_eq!(v5, ReadAccessVerdict::Allowed);
    }

    #[test]
    fn scrubs_pii_and_secrets_and_supports_roundtrip_restore() {
        let raw = "你好，我的手机号是 13812345678，身份证 31010119920518231X，收款卡号 6222021234567890123，测试密钥 sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234，重置链接 https://app.example.com/reset?token=eyJhbGciOiJIUzI1NiJ9abcdef&lang=zh ，内部代号 ProjectTitan。";
        let res = scrub_text_with_vault(raw, true, &["ProjectTitan".to_string()]);

        assert!(!res.scrubbed.contains("13812345678"));
        assert!(!res.scrubbed.contains("31010119920518231X"));
        assert!(!res.scrubbed.contains("6222021234567890123"));
        assert!(!res.scrubbed.contains("sk-proj-AbCdEf"));
        assert!(!res.scrubbed.contains("eyJhbGciOiJIUzI1NiJ9abcdef"));
        assert!(!res.scrubbed.contains("ProjectTitan"));
        assert!(res.scrubbed.contains("{{MC_PHONE_"));
        assert!(res.scrubbed.contains("{{MC_IDCARD_"));
        assert!(res.scrubbed.contains("{{MC_BANK_"));
        assert!(res.scrubbed.contains("{{MC_SECRET_"));
        assert!(res.scrubbed.contains("{{MC_URLTOK_"));
        assert!(res.scrubbed.contains("{{MC_CUSTOM_"));

        // 审计掩码绝不保存明文
        for h in &res.hits {
            assert!(h.masked_preview.contains("****"));
            assert!(!h.masked_preview.contains("13812345678"));
        }

        // 写信工坊盲脱敏后本地无损还原
        let restored = restore_placeholders(&res.scrubbed, &res.vault_map);
        assert_eq!(restored, raw);
    }

    #[test]
    fn permission_tiers_and_outbound_dlp_guard_work() {
        let mut p = ReplyPolicySpec::default();
        p.auto_send_enabled = true;
        p.auto_send_senders = vec!["vip@partner.com".into()];
        p.auto_send_hourly_limit = 2;
        let p = normalize_policy(&p);

        assert_eq!(
            evaluate_send_permission(&p, "vip@partner.com", 1),
            PermissionVerdict::WhitelistedAutoSend
        );
        assert!(matches!(
            evaluate_send_permission(&p, "vip@partner.com", 2),
            PermissionVerdict::DraftReview { .. }
        ));
        assert!(matches!(
            evaluate_send_permission(&p, "other@partner.com", 0),
            PermissionVerdict::DraftReview { .. }
        ));

        let dlp_bad = check_outbound_dlp(
            "Re: 联调",
            "这是密钥 sk-1234567890abcdefghijkl 和 {{MC_PHONE_1}}",
            "",
            true,
        );
        assert!(!dlp_bad.passed);
        assert_eq!(dlp_bad.findings.len(), 2);

        let clean_html = sanitize_outgoing_html(
            r#"<div onclick="alert(1)"><a href="javascript:evil()">点此</a><script>evil()</script><p>正文</p></div>"#,
        );
        assert!(!clean_html.contains("script"));
        assert!(!clean_html.contains("onclick"));
        assert!(!clean_html.contains("javascript:"));
        assert!(clean_html.contains("<p>正文</p>"));
    }

    #[test]
    fn auto_reply_rule_matching_and_anti_loop_work() {
        let mut p = ReplyPolicySpec::default();
        p.enabled = true;
        p.enabled_accounts = vec!["work@company.com".into()];
        p.auto_rules = vec![
            AutoReplyRuleSpec {
                id: "quote".into(),
                name: "合作询价秒回".into(),
                enabled: true,
                accounts: vec!["work@company.com".into()],
                match_senders: Vec::new(),
                match_domains: vec!["partner.com".into()],
                match_keywords: vec!["报价".into(), "排期".into()],
                mode: "ai".into(),
                instructions_or_template: "礼貌确认收到询价，承诺2小时内详复".into(),
                template_html: String::new(),
                require_review: false,
                cooldown_minutes: 60,
            },
            AutoReplyRuleSpec {
                id: "vacation".into(),
                name: "休假自动告知".into(),
                enabled: true,
                accounts: vec!["work@company.com".into()],
                match_senders: Vec::new(),
                match_domains: Vec::new(),
                match_keywords: Vec::new(),
                mode: "template".into(),
                instructions_or_template: "您好，我目前正在休假，紧急事务请联系值班同事。".into(),
                template_html: String::new(),
                require_review: false,
                cooldown_minutes: 120,
            },
        ];
        let p = normalize_policy(&p);

        // 命中高优先级精准规则（域名 + 关键词）
        let m1 = match_auto_reply_rule(
            &p,
            "work@company.com",
            "alice@partner.com",
            "关于 Q4 定制方案报价咨询",
            "请发一份报价单",
        );
        assert_eq!(m1.map(|r| r.id.as_str()), Some("quote"));

        // 其他常规发件人落入休假兜底规则
        let m2 = match_auto_reply_rule(
            &p,
            "work@company.com",
            "bob@other.org",
            "明天会议沟通",
            "下午有空吗",
        );
        assert_eq!(m2.map(|r| r.id.as_str()), Some("vacation"));

        // no-reply 系统地址绝不触发自动回复（防死循环）
        let m3 = match_auto_reply_rule(
            &p,
            "work@company.com",
            "no-reply@partner.com",
            "报价通知",
            "自动通知",
        );
        assert!(m3.is_none());
    }
}
