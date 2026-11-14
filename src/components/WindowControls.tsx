import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "../api";
import type { AccountEntry } from "../types";
import {
  IconArrowDown,
  IconArrowUp,
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

const STRIP_GAP_PX = 6;

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
  onReorderAccounts?: (emails: string[]) => Promise<void> | void;
  onAddAccount?: () => void;
  onManageAccounts?: () => void;
}

function avatarChar(displayName?: string, email?: string): string {
  const src = (displayName?.trim() || email?.trim() || "?")[0];
  return src ? src.toUpperCase() : "?";
}

function getPillText(acc: AccountEntry, syncing: boolean, switchingAccount: boolean): string {
  if (acc.active && switchingAccount) return `${acc.email} · 切换中`;
  if (acc.active && syncing) return `${acc.email} · 同步中`;
  return acc.email;
}

function getDotStatus(acc: AccountEntry, syncing: boolean, switchingAccount: boolean): string {
  if (acc.active && (syncing || switchingAccount)) return "syncing";
  if (!acc.has_password) return "warn";
  return acc.active ? "online" : "standby";
}

/** 微信桌面端风格的外层顶部窗口栏（左侧品牌 + 自适应平铺/折叠多邮箱栏 + 右侧窗口控制按钮） */
export function WindowControls({
  accountEmail,
  accountName,
  accounts = [],
  syncing = false,
  switchingAccount = false,
  hasDemo = false,
  onClickAccount,
  onSwitchAccount,
  onReorderAccounts,
  onAddAccount,
  onManageAccounts,
}: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // 拖拽排序状态（左键按住邮箱胶囊左右拖动即可调整前后顺序）
  const [dragEmail, setDragEmail] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const suppressClickRef = useRef(false);

  // 自适应宽度预算与可见胶囊集合
  const [visibleEmails, setVisibleEmails] = useState<string[] | null>(null);
  const [singleMaxPx, setSingleMaxPx] = useState<number>(240);

  const headerRef = useRef<HTMLElement>(null);
  const brandClusterRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const pillsRowRef = useRef<HTMLDivElement>(null);
  const measureRowRef = useRef<HTMLDivElement>(null);

  const trimmedEmail = accountEmail?.trim() || "";

  // 合并实时的账号列表（兼容首帧 accounts 尚未返回但已有 accountEmail 的情况）
  const baseAccounts = useMemo<AccountEntry[]>(() => {
    if (accounts.length > 0) return accounts;
    if (!trimmedEmail) return [];
    return [
      {
        email: trimmedEmail,
        display_name: accountName?.trim() || "",
        imap_host: "",
        imap_port: 993,
        smtp_host: "",
        smtp_port: 465,
        username: trimmedEmail,
        active: true,
        has_password: true,
        inbox_unread: 0,
      },
    ];
  }, [accounts, trimmedEmail, accountName]);

  const displayAccounts = useMemo<AccountEntry[]>(() => {
    if (!dragOrder || dragOrder.length === 0) return baseAccounts;
    const byEmail = new Map(baseAccounts.map((a) => [a.email.toLowerCase(), a]));
    const ordered: AccountEntry[] = [];
    for (const em of dragOrder) {
      const hit = byEmail.get(em.toLowerCase());
      if (hit) {
        ordered.push(hit);
        byEmail.delete(em.toLowerCase());
      }
    }
    for (const rest of byEmail.values()) ordered.push(rest);
    return ordered;
  }, [baseAccounts, dragOrder]);

  // 根据窗口宽度计算顶栏最多平铺几个邮箱（严格控制在顶栏总宽度的 46%~48% 以内，绝不超过一半）
  const recomputeStripLayout = useCallback(() => {
    if (displayAccounts.length === 0) {
      setVisibleEmails(null);
      return;
    }
    const headerEl = headerRef.current;
    const measureEl = measureRowRef.current;
    if (!headerEl || !measureEl) {
      setVisibleEmails(displayAccounts.map((a) => a.email));
      return;
    }

    const headerW = headerEl.clientWidth || window.innerWidth || 1100;
    const brandW = brandClusterRef.current?.offsetWidth ?? 94;

    // 整个左侧区域（MailChat + 分隔符 + 邮箱平铺栏）不超过窗口 48% 且上限 780px，同时右侧至少留出 260px 拖拽与控制按钮空间
    const maxLeftTotal = Math.min(Math.floor(headerW * 0.48), 780, headerW - 260);
    const stripBudget = Math.max(176, maxLeftTotal - brandW - 10);

    const pillNodes = Array.from(
      measureEl.querySelectorAll<HTMLElement>("[data-measure-pill]"),
    );
    const widths = displayAccounts.map((_, idx) => {
      const w = pillNodes[idx]?.offsetWidth ?? 150;
      return Math.min(w, 230);
    });

    const plainBtnW =
      measureEl.querySelector<HTMLElement>('[data-measure-more="plain"]')?.offsetWidth ?? 24;
    const overflowBtnW =
      measureEl.querySelector<HTMLElement>('[data-measure-more="overflow"]')?.offsetWidth ?? 58;

    setSingleMaxPx(Math.max(132, Math.min(230, stripBudget - overflowBtnW - STRIP_GAP_PX)));

    const totalIfAllVisible =
      widths.reduce((acc, w) => acc + w, 0) +
      displayAccounts.length * STRIP_GAP_PX +
      plainBtnW;

    if (displayAccounts.length === 1 || totalIfAllVisible <= stripBudget) {
      setVisibleEmails(displayAccounts.map((a) => a.email));
      return;
    }

    // 空间不足以全部平铺时：按用户排定的前后顺序优先保留前面的邮箱，后面的自动折叠进 +N 下拉菜单
    const availForPills = stripBudget - overflowBtnW;
    const chosenIndices: number[] = [];
    let used = 0;

    for (let i = 0; i < displayAccounts.length; i++) {
      const need = widths[i] + STRIP_GAP_PX;
      if (i === 0 || used + need <= availForPills) {
        chosenIndices.push(i);
        used += need;
      } else {
        break;
      }
    }

    // 若当前激活的邮箱排在折叠区（非拖拽态），替换最后一个可见槽位，保证当前正在查看的邮箱始终在顶栏可见
    const activeIdx = displayAccounts.findIndex((a) => a.active);
    if (!dragEmail && activeIdx >= 0 && !chosenIndices.includes(activeIdx)) {
      if (chosenIndices.length <= 1) {
        chosenIndices[0] = activeIdx;
      } else {
        while (chosenIndices.length > 1) {
          const removedIdx = chosenIndices.pop()!;
          used -= widths[removedIdx] + STRIP_GAP_PX;
          if (used + widths[activeIdx] + STRIP_GAP_PX <= availForPills || chosenIndices.length === 0) {
            break;
          }
        }
        chosenIndices.push(activeIdx);
      }
    }

    setVisibleEmails(chosenIndices.map((idx) => displayAccounts[idx].email));
  }, [displayAccounts, dragEmail]);

  useLayoutEffect(() => {
    recomputeStripLayout();
  }, [recomputeStripLayout, syncing, switchingAccount]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeStripLayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeStripLayout]);

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

  const visibleSet = useMemo(() => {
    if (!visibleEmails) return new Set(displayAccounts.map((a) => a.email.toLowerCase()));
    return new Set(visibleEmails.map((e) => e.toLowerCase()));
  }, [visibleEmails, displayAccounts]);

  const visibleAccounts = useMemo(
    () => displayAccounts.filter((a) => visibleSet.has(a.email.toLowerCase())),
    [displayAccounts, visibleSet],
  );

  const overflowAccounts = useMemo(
    () => displayAccounts.filter((a) => !visibleSet.has(a.email.toLowerCase())),
    [displayAccounts, visibleSet],
  );

  const overflowUnread = useMemo(
    () => overflowAccounts.reduce((sum, a) => sum + (a.inbox_unread || 0), 0),
    [overflowAccounts],
  );

  // 顶栏胶囊指针按住左右拖拽排序（5px 防抖阈值，不影响正常单击秒切）
  const handlePillPointerDown = (email: string, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || baseAccounts.length <= 1 || switchingAccount) return;
    const startX = e.clientX;
    let moved = false;
    let workingOrder = baseAccounts.map((a) => a.email);

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) >= 5) {
        moved = true;
        setMenuOpen(false);
        setDragEmail(email);
        setDragOrder(workingOrder);
      }
      if (!moved) return;

      const rowEl = pillsRowRef.current;
      if (!rowEl) return;
      const nodes = Array.from(rowEl.querySelectorAll<HTMLElement>("[data-pill-email]"));
      for (const node of nodes) {
        const targetEmail = node.dataset.pillEmail;
        if (!targetEmail || targetEmail.toLowerCase() === email.toLowerCase()) continue;
        const rect = node.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const fromIdx = workingOrder.findIndex((x) => x.toLowerCase() === email.toLowerCase());
        const toIdx = workingOrder.findIndex((x) => x.toLowerCase() === targetEmail.toLowerCase());
        if (fromIdx < 0 || toIdx < 0) continue;

        if (
          (fromIdx < toIdx && ev.clientX > midX) ||
          (fromIdx > toIdx && ev.clientX < midX)
        ) {
          const next = [...workingOrder];
          const [picked] = next.splice(fromIdx, 1);
          next.splice(toIdx, 0, picked);
          workingOrder = next;
          setDragOrder(next);
          break;
        }
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) return;

      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 60);

      setDragEmail(null);
      setDragOrder(null);

      const origKey = baseAccounts.map((a) => a.email.toLowerCase()).join("|");
      const nextKey = workingOrder.map((x) => x.toLowerCase()).join("|");
      if (origKey !== nextKey) {
        onReorderAccounts?.(workingOrder);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // 下拉菜单内点击上移 / 下移调整前后顺序
  const moveAccountStep = (index: number, delta: -1 | 1, e: MouseEvent) => {
    e.stopPropagation();
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= displayAccounts.length) return;
    const next = displayAccounts.map((a) => a.email);
    const [picked] = next.splice(index, 1);
    next.splice(targetIdx, 0, picked);
    onReorderAccounts?.(next);
  };

  const emptyLabel = hasDemo ? "演示信箱 · 点击绑定邮箱" : "未绑定邮箱 · 点击配置";
  const emptyDotKind = hasDemo ? "demo" : "idle";

  return (
    <header
      ref={headerRef}
      className="window-titlebar"
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <div className="win-titlebar-left">
        <div className="win-brand-cluster" ref={brandClusterRef}>
          <span className="win-brand-title">MailChat</span>
          <span className="win-titlebar-sep" aria-hidden="true" />
        </div>

        <div className="win-account-switcher-wrap no-drag" ref={switcherRef}>
          {displayAccounts.length === 0 ? (
            <button
              type="button"
              className="win-account-pill is-empty no-drag"
              onClick={() => {
                if (onAddAccount) onAddAccount();
                else onClickAccount?.();
              }}
              title={
                hasDemo
                  ? "当前展示本地演示会话，点击绑定真实 IMAP / SMTP 邮箱"
                  : "尚未绑定邮箱账号，点击前往配置"
              }
            >
              <span className={`win-status-dot ${emptyDotKind}`} aria-hidden="true" />
              <span className="win-account-text">{emptyLabel}</span>
            </button>
          ) : (
            <div className="win-account-strip" ref={pillsRowRef}>
              {visibleAccounts.map((acc) => {
                const isDraggingThis =
                  Boolean(dragEmail) && dragEmail!.toLowerCase() === acc.email.toLowerCase();
                const dotKind = getDotStatus(acc, syncing, switchingAccount);
                const text = getPillText(acc, syncing, switchingAccount);
                const nickPart = acc.display_name?.trim() ? `${acc.display_name.trim()} · ` : "";
                const dragHint =
                  displayAccounts.length > 1 ? " · 按住左右拖动可调整前后顺序" : "";
                const pillTitle = acc.active
                  ? `当前使用：${nickPart}${acc.email}（点击展开账号菜单${dragHint}）`
                  : `点击切换至：${nickPart}${acc.email}${dragHint}`;

                return (
                  <button
                    key={acc.email}
                    type="button"
                    data-pill-email={acc.email}
                    style={{ maxWidth: `${singleMaxPx}px` }}
                    className={`win-account-pill no-drag ${acc.active ? "is-active" : "is-inactive"} ${isDraggingThis ? "is-dragging" : ""} ${acc.active && menuOpen ? "open" : ""}`}
                    disabled={switchingAccount}
                    onPointerDown={(e) => handlePillPointerDown(acc.email, e)}
                    onClick={() => {
                      if (suppressClickRef.current) return;
                      if (acc.active) {
                        setMenuOpen((v) => !v);
                      } else {
                        setMenuOpen(false);
                        onSwitchAccount?.(acc.email);
                      }
                    }}
                    title={pillTitle}
                  >
                    <span className={`win-status-dot ${dotKind}`} aria-hidden="true" />
                    <span className="win-account-text">{text}</span>
                    {acc.inbox_unread > 0 && (
                      <span
                        className={`win-pill-unread ${acc.active ? "active" : ""}`}
                        title={`该邮箱有 ${acc.inbox_unread} 封未读邮件`}
                      >
                        {acc.inbox_unread > 99 ? "99+" : acc.inbox_unread}
                      </span>
                    )}
                  </button>
                );
              })}

              <button
                type="button"
                className={`win-account-more-btn no-drag ${overflowAccounts.length > 0 ? "has-overflow" : ""} ${menuOpen ? "open" : ""}`}
                onClick={() => setMenuOpen((v) => !v)}
                title={
                  overflowAccounts.length > 0
                    ? `还有 ${overflowAccounts.length} 个邮箱因空间不足已收起，点击切换或调整排序`
                    : "展开多邮箱排序、接入新账号或连接管理"
                }
              >
                {overflowAccounts.length > 0 && (
                  <span className="win-more-count">+{overflowAccounts.length}</span>
                )}
                {overflowUnread > 0 && (
                  <span
                    className="win-more-unread-dot"
                    title={`收起的邮箱中有 ${overflowUnread} 封未读邮件`}
                  />
                )}
                <IconChevron
                  size={11}
                  className={`win-account-caret ${menuOpen ? "open" : ""}`}
                />
              </button>
            </div>
          )}

          {/* 隐藏离屏宽度测量行：保证窗口缩放时平铺/收起临界点精确到像素且不闪烁 */}
          {displayAccounts.length > 0 && (
            <div className="win-account-measure-row" ref={measureRowRef} aria-hidden="true">
              {displayAccounts.map((acc) => (
                <span key={acc.email} data-measure-pill={acc.email} className="win-account-pill">
                  <span className="win-status-dot online" />
                  <span className="win-account-text">
                    {getPillText(acc, syncing, switchingAccount)}
                  </span>
                  {acc.inbox_unread > 0 && (
                    <span className="win-pill-unread">
                      {acc.inbox_unread > 99 ? "99+" : acc.inbox_unread}
                    </span>
                  )}
                </span>
              ))}
              <span data-measure-more="plain" className="win-account-more-btn">
                <IconChevron size={11} />
              </span>
              <span data-measure-more="overflow" className="win-account-more-btn has-overflow">
                <span className="win-more-count">+{displayAccounts.length}</span>
                <span className="win-more-unread-dot" />
                <IconChevron size={11} />
              </span>
            </div>
          )}

          {menuOpen && (
            <div className="win-account-popover" role="menu" aria-label="多邮箱账号切换与排序">
              <div className="win-account-pop-head">
                <span>已接入邮箱 ({displayAccounts.length})</span>
                <span className="win-account-pop-hint">
                  {displayAccounts.length > 1
                    ? "排在前面的优先平铺 · 支持拖拽"
                    : "数据与凭据独立隔离"}
                </span>
              </div>

              <div className="win-account-pop-list">
                {displayAccounts.map((acc, idx) => {
                  const labelName = acc.display_name?.trim() || acc.email.split("@")[0];
                  const isFolded = !visibleSet.has(acc.email.toLowerCase());
                  return (
                    <div
                      key={acc.email}
                      role="menuitem"
                      tabIndex={0}
                      className={`win-account-option ${acc.active ? "active" : ""}`}
                      onClick={() => {
                        if (switchingAccount) return;
                        setMenuOpen(false);
                        if (!acc.active) {
                          onSwitchAccount?.(acc.email);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (switchingAccount) return;
                          setMenuOpen(false);
                          if (!acc.active) onSwitchAccount?.(acc.email);
                        }
                      }}
                    >
                      <span className="win-account-rank" title={`展示优先级 #${idx + 1}`}>
                        {idx + 1}
                      </span>

                      <span className={`win-account-avatar ${acc.active ? "active" : ""}`}>
                        {avatarChar(acc.display_name, acc.email)}
                      </span>

                      <span className="win-account-opt-main">
                        <span className="win-account-opt-top">
                          <span className="win-account-opt-name">{labelName}</span>
                          {isFolded && <span className="win-account-opt-folded">已收起</span>}
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
                        {displayAccounts.length > 1 && (
                          <span className="win-account-order-btns">
                            <button
                              type="button"
                              className="win-order-icon-btn"
                              disabled={idx === 0}
                              onClick={(e) => moveAccountStep(idx, -1, e)}
                              title="往前移（更优先在顶栏平铺显示）"
                            >
                              <IconArrowUp size={12} />
                            </button>
                            <button
                              type="button"
                              className="win-order-icon-btn"
                              disabled={idx === displayAccounts.length - 1}
                              onClick={(e) => moveAccountStep(idx, 1, e)}
                              title="往后移（空间不足时优先收起）"
                            >
                              <IconArrowDown size={12} />
                            </button>
                          </span>
                        )}
                      </span>
                    </div>
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
