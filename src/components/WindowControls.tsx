import { useEffect, useRef, useState, type MouseEvent } from "react";
import { api } from "../api";
import type { AccountEntry } from "../types";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconPin,
  IconPlus,
  IconSliders,
  IconWinMaximize,
  IconWinMinimize,
  IconWinRestore,
} from "./Icons";

const INTERACTIVE_SELECTOR =
  'button, input, textarea, select, a, label, code, [role="button"], .no-drag';

/** 在空白顶栏、导航侧栏或卡片间距处按住左键拖动无边框窗口 */
export function startWindowDrag(e: MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest(INTERACTIVE_SELECTOR)) return;
  if (e.detail >= 2) return;
  api.windowAction("drag").catch(() => {});
}

/** 双击顶栏空白区域切换最大化 / 还原 */
export function toggleWindowMaximize(e: MouseEvent) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest(INTERACTIVE_SELECTOR)) return;
  api
    .windowAction("toggle_maximize")
    .then((max) => window.dispatchEvent(new CustomEvent("mailchat-win-max", { detail: max })))
    .catch(() => {});
}

export interface WindowControlsProps {
  accountEmail?: string;
  accountName?: string;
  accounts?: AccountEntry[];
  syncing?: boolean;
  switchingAccount?: boolean;
  hasDemo?: boolean;
  onClickAccount?: () => void;
  onSwitchAccount?: (email: string) => void;
  onAddAccount?: () => void;
  onManageAccounts?: () => void;
}

function avatarChar(displayName?: string, email?: string): string {
  const src = (displayName?.trim() || email?.trim() || "?")[0];
  return src ? src.toUpperCase() : "?";
}

/** 微信桌面端风格的外层顶部窗口栏（左侧品牌与多邮箱快速切换胶囊 + 右侧置顶 / 最小化 / 最大化 / 关闭） */
export function WindowControls({
  accountEmail,
  accountName,
  accounts = [],
  syncing = false,
  switchingAccount = false,
  hasDemo = false,
  onClickAccount,
  onSwitchAccount,
  onAddAccount,
  onManageAccounts,
}: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  const activeEntry = accounts.find((a) => a.active);
  const trimmedEmail = accountEmail?.trim() || activeEntry?.email?.trim() || "";
  const effectiveName = accountName?.trim() || activeEntry?.display_name?.trim() || "";
  const hasPassword = activeEntry ? activeEntry.has_password : Boolean(trimmedEmail);

  const otherUnread = accounts
    .filter((a) => !a.active)
    .reduce((sum, a) => sum + (a.inbox_unread || 0), 0);

  const statusKind =
    syncing || switchingAccount
      ? "syncing"
      : trimmedEmail
        ? hasPassword
          ? "online"
          : "warn"
        : hasDemo
          ? "demo"
          : "idle";

  const pillLabel = trimmedEmail
    ? switchingAccount
      ? `${trimmedEmail} · 切换中`
      : syncing
        ? `${trimmedEmail} · 同步中`
        : trimmedEmail
    : hasDemo
      ? "演示信箱 · 点击绑定邮箱"
      : "未绑定邮箱 · 点击配置";

  const pillTitle = trimmedEmail
    ? `${syncing ? "正在同步：" : "当前邮箱："}${effectiveName ? `${effectiveName} (${trimmedEmail})` : trimmedEmail}${accounts.length > 1 ? ` · 已接入 ${accounts.length} 个账号，点击快速切换` : "（点击切换或添加更多邮箱账号）"}`
    : hasDemo
      ? "当前展示本地演示会话，点击绑定真实 IMAP / SMTP 邮箱"
      : "尚未绑定邮箱账号，点击前往配置";

  useEffect(() => {
    const sync = () => {
      api
        .windowAction("is_maximized")
        .then(setMaximized)
        .catch(() => {});
    };
    const onCustom = (ev: Event) => {
      const detail = (ev as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setMaximized(detail);
    };
    sync();
    api
      .windowAction("is_pinned")
      .then(setPinned)
      .catch(() => {});
    window.addEventListener("resize", sync);
    window.addEventListener("mailchat-win-max", onCustom);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("mailchat-win-max", onCustom);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (ev: globalThis.MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handlePillClick = () => {
    if (accounts.length === 0 && !trimmedEmail) {
      if (onAddAccount) onAddAccount();
      else onClickAccount?.();
      return;
    }
    setMenuOpen((v) => !v);
  };

  return (
    <header
      className="window-titlebar"
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <div className="win-titlebar-left">
        <span className="win-brand-title">MailChat</span>
        <span className="win-titlebar-sep" aria-hidden="true" />

        <div className="win-account-switcher-wrap no-drag" ref={switcherRef}>
          <button
            type="button"
            className={`win-account-pill no-drag ${menuOpen ? "open" : ""}`}
            onClick={handlePillClick}
            title={pillTitle}
          >
            <span className={`win-status-dot ${statusKind}`} aria-hidden="true" />
            <span className="win-account-text">{pillLabel}</span>
            {trimmedEmail && otherUnread > 0 ? (
              <span
                className="win-account-other-badge unread"
                title={`其他邮箱共有 ${otherUnread} 封未读邮件`}
              >
                +{otherUnread > 99 ? "99+" : otherUnread}
              </span>
            ) : (
              accounts.length > 1 && (
                <span className="win-account-other-badge">{accounts.length}</span>
              )
            )}
            {trimmedEmail && (
              <IconChevron
                size={11}
                className={`win-account-caret ${menuOpen ? "open" : ""}`}
              />
            )}
          </button>

          {menuOpen && (
            <div className="win-account-popover" role="menu" aria-label="多邮箱账号切换">
              <div className="win-account-pop-head">
                <span>已接入邮箱 ({accounts.length || 1})</span>
                <span className="win-account-pop-hint">数据与凭据独立隔离</span>
              </div>

              <div className="win-account-pop-list">
                {accounts.map((acc) => {
                  const labelName = acc.display_name?.trim() || acc.email.split("@")[0];
                  return (
                    <button
                      key={acc.email}
                      type="button"
                      className={`win-account-option ${acc.active ? "active" : ""}`}
                      disabled={switchingAccount}
                      onClick={() => {
                        setMenuOpen(false);
                        if (!acc.active) {
                          onSwitchAccount?.(acc.email);
                        }
                      }}
                    >
                      <span className={`win-account-avatar ${acc.active ? "active" : ""}`}>
                        {avatarChar(acc.display_name, acc.email)}
                      </span>

                      <span className="win-account-opt-main">
                        <span className="win-account-opt-top">
                          <span className="win-account-opt-name">{labelName}</span>
                          {!acc.has_password && (
                            <span className="win-account-opt-warn">待填授权码</span>
                          )}
                        </span>
                        <span className="win-account-opt-email">{acc.email}</span>
                      </span>

                      <span className="win-account-opt-right">
                        {acc.inbox_unread > 0 && (
                          <span className="win-account-opt-unread">
                            {acc.inbox_unread > 99 ? "99+" : acc.inbox_unread}
                          </span>
                        )}
                        {acc.active && (
                          <span className="win-account-opt-current">
                            <IconCheck size={11} />
                            当前
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="win-account-pop-divider" />

              <div className="win-account-pop-actions">
                <button
                  type="button"
                  className="win-account-pop-action primary"
                  onClick={() => {
                    setMenuOpen(false);
                    if (onAddAccount) onAddAccount();
                    else onClickAccount?.();
                  }}
                >
                  <IconPlus size={13} />
                  <span>接入新邮箱账号</span>
                </button>
                <button
                  type="button"
                  className="win-account-pop-action"
                  onClick={() => {
                    setMenuOpen(false);
                    if (onManageAccounts) onManageAccounts();
                    else onClickAccount?.();
                  }}
                >
                  <IconSliders size={13} />
                  <span>多账号与服务器管理</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="win-controls no-drag" aria-label="窗口控制">
        <button
          type="button"
          className={`win-ctl ${pinned ? "pinned" : ""}`}
          onClick={async () => {
            try {
              setPinned(await api.windowAction("toggle_pin"));
            } catch {
              // ignore in plain browser preview
            }
          }}
          title={pinned ? "取消置顶" : "置顶"}
        >
          <IconPin size={14} />
        </button>

        <button
          type="button"
          className="win-ctl"
          onClick={() => api.windowAction("minimize").catch(() => {})}
          title="最小化"
        >
          <IconWinMinimize size={14} />
        </button>

        <button
          type="button"
          className="win-ctl"
          onClick={async () => {
            try {
              setMaximized(await api.windowAction("toggle_maximize"));
            } catch {
              // ignore in plain browser preview
            }
          }}
          title={maximized ? "向下还原" : "最大化"}
        >
          {maximized ? <IconWinRestore size={14} /> : <IconWinMaximize size={14} />}
        </button>

        <button
          type="button"
          className="win-ctl close"
          onClick={() => api.windowAction("close").catch(() => {})}
          title="关闭"
        >
          <IconClose size={14} />
        </button>
      </div>
    </header>
  );
}
