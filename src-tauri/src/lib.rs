mod agent;
mod config;
mod db;
mod llm;
mod mail;
mod vault;

use db::{
    Account, AgentConfig, AgentSessionSummary, AgentTurnRecord, AttachmentMeta, ContactProfile,
    Conversation, Db, GroupInfo, GroupMember, MailboxStats, MessageDto, NewAgentTurn, NewMessage,
    ProviderProfile, Rule,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{llm_secret_key, mail_secret_key, secret_label, SecretPrompt, SecretStatus, Vault};

/// IMAP IDLE 单次保活周期（秒）：有新邮件时毫秒级推送唤醒，静默每 28s 刷新一次防止家用 NAT/代理超时断流
const IDLE_KEEPALIVE_SECS: u64 = 28;
/// 不支持 IDLE 的邮箱服务端在复用长连接上的热轮询间隔（秒）
const WARM_POLL_SECS: u64 = 6;
/// 已发送文件夹增量对账周期（秒）
const SENT_SYNC_INTERVAL_SECS: u64 = 120;
/// 后台 AI 智能分拣单批最大并发数
const AGENT_CONCURRENCY: usize = 4;

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

struct WatcherControl {
    wake_mu: Mutex<u64>,
    wake_cv: Condvar,
    active_socket: Mutex<Option<std::net::TcpStream>>,
    last_live_at: AtomicU64,
    account_epoch: AtomicU64,
    triaging: AtomicBool,
}

impl WatcherControl {
    fn new() -> Self {
        Self {
            wake_mu: Mutex::new(0),
            wake_cv: Condvar::new(),
            active_socket: Mutex::new(None),
            last_live_at: AtomicU64::new(0),
            account_epoch: AtomicU64::new(0),
            triaging: AtomicBool::new(false),
        }
    }

    fn touch_live(&self) {
        self.last_live_at.store(now_unix_secs(), Ordering::Relaxed);
    }

    fn set_socket(&self, sock: Option<std::net::TcpStream>) {
        if sock.is_some() {
            self.touch_live();
        }
        if let Ok(mut guard) = self.active_socket.lock() {
            *guard = sock;
        }
    }

    fn interrupt_socket(&self) {
        if let Ok(mut guard) = self.active_socket.lock() {
            if let Some(sock) = guard.take() {
                let _ = sock.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    fn signal_wake(&self) {
        if let Ok(mut seq) = self.wake_mu.lock() {
            *seq = seq.wrapping_add(1);
            self.wake_cv.notify_all();
        }
    }

    /// 账号、密码或声明式配置变更时调用：立即中断旧连接并切换到最新配置重连
    fn reconnect_now(&self) {
        self.account_epoch.fetch_add(1, Ordering::SeqCst);
        self.interrupt_socket();
        self.signal_wake();
    }

    /// 窗口切回前台或手动刷新时轻量唤醒：若休眠导致长连接静默超时则立即掐断重连，否则唤醒热轮询
    fn poke(&self) {
        let last = self.last_live_at.load(Ordering::Relaxed);
        if last > 0 && now_unix_secs().saturating_sub(last) >= IDLE_KEEPALIVE_SECS + 15 {
            self.interrupt_socket();
        }
        self.signal_wake();
    }

    fn wait_or_woken(&self, seen_seq: &mut u64, timeout: Duration) -> bool {
        let Ok(guard) = self.wake_mu.lock() else {
            std::thread::sleep(timeout);
            return false;
        };
        if *guard != *seen_seq {
            *seen_seq = *guard;
            return true;
        }
        let Ok((guard_after, _)) = self.wake_cv.wait_timeout(guard, timeout) else {
            return false;
        };
        if *guard_after != *seen_seq {
            *seen_seq = *guard_after;
            true
        } else {
            false
        }
    }
}

struct AppState {
    app_dir: PathBuf,
    db: Arc<Db>,
    vault: Arc<Vault>,
    syncing: Arc<AtomicBool>,
    watcher: Arc<WatcherControl>,
    agent_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// 在阻塞线程池中安全执行 IMAP/SMTP 网络任务，捕获潜在底层解析器 panic 并转为友好错误信息。
async fn spawn_mail_blocking<F, T>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
    })
    .await
    .map_err(err)?;

    match joined {
        Ok(res) => res.map_err(err),
        Err(payload) => {
            let detail = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "未知内部异常".to_string()
            };
            Err(format!("邮件协议底层处理异常: {detail}"))
        }
    }
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
    spec: config::DeclarativeConfig,
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
    session_id: String,
    reply: String,
    thinking: String,
    thinking_ms: i64,
    tool_steps: Vec<String>,
    changes: Vec<String>,
    config_diff: Option<config::ConfigDiffReport>,
    toml: String,
    spec: config::DeclarativeConfig,
    secrets: Vec<SecretStatus>,
    secret_prompts: Vec<SecretPrompt>,
    suggestions: Vec<String>,
    sessions: Vec<AgentSessionSummary>,
}

#[derive(Serialize, Clone)]
struct AgentStreamPayload {
    request_id: String,
    session_id: String,
    kind: String,
    delta: String,
    thinking_ms: u64,
}

#[derive(Serialize)]
struct ModelSwitchResult {
    agent_config: AgentConfig,
    bundle: DeclarativeBundle,
}

#[derive(Deserialize)]
struct SendAttachmentInput {
    filename: String,
    mime: String,
    data_base64: String,
}

#[derive(Serialize, Clone)]
struct AccountEntry {
    email: String,
    display_name: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    username: String,
    active: bool,
    has_password: bool,
    inbox_unread: i64,
}

fn vault_statuses(db: &Db, vault: &Vault) -> Vec<SecretStatus> {
    let emails = db.account_emails().unwrap_or_default();
    vault.statuses_for_accounts(&emails)
}

fn build_account_entries(db: &Db, vault: &Vault) -> CmdResult<Vec<AccountEntry>> {
    let list = db.list_accounts().map_err(err)?;
    let active = db.active_account_email().map_err(err)?;
    let unread_map = db.unread_counts_by_account().unwrap_or_default();
    Ok(list
        .into_iter()
        .map(|a| {
            let sk = mail_secret_key(&a.email);
            let has_password = vault.get(&sk).is_some();
            let inbox_unread = unread_map.get(&a.email).copied().unwrap_or(0);
            AccountEntry {
                active: a.email == active,
                email: a.email,
                display_name: a.display_name,
                imap_host: a.imap_host,
                imap_port: a.imap_port,
                smtp_host: a.smtp_host,
                smtp_port: a.smtp_port,
                username: a.username,
                has_password,
                inbox_unread,
            }
        })
        .collect())
}

/// 立即拉取 IMAP 新邮件并异步移交后台 Agent 分拣（支持快速切号重入，绝不因等待大模型响应阻塞收信与刷新按钮）。
async fn run_sync(
    app: &AppHandle,
    db: Arc<Db>,
    vault: Arc<Vault>,
    syncing: Arc<AtomicBool>,
    watcher: Arc<WatcherControl>,
) -> SyncReport {
    watcher.poke();
    if syncing.swap(true, Ordering::SeqCst) {
        return SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        };
    }
    let mut report = SyncReport {
        new_incoming: 0,
        agent_processed: 0,
        error: None,
    };
    for _ in 0..3 {
        let before_epoch = watcher.account_epoch.load(Ordering::SeqCst);
        report = sync_inner(app, db.clone(), vault.clone()).await;
        if watcher.account_epoch.load(Ordering::SeqCst) == before_epoch {
            break;
        }
    }
    syncing.store(false, Ordering::SeqCst);
    let _ = app.emit("mail-updated", report.clone());
    spawn_agent_triage(app.clone(), db, vault, watcher);
    report
}

fn spawn_agent_triage(app: AppHandle, db: Arc<Db>, vault: Arc<Vault>, watcher: Arc<WatcherControl>) {
    if watcher.triaging.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for _ in 0..4 {
            let has_pending = db.pending().map(|p| !p.is_empty()).unwrap_or(false);
            if !has_pending {
                break;
            }
            let cfg = config::hydrated_agent(&db, &vault).unwrap_or_default();
            let done = process_pending_with_agent(&app, &db, &cfg).await;
            if done == 0 {
                break;
            }
        }
        watcher.triaging.store(false, Ordering::SeqCst);
    });
}

async fn process_pending_with_agent(app: &AppHandle, db: &Arc<Db>, cfg: &AgentConfig) -> usize {
    let pending = db.pending().unwrap_or_default();
    if pending.is_empty() {
        return 0;
    }
    let mut processed = 0;
    for chunk in pending.chunks(AGENT_CONCURRENCY) {
        let mut handles = Vec::with_capacity(chunk.len());
        for item in chunk {
            let cfg_clone = cfg.clone();
            let id = item.id;
            let from_addr = item.from_addr.clone();
            let from_name = item.from_name.clone();
            let subject = item.subject.clone();
            let body_full = item.body_full.clone();
            let existing_code = item.existing_code.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let res = if cfg_clone.enabled {
                    agent::classify(&cfg_clone, &from_addr, &from_name, &subject, &body_full).await
                } else {
                    Err(anyhow::anyhow!("Agent 未启用"))
                };
                (id, from_addr, body_full, existing_code, res)
            }));
        }

        for h in handles {
            let Ok((id, from_addr, body_full, existing_code, result)) = h.await else {
                continue;
            };
            match result {
                Ok(v) => {
                    let status = v.status();
                    if status == "blocked" && cfg.auto_block_sender {
                        let _ = db.add_rule("block_sender", &from_addr);
                    }
                    let code = if !v.extracted_code.is_empty() {
                        v.extracted_code.as_str()
                    } else {
                        existing_code.as_str()
                    };
                    let cleaned_len = mail::clean_body(&body_full).chars().count();
                    let summary = if status == "inbox" && cleaned_len <= 140 {
                        ""
                    } else {
                        v.summary.as_str()
                    };
                    let _ = db.apply_verdict(
                        id,
                        status,
                        &v.category,
                        summary,
                        &v.reason,
                        code,
                        &v.suggested_reply,
                    );
                }
                // 模型调用失败或未启用时保持在聊天列表，绝不吞掉正常来信
                Err(e) => {
                    let _ = db.apply_verdict(
                        id,
                        "inbox",
                        "",
                        "",
                        &format!("Agent 未处理: {e:#}"),
                        &existing_code,
                        "",
                    );
                }
            }
            processed += 1;
        }

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
            let app_early = app.clone();
            match spawn_mail_blocking(move || {
                mail::sync_with_hook(&acc, &db2, agent_on, move |inbox_new| {
                    let _ = app_early.emit(
                        "mail-updated",
                        SyncReport {
                            new_incoming: inbox_new,
                            agent_processed: 0,
                            error: None,
                        },
                    );
                })
            })
            .await
            {
                Ok(o) => report.new_incoming = o.new_incoming,
                Err(e) => report.error = Some(e),
            }
        }
    }

    report
}

/// 常驻实时收信守护线程：优先使用 IMAP IDLE 毫秒级长连接推送，对不支持 IDLE 的服务端自动保持 TLS 热会话高频增量检查。
fn spawn_realtime_imap_watcher(
    app: AppHandle,
    db: Arc<Db>,
    vault: Arc<Vault>,
    watcher: Arc<WatcherControl>,
) {
    let _ = std::thread::Builder::new()
        .name("mailchat-imap-watcher".into())
        .spawn(move || {
            let mut wake_seq: u64 = 0;
            let mut backoff_secs: u64 = 3;

            'reconnect: loop {
                let epoch = watcher.account_epoch.load(Ordering::SeqCst);
                let acc = match config::hydrated_account(&db, &vault) {
                    Ok(Some(a)) if !a.password.trim().is_empty() && !a.imap_host.trim().is_empty() => a,
                    _ => {
                        watcher.set_socket(None);
                        backoff_secs = 3;
                        let _ = watcher.wait_or_woken(&mut wake_seq, Duration::from_secs(30));
                        continue 'reconnect;
                    }
                };

                let connect_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mail::RealtimeSession::connect(&acc)
                }));

                let (mut rt, tcp_ctl) = match connect_res {
                    Ok(Ok(pair)) => {
                        backoff_secs = 3;
                        pair
                    }
                    _ => {
                        watcher.set_socket(None);
                        let _ = watcher.wait_or_woken(&mut wake_seq, Duration::from_secs(backoff_secs));
                        backoff_secs = (backoff_secs * 2).min(25);
                        continue 'reconnect;
                    }
                };

                watcher.set_socket(Some(tcp_ctl));

                let emit_and_triage = |incoming: usize| {
                    if incoming > 0 {
                        let _ = app.emit(
                            "mail-updated",
                            SyncReport {
                                new_incoming: incoming,
                                agent_processed: 0,
                                error: None,
                            },
                        );
                        spawn_agent_triage(app.clone(), db.clone(), vault.clone(), watcher.clone());
                    }
                };

                // 连接建立后立即同步一次 INBOX，新邮件秒级上屏，随后再同步已发送文件夹
                let agent_on = db.agent_config().map(|c| c.enabled).unwrap_or(false);
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    rt.sync_inbox(&acc, &db, agent_on)
                })) {
                    Ok(Ok(n)) => {
                        watcher.touch_live();
                        emit_and_triage(n);
                    }
                    _ => {
                        watcher.set_socket(None);
                        continue 'reconnect;
                    }
                }

                if let Ok(Ok(sent_n)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    rt.sync_sent(&acc, &db, agent_on)
                })) {
                    watcher.touch_live();
                    if sent_n > 0 {
                        let _ = app.emit(
                            "mail-updated",
                            SyncReport {
                                new_incoming: sent_n,
                                agent_processed: 0,
                                error: None,
                            },
                        );
                    }
                } else {
                    watcher.set_socket(None);
                    continue 'reconnect;
                }

                // 自动增量回填旧版入库但未保存 HTML 正文的历史邮件，补齐后实时通知前端刷新富文本卡片
                for _ in 0..12 {
                    if watcher.account_epoch.load(Ordering::SeqCst) != epoch {
                        break;
                    }
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        rt.backfill_missing_html(&acc, &db, 30)
                    })) {
                        Ok(Ok((checked, enriched))) => {
                            watcher.touch_live();
                            if enriched > 0 {
                                let _ = app.emit(
                                    "mail-updated",
                                    SyncReport {
                                        new_incoming: 0,
                                        agent_processed: 0,
                                        error: None,
                                    },
                                );
                            }
                            if checked == 0 {
                                break;
                            }
                        }
                        _ => {
                            watcher.set_socket(None);
                            continue 'reconnect;
                        }
                    }
                }

                let mut last_sent_sync = Instant::now();
                let mut poll_tick: u64 = 0;

                loop {
                    if watcher.account_epoch.load(Ordering::SeqCst) != epoch {
                        watcher.set_socket(None);
                        rt.logout();
                        continue 'reconnect;
                    }

                    if rt.supports_idle() {
                        let ev = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            rt.wait_idle(Duration::from_secs(IDLE_KEEPALIVE_SECS))
                        }));
                        match ev {
                            Ok(Ok(mail::WatchEvent::Changed)) | Ok(Ok(mail::WatchEvent::IdleKeepalive)) => {
                                watcher.touch_live();
                                if watcher.account_epoch.load(Ordering::SeqCst) != epoch {
                                    watcher.set_socket(None);
                                    rt.logout();
                                    continue 'reconnect;
                                }
                                let ag_on = db.agent_config().map(|c| c.enabled).unwrap_or(false);
                                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    rt.sync_inbox(&acc, &db, ag_on)
                                })) {
                                    Ok(Ok(n)) => {
                                        watcher.touch_live();
                                        emit_and_triage(n);
                                    }
                                    _ => {
                                        watcher.set_socket(None);
                                        continue 'reconnect;
                                    }
                                }
                            }
                            Ok(Ok(mail::WatchEvent::IdleRejected)) | _ => {
                                watcher.set_socket(None);
                                continue 'reconnect;
                            }
                        }
                    } else {
                        let woken = watcher.wait_or_woken(&mut wake_seq, Duration::from_secs(WARM_POLL_SECS));
                        if watcher.account_epoch.load(Ordering::SeqCst) != epoch {
                            watcher.set_socket(None);
                            rt.logout();
                            continue 'reconnect;
                        }
                        poll_tick = poll_tick.wrapping_add(1);
                        let noop_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rt.noop_check()));
                        let noop_changed = match noop_res {
                            Ok(Ok(changed)) => {
                                watcher.touch_live();
                                changed
                            }
                            _ => {
                                watcher.set_socket(None);
                                continue 'reconnect;
                            }
                        };

                        if noop_changed || woken || poll_tick % 2 == 0 {
                            let ag_on = db.agent_config().map(|c| c.enabled).unwrap_or(false);
                            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                rt.sync_inbox(&acc, &db, ag_on)
                            })) {
                                Ok(Ok(n)) => {
                                    watcher.touch_live();
                                    emit_and_triage(n);
                                }
                                _ => {
                                    watcher.set_socket(None);
                                    continue 'reconnect;
                                }
                            }
                        }
                    }

                    if last_sent_sync.elapsed() >= Duration::from_secs(SENT_SYNC_INTERVAL_SECS) {
                        let ag_on = db.agent_config().map(|c| c.enabled).unwrap_or(false);
                        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            rt.sync_sent(&acc, &db, ag_on)
                        })) {
                            Ok(Ok(sent_n)) => {
                                watcher.touch_live();
                                last_sent_sync = Instant::now();
                                if sent_n > 0 {
                                    let _ = app.emit(
                                        "mail-updated",
                                        SyncReport {
                                            new_incoming: sent_n,
                                            agent_processed: 0,
                                            error: None,
                                        },
                                    );
                                }
                            }
                            _ => {
                                watcher.set_socket(None);
                                continue 'reconnect;
                            }
                        }
                    }
                }
            }
        });
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
    let spec = config::build_spec(&state.db).map_err(err)?;
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn apply_declarative_config(state: State<AppState>, toml: String) -> CmdResult<DeclarativeBundle> {
    let prev_spec = config::build_spec(&state.db).unwrap_or_default();
    let normalized = config::apply_toml(&state.app_dir, &toml, &state.db, &state.vault).map_err(err)?;
    let rules = state.db.rules().map_err(err)?;
    let _ = state.db.scan_existing_with_rules(|from, subject, body| {
        agent::apply_rules(&rules, from, subject, body).map(|h| (h.status, h.reason))
    });
    let next_spec = config::build_spec(&state.db).map_err(err)?;
    let mail_changed = prev_spec.active_account != next_spec.active_account
        || serde_json::to_string(&prev_spec.accounts).ok() != serde_json::to_string(&next_spec.accounts).ok();
    if mail_changed {
        state.watcher.reconnect_now();
    }
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml: normalized,
        spec: next_spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn apply_declarative_spec(
    state: State<AppState>,
    spec: config::DeclarativeConfig,
) -> CmdResult<DeclarativeBundle> {
    let prev_spec = config::build_spec(&state.db).unwrap_or_default();
    let normalized =
        config::apply_spec(&state.app_dir, &spec, &state.db, &state.vault).map_err(err)?;
    let rules = state.db.rules().map_err(err)?;
    let _ = state.db.scan_existing_with_rules(|from, subject, body| {
        agent::apply_rules(&rules, from, subject, body).map(|h| (h.status, h.reason))
    });
    let next_spec = config::build_spec(&state.db).map_err(err)?;
    let mail_changed = prev_spec.active_account != next_spec.active_account
        || serde_json::to_string(&prev_spec.accounts).ok() != serde_json::to_string(&next_spec.accounts).ok();
    if mail_changed {
        state.watcher.reconnect_now();
    }
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml: normalized,
        spec: next_spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn list_secrets(state: State<AppState>) -> CmdResult<Vec<SecretStatus>> {
    Ok(vault_statuses(&state.db, &state.vault))
}

#[tauri::command]
async fn set_secret(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
    verify: bool,
) -> CmdResult<SecretSaveResult> {
    let raw_clean = key.trim().trim_start_matches("secret:").to_string();
    if value.trim().is_empty() {
        return Err("输入的凭据内容不能为空".into());
    }
    let clean_key = if raw_clean == "mail_password" {
        let active_em = state.db.active_account_email().unwrap_or_default();
        mail_secret_key(&active_em)
    } else {
        raw_clean
    };
    state.vault.set(&clean_key, &value).map_err(err)?;

    let mut verified = false;
    let mut message = format!("{} 已通过本地 DPAPI 加密保存", secret_label(&clean_key));
    let is_mail_secret = clean_key == "mail_password" || clean_key.starts_with("mail_pwd:");
    let target_mail_email = clean_key
        .strip_prefix("mail_pwd:")
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| state.db.active_account_email().unwrap_or_default());

    if clean_key.starts_with("llm_") {
        if let Ok(mut ag) = state.db.agent_config() {
            let target_preset = clean_key.trim_start_matches("llm_");
            let (_, def_base, def_model) = config::model_preset_defaults(target_preset);
            if !def_base.is_empty() && !ag.profiles.contains_key(target_preset) {
                ag.profiles.insert(
                    target_preset.to_string(),
                    ProviderProfile {
                        base_url: def_base.to_string(),
                        api_key: String::new(),
                        model: def_model.to_string(),
                    },
                );
            }
            if ag.preset == target_preset || !ag.enabled {
                ag.enabled = true;
            }
            let _ = state.db.save_agent_config(&ag);
            refresh_disk_toml(&state);
        }
    }

    let active_email = state.db.active_account_email().unwrap_or_default();
    if is_mail_secret && (active_email.is_empty() || active_email == target_mail_email) {
        state.watcher.reconnect_now();
    }

    if verify {
        if is_mail_secret {
            let hydrated = if !target_mail_email.is_empty() {
                config::hydrated_account_for(&state.db, &state.vault, &target_mail_email).map_err(err)?
            } else {
                config::hydrated_account(&state.db, &state.vault).map_err(err)?
            };
            if let Some(acc) = hydrated {
                if !acc.imap_host.is_empty() && !acc.smtp_host.is_empty() {
                    let acc_em = acc.email.clone();
                    spawn_mail_blocking(move || mail::test_account(&acc)).await?;
                    verified = true;
                    message = format!(
                        "{acc_em} 授权码加密保存成功，IMAP/SMTP 连接验证通过{}！",
                        if acc_em == active_email { "，已开启实时收信" } else { "" }
                    );
                    if acc_em == active_email {
                        let (db, vault, syncing, watcher) = (
                            state.db.clone(),
                            state.vault.clone(),
                            state.syncing.clone(),
                            state.watcher.clone(),
                        );
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            run_sync(&handle, db, vault, syncing, watcher).await
                        });
                    }
                } else {
                    message = "邮箱授权码已加密保存（尚未绑定邮箱服务器地址，绑定后将自动校验连通）".into();
                }
            } else {
                message = "邮箱授权码已加密保存（绑定邮箱地址后将自动启用同步）".into();
            }
        } else if clean_key.starts_with("llm_") {
            let ag = state.db.agent_config().map_err(err)?;
            let target_preset = clean_key.trim_start_matches("llm_");
            let mut test_cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
            if test_cfg.preset != target_preset && target_preset != "custom" {
                let (prov, def_base, def_model) = config::model_preset_defaults(target_preset);
                let prof = ag.profiles.get(target_preset);
                test_cfg.preset = target_preset.to_string();
                test_cfg.provider = prov.to_string();
                test_cfg.base_url = prof
                    .map(|p| p.base_url.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(def_base)
                    .to_string();
                test_cfg.model = prof
                    .map(|p| p.model.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(def_model)
                    .to_string();
            }
            test_cfg.api_key = value.trim().to_string();

            let v = agent::classify(
                &test_cfg,
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

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    Ok(SecretSaveResult {
        secrets: vault_statuses(&state.db, &state.vault),
        verified,
        message,
    })
}

#[tauri::command]
fn delete_secret(state: State<AppState>, key: String) -> CmdResult<Vec<SecretStatus>> {
    let clean = key.trim().trim_start_matches("secret:");
    state.vault.delete(clean).map_err(err)?;
    if clean == "mail_password" || clean.starts_with("mail_pwd:") {
        state.watcher.reconnect_now();
    }
    Ok(vault_statuses(&state.db, &state.vault))
}

#[tauri::command]
fn cancel_agent_chat(state: State<AppState>, request_id: Option<String>) -> CmdResult<()> {
    let guard = state.agent_cancels.lock().unwrap();
    if let Some(rid) = request_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(flag) = guard.get(rid) {
            flag.store(true, Ordering::Relaxed);
        }
    } else {
        for flag in guard.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
fn list_agent_sessions(state: State<AppState>) -> CmdResult<Vec<AgentSessionSummary>> {
    state.db.list_agent_sessions().map_err(err)
}

#[tauri::command]
fn create_agent_session(
    state: State<AppState>,
    title: Option<String>,
) -> CmdResult<AgentSessionSummary> {
    state
        .db
        .create_agent_session(title.as_deref())
        .map_err(err)
}

#[tauri::command]
fn get_agent_session_turns(
    state: State<AppState>,
    session_id: String,
) -> CmdResult<Vec<AgentTurnRecord>> {
    state.db.get_agent_session_turns(&session_id).map_err(err)
}

#[tauri::command]
fn delete_agent_session(
    state: State<AppState>,
    session_id: String,
) -> CmdResult<Vec<AgentSessionSummary>> {
    state.db.delete_agent_session(&session_id).map_err(err)?;
    state.db.list_agent_sessions().map_err(err)
}

#[tauri::command]
fn clear_agent_session_turns(
    state: State<AppState>,
    session_id: String,
) -> CmdResult<Vec<AgentSessionSummary>> {
    state
        .db
        .clear_agent_session_turns(&session_id)
        .map_err(err)?;
    state.db.list_agent_sessions().map_err(err)
}

/// 零延迟原子切换当前激活模型服务商或模型名称（不调用远端 LLM，直接更新 AgentConfig 与 config.toml）
#[tauri::command]
fn switch_active_model(
    state: State<AppState>,
    preset: String,
    model: Option<String>,
) -> CmdResult<ModelSwitchResult> {
    let target_preset = preset.trim().to_lowercase();
    if target_preset.is_empty() {
        return Err("模型预设标识不能为空".into());
    }

    let mut ag = state.db.agent_config().map_err(err)?;
    // 先保存切换前预设的当前连接配置
    let prev_preset = ag.preset.trim().to_lowercase();
    if !prev_preset.is_empty() {
        ag.profiles.insert(
            prev_preset,
            ProviderProfile {
                base_url: ag.base_url.clone(),
                api_key: String::new(),
                model: ag.model.clone(),
            },
        );
    }

    let (def_prov, def_base, def_model) = config::model_preset_defaults(&target_preset);
    let saved_prof = ag.profiles.get(&target_preset).cloned();

    ag.preset = target_preset.clone();
    if target_preset != "custom" {
        ag.provider = def_prov.to_string();
    } else if ag.provider.trim().is_empty() {
        ag.provider = "openai".to_string();
    }

    let resolved_base = saved_prof
        .as_ref()
        .map(|p| p.base_url.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(def_base)
        .to_string();
    if !resolved_base.is_empty() || target_preset != "custom" {
        ag.base_url = resolved_base;
    }

    let resolved_model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            saved_prof
                .as_ref()
                .map(|p| p.model.trim())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(def_model)
        .to_string();
    if !resolved_model.is_empty() {
        ag.model = resolved_model;
    }

    // 若对应服务商密钥已配置或支持免密直连，切换时自动启用 AI 分拣
    let key_ready = llm_secret_key(&target_preset)
        .map(|sk| state.vault.get(sk).is_some())
        .unwrap_or(true)
        || matches!(target_preset.as_str(), "ollama" | "ollama_remote" | "custom");
    if key_ready {
        ag.enabled = true;
    }

    ag.profiles.insert(
        target_preset,
        ProviderProfile {
            base_url: ag.base_url.clone(),
            api_key: String::new(),
            model: ag.model.clone(),
        },
    );

    ag.api_key.clear();
    for p in ag.profiles.values_mut() {
        p.api_key.clear();
    }

    state.db.save_agent_config(&ag).map_err(err)?;
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;

    Ok(ModelSwitchResult {
        agent_config: ag,
        bundle: DeclarativeBundle {
            path: config_file_path(&state),
            toml,
            spec,
            secrets: vault_statuses(&state.db, &state.vault),
        },
    })
}

#[tauri::command]
async fn chat_with_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    history: Vec<agent::ChatTurn>,
    session_id: Option<String>,
    request_id: Option<String>,
) -> CmdResult<AgentChatResponse> {
    let sid = state
        .db
        .ensure_agent_session(session_id.as_deref())
        .map_err(err)?;
    let req_id = request_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("req-{}", uuid::Uuid::new_v4().simple()));

    // 若前端未传 history，自动从 SQLite 会话历史恢复最近上下文
    let effective_history: Vec<agent::ChatTurn> = if !history.is_empty() {
        history
    } else {
        state
            .db
            .get_agent_session_turns(&sid)
            .unwrap_or_default()
            .into_iter()
            .map(|r| agent::ChatTurn {
                role: r.role,
                content: r.content,
            })
            .collect()
    };

    // 持久化用户本轮配置请求（自动脱敏可能误输的明文密钥）
    let safe_user_content = agent::sanitize_user_input_for_history(&message);
    let _ = state.db.append_agent_turn(&NewAgentTurn {
        session_id: &sid,
        role: "user",
        content: &safe_user_content,
        thinking: "",
        thinking_ms: 0,
        tool_steps: &[],
        changes: &[],
        config_diff: None,
        secret_prompts: &[],
        suggestions: &[],
    });

    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let stats = state.db.stats().unwrap_or_default();
    let current_toml = config::export_toml(&state.db).map_err(err)?;
    let statuses = vault_statuses(&state.db, &state.vault);

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        state
            .agent_cancels
            .lock()
            .unwrap()
            .insert(req_id.clone(), cancel_flag.clone());
    }

    let app_for_stream = app.clone();
    let sid_for_stream = sid.clone();
    let rid_for_stream = req_id.clone();
    let spec_for_stream = spec.clone();
    let base_toml_for_stream = current_toml.clone();

    let mut plan = agent::chat_config_agent_stream(
        &cfg,
        &spec,
        &stats,
        &current_toml,
        &statuses,
        &effective_history,
        &message,
        &cancel_flag,
        |ev| match ev {
            agent::ConfigAgentStreamEvent::ThinkingDelta { delta, thinking_ms } => {
                let _ = app_for_stream.emit(
                    "agent-chat-stream",
                    AgentStreamPayload {
                        request_id: rid_for_stream.clone(),
                        session_id: sid_for_stream.clone(),
                        kind: "thinking".into(),
                        delta: delta.to_string(),
                        thinking_ms,
                    },
                );
            }
            agent::ConfigAgentStreamEvent::ContentDelta { delta } => {
                let _ = app_for_stream.emit(
                    "agent-chat-stream",
                    AgentStreamPayload {
                        request_id: rid_for_stream.clone(),
                        session_id: sid_for_stream.clone(),
                        kind: "content".into(),
                        delta: delta.to_string(),
                        thinking_ms: 0,
                    },
                );
            }
            agent::ConfigAgentStreamEvent::ToolStep { step } => {
                let _ = app_for_stream.emit(
                    "agent-chat-stream",
                    AgentStreamPayload {
                        request_id: rid_for_stream.clone(),
                        session_id: sid_for_stream.clone(),
                        kind: "tool".into(),
                        delta: step.to_string(),
                        thinking_ms: 0,
                    },
                );
            }
            agent::ConfigAgentStreamEvent::DraftToml {
                toml,
                spec: draft_spec,
            } => {
                let _ = app_for_stream.emit(
                    "agent-chat-stream",
                    AgentStreamPayload {
                        request_id: rid_for_stream.clone(),
                        session_id: sid_for_stream.clone(),
                        kind: "toml".into(),
                        delta: toml.to_string(),
                        thinking_ms: 0,
                    },
                );
                let live_diff = config::diff_specs(
                    &spec_for_stream,
                    draft_spec,
                    &base_toml_for_stream,
                    toml,
                    None,
                );
                if let Ok(preview_json) = serde_json::to_string(&serde_json::json!({
                    "spec": draft_spec,
                    "config_diff": live_diff,
                })) {
                    let _ = app_for_stream.emit(
                        "agent-chat-stream",
                        AgentStreamPayload {
                            request_id: rid_for_stream.clone(),
                            session_id: sid_for_stream.clone(),
                            kind: "spec_preview".into(),
                            delta: preview_json,
                            thinking_ms: 0,
                        },
                    );
                }
            }
        },
    )
    .await;

    {
        state.agent_cancels.lock().unwrap().remove(&req_id);
    }

    let mut should_reconnect_mail = false;
    if let Some((sk, raw_val)) = &plan.intercepted_secret {
        state.vault.set(sk, raw_val).map_err(err)?;
        if sk == "mail_password" || sk.starts_with("mail_pwd:") {
            should_reconnect_mail = true;
        }
    }

    let final_toml = if let Some(new_toml) = &plan.updated_toml {
        match config::apply_toml(&state.app_dir, new_toml, &state.db, &state.vault) {
            Ok(normalized) => {
                should_reconnect_mail = true;
                normalized
            }
            Err(e) => {
                plan.reply.push_str(&format!("\n\n（注：生成的声明式配置校验未通过：{e:#}，已保留原配置）"));
                plan.changes.clear();
                current_toml.clone()
            }
        }
    } else {
        current_toml.clone()
    };

    if should_reconnect_mail {
        state.watcher.reconnect_now();
    }

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
                let (db, vault, syncing, watcher) = (
                    state.db.clone(),
                    state.vault.clone(),
                    state.syncing.clone(),
                    state.watcher.clone(),
                );
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { run_sync(&handle, db, vault, syncing, watcher).await });
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
    let latest_spec = config::build_spec(&state.db).unwrap_or_else(|_| spec.clone());
    let latest_secrets = vault_statuses(&state.db, &state.vault);

    let raw_diff = config::diff_specs(
        &spec,
        &latest_spec,
        &current_toml,
        &latest_toml,
        plan.intercepted_secret.as_ref().map(|(k, _)| k.as_str()),
    );
    let config_diff = if !raw_diff.items.is_empty() || current_toml.trim() != latest_toml.trim() {
        Some(raw_diff)
    } else {
        None
    };

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
            let hint = if k == "mail_password" || k.starts_with("mail_pwd:") {
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

    let _ = state.db.append_agent_turn(&NewAgentTurn {
        session_id: &sid,
        role: "assistant",
        content: &plan.reply,
        thinking: &plan.thinking,
        thinking_ms: plan.thinking_ms as i64,
        tool_steps: &plan.tool_steps,
        changes: &plan.changes,
        config_diff: config_diff.as_ref(),
        secret_prompts: &secret_prompts,
        suggestions: &plan.suggestions,
    });

    let sessions = state.db.list_agent_sessions().unwrap_or_default();

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    Ok(AgentChatResponse {
        session_id: sid,
        reply: plan.reply,
        thinking: plan.thinking,
        thinking_ms: plan.thinking_ms as i64,
        tool_steps: plan.tool_steps,
        changes: plan.changes,
        config_diff,
        toml: latest_toml,
        spec: latest_spec,
        secrets: latest_secrets,
        secret_prompts,
        suggestions: plan.suggestions,
        sessions,
    })
}

#[tauri::command]
fn list_accounts(state: State<AppState>) -> CmdResult<Vec<AccountEntry>> {
    build_account_entries(&state.db, &state.vault)
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
async fn save_account(
    app: AppHandle,
    state: State<'_, AppState>,
    mut account: Account,
    set_active: Option<bool>,
) -> CmdResult<Vec<AccountEntry>> {
    let email = account.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err("请填写有效的邮箱地址".into());
    }
    account.email = email.clone();
    if account.username.trim().is_empty() {
        account.username = email.clone();
    }

    let sk = mail_secret_key(&email);
    let typed_pwd = account.password.trim().to_string();
    let full_password = if !typed_pwd.is_empty() {
        typed_pwd.clone()
    } else {
        state.vault.get(&sk).unwrap_or_default()
    };
    if full_password.is_empty() {
        return Err("请填写该邮箱的 IMAP/SMTP 授权码（密码将独立加密存入本地 DPAPI 保险箱）".into());
    }

    let mut test_acc = account.clone();
    test_acc.password = full_password;
    spawn_mail_blocking(move || mail::test_account(&test_acc)).await?;

    if !typed_pwd.is_empty() {
        state.vault.set(&sk, &typed_pwd).map_err(err)?;
    }

    let activate = set_active.unwrap_or(true);
    account.password.clear();
    state.db.upsert_account(&account, activate).map_err(err)?;
    refresh_disk_toml(&state);

    let active_now = state.db.active_account_email().unwrap_or_default();
    if active_now == email {
        state.watcher.reconnect_now();
        let (db, vault, syncing, watcher) = (
            state.db.clone(),
            state.vault.clone(),
            state.syncing.clone(),
            state.watcher.clone(),
        );
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            run_sync(&handle, db, vault, syncing, watcher).await
        });
    }

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    build_account_entries(&state.db, &state.vault)
}

#[tauri::command]
fn switch_account(
    app: AppHandle,
    state: State<AppState>,
    email: String,
) -> CmdResult<Vec<AccountEntry>> {
    let prev = state.db.active_account_email().unwrap_or_default();
    let acc = state.db.set_active_account(&email).map_err(err)?;
    refresh_disk_toml(&state);

    if acc.email != prev {
        state.watcher.reconnect_now();
        let (db, vault, syncing, watcher) = (
            state.db.clone(),
            state.vault.clone(),
            state.syncing.clone(),
            state.watcher.clone(),
        );
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            run_sync(&handle, db, vault, syncing, watcher).await
        });
    }

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    build_account_entries(&state.db, &state.vault)
}

#[tauri::command]
fn remove_account(
    app: AppHandle,
    state: State<AppState>,
    email: String,
    delete_local_data: Option<bool>,
) -> CmdResult<Vec<AccountEntry>> {
    let target = email.trim().to_lowercase();
    let prev_active = state.db.active_account_email().unwrap_or_default();
    let next_acc = state
        .db
        .remove_account(&target, delete_local_data.unwrap_or(false))
        .map_err(err)?;
    let _ = state.vault.delete(&mail_secret_key(&target));
    refresh_disk_toml(&state);

    if prev_active == target {
        state.watcher.reconnect_now();
        if next_acc.is_some() {
            let (db, vault, syncing, watcher) = (
                state.db.clone(),
                state.vault.clone(),
                state.syncing.clone(),
                state.watcher.clone(),
            );
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                run_sync(&handle, db, vault, syncing, watcher).await
            });
        }
    }

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    build_account_entries(&state.db, &state.vault)
}

#[tauri::command]
fn reorder_accounts(
    app: AppHandle,
    state: State<AppState>,
    emails: Vec<String>,
) -> CmdResult<Vec<AccountEntry>> {
    state.db.reorder_accounts(&emails).map_err(err)?;
    refresh_disk_toml(&state);
    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );
    build_account_entries(&state.db, &state.vault)
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
    Ok(run_sync(
        &app,
        state.db.clone(),
        state.vault.clone(),
        state.syncing.clone(),
        state.watcher.clone(),
    )
    .await)
}

#[tauri::command]
fn poke_mail_sync(state: State<AppState>) -> CmdResult<()> {
    state.watcher.poke();
    Ok(())
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
fn get_contact_profile(state: State<AppState>, email: String) -> CmdResult<ContactProfile> {
    state.db.get_contact_profile(&email).map_err(err)
}

#[tauri::command]
fn save_contact_profile(
    state: State<AppState>,
    profile: ContactProfile,
) -> CmdResult<ContactProfile> {
    let prev_muted = state
        .db
        .get_contact_profile(&profile.email)
        .map(|p| p.muted)
        .unwrap_or(false);
    let saved = state.db.save_contact_profile(&profile).map_err(err)?;
    if prev_muted != saved.muted {
        let target = if saved.muted { "archived" } else { "inbox" };
        let _ = state.db.move_peer(&saved.email, target);
    }
    Ok(saved)
}

fn resolve_safe_attachment_path(state: &AppState, rel_path: &str) -> CmdResult<PathBuf> {
    let clean = rel_path.trim();
    if clean.is_empty()
        || clean.contains("..")
        || clean.contains('/')
        || clean.contains('\\')
        || clean.contains(':')
        || clean.chars().any(|c| c.is_control())
    {
        return Err("非法的本地附件路径".into());
    }
    let full = state.db.attachments_dir().join(clean);
    if !full.exists() {
        return Err("本地附件文件不存在或已被清理".into());
    }
    Ok(full)
}

#[tauri::command]
fn read_attachment_data_url(state: State<AppState>, rel_path: String) -> CmdResult<String> {
    let full = resolve_safe_attachment_path(&state, &rel_path)?;
    let bytes = std::fs::read(&full).map_err(err)?;
    let mime_raw = mail::infer_mime_type(&rel_path, "", &bytes);
    let mime = mime_raw
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim();
    Ok(format!("data:{mime};base64,{}", mail::base64_encode(&bytes)))
}

#[cfg(target_os = "windows")]
fn win_shell_open(target: &str) -> CmdResult<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const u8) -> isize;
        fn GetProcAddress(h_module: isize, lp_proc_name: *const u8) -> *const core::ffi::c_void;
    }
    type ShellExecuteWFn = unsafe extern "system" fn(
        isize,
        *const u16,
        *const u16,
        *const u16,
        *const u16,
        i32,
    ) -> isize;

    let op: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let file: Vec<u16> = std::ffi::OsStr::new(target)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ret = unsafe {
        let hmod = LoadLibraryA(b"shell32.dll\0".as_ptr());
        if hmod == 0 {
            return Err("无法加载系统 shell32 组件".into());
        }
        let proc_ptr = GetProcAddress(hmod, b"ShellExecuteW\0".as_ptr());
        if proc_ptr.is_null() {
            return Err("无法定位 ShellExecuteW 入口".into());
        }
        let func: ShellExecuteWFn = core::mem::transmute(proc_ptr);
        func(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
    };
    if ret <= 32 {
        return Err(format!("系统默认程序打开失败 (code {ret})"));
    }
    Ok(())
}

#[tauri::command]
fn open_attachment(state: State<AppState>, rel_path: String) -> CmdResult<()> {
    let full = resolve_safe_attachment_path(&state, &rel_path)?;
    #[cfg(target_os = "windows")]
    {
        win_shell_open(&full.to_string_lossy())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&full)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&full)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
}

#[tauri::command]
fn reveal_attachment(state: State<AppState>, rel_path: String) -> CmdResult<()> {
    let full = resolve_safe_attachment_path(&state, &rel_path)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", full.to_string_lossy()))
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&full)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = full.parent().unwrap_or_else(|| std::path::Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    peer: String,
    body: String,
    custom_subject: Option<String>,
    attachments: Option<Vec<SendAttachmentInput>>,
    reply_to_id: Option<i64>,
) -> CmdResult<MessageDto> {
    let incoming_atts = attachments.unwrap_or_default();
    if body.trim().is_empty() && incoming_atts.is_empty() {
        return Err("消息内容与附件不能同时为空".into());
    }

    let active_scope = state.db.active_scope_email().map_err(err)?;
    let raw_peer = peer.trim();
    let is_group = raw_peer.starts_with("group:");
    let (peer, recipients, group_id, group_name, grp_muted) = if is_group {
        let grp = state
            .db
            .get_group_for(&active_scope, raw_peer)
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

    let mut saved_metas: Vec<AttachmentMeta> = Vec::with_capacity(incoming_atts.len());
    let mut outgoing_atts: Vec<mail::OutgoingAttachment> = Vec::with_capacity(incoming_atts.len());
    for item in incoming_atts {
        let bytes = mail::base64_decode(&item.data_base64).map_err(err)?;
        let meta = mail::save_attachment_bytes(
            state.db.attachments_dir(),
            &item.filename,
            &item.mime,
            &bytes,
        )
        .map_err(err)?;
        outgoing_atts.push(mail::OutgoingAttachment {
            filename: meta.filename.clone(),
            mime: meta.mime.clone(),
            bytes,
        });
        saved_metas.push(meta);
    }

    let (ctx, reply_quote) = if let Some(rid) = reply_to_id {
        match state.db.reply_context_by_id_for(&active_scope, rid).map_err(err)? {
            Some((explicit_ctx, quote)) => (Some(explicit_ctx), Some(quote)),
            None => (state.db.reply_context_for(&active_scope, &peer).map_err(err)?, None),
        }
    } else {
        (state.db.reply_context_for(&active_scope, &peer).map_err(err)?, None)
    };

    let acc_opt = if active_scope != db::UNBOUND_SCOPE {
        config::hydrated_account_for(&state.db, &state.vault, &active_scope).map_err(err)?
    } else {
        config::hydrated_account(&state.db, &state.vault).map_err(err)?
    };

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

    let clean_body_text = body.trim().to_string();
    let smtp_body = if let Some(q) = &reply_quote {
        let quote_line = format!("> {}: {}", q.sender, q.snippet);
        if clean_body_text.is_empty() {
            quote_line
        } else {
            format!("{clean_body_text}\n\n{quote_line}")
        }
    } else {
        body.clone()
    };
    let quote_mid = reply_quote.as_ref().map(|q| q.message_id.clone());

    let (mid, from_addr, from_name, folder) = match acc_opt {
        Some(acc) if !acc.password.is_empty() && !acc.smtp_host.is_empty() => {
            let acc2 = acc.clone();
            let (rcpts, subj, b, irt, refs, gid, gname, qmid, out_atts) = (
                recipients.clone(),
                subject.clone(),
                smtp_body.clone(),
                in_reply_to.clone(),
                references.clone(),
                group_id.clone(),
                group_name.clone(),
                quote_mid,
                outgoing_atts,
            );
            let mid = spawn_mail_blocking(move || {
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
                        quote_mid: qmid,
                        attachments: out_atts,
                    },
                )
            })
            .await?;
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

    let contact_muted = !is_group
        && state
            .db
            .is_contact_muted_for(&active_scope, &peer)
            .unwrap_or(false);
    let target_status = if (is_group && grp_muted) || contact_muted {
        "archived"
    } else {
        "inbox"
    };
    let category = if is_group { "群聊".to_string() } else { String::new() };

    let id = state
        .db
        .insert_message_for(
            &active_scope,
            &NewMessage {
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
                body: clean_body_text,
                body_full: smtp_body,
                body_html: String::new(),
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
                attachments: saved_metas,
                reply_to: reply_quote,
            },
        )
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
        state
            .db
            .get_contact_profile(&peer)
            .ok()
            .map(|p| p.alias)
            .filter(|a| !a.trim().is_empty())
            .unwrap_or_else(|| peer.clone())
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

#[tauri::command]
fn start_screen_snip() -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    {
        win_shell_open("ms-screenclip:")
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("screencapture")
            .args(["-i", "-c"])
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Err("当前系统暂不支持快捷截图唤起，请使用系统截图后按 Ctrl+V 粘贴".into())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> CmdResult<()> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("仅支持打开 http / https / mailto 链接".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("链接包含非法控制字符".into());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryA(lp_lib_file_name: *const u8) -> isize;
            fn GetProcAddress(h_module: isize, lp_proc_name: *const u8) -> *const core::ffi::c_void;
        }
        type ShellExecuteWFn = unsafe extern "system" fn(
            isize,
            *const u16,
            *const u16,
            *const u16,
            *const u16,
            i32,
        ) -> isize;

        let op: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let file: Vec<u16> = std::ffi::OsStr::new(trimmed)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ret = unsafe {
            let hmod = LoadLibraryA(b"shell32.dll\0".as_ptr());
            if hmod == 0 {
                return Err("无法加载系统 shell32 组件".into());
            }
            let proc_ptr = GetProcAddress(hmod, b"ShellExecuteW\0".as_ptr());
            if proc_ptr.is_null() {
                return Err("无法定位 ShellExecuteW 入口".into());
            }
            let func: ShellExecuteWFn = core::mem::transmute(proc_ptr);
            func(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
        };
        if ret <= 32 {
            return Err(format!("无法调用系统浏览器打开链接 (code {ret})"));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(err)?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
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
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = win.set_icon(icon);
                }
            }

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Arc::new(Db::open(&dir.join("mailchat.db"))?);
            let _ = db.reclean_all_bodies(mail::clean_body);
            let vault = Arc::new(Vault::open(&dir)?);

            // 自动将旧库中的明文密钥迁移至系统 DPAPI 隐私保险箱
            config::migrate_legacy_secrets(&db, &vault);

            // 若磁盘已存在用户手工修改过的 config.toml 则加载对账，否则生成初始声明式配置文件
            let cfg_file = dir.join("config.toml");
            if cfg_file.exists() {
                if let Ok(mut raw) = std::fs::read_to_string(&cfg_file) {
                    // 将早期未配置密钥的旧默认模型名平滑升级为 deepseek-v4.1-flash，并同步升级旧版 OpenCode Go 网关路径
                    if !raw.contains("deepseek-v4.1-flash")
                        && raw.contains("preset = \"deepseek\"")
                        && raw.contains("model = \"deepseek-chat\"")
                        && vault.get("llm_deepseek").is_none()
                    {
                        raw = raw.replace("model = \"deepseek-chat\"", "model = \"deepseek-v4.1-flash\"");
                    }
                    if raw.contains("https://opencode.ai/zen/go/v1") {
                        raw = raw.replace(
                            "https://opencode.ai/zen/go/v1",
                            "https://opencode.ai/inference/go/openai/v1",
                        );
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
            let watcher = Arc::new(WatcherControl::new());
            app.manage(AppState {
                app_dir: dir,
                db: db.clone(),
                vault: vault.clone(),
                syncing: syncing.clone(),
                watcher: watcher.clone(),
                agent_cancels: Mutex::new(HashMap::new()),
            });

            let handle = app.handle().clone();
            spawn_agent_triage(handle.clone(), db.clone(), vault.clone(), watcher.clone());
            spawn_realtime_imap_watcher(handle, db, vault, watcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_declarative_config,
            apply_declarative_config,
            apply_declarative_spec,
            list_secrets,
            set_secret,
            delete_secret,
            chat_with_agent,
            cancel_agent_chat,
            list_agent_sessions,
            create_agent_session,
            get_agent_session_turns,
            delete_agent_session,
            clear_agent_session_turns,
            switch_active_model,
            list_accounts,
            get_account,
            save_account,
            switch_account,
            remove_account,
            reorder_accounts,
            get_agent_config,
            save_agent_config,
            test_agent,
            fetch_models,
            window_action,
            reclassify_messages,
            sync_now,
            poke_mail_sync,
            get_stats,
            list_conversations,
            list_messages,
            list_contacts,
            create_group,
            get_group,
            update_group,
            get_contact_profile,
            save_contact_profile,
            read_attachment_data_url,
            open_attachment,
            reveal_attachment,
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
            start_screen_snip,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
