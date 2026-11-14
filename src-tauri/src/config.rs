//! 声明式配置引擎（config.toml）：
//! - 非敏感业务配置（邮箱服务器、模型选择与指令、确定性分流规则、群聊拓扑）全部统一为人类与 Agent 均可读写的 TOML 声明式配置。
//! - 密码与 API Key 绝不落入 config.toml，仅通过 `secret:<key>` 引用本地 DPAPI 隐私保险箱。

use crate::db::{Account, AgentConfig, Db, GroupMember, ProviderProfile};
use crate::vault::{llm_secret_key, mail_secret_key, secret_label, Vault};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConfigDiffItem {
    /// 模块标识: "accounts" | "agent" | "triage" | "groups" | "vault"
    pub section: String,
    /// 模块中文标题
    pub section_label: String,
    /// 可视化表单锚点标识，如 "account:wokao@111.com" / "agent.model" / "triage.block_keywords"
    pub target_key: String,
    /// 变更类型: "added" | "modified" | "removed"
    pub kind: String,
    /// 具体修改项中文标签
    pub field_label: String,
    /// 修改前的值描述
    pub before: String,
    /// 修改后的值描述
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConfigDiffReport {
    #[serde(default)]
    pub items: Vec<ConfigDiffItem>,
    #[serde(default)]
    pub before_toml: String,
    #[serde(default)]
    pub after_toml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeclarativeConfig {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub active_account: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<AccountSpec>,
    /// 兼容旧版单账号 `[account]` 声明式段落，加载后自动升级为 `active_account` + `[[accounts]]`
    #[serde(default, skip_serializing)]
    pub account: Option<AccountSpec>,
    #[serde(default)]
    pub agent: AgentSpec,
    #[serde(default)]
    pub triage: TriageSpec,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<GroupSpec>,
}

impl DeclarativeConfig {
    /// 合并 `[[accounts]]` 与旧版 `[account]`，返回去重后的有效账号声明列表
    pub fn effective_accounts(&self) -> Vec<AccountSpec> {
        let mut out: Vec<AccountSpec> = Vec::new();
        for a in &self.accounts {
            let em = a.email.trim().to_lowercase();
            if em.is_empty() {
                continue;
            }
            if let Some(existing) = out.iter_mut().find(|x| x.email.trim().eq_ignore_ascii_case(&em)) {
                *existing = a.clone();
            } else {
                out.push(a.clone());
            }
        }
        if let Some(legacy) = &self.account {
            let em = legacy.email.trim().to_lowercase();
            if !em.is_empty() && !out.iter().any(|x| x.email.trim().eq_ignore_ascii_case(&em)) {
                out.push(legacy.clone());
            }
        }
        out
    }

    /// 返回当前激活账号声明（若未指定则回退第一个账号）
    pub fn primary_account(&self) -> Option<AccountSpec> {
        let list = self.effective_accounts();
        if list.is_empty() {
            return None;
        }
        let target = self.active_account.trim().to_lowercase();
        if !target.is_empty() {
            if let Some(found) = list.iter().find(|a| a.email.trim().eq_ignore_ascii_case(&target)) {
                return Some(found.clone());
            }
        }
        list.into_iter().next()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountSpec {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
    #[serde(default = "default_mail_secret_ref")]
    pub password_ref: String,
}

impl Default for AccountSpec {
    fn default() -> Self {
        Self {
            email: String::new(),
            display_name: String::new(),
            username: String::new(),
            imap_host: String::new(),
            imap_port: 993,
            smtp_host: String::new(),
            smtp_port: 465,
            password_ref: default_mail_secret_ref(),
        }
    }
}

fn default_imap_port() -> u16 {
    993
}
fn default_smtp_port() -> u16 {
    465
}
fn default_mail_secret_ref() -> String {
    "secret:mail_password".into()
}
fn default_true() -> bool {
    true
}
fn default_preset() -> String {
    "deepseek".into()
}
fn default_provider() -> String {
    "openai".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileSpec {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key_ref: String,
    #[serde(default = "default_true")]
    pub auto_draft: bool,
    #[serde(default)]
    pub auto_block_sender: bool,
    #[serde(default)]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub profiles: BTreeMap<String, ProfileSpec>,
}

impl Default for AgentSpec {
    fn default() -> Self {
        let def = AgentConfig::default();
        Self {
            enabled: def.enabled,
            preset: def.preset,
            provider: def.provider,
            base_url: def.base_url,
            model: def.model,
            api_key_ref: "secret:llm_deepseek".into(),
            auto_draft: def.auto_draft,
            auto_block_sender: def.auto_block_sender,
            instructions: def.instructions,
            profiles: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TriageSpec {
    #[serde(default)]
    pub allow_senders: Vec<String>,
    #[serde(default)]
    pub block_senders: Vec<String>,
    #[serde(default)]
    pub block_domains: Vec<String>,
    #[serde(default)]
    pub block_keywords: Vec<String>,
    #[serde(default)]
    pub archive_senders: Vec<String>,
    #[serde(default)]
    pub archive_keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub members: Vec<GroupMember>,
}

/// 主流邮箱域名默认服务器参数
pub fn mail_domain_defaults(email: &str) -> Option<(&'static str, u16, &'static str, u16)> {
    let domain = email.trim().split('@').nth(1)?.to_lowercase();
    match domain.as_str() {
        "qq.com" | "foxmail.com" => Some(("imap.qq.com", 993, "smtp.qq.com", 465)),
        "163.com" => Some(("imap.163.com", 993, "smtp.163.com", 465)),
        "126.com" => Some(("imap.126.com", 993, "smtp.126.com", 465)),
        "yeah.net" => Some(("imap.yeah.net", 993, "smtp.yeah.net", 465)),
        "gmail.com" => Some(("imap.gmail.com", 993, "smtp.gmail.com", 465)),
        "outlook.com" | "hotmail.com" | "live.com" => Some(("outlook.office365.com", 993, "smtp.office365.com", 587)),
        "icloud.com" | "me.com" => Some(("imap.mail.me.com", 993, "smtp.mail.me.com", 587)),
        "aliyun.com" => Some(("imap.aliyun.com", 993, "smtp.aliyun.com", 465)),
        _ => None,
    }
}

/// 主流模型预设默认连接参数：(provider, base_url, default_model)
/// 首选推荐接入：DeepSeek 官网、OpenCode Go、Ollama 远程订阅（均默认搭载 deepseek-v4.1-flash）
pub fn model_preset_defaults(preset: &str) -> (&'static str, &'static str, &'static str) {
    match preset.trim().to_lowercase().as_str() {
        "deepseek" => ("openai", "https://api.deepseek.com/v1", "deepseek-v4.1-flash"),
        "opencode_go" => ("openai", "https://opencode.ai/inference/go/openai/v1", "deepseek-v4.1-flash"),
        "ollama_cloud" => ("openai", "https://ollama.com/v1", "deepseek-v4.1-flash"),
        "ollama_remote" => ("openai", "http://192.168.1.100:11434/v1", "qwen2.5:7b"),
        "ollama" => ("openai", "http://localhost:11434/v1", "qwen2.5:7b"),
        "qwen" => ("openai", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
        "openai" => ("openai", "https://api.openai.com/v1", "gpt-4o-mini"),
        "anthropic" => ("anthropic", "https://api.anthropic.com", "claude-sonnet-4-20250514"),
        "gemini" => ("gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-flash"),
        "kimi" => ("openai", "https://api.moonshot.cn/v1", "kimi-k2-0711-preview"),
        "siliconflow" => ("openai", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct"),
        _ => ("openai", "", ""),
    }
}

/// 启动时将旧版本可能存放在 SQLite 中的明文密码、单账号 `mail_password` 凭据和 API Key 自动迁移至多账号 DPAPI 保险箱
pub fn migrate_legacy_secrets(db: &Db, vault: &Vault) {
    if let Ok(mut list) = db.list_accounts() {
        let mut had_plaintext = false;
        for acc in &mut list {
            if !acc.password.trim().is_empty() {
                let sk = mail_secret_key(&acc.email);
                let _ = vault.set(&sk, &acc.password);
                acc.password.clear();
                had_plaintext = true;
            }
        }
        if had_plaintext {
            let active = db.active_account_email().unwrap_or_default();
            let _ = db.replace_accounts(&list, &active);
        }
        if let Some(legacy_pw) = vault.get("mail_password") {
            let active = db.active_account_email().unwrap_or_default();
            let target_email = if !active.is_empty() {
                active
            } else {
                list.first().map(|a| a.email.clone()).unwrap_or_default()
            };
            if !target_email.is_empty() {
                let sk = mail_secret_key(&target_email);
                if vault.get(&sk).is_none() {
                    let _ = vault.set(&sk, &legacy_pw);
                }
                let _ = vault.delete("mail_password");
            }
        }
    }

    if let Ok(mut cfg) = db.agent_config() {
        let mut dirty = false;
        if !cfg.api_key.trim().is_empty() {
            if let Some(sk) = llm_secret_key(&cfg.preset) {
                let _ = vault.set(sk, &cfg.api_key);
            }
            cfg.api_key.clear();
            dirty = true;
        }
        for (preset, prof) in cfg.profiles.iter_mut() {
            if !prof.api_key.trim().is_empty() {
                if let Some(sk) = llm_secret_key(preset) {
                    let _ = vault.set(sk, &prof.api_key);
                }
                prof.api_key.clear();
                dirty = true;
            }
        }
        if dirty {
            let _ = db.save_agent_config(&cfg);
        }
    }
}

/// 组装指定邮箱账号的完整连接凭据（从独立 DPAPI 保险箱注入该账号专属密码）
pub fn hydrated_account_for(db: &Db, vault: &Vault, email: &str) -> Result<Option<Account>> {
    let Some(mut acc) = db.account_by_email(email)? else {
        return Ok(None);
    };
    if acc.email.trim().is_empty() {
        return Ok(None);
    }
    let sk = mail_secret_key(&acc.email);
    acc.password = vault.get(&sk).unwrap_or_default();
    if acc.password.is_empty() && db.list_accounts().map(|l| l.len() <= 1).unwrap_or(false) {
        acc.password = vault.get("mail_password").unwrap_or_default();
    }
    Ok(Some(acc))
}

/// 组装当前激活邮箱供 IMAP / SMTP 实际连接使用的完整账号（从隐私保险箱注入对应密码）
pub fn hydrated_account(db: &Db, vault: &Vault) -> Result<Option<Account>> {
    let active = db.active_account_email()?;
    if active.is_empty() {
        return Ok(None);
    }
    hydrated_account_for(db, vault, &active)
}

/// 组装供大模型调用使用的完整 AgentConfig（从隐私保险箱注入对应服务商 API Key）
pub fn hydrated_agent(db: &Db, vault: &Vault) -> Result<AgentConfig> {
    let mut cfg = db.agent_config()?;
    cfg.api_key = llm_secret_key(&cfg.preset)
        .and_then(|k| vault.get(k))
        .unwrap_or_default();
    Ok(cfg)
}

/// 从当前数据库状态导出无敏感信息的声明式结构
pub fn build_spec(db: &Db) -> Result<DeclarativeConfig> {
    let active_account = db.active_account_email()?;
    let accounts: Vec<AccountSpec> = db
        .list_accounts()?
        .into_iter()
        .map(|a| {
            let sk = mail_secret_key(&a.email);
            AccountSpec {
                email: a.email,
                display_name: a.display_name,
                username: a.username,
                imap_host: a.imap_host,
                imap_port: a.imap_port,
                smtp_host: a.smtp_host,
                smtp_port: a.smtp_port,
                password_ref: format!("secret:{sk}"),
            }
        })
        .collect();

    let ag = db.agent_config()?;
    let api_key_ref = llm_secret_key(&ag.preset)
        .map(|k| format!("secret:{k}"))
        .unwrap_or_else(|| "none (local)".into());
    let mut profiles = BTreeMap::new();
    for (k, v) in ag.profiles {
        if !v.base_url.is_empty() || !v.model.is_empty() {
            profiles.insert(
                k,
                ProfileSpec {
                    base_url: v.base_url,
                    model: v.model,
                },
            );
        }
    }
    let agent = AgentSpec {
        enabled: ag.enabled,
        preset: ag.preset,
        provider: ag.provider,
        base_url: ag.base_url,
        model: ag.model,
        api_key_ref,
        auto_draft: ag.auto_draft,
        auto_block_sender: ag.auto_block_sender,
        instructions: ag.instructions,
        profiles,
    };

    let mut triage = TriageSpec::default();
    let mut rules = db.rules()?;
    rules.reverse();
    for r in rules {
        match r.kind.as_str() {
            "allow_sender" => triage.allow_senders.push(r.pattern),
            "block_sender" => triage.block_senders.push(r.pattern),
            "block_domain" => triage.block_domains.push(r.pattern),
            "block_keyword" => triage.block_keywords.push(r.pattern),
            "archive_sender" => triage.archive_senders.push(r.pattern),
            "archive_keyword" => triage.archive_keywords.push(r.pattern),
            _ => {}
        }
    }

    let groups = db
        .list_groups()?
        .into_iter()
        .map(|g| GroupSpec {
            id: g.peer.trim_start_matches("group:").to_string(),
            name: g.name,
            muted: g.muted,
            members: g.members,
        })
        .collect();

    Ok(DeclarativeConfig {
        active_account,
        accounts,
        account: None,
        agent,
        triage,
        groups,
    })
}

pub fn export_toml(db: &Db) -> Result<String> {
    let spec = build_spec(db)?;
    let body = toml::to_string_pretty(&spec).context("序列化声明式配置失败")?;
    Ok(format!(
        "# MailChat 声明式配置文件 (config.toml)\n\
         # 提示：可通过「AI 助手」自然语言对话修改，也可直接编辑本声明式文本后应用。\n\
         # 隐私隔离：邮箱授权码与 API Key 独立加密存储于系统 DPAPI 保险箱，此处仅保留 secret:* 引用。\n\n\
         {body}"
    ))
}

pub fn sync_disk_toml(app_dir: &Path, db: &Db) -> Result<String> {
    let text = export_toml(db)?;
    let _ = std::fs::write(app_dir.join("config.toml"), &text);
    Ok(text)
}

/// 解析、校验并原子应用声明式 TOML 配置；兼容单账号 `[account]` 与多账号 `[[accounts]]`，自动收纳误填明文凭据
pub fn apply_toml(app_dir: &Path, toml_str: &str, db: &Db, vault: &Vault) -> Result<String> {
    let spec: DeclarativeConfig =
        toml::from_str(toml_str).context("声明式 TOML 语法解析失败，请检查括号、引号或字段类型")?;
    apply_spec(app_dir, &spec, db, vault)
}

/// 原子应用结构化声明式配置（供可视化表单与 TOML 引擎共用）
pub fn apply_spec(app_dir: &Path, spec: &DeclarativeConfig, db: &Db, vault: &Vault) -> Result<String> {
    // 1. 多邮箱账号声明（无缝兼容旧版 [account]）
    let raw_accounts = spec.effective_accounts();
    let prev_active = db.active_account_email().unwrap_or_default();
    let mut resolved_accounts: Vec<Account> = Vec::new();

    for acc_spec in &raw_accounts {
        let email = acc_spec.email.trim().to_lowercase();
        if email.is_empty() {
            continue;
        }
        let sk = mail_secret_key(&email);
        let pw_ref = acc_spec.password_ref.trim();
        if !pw_ref.is_empty() && !pw_ref.starts_with("secret:") && !pw_ref.starts_with("none") {
            // 若用户误在 password_ref 直接填了明文密码，自动转存入该账号独立 DPAPI Vault 槽位并擦除明文
            vault.set(&sk, pw_ref)?;
        } else if pw_ref == "secret:mail_password" && vault.get(&sk).is_none() {
            if let Some(legacy_pw) = vault.get("mail_password") {
                vault.set(&sk, &legacy_pw)?;
                let _ = vault.delete("mail_password");
            }
        }

        let defaults = mail_domain_defaults(&email);
        let imap_host = if !acc_spec.imap_host.trim().is_empty() {
            acc_spec.imap_host.trim().to_string()
        } else {
            defaults.map(|d| d.0.to_string()).unwrap_or_default()
        };
        let imap_port = if acc_spec.imap_port > 0 {
            acc_spec.imap_port
        } else {
            defaults.map(|d| d.1).unwrap_or(993)
        };
        let smtp_host = if !acc_spec.smtp_host.trim().is_empty() {
            acc_spec.smtp_host.trim().to_string()
        } else {
            defaults.map(|d| d.2.to_string()).unwrap_or_default()
        };
        let smtp_port = if acc_spec.smtp_port > 0 {
            acc_spec.smtp_port
        } else {
            defaults.map(|d| d.3).unwrap_or(465)
        };
        let username = if !acc_spec.username.trim().is_empty() {
            acc_spec.username.trim().to_string()
        } else {
            email.clone()
        };

        resolved_accounts.push(Account {
            email,
            display_name: acc_spec.display_name.trim().to_string(),
            imap_host,
            imap_port,
            smtp_host,
            smtp_port,
            username,
            password: String::new(),
        });
    }

    if resolved_accounts.is_empty() {
        db.clear_account()?;
    } else {
        let preferred_active = if !spec.active_account.trim().is_empty() {
            spec.active_account.trim().to_lowercase()
        } else if !prev_active.is_empty()
            && resolved_accounts.iter().any(|a| a.email == prev_active)
        {
            prev_active
        } else {
            resolved_accounts[0].email.clone()
        };
        db.replace_accounts(&resolved_accounts, &preferred_active)?;
    }

    let active_email = db.active_account_email()?;

    // 2. Agent 模型与行为声明
    let preset = if spec.agent.preset.trim().is_empty() {
        "deepseek".to_string()
    } else {
        spec.agent.preset.trim().to_lowercase()
    };
    let (def_provider, def_base, def_model) = model_preset_defaults(&preset);

    let key_ref = spec.agent.api_key_ref.trim();
    if !key_ref.is_empty() && !key_ref.starts_with("secret:") && !key_ref.starts_with("none") {
        if let Some(sk) = llm_secret_key(&preset) {
            vault.set(sk, key_ref)?;
        }
    }

    let provider = if !spec.agent.provider.trim().is_empty() {
        spec.agent.provider.trim().to_lowercase()
    } else {
        def_provider.to_string()
    };
    let base_url = if !spec.agent.base_url.trim().is_empty() {
        spec.agent.base_url.trim().to_string()
    } else {
        def_base.to_string()
    };
    let model = if !spec.agent.model.trim().is_empty() {
        spec.agent.model.trim().to_string()
    } else {
        def_model.to_string()
    };

    let mut profiles = std::collections::HashMap::new();
    for (k, v) in &spec.agent.profiles {
        profiles.insert(
            k.clone(),
            ProviderProfile {
                base_url: v.base_url.clone(),
                api_key: String::new(),
                model: v.model.clone(),
            },
        );
    }
    profiles.insert(
        preset.clone(),
        ProviderProfile {
            base_url: base_url.clone(),
            api_key: String::new(),
            model: model.clone(),
        },
    );

    db.save_agent_config(&AgentConfig {
        enabled: spec.agent.enabled,
        preset,
        provider,
        base_url,
        api_key: String::new(), // 永不在数据库存明文 API Key
        model,
        instructions: if spec.agent.instructions.trim().is_empty() {
            AgentConfig::default().instructions
        } else {
            spec.agent.instructions.trim().to_string()
        },
        auto_draft: spec.agent.auto_draft,
        auto_block_sender: spec.agent.auto_block_sender,
        profiles,
    })?;

    // 3. 确定性分流规则声明
    let mut flat_rules: Vec<(String, String)> = Vec::new();
    for s in &spec.triage.allow_senders {
        flat_rules.push(("allow_sender".into(), s.clone()));
    }
    for s in &spec.triage.block_senders {
        flat_rules.push(("block_sender".into(), s.clone()));
    }
    for s in &spec.triage.block_domains {
        flat_rules.push(("block_domain".into(), s.clone()));
    }
    for s in &spec.triage.block_keywords {
        flat_rules.push(("block_keyword".into(), s.clone()));
    }
    for s in &spec.triage.archive_senders {
        flat_rules.push(("archive_sender".into(), s.clone()));
    }
    for s in &spec.triage.archive_keywords {
        flat_rules.push(("archive_keyword".into(), s.clone()));
    }
    db.replace_rules(&flat_rules)?;

    // 4. 当前激活账号的群聊声明对账
    let me = if active_email.is_empty() {
        "me@mailchat.local"
    } else {
        &active_email
    };
    for g in &spec.groups {
        if g.members.is_empty() {
            continue;
        }
        let clean_id = g.id.trim().trim_start_matches("group:");
        if clean_id.is_empty() {
            continue;
        }
        let peer = format!("group:{clean_id}");
        let prev_muted = db.get_group(&peer)?.map(|x| x.muted);
        if prev_muted.is_some() {
            let _ = db.update_group(&peer, &g.name, &g.members, g.muted, me);
        } else {
            let _ = db.upsert_group(&peer, &g.name, &g.members, me, clean_id.starts_with("demo-"));
            if g.muted {
                let _ = db.update_group(&peer, &g.name, &g.members, true, me);
            }
        }
        if prev_muted != Some(g.muted) {
            let _ = db.move_peer(&peer, if g.muted { "archived" } else { "inbox" });
        }
    }

    sync_disk_toml(app_dir, db)
}

fn preset_readable_name(preset: &str) -> &'static str {
    match preset.trim().to_lowercase().as_str() {
        "deepseek" => "DeepSeek 官网",
        "opencode_go" => "OpenCode Go",
        "ollama_cloud" => "Ollama 远程订阅",
        "ollama_remote" => "Ollama 自建远程",
        "ollama" => "本地 Ollama",
        "qwen" => "通义千问 Qwen",
        "openai" => "OpenAI",
        "anthropic" => "Anthropic Claude",
        "gemini" => "Google Gemini",
        "kimi" => "Moonshot Kimi",
        "siliconflow" => "硅基流动",
        "custom" => "自定义网关",
        _ => "模型预设",
    }
}

fn bool_label(v: bool) -> &'static str {
    if v {
        "开启"
    } else {
        "关闭"
    }
}

fn val_or(s: &str, empty_fallback: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        empty_fallback.to_string()
    } else {
        t.to_string()
    }
}

fn short_text(s: &str, max_chars: usize) -> String {
    let single = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.is_empty() {
        return "（空）".to_string();
    }
    let count = single.chars().count();
    if count <= max_chars {
        single
    } else {
        let head: String = single.chars().take(max_chars).collect();
        format!("{head}…")
    }
}

/// 精确计算修改前后两份 `DeclarativeConfig` 的结构化字段差异，供对话变更卡片与可视化表单高亮定位使用
pub fn diff_specs(
    before: &DeclarativeConfig,
    after: &DeclarativeConfig,
    before_toml: &str,
    after_toml: &str,
    intercepted_secret: Option<&str>,
) -> ConfigDiffReport {
    let mut items: Vec<ConfigDiffItem> = Vec::new();

    // 0. 本地加密保险箱凭据拦截
    if let Some(sk) = intercepted_secret.map(str::trim).filter(|s| !s.is_empty()) {
        items.push(ConfigDiffItem {
            section: "vault".into(),
            section_label: "隐私保险箱".into(),
            target_key: format!("vault:{sk}"),
            kind: "modified".into(),
            field_label: secret_label(sk),
            before: "明文凭据（本地已拦截）".into(),
            after: format!("已加密存入 secret:{sk}"),
        });
    }

    // 1. 邮箱账号对比
    let b_accs = before.effective_accounts();
    let a_accs = after.effective_accounts();

    for acc in &a_accs {
        let em = acc.email.trim().to_lowercase();
        let target_key = format!("account:{em}");
        if let Some(prev) = b_accs.iter().find(|x| x.email.trim().eq_ignore_ascii_case(&em)) {
            if prev.display_name.trim() != acc.display_name.trim() {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · 显示昵称", acc.email),
                    before: val_or(&prev.display_name, "未设置"),
                    after: val_or(&acc.display_name, "未设置"),
                });
            }
            let prev_user = if prev.username.trim().is_empty() {
                prev.email.trim()
            } else {
                prev.username.trim()
            };
            let next_user = if acc.username.trim().is_empty() {
                acc.email.trim()
            } else {
                acc.username.trim()
            };
            if prev_user != next_user {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · 登录用户名", acc.email),
                    before: val_or(prev_user, "未设置"),
                    after: val_or(next_user, "未设置"),
                });
            }
            if prev.imap_host.trim() != acc.imap_host.trim() {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · IMAP 服务器", acc.email),
                    before: val_or(&prev.imap_host, "未填写"),
                    after: val_or(&acc.imap_host, "未填写"),
                });
            }
            if prev.imap_port != acc.imap_port {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · IMAP 端口", acc.email),
                    before: prev.imap_port.to_string(),
                    after: acc.imap_port.to_string(),
                });
            }
            if prev.smtp_host.trim() != acc.smtp_host.trim() {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · SMTP 服务器", acc.email),
                    before: val_or(&prev.smtp_host, "未填写"),
                    after: val_or(&acc.smtp_host, "未填写"),
                });
            }
            if prev.smtp_port != acc.smtp_port {
                items.push(ConfigDiffItem {
                    section: "accounts".into(),
                    section_label: "邮箱账号".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("{} · SMTP 端口", acc.email),
                    before: prev.smtp_port.to_string(),
                    after: acc.smtp_port.to_string(),
                });
            }
        } else {
            let host_desc = if !acc.imap_host.trim().is_empty() || !acc.smtp_host.trim().is_empty() {
                format!(
                    "IMAP {}:{} · SMTP {}:{}",
                    val_or(&acc.imap_host, "未填"),
                    acc.imap_port,
                    val_or(&acc.smtp_host, "未填"),
                    acc.smtp_port
                )
            } else {
                "待补齐 IMAP / SMTP 服务器".to_string()
            };
            items.push(ConfigDiffItem {
                section: "accounts".into(),
                section_label: "邮箱账号".into(),
                target_key,
                kind: "added".into(),
                field_label: format!("新增邮箱 {}", acc.email),
                before: String::new(),
                after: host_desc,
            });
        }
    }

    for prev in &b_accs {
        let em = prev.email.trim().to_lowercase();
        if !a_accs.iter().any(|x| x.email.trim().eq_ignore_ascii_case(&em)) {
            items.push(ConfigDiffItem {
                section: "accounts".into(),
                section_label: "邮箱账号".into(),
                target_key: "accounts".into(),
                kind: "removed".into(),
                field_label: format!("解绑邮箱 {}", prev.email),
                before: format!("IMAP {}:{}", val_or(&prev.imap_host, "未填"), prev.imap_port),
                after: String::new(),
            });
        }
    }

    // 检查多账号相对顺序变更
    let b_common: Vec<String> = b_accs
        .iter()
        .map(|a| a.email.trim().to_lowercase())
        .filter(|em| a_accs.iter().any(|x| x.email.trim().eq_ignore_ascii_case(em)))
        .collect();
    let a_common: Vec<String> = a_accs
        .iter()
        .map(|a| a.email.trim().to_lowercase())
        .filter(|em| b_accs.iter().any(|x| x.email.trim().eq_ignore_ascii_case(em)))
        .collect();
    if b_common.len() >= 2 && b_common != a_common {
        items.push(ConfigDiffItem {
            section: "accounts".into(),
            section_label: "邮箱账号".into(),
            target_key: "accounts".into(),
            kind: "modified".into(),
            field_label: "多邮箱排列顺序".into(),
            before: b_common.join(" → "),
            after: a_common.join(" → "),
        });
    }

    let b_active = before
        .primary_account()
        .map(|a| a.email.trim().to_lowercase())
        .unwrap_or_default();
    let a_active = after
        .primary_account()
        .map(|a| a.email.trim().to_lowercase())
        .unwrap_or_default();
    if b_active != a_active {
        items.push(ConfigDiffItem {
            section: "accounts".into(),
            section_label: "邮箱账号".into(),
            target_key: if a_active.is_empty() {
                "accounts".into()
            } else {
                format!("account:{a_active}")
            },
            kind: "modified".into(),
            field_label: "当前主用邮箱".into(),
            before: if b_active.is_empty() {
                "未绑定".into()
            } else {
                b_active
            },
            after: if a_active.is_empty() {
                "无".into()
            } else {
                a_active
            },
        });
    }

    // 2. AI 模型与分拣参数对比
    let ba = &before.agent;
    let aa = &after.agent;
    if ba.enabled != aa.enabled {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.enabled".into(),
            kind: "modified".into(),
            field_label: "新来信 AI 自动分拣".into(),
            before: bool_label(ba.enabled).into(),
            after: bool_label(aa.enabled).into(),
        });
    }
    if !ba.preset.trim().eq_ignore_ascii_case(aa.preset.trim()) {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.preset".into(),
            kind: "modified".into(),
            field_label: "模型服务商".into(),
            before: format!("{} ({})", preset_readable_name(&ba.preset), val_or(&ba.preset, "未设")),
            after: format!("{} ({})", preset_readable_name(&aa.preset), val_or(&aa.preset, "未设")),
        });
    } else if !ba.provider.trim().eq_ignore_ascii_case(aa.provider.trim()) {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.provider".into(),
            kind: "modified".into(),
            field_label: "接口协议".into(),
            before: val_or(&ba.provider, "openai"),
            after: val_or(&aa.provider, "openai"),
        });
    }
    if ba.model.trim() != aa.model.trim() {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.model".into(),
            kind: "modified".into(),
            field_label: "模型名称".into(),
            before: val_or(&ba.model, "默认"),
            after: val_or(&aa.model, "默认"),
        });
    }
    if ba.base_url.trim() != aa.base_url.trim() {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.base_url".into(),
            kind: "modified".into(),
            field_label: "接口地址 (Base URL)".into(),
            before: val_or(&ba.base_url, "默认"),
            after: val_or(&aa.base_url, "默认"),
        });
    }
    if ba.auto_draft != aa.auto_draft {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.auto_draft".into(),
            kind: "modified".into(),
            field_label: "自动生成快捷回复建议".into(),
            before: bool_label(ba.auto_draft).into(),
            after: bool_label(aa.auto_draft).into(),
        });
    }
    if ba.auto_block_sender != aa.auto_block_sender {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.auto_block_sender".into(),
            kind: "modified".into(),
            field_label: "垃圾邮件自动拉黑发件人".into(),
            before: bool_label(ba.auto_block_sender).into(),
            after: bool_label(aa.auto_block_sender).into(),
        });
    }
    if ba.instructions.trim() != aa.instructions.trim() {
        items.push(ConfigDiffItem {
            section: "agent".into(),
            section_label: "AI 模型与分拣".into(),
            target_key: "agent.instructions".into(),
            kind: "modified".into(),
            field_label: "自然语言分拣偏好".into(),
            before: short_text(&ba.instructions, 56),
            after: short_text(&aa.instructions, 56),
        });
    }

    // 3. 确定性分流规则对比
    let rule_pairs: [(&str, &str, &[String], &[String]); 6] = [
        (
            "allow_senders",
            "白名单发件人",
            &before.triage.allow_senders,
            &after.triage.allow_senders,
        ),
        (
            "block_senders",
            "屏蔽发件人",
            &before.triage.block_senders,
            &after.triage.block_senders,
        ),
        (
            "block_domains",
            "屏蔽发件域名",
            &before.triage.block_domains,
            &after.triage.block_domains,
        ),
        (
            "block_keywords",
            "屏蔽关键词",
            &before.triage.block_keywords,
            &after.triage.block_keywords,
        ),
        (
            "archive_senders",
            "折叠发件人（进通知）",
            &before.triage.archive_senders,
            &after.triage.archive_senders,
        ),
        (
            "archive_keywords",
            "折叠关键词（进通知）",
            &before.triage.archive_keywords,
            &after.triage.archive_keywords,
        ),
    ];

    for (key, label, b_list, a_list) in rule_pairs {
        let added: Vec<String> = a_list
            .iter()
            .filter(|v| !b_list.iter().any(|x| x.trim().eq_ignore_ascii_case(v.trim())))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let removed: Vec<String> = b_list
            .iter()
            .filter(|v| !a_list.iter().any(|x| x.trim().eq_ignore_ascii_case(v.trim())))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if !added.is_empty() && removed.is_empty() {
            items.push(ConfigDiffItem {
                section: "triage".into(),
                section_label: "分流规则".into(),
                target_key: format!("triage.{key}"),
                kind: "added".into(),
                field_label: label.into(),
                before: String::new(),
                after: added.join("、"),
            });
        } else if added.is_empty() && !removed.is_empty() {
            items.push(ConfigDiffItem {
                section: "triage".into(),
                section_label: "分流规则".into(),
                target_key: format!("triage.{key}"),
                kind: "removed".into(),
                field_label: label.into(),
                before: removed.join("、"),
                after: String::new(),
            });
        } else if !added.is_empty() && !removed.is_empty() {
            items.push(ConfigDiffItem {
                section: "triage".into(),
                section_label: "分流规则".into(),
                target_key: format!("triage.{key}"),
                kind: "modified".into(),
                field_label: label.into(),
                before: format!("移除 {}", removed.join("、")),
                after: format!("新增 {}", added.join("、")),
            });
        }
    }

    // 4. 邮件群聊拓扑对比
    let norm_gid = |id: &str| id.trim().trim_start_matches("group:").to_string();
    for ag in &after.groups {
        let gid = norm_gid(&ag.id);
        let target_key = format!("group:{gid}");
        if let Some(bg) = before.groups.iter().find(|x| norm_gid(&x.id) == gid) {
            if bg.name.trim() != ag.name.trim() {
                items.push(ConfigDiffItem {
                    section: "groups".into(),
                    section_label: "邮件群聊".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: "群聊名称".into(),
                    before: val_or(&bg.name, "未命名"),
                    after: val_or(&ag.name, "未命名"),
                });
            }
            if bg.muted != ag.muted {
                items.push(ConfigDiffItem {
                    section: "groups".into(),
                    section_label: "邮件群聊".into(),
                    target_key: target_key.clone(),
                    kind: "modified".into(),
                    field_label: format!("群聊「{}」免打扰", ag.name),
                    before: bool_label(bg.muted).into(),
                    after: bool_label(ag.muted).into(),
                });
            }
            let added_m: Vec<String> = ag
                .members
                .iter()
                .filter(|m| {
                    !bg.members
                        .iter()
                        .any(|x| x.email.trim().eq_ignore_ascii_case(m.email.trim()))
                })
                .map(|m| m.email.trim().to_string())
                .collect();
            let removed_m: Vec<String> = bg
                .members
                .iter()
                .filter(|m| {
                    !ag.members
                        .iter()
                        .any(|x| x.email.trim().eq_ignore_ascii_case(m.email.trim()))
                })
                .map(|m| m.email.trim().to_string())
                .collect();
            if !added_m.is_empty() || !removed_m.is_empty() {
                let mut parts_b = Vec::new();
                let mut parts_a = Vec::new();
                if !removed_m.is_empty() {
                    parts_b.push(format!("移除 {}", removed_m.join("、")));
                } else {
                    parts_b.push(format!("原 {} 人", bg.members.len()));
                }
                if !added_m.is_empty() {
                    parts_a.push(format!("新增 {}", added_m.join("、")));
                } else {
                    parts_a.push(format!("现 {} 人", ag.members.len()));
                }
                items.push(ConfigDiffItem {
                    section: "groups".into(),
                    section_label: "邮件群聊".into(),
                    target_key,
                    kind: "modified".into(),
                    field_label: format!("群聊「{}」成员", ag.name),
                    before: parts_b.join("；"),
                    after: parts_a.join("；"),
                });
            }
        } else {
            let preview_members: Vec<&str> =
                ag.members.iter().take(3).map(|m| m.email.as_str()).collect();
            let member_note = if preview_members.is_empty() {
                format!("{} 位成员", ag.members.len())
            } else if ag.members.len() > 3 {
                format!("{} 等 {} 人", preview_members.join("、"), ag.members.len())
            } else {
                format!("{}（共 {} 人）", preview_members.join("、"), ag.members.len())
            };
            items.push(ConfigDiffItem {
                section: "groups".into(),
                section_label: "邮件群聊".into(),
                target_key,
                kind: "added".into(),
                field_label: format!("新建群聊「{}」", ag.name),
                before: String::new(),
                after: format!("{member_note}{}", if ag.muted { " · 免打扰" } else { "" }),
            });
        }
    }

    for bg in &before.groups {
        let gid = norm_gid(&bg.id);
        if !after.groups.iter().any(|x| norm_gid(&x.id) == gid) {
            items.push(ConfigDiffItem {
                section: "groups".into(),
                section_label: "邮件群聊".into(),
                target_key: "groups".into(),
                kind: "removed".into(),
                field_label: format!("移除群聊「{}」", bg.name),
                before: format!("{} 位成员", bg.members.len()),
                after: String::new(),
            });
        }
    }

    let has_toml_change = before_toml.trim() != after_toml.trim();
    ConfigDiffReport {
        items,
        before_toml: if has_toml_change {
            before_toml.to_string()
        } else {
            String::new()
        },
        after_toml: if has_toml_change {
            after_toml.to_string()
        } else {
            String::new()
        },
    }
}
