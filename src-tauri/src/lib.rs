mod agent;
mod config;
mod db;
mod kernel;
mod llm;
mod magpie;
mod mail;
mod privacy;
mod tray;
mod updater;
mod vault;

use db::{
    Account, AgentConfig, AgentSessionSummary, AgentTurnRecord, AttachmentMeta, ContactProfile,
    Conversation, Db, GroupInfo, GroupMember, MailboxStats, MessageDto, NewAgentTurn, NewMessage,
    NewReplyQueueItem, ProviderProfile, ReplyQueueItem, ReplyQueueStats, Rule, ThemeConfig,
    UpdateConfig, WindowConfig,
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

pub(crate) struct WatcherControl {
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
    pub(crate) fn reconnect_now(&self) {
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

#[derive(Default)]
struct DockWindowState {
    expanded: bool,
    added_phys_w: u32,
    shifted_left_px: i32,
    post_shift_x: Option<i32>,
}

pub(crate) struct AppState {
    pub(crate) app_dir: PathBuf,
    pub(crate) db: Arc<Db>,
    pub(crate) vault: Arc<Vault>,
    pub(crate) syncing: Arc<AtomicBool>,
    pub(crate) watcher: Arc<WatcherControl>,
    pub(crate) tray: Arc<tray::TrayAlertManager>,
    pub(crate) updater: Arc<updater::UpdaterManager>,
    pub(crate) agent_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    dock_win: Mutex<DockWindowState>,
}

type CmdResult<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
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
pub(crate) struct SyncReport {
    pub(crate) new_incoming: usize,
    pub(crate) agent_processed: usize,
    pub(crate) error: Option<String>,
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
    turns: Vec<AgentTurnRecord>,
}

#[derive(Serialize)]
struct RewindAgentResponse {
    turns: Vec<AgentTurnRecord>,
    sessions: Vec<AgentSessionSummary>,
    config_restored: bool,
    bundle: DeclarativeBundle,
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

#[derive(Serialize)]
struct MagpieConnectResult {
    probe: magpie::MagpieProbeReport,
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

pub(crate) fn vault_statuses(db: &Db, vault: &Vault) -> Vec<SecretStatus> {
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
pub(crate) async fn run_sync(
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
        if let Ok(pol) = db.reply_policy() {
            let has_active_auto_rule = pol.auto_rules.iter().any(|r| r.enabled);
            if pol.enabled && (pol.auto_scan_on_sync || has_active_auto_rule) && !pol.enabled_accounts.is_empty() {
                let _ = run_unified_reply_scan(&app, &db, &vault, false).await;
            }
        }
        watcher.triaging.store(false, Ordering::SeqCst);
    });
}

pub(crate) async fn process_pending_with_agent(app: &AppHandle, db: &Arc<Db>, cfg: &AgentConfig) -> usize {
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

        let mut chunk_alert_inbox = false;
        for h in handles {
            let Ok((id, from_addr, body_full, existing_code, result)) = h.await else {
                continue;
            };
            let was_fresh_pending = app
                .try_state::<AppState>()
                .map(|st| st.tray.take_fresh_pending(id))
                .unwrap_or(false);
            let final_status: &str;
            match result {
                Ok(v) => {
                    let status = v.status();
                    final_status = status;
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
                    final_status = "inbox";
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
            if was_fresh_pending && final_status == "inbox" && db.is_unread_inbox_message(id) {
                chunk_alert_inbox = true;
            }
            processed += 1;
        }

        if let Some(st) = app.try_state::<AppState>() {
            if chunk_alert_inbox {
                st.tray.notify_new_inbox_messages(app, db);
            } else {
                st.tray.refresh_summary(db);
            }
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
            let db_hook = db.clone();
            let agent_on = cfg.enabled;
            let app_early = app.clone();
            match spawn_mail_blocking(move || {
                mail::sync_with_hook(&acc, &db2, agent_on, move |inbox_outcome| {
                    if let Some(st) = app_early.try_state::<AppState>() {
                        st.tray.handle_sync_outcome(&app_early, &db_hook, inbox_outcome);
                    }
                    let _ = app_early.emit(
                        "mail-updated",
                        SyncReport {
                            new_incoming: inbox_outcome.new_incoming,
                            agent_processed: 0,
                            error: None,
                        },
                    );
                })
            })
            .await
            {
                Ok(o) => {
                    report.new_incoming = o.new_incoming;
                    if let Some(st) = app.try_state::<AppState>() {
                        st.tray.refresh_summary(&db);
                    }
                }
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

                let emit_and_triage = |outcome: mail::SyncOutcome| {
                    if let Some(st) = app.try_state::<AppState>() {
                        st.tray.handle_sync_outcome(&app, &db, &outcome);
                    }
                    if outcome.new_incoming > 0 {
                        let _ = app.emit(
                            "mail-updated",
                            SyncReport {
                                new_incoming: outcome.new_incoming,
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
                    rt.sync_inbox_outcome(&acc, &db, agent_on)
                })) {
                    Ok(Ok(outcome)) => {
                        watcher.touch_live();
                        emit_and_triage(outcome);
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
                                    rt.sync_inbox_outcome(&acc, &db, ag_on)
                                })) {
                                    Ok(Ok(outcome)) => {
                                        watcher.touch_live();
                                        emit_and_triage(outcome);
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
                                rt.sync_inbox_outcome(&acc, &db, ag_on)
                            })) {
                                Ok(Ok(outcome)) => {
                                    watcher.touch_live();
                                    emit_and_triage(outcome);
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

pub(crate) fn current_me(db: &Db) -> String {
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
fn get_theme_config(state: State<AppState>) -> CmdResult<ThemeConfig> {
    state.db.theme_config().map_err(err)
}

#[tauri::command]
fn save_theme_config(
    app: AppHandle,
    state: State<AppState>,
    theme: ThemeConfig,
) -> CmdResult<DeclarativeBundle> {
    state.db.save_theme_config(&theme).map_err(err)?;
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let _ = app.emit("theme-updated", &spec.theme);
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn get_window_config(state: State<AppState>) -> CmdResult<WindowConfig> {
    state.db.window_config().map_err(err)
}

#[tauri::command]
fn save_window_config(
    app: AppHandle,
    state: State<AppState>,
    window_cfg: WindowConfig,
) -> CmdResult<DeclarativeBundle> {
    state.db.save_window_config(&window_cfg).map_err(err)?;
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let _ = app.emit("window-config-updated", &spec.window);
    state.tray.reconcile_config(&app, &state.db);
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn get_update_config(state: State<AppState>) -> CmdResult<UpdateConfig> {
    state.db.update_config().map_err(err)
}

#[tauri::command]
fn save_update_config(
    app: AppHandle,
    state: State<AppState>,
    update: UpdateConfig,
) -> CmdResult<DeclarativeBundle> {
    let norm = update.normalized();
    state.db.save_update_config(&norm).map_err(err)?;
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let _ = app.emit("update-config-updated", &spec.update);
    let snap = state.updater.snapshot(&spec.update.skipped_version);
    let _ = app.emit("app-update-status", &snap);
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn get_update_status(state: State<AppState>) -> CmdResult<updater::UpdateStatusSnapshot> {
    let cfg = state.db.update_config().unwrap_or_default();
    Ok(state.updater.snapshot(&cfg.skipped_version))
}

#[tauri::command]
async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: Option<bool>,
) -> CmdResult<updater::UpdateStatusSnapshot> {
    let cfg = state.db.update_config().unwrap_or_default();
    let updater = state.updater.clone();
    updater
        .check_for_updates(&app, &cfg, manual.unwrap_or(true))
        .await
        .map_err(err)
}

#[tauri::command]
async fn download_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<updater::UpdateStatusSnapshot> {
    let cfg = state.db.update_config().unwrap_or_default();
    let updater = state.updater.clone();
    updater
        .download_only(&app, &cfg.skipped_version)
        .await
        .map_err(err)
}

#[tauri::command]
async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<updater::UpdateStatusSnapshot> {
    let cfg = state.db.update_config().unwrap_or_default();
    let updater = state.updater.clone();
    let watcher = state.watcher.clone();
    let tray_mgr = state.tray.clone();
    updater
        .download_and_install_now(&app, &cfg.skipped_version, move || {
            tray_mgr.mark_quitting();
            watcher.interrupt_socket();
        })
        .await
        .map_err(err)
}

#[tauri::command]
fn skip_app_update_version(
    app: AppHandle,
    state: State<AppState>,
    version: String,
) -> CmdResult<DeclarativeBundle> {
    let mut cfg = state.db.update_config().unwrap_or_default();
    cfg.skipped_version = version.trim().trim_start_matches(['v', 'V']).to_string();
    state.db.save_update_config(&cfg).map_err(err)?;
    let toml = config::sync_disk_toml(&state.app_dir, &state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let _ = app.emit("update-config-updated", &spec.update);
    let snap = state.updater.snapshot(&spec.update.skipped_version);
    let _ = app.emit("app-update-status", &snap);
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml,
        spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn apply_declarative_config(
    app: AppHandle,
    state: State<AppState>,
    toml: String,
) -> CmdResult<DeclarativeBundle> {
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
    let _ = app.emit("theme-updated", &next_spec.theme);
    let _ = app.emit("window-config-updated", &next_spec.window);
    let _ = app.emit("update-config-updated", &next_spec.update);
    state.tray.reconcile_config(&app, &state.db);
    let snap = state.updater.snapshot(&next_spec.update.skipped_version);
    let _ = app.emit("app-update-status", &snap);
    Ok(DeclarativeBundle {
        path: config_file_path(&state),
        toml: normalized,
        spec: next_spec,
        secrets: vault_statuses(&state.db, &state.vault),
    })
}

#[tauri::command]
fn apply_declarative_spec(
    app: AppHandle,
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
    let _ = app.emit("theme-updated", &next_spec.theme);
    let _ = app.emit("window-config-updated", &next_spec.window);
    let _ = app.emit("update-config-updated", &next_spec.update);
    state.tray.reconcile_config(&app, &state.db);
    let snap = state.updater.snapshot(&next_spec.update.skipped_version);
    let _ = app.emit("app-update-status", &snap);
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

#[tauri::command]
fn rewind_agent_session(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    from_turn_id: i64,
    restore_config: bool,
) -> CmdResult<RewindAgentResponse> {
    let prev_spec = config::build_spec(&state.db).unwrap_or_default();
    let rollback_toml = state
        .db
        .rewind_agent_session(&session_id, from_turn_id)
        .map_err(err)?;

    let mut config_restored = false;
    if restore_config {
        if let Some(ref target_toml) = rollback_toml {
            if !target_toml.trim().is_empty() {
                config::apply_toml(&state.app_dir, target_toml, &state.db, &state.vault)
                    .map_err(err)?;
                if let Ok(rules) = state.db.rules() {
                    let _ = state.db.scan_existing_with_rules(|from, subject, body| {
                        agent::apply_rules(&rules, from, subject, body)
                            .map(|h| (h.status, h.reason))
                    });
                }
                let next_spec = config::build_spec(&state.db).unwrap_or_default();
                let mail_changed = prev_spec.active_account != next_spec.active_account
                    || serde_json::to_string(&prev_spec.accounts).ok()
                        != serde_json::to_string(&next_spec.accounts).ok();
                if mail_changed {
                    state.watcher.reconnect_now();
                }
                let _ = app.emit(
                    "mail-updated",
                    SyncReport {
                        new_incoming: 0,
                        agent_processed: 0,
                        error: None,
                    },
                );
                config_restored = true;
            }
        }
    }

    let toml = config::export_toml(&state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    if config_restored {
        let _ = app.emit("theme-updated", &spec.theme);
        let _ = app.emit("window-config-updated", &spec.window);
        let _ = app.emit("update-config-updated", &spec.update);
        state.tray.reconcile_config(&app, &state.db);
    }
    let turns = state.db.get_agent_session_turns(&session_id).map_err(err)?;
    let sessions = state.db.list_agent_sessions().map_err(err)?;

    Ok(RewindAgentResponse {
        turns,
        sessions,
        config_restored,
        bundle: DeclarativeBundle {
            path: config_file_path(&state),
            toml,
            spec,
            secrets: vault_statuses(&state.db, &state.vault),
        },
    })
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

    let fallback_base = if target_preset == "magpie" {
        magpie::configured_local_base_url()
    } else {
        def_base.to_string()
    };
    let resolved_base = saved_prof
        .as_ref()
        .map(|p| p.base_url.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&fallback_base)
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
    let is_local_magpie = target_preset == "magpie"
        && (ag.base_url.trim().is_empty() || magpie::is_loopback_url(&ag.base_url));
    let key_ready = is_local_magpie
        || llm_secret_key(&target_preset)
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

    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let stats = state.db.stats().unwrap_or_default();
    let current_toml = config::export_toml(&state.db).map_err(err)?;
    let statuses = vault_statuses(&state.db, &state.vault);

    // 持久化用户本轮配置请求及本轮执行前的脱敏 config.toml 检查点快照（自动脱敏可能误输的明文密钥）
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
        snapshot_toml: &current_toml,
        secret_prompts: &[],
        suggestions: &[],
    });

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
                if draft_spec.theme.normalized() != spec_for_stream.theme.normalized() {
                    let _ = app_for_stream.emit("theme-updated", &draft_spec.theme.normalized());
                }
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
                if let Ok(applied_spec) = config::build_spec(&state.db) {
                    if spec.active_account != applied_spec.active_account
                        || serde_json::to_string(&spec.accounts).ok()
                            != serde_json::to_string(&applied_spec.accounts).ok()
                    {
                        should_reconnect_mail = true;
                    }
                }
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
            "run_reply_scan" => {
                if let Ok(rep) = run_unified_reply_scan(&app, &state.db, &state.vault, false).await {
                    plan.changes.push(format!(
                        "统一批复与自动规则扫描完成：待审 {} 封，自动发出 {} 封",
                        rep.queued_review_count, rep.auto_sent_count
                    ));
                }
            }
            _ => {}
        }
    }

    let latest_toml = config::sync_disk_toml(&state.app_dir, &state.db).unwrap_or(final_toml);
    let latest_spec = config::build_spec(&state.db).unwrap_or_else(|_| spec.clone());
    let latest_secrets = vault_statuses(&state.db, &state.vault);
    let _ = app.emit("theme-updated", &latest_spec.theme);
    let _ = app.emit("window-config-updated", &latest_spec.window);
    let _ = app.emit("update-config-updated", &latest_spec.update);
    state.tray.reconcile_config(&app, &state.db);

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
        snapshot_toml: "",
        secret_prompts: &secret_prompts,
        suggestions: &plan.suggestions,
    });

    let turns = state.db.get_agent_session_turns(&sid).unwrap_or_default();
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
        turns,
    })
}

// ============================================================================
// 统一智能体内核（Unified Agent Kernel）多实例隔离 IPC 接口
// ============================================================================

#[tauri::command]
fn get_agent_instance_state(
    state: State<AppState>,
    instance_id: String,
) -> CmdResult<kernel::KernelInstanceSnapshot> {
    let kind = kernel::AgentInstanceKind::parse(&instance_id);
    let inst = kind.as_str();
    let mut sessions = state.db.list_instance_sessions(inst).map_err(err)?;
    let active_session_id = if let Some(first) = sessions.first() {
        first.id.clone()
    } else {
        let created = state.db.create_instance_session(inst, None).map_err(err)?;
        let sid = created.id.clone();
        sessions = vec![created];
        sid
    };
    let turns = state
        .db
        .get_instance_session_turns(inst, &active_session_id)
        .map_err(err)?;
    let agent_config = kernel::sanitize_agent_config_for_ui(
        state.db.instance_agent_config(inst).map_err(err)?,
    );
    let toml = config::export_toml(&state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    let secrets = vault_statuses(&state.db, &state.vault);

    Ok(kernel::KernelInstanceSnapshot {
        descriptor: kind.descriptor(),
        agent_config,
        sessions,
        active_session_id,
        turns,
        path: config_file_path(&state),
        toml,
        spec,
        secrets,
    })
}

#[tauri::command]
fn list_instance_sessions(
    state: State<AppState>,
    instance_id: String,
) -> CmdResult<Vec<AgentSessionSummary>> {
    state.db.list_instance_sessions(&instance_id).map_err(err)
}

#[tauri::command]
fn create_instance_session(
    state: State<AppState>,
    instance_id: String,
    title: Option<String>,
) -> CmdResult<AgentSessionSummary> {
    state
        .db
        .create_instance_session(&instance_id, title.as_deref())
        .map_err(err)
}

#[tauri::command]
fn get_instance_session_turns(
    state: State<AppState>,
    instance_id: String,
    session_id: String,
) -> CmdResult<Vec<AgentTurnRecord>> {
    state
        .db
        .get_instance_session_turns(&instance_id, &session_id)
        .map_err(err)
}

#[tauri::command]
fn delete_instance_session(
    state: State<AppState>,
    instance_id: String,
    session_id: String,
) -> CmdResult<Vec<AgentSessionSummary>> {
    state
        .db
        .delete_instance_session(&instance_id, &session_id)
        .map_err(err)?;
    state.db.list_instance_sessions(&instance_id).map_err(err)
}

#[tauri::command]
fn rewind_instance_session(
    app: AppHandle,
    state: State<AppState>,
    instance_id: String,
    session_id: String,
    from_turn_id: i64,
    restore_config: bool,
) -> CmdResult<RewindAgentResponse> {
    let kind = kernel::AgentInstanceKind::parse(&instance_id);
    let inst = kind.as_str();
    let prev_spec = config::build_spec(&state.db).unwrap_or_default();
    let rollback_toml = state
        .db
        .rewind_instance_session(inst, &session_id, from_turn_id)
        .map_err(err)?;

    let mut config_restored = false;
    if kind == kernel::AgentInstanceKind::Config && restore_config {
        if let Some(ref target_toml) = rollback_toml {
            if !target_toml.trim().is_empty() {
                config::apply_toml(&state.app_dir, target_toml, &state.db, &state.vault)
                    .map_err(err)?;
                if let Ok(rules) = state.db.rules() {
                    let _ = state.db.scan_existing_with_rules(|from, subject, body| {
                        agent::apply_rules(&rules, from, subject, body)
                            .map(|h| (h.status, h.reason))
                    });
                }
                let next_spec = config::build_spec(&state.db).unwrap_or_default();
                let mail_changed = prev_spec.active_account != next_spec.active_account
                    || serde_json::to_string(&prev_spec.accounts).ok()
                        != serde_json::to_string(&next_spec.accounts).ok();
                if mail_changed {
                    state.watcher.reconnect_now();
                }
                let _ = app.emit(
                    "mail-updated",
                    SyncReport {
                        new_incoming: 0,
                        agent_processed: 0,
                        error: None,
                    },
                );
                config_restored = true;
            }
        }
    }

    let toml = config::export_toml(&state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    if config_restored {
        let _ = app.emit("theme-updated", &spec.theme);
        let _ = app.emit("window-config-updated", &spec.window);
        let _ = app.emit("update-config-updated", &spec.update);
        state.tray.reconcile_config(&app, &state.db);
    }
    let turns = state
        .db
        .get_instance_session_turns(inst, &session_id)
        .map_err(err)?;
    let sessions = state.db.list_instance_sessions(inst).map_err(err)?;

    Ok(RewindAgentResponse {
        turns,
        sessions,
        config_restored,
        bundle: DeclarativeBundle {
            path: config_file_path(&state),
            toml,
            spec,
            secrets: vault_statuses(&state.db, &state.vault),
        },
    })
}

#[tauri::command]
fn switch_instance_model(
    state: State<AppState>,
    instance_id: String,
    preset: String,
    model: Option<String>,
) -> CmdResult<ModelSwitchResult> {
    let ag = kernel::switch_instance_model_core(
        &state.app_dir,
        &state.db,
        &state.vault,
        &instance_id,
        &preset,
        model.as_deref(),
    )
    .map_err(err)?;
    let toml = config::export_toml(&state.db).map_err(err)?;
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
async fn connect_instance_magpie(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    base_url: Option<String>,
    model: Option<String>,
    auto_start: Option<bool>,
) -> CmdResult<MagpieConnectResult> {
    let (probe, ag) = kernel::connect_instance_magpie_core(
        &state.app_dir,
        &state.db,
        &state.vault,
        &instance_id,
        base_url.as_deref(),
        model.as_deref(),
        auto_start.unwrap_or(true),
    )
    .await
    .map_err(err)?;

    let toml = config::export_toml(&state.db).map_err(err)?;
    let spec = config::build_spec(&state.db).map_err(err)?;
    if kernel::AgentInstanceKind::parse(&instance_id) == kernel::AgentInstanceKind::Config {
        let _ = app.emit(
            "mail-updated",
            SyncReport {
                new_incoming: 0,
                agent_processed: 0,
                error: None,
            },
        );
    }

    Ok(MagpieConnectResult {
        probe,
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
async fn run_agent_kernel_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    req: kernel::KernelTurnRequest,
) -> CmdResult<kernel::KernelTurnResponse> {
    kernel::run_kernel_turn(&app, &state, req).await
}

#[tauri::command]
fn cancel_agent_kernel_turn(
    state: State<AppState>,
    request_id: Option<String>,
) -> CmdResult<()> {
    cancel_agent_chat(state, request_id)
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
async fn probe_magpie(
    state: State<'_, AppState>,
    base_url: Option<String>,
) -> CmdResult<magpie::MagpieProbeReport> {
    let gw_key = state.vault.get("llm_magpie").unwrap_or_default();
    Ok(magpie::probe_magpie(base_url.as_deref(), Some(&gw_key)).await)
}

#[tauri::command]
async fn start_magpie_gateway(
    state: State<'_, AppState>,
    base_url: Option<String>,
) -> CmdResult<magpie::MagpieProbeReport> {
    let gw_key = state.vault.get("llm_magpie").unwrap_or_default();
    magpie::start_local_magpie_gateway(base_url.as_deref(), Some(&gw_key))
        .await
        .map_err(err)
}

#[tauri::command]
async fn connect_magpie(
    app: AppHandle,
    state: State<'_, AppState>,
    base_url: Option<String>,
    model: Option<String>,
    auto_start: Option<bool>,
) -> CmdResult<MagpieConnectResult> {
    let gw_key = state.vault.get("llm_magpie").unwrap_or_default();
    let mut probe = magpie::probe_magpie(base_url.as_deref(), Some(&gw_key)).await;
    if !probe.gateway_online
        && auto_start.unwrap_or(true)
        && magpie::is_loopback_url(&probe.base_url)
        && probe.cli_installed
    {
        if let Ok(started) =
            magpie::start_local_magpie_gateway(Some(&probe.base_url), Some(&gw_key)).await
        {
            probe = started;
        }
    }

    let mut ag = state.db.agent_config().map_err(err)?;
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

    let saved_prof = ag.profiles.get("magpie").cloned();
    let explicit_model = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix("magpie/").unwrap_or(s).trim().to_string());

    let chosen_model = if let Some(m) = explicit_model {
        m
    } else if let Some(saved_m) = saved_prof
        .as_ref()
        .map(|p| p.model.trim())
        .filter(|s| {
            !s.is_empty()
                && !s.eq_ignore_ascii_case("auto")
                && (probe.models.is_empty() || probe.models.iter().any(|x| x == *s))
        })
    {
        saved_m.to_string()
    } else if !probe.recommended_model.is_empty() {
        probe.recommended_model.clone()
    } else {
        "auto".to_string()
    };

    ag.preset = "magpie".to_string();
    ag.provider = "openai".to_string();
    ag.base_url = probe.base_url.clone();
    ag.model = chosen_model;
    let key_ready = magpie::is_loopback_url(&ag.base_url) || !gw_key.trim().is_empty();
    if key_ready {
        ag.enabled = true;
    }

    ag.profiles.insert(
        "magpie".to_string(),
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

    if ag.enabled && probe.gateway_online {
        spawn_agent_triage(
            app.clone(),
            state.db.clone(),
            state.vault.clone(),
            state.watcher.clone(),
        );
    }

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    Ok(MagpieConnectResult {
        probe,
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
fn window_action(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
    action: String,
) -> CmdResult<bool> {
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
        "hide_to_tray" => {
            window.hide().map_err(err)?;
            Ok(true)
        }
        "close" => {
            let close_to_tray = state
                .db
                .window_config()
                .map(|c| c.close_to_tray)
                .unwrap_or(true);
            if close_to_tray {
                window.hide().map_err(err)?;
                Ok(true)
            } else {
                tray::quit_application(&app, &state.watcher, &state.tray);
                Ok(false)
            }
        }
        "exit" => {
            tray::quit_application(&app, &state.watcher, &state.tray);
            Ok(false)
        }
        _ => Err("不支持的窗口操作".into()),
    }
}

#[tauri::command]
fn set_agent_dock_expanded(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    expanded: bool,
    dock_width: Option<f64>,
) -> CmdResult<bool> {
    let mut st = state.dock_win.lock().unwrap();
    if st.expanded == expanded {
        return Ok(expanded);
    }

    let dock_w = dock_width.unwrap_or(388.0).clamp(300.0, 560.0);
    if window.is_maximized().unwrap_or(false) {
        st.expanded = expanded;
        st.added_phys_w = 0;
        st.shifted_left_px = 0;
        st.post_shift_x = None;
        return Ok(expanded);
    }

    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let delta_w = (dock_w * scale).round() as u32;

    if expanded {
        let cur_inner = window.inner_size().map_err(err)?;
        let mut target_w = cur_inner.width.saturating_add(delta_w);
        st.shifted_left_px = 0;
        st.post_shift_x = None;

        if let Ok(Some(mon)) = window.current_monitor() {
            let mon_left = mon.position().x;
            let mon_w = mon.size().width;
            let mon_right = mon_left + mon_w as i32;
            if target_w > mon_w {
                target_w = mon_w;
            }
            if let Ok(pos) = window.outer_position() {
                let right_edge = pos.x + target_w as i32;
                if right_edge > mon_right {
                    let overflow = right_edge - mon_right;
                    let new_x = (pos.x - overflow).max(mon_left);
                    let shifted = pos.x - new_x;
                    if shifted > 0 {
                        let _ = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(new_x, pos.y),
                        ));
                        st.shifted_left_px = shifted;
                        st.post_shift_x = Some(new_x);
                    }
                }
            }
        }

        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                target_w,
                cur_inner.height,
            )))
            .map_err(err)?;
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
            820.0 + dock_w,
            520.0,
        ))));
        st.expanded = true;
        st.added_phys_w = target_w.saturating_sub(cur_inner.width);
    } else {
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
            820.0, 520.0,
        ))));
        let cur_inner = window.inner_size().map_err(err)?;
        let sub_w = if st.added_phys_w > 0 {
            st.added_phys_w
        } else {
            delta_w
        };
        let min_phys_w = (820.0 * scale).round() as u32;
        let target_w = cur_inner.width.saturating_sub(sub_w).max(min_phys_w);
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                target_w,
                cur_inner.height,
            )))
            .map_err(err)?;

        if st.shifted_left_px > 0 {
            if let Ok(pos) = window.outer_position() {
                if st
                    .post_shift_x
                    .map(|px| (pos.x - px).abs() <= 12)
                    .unwrap_or(false)
                {
                    let _ = window.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition::new(pos.x + st.shifted_left_px, pos.y),
                    ));
                }
            }
        }
        st.expanded = false;
        st.added_phys_w = 0;
        st.shifted_left_px = 0;
        st.post_shift_x = None;
    }

    Ok(expanded)
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
    let st = state.db.stats().map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(st)
}

#[tauri::command]
fn list_conversations(state: State<AppState>, status: String) -> CmdResult<Vec<Conversation>> {
    state.db.conversations(&status).map_err(err)
}

#[tauri::command]
fn list_messages(state: State<AppState>, peer: String, status: String) -> CmdResult<Vec<MessageDto>> {
    let msgs = state.db.messages(&peer, &status).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(msgs)
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

fn is_dangerous_executable_filename(name: &str) -> bool {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .trim_end_matches(|c: char| c.is_whitespace() || c == '.');
    let ext = match base.rsplit_once('.') {
        Some((_, e)) => e.trim().to_ascii_lowercase(),
        None => return false,
    };
    matches!(
        ext.as_str(),
        "exe"
            | "msi"
            | "msp"
            | "bat"
            | "cmd"
            | "com"
            | "scr"
            | "pif"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "wsf"
            | "wsh"
            | "ps1"
            | "psm1"
            | "hta"
            | "cpl"
            | "jar"
            | "reg"
            | "lnk"
            | "dll"
            | "sys"
            | "msc"
            | "application"
            | "appref-ms"
            | "iso"
            | "img"
            | "vhd"
            | "vhdx"
    )
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

#[cfg(target_os = "windows")]
fn pick_save_file_path(
    hwnd_owner: isize,
    default_filename: &str,
    initial_dir: Option<&std::path::Path>,
) -> CmdResult<Option<PathBuf>> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[repr(C)]
    struct OpenFileNameW {
        l_struct_size: u32,
        hwnd_owner: isize,
        h_instance: isize,
        lpstr_filter: *const u16,
        lpstr_custom_filter: *mut u16,
        n_max_cust_filter: u32,
        n_filter_index: u32,
        lpstr_file: *mut u16,
        n_max_file: u32,
        lpstr_file_title: *mut u16,
        n_max_file_title: u32,
        lpstr_initial_dir: *const u16,
        lpstr_title: *const u16,
        flags: u32,
        n_file_offset: u16,
        n_file_extension: u16,
        lpstr_def_ext: *const u16,
        l_cust_data: isize,
        lpfn_hook: *const core::ffi::c_void,
        lp_template_name: *const u16,
        pv_reserved: *mut core::ffi::c_void,
        dw_reserved: u32,
        flags_ex: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const u8) -> isize;
        fn GetProcAddress(h_module: isize, lp_proc_name: *const u8) -> *const core::ffi::c_void;
    }
    type GetSaveFileNameWFn = unsafe extern "system" fn(*mut OpenFileNameW) -> i32;
    type CommDlgExtendedErrorFn = unsafe extern "system" fn() -> u32;

    const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
    const OFN_EXPLORER: u32 = 0x0008_0000;
    const OFN_DONTADDTORECENT: u32 = 0x0200_0000;

    let clean_name = mail::sanitize_attachment_filename(default_filename, "application/octet-stream");
    let ext = clean_name
        .rsplit_once('.')
        .map(|(_, e)| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric()));

    let filter_str = if let Some(ref e) = ext {
        format!(
            "{} 文件 (*.{})\0*.{}\0所有文件 (*.*)\0*.*\0\0",
            e.to_ascii_uppercase(),
            e,
            e
        )
    } else {
        "所有文件 (*.*)\0*.*\0\0".to_string()
    };
    let filter_u16: Vec<u16> = filter_str.encode_utf16().collect();
    let def_ext_u16: Option<Vec<u16>> = ext.map(|e| e.encode_utf16().chain(std::iter::once(0)).collect());
    let title_u16: Vec<u16> = "另存邮件附件为\0".encode_utf16().collect();
    let init_dir_u16: Option<Vec<u16>> = initial_dir
        .filter(|p| p.is_dir())
        .map(|p| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect());

    let run_dialog = |use_init_dir: bool| -> CmdResult<(i32, u32, Vec<u16>)> {
        let mut file_buf = vec![0u16; 4096];
        let name_wide: Vec<u16> = std::ffi::OsStr::new(&clean_name).encode_wide().collect();
        if name_wide.len() + 1 < file_buf.len() {
            file_buf[..name_wide.len()].copy_from_slice(&name_wide);
        }

        let mut ofn = OpenFileNameW {
            l_struct_size: core::mem::size_of::<OpenFileNameW>() as u32,
            hwnd_owner,
            h_instance: 0,
            lpstr_filter: filter_u16.as_ptr(),
            lpstr_custom_filter: std::ptr::null_mut(),
            n_max_cust_filter: 0,
            n_filter_index: 1,
            lpstr_file: file_buf.as_mut_ptr(),
            n_max_file: file_buf.len() as u32,
            lpstr_file_title: std::ptr::null_mut(),
            n_max_file_title: 0,
            lpstr_initial_dir: if use_init_dir {
                init_dir_u16.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null())
            } else {
                std::ptr::null()
            },
            lpstr_title: title_u16.as_ptr(),
            flags: OFN_OVERWRITEPROMPT
                | OFN_NOCHANGEDIR
                | OFN_PATHMUSTEXIST
                | OFN_EXPLORER
                | OFN_DONTADDTORECENT,
            n_file_offset: 0,
            n_file_extension: 0,
            lpstr_def_ext: def_ext_u16.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
            l_cust_data: 0,
            lpfn_hook: std::ptr::null(),
            lp_template_name: std::ptr::null(),
            pv_reserved: std::ptr::null_mut(),
            dw_reserved: 0,
            flags_ex: 0,
        };

        unsafe {
            let hmod = LoadLibraryA(b"comdlg32.dll\0".as_ptr());
            if hmod == 0 {
                return Err("无法加载系统 comdlg32 对话框组件".into());
            }
            let proc_ptr = GetProcAddress(hmod, b"GetSaveFileNameW\0".as_ptr());
            if proc_ptr.is_null() {
                return Err("无法定位 GetSaveFileNameW 入口".into());
            }
            let err_ptr = GetProcAddress(hmod, b"CommDlgExtendedError\0".as_ptr());
            let save_fn: GetSaveFileNameWFn = core::mem::transmute(proc_ptr);
            let ok = save_fn(&mut ofn);
            let dlg_err = if ok == 0 && !err_ptr.is_null() {
                let err_fn: CommDlgExtendedErrorFn = core::mem::transmute(err_ptr);
                err_fn()
            } else {
                0
            };
            Ok((ok, dlg_err, file_buf))
        }
    };

    let (mut ok, mut dlg_err, mut file_buf) = run_dialog(true)?;
    if ok == 0 && dlg_err != 0 {
        // 若默认下载目录句柄异常导致系统对话框报错，去除初始目录重试一次
        let retry = run_dialog(false)?;
        ok = retry.0;
        dlg_err = retry.1;
        file_buf = retry.2;
    }
    if ok == 0 {
        if dlg_err != 0 {
            return Err(format!("打开系统另存为对话框失败 (code 0x{dlg_err:x})"));
        }
        return Ok(None);
    }

    let len = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
    if len == 0 {
        return Ok(None);
    }
    let chosen = std::ffi::OsString::from_wide(&file_buf[..len]);
    Ok(Some(PathBuf::from(chosen)))
}

#[cfg(target_os = "macos")]
fn pick_save_file_path(
    _hwnd_owner: isize,
    default_filename: &str,
    _initial_dir: Option<&std::path::Path>,
) -> CmdResult<Option<PathBuf>> {
    let clean_name = mail::sanitize_attachment_filename(default_filename, "application/octet-stream")
        .replace('\\', "")
        .replace('"', "");
    let script = format!(
        "POSIX path of (choose file name with prompt \"另存邮件附件为\" default name \"{clean_name}\")"
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(err)?;
    if !out.status.success() {
        return Ok(None);
    }
    let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path_str.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(path_str)))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_save_file_path(
    _hwnd_owner: isize,
    default_filename: &str,
    initial_dir: Option<&std::path::Path>,
) -> CmdResult<Option<PathBuf>> {
    let clean_name = mail::sanitize_attachment_filename(default_filename, "application/octet-stream");
    let default_target = initial_dir
        .filter(|p| p.is_dir())
        .map(|p| p.join(&clean_name))
        .unwrap_or_else(|| PathBuf::from(&clean_name));
    let out = std::process::Command::new("zenity")
        .args([
            "--file-selection",
            "--save",
            "--confirm-overwrite",
            "--title=另存邮件附件为",
            &format!("--filename={}", default_target.to_string_lossy()),
        ])
        .output()
        .map_err(|e| format!("无法调用系统文件保存对话框 (zenity): {e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path_str.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(path_str)))
    }
}

fn resolve_account_for_locator(state: &AppState, account_email: &str) -> CmdResult<Account> {
    let acc_opt = if !account_email.is_empty() && account_email != db::UNBOUND_SCOPE {
        config::hydrated_account_for(&state.db, &state.vault, account_email).map_err(err)?
    } else {
        config::hydrated_account(&state.db, &state.vault).map_err(err)?
    };
    let acc = acc_opt.ok_or("未找到对应邮箱账号配置，请先连接邮箱账号")?;
    if acc.imap_host.trim().is_empty() || acc.password.trim().is_empty() {
        return Err("邮箱账号尚未配置 IMAP 服务器或授权码".into());
    }
    Ok(acc)
}

/// 仅对图片附件按需拉取至内存生成 `data:` 预览 URI（绝不写入本地磁盘，且拒绝一切非图片/可执行文件）
#[tauri::command]
async fn preview_attachment_data_url(
    state: State<'_, AppState>,
    message_id: i64,
    attachment_id: String,
) -> CmdResult<String> {
    let loc = state
        .db
        .locate_attachment(message_id, &attachment_id)
        .map_err(err)?
        .ok_or("找不到该图片附件记录")?;

    if !loc.meta.is_image || is_dangerous_executable_filename(&loc.meta.filename) {
        return Err("安全限制：仅允许在内存中预览图片类型附件".into());
    }

    let (bytes, mime_hint) = if !loc.meta.saved_path.is_empty()
        && std::path::Path::new(&loc.meta.saved_path).is_file()
    {
        let b = std::fs::read(&loc.meta.saved_path).map_err(err)?;
        (b, loc.meta.mime.clone())
    } else {
        let acc = resolve_account_for_locator(&state, &loc.account_email)?;
        let folder = loc.folder.clone();
        let uid = loc.uid;
        let rfc_mid = loc.rfc_message_id.clone();
        let meta = loc.meta.clone();
        spawn_mail_blocking(move || mail::fetch_attachment_bytes(&acc, &folder, uid, &rfc_mid, &meta))
            .await?
    };

    let mime_full = mail::infer_mime_type(&loc.meta.filename, &mime_hint, &bytes);
    let mime = mime_full
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim();
    if !mime.starts_with("image/") {
        return Err("该附件实际内容不是受支持的图片格式".into());
    }
    Ok(format!("data:{mime};base64,{}", mail::base64_encode(&bytes)))
}

/// 用户主动点击“下载 / 另存为”时：先弹出系统文件保存对话框，用户确认目标路径后才从 IMAP 按需拉取并写入该路径
#[tauri::command]
async fn save_attachment_as(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    message_id: i64,
    attachment_id: String,
) -> CmdResult<Option<AttachmentMeta>> {
    let loc = state
        .db
        .locate_attachment(message_id, &attachment_id)
        .map_err(err)?
        .ok_or("找不到该附件记录")?;

    #[cfg(target_os = "windows")]
    let hwnd_owner = window.hwnd().ok().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    let hwnd_owner = {
        let _ = &window;
        0isize
    };

    let download_dir = app.path().download_dir().ok();
    let default_name = loc.meta.filename.clone();
    let chosen_opt = tokio::task::spawn_blocking(move || {
        pick_save_file_path(hwnd_owner, &default_name, download_dir.as_deref())
    })
    .await
    .map_err(|e| format!("等待系统保存对话框失败: {e}"))??;

    // 用户取消“另存为”对话框：零网络请求、零磁盘写入
    let Some(target_path) = chosen_opt else {
        return Ok(None);
    };

    let bytes = if !loc.meta.saved_path.is_empty()
        && std::path::Path::new(&loc.meta.saved_path).is_file()
    {
        std::fs::read(&loc.meta.saved_path).map_err(err)?
    } else {
        let acc = resolve_account_for_locator(&state, &loc.account_email)?;
        let folder = loc.folder.clone();
        let uid = loc.uid;
        let rfc_mid = loc.rfc_message_id.clone();
        let meta = loc.meta.clone();
        let (b, _) = spawn_mail_blocking(move || {
            mail::fetch_attachment_bytes(&acc, &folder, uid, &rfc_mid, &meta)
        })
        .await?;
        b
    };

    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
    }
    std::fs::write(&target_path, &bytes)
        .map_err(|e| format!("写入目标保存路径失败: {e}"))?;

    let saved_str = target_path.to_string_lossy().to_string();
    let updated = state
        .db
        .record_attachment_saved_path(message_id, &loc.meta.id, &saved_str)
        .map_err(err)?;
    Ok(updated)
}

#[tauri::command]
fn open_saved_attachment(
    state: State<AppState>,
    message_id: i64,
    attachment_id: String,
) -> CmdResult<()> {
    let loc = state
        .db
        .locate_attachment(message_id, &attachment_id)
        .map_err(err)?
        .ok_or("找不到该附件记录")?;

    if is_dangerous_executable_filename(&loc.meta.filename)
        || is_dangerous_executable_filename(&loc.meta.saved_path)
    {
        return Err(
            "安全保护：禁止直接启动可执行程序或脚本附件，请在文件夹中核实来源与签名后谨慎处理".into(),
        );
    }

    if loc.meta.saved_path.trim().is_empty() {
        return Err("请先手动下载保存该文件后再打开".into());
    }
    let full = PathBuf::from(&loc.meta.saved_path);
    if !full.is_file() {
        return Err("已保存的本地文件不存在（可能已被移动或删除），请重新下载保存".into());
    }

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
fn reveal_saved_attachment(
    state: State<AppState>,
    message_id: i64,
    attachment_id: String,
) -> CmdResult<()> {
    let loc = state
        .db
        .locate_attachment(message_id, &attachment_id)
        .map_err(err)?
        .ok_or("找不到该附件记录")?;

    if loc.meta.saved_path.trim().is_empty() {
        return Err("该附件尚未下载保存".into());
    }
    let full = PathBuf::from(&loc.meta.saved_path);
    if !full.is_file() {
        return Err("已保存的本地文件不存在（可能已被移动或删除）".into());
    }

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

    const MAX_SEND_ATT_BYTES: usize = 25 * 1024 * 1024;
    let mut saved_metas: Vec<AttachmentMeta> = Vec::with_capacity(incoming_atts.len());
    let mut outgoing_atts: Vec<mail::OutgoingAttachment> = Vec::with_capacity(incoming_atts.len());
    for (idx, item) in incoming_atts.into_iter().enumerate() {
        let bytes = mail::base64_decode(&item.data_base64).map_err(err)?;
        if bytes.is_empty() {
            return Err("附件内容为空".into());
        }
        if bytes.len() > MAX_SEND_ATT_BYTES {
            return Err("单个附件大小不能超过 25 MB".into());
        }
        // 严禁在发信时把附件自动拷贝落盘到应用数据目录！仅构造内存元数据供展示
        let meta = mail::build_attachment_meta(
            &item.filename,
            &item.mime,
            bytes.len(),
            "",
            "",
            idx,
            &bytes,
        );
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
                        cc: Vec::new(),
                        bcc: Vec::new(),
                        subject: subj,
                        body: &b,
                        body_html: None,
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
    state.db.set_message_status(id, &status).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(())
}

#[tauri::command]
fn move_conversation(state: State<AppState>, peer: String, status: String) -> CmdResult<()> {
    state.db.move_peer(&peer, &status).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(())
}

#[tauri::command]
fn set_conversation_pinned(state: State<AppState>, peer: String, pinned: bool) -> CmdResult<()> {
    state.db.set_peer_pinned(&peer, pinned).map_err(err)
}

#[tauri::command]
fn set_conversation_read(
    state: State<AppState>,
    peer: String,
    status: String,
    read: bool,
) -> CmdResult<()> {
    state.db.set_peer_read(&peer, &status, read).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(())
}

#[tauri::command]
fn mark_all_read(state: State<AppState>, status: String) -> CmdResult<usize> {
    let n = state.db.mark_all_read(&status).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(n)
}

#[tauri::command]
fn set_conversation_muted(state: State<AppState>, peer: String, muted: bool) -> CmdResult<()> {
    state.db.set_peer_muted(&peer, muted).map_err(err)?;
    if peer.trim().starts_with("group:") {
        refresh_disk_toml(&state);
    }
    Ok(())
}

#[tauri::command]
fn delete_message(state: State<AppState>, id: i64) -> CmdResult<()> {
    state.db.delete_message(id).map_err(err)?;
    state.tray.refresh_summary(&state.db);
    Ok(())
}

#[tauri::command]
fn delete_conversation(
    state: State<AppState>,
    peer: String,
    status: Option<String>,
) -> CmdResult<usize> {
    let deleted = state
        .db
        .delete_conversation(&peer, status.as_deref())
        .map_err(err)?;
    if peer.trim().starts_with("group:") {
        refresh_disk_toml(&state);
    }
    state.tray.refresh_summary(&state.db);
    Ok(deleted)
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

#[tauri::command]
fn start_screen_snip() -> CmdResult<()> {
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
        let uri: Vec<u16> = std::ffi::OsStr::new("ms-screenclip:")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ret = unsafe {
            let hmod = LoadLibraryA(b"shell32.dll\0".as_ptr());
            if hmod == 0 {
                0
            } else {
                let proc_ptr = GetProcAddress(hmod, b"ShellExecuteW\0".as_ptr());
                if proc_ptr.is_null() {
                    0
                } else {
                    let func: ShellExecuteWFn = core::mem::transmute(proc_ptr);
                    func(0, op.as_ptr(), uri.as_ptr(), std::ptr::null(), std::ptr::null(), 1)
                }
            }
        };
        if ret <= 32 {
            std::process::Command::new("SnippingTool.exe")
                .arg("/clip")
                .spawn()
                .map_err(|e| format!("无法启动系统截图工具：{e}"))?;
        }
        Ok(())
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
        std::process::Command::new("gnome-screenshot")
            .args(["-a", "-c"])
            .spawn()
            .map_err(|e| format!("无法启动系统截图工具：{e}"))?;
        Ok(())
    }
}

// ============================================================================
// 模式一：传统写信 + Agent HTML 工坊（Compose Studio）Tauri 接口
// ============================================================================

#[derive(Debug, Clone, Serialize)]
struct ComposeAgentStreamPayload {
    request_id: String,
    /// "thinking" | "content" | "html_preview"
    kind: String,
    delta: String,
    thinking_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrivacyScrubPreviewDto {
    pub scrubbed: String,
    pub redactions: Vec<privacy::RedactionHit>,
    pub dlp_passed: bool,
    pub dlp_findings: Vec<String>,
}

#[tauri::command]
fn preview_privacy_scrub(
    state: State<AppState>,
    text: String,
    redact_pii: Option<bool>,
    custom_terms: Option<Vec<String>>,
) -> CmdResult<PrivacyScrubPreviewDto> {
    let policy = state.db.reply_policy().unwrap_or_default();
    let do_redact = redact_pii.unwrap_or(policy.redact_pii);
    let terms = custom_terms.unwrap_or(policy.custom_redact_terms);
    let scrub = privacy::scrub_text_with_vault(&text, do_redact, &terms);
    let dlp = privacy::check_outbound_dlp("", &text, "", false);
    Ok(PrivacyScrubPreviewDto {
        scrubbed: scrub.scrubbed,
        redactions: scrub.hits,
        dlp_passed: dlp.passed,
        dlp_findings: dlp.findings,
    })
}

#[tauri::command]
async fn chat_compose_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: Option<String>,
    input: agent::ComposeAgentInput,
) -> CmdResult<agent::ComposeAgentResult> {
    if input.user_prompt.trim().is_empty() {
        return Err("请输入给写信 Agent 的指令或描述".into());
    }
    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;
    let req_id = request_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("compose-{}", uuid::Uuid::new_v4()));

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        state
            .agent_cancels
            .lock()
            .unwrap()
            .insert(req_id.clone(), cancel_flag.clone());
    }

    let emit_app = app.clone();
    let emit_id = req_id.clone();
    let res = agent::stream_compose_agent(&cfg, &input, &cancel_flag, |ev| match ev {
        agent::ComposeAgentStreamEvent::ThinkingDelta { delta, thinking_ms } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "thinking".into(),
                    delta: delta.to_string(),
                    thinking_ms,
                },
            );
        }
        agent::ComposeAgentStreamEvent::ContentDelta { delta } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "content".into(),
                    delta: delta.to_string(),
                    thinking_ms: 0,
                },
            );
        }
        agent::ComposeAgentStreamEvent::HtmlPreviewDelta { html } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "html_preview".into(),
                    delta: html.to_string(),
                    thinking_ms: 0,
                },
            );
        }
    })
    .await;

    {
        state.agent_cancels.lock().unwrap().remove(&req_id);
    }

    Ok(res)
}

#[tauri::command]
fn cancel_compose_agent(state: State<AppState>, request_id: String) -> CmdResult<()> {
    if let Ok(map) = state.agent_cancels.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn normalize_email_list(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in raw {
        for part in item.split(&[',', ';', '，', '；'][..]) {
            let clean = part.trim().to_lowercase();
            if clean.contains('@') && !clean.contains(' ') && !out.contains(&clean) {
                out.push(clean);
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn send_composed_mail(
    app: AppHandle,
    state: State<'_, AppState>,
    from_email: Option<String>,
    to: Vec<String>,
    cc: Option<Vec<String>>,
    bcc: Option<Vec<String>>,
    subject: String,
    body_plain: String,
    body_html: Option<String>,
    attachments: Option<Vec<SendAttachmentInput>>,
    reply_to_id: Option<i64>,
    force_dlp_override: Option<bool>,
) -> CmdResult<MessageDto> {
    let to_list = normalize_email_list(to);
    if to_list.is_empty() {
        return Err("请至少填写 1 位有效的收件人邮箱地址（To）".into());
    }
    let cc_list = normalize_email_list(cc.unwrap_or_default());
    let bcc_list = normalize_email_list(bcc.unwrap_or_default());

    let raw_html = body_html.unwrap_or_default();
    let clean_html = privacy::sanitize_outgoing_html(&raw_html);
    let clean_plain = if !body_plain.trim().is_empty() {
        body_plain.trim().to_string()
    } else if !clean_html.is_empty() {
        mail::html_to_text(&clean_html)
    } else {
        String::new()
    };

    let incoming_atts = attachments.unwrap_or_default();
    if clean_plain.is_empty() && clean_html.is_empty() && incoming_atts.is_empty() {
        return Err("邮件正文与附件不能同时为空".into());
    }

    let policy = state.db.reply_policy().unwrap_or_default();
    if policy.outbound_dlp_guard && !force_dlp_override.unwrap_or(false) {
        let dlp = privacy::check_outbound_dlp(&subject, &clean_plain, &clean_html, true);
        if !dlp.passed {
            return Err(format!("DLP_BLOCK: {}", dlp.findings.join("；")));
        }
    }

    const MAX_SEND_ATT_BYTES: usize = 25 * 1024 * 1024;
    let mut saved_metas: Vec<AttachmentMeta> = Vec::with_capacity(incoming_atts.len());
    let mut outgoing_atts: Vec<mail::OutgoingAttachment> = Vec::with_capacity(incoming_atts.len());
    for (idx, item) in incoming_atts.into_iter().enumerate() {
        if is_dangerous_executable_filename(&item.filename) {
            return Err(format!(
                "安全限制：禁止发送可执行程序或脚本附件（{}）",
                item.filename
            ));
        }
        let bytes = mail::base64_decode(&item.data_base64).map_err(err)?;
        if bytes.is_empty() {
            return Err("附件内容为空".into());
        }
        if bytes.len() > MAX_SEND_ATT_BYTES {
            return Err("单个附件大小不能超过 25 MB".into());
        }
        let meta = mail::build_attachment_meta(
            &item.filename,
            &item.mime,
            bytes.len(),
            "",
            "",
            idx,
            &bytes,
        );
        outgoing_atts.push(mail::OutgoingAttachment {
            filename: meta.filename.clone(),
            mime: meta.mime.clone(),
            bytes,
        });
        saved_metas.push(meta);
    }

    let active_scope = state.db.active_scope_email().map_err(err)?;
    let requested_from = from_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.contains('@'))
        .map(str::to_lowercase);
    let target_scope = requested_from.clone().unwrap_or_else(|| active_scope.clone());

    let acc_opt = if target_scope != db::UNBOUND_SCOPE {
        config::hydrated_account_for(&state.db, &state.vault, &target_scope).map_err(err)?
    } else {
        config::hydrated_account(&state.db, &state.vault).map_err(err)?
    };

    let primary_peer = to_list[0].clone();
    let (ctx, reply_quote) = if let Some(rid) = reply_to_id {
        match state.db.reply_context_by_id_for(&target_scope, rid).map_err(err)? {
            Some((explicit_ctx, quote)) => (Some(explicit_ctx), Some(quote)),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    let final_subject = if !subject.trim().is_empty() {
        subject.trim().to_string()
    } else if let Some(ref c) = ctx {
        if c.subject.trim().is_empty() {
            "(无主题)".to_string()
        } else if c.subject.to_lowercase().starts_with("re:") || c.subject.starts_with("回复") {
            c.subject.trim().to_string()
        } else {
            format!("Re: {}", c.subject.trim())
        }
    } else {
        "(无主题)".to_string()
    };

    let (in_reply_to, references) = if let Some(c) = ctx {
        let mut refs: Vec<String> = c
            .references
            .split_whitespace()
            .map(|r| format!("<{}>", r.trim_matches(&['<', '>'][..])))
            .collect();
        let clean_mid = format!("<{}>", c.message_id.trim_matches(&['<', '>'][..]));
        if !c.message_id.trim().is_empty() && !refs.contains(&clean_mid) {
            refs.push(clean_mid);
        }
        (
            if c.message_id.trim().is_empty() {
                None
            } else {
                Some(c.message_id)
            },
            if refs.is_empty() {
                None
            } else {
                Some(refs.join(" "))
            },
        )
    } else {
        (None, None)
    };

    let quote_mid = reply_quote.as_ref().map(|q| q.message_id.clone());

    let (mid, from_addr, from_name, folder, db_scope) = match acc_opt {
        Some(acc) if !acc.password.is_empty() && !acc.smtp_host.is_empty() => {
            let acc2 = acc.clone();
            let (rcpts, ccs, bccs, subj, bp, bh, irt, refs, qmid, out_atts) = (
                to_list.clone(),
                cc_list.clone(),
                bcc_list.clone(),
                final_subject.clone(),
                clean_plain.clone(),
                clean_html.clone(),
                in_reply_to.clone(),
                references.clone(),
                quote_mid,
                outgoing_atts,
            );
            let mid = spawn_mail_blocking(move || {
                mail::send(
                    &acc2,
                    &mail::Outgoing {
                        recipients: rcpts,
                        cc: ccs,
                        bcc: bccs,
                        subject: subj,
                        body: &bp,
                        body_html: if bh.trim().is_empty() {
                            None
                        } else {
                            Some(bh.as_str())
                        },
                        in_reply_to: irt,
                        references: refs,
                        group_id: None,
                        group_name: None,
                        quote_mid: qmid,
                        attachments: out_atts,
                    },
                )
            })
            .await?;
            let em = acc.email.to_lowercase();
            (mid, em.clone(), acc.display_name, "local", em)
        }
        _ => {
            let stats = state.db.stats().map_err(err)?;
            if !stats.has_demo {
                return Err(
                    "所选发件邮箱尚未配置 SMTP 授权码，请先通过「AI 助手」或「设置」绑定邮箱凭据"
                        .into(),
                );
            }
            (
                format!("{}@mailchat.demo", uuid::Uuid::new_v4()),
                "me@mailchat.local".to_string(),
                "我 (演示模式)".to_string(),
                "demo",
                db::UNBOUND_SCOPE.to_string(),
            )
        }
    };

    let contact_muted = state
        .db
        .is_contact_muted_for(&db_scope, &primary_peer)
        .unwrap_or(false);
    let target_status = if contact_muted { "archived" } else { "inbox" };

    let id = state
        .db
        .insert_message_for(
            &db_scope,
            &NewMessage {
                folder: folder.into(),
                uid: 0,
                message_id: mid,
                in_reply_to: in_reply_to.unwrap_or_default(),
                references: references.unwrap_or_default(),
                from_addr,
                from_name,
                to_addrs: to_list.join(","),
                cc_addrs: cc_list.join(","),
                subject: final_subject,
                body: clean_plain.clone(),
                body_full: clean_plain,
                body_html: clean_html,
                date: chrono::Utc::now().timestamp(),
                outgoing: true,
                peer: primary_peer,
                status: target_status.into(),
                category: String::new(),
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
        .ok_or("邮件本地入库失败")?;

    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );

    state.db.message(id).map_err(err)
}

// ============================================================================
// 模式二：跨邮箱隐私脱敏与分级权限统一批复中心（Unified Reply Hub）
// ============================================================================

#[derive(Debug, Clone, Default, Serialize)]
pub struct UnifiedScanReport {
    pub authorized_accounts: Vec<String>,
    pub isolated_accounts_count: usize,
    pub scanned_candidates: usize,
    pub skipped_by_privacy_count: usize,
    pub skipped_reasons: Vec<String>,
    pub total_redactions: usize,
    pub queued_review_count: usize,
    pub auto_sent_count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BatchApproveResult {
    pub sent_count: usize,
    pub failed_count: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
fn get_reply_policy(state: State<AppState>) -> CmdResult<privacy::ReplyPolicySpec> {
    state.db.reply_policy().map_err(err)
}

#[tauri::command]
fn save_reply_policy(
    app: AppHandle,
    state: State<AppState>,
    policy: privacy::ReplyPolicySpec,
) -> CmdResult<privacy::ReplyPolicySpec> {
    let normalized = privacy::normalize_policy(&policy);
    state.db.save_reply_policy(&normalized).map_err(err)?;
    refresh_disk_toml(&state);
    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );
    Ok(normalized)
}

#[tauri::command]
fn list_reply_queue(
    state: State<AppState>,
    status_filter: Option<String>,
    account_filter: Option<String>,
) -> CmdResult<Vec<ReplyQueueItem>> {
    state
        .db
        .list_reply_queue(status_filter.as_deref(), account_filter.as_deref())
        .map_err(err)
}

#[tauri::command]
fn get_reply_queue_stats(state: State<AppState>) -> CmdResult<ReplyQueueStats> {
    state.db.reply_queue_stats().map_err(err)
}

async fn send_reply_queue_item_smtp(
    db: &Arc<Db>,
    vault: &Arc<Vault>,
    item: &ReplyQueueItem,
    force_dlp_override: bool,
    outbound_dlp_guard: bool,
) -> std::result::Result<(), String> {
    let clean_html = privacy::sanitize_outgoing_html(&item.draft_html);
    let clean_plain = if !item.draft_body.trim().is_empty() {
        item.draft_body.trim().to_string()
    } else if !clean_html.is_empty() {
        mail::html_to_text(&clean_html)
    } else {
        return Err("回复草稿内容为空".into());
    };

    if outbound_dlp_guard && !force_dlp_override {
        let dlp = privacy::check_outbound_dlp(&item.draft_subject, &clean_plain, &clean_html, true);
        if !dlp.passed {
            return Err(format!("出站 DLP 安全拦截：{}", dlp.findings.join("；")));
        }
    }

    let scope = item.account_email.trim().to_lowercase();
    let acc_opt = if scope != db::UNBOUND_SCOPE && !scope.is_empty() {
        config::hydrated_account_for(db, vault, &scope).map_err(err)?
    } else {
        config::hydrated_account(db, vault).map_err(err)?
    };

    let (ctx, reply_quote) = match db
        .reply_context_by_id_for(&scope, item.message_id_ref)
        .map_err(err)?
    {
        Some((c, q)) => (Some(c), Some(q)),
        None => (None, None),
    };

    let final_subject = if !item.draft_subject.trim().is_empty() {
        item.draft_subject.trim().to_string()
    } else if !item.original_subject.trim().is_empty() {
        let os = item.original_subject.trim();
        if os.to_lowercase().starts_with("re:") || os.starts_with("回复") {
            os.to_string()
        } else {
            format!("Re: {os}")
        }
    } else {
        "Re: 来信回复".to_string()
    };

    let (in_reply_to, references) = if let Some(c) = ctx {
        let mut refs: Vec<String> = c
            .references
            .split_whitespace()
            .map(|r| format!("<{}>", r.trim_matches(&['<', '>'][..])))
            .collect();
        let clean_mid = format!("<{}>", c.message_id.trim_matches(&['<', '>'][..]));
        if !c.message_id.trim().is_empty() && !refs.contains(&clean_mid) {
            refs.push(clean_mid);
        }
        (
            if c.message_id.trim().is_empty() {
                None
            } else {
                Some(c.message_id)
            },
            if refs.is_empty() {
                None
            } else {
                Some(refs.join(" "))
            },
        )
    } else if !item.rfc_message_id.trim().is_empty() {
        let clean_mid = format!("<{}>", item.rfc_message_id.trim_matches(&['<', '>'][..]));
        (Some(item.rfc_message_id.clone()), Some(clean_mid))
    } else {
        (None, None)
    };

    let recipient = item.sender_addr.trim().to_lowercase();
    if !recipient.contains('@') {
        return Err(format!("无效的目标收件人地址: {recipient}"));
    }
    let quote_mid = reply_quote.as_ref().map(|q| q.message_id.clone());

    let (mid, from_addr, from_name, folder, write_scope) = match acc_opt {
        Some(acc) if !acc.password.is_empty() && !acc.smtp_host.is_empty() => {
            let acc2 = acc.clone();
            let rcpts = vec![recipient.clone()];
            let subj = final_subject.clone();
            let bp = clean_plain.clone();
            let bh = clean_html.clone();
            let irt = in_reply_to.clone();
            let refs = references.clone();
            let mid = spawn_mail_blocking(move || {
                mail::send(
                    &acc2,
                    &mail::Outgoing {
                        recipients: rcpts,
                        cc: Vec::new(),
                        bcc: Vec::new(),
                        subject: subj,
                        body: &bp,
                        body_html: if bh.trim().is_empty() {
                            None
                        } else {
                            Some(bh.as_str())
                        },
                        in_reply_to: irt,
                        references: refs,
                        group_id: None,
                        group_name: None,
                        quote_mid,
                        attachments: Vec::new(),
                    },
                )
            })
            .await?;
            let em = acc.email.to_lowercase();
            (mid, em.clone(), acc.display_name, "local", em)
        }
        _ => {
            let stats = db.stats().map_err(err)?;
            if stats.has_demo && (scope == db::UNBOUND_SCOPE || scope.is_empty()) {
                (
                    format!("{}@mailchat.demo", uuid::Uuid::new_v4()),
                    "me@mailchat.local".to_string(),
                    "我 (演示模式)".to_string(),
                    "demo",
                    db::UNBOUND_SCOPE.to_string(),
                )
            } else {
                return Err(format!(
                    "邮箱 `{scope}` 尚未配置有效的 SMTP 主机或授权码，无法发送"
                ));
            }
        }
    };

    let peer = if item.peer.trim().is_empty() {
        recipient.clone()
    } else {
        item.peer.clone()
    };

    let _ = db
        .insert_message_for(
            &write_scope,
            &NewMessage {
                folder: folder.into(),
                uid: 0,
                message_id: mid,
                in_reply_to: in_reply_to.unwrap_or_default(),
                references: references.unwrap_or_default(),
                from_addr,
                from_name,
                to_addrs: recipient,
                cc_addrs: String::new(),
                subject: final_subject,
                body: clean_plain.clone(),
                body_full: clean_plain,
                body_html: clean_html,
                date: chrono::Utc::now().timestamp(),
                outgoing: true,
                peer,
                status: "inbox".into(),
                category: String::new(),
                summary: String::new(),
                reason: String::new(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
                attachments: Vec::new(),
                reply_to: reply_quote,
            },
        )
        .map_err(err)?;

    Ok(())
}

pub(crate) async fn run_unified_reply_scan(
    app: &AppHandle,
    db: &Arc<Db>,
    vault: &Arc<Vault>,
    include_dismissed: bool,
) -> CmdResult<UnifiedScanReport> {
    let policy = db.reply_policy().map_err(err)?;
    let all_accounts = db.list_accounts().map_err(err)?;
    let cfg = config::hydrated_instance_agent(db, vault, "mail").unwrap_or_default();

    let mut report = UnifiedScanReport::default();
    let mut authorized_scopes: Vec<String> = Vec::new();
    let mut account_names: HashMap<String, String> = HashMap::new();

    if all_accounts.is_empty() {
        // 演示模式支持：未绑定真实邮箱但存在演示数据且显式授权了 demo@mailchat.local 时可扫描演示收件箱
        let has_demo = db.stats().map(|s| s.has_demo).unwrap_or(false);
        let demo_authorized = policy.enabled_accounts.iter().any(|a| {
            let n = a.trim().to_lowercase();
            n == "demo@mailchat.local" || n == "me@mailchat.local" || n == db::UNBOUND_SCOPE
        });
        if has_demo && demo_authorized {
            authorized_scopes.push(db::UNBOUND_SCOPE.to_string());
            report
                .authorized_accounts
                .push("demo@mailchat.local".to_string());
            account_names.insert(db::UNBOUND_SCOPE.to_string(), "演示邮箱".to_string());
        }
    } else {
        for acc in &all_accounts {
            let em = acc.email.trim().to_lowercase();
            account_names.insert(em.clone(), acc.display_name.clone());
            if policy
                .enabled_accounts
                .iter()
                .any(|x| x.trim().eq_ignore_ascii_case(&em))
            {
                authorized_scopes.push(em.clone());
                report.authorized_accounts.push(em);
            } else {
                report.isolated_accounts_count += 1;
            }
        }
    }

    if authorized_scopes.is_empty() {
        return Ok(report);
    }

    // 第一阶段：零信任仅扫描元数据（不加载任何邮件正文）
    let candidates = db
        .unanswered_candidate_metas(&authorized_scopes, include_dismissed, 40)
        .map_err(err)?;
    report.scanned_candidates = candidates.len();

    let mut auto_sent_last_hour = db
        .reply_queue_stats()
        .map(|s| s.auto_sent_last_hour)
        .unwrap_or(0);

    for row in candidates {
        let sender_lc = row.from_addr.trim().to_lowercase();
        if sender_lc == "me@mailchat.local"
            || all_accounts
                .iter()
                .any(|a| a.email.trim().eq_ignore_ascii_case(&sender_lc))
        {
            continue;
        }

        let policy_account_label = if row.account_email == db::UNBOUND_SCOPE {
            report
                .authorized_accounts
                .first()
                .cloned()
                .unwrap_or_else(|| "demo@mailchat.local".to_string())
        } else {
            row.account_email.clone()
        };
        let is_group = row.peer.starts_with("group:");

        // 第二阶段（a）：元数据级读取准入校验（拦截槽、验证码/账单、免回复系统号、黑名单在此直接拦截，零正文读取）
        if let privacy::ReadAccessVerdict::Denied { reason, .. } = privacy::evaluate_read_access(
            &policy,
            &policy_account_label,
            is_group,
            &row.status,
            &row.from_addr,
            &row.subject,
            &row.category,
            &row.extracted_code,
            "",
        ) {
            report.skipped_by_privacy_count += 1;
            if report.skipped_reasons.len() < 12 {
                report
                    .skipped_reasons
                    .push(format!("{} · 《{}》：{}", row.from_addr, row.subject, reason));
            }
            continue;
        }

        // 第二阶段（b）：仅对准入通过的邮件按字符上限加载去噪纯文本，再执行正文级隐私排除词复核
        let stripped_body = db
            .load_stripped_body_by_id(row.message_id_pk, policy.max_context_chars)
            .map_err(err)?;

        if let privacy::ReadAccessVerdict::Denied { reason, .. } = privacy::evaluate_read_access(
            &policy,
            &policy_account_label,
            is_group,
            &row.status,
            &row.from_addr,
            &row.subject,
            &row.category,
            &row.extracted_code,
            &stripped_body,
        ) {
            report.skipped_by_privacy_count += 1;
            if report.skipped_reasons.len() < 12 {
                report
                    .skipped_reasons
                    .push(format!("{} · 《{}》：{}", row.from_addr, row.subject, reason));
            }
            continue;
        }

        // 第三阶段：入模前本地确定性隐私与密钥脱敏（立即丢弃原始 vault_map，确保统一批复永不持久化或外泄明文 PII）
        const SUBJ_BODY_SEP: &str = "\n\x1e__MC_UNIFIED_SEP__\x1e\n";
        let combined_in = format!("{}{SUBJ_BODY_SEP}{}", row.subject, stripped_body);
        let scrub = privacy::scrub_text_with_vault(
            &combined_in,
            policy.redact_pii,
            &policy.custom_redact_terms,
        );
        let hits = scrub.hits;
        let scrubbed_text = scrub.scrubbed;
        drop(scrub.vault_map);

        report.total_redactions += hits.len();

        let (sanitized_subj, sanitized_body) = match scrubbed_text.split_once(SUBJ_BODY_SEP) {
            Some((s, b)) => (s.trim().to_string(), b.trim().to_string()),
            None => (row.subject.clone(), scrubbed_text.clone()),
        };
        let sanitized_audit_view = format!(
            "发件人: {} <{}>\n主题: {}\n\n{}",
            row.from_name, row.from_addr, sanitized_subj, sanitized_body
        );

        let sender_display = if row.from_name.trim().is_empty() {
            row.from_addr.clone()
        } else {
            format!("{} <{}>", row.from_name.trim(), row.from_addr)
        };
        let acc_disp_name = account_names
            .get(&row.account_email)
            .cloned()
            .unwrap_or_default();

        // 第四阶段：匹配自动化回复规则或调用统一草稿生成（仅向大模型发送已脱敏文本）
        let matched_rule = privacy::match_auto_reply_rule(
            &policy,
            &policy_account_label,
            &row.from_addr,
            &row.subject,
            &stripped_body,
        );

        let (draft_body, draft_html, confidence_note, used_offline_fallback) =
            if let Some(rule) = matched_rule {
                if rule.mode == "template" {
                    let tpl_body = if rule.instructions_or_template.trim().is_empty() {
                        "您好，已收到您的来信，我们会尽快处理并回复您。".to_string()
                    } else {
                        rule.instructions_or_template.trim().to_string()
                    };
                    let tpl_html = privacy::sanitize_outgoing_html(&rule.template_html);
                    (
                        tpl_body,
                        tpl_html,
                        format!("命中自动化规则「{}」固定模板", rule.name),
                        false,
                    )
                } else {
                    let combined_persona = if rule.instructions_or_template.trim().is_empty() {
                        policy.persona_instructions.clone()
                    } else if policy.persona_instructions.trim().is_empty() {
                        rule.instructions_or_template.clone()
                    } else {
                        format!(
                            "【本条自动化规则专属要求】：{}\n【全局回复规范】：{}",
                            rule.instructions_or_template.trim(),
                            policy.persona_instructions.trim()
                        )
                    };
                    let gen = agent::generate_unified_reply_draft(
                        &cfg,
                        &policy_account_label,
                        &acc_disp_name,
                        &sender_display,
                        &sanitized_subj,
                        &sanitized_body,
                        &combined_persona,
                    )
                    .await;
                    let tpl_html = privacy::sanitize_outgoing_html(&rule.template_html);
                    (
                        gen.draft_body,
                        tpl_html,
                        format!("命中自动化规则「{}」· {}", rule.name, gen.confidence_note),
                        gen.used_offline_fallback,
                    )
                }
            } else {
                let gen = agent::generate_unified_reply_draft(
                    &cfg,
                    &policy_account_label,
                    &acc_disp_name,
                    &sender_display,
                    &sanitized_subj,
                    &sanitized_body,
                    &policy.persona_instructions,
                )
                .await;
                (
                    gen.draft_body,
                    String::new(),
                    gen.confidence_note,
                    gen.used_offline_fallback,
                )
            };

        let draft_subject = if row.subject.trim().is_empty() {
            "Re: 来信回复".to_string()
        } else if row.subject.to_lowercase().starts_with("re:") || row.subject.starts_with("回复") {
            row.subject.trim().to_string()
        } else {
            format!("Re: {}", row.subject.trim())
        };

        let dlp = privacy::check_outbound_dlp(&draft_subject, &draft_body, &draft_html, true);
        let dlp_warning = if dlp.passed {
            String::new()
        } else {
            dlp.findings.join("；")
        };

        // 第五阶段：自动化规则 / 白名单分级发信裁决（含防乒乓死循环冷却、小时限速与出站 DLP 守卫）
        let (perm_tier, perm_reason, want_auto_send) = if let Some(rule) = matched_rule {
            if rule.require_review {
                (
                    "rule_review",
                    format!("命中自动化规则「{}」（规则设为人工确认后发出）", rule.name),
                    false,
                )
            } else if db
                .has_recent_auto_reply_to_sender(
                    &row.account_email,
                    &row.from_addr,
                    rule.cooldown_minutes,
                )
                .unwrap_or(false)
            {
                (
                    "draft_review",
                    format!(
                        "防循环冷却保护：{} 分钟内已向该发件人自动回复过，降级人工待审",
                        rule.cooldown_minutes
                    ),
                    false,
                )
            } else if auto_sent_last_hour >= policy.auto_send_hourly_limit as usize {
                (
                    "draft_review",
                    format!(
                        "已达每小时自动发信上限（{} 封/小时），降级为人工待审",
                        policy.auto_send_hourly_limit
                    ),
                    false,
                )
            } else if !dlp.passed {
                (
                    "draft_review",
                    format!("命中出站 DLP 守卫（{}），已强制降级为人工待审", dlp_warning),
                    false,
                )
            } else if rule.mode != "template" && used_offline_fallback {
                (
                    "draft_review",
                    format!(
                        "命中规则「{}」但模型未在线使用了本地模板，已自动降级待审",
                        rule.name
                    ),
                    false,
                )
            } else {
                (
                    "rule_auto_send",
                    format!("命中自动化回复规则「{}」并通过冷却与 DLP 校验", rule.name),
                    true,
                )
            }
        } else {
            let perm =
                privacy::evaluate_send_permission(&policy, &row.from_addr, auto_sent_last_hour);
            match perm {
                privacy::PermissionVerdict::WhitelistedAutoSend => {
                    if db
                        .has_recent_auto_reply_to_sender(&row.account_email, &row.from_addr, 60)
                        .unwrap_or(false)
                    {
                        (
                            "draft_review",
                            "防循环冷却保护：60 分钟内已向该发件人自动回复过".to_string(),
                            false,
                        )
                    } else if !dlp.passed {
                        (
                            "draft_review",
                            format!("命中出站 DLP 守卫（{}），已强制降级为人工待审", dlp_warning),
                            false,
                        )
                    } else if used_offline_fallback {
                        (
                            "draft_review",
                            "当前为本地离线模板草稿，已自动降级为人工待审".to_string(),
                            false,
                        )
                    } else {
                        (
                            "whitelisted_auto_send",
                            "命中已验证自动发信白名单且通过出站 DLP 校验".to_string(),
                            true,
                        )
                    }
                }
                privacy::PermissionVerdict::DraftReview { reason } => ("draft_review", reason, false),
            }
        };

        let snippet: String = stripped_body
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(110)
            .collect();

        let queue_id = db
            .upsert_reply_queue_item(&NewReplyQueueItem {
                account_email: &row.account_email,
                message_id_ref: row.message_id_pk,
                rfc_message_id: &row.rfc_message_id,
                peer: &row.peer,
                sender_addr: &row.from_addr,
                sender_name: &row.from_name,
                original_subject: &row.subject,
                original_snippet: &snippet,
                sanitized_input: &sanitized_audit_view,
                redactions: &hits,
                permission_tier: perm_tier,
                permission_reason: &perm_reason,
                draft_subject: &draft_subject,
                draft_body: &draft_body,
                draft_html: &draft_html,
                confidence_note: &confidence_note,
                dlp_warning: &dlp_warning,
                status: "pending_review",
                error_msg: "",
            })
            .map_err(err)?;

        if want_auto_send {
            if let Ok(Some(saved_item)) = db.get_reply_queue_item(queue_id) {
                match send_reply_queue_item_smtp(
                    db,
                    vault,
                    &saved_item,
                    false,
                    policy.outbound_dlp_guard,
                )
                .await
                {
                    Ok(()) => {
                        let _ = db.mark_reply_queue_status(queue_id, "auto_sent", "");
                        auto_sent_last_hour += 1;
                        report.auto_sent_count += 1;
                    }
                    Err(send_err) => {
                        let _ =
                            db.mark_reply_queue_status(queue_id, "pending_review", &send_err);
                        report.queued_review_count += 1;
                    }
                }
            } else {
                report.queued_review_count += 1;
            }
        } else {
            report.queued_review_count += 1;
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
    let _ = app.emit("reply-queue-updated", &report);

    Ok(report)
}

#[tauri::command]
async fn scan_unified_replies(
    app: AppHandle,
    state: State<'_, AppState>,
    include_dismissed: Option<bool>,
) -> CmdResult<UnifiedScanReport> {
    run_unified_reply_scan(
        &app,
        &state.db,
        &state.vault,
        include_dismissed.unwrap_or(false),
    )
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviseReplyQueueResult {
    pub item: ReplyQueueItem,
    pub reply: String,
    pub thinking: String,
    pub thinking_ms: u64,
}

#[tauri::command]
async fn revise_reply_queue_with_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    instruction: String,
    request_id: Option<String>,
) -> CmdResult<ReviseReplyQueueResult> {
    if instruction.trim().is_empty() {
        return Err("请输入对当前回复草稿的修改要求".into());
    }
    let item = state
        .db
        .get_reply_queue_item(id)
        .map_err(err)?
        .ok_or_else(|| "找不到该待审回复记录".to_string())?;
    let cfg = config::hydrated_agent(&state.db, &state.vault).map_err(err)?;

    let req_id = request_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("revise-{}", uuid::Uuid::new_v4()));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        state
            .agent_cancels
            .lock()
            .unwrap()
            .insert(req_id.clone(), cancel_flag.clone());
    }

    let sender_identity = if item.account_email == db::UNBOUND_SCOPE {
        "demo@mailchat.local".to_string()
    } else {
        item.account_email.clone()
    };

    let input = agent::ComposeAgentInput {
        sender_identity,
        to: vec![item.sender_addr.clone()],
        cc: Vec::new(),
        current_subject: item.draft_subject.clone(),
        current_html: item.draft_html.clone(),
        current_plain: item.draft_body.clone(),
        reply_context: Some(format!(
            "【已本地脱敏的原邮件摘要（仅含脱敏占位符，严禁外泄明文隐私）】：\n{}",
            item.sanitized_input
        )),
        redact_pii: false, // sanitized_input 已完成本地盲脱敏且原始 vault 已销毁
        custom_redact_terms: Vec::new(),
        history: Vec::new(),
        user_prompt: instruction,
    };

    let emit_app = app.clone();
    let emit_id = req_id.clone();
    let res = agent::stream_compose_agent(&cfg, &input, &cancel_flag, |ev| match ev {
        agent::ComposeAgentStreamEvent::ThinkingDelta { delta, thinking_ms } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "thinking".into(),
                    delta: delta.to_string(),
                    thinking_ms,
                },
            );
        }
        agent::ComposeAgentStreamEvent::ContentDelta { delta } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "content".into(),
                    delta: delta.to_string(),
                    thinking_ms: 0,
                },
            );
        }
        agent::ComposeAgentStreamEvent::HtmlPreviewDelta { html } => {
            let _ = emit_app.emit(
                "compose-agent-stream",
                ComposeAgentStreamPayload {
                    request_id: emit_id.clone(),
                    kind: "html_preview".into(),
                    delta: html.to_string(),
                    thinking_ms: 0,
                },
            );
        }
    })
    .await;

    {
        state.agent_cancels.lock().unwrap().remove(&req_id);
    }

    let next_subj = res
        .suggested_subject
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&item.draft_subject)
        .to_string();
    let next_html = match res.suggested_html {
        Some(ref h) if !h.trim().is_empty() => privacy::sanitize_outgoing_html(h),
        _ => String::new(),
    };
    let next_body = if let Some(ref p) = res.suggested_plain {
        if !p.trim().is_empty() {
            p.trim().to_string()
        } else if !next_html.is_empty() {
            mail::html_to_text(&next_html)
        } else {
            item.draft_body.clone()
        }
    } else if !next_html.is_empty() {
        mail::html_to_text(&next_html)
    } else {
        item.draft_body.clone()
    };

    let dlp = privacy::check_outbound_dlp(&next_subj, &next_body, &next_html, true);
    let dlp_warning = if dlp.passed {
        String::new()
    } else {
        dlp.findings.join("；")
    };

    let updated = state
        .db
        .update_reply_queue_draft(id, &next_subj, &next_body, &next_html, &dlp_warning)
        .map_err(err)?
        .ok_or_else(|| "更新待审回复草稿失败".to_string())?;

    let _ = app.emit("reply-queue-updated", &updated);

    Ok(ReviseReplyQueueResult {
        item: updated,
        reply: res.reply,
        thinking: res.thinking,
        thinking_ms: res.thinking_ms,
    })
}

#[tauri::command]
fn update_reply_queue_item(
    state: State<AppState>,
    id: i64,
    draft_subject: String,
    draft_body: String,
    draft_html: Option<String>,
) -> CmdResult<ReplyQueueItem> {
    let clean_html = privacy::sanitize_outgoing_html(&draft_html.unwrap_or_default());
    let dlp = privacy::check_outbound_dlp(&draft_subject, &draft_body, &clean_html, true);
    let dlp_warning = if dlp.passed {
        String::new()
    } else {
        dlp.findings.join("；")
    };
    state
        .db
        .update_reply_queue_draft(id, draft_subject.trim(), draft_body.trim(), &clean_html, &dlp_warning)
        .map_err(err)?
        .ok_or_else(|| "找不到该待审回复记录".to_string())
}

#[tauri::command]
async fn approve_send_reply_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    force_dlp_override: Option<bool>,
) -> CmdResult<BatchApproveResult> {
    if ids.is_empty() {
        return Err("请至少选择 1 封待批准回复的邮件".into());
    }
    let policy = state.db.reply_policy().unwrap_or_default();
    let force_override = force_dlp_override.unwrap_or(false);
    let mut out = BatchApproveResult::default();

    for id in ids {
        let Some(item) = state.db.get_reply_queue_item(id).map_err(err)? else {
            continue;
        };
        if item.status == "approved_sent" || item.status == "auto_sent" {
            continue;
        }
        match send_reply_queue_item_smtp(
            &state.db,
            &state.vault,
            &item,
            force_override,
            policy.outbound_dlp_guard,
        )
        .await
        {
            Ok(()) => {
                let _ = state.db.mark_reply_queue_status(id, "approved_sent", "");
                out.sent_count += 1;
            }
            Err(e) => {
                let _ = state.db.mark_reply_queue_status(id, "failed", &e);
                out.failed_count += 1;
                out.errors
                    .push(format!("{} ({}): {}", item.sender_addr, item.account_email, e));
            }
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

    Ok(out)
}

#[tauri::command]
fn dismiss_reply_queue_items(
    app: AppHandle,
    state: State<AppState>,
    ids: Vec<i64>,
) -> CmdResult<usize> {
    let mut n = 0usize;
    for id in ids {
        state
            .db
            .mark_reply_queue_status(id, "dismissed", "")
            .map_err(err)?;
        n += 1;
    }
    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );
    Ok(n)
}

#[tauri::command]
fn clear_finished_reply_queue(app: AppHandle, state: State<AppState>) -> CmdResult<usize> {
    let n = state.db.clear_finished_reply_queue().map_err(err)?;
    let _ = app.emit(
        "mail-updated",
        SyncReport {
            new_incoming: 0,
            agent_processed: 0,
            error: None,
        },
    );
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let base_tray_icon = app.default_window_icon().map(|i| {
                tauri::image::Image::new_owned(i.rgba().to_vec(), i.width(), i.height())
            });
            let tray_mgr = tray::TrayAlertManager::new(base_tray_icon);
            let updater_mgr = Arc::new(updater::UpdaterManager::new());
            let app_dir_for_state = dir.clone();
            app.manage(AppState {
                app_dir: app_dir_for_state,
                db: db.clone(),
                vault: vault.clone(),
                syncing: syncing.clone(),
                watcher: watcher.clone(),
                tray: tray_mgr.clone(),
                updater: updater_mgr.clone(),
                agent_cancels: Mutex::new(HashMap::new()),
                dock_win: Mutex::new(DockWindowState::default()),
            });

            let _ = tray::setup_system_tray_and_window_hooks(
                app,
                &dir,
                db.clone(),
                vault.clone(),
                syncing.clone(),
                watcher.clone(),
                tray_mgr,
            );

            let handle = app.handle().clone();
            updater::spawn_background_update_checker(
                handle.clone(),
                db.clone(),
                updater_mgr,
            );

            // 零配置无感沿用：若用户尚未启用/配置任何模型 API Key，且本机 Magpie 路由网关已在线并配好模型，自动在后台沿用接入
            let should_probe_adopt = db
                .agent_config()
                .ok()
                .map(|ag| {
                    !ag.enabled
                        && vault::KNOWN_SECRETS
                            .iter()
                            .filter(|(_, _, cat)| *cat == "llm")
                            .all(|(k, _, _)| vault.get(k).is_none())
                })
                .unwrap_or(false);
            if should_probe_adopt {
                let handle_adopt = handle.clone();
                let db_adopt = db.clone();
                let vault_adopt = vault.clone();
                let watcher_adopt = watcher.clone();
                let dir_adopt = dir.clone();
                tauri::async_runtime::spawn(async move {
                    let probe = magpie::probe_magpie(None, None).await;
                    if !probe.gateway_online || probe.models.is_empty() {
                        return;
                    }
                    let Ok(mut cur) = db_adopt.agent_config() else {
                        return;
                    };
                    if cur.enabled {
                        return;
                    }
                    let chosen = if probe.recommended_model.is_empty() {
                        "auto".to_string()
                    } else {
                        probe.recommended_model.clone()
                    };
                    cur.preset = "magpie".into();
                    cur.provider = "openai".into();
                    cur.base_url = probe.base_url.clone();
                    cur.model = chosen.clone();
                    cur.enabled = true;
                    cur.api_key.clear();
                    cur.profiles.insert(
                        "magpie".into(),
                        ProviderProfile {
                            base_url: probe.base_url,
                            api_key: String::new(),
                            model: chosen,
                        },
                    );
                    if db_adopt.save_agent_config(&cur).is_ok() {
                        let _ = config::sync_disk_toml(&dir_adopt, &db_adopt);
                        let _ = handle_adopt.emit(
                            "mail-updated",
                            SyncReport {
                                new_incoming: 0,
                                agent_processed: 0,
                                error: None,
                            },
                        );
                        spawn_agent_triage(handle_adopt, db_adopt, vault_adopt, watcher_adopt);
                    }
                });
            }

            spawn_agent_triage(handle.clone(), db.clone(), vault.clone(), watcher.clone());
            spawn_realtime_imap_watcher(handle, db, vault, watcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_declarative_config,
            apply_declarative_config,
            apply_declarative_spec,
            get_theme_config,
            save_theme_config,
            get_window_config,
            save_window_config,
            get_update_config,
            save_update_config,
            get_update_status,
            check_app_update,
            download_app_update,
            install_app_update,
            skip_app_update_version,
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
            rewind_agent_session,
            switch_active_model,
            get_agent_instance_state,
            list_instance_sessions,
            create_instance_session,
            get_instance_session_turns,
            delete_instance_session,
            rewind_instance_session,
            switch_instance_model,
            connect_instance_magpie,
            run_agent_kernel_turn,
            cancel_agent_kernel_turn,
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
            probe_magpie,
            start_magpie_gateway,
            connect_magpie,
            window_action,
            set_agent_dock_expanded,
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
            preview_attachment_data_url,
            save_attachment_as,
            open_saved_attachment,
            reveal_saved_attachment,
            send_message,
            set_message_status,
            move_conversation,
            set_conversation_pinned,
            set_conversation_read,
            mark_all_read,
            set_conversation_muted,
            delete_message,
            delete_conversation,
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
            open_external_url,
            start_screen_snip,
            preview_privacy_scrub,
            chat_compose_agent,
            cancel_compose_agent,
            send_composed_mail,
            get_reply_policy,
            save_reply_policy,
            list_reply_queue,
            get_reply_queue_stats,
            scan_unified_replies,
            revise_reply_queue_with_agent,
            update_reply_queue_item,
            approve_send_reply_queue,
            dismiss_reply_queue_items,
            clear_finished_reply_queue,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod attachment_security_tests {
    use super::is_dangerous_executable_filename;

    #[test]
    fn blocks_executables_scripts_and_windows_trailing_dot_bypasses() {
        assert!(is_dangerous_executable_filename("JiJiDown_setup.exe"));
        assert!(is_dangerous_executable_filename("JiJiDown_setup.EXE."));
        assert!(is_dangerous_executable_filename("JiJiDown_setup.exe   "));
        assert!(is_dangerous_executable_filename("payload.exe:$DATA"));
        assert!(is_dangerous_executable_filename("invoice.pdf.scr"));
        assert!(is_dangerous_executable_filename("install.msi"));
        assert!(is_dangerous_executable_filename("run.bat"));
        assert!(is_dangerous_executable_filename("dropper.ps1"));
        assert!(is_dangerous_executable_filename("shortcut.lnk"));
        assert!(is_dangerous_executable_filename("archive.iso"));

        assert!(!is_dangerous_executable_filename("派发通知.docx"));
        assert!(!is_dangerous_executable_filename("核对！.docx"));
        assert!(!is_dangerous_executable_filename("Horoscope.txt"));
        assert!(!is_dangerous_executable_filename("image.png"));
        assert!(!is_dangerous_executable_filename("report.pdf"));
    }
}
