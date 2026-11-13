mod agent;
mod config;
mod db;
mod mail;
mod vault;

use db::{Account, AgentConfig, Conversation, Db, GroupInfo, GroupMember, MailboxStats, MessageDto, NewMessage, Rule};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{llm_secret_key, secret_label, SecretPrompt, SecretStatus, Vault};

/// 后台轮询间隔（秒）
const POLL_SECS: u64 = 90;

struct AppState {
    app_dir: PathBuf,
    db: Arc<Db>,
    vault: Arc<Vault>,
    syncing: Arc<AtomicBool>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

#[derive(Serialize, Clone)]
struct SyncReport {
    new_incoming: usize,
    agent_processed: usize,
    error: Option<String>,
}

#[derive(Serialize)]
struct DeclarativeBundle {
    path: String,
    toml: String,
    secrets: Vec<SecretStatus>,
}

#[derive(Serialize)]
struct SecretSaveResult {
    secrets: Vec<SecretStatus>,
    verified: bool,
    message: String,
}

#[derive(Serialize)]
struct AgentChatResponse {
    reply: String,
    changes: Vec<String>,
    toml: String,
    secrets: Vec<SecretStatus>,
    secret_prompts: Vec<SecretPrompt>,
    suggestions: Vec<String>,
}

/// 同步 + Agent 分拣。可被后台循环、刷新按钮与配置管家 Agent 触发，用原子标志位防止并发重入。
async fn run_sync(app: &AppHandle, db: Arc<Db>, vault: Arc<Vault>, syncing: Arc<AtomicBool>) -> SyncReport {
    if syncing.swap(true, Ordering::SeqCst) {
        return SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        };
    }
    let report = sync_inner(app, db, vault).await;
    syncing.store(false, Ordering::SeqCst);
    let _ = app.emit("mail-updated", report.clone());
    report
}

async fn process_pending_with_agent(app: &AppHandle, db: &Arc<Db>, cfg: &AgentConfig) -> usize {
    let pending = db.pending().unwrap_or_default();
    let mut processed = 0;
    for item in pending {
        let result = if cfg.enabled {
            agent::classify(cfg, &item.from_addr, &item.from_name, &item.subject, &item.body_full).await
        } else {
            Err(anyhow::anyhow!("Agent 未启用"))
        };
        match result {
            Ok(v) => {
                let status = v.status();
                if status == "blocked" && cfg.auto_block_sender {
                    let _ = db.add_rule("block_sender", &item.from_addr);
                }
                let code = if !v.extracted_code.is_empty() {
                    v.extracted_code.as_str()
                } else {
                    item.existing_code.as_str()
                };
                let _ = db.apply_verdict(
                    item.id,
                    status,
                    &v.category,
                    &v.summary,
                    &v.reason,
                    code,
                    &v.suggested_reply,
                );
            }
            // 模型调用失败时放行到聊天列表，绝不因为接口异常吞掉正常来信
            Err(e) => {
                let _ = db.apply_verdict(
                    item.id,
                    "inbox",
                    "",
                    "",
                    &format!("Agent 未处理: {e:#}"),
                    &item.existing_code,
                    "",
                );
            }
        }
        processed += 1;
        let _ = app.emit(
            "mail-updated",
            SyncReport {
                new_incoming: 0,
                agent_processed: processed,
                error: None,
            },
        );
    }
    processed
}

async fn sync_inner(app: &AppHandle, db: Arc<Db>, vault: Arc<Vault>) -> SyncReport {
    let mut report = SyncReport {
        new_incoming: 0,
        agent_processed: 0,
        error: None,
    };
    let cfg = config::hydrated_agent(&db, &vault).unwrap_or_default();

    if let Ok(Some(acc)) = config::hydrated_account(&db, &vault) {
        if !acc.password.is_empty() && !acc.imap_host.is_empty() {
            let db2 = db.clone();
            let agent_on = cfg.enabled;
            match tauri::async_runtime::spawn_blocking(move || mail::sync(&acc, &db2, agent_on)).await {
                Ok(Ok(o)) => report.new_incoming = o.new_incoming,
                Ok(Err(e)) => report.error = Some(err(e)),
                Err(e) => report.error = Some(err(e)),
            }
            if report.new_incoming > 0 {
                let _ = app.emit("mail-updated", report.clone());
            }
        }
    }

    report.agent_processed = process_pending_with_agent(app, &db, &cfg).await;
    report
}

fn current_me(db: &Db) -> String {
    db.account()
        .ok()
        .flatten()
        .map(|a| a.email)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "me@mailchat.local".into())
}

fn config_file_path(state: &AppState) -> String {
    state.app_dir.join("config.toml").to_string_lossy().to_string()
}

fn refresh_disk_toml(state: &AppState) {
    let _ = config::sync_disk_toml(&state.app_dir, &state.db);
}

#[tauri::command]
fn get_declarative_config(state: State<AppState>) -> CmdResult<DeclarativeBundle> {
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        secrets: state.vault.statuses(),
    })
}

#[tauri::command]
fn apply_declarative_config(state: State<AppState>, toml: String) -> CmdResult<DeclarativeBundle> {
    let normalized = config::apply_toml(&state.app_dir, &toml, &state.db, &state.vault).map_err(err)?;
    let rules = state.db.rules().map_err(err)?;
    let _ = state.db.scan_existing_with_rules(|from, subject, body| {
        agent::apply_rules(&rules, from, subject, body).map(|h| (h.status, h.reason))
    });
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml: normalized,
        secrets: state.vault.statuses(),
    })
}

#[tauri::command]
fn list_secrets(state: State<AppState>) -> CmdResult<Vec<SecretStatus>> {
    Ok(state.vault.statuses())
}

#[tauri::command]
async fn set_secret(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
    verify: bool,
) -> CmdResult<SecretSaveResult> {
    let clean_key = key.trim().trim_start_matches("secret:").to_string();
    if value.trim().is_empty() {
        return Err("输入的凭据内容不能为空".into());
    }
    state.vault.set(&clean_key, &value).map_err(err)?;

    let mut verified = false;
    let mut message = format!("{} 已通过本地 DPAPI 加密保存", secret_label(&clean_key));

    if verify {
        if clean_key == "mail_password" {
            if let Some(acc) = config::hydrated_account(&state.db, &state.vault).map_err(err)? {
                if !acc.imap_host.is_empty() && !acc.smtp_host.is_empty() {
                    tauri::async_runtime::spawn_blocking(move || mail::test_account(&acc))
                        .await
                        .map_err(err)?
                        .map_err(err)?;
                    verified = true;
                    message = "邮箱授权码加密保存成功，IMAP/SMTP 连接验证通过，正在后台同步！".into();
                    let (db, vault, syncing) = (state.db.clone(), state.vault.clone(), state.syncing.clone());
                    tauri::async_runtime::spawn(async move { run_sync(&app, db, vault, syncing).await });
                }
            }
        } else if clean_key.starts_with("llm_") {
            let mut ag = state.db.agent_config().map_err(err)?;
            let target_preset = clean_key.trim_start_matches("llm_");
            if ag.preset == target_preset || !ag.enabled {
                ag.enabled = true;
                let _ = state.db.save_agent_config(&ag);
                refresh_disk_toml(&state);
            }
            let hydrated = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
            if llm_secret_key(&hydrated.preset) == Some(clean_key.as_str()) {
                let v = agent::classify(
                    &hydrated,
                    "promo@shop.example.com",
                    "测试商城",
                    "限时五折促销",
                    "点击抢购，回复 TD 退订",
                )
                .await
                .map_err(err)?;
                verified = true;
                message = format!(
                    "{} 已加密保存且模型连通正常（测试样本判定：{} / {}）",
                    secret_label(&clean_key),
                    v.action,
                    v.category
                );
            }
        }
    }

    Ok(SecretSaveResult {
        secrets: state.vault.statuses(),
        verified,
        message,
    })
}

#[tauri::command]
fn delete_secret(state: State<AppState>, key: String) -> CmdResult<Vec<SecretStatus>> {
    state.vault.delete(&key).map_err(err)?;
    Ok(state.vault.statuses())
}

#[tauri::command]
async fn chat_with_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    history: Vec<agent::ChatTurn>,
) -> CmdResult<AgentChatResponse> {
    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let stats = state.db.stats().unwrap_or_default();
    let current_toml = config::export_toml(&state.db).map_err(err)?;
    let statuses = state.vault.statuses();

    let mut plan = agent::chat_config_agent(&cfg, &spec, &stats, &current_toml, &statuses, &history, &message).await;

    if let Some((sk, raw_val)) = &plan.intercepted_secret {
        state.vault.set(sk, raw_val).map_err(err)?;
    }

    let final_toml = if let Some(new_toml) = &plan.updated_toml {
        match config::apply_toml(&state.app_dir, new_toml, &state.db, &state.vault) {
            Ok(normalized) => normalized,
            Err(e) => {
                plan.reply.push_str(&format!("\n\n（注：生成的声明式配置校验未通过：{e:#}，已保留原配置）"));
                plan.changes.clear();
                current_toml
            }
        }
    } else {
        current_toml
    };

    for op in &plan.operations {
        match op.as_str() {
            "apply_rules_now" => {
                if let Ok(rules) = state.db.rules() {
                    if let Ok(n) = state.db.scan_existing_with_rules(|from, subject, body| {
                        agent::apply_rules(&rules, from, subject, body).map(|h| (h.status, h.reason))
                    }) {
                        if n > 0 {
                            plan.changes.push(format!("按新规则自动归整了 {n} 封现有邮件"));
                        }
                    }
                }
            }
            "reclassify" => {
                let mut active = config::hydrated_agent(&state.db, &state.vault).unwrap_or_default();
                active.enabled = true;
                if let Ok(queued) = state.db.mark_for_reclassify(true) {
                    if queued > 0 {
                        let done = process_pending_with_agent(&app, &state.db, &active).await;
                        plan.changes.push(format!("AI 重新分拣了 {done} 封邮件"));
                    }
                }
            }
            "sync_now" => {
                let (db, vault, syncing) = (state.db.clone(), state.vault.clone(), state.syncing.clone());
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { run_sync(&handle, db, vault, syncing).await });
                plan.changes.push("已启动后台 IMAP 收信同步".into());
            }
            "load_demo" => {
                let me = current_me(&state.db);
                if let Ok(n) = state.db.seed_demo_data(&me) {
                    let _ = config::sync_disk_toml(&state.app_dir, &state.db);
                    plan.changes.push(if n > 0 {
                        format!("注入 {n} 封演示邮件与 4 人研发群聊")
                    } else {
                        "演示会话已就绪".into()
                    });
                }
            }
            "clear_demo" => {
                if let Ok(n) = state.db.clear_demo_data() {
                    let _ = config::sync_disk_toml(&state.app_dir, &state.db);
                    plan.changes.push(format!("已清理 {n} 封演示邮件"));
                }
            }
            _ => {}
        }
    }

    let latest_toml = config::sync_disk_toml(&state.app_dir, &state.db).unwrap_or(final_toml);
    let latest_secrets = state.vault.statuses();

    // 构建本地安全输入提示卡（去重）
    let mut prompt_keys: Vec<String> = Vec::new();
    for k in plan.request_secrets {
        let clean = k.trim().trim_start_matches("secret:").to_string();
        if !clean.is_empty() && !prompt_keys.contains(&clean) {
            prompt_keys.push(clean);
        }
    }
    let secret_prompts: Vec<SecretPrompt> = prompt_keys
        .into_iter()
        .map(|k| {
            let configured = latest_secrets.iter().any(|s| s.key == k && s.configured);
            let hint = if k == "mail_password" {
                "QQ / 163 / Gmail 等请填写网页端开启 IMAP/SMTP 后生成的「授权码 / 应用专用密码」。".to_string()
            } else {
                "密钥仅在本地经系统 DPAPI 加密存储，绝不写入 config.toml，也不会发送给聊天上下文。".to_string()
            };
            SecretPrompt {
                label: secret_label(&k),
                key: k,
                hint,
                configured,
            }
        })
        .collect();

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    Ok(AgentChatResponse {
        reply: plan.reply,
        changes: plan.changes,
        toml: latest_toml,
        secrets: latest_secrets,
        secret_prompts,
        suggestions: plan.suggestions,
    })
}

#[tauri::command]
fn get_account(state: State<AppState>) -> CmdResult<Option<Account>> {
    // 返回给前端表单时绝不回传明文密码
    let mut acc = state.db.account().map_err(err)?;
    if let Some(a) = &mut acc {
        a.password.clear();
    }
    Ok(acc)
}

#[tauri::command]
async fn save_account(app: AppHandle, state: State<'_, AppState>, mut account: Account) -> CmdResult<()> {
    if !account.password.trim().is_empty() {
        state.vault.set("mail_password", &account.password).map_err(err)?;
    }
    let full_password = state.vault.get("mail_password").unwrap_or_default();
    if full_password.is_empty() {
        return Err("请填写邮箱 IMAP/SMTP 授权码（密码将独立加密存入本地隐私保险箱）".into());
    }

    let mut test_acc = account.clone();
    test_acc.password = full_password;
    tauri::async_runtime::spawn_blocking(move || mail::test_account(&test_acc))
        .await
        .map_err(err)?
        .map_err(err)?;

    account.password.clear();
    state.db.save_account(&account).map_err(err)?;
    refresh_disk_toml(&state);

    let (db, vault, syncing) = (state.db.clone(), state.vault.clone(), state.syncing.clone());
    tauri::async_runtime::spawn(async move { run_sync(&app, db, vault, syncing).await });
    Ok(())
}

#[tauri::command]
fn get_agent_config(state: State<AppState>) -> CmdResult<AgentConfig> {
    let mut cfg = state.db.agent_config().map_err(err)?;
    cfg.api_key.clear();
    for p in cfg.profiles.values_mut() {
        p.api_key.clear();
    }
    Ok(cfg)
}

#[tauri::command]
fn save_agent_config(state: State<AppState>, mut config: AgentConfig) -> CmdResult<()> {
    if !config.api_key.trim().is_empty() {
        if let Some(sk) = llm_secret_key(&config.preset) {
            state.vault.set(sk, &config.api_key).map_err(err)?;
        }
    }
    config.api_key.clear();
    for (preset, prof) in config.profiles.iter_mut() {
        if !prof.api_key.trim().is_empty() {
            if let Some(sk) = llm_secret_key(preset) {
                let _ = state.vault.set(sk, &prof.api_key);
            }
            prof.api_key.clear();
        }
    }
    state.db.save_agent_config(&config).map_err(err)?;
    refresh_disk_toml(&state);
    Ok(())
}

#[tauri::command]
async fn test_agent(state: State<'_, AppState>, mut config: AgentConfig) -> CmdResult<agent::Verdict> {
    if config.api_key.trim().is_empty() {
        config.api_key = llm_secret_key(&config.preset)
            .and_then(|k| state.vault.get(k))
            .unwrap_or_default();
    }
    agent::classify(
        &config,
        "promo@shop.example.com",
        "某某商城",
        "双十一返场狂欢，全场五折起！",
        "尊敬的会员，限时优惠仅剩 24 小时，点击链接立即抢购。拒收请回复 TD 退订。",
    )
    .await
    .map_err(err)
}

#[tauri::command]
async fn fetch_models(state: State<'_, AppState>, mut config: AgentConfig) -> CmdResult<Vec<String>> {
    if config.api_key.trim().is_empty() {
        config.api_key = llm_secret_key(&config.preset)
            .and_then(|k| state.vault.get(k))
            .unwrap_or_default();
    }
    agent::fetch_remote_models(&config).await.map_err(err)
}

#[tauri::command]
fn window_action(window: tauri::WebviewWindow, action: String) -> CmdResult<bool> {
    match action.as_str() {
        "drag" => {
            let _ = window.start_dragging();
            Ok(window.is_maximized().unwrap_or(false))
        }
        "toggle_pin" => {
            let next = !window.is_always_on_top().unwrap_or(false);
            window.set_always_on_top(next).map_err(err)?;
            Ok(next)
        }
        "is_pinned" => window.is_always_on_top().map_err(err),
        "minimize" => {
            window.minimize().map_err(err)?;
            Ok(false)
        }
        "toggle_maximize" => {
            let max = window.is_maximized().unwrap_or(false);
            if max {
                window.unmaximize().map_err(err)?;
                Ok(false)
            } else {
                window.maximize().map_err(err)?;
                Ok(true)
            }
        }
        "is_maximized" => window.is_maximized().map_err(err),
        "close" => {
            window.close().map_err(err)?;
            Ok(false)
        }
        _ => Err("不支持的窗口操作".into()),
    }
}

#[tauri::command]
async fn reclassify_messages(app: AppHandle, state: State<'_, AppState>, all: bool) -> CmdResult<usize> {
    let mut cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    cfg.enabled = true;
    let queued = state.db.mark_for_reclassify(all).map_err(err)?;
    if queued == 0 {
        return Ok(0);
    }
    let processed = process_pending_with_agent(&app, &state.db, &cfg).await;
    Ok(processed)
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> CmdResult<SyncReport> {
    Ok(run_sync(&app, state.db.clone(), state.vault.clone(), state.syncing.clone()).await)
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> CmdResult<MailboxStats> {
    state.db.stats().map_err(err)
}

#[tauri::command]
fn list_conversations(state: State<AppState>, status: String) -> CmdResult<Vec<Conversation>> {
    state.db.conversations(&status).map_err(err)
}

#[tauri::command]
fn list_messages(state: State<AppState>, peer: String, status: String) -> CmdResult<Vec<MessageDto>> {
    state.db.messages(&peer, &status).map_err(err)
}

#[tauri::command]
fn list_contacts(state: State<AppState>) -> CmdResult<Vec<GroupMember>> {
    let me = current_me(&state.db);
    state.db.known_contacts(&me).map_err(err)
}

#[tauri::command]
fn create_group(state: State<AppState>, name: String, members: Vec<GroupMember>) -> CmdResult<GroupInfo> {
    let me = current_me(&state.db);
    let g = state.db.create_group(&name, &members, &me).map_err(err)?;
    refresh_disk_toml(&state);
    Ok(g)
}

#[tauri::command]
fn get_group(state: State<AppState>, peer: String) -> CmdResult<Option<GroupInfo>> {
    state.db.get_group(&peer).map_err(err)
}

#[tauri::command]
fn update_group(
    state: State<AppState>,
    peer: String,
    name: String,
    members: Vec<GroupMember>,
    muted: bool,
) -> CmdResult<GroupInfo> {
    let me = current_me(&state.db);
    let prev_muted = state
        .db
        .get_group(&peer)
        .map_err(err)?
        .map(|g| g.muted)
        .unwrap_or(false);
    let updated = state
        .db
        .update_group(&peer, &name, &members, muted, &me)
        .map_err(err)?;
    if prev_muted != muted {
        let target = if muted { "archived" } else { "inbox" };
        let _ = state.db.move_peer(&peer, target);
    }
    refresh_disk_toml(&state);
    Ok(updated)
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    peer: String,
    body: String,
    custom_subject: Option<String>,
) -> CmdResult<MessageDto> {
    let raw_peer = peer.trim();
    let is_group = raw_peer.starts_with("group:");
    let (peer, recipients, group_id, group_name, grp_muted) = if is_group {
        let grp = state
            .db
            .get_group(raw_peer)
            .map_err(err)?
            .ok_or("找不到该群聊")?;
        let rcpts: Vec<String> = grp.members.iter().map(|m| m.email.clone()).collect();
        if rcpts.is_empty() {
            return Err("群聊至少需要 1 位成员才能发送消息".into());
        }
        let gid = raw_peer.trim_start_matches("group:").to_string();
        (raw_peer.to_string(), rcpts, Some(gid), Some(grp.name), grp.muted)
    } else {
        let p = raw_peer.to_lowercase();
        if !p.contains('@') {
            return Err("请输入有效的收件人邮箱地址".into());
        }
        (p.clone(), vec![p], None, None, false)
    };

    let ctx = state.db.reply_context(&peer).map_err(err)?;
    let acc_opt = config::hydrated_account(&state.db, &state.vault).map_err(err)?;

    let (subject, in_reply_to, references) = match (&custom_subject, &ctx) {
        (Some(cs), _) if !cs.trim().is_empty() => (cs.trim().to_string(), None, None),
        (_, Some(c)) => {
            let s = c.subject.trim();
            let lower = s.to_lowercase();
            let subject = if s.is_empty() {
                group_name.clone().unwrap_or_else(|| "(无主题)".to_string())
            } else if lower.starts_with("re:") || s.starts_with("回复") {
                s.to_string()
            } else {
                format!("Re: {s}")
            };
            let mut refs: Vec<String> = c
                .references
                .split_whitespace()
                .map(|r| format!("<{}>", r.trim_matches(&['<', '>'][..])))
                .collect();
            let clean_mid = format!("<{}>", c.message_id.trim_matches(&['<', '>'][..]));
            if !refs.contains(&clean_mid) {
                refs.push(clean_mid);
            }
            (subject, Some(c.message_id.clone()), Some(refs.join(" ")))
        }
        _ => {
            if let Some(gname) = &group_name {
                (gname.clone(), None, None)
            } else {
                let sender_label = acc_opt
                    .as_ref()
                    .map(|a| if a.display_name.is_empty() { a.email.as_str() } else { a.display_name.as_str() })
                    .unwrap_or("MailChat");
                (format!("来自 {sender_label} 的消息"), None, None)
            }
        }
    };

    let (mid, from_addr, from_name, folder) = match acc_opt {
        Some(acc) if !acc.password.is_empty() && !acc.smtp_host.is_empty() => {
            let acc2 = acc.clone();
            let (rcpts, subj, b, irt, refs, gid, gname) = (
                recipients.clone(),
                subject.clone(),
                body.clone(),
                in_reply_to.clone(),
                references.clone(),
                group_id.clone(),
                group_name.clone(),
            );
            let mid = tauri::async_runtime::spawn_blocking(move || {
                mail::send(
                    &acc2,
                    &mail::Outgoing {
                        recipients: rcpts,
                        subject: subj,
                        body: &b,
                        in_reply_to: irt,
                        references: refs,
                        group_id: gid,
                        group_name: gname,
                    },
                )
            })
            .await
            .map_err(err)?
            .map_err(err)?;
            (mid, acc.email.to_lowercase(), acc.display_name, "local")
        }
        _ => {
            let stats = state.db.stats().map_err(err)?;
            if !stats.has_demo {
                return Err("请先通过左侧「AI 助手」或配置页连接邮箱账号，或载入演示会话体验".into());
            }
            (
                format!("{}@mailchat.demo", uuid::Uuid::new_v4()),
                "me@mailchat.local".to_string(),
                "我 (演示模式)".to_string(),
                "demo",
            )
        }
    };

    let target_status = if is_group && grp_muted { "archived" } else { "inbox" };
    let category = if is_group { "群聊".to_string() } else { String::new() };

    let id = state
        .db
        .insert_message(&NewMessage {
            folder: folder.into(),
            uid: 0,
            message_id: mid,
            in_reply_to: in_reply_to.unwrap_or_default(),
            references: references.unwrap_or_default(),
            from_addr,
            from_name,
            to_addrs: recipients.join(","),
            cc_addrs: String::new(),
            subject,
            body: body.trim().to_string(),
            body_full: body,
            date: chrono::Utc::now().timestamp(),
            outgoing: true,
            peer,
            status: target_status.into(),
            category,
            summary: String::new(),
            reason: String::new(),
            extracted_code: String::new(),
            suggested_reply: String::new(),
            read: true,
            agent_done: true,
        })
        .map_err(err)?
        .ok_or("消息写入失败")?;
    state.db.message(id).map_err(err)
}

#[tauri::command]
fn set_message_status(state: State<AppState>, id: i64, status: String) -> CmdResult<()> {
    state.db.set_message_status(id, &status).map_err(err)
}

#[tauri::command]
fn move_conversation(state: State<AppState>, peer: String, status: String) -> CmdResult<()> {
    state.db.move_peer(&peer, &status).map_err(err)
}

#[tauri::command]
fn block_sender(state: State<AppState>, peer: String) -> CmdResult<()> {
    state.db.add_rule("block_sender", &peer).map_err(err)?;
    refresh_disk_toml(&state);
    state.db.move_peer(&peer, "blocked").map_err(err)
}

#[tauri::command]
fn allow_sender(state: State<AppState>, peer: String) -> CmdResult<()> {
    state.db.add_rule("allow_sender", &peer).map_err(err)?;
    refresh_disk_toml(&state);
    state.db.move_peer(&peer, "inbox").map_err(err)
}

#[tauri::command]
fn list_rules(state: State<AppState>) -> CmdResult<Vec<Rule>> {
    state.db.rules().map_err(err)
}

#[tauri::command]
fn add_rule(state: State<AppState>, kind: String, pattern: String) -> CmdResult<()> {
    if pattern.trim().is_empty() {
        return Err("规则内容不能为空".into());
    }
    state.db.add_rule(&kind, &pattern).map_err(err)?;
    refresh_disk_toml(&state);
    Ok(())
}

#[tauri::command]
fn delete_rule(state: State<AppState>, id: i64) -> CmdResult<()> {
    state.db.delete_rule(id).map_err(err)?;
    refresh_disk_toml(&state);
    Ok(())
}

#[tauri::command]
fn apply_rules_now(state: State<AppState>) -> CmdResult<usize> {
    let rules = state.db.rules().map_err(err)?;
    state
        .db
        .scan_existing_with_rules(|from, subject, body| {
            agent::apply_rules(&rules, from, subject, body).map(|h| (h.status, h.reason))
        })
        .map_err(err)
}

#[tauri::command]
async fn draft_reply(state: State<'_, AppState>, peer: String, hint: Option<String>) -> CmdResult<String> {
    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let me = current_me(&state.db);
    let is_group = peer.starts_with("group:");
    let title = if is_group {
        state
            .db
            .get_group(&peer)
            .map_err(err)?
            .map(|g| g.name)
            .unwrap_or_else(|| peer.clone())
    } else {
        peer.clone()
    };
    let history = state.db.recent_history(&peer, 12).map_err(err)?;
    if history.is_empty() {
        return Err("当前会话还没有历史消息可供起草回复".into());
    }
    agent::draft_reply(&cfg, &me, &title, is_group, &history, hint.as_deref())
        .await
        .map_err(err)
}

#[tauri::command]
async fn summarize_conversation(state: State<'_, AppState>, peer: String, title: String) -> CmdResult<String> {
    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let me = current_me(&state.db);
    let is_group = peer.starts_with("group:");
    let label = if !title.trim().is_empty() {
        title
    } else if is_group {
        state
            .db
            .get_group(&peer)
            .map_err(err)?
            .map(|g| g.name)
            .unwrap_or_else(|| peer.clone())
    } else {
        peer.clone()
    };
    let history = state.db.recent_history(&peer, 25).map_err(err)?;
    if history.is_empty() {
        return Err("当前会话还没有历史消息可供总结".into());
    }
    agent::summarize_conversation(&cfg, &me, &label, is_group, &history)
        .await
        .map_err(err)
}

#[tauri::command]
fn load_demo_data(state: State<AppState>) -> CmdResult<usize> {
    let email = state
        .db
        .account()
        .ok()
        .flatten()
        .map(|a| a.email)
        .unwrap_or_default();
    let n = state.db.seed_demo_data(&email).map_err(err)?;
    refresh_disk_toml(&state);
    Ok(n)
}

#[tauri::command]
fn clear_demo_data(state: State<AppState>) -> CmdResult<usize> {
    let n = state.db.clear_demo_data().map_err(err)?;
    refresh_disk_toml(&state);
    Ok(n)
}

#[cfg(target_os = "windows")]
fn apply_win11_window_style(window: &tauri::WebviewWindow) {
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const u8) -> isize;
        fn GetProcAddress(h_module: isize, lp_proc_name: *const u8) -> *const core::ffi::c_void;
    }
    type DwmSetWindowAttributeFn =
        unsafe extern "system" fn(isize, u32, *const core::ffi::c_void, u32) -> i32;

    if let Ok(hwnd) = window.hwnd() {
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        const DWMWCP_ROUND: u32 = 2;
        let pref: u32 = DWMWCP_ROUND;
        unsafe {
            let hmod = LoadLibraryA(b"dwmapi.dll\0".as_ptr());
            if hmod != 0 {
                let proc_ptr = GetProcAddress(hmod, b"DwmSetWindowAttribute\0".as_ptr());
                if !proc_ptr.is_null() {
                    let func: DwmSetWindowAttributeFn = core::mem::transmute(proc_ptr);
                    let _ = func(
                        hwnd.0 as isize,
                        DWMWA_WINDOW_CORNER_PREFERENCE,
                        &pref as *const u32 as *const core::ffi::c_void,
                        core::mem::size_of::<u32>() as u32,
                    );
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                apply_win11_window_style(&win);
            }

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Arc::new(Db::open(&dir.join("mailchat.db"))?);
            let vault = Arc::new(Vault::open(&dir)?);

            // 自动将旧库中的明文密钥迁移至系统 DPAPI 隐私保险箱
            config::migrate_legacy_secrets(&db, &vault);

            // 若磁盘已存在用户手工修改过的 config.toml 则加载对账，否则生成初始声明式配置文件
            let cfg_file = dir.join("config.toml");
            if cfg_file.exists() {
                if let Ok(mut raw) = std::fs::read_to_string(&cfg_file) {
                    // 将早期未配置密钥的旧默认模型名平滑升级为 deepseek-v4.1-flash
                    if !raw.contains("deepseek-v4.1-flash")
                        && raw.contains("preset = \"deepseek\"")
                        && raw.contains("model = \"deepseek-chat\"")
                        && vault.get("llm_deepseek").is_none()
                    {
                        raw = raw.replace("model = \"deepseek-chat\"", "model = \"deepseek-v4.1-flash\"");
                    }
                    let _ = config::apply_toml(&dir, &raw, &db, &vault);
                }
            } else {
                let _ = config::sync_disk_toml(&dir, &db);
            }

            if let Ok(st) = db.stats() {
                if st.has_demo && db.get_group("group:demo-product-team").ok().flatten().is_none() {
                    let me = current_me(&db);
                    let _ = db.seed_demo_data(&me);
                    let _ = config::sync_disk_toml(&dir, &db);
                }
            }

            let syncing = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                app_dir: dir,
                db: db.clone(),
                vault: vault.clone(),
                syncing: syncing.clone(),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    run_sync(&handle, db.clone(), vault.clone(), syncing.clone()).await;
                    tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_declarative_config,
            apply_declarative_config,
            list_secrets,
            set_secret,
            delete_secret,
            chat_with_agent,
            get_account,
            save_account,
            get_agent_config,
            save_agent_config,
            test_agent,
            fetch_models,
            window_action,
            reclassify_messages,
            sync_now,
            get_stats,
            list_conversations,
            list_messages,
            list_contacts,
            create_group,
            get_group,
            update_group,
            send_message,
            set_message_status,
            move_conversation,
            block_sender,
            allow_sender,
            list_rules,
            add_rule,
            delete_rule,
            apply_rules_now,
            draft_reply,
            summarize_conversation,
            load_demo_data,
            clear_demo_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
