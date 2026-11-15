//! 客户端自动更新引擎（Tauri v2 Minisign 签名热更新 + 多渠道感知 + GitHub Releases 元数据兜底）：
//! - **原生热更新（签名强校验）**：基于 `tauri-plugin-updater` 校验编译期内置公钥（Minisign Ed25519），
//!   支持流式下载进度推送、后台静默预下载与一键覆盖重启（Windows NSIS `/P /UPDATE /R`、macOS `.app.tar.gz`、Linux `AppImage`/`deb`）。
//! - **多安装渠道感知**：自动识别 Scoop、Homebrew Cask、Windows 绿色便携包、标准安装版与源码开发态，
//!   避免在 Scoop / 便携版目录误跑 NSIS 安装向导造成双份副本，并给出对应渠道的一键升级命令或直链。
//! - **平滑兼容兜底**：当远端旧版 Release 尚未附带 `latest.json` 或当前处于便携/包管理渠道时，
//!   自动回退查询 GitHub Releases API 获取最新版本与更新日志（回退路径绝不自动执行未验签二进制）。

use crate::db::{Db, UpdateConfig};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CmpOrdering;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

pub const DEFAULT_GITHUB_REPO: &str = "arrake0101/mailchat";
pub const DEFAULT_RELEASES_PAGE: &str = "https://github.com/arrake0101/mailchat/releases";

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallChannelInfo {
    /// nsis | scoop | portable | macos_app | homebrew | appimage | deb | dev
    pub channel_id: String,
    pub channel_label: String,
    pub supports_hot_update: bool,
    pub upgrade_command: Option<String>,
    pub exe_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatusSnapshot {
    /// idle | checking | up_to_date | available | downloading | installing | ready | error
    pub phase: String,
    pub current_version: String,
    pub install_channel: InstallChannelInfo,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    pub download_url: Option<String>,
    pub release_page_url: String,
    pub can_hot_install: bool,
    pub signature_verified: bool,
    pub is_skipped: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress_percent: Option<f64>,
    pub last_checked_at: u64,
    pub error: Option<String>,
}

struct PendingSignedUpdate {
    version: String,
    update: tauri_plugin_updater::Update,
    verified_bytes: Option<Vec<u8>>,
}

pub struct UpdaterManager {
    snapshot: Mutex<UpdateStatusSnapshot>,
    pending: Mutex<Option<PendingSignedUpdate>>,
    busy: AtomicBool,
}

impl UpdaterManager {
    pub fn new() -> Self {
        let install_channel = detect_install_channel();
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        Self {
            snapshot: Mutex::new(UpdateStatusSnapshot {
                phase: "idle".into(),
                current_version,
                install_channel,
                latest_version: None,
                release_notes: None,
                published_at: None,
                download_url: None,
                release_page_url: DEFAULT_RELEASES_PAGE.into(),
                can_hot_install: false,
                signature_verified: false,
                is_skipped: false,
                downloaded_bytes: 0,
                total_bytes: None,
                progress_percent: None,
                last_checked_at: 0,
                error: None,
            }),
            pending: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self, skipped_version: &str) -> UpdateStatusSnapshot {
        let mut guard = self.snapshot.lock().unwrap();
        let norm_skip = normalize_version_str(skipped_version);
        if let Some(ref latest) = guard.latest_version {
            guard.is_skipped = !norm_skip.is_empty() && normalize_version_str(latest) == norm_skip;
        } else {
            guard.is_skipped = false;
        }
        guard.clone()
    }

    fn update_and_emit<F>(&self, app: &AppHandle, f: F) -> UpdateStatusSnapshot
    where
        F: FnOnce(&mut UpdateStatusSnapshot),
    {
        let snap = {
            let mut guard = self.snapshot.lock().unwrap();
            f(&mut guard);
            guard.clone()
        };
        let _ = app.emit("app-update-status", &snap);
        snap
    }

    /// 检查远端更新（`manual = true` 时即使命中 `skipped_version` 也会清除错误并完整展示）
    pub async fn check_for_updates(
        self: &Arc<Self>,
        app: &AppHandle,
        cfg: &UpdateConfig,
        manual: bool,
    ) -> Result<UpdateStatusSnapshot> {
        let cfg = cfg.normalized();
        if self.busy.swap(true, Ordering::SeqCst) {
            return Ok(self.snapshot(&cfg.skipped_version));
        }

        struct BusyGuard<'a>(&'a AtomicBool);
        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = BusyGuard(&self.busy);

        self.update_and_emit(app, |s| {
            s.phase = "checking".into();
            s.error = None;
            s.downloaded_bytes = 0;
            s.total_bytes = None;
            s.progress_percent = None;
        });

        let channel_info = detect_install_channel();
        let current_ver = app.package_info().version.to_string();
        let checked_at = now_unix_secs();

        // 1. 若配置了 beta 通道且未指定自定义源，尝试先从 GitHub Releases 定位最新含预发布版的 latest.json
        let mut beta_manifest_url: Option<reqwest::Url> = None;
        let mut gh_fallback_candidate: Option<GithubReleaseMeta> = None;
        if cfg.custom_endpoint.is_empty() && cfg.channel == "beta" {
            if let Ok(Some(meta)) = fetch_github_release_meta(true).await {
                if let Some(ref manifest_asset_url) = meta.manifest_asset_url {
                    beta_manifest_url = reqwest::Url::parse(manifest_asset_url).ok();
                }
                gh_fallback_candidate = Some(meta);
            }
        }

        // 2. 尝试通过 Tauri 官方签名热更新器检查 latest.json
        let native_outcome = self
            .try_check_native_updater(app, &cfg, beta_manifest_url)
            .await;

        match native_outcome {
            Ok(Some(update)) => {
                let remote_ver = normalize_version_str(&update.version);
                let is_skipped = !cfg.skipped_version.is_empty()
                    && remote_ver == normalize_version_str(&cfg.skipped_version);
                let can_hot = channel_info.supports_hot_update;
                let release_page = format!(
                    "https://github.com/{DEFAULT_GITHUB_REPO}/releases/tag/v{remote_ver}"
                );
                let pub_date = update.date.map(|d| {
                    format!(
                        "{:04}-{:02}-{:02}",
                        d.year(),
                        u8::from(d.month()),
                        d.day()
                    )
                });
                let dl_url = update.download_url.to_string();
                let notes = update.body.clone();

                // 若之前已预下载同版本签名包，直接复用，避免重复消耗流量
                let already_ready = {
                    let mut p_guard = self.pending.lock().unwrap();
                    let reuse = p_guard
                        .as_ref()
                        .map(|p| p.version == remote_ver && p.verified_bytes.is_some())
                        .unwrap_or(false);
                    if reuse {
                        true
                    } else {
                        *p_guard = Some(PendingSignedUpdate {
                            version: remote_ver.clone(),
                            update,
                            verified_bytes: None,
                        });
                        false
                    }
                };

                let snap = self.update_and_emit(app, |s| {
                    s.current_version = current_ver;
                    s.install_channel = channel_info;
                    s.phase = if already_ready {
                        "ready".into()
                    } else {
                        "available".into()
                    };
                    s.latest_version = Some(remote_ver.clone());
                    s.release_notes = notes;
                    s.published_at = pub_date;
                    s.download_url = Some(dl_url);
                    s.release_page_url = release_page;
                    s.can_hot_install = can_hot;
                    s.signature_verified = true;
                    s.is_skipped = is_skipped;
                    s.last_checked_at = checked_at;
                    s.error = None;
                });

                // 若开启了后台静默预下载且未跳过该版本，自动流式拉取并验签缓存到内存
                if !already_ready && cfg.auto_download && can_hot && (!is_skipped || manual) {
                    drop(_guard);
                    return self.download_only(app, &cfg.skipped_version).await;
                }

                return Ok(snap);
            }
            Ok(None) => {
                {
                    let mut p_guard = self.pending.lock().unwrap();
                    *p_guard = None;
                }
                let snap = self.update_and_emit(app, |s| {
                    s.current_version = current_ver;
                    s.install_channel = channel_info;
                    s.phase = "up_to_date".into();
                    s.latest_version = None;
                    s.release_notes = None;
                    s.published_at = None;
                    s.download_url = None;
                    s.release_page_url = DEFAULT_RELEASES_PAGE.into();
                    s.can_hot_install = false;
                    s.signature_verified = false;
                    s.is_skipped = false;
                    s.last_checked_at = checked_at;
                    s.error = None;
                });
                return Ok(snap);
            }
            Err(native_err) => {
                // 若用户显式配置了企业/私有镜像源，直接反馈该镜像源错误，不越权访问 GitHub
                if !cfg.custom_endpoint.is_empty() {
                    let msg = format!("连接自定义更新源失败：{native_err:#}");
                    let snap = self.update_and_emit(app, |s| {
                        s.install_channel = channel_info;
                        s.phase = "error".into();
                        s.last_checked_at = checked_at;
                        s.error = Some(msg.clone());
                    });
                    return if manual { Err(anyhow!(msg)) } else { Ok(snap) };
                }

                // 3. 官方默认源回退：查询 GitHub Releases API（兼容尚未生成 latest.json 的历史版本及 Scoop/便携渠道）
                let fallback_meta = match gh_fallback_candidate {
                    Some(m) => Ok(Some(m)),
                    None => fetch_github_release_meta(cfg.channel == "beta").await,
                };

                match fallback_meta {
                    Ok(Some(meta)) => {
                        let remote_ver = normalize_version_str(&meta.version);
                        if compare_versions(&remote_ver, &current_ver) == CmpOrdering::Greater {
                            let is_skipped = !cfg.skipped_version.is_empty()
                                && remote_ver == normalize_version_str(&cfg.skipped_version);
                            {
                                let mut p_guard = self.pending.lock().unwrap();
                                *p_guard = None;
                            }
                            let preferred_asset =
                                select_platform_asset_url(&meta.assets, &channel_info.channel_id);
                            let snap = self.update_and_emit(app, |s| {
                                s.current_version = current_ver;
                                s.install_channel = channel_info;
                                s.phase = "available".into();
                                s.latest_version = Some(remote_ver);
                                s.release_notes = if meta.body.trim().is_empty() {
                                    None
                                } else {
                                    Some(meta.body)
                                };
                                s.published_at = meta.published_date;
                                s.download_url =
                                    preferred_asset.or_else(|| Some(meta.html_url.clone()));
                                s.release_page_url = meta.html_url;
                                // 回退元数据未附带 latest.json 签名清单时，严格禁止自动执行二进制覆盖
                                s.can_hot_install = false;
                                s.signature_verified = false;
                                s.is_skipped = is_skipped;
                                s.last_checked_at = checked_at;
                                s.error = None;
                            });
                            Ok(snap)
                        } else {
                            {
                                let mut p_guard = self.pending.lock().unwrap();
                                *p_guard = None;
                            }
                            let snap = self.update_and_emit(app, |s| {
                                s.current_version = current_ver;
                                s.install_channel = channel_info;
                                s.phase = "up_to_date".into();
                                s.latest_version = None;
                                s.release_notes = None;
                                s.published_at = None;
                                s.download_url = None;
                                s.release_page_url = meta.html_url;
                                s.can_hot_install = false;
                                s.signature_verified = false;
                                s.is_skipped = false;
                                s.last_checked_at = checked_at;
                                s.error = None;
                            });
                            Ok(snap)
                        }
                    }
                    Ok(None) => {
                        let snap = self.update_and_emit(app, |s| {
                            s.current_version = current_ver;
                            s.install_channel = channel_info;
                            s.phase = "up_to_date".into();
                            s.last_checked_at = checked_at;
                            s.error = None;
                        });
                        Ok(snap)
                    }
                    Err(gh_err) => {
                        let msg = format!("检查更新失败：{gh_err:#}");
                        let snap = self.update_and_emit(app, |s| {
                            s.install_channel = channel_info;
                            s.phase = "error".into();
                            s.last_checked_at = checked_at;
                            s.error = Some(msg.clone());
                        });
                        if manual {
                            Err(anyhow!(msg))
                        } else {
                            Ok(snap)
                        }
                    }
                }
            }
        }
    }

    async fn try_check_native_updater(
        &self,
        app: &AppHandle,
        cfg: &UpdateConfig,
        override_endpoint: Option<reqwest::Url>,
    ) -> Result<Option<tauri_plugin_updater::Update>> {
        let mut builder = app.updater_builder().timeout(Duration::from_secs(20));

        if !cfg.custom_endpoint.is_empty() {
            let parsed = reqwest::Url::parse(&cfg.custom_endpoint)
                .context("自定义更新镜像源 URL 格式无效")?;
            builder = builder
                .endpoints(vec![parsed])
                .context("自定义更新镜像源必须使用 HTTPS 加密协议")?;
        } else if let Some(ep) = override_endpoint {
            builder = builder
                .endpoints(vec![ep])
                .context("预发布通道更新源 URL 无效")?;
        }

        let updater = builder.build().context("初始化内置更新器失败")?;
        let update = updater.check().await.context("拉取签名更新清单失败")?;
        Ok(update)
    }

    /// 仅下载并校验 Minisign 签名，将更新包缓存在内存中（置为 `ready` 状态，等待用户一键重启安装）
    pub async fn download_only(
        self: &Arc<Self>,
        app: &AppHandle,
        skipped_version: &str,
    ) -> Result<UpdateStatusSnapshot> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Ok(self.snapshot(skipped_version));
        }
        struct BusyGuard<'a>(&'a AtomicBool);
        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = BusyGuard(&self.busy);

        let (version, update, already_cached) = {
            let guard = self.pending.lock().unwrap();
            let Some(p) = guard.as_ref() else {
                anyhow::bail!("当前没有可热更新的签名版本，请先检查更新");
            };
            (p.version.clone(), p.update.clone(), p.verified_bytes.is_some())
        };

        if already_cached {
            return Ok(self.update_and_emit(app, |s| {
                s.phase = "ready".into();
                s.progress_percent = Some(100.0);
                s.signature_verified = true;
                s.error = None;
            }));
        }

        let bytes = self.stream_download_verified(app, &update).await?;

        {
            let mut guard = self.pending.lock().unwrap();
            if let Some(p) = guard.as_mut() {
                if p.version == version {
                    p.verified_bytes = Some(bytes);
                }
            }
        }

        Ok(self.update_and_emit(app, |s| {
            s.phase = "ready".into();
            s.progress_percent = Some(100.0);
            s.signature_verified = true;
            s.error = None;
        }))
    }

    /// 下载（若尚未预下载）、校验 Minisign 签名、中断后台长连接并立即执行热替换重启
    pub async fn download_and_install_now<F>(
        self: &Arc<Self>,
        app: &AppHandle,
        skipped_version: &str,
        before_exit: F,
    ) -> Result<UpdateStatusSnapshot>
    where
        F: FnOnce() + Send + 'static,
    {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Ok(self.snapshot(skipped_version));
        }
        struct BusyGuard<'a>(&'a AtomicBool);
        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = BusyGuard(&self.busy);

        let channel = detect_install_channel();
        if !channel.supports_hot_update {
            anyhow::bail!(
                "当前为「{}」，不支持直接覆盖二进制，请使用对应包管理命令或下载安装包升级",
                channel.channel_label
            );
        }

        let (version, update, cached_bytes) = {
            let guard = self.pending.lock().unwrap();
            let Some(p) = guard.as_ref() else {
                anyhow::bail!("未找到待安装的签名更新包，请先点击检查更新");
            };
            (p.version.clone(), p.update.clone(), p.verified_bytes.clone())
        };

        let verified_bytes = match cached_bytes {
            Some(b) => b,
            None => {
                let b = self.stream_download_verified(app, &update).await?;
                let mut guard = self.pending.lock().unwrap();
                if let Some(p) = guard.as_mut() {
                    if p.version == version {
                        p.verified_bytes = Some(b.clone());
                    }
                }
                b
            }
        };

        self.update_and_emit(app, |s| {
            s.phase = "installing".into();
            s.progress_percent = Some(100.0);
            s.signature_verified = true;
            s.error = None;
        });

        // 安装退出前优雅掐断 IMAP IDLE TCP 套接字
        before_exit();

        if let Err(e) = update.install(&verified_bytes) {
            let msg = format!("应用更新包安装失败：{e:#}");
            self.update_and_emit(app, |s| {
                s.phase = "error".into();
                s.error = Some(msg.clone());
            });
            return Err(anyhow!(msg));
        }

        // Windows 下 update.install 内部拉起 NSIS `/P /UPDATE /R` 后会自动 exit(0)；
        // macOS 与 Linux 原地替换完成后由 Tauri 立即重启新进程
        app.restart();
    }

    async fn stream_download_verified(
        &self,
        app: &AppHandle,
        update: &tauri_plugin_updater::Update,
    ) -> Result<Vec<u8>> {
        self.update_and_emit(app, |s| {
            s.phase = "downloading".into();
            s.downloaded_bytes = 0;
            s.total_bytes = None;
            s.progress_percent = Some(0.0);
            s.error = None;
        });

        let mut downloaded: u64 = 0;
        let mut last_emit = Instant::now();
        let app_progress = app.clone();

        let res = update
            .download(
                |chunk_len, content_len| {
                    downloaded = downloaded.saturating_add(chunk_len as u64);
                    let pct = content_len
                        .filter(|&tot| tot > 0)
                        .map(|tot| ((downloaded as f64 / tot as f64) * 100.0).clamp(0.0, 100.0));
                    let is_done = content_len.map(|tot| downloaded >= tot).unwrap_or(false);
                    if is_done || last_emit.elapsed() >= Duration::from_millis(80) {
                        last_emit = Instant::now();
                        let snap = {
                            let mut g = self.snapshot.lock().unwrap();
                            g.phase = "downloading".into();
                            g.downloaded_bytes = downloaded;
                            g.total_bytes = content_len;
                            g.progress_percent = pct;
                            g.clone()
                        };
                        let _ = app_progress.emit("app-update-status", &snap);
                    }
                },
                || {},
            )
            .await;

        match res {
            Ok(bytes) => {
                let len = bytes.len() as u64;
                self.update_and_emit(app, |s| {
                    s.downloaded_bytes = len;
                    s.total_bytes = Some(len);
                    s.progress_percent = Some(100.0);
                    s.signature_verified = true;
                });
                Ok(bytes)
            }
            Err(e) => {
                let msg = format!("更新包下载或签名校验失败：{e:#}");
                self.update_and_emit(app, |s| {
                    s.phase = "error".into();
                    s.error = Some(msg.clone());
                });
                Err(anyhow!(msg))
            }
        }
    }
}

/// 后台定时更新巡检守护任务：
/// - 启动延迟 12 秒避开首屏渲染与首次 IMAP 握手高峰；
/// - 每 15 分钟唤醒比对一次 `last_checked_at` 与 `config.toml` `[update].check_interval_hours`，动态响应用户配置变更。
pub fn spawn_background_update_checker(
    app: AppHandle,
    db: Arc<Db>,
    manager: Arc<UpdaterManager>,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(12)).await;

        loop {
            if let Ok(cfg) = db.update_config() {
                if cfg.auto_check {
                    let last = manager.snapshot(&cfg.skipped_version).last_checked_at;
                    let interval_secs = (cfg.check_interval_hours.clamp(1, 168) as u64) * 3600;
                    let due = last == 0 || now_unix_secs().saturating_sub(last) >= interval_secs;
                    if due {
                        let _ = manager.check_for_updates(&app, &cfg, false).await;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });
}

/* ---------------- 安装渠道探测 ---------------- */

pub fn detect_install_channel() -> InstallChannelInfo {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_display = exe_path.to_string_lossy().to_string();

    if cfg!(debug_assertions) || is_cargo_target_binary(&exe_path) {
        return InstallChannelInfo {
            channel_id: "dev".into(),
            channel_label: "本地源码构建".into(),
            supports_hot_update: false,
            upgrade_command: Some("git pull && npm run desktop:build".into()),
            exe_path: exe_display,
        };
    }

    #[cfg(target_os = "windows")]
    {
        return detect_windows_channel(&exe_path, exe_display);
    }

    #[cfg(target_os = "macos")]
    {
        return detect_macos_channel(&exe_path, exe_display);
    }

    #[cfg(target_os = "linux")]
    {
        return detect_linux_channel(&exe_path, exe_display);
    }

    #[allow(unreachable_code)]
    InstallChannelInfo {
        channel_id: "portable".into(),
        channel_label: "独立发行版".into(),
        supports_hot_update: false,
        upgrade_command: None,
        exe_path: exe_display,
    }
}

fn is_cargo_target_binary(exe: &Path) -> bool {
    let lower = exe.to_string_lossy().replace('\\', "/").to_lowercase();
    lower.contains("/src-tauri/target/debug/")
        || lower.contains("/src-tauri/target/release/")
        || lower.contains("/target/debug/")
}

#[cfg(target_os = "windows")]
fn detect_windows_channel(exe: &Path, exe_display: String) -> InstallChannelInfo {
    let norm = exe_display.replace('/', "\\").to_lowercase();
    if norm.contains("\\scoop\\apps\\mailchat\\") {
        return InstallChannelInfo {
            channel_id: "scoop".into(),
            channel_label: "Scoop 声明式安装".into(),
            supports_hot_update: false,
            upgrade_command: Some("scoop update mailchat".into()),
            exe_path: exe_display,
        };
    }

    let has_nsis_uninstaller = exe
        .parent()
        .map(|dir| {
            dir.join("uninstall.exe").exists()
                || dir.join("Uninstall MailChat.exe").exists()
                || dir.join("uninstall-mailchat.exe").exists()
        })
        .unwrap_or(false);

    if has_nsis_uninstaller {
        InstallChannelInfo {
            channel_id: "nsis".into(),
            channel_label: "Windows 标准安装版 (NSIS)".into(),
            supports_hot_update: true,
            upgrade_command: None,
            exe_path: exe_display,
        }
    } else {
        InstallChannelInfo {
            channel_id: "portable".into(),
            channel_label: "Windows 免安装便携版".into(),
            supports_hot_update: false,
            upgrade_command: None,
            exe_path: exe_display,
        }
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_channel(exe: &Path, exe_display: String) -> InstallChannelInfo {
    let has_brew_caskroom = Path::new("/opt/homebrew/Caskroom/mailchat").exists()
        || Path::new("/usr/local/Caskroom/mailchat").exists();
    let app_bundle = find_macos_app_bundle(exe);
    let writable = app_bundle
        .as_ref()
        .and_then(|b| std::fs::metadata(b).ok())
        .map(|m| !m.permissions().readonly())
        .unwrap_or(false);

    if has_brew_caskroom {
        InstallChannelInfo {
            channel_id: "homebrew".into(),
            channel_label: "macOS (Homebrew Cask)".into(),
            supports_hot_update: writable,
            upgrade_command: Some("brew upgrade --cask mailchat".into()),
            exe_path: exe_display,
        }
    } else {
        InstallChannelInfo {
            channel_id: "macos_app".into(),
            channel_label: "macOS 应用包 (.app)".into(),
            supports_hot_update: app_bundle.is_some() && writable,
            upgrade_command: None,
            exe_path: exe_display,
        }
    }
}

#[cfg(target_os = "macos")]
fn find_macos_app_bundle(exe: &Path) -> Option<std::path::PathBuf> {
    let mut cur = Some(exe);
    while let Some(p) = cur {
        if p.extension().and_then(|e| e.to_str()) == Some("app") {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_linux_channel(_exe: &Path, exe_display: String) -> InstallChannelInfo {
    if std::env::var_os("APPIMAGE").is_some() {
        InstallChannelInfo {
            channel_id: "appimage".into(),
            channel_label: "Linux AppImage".into(),
            supports_hot_update: true,
            upgrade_command: None,
            exe_path: exe_display,
        }
    } else {
        InstallChannelInfo {
            channel_id: "deb".into(),
            channel_label: "Linux 系统安装包 (.deb)".into(),
            supports_hot_update: true,
            upgrade_command: None,
            exe_path: exe_display,
        }
    }
}

/* ---------------- GitHub Releases API 元数据兜底 ---------------- */

#[derive(Debug, Clone)]
struct GithubAssetMeta {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone)]
struct GithubReleaseMeta {
    version: String,
    body: String,
    published_date: Option<String>,
    html_url: String,
    manifest_asset_url: Option<String>,
    assets: Vec<GithubAssetMeta>,
}

#[derive(Deserialize)]
struct RawGhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct RawGhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<RawGhAsset>,
}

async fn fetch_github_release_meta(include_prerelease: bool) -> Result<Option<GithubReleaseMeta>> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("MailChat-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()?;

    let chosen: Option<RawGhRelease> = if include_prerelease {
        let url = format!("https://api.github.com/repos/{DEFAULT_GITHUB_REPO}/releases?per_page=8");
        let resp = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        let list: Vec<RawGhRelease> = resp.error_for_status()?.json().await?;
        list.into_iter().find(|r| !r.draft)
    } else {
        let url = format!("https://api.github.com/repos/{DEFAULT_GITHUB_REPO}/releases/latest");
        let resp = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        let rel: RawGhRelease = resp.error_for_status()?.json().await?;
        if rel.draft || rel.prerelease {
            None
        } else {
            Some(rel)
        }
    };

    let Some(rel) = chosen else {
        return Ok(None);
    };

    let manifest_asset_url = rel
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("latest.json"))
        .map(|a| a.browser_download_url.clone());

    let assets = rel
        .assets
        .into_iter()
        .map(|a| GithubAssetMeta {
            name: a.name,
            browser_download_url: a.browser_download_url,
        })
        .collect();

    let published_date = rel
        .published_at
        .as_deref()
        .and_then(|s| s.get(0..10))
        .map(|s| s.to_string());

    Ok(Some(GithubReleaseMeta {
        version: normalize_version_str(&rel.tag_name),
        body: rel.body.unwrap_or_default(),
        published_date,
        html_url: rel.html_url,
        manifest_asset_url,
        assets,
    }))
}

fn select_platform_asset_url(assets: &[GithubAssetMeta], channel_id: &str) -> Option<String> {
    let find_by_suffix = |suffix: &str| -> Option<String> {
        let lower = suffix.to_lowercase();
        assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(&lower))
            .map(|a| a.browser_download_url.clone())
    };

    match channel_id {
        "scoop" | "portable" => find_by_suffix("portable.zip").or_else(|| find_by_suffix("setup.exe")),
        "nsis" => find_by_suffix("setup.exe").or_else(|| find_by_suffix("portable.zip")),
        "appimage" => find_by_suffix(".appimage").or_else(|| find_by_suffix(".deb")),
        "deb" => find_by_suffix(".deb").or_else(|| find_by_suffix(".appimage")),
        "macos_app" | "homebrew" => {
            if cfg!(target_arch = "aarch64") {
                find_by_suffix("aarch64.dmg").or_else(|| find_by_suffix(".dmg"))
            } else {
                find_by_suffix("x64.dmg").or_else(|| find_by_suffix(".dmg"))
            }
        }
        _ => {
            if cfg!(target_os = "windows") {
                find_by_suffix("setup.exe").or_else(|| find_by_suffix("portable.zip"))
            } else if cfg!(target_os = "macos") {
                if cfg!(target_arch = "aarch64") {
                    find_by_suffix("aarch64.dmg").or_else(|| find_by_suffix(".dmg"))
                } else {
                    find_by_suffix("x64.dmg").or_else(|| find_by_suffix(".dmg"))
                }
            } else {
                find_by_suffix(".appimage").or_else(|| find_by_suffix(".deb"))
            }
        }
    }
}

/* ---------------- SemVer 版本号解析与严格比较 ---------------- */

pub fn normalize_version_str(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Option<String>,
}

fn parse_semver(raw: &str) -> Option<ParsedSemver> {
    let clean = normalize_version_str(raw);
    if clean.is_empty() {
        return None;
    }
    let without_build = clean.split('+').next().unwrap_or(&clean);
    let (core, pre) = match without_build.split_once('-') {
        Some((c, p)) => (
            c,
            if p.trim().is_empty() {
                None
            } else {
                Some(p.trim().to_string())
            },
        ),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some(ParsedSemver {
        major,
        minor,
        patch,
        pre,
    })
}

pub fn compare_versions(a: &str, b: &str) -> CmpOrdering {
    let (Some(pa), Some(pb)) = (parse_semver(a), parse_semver(b)) else {
        return normalize_version_str(a).cmp(&normalize_version_str(b));
    };

    match (pa.major, pa.minor, pa.patch).cmp(&(pb.major, pb.minor, pb.patch)) {
        CmpOrdering::Equal => match (&pa.pre, &pb.pre) {
            (None, None) => CmpOrdering::Equal,
            // 正式版高于同主次补丁号的预发布版（如 0.3.0 > 0.3.0-beta.1）
            (None, Some(_)) => CmpOrdering::Greater,
            (Some(_), None) => CmpOrdering::Less,
            (Some(sa), Some(sb)) => compare_prerelease(sa, sb),
        },
        ord => ord,
    }
}

fn compare_prerelease(a: &str, b: &str) -> CmpOrdering {
    let mut ia = a.split('.');
    let mut ib = b.split('.');
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return CmpOrdering::Equal,
            (None, Some(_)) => return CmpOrdering::Less,
            (Some(_), None) => return CmpOrdering::Greater,
            (Some(xa), Some(xb)) => {
                let ord = match (xa.parse::<u64>(), xb.parse::<u64>()) {
                    (Ok(na), Ok(nb)) => na.cmp(&nb),
                    (Ok(_), Err(_)) => CmpOrdering::Less,
                    (Err(_), Ok(_)) => CmpOrdering::Greater,
                    (Err(_), Err(_)) => xa.cmp(xb),
                };
                if ord != CmpOrdering::Equal {
                    return ord;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semver_and_prereleases_accurately() {
        assert_eq!(compare_versions("v0.2.1", "0.2.1"), CmpOrdering::Equal);
        assert_eq!(compare_versions("0.2.2", "0.2.1"), CmpOrdering::Greater);
        assert_eq!(compare_versions("0.10.0", "0.2.9"), CmpOrdering::Greater);
        assert_eq!(compare_versions("0.3.0", "0.3.0-beta.2"), CmpOrdering::Greater);
        assert_eq!(
            compare_versions("0.3.0-beta.10", "0.3.0-beta.2"),
            CmpOrdering::Greater
        );
        assert_eq!(compare_versions("0.2.0", "0.2.1"), CmpOrdering::Less);
    }

    #[test]
    fn picks_matching_asset_for_install_channel() {
        let assets = vec![
            GithubAssetMeta {
                name: "MailChat_0.3.0_x64-setup.exe".into(),
                browser_download_url: "https://example.com/setup.exe".into(),
            },
            GithubAssetMeta {
                name: "MailChat_0.3.0_x64-portable.zip".into(),
                browser_download_url: "https://example.com/portable.zip".into(),
            },
            GithubAssetMeta {
                name: "MailChat_0.3.0_aarch64.dmg".into(),
                browser_download_url: "https://example.com/aarch64.dmg".into(),
            },
        ];

        assert_eq!(
            select_platform_asset_url(&assets, "scoop").as_deref(),
            Some("https://example.com/portable.zip")
        );
        assert_eq!(
            select_platform_asset_url(&assets, "portable").as_deref(),
            Some("https://example.com/portable.zip")
        );
        assert_eq!(
            select_platform_asset_url(&assets, "nsis").as_deref(),
            Some("https://example.com/setup.exe")
        );
    }

    #[test]
    fn normalizes_update_config_bounds_and_protocols() {
        let raw = UpdateConfig {
            auto_check: true,
            auto_download: false,
            check_interval_hours: 0,
            channel: "Preview".into(),
            skipped_version: "v0.2.2 ".into(),
            custom_endpoint: "ftp://insecure.example/latest.json".into(),
        };
        let norm = raw.normalized();
        assert_eq!(norm.check_interval_hours, 1);
        assert_eq!(norm.channel, "beta");
        assert_eq!(norm.skipped_version, "0.2.2");
        assert!(norm.custom_endpoint.is_empty());
    }
}
