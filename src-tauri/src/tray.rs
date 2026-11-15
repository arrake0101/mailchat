//! 系统托盘常驻、关闭最小化拦截与新消息闪烁提醒（托盘图标交替闪动 + 任务栏高亮闪烁联动）。

use crate::config;
use crate::db::Db;
use crate::mail::SyncOutcome;
use crate::vault::Vault;
use crate::{run_sync, WatcherControl};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

const TRAY_BLINK_INTERVAL_MS: u64 = 450;

const MENU_ID_SHOW: &str = "tray_show_main";
const MENU_ID_SYNC: &str = "tray_sync_now";
const MENU_ID_TOGGLE_FLASH: &str = "tray_toggle_flash";
const MENU_ID_QUIT: &str = "tray_quit_app";

struct TrayIcons {
    normal: Image<'static>,
    badge: Image<'static>,
    blank: Image<'static>,
}

pub struct TrayAlertManager {
    quitting: AtomicBool,
    blinking: AtomicBool,
    wake_mu: Mutex<u64>,
    wake_cv: Condvar,
    fresh_pending_ids: Mutex<HashSet<i64>>,
    icons: TrayIcons,
    tray: Mutex<Option<TrayIcon>>,
    flash_menu_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    last_static_unread_dot: Mutex<Option<bool>>,
    last_tooltip: Mutex<String>,
}

fn fallback_app_icon() -> Image<'static> {
    let w = 32u32;
    let h = 32u32;
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 2..30 {
        for x in 2..30 {
            let idx = ((y * w + x) * 4) as usize;
            rgba[idx] = 37;
            rgba[idx + 1] = 99;
            rgba[idx + 2] = 235;
            rgba[idx + 3] = 255;
        }
    }
    Image::new_owned(rgba, w, h)
}

/// 基于应用原始 RGBA 图标动态合成：正常图标、右下角红点新消息图标、等尺寸全透明闪烁帧（防止托盘邻近图标抖动位移）。
fn build_icon_variants(base_opt: Option<Image<'static>>) -> TrayIcons {
    let normal = base_opt.unwrap_or_else(fallback_app_icon);
    let w = normal.width().max(1);
    let h = normal.height().max(1);
    let mut badge_rgba = normal.rgba().to_vec();
    let expected_len = (w as usize) * (h as usize) * 4;
    if badge_rgba.len() != expected_len {
        badge_rgba.resize(expected_len, 0);
    }

    let min_dim = (w.min(h)) as f32;
    let r_inner = (min_dim * 0.215).max(3.0);
    let ring = (min_dim * 0.055).max(1.0);
    let r_outer = r_inner + ring;
    let margin = (min_dim * 0.02).max(0.5);
    let cx = (w as f32) - r_outer - margin;
    let cy = (h as f32) - r_outer - margin;

    let x0 = ((cx - r_outer - 1.5).floor().max(0.0)) as u32;
    let x1 = ((cx + r_outer + 1.5).ceil().min(w as f32)) as u32;
    let y0 = ((cy - r_outer - 1.5).floor().max(0.0)) as u32;
    let y1 = ((cy + r_outer + 1.5).ceil().min(h as f32)) as u32;

    for py in y0..y1 {
        for px in x0..x1 {
            let dx = (px as f32 + 0.5) - cx;
            let dy = (py as f32 + 0.5) - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > r_outer + 0.8 {
                continue;
            }
            let outer_cov = (r_outer + 0.5 - dist).clamp(0.0, 1.0);
            if outer_cov <= 0.0 {
                continue;
            }
            let inner_cov = (r_inner + 0.5 - dist).clamp(0.0, 1.0);
            // 外圈纯白描边 (255, 255, 255) -> 内圈醒目消息红 (255, 59, 48)
            let sr = 255.0;
            let sg = 255.0 * (1.0 - inner_cov) + 59.0 * inner_cov;
            let sb = 255.0 * (1.0 - inner_cov) + 48.0 * inner_cov;
            let sa = outer_cov;

            let idx = ((py * w + px) * 4) as usize;
            let dr = badge_rgba[idx] as f32;
            let dg = badge_rgba[idx + 1] as f32;
            let db = badge_rgba[idx + 2] as f32;
            let da = (badge_rgba[idx + 3] as f32) / 255.0;

            let out_a = sa + da * (1.0 - sa);
            if out_a > 0.001 {
                let out_r = (sr * sa + dr * da * (1.0 - sa)) / out_a;
                let out_g = (sg * sa + dg * da * (1.0 - sa)) / out_a;
                let out_b = (sb * sa + db * da * (1.0 - sa)) / out_a;
                badge_rgba[idx] = out_r.round().clamp(0.0, 255.0) as u8;
                badge_rgba[idx + 1] = out_g.round().clamp(0.0, 255.0) as u8;
                badge_rgba[idx + 2] = out_b.round().clamp(0.0, 255.0) as u8;
                badge_rgba[idx + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    let badge = Image::new_owned(badge_rgba, w, h);
    let blank = Image::new_owned(vec![0u8; expected_len], w, h);
    TrayIcons {
        normal,
        badge,
        blank,
    }
}

#[cfg(target_os = "windows")]
fn force_foreground_win32(win: &tauri::WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn SetForegroundWindow(hwnd: isize) -> i32;
    }
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = SetForegroundWindow(hwnd.0 as isize);
        }
    }
}

fn set_taskbar_attention(win: &tauri::WebviewWindow, active: bool) {
    if active {
        let _ = win.request_user_attention(Some(UserAttentionType::Critical));
    } else {
        let _ = win.request_user_attention(None);
    }
}

impl TrayAlertManager {
    pub fn new(base_icon: Option<Image<'static>>) -> Arc<Self> {
        let mgr = Arc::new(Self {
            quitting: AtomicBool::new(false),
            blinking: AtomicBool::new(false),
            wake_mu: Mutex::new(0),
            wake_cv: Condvar::new(),
            fresh_pending_ids: Mutex::new(HashSet::new()),
            icons: build_icon_variants(base_icon),
            tray: Mutex::new(None),
            flash_menu_item: Mutex::new(None),
            last_static_unread_dot: Mutex::new(None),
            last_tooltip: Mutex::new(String::new()),
        });
        Self::spawn_blink_worker(mgr.clone());
        mgr
    }

    fn signal_wake(&self) {
        if let Ok(mut seq) = self.wake_mu.lock() {
            *seq = seq.wrapping_add(1);
            self.wake_cv.notify_all();
        }
    }

    fn spawn_blink_worker(mgr: Arc<Self>) {
        let _ = std::thread::Builder::new()
            .name("mailchat-tray-blink".into())
            .spawn(move || {
                let mut show_badge_frame = true;
                loop {
                    if mgr.quitting.load(Ordering::SeqCst) {
                        break;
                    }

                    if !mgr.blinking.load(Ordering::SeqCst) {
                        let Ok(guard) = mgr.wake_mu.lock() else {
                            std::thread::sleep(Duration::from_secs(1));
                            continue;
                        };
                        if !mgr.blinking.load(Ordering::SeqCst) && !mgr.quitting.load(Ordering::SeqCst) {
                            drop(mgr.wake_cv.wait(guard));
                        }
                        show_badge_frame = true;
                        continue;
                    }

                    let frame = if show_badge_frame {
                        mgr.icons.badge.clone()
                    } else {
                        mgr.icons.blank.clone()
                    };
                    show_badge_frame = !show_badge_frame;

                    if let Ok(guard) = mgr.tray.lock() {
                        if let Some(tray) = guard.as_ref() {
                            let _ = tray.set_icon(Some(frame));
                        }
                    }

                    if let Ok(guard) = mgr.wake_mu.lock() {
                        if mgr.blinking.load(Ordering::SeqCst) && !mgr.quitting.load(Ordering::SeqCst) {
                            drop(
                                mgr.wake_cv
                                    .wait_timeout(guard, Duration::from_millis(TRAY_BLINK_INTERVAL_MS)),
                            );
                        }
                    } else {
                        std::thread::sleep(Duration::from_millis(TRAY_BLINK_INTERVAL_MS));
                    }
                }
            });
    }

    pub fn attach_tray(
        &self,
        tray: TrayIcon,
        flash_item: CheckMenuItem<tauri::Wry>,
        db: &Db,
    ) {
        if let Ok(mut g) = self.tray.lock() {
            *g = Some(tray);
        }
        if let Ok(mut g) = self.flash_menu_item.lock() {
            *g = Some(flash_item);
        }
        self.refresh_summary(db);
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        self.blinking.store(false, Ordering::SeqCst);
        self.signal_wake();
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn is_blinking(&self) -> bool {
        self.blinking.load(Ordering::SeqCst)
    }

    pub fn register_fresh_pending(&self, ids: &[i64]) {
        if ids.is_empty() {
            return;
        }
        if let Ok(mut set) = self.fresh_pending_ids.lock() {
            if set.len() > 512 {
                set.clear();
            }
            for &id in ids {
                set.insert(id);
            }
        }
    }

    pub fn take_fresh_pending(&self, id: i64) -> bool {
        self.fresh_pending_ids
            .lock()
            .map(|mut set| set.remove(&id))
            .unwrap_or(false)
    }

    fn set_tooltip_if_changed(&self, tooltip: String) {
        let should_update = if let Ok(mut last) = self.last_tooltip.lock() {
            if *last == tooltip {
                false
            } else {
                *last = tooltip.clone();
                true
            }
        } else {
            true
        };
        if should_update {
            if let Ok(guard) = self.tray.lock() {
                if let Some(tray) = guard.as_ref() {
                    let _ = tray.set_tooltip(Some(tooltip));
                }
            }
        }
    }

    fn apply_static_icon(&self, has_unread: bool, force: bool) {
        let should_update = if let Ok(mut last) = self.last_static_unread_dot.lock() {
            if !force && *last == Some(has_unread) {
                false
            } else {
                *last = Some(has_unread);
                true
            }
        } else {
            true
        };
        if should_update {
            let icon = if has_unread {
                self.icons.badge.clone()
            } else {
                self.icons.normal.clone()
            };
            if let Ok(guard) = self.tray.lock() {
                if let Some(tray) = guard.as_ref() {
                    let _ = tray.set_icon(Some(icon));
                }
            }
        }
    }

    /// 根据当前数据库未读“消息(inbox)”总数刷新托盘静态角标与悬停提示（若未读已清零则自动停止闪烁）。
    pub fn refresh_summary(&self, db: &Db) {
        let unread = db.total_real_inbox_unread();
        if unread <= 0 && self.blinking.swap(false, Ordering::SeqCst) {
            if let Ok(mut last) = self.last_static_unread_dot.lock() {
                *last = None;
            }
            self.signal_wake();
        }

        if self.blinking.load(Ordering::SeqCst) {
            let tip = if unread > 0 {
                format!("MailChat · 收到新消息（{unread} 封未读，点击查看）")
            } else {
                "MailChat · 收到新消息，点击查看".to_string()
            };
            self.set_tooltip_if_changed(tip);
        } else {
            self.apply_static_icon(unread > 0, false);
            let tip = if unread > 0 {
                format!("MailChat · {unread} 封未读消息")
            } else {
                "MailChat · 后台收信守护中".to_string()
            };
            self.set_tooltip_if_changed(tip);
        }
    }

    /// 处理单次收信结果：对已确认进入“消息(inbox)”的未读新来信立即触发提醒，对等待 AI 分拣的新来信登记后续回调。
    pub fn handle_sync_outcome(&self, app: &AppHandle, db: &Db, outcome: &SyncOutcome) {
        if !outcome.fresh_pending_ids.is_empty() {
            self.register_fresh_pending(&outcome.fresh_pending_ids);
        }
        if outcome.alert_inbox_unread > 0 {
            self.notify_new_inbox_messages(app, db);
        } else {
            self.refresh_summary(db);
        }
    }

    /// 当收到“消息(inbox)”分类未读新来信时触发托盘闪动与任务栏高亮闪烁（若主窗口正在前台聚焦查看则不打扰）。
    pub fn notify_new_inbox_messages(&self, app: &AppHandle, db: &Db) {
        let (actively_viewing, win_opt) = if let Some(win) = app.get_webview_window("main") {
            let vis = win.is_visible().unwrap_or(false);
            let min = win.is_minimized().unwrap_or(false);
            let foc = win.is_focused().unwrap_or(false);
            (vis && !min && foc, Some(win))
        } else {
            (false, None)
        };

        if actively_viewing {
            self.refresh_summary(db);
            return;
        }

        let wcfg = db.window_config().unwrap_or_default();
        if wcfg.taskbar_flash_on_message {
            if let Some(win) = &win_opt {
                if win.is_visible().unwrap_or(false) {
                    set_taskbar_attention(win, true);
                }
            }
        }

        if wcfg.tray_flash_on_message {
            if let Ok(mut last) = self.last_static_unread_dot.lock() {
                *last = None;
            }
            let was_blinking = self.blinking.swap(true, Ordering::SeqCst);
            let unread = db.total_real_inbox_unread();
            let tip = if unread > 0 {
                format!("MailChat · 收到新消息（{unread} 封未读，点击查看）")
            } else {
                "MailChat · 收到新消息，点击查看".to_string()
            };
            self.set_tooltip_if_changed(tip);
            if !was_blinking {
                self.signal_wake();
            }
        } else {
            self.refresh_summary(db);
        }
    }

    /// 用户点击托盘图标或切回主窗口聚焦时立即停止闪烁并恢复静态图标。
    pub fn stop_alert(&self, app: &AppHandle, db: &Db) -> bool {
        let was_blinking = self.blinking.swap(false, Ordering::SeqCst);
        if was_blinking {
            self.signal_wake();
        }
        if let Some(win) = app.get_webview_window("main") {
            set_taskbar_attention(&win, false);
        }
        let unread = db.total_real_inbox_unread();
        self.apply_static_icon(unread > 0, true);
        let tip = if unread > 0 {
            format!("MailChat · {unread} 封未读消息")
        } else {
            "MailChat · 后台收信守护中".to_string()
        };
        self.set_tooltip_if_changed(tip);
        was_blinking
    }

    /// 当 `[window]` 配置变更时同步更新托盘菜单勾选状态与当前闪烁状态。
    pub fn reconcile_config(&self, app: &AppHandle, db: &Db) {
        let wcfg = db.window_config().unwrap_or_default();
        if let Ok(guard) = self.flash_menu_item.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_checked(wcfg.tray_flash_on_message || wcfg.taskbar_flash_on_message);
            }
        }
        if !wcfg.taskbar_flash_on_message {
            if let Some(win) = app.get_webview_window("main") {
                set_taskbar_attention(&win, false);
            }
        }
        if !wcfg.tray_flash_on_message && self.blinking.swap(false, Ordering::SeqCst) {
            self.signal_wake();
            let unread = db.total_real_inbox_unread();
            self.apply_static_icon(unread > 0, true);
        }
        self.refresh_summary(db);
    }
}

pub fn restore_and_focus_main_window(
    app: &AppHandle,
    db: &Db,
    watcher: &WatcherControl,
    tray_mgr: &Arc<TrayAlertManager>,
) {
    let was_blinking = tray_mgr.stop_alert(app, db);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.set_focus();
        #[cfg(target_os = "windows")]
        force_foreground_win32(&win);
    }
    watcher.poke();
    if was_blinking {
        let _ = app.emit("tray-open-inbox", true);
    }
}

pub fn quit_application(
    app: &AppHandle,
    watcher: &WatcherControl,
    tray_mgr: &Arc<TrayAlertManager>,
) {
    tray_mgr.mark_quitting();
    watcher.interrupt_socket();
    app.exit(0);
}

#[allow(clippy::too_many_arguments)]
pub fn setup_system_tray_and_window_hooks(
    app: &tauri::App,
    app_dir: &Path,
    db: Arc<Db>,
    vault: Arc<Vault>,
    syncing: Arc<AtomicBool>,
    watcher: Arc<WatcherControl>,
    tray_mgr: Arc<TrayAlertManager>,
) -> tauri::Result<()> {
    let wcfg = db.window_config().unwrap_or_default();
    let flash_checked = wcfg.tray_flash_on_message || wcfg.taskbar_flash_on_message;

    let show_item = MenuItem::with_id(app, MENU_ID_SHOW, "打开 MailChat 主窗口", true, None::<&str>)?;
    let sync_item = MenuItem::with_id(app, MENU_ID_SYNC, "立即同步收信", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let flash_item = CheckMenuItem::with_id(
        app,
        MENU_ID_TOGGLE_FLASH,
        "新消息闪烁提醒",
        true,
        flash_checked,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, "退出 MailChat", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_item, &sync_item, &sep1, &flash_item, &sep2, &quit_item],
    )?;

    let db_menu = db.clone();
    let vault_menu = vault;
    let syncing_menu = syncing;
    let watcher_menu = watcher.clone();
    let tray_mgr_menu = tray_mgr.clone();
    let app_dir_buf = app_dir.to_path_buf();

    let db_click = db.clone();
    let watcher_click = watcher.clone();
    let tray_mgr_click = tray_mgr.clone();

    let initial_icon = if db.total_real_inbox_unread() > 0 {
        tray_mgr.icons.badge.clone()
    } else {
        tray_mgr.icons.normal.clone()
    };

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(initial_icon)
        .tooltip("MailChat · 后台收信守护中")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, ev| match ev.id().as_ref() {
            MENU_ID_SHOW => {
                restore_and_focus_main_window(app_handle, &db_menu, &watcher_menu, &tray_mgr_menu);
            }
            MENU_ID_SYNC => {
                let app_clone = app_handle.clone();
                let db_c = db_menu.clone();
                let vault_c = vault_menu.clone();
                let sync_c = syncing_menu.clone();
                let watch_c = watcher_menu.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_sync(&app_clone, db_c, vault_c, sync_c, watch_c).await;
                });
            }
            MENU_ID_TOGGLE_FLASH => {
                let mut cur = db_menu.window_config().unwrap_or_default();
                let next_on = !(cur.tray_flash_on_message || cur.taskbar_flash_on_message);
                cur.tray_flash_on_message = next_on;
                cur.taskbar_flash_on_message = next_on;
                if db_menu.save_window_config(&cur).is_ok() {
                    let _ = config::sync_disk_toml(&app_dir_buf, &db_menu);
                    let _ = app_handle.emit("window-config-updated", &cur);
                    tray_mgr_menu.reconcile_config(app_handle, &db_menu);
                }
            }
            MENU_ID_QUIT => {
                quit_application(app_handle, &watcher_menu, &tray_mgr_menu);
            }
            _ => {}
        })
        .on_tray_icon_event(move |tray_icon, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                restore_and_focus_main_window(
                    tray_icon.app_handle(),
                    &db_click,
                    &watcher_click,
                    &tray_mgr_click,
                );
            }
            _ => {}
        })
        .build(app)?;

    tray_mgr.attach_tray(tray, flash_item, &db);

    if let Some(win) = app.get_webview_window("main") {
        let win_clone = win.clone();
        let app_handle = app.handle().clone();
        let db_ev = db;
        let watcher_ev = watcher;
        let tray_ev = tray_mgr;
        win.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if tray_ev.is_quitting() {
                    return;
                }
                let close_to_tray = db_ev
                    .window_config()
                    .map(|c| c.close_to_tray)
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = win_clone.hide();
                } else {
                    tray_ev.mark_quitting();
                    watcher_ev.interrupt_socket();
                }
            }
            tauri::WindowEvent::Focused(true) => {
                tray_ev.stop_alert(&app_handle, &db_ev);
            }
            _ => {}
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Account, NewMessage};

    #[test]
    fn build_icon_variants_preserves_dimensions_and_creates_red_badge_and_blank_frame() {
        let icons = build_icon_variants(None);
        let w = icons.normal.width();
        let h = icons.normal.height();
        let expected_len = (w as usize) * (h as usize) * 4;

        assert_eq!(w, 32);
        assert_eq!(h, 32);
        assert_eq!(icons.normal.rgba().len(), expected_len);
        assert_eq!(icons.badge.width(), w);
        assert_eq!(icons.badge.height(), h);
        assert_eq!(icons.badge.rgba().len(), expected_len);
        assert_eq!(icons.blank.width(), w);
        assert_eq!(icons.blank.height(), h);
        assert_eq!(icons.blank.rgba().len(), expected_len);

        // 空白闪烁帧必须等尺寸全透明，防止 Windows 托盘邻近图标位移抖动
        assert!(icons.blank.rgba().iter().all(|&b| b == 0));

        // 右下角角标帧必须包含醒目消息红像素 (255, 59, 48, 255)
        let has_red_core = icons
            .badge
            .rgba()
            .chunks_exact(4)
            .any(|px| px[0] == 255 && px[1] == 59 && px[2] == 48 && px[3] == 255);
        assert!(has_red_core, "角标图标应在右下角渲染醒目消息红圆点");
    }

    #[test]
    fn real_inbox_unread_filters_demo_archived_blocked_and_tracks_pending_ids() {
        let dir = std::env::temp_dir().join(format!(
            "mailchat_tray_test_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("tray.db")).unwrap();

        // 未绑定真实账号时的演示会话数据不应污染系统托盘真实未读角标
        db.seed_demo_data("me@mailchat.local").unwrap();
        assert_eq!(db.total_real_inbox_unread(), 0);

        let acc = Account {
            email: "me@example.com".into(),
            ..Default::default()
        };
        db.save_account(&acc).unwrap();

        let make_mail = |uid: u32, peer: &str, outgoing: bool, status: &str, read: bool| NewMessage {
            folder: "INBOX".into(),
            uid,
            message_id: format!("m-{uid}@example.com"),
            in_reply_to: String::new(),
            references: String::new(),
            from_addr: if outgoing {
                "me@example.com".into()
            } else {
                peer.into()
            },
            from_name: peer.into(),
            to_addrs: if outgoing {
                peer.into()
            } else {
                "me@example.com".into()
            },
            cc_addrs: String::new(),
            subject: format!("Subj {uid}"),
            body: "hello".into(),
            body_full: "hello".into(),
            body_html: String::new(),
            date: 1_700_000_000 + uid as i64,
            outgoing,
            peer: peer.into(),
            status: status.into(),
            category: "单聊".into(),
            summary: "hello".into(),
            reason: String::new(),
            extracted_code: String::new(),
            suggested_reply: String::new(),
            read,
            agent_done: true,
            attachments: Vec::new(),
            reply_to: None,
        };

        let inbox_id = db
            .insert_message(&make_mail(1, "alice@example.com", false, "inbox", false))
            .unwrap()
            .unwrap();
        let archived_id = db
            .insert_message(&make_mail(2, "notice@example.com", false, "archived", false))
            .unwrap()
            .unwrap();
        let blocked_id = db
            .insert_message(&make_mail(3, "spam@example.com", false, "blocked", false))
            .unwrap()
            .unwrap();
        let outgoing_id = db
            .insert_message(&make_mail(4, "alice@example.com", true, "inbox", false))
            .unwrap()
            .unwrap();

        assert_eq!(db.total_real_inbox_unread(), 1);
        assert!(db.is_unread_inbox_message(inbox_id));
        assert!(!db.is_unread_inbox_message(archived_id));
        assert!(!db.is_unread_inbox_message(blocked_id));
        assert!(!db.is_unread_inbox_message(outgoing_id));

        db.set_peer_read("alice@example.com", "inbox", true).unwrap();
        assert_eq!(db.total_real_inbox_unread(), 0);
        assert!(!db.is_unread_inbox_message(inbox_id));

        let mgr = TrayAlertManager::new(None);
        mgr.register_fresh_pending(&[inbox_id, archived_id]);
        assert!(mgr.take_fresh_pending(inbox_id));
        assert!(!mgr.take_fresh_pending(inbox_id));
        assert!(mgr.take_fresh_pending(archived_id));
        assert!(!mgr.take_fresh_pending(999_999));

        mgr.mark_quitting();
        assert!(mgr.is_quitting());
        assert!(!mgr.is_blinking());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
