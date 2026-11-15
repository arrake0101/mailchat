import { useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { api, PRESETS } from "../api";
import type { Account, AccountEntry, Conversation, MailboxStats, Status } from "../types";
import { Avatar, copyText, GroupAvatar, shortTime } from "../util";
import { useContextMenu } from "./ContextMenu";
import { buildConversationMenuEntries } from "./ConversationList";
import {
  BrandAppIcon,
  IconAgentDock,
  IconBell,
  IconChat,
  IconCheck,
  IconCode,
  IconCompose,
  IconKey,
  IconLock,
  IconMailRead,
  IconMute,
  IconOtp,
  IconPin,
  IconPlus,
  IconRefresh,
  IconReplyHub,
  IconShield,
  IconSliders,
  IconSparkles,
  IconTrash,
  IconTriage,
  IconUsers,
} from "./Icons";
import type { SettingsTab } from "./Settings";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

const QUICK_PROVIDER_DOMAINS = [
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "gmail.com",
  "outlook.com",
  "icloud.com",
  "aliyun.com",
] as const;

function getTimeGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function extractPreviewOtp(preview: string): string | null {
  const m = preview.match(/验证码\s*([A-Za-z0-9-]{4,10})/);
  return m ? m[1] : null;
}

export interface FirstScreenWorkspaceProps {
  hydrated: boolean;
  status: Status;
  account: Account | null;
  accounts: AccountEntry[];
  stats: MailboxStats;
  conversations: Conversation[];
  syncing: boolean;
  triaging: boolean;
  onSwitchStatus: (status: Status) => void;
  onSelectConversation: (peer: string) => void;
  onOpenConversationDrawer: (peer: string) => void;
  onOpenComposePanel: (mode: "direct" | "group") => void;
  onOpenComposeStudio?: () => void;
  onOpenReplyHub?: () => void;
  agentDockOpen?: boolean;
  onToggleAgentDock?: () => void;
  onConnectAccount: (presetDomain?: string) => void;
  onManageAccounts: () => void;
  onOpenAssistant: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onSyncNow: () => void;
  onRunTriage: () => void;
  onLoadDemo: () => void;
  onDataChanged: () => Promise<void> | void;
  notify: (text: string, isError?: boolean) => void;
}

export function FirstScreenWorkspace({
  hydrated,
  status,
  account,
  accounts,
  stats,
  conversations,
  syncing,
  triaging,
  onSwitchStatus,
  onSelectConversation,
  onOpenConversationDrawer,
  onOpenComposePanel,
  onOpenComposeStudio,
  onOpenReplyHub,
  agentDockOpen = false,
  onToggleAgentDock,
  onConnectAccount,
  onManageAccounts,
  onOpenAssistant,
  onOpenSettings,
  onSyncNow,
  onRunTriage,
  onLoadDemo,
  onDataChanged,
  notify,
}: FirstScreenWorkspaceProps) {
  const { openContextMenu } = useContextMenu();

  const activeEntry = useMemo(
    () =>
      accounts.find(
        (item) =>
          item.active ||
          (account?.email && item.email.toLowerCase() === account.email.toLowerCase()),
      ),
    [accounts, account?.email],
  );

  const isUnbound = !account && accounts.length === 0 && !stats.has_demo;
  const missingPassword = Boolean(activeEntry && !activeEntry.has_password);

  const focusConversations = useMemo(() => {
    const unreadItems = conversations.filter((c) => c.unread > 0);
    if (unreadItems.length >= 5) return unreadItems.slice(0, 5);
    const seen = new Set(unreadItems.map((c) => c.peer));
    const rest = conversations.filter((c) => !seen.has(c.peer));
    return [...unreadItems, ...rest].slice(0, 5);
  }, [conversations]);

  const unreadInCurrentStatus = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unread > 0 ? 1 : 0), 0),
    [conversations],
  );

  const handleCanvasContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    if (target?.closest(".fs-conv-item, button, a, input, textarea")) return;
    openContextMenu(e, [
      { kind: "header", label: "MailChat 工作台" },
      account
        ? {
            label: syncing ? "正在同步收信…" : "立即同步收信",
            icon: <IconRefresh size={14} />,
            accent: true,
            disabled: syncing,
            onSelect: onSyncNow,
          }
        : {
            label: "立即绑定邮箱账号…",
            icon: <IconPlus size={14} />,
            accent: true,
            onSelect: () => onConnectAccount(),
          },
      !isUnbound
        ? {
            label: "发起新单聊",
            icon: <IconPlus size={14} />,
            onSelect: () => onOpenComposePanel("direct"),
          }
        : null,
      !isUnbound
        ? {
            label: "发起多人邮件群聊",
            icon: <IconUsers size={14} />,
            onSelect: () => onOpenComposePanel("group"),
          }
        : null,
      onOpenComposeStudio
        ? {
            label: "打开写信工坊（传统写信 + HTML Agent）",
            icon: <IconCompose size={14} />,
            onSelect: onOpenComposeStudio,
          }
        : null,
      onOpenReplyHub
        ? {
            label: "打开跨邮箱隐私统一批复",
            icon: <IconReplyHub size={14} />,
            onSelect: onOpenReplyHub,
          }
        : null,
      onToggleAgentDock
        ? {
            label: agentDockOpen
              ? "收起右侧邮件 AI 面板 (Ctrl+J)"
              : "向右展开邮件 AI 面板 (Ctrl+J)",
            icon: <IconAgentDock size={14} open={!agentDockOpen} />,
            onSelect: onToggleAgentDock,
          }
        : null,
      { kind: "divider" },
      {
        label: "打开 AI 配置助手",
        icon: <IconSparkles size={14} />,
        onSelect: onOpenAssistant,
      },
      {
        label: "打开声明式配置与保险箱",
        icon: <IconSliders size={14} />,
        onSelect: () => onOpenSettings("declarative"),
      },
    ]);
  };

  if (!hydrated) {
    return (
      <section
        className="chat-workspace fs-workspace"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <div className="fs-container">
          <div className="fs-skeleton-hero" />
          <div className="fs-skeleton-grid">
            <div className="fs-skeleton-card" />
            <div className="fs-skeleton-card" />
            <div className="fs-skeleton-card" />
          </div>
          <div className="fs-skeleton-list" />
        </div>
      </section>
    );
  }

  if (isUnbound) {
    return (
      <section
        className="chat-workspace fs-workspace"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
        onContextMenu={handleCanvasContextMenu}
      >
        <div className="fs-container fs-onboarding">
          <div className="fs-hero-card">
            <div className="fs-hero-top">
              <div className="fs-brand-badge">
                <BrandAppIcon size={48} />
              </div>
              <div className="fs-hero-copy">
                <div className="fs-eyebrow">MAILCHAT DESKTOP · 即时邮件工作台</div>
                <h1 className="fs-hero-title">像聊天一样收发与管理邮件</h1>
                <p className="fs-hero-desc">
                  兼容任意标准 IMAP / SMTP 单聊与多人跨服群聊。非敏感配置统一收口于{" "}
                  <code>config.toml</code>，邮箱授权码与模型密钥由 Windows DPAPI 本机独立加密隔离。
                </p>
              </div>
            </div>

            <div className="fs-cta-row">
              <button
                type="button"
                className="primary-btn large"
                onClick={() => onConnectAccount()}
              >
                <IconPlus size={15} />
                <span>立即绑定邮箱账号</span>
              </button>
              <button
                type="button"
                className="soft-btn large fs-accent-soft"
                onClick={onOpenAssistant}
              >
                <IconSparkles size={15} />
                <span>AI 助手一句话配置</span>
              </button>
              <button type="button" className="soft-btn large" onClick={onLoadDemo}>
                <IconUsers size={15} />
                <span>载入演示会话与群聊</span>
              </button>
            </div>

            <div className="fs-provider-block">
              <div className="fs-block-head">
                <span className="fs-block-title">主流邮箱一键预填服务器参数</span>
                <span className="fs-block-sub">点击下方服务商将自动带出 IMAP / SMTP 端口配置</span>
              </div>
              <div className="fs-provider-grid">
                {QUICK_PROVIDER_DOMAINS.map((domain) => {
                  const p = PRESETS[domain];
                  if (!p) return null;
                  return (
                    <button
                      key={domain}
                      type="button"
                      className="fs-provider-chip"
                      onClick={() => onConnectAccount(domain)}
                      title={`使用 ${p.label} 预设 (${p.imap_host}:${p.imap_port}) 绑定账号`}
                    >
                      <span className="fs-provider-name">{p.label}</span>
                      <span className="fs-provider-domain">@{domain}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="fs-cap-grid">
            <div className="fs-cap-card">
              <div className="fs-cap-icon">
                <IconChat size={17} />
              </div>
              <div className="fs-cap-title">即时气泡单聊与全员群聊</div>
              <div className="fs-cap-desc">
                自动剥离冗长历史引用与签名噪音，支持多收件人标准邮件群聊、图片附件与引用回复。
              </div>
            </div>

            <div className="fs-cap-card">
              <div className="fs-cap-icon">
                <IconTriage size={17} />
              </div>
              <div className="fs-cap-title">消息 · 通知 · 拦截三槽分流</div>
              <div className="fs-cap-desc">
                确定性规则结合多模型分拣，真人沟通留主槽，验证码与账单自动提炼折叠，推广静默隔离。
              </div>
            </div>

            <div className="fs-cap-card">
              <div className="fs-cap-icon">
                <IconLock size={17} />
              </div>
              <div className="fs-cap-title">声明式配置与本机保险箱</div>
              <div className="fs-cap-desc">
                支持直接审阅编辑声明式清单，所有口令均以 <code>secret:*</code> 引用隔离保存。
              </div>
              <div className="fs-cap-links">
                <button
                  type="button"
                  className="text-link"
                  onClick={() => onOpenSettings("declarative")}
                >
                  查看 config.toml
                </button>
                <span className="fs-dot-sep">·</span>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => onOpenSettings("vault")}
                >
                  隐私保险箱
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const displayUser =
    account?.display_name?.trim() ||
    account?.email?.split("@")[0] ||
    (stats.has_demo ? "体验访客" : "MailChat");

  const statusTitle =
    status === "inbox" ? "消息主槽" : status === "archived" ? "折叠通知" : "静默拦截";

  const handleClearDemo = async () => {
    try {
      const n = await api.clearDemoData();
      await onDataChanged();
      notify(`已清理 ${n} 封本地演示数据`);
    } catch (err) {
      notify(`清理演示数据失败：${err}`, true);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllRead(status);
      await onDataChanged();
      notify(`已将当前「${statusTitle}」全部标为已读`);
    } catch (err) {
      notify(`操作失败：${err}`, true);
    }
  };

  return (
    <section
      className="chat-workspace fs-workspace"
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleWindowMaximize}
      onContextMenu={handleCanvasContextMenu}
    >
      <div className="fs-container fs-overview">
        {/* 顶栏状态与问候条 */}
        <header className="fs-overview-head">
          <div className="fs-overview-greeting">
            <div className="fs-overview-title-row">
              <h1 className="fs-overview-title">
                {getTimeGreeting()}，{displayUser}
              </h1>
              {account ? (
                <span className={`fs-status-pill ${missingPassword ? "warn" : "online"}`}>
                  <span className="fs-status-dot" />
                  <span>
                    {missingPassword
                      ? `${account.email} · 待录入授权码`
                      : syncing
                        ? `${account.email} · 正在同步`
                        : `${account.email} · 实时收信就绪`}
                  </span>
                </span>
              ) : (
                <span className="fs-status-pill demo">
                  <span className="fs-status-dot" />
                  <span>本地演示信箱模式</span>
                </span>
              )}
            </div>
            <div className="fs-overview-sub">
              {stats.inbox_unread > 0
                ? `当前有 ${stats.inbox_unread} 封重要未读来信待查看，点击下方会话即可直接回复`
                : stats.archived_unread > 0
                  ? `主消息槽已全部处理完毕，另有 ${stats.archived_unread} 条折叠通知可按需查阅`
                  : "所有重要消息均已处理完毕，信箱保持清爽零积压"}
            </div>
          </div>

          <div className="fs-overview-actions">
            {onOpenComposeStudio && (
              <button
                type="button"
                className="soft-btn"
                onClick={onOpenComposeStudio}
                title="传统邮件写信与 Agent HTML 排版工坊"
              >
                <IconCompose size={14} />
                <span>写信工坊</span>
              </button>
            )}
            <button
              type="button"
              className="soft-btn"
              onClick={() => onOpenComposePanel("direct")}
            >
              <IconPlus size={14} />
              <span>发起单聊</span>
            </button>
            <button
              type="button"
              className="soft-btn"
              onClick={() => onOpenComposePanel("group")}
            >
              <IconUsers size={14} />
              <span>新建群聊</span>
            </button>
            {onToggleAgentDock && (
              <button
                type="button"
                className={`soft-btn ${agentDockOpen ? "active-soft" : ""}`}
                onClick={onToggleAgentDock}
                title={
                  agentDockOpen
                    ? "收起右侧邮件 AI 面板 (Ctrl+J)"
                    : "向右展开邮件 AI 面板 (Ctrl+J)"
                }
              >
                <IconAgentDock size={14} open={agentDockOpen} />
                <span>{agentDockOpen ? "收起邮件 AI" : "邮件 AI"}</span>
              </button>
            )}
            {account ? (
              <button
                type="button"
                className="primary-btn"
                onClick={onSyncNow}
                disabled={syncing}
              >
                <span className={syncing ? "spin" : ""}>
                  <IconRefresh size={14} />
                </span>
                <span>{syncing ? "同步中…" : "立即同步"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="primary-btn"
                onClick={() => onConnectAccount()}
              >
                <IconPlus size={14} />
                <span>绑定真实邮箱</span>
              </button>
            )}
          </div>
        </header>

        {/* 缺少授权码或演示模式的醒目操作横幅 */}
        {missingPassword && account && (
          <div className="fs-alert-banner warn">
            <div className="fs-alert-main">
              <IconKey size={16} />
              <span>
                当前邮箱 <b>{account.email}</b> 尚未录入密码或客户端专用授权码，补全后即可启用 IMAP 实时收发。
              </span>
            </div>
            <div className="fs-alert-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={() => onOpenSettings("vault")}
              >
                前往保险箱录入
              </button>
              <button type="button" className="soft-btn" onClick={onManageAccounts}>
                检查服务器参数
              </button>
            </div>
          </div>
        )}

        {!account && stats.has_demo && (
          <div className="fs-alert-banner info">
            <div className="fs-alert-main">
              <IconSparkles size={16} />
              <span>
                您正在浏览内置演示会话与跨服 4 人群聊。随时可接入真实邮箱，或一键清除演示数据。
              </span>
            </div>
            <div className="fs-alert-actions">
              <button
                type="button"
                className="soft-btn"
                onClick={() => onConnectAccount()}
              >
                接入真实邮箱
              </button>
              <button type="button" className="ghost-btn danger-text" onClick={handleClearDemo}>
                <IconTrash size={13} />
                <span>清除演示数据</span>
              </button>
            </div>
          </div>
        )}

        {/* 三路收信分流脉搏卡 */}
        <div className="fs-pulse-grid">
          <button
            type="button"
            className={`fs-pulse-card ${status === "inbox" ? "active" : ""}`}
            onClick={() => onSwitchStatus("inbox")}
          >
            <div className="fs-pulse-top">
              <span className="fs-pulse-icon inbox">
                <IconChat size={16} />
              </span>
              <span className="fs-pulse-label">消息主槽</span>
              {status === "inbox" && <span className="fs-pulse-current">当前视图</span>}
            </div>
            <div className="fs-pulse-metric">
              <span className="fs-pulse-value">{stats.inbox_unread}</span>
              <span className="fs-pulse-unit">未读来信</span>
            </div>
            <div className="fs-pulse-foot">真人单聊、工作往来与 @提及你的群聊</div>
          </button>

          <button
            type="button"
            className={`fs-pulse-card ${status === "archived" ? "active" : ""}`}
            onClick={() => onSwitchStatus("archived")}
          >
            <div className="fs-pulse-top">
              <span className="fs-pulse-icon archived">
                <IconBell size={16} />
              </span>
              <span className="fs-pulse-label">通知折叠</span>
              {status === "archived" && <span className="fs-pulse-current">当前视图</span>}
            </div>
            <div className="fs-pulse-metric">
              <span className="fs-pulse-value">{stats.archived_unread}</span>
              <span className="fs-pulse-unit">未读通知</span>
            </div>
            <div className="fs-pulse-foot">验证码、电子账单、订阅周刊与免打扰群</div>
          </button>

          <button
            type="button"
            className={`fs-pulse-card ${status === "blocked" ? "active" : ""}`}
            onClick={() => onSwitchStatus("blocked")}
          >
            <div className="fs-pulse-top">
              <span className="fs-pulse-icon blocked">
                <IconShield size={16} />
              </span>
              <span className="fs-pulse-label">静默拦截</span>
              {status === "blocked" && <span className="fs-pulse-current">当前视图</span>}
            </div>
            <div className="fs-pulse-metric">
              <span className="fs-pulse-value">{stats.blocked_count}</span>
              <span className="fs-pulse-unit">已隔离</span>
            </div>
            <div className="fs-pulse-foot">
              {stats.pending_count > 0
                ? `${stats.pending_count} 封来信正在等待后台分拣`
                : "广告推广与可疑发件人静默隔离"}
            </div>
          </button>
        </div>

        {/* 待处理 / 最近活跃会话直达面板 */}
        <div className="fs-section-card">
          <div className="fs-section-head">
            <div className="fs-section-title-wrap">
              <span className="fs-section-title">
                {unreadInCurrentStatus > 0
                  ? `${statusTitle} · 优先待读 (${unreadInCurrentStatus})`
                  : `${statusTitle} · 最近会话`}
              </span>
              <span className="fs-section-hint">左键进入对话 · 右键呼出快捷菜单</span>
            </div>

            <div className="fs-section-actions">
              {unreadInCurrentStatus > 0 && (
                <button type="button" className="soft-btn" onClick={handleMarkAllRead}>
                  <IconMailRead size={13} />
                  <span>全部标为已读</span>
                </button>
              )}
              <button
                type="button"
                className="soft-btn"
                onClick={onRunTriage}
                disabled={triaging}
              >
                <span className={triaging ? "spin" : ""}>
                  <IconTriage size={13} />
                </span>
                <span>{triaging ? "分拣中…" : "AI 重分拣"}</span>
              </button>
            </div>
          </div>

          {focusConversations.length === 0 ? (
            <div className="fs-empty-box">
              <IconCheck size={20} />
              <div className="fs-empty-title">当前「{statusTitle}」暂无会话</div>
              <div className="fs-empty-sub">
                {status === "inbox"
                  ? "可点击上方「发起单聊」主动发信，或同步拉取最新邮件"
                  : status === "archived"
                    ? "自动折叠的系统通知、账单与验证码到达后会安静归入此处"
                    : "被规则或模型识别出的营销推广邮件会安全隔离在此处"}
              </div>
            </div>
          ) : (
            <div className="fs-conv-list">
              {focusConversations.map((c) => {
                const cleanName = c.name.replace(/^🚀\s*/, "");
                const otp = extractPreviewOtp(c.preview);
                return (
                  <div
                    key={c.peer}
                    className={`fs-conv-item ${c.unread > 0 ? "is-unread" : ""}`}
                    onClick={() => onSelectConversation(c.peer)}
                    onContextMenu={(e) =>
                      openContextMenu(
                        e,
                        buildConversationMenuEntries({
                          conv: c,
                          status,
                          isSelected: false,
                          onSelect: onSelectConversation,
                          onDeselect: () => {},
                          onOpenDrawer: onOpenConversationDrawer,
                          onChanged: onDataChanged,
                          notify,
                        }),
                      )
                    }
                  >
                    {c.is_group ? (
                      <GroupAvatar members={c.members} seed={c.peer} size={38} />
                    ) : (
                      <Avatar name={cleanName} seed={c.peer} size={38} />
                    )}

                    <div className="fs-conv-body">
                      <div className="fs-conv-top">
                        <span className="fs-conv-name">
                          {c.pinned && (
                            <span className="conv-pin-badge" title="已置顶">
                              <IconPin size={11} />
                            </span>
                          )}
                          {cleanName}
                          {c.is_group && (
                            <span className="group-count">({c.members.length + 1})</span>
                          )}
                        </span>
                        {c.muted && (
                          <span className="mute-icon" title="免打扰">
                            <IconMute size={12} />
                          </span>
                        )}
                        {c.category && <span className="mini-tag">{c.category}</span>}
                      </div>

                      <div className="fs-conv-preview">
                        {otp ? (
                          <>
                            <button
                              type="button"
                              className="conv-otp-pill"
                              onClick={(e) => {
                                e.stopPropagation();
                                void copyText(otp).then(() =>
                                  notify(`已复制验证码：${otp}`),
                                );
                              }}
                              title="点击复制验证码"
                            >
                              <IconOtp size={11} />
                              <span>{otp}</span>
                            </button>
                            <span>
                              {c.preview.replace(/^🔑\s*验证码\s*[A-Za-z0-9-]+\s*·?\s*/, "")}
                            </span>
                          </>
                        ) : (
                          <span>{c.preview.replace(/^🔑\s*/, "") || c.peer}</span>
                        )}
                      </div>
                    </div>

                    <div className="fs-conv-right">
                      <span className="fs-conv-time">{shortTime(c.last_date)}</span>
                      {c.unread > 0 && (
                        <span className={`badge ${c.muted ? "badge-muted" : ""}`}>
                          {c.unread > 99 ? "99+" : c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部快捷能力入口与桌面操作提示 */}
        <div className="fs-quick-grid">
          {onOpenComposeStudio && (
            <button
              type="button"
              className="fs-quick-tile"
              onClick={onOpenComposeStudio}
            >
              <IconCompose size={16} />
              <div className="fs-quick-text">
                <span className="fs-quick-title">传统写信 + Agent HTML 工坊</span>
                <span className="fs-quick-sub">多邮箱切换、抄送密送与内联 HTML 实时双栏预览</span>
              </div>
            </button>
          )}

          {onOpenReplyHub && (
            <button
              type="button"
              className="fs-quick-tile"
              onClick={onOpenReplyHub}
            >
              <IconReplyHub size={16} />
              <div className="fs-quick-text">
                <span className="fs-quick-title">
                  跨邮箱隐私统一批复
                  {(stats.reply_pending_count ?? 0) > 0
                    ? ` · ${stats.reply_pending_count} 封待审`
                    : ""}
                </span>
                <span className="fs-quick-sub">本地入模 PII 脱敏、范围隔离与分级权限放行</span>
              </div>
            </button>
          )}

          <button
            type="button"
            className="fs-quick-tile"
            onClick={onOpenAssistant}
          >
            <IconSparkles size={16} />
            <div className="fs-quick-text">
              <span className="fs-quick-title">AI 助手自然语言编排</span>
              <span className="fs-quick-sub">一句话调整过滤规则、模型与群组配置</span>
            </div>
          </button>

          <button
            type="button"
            className="fs-quick-tile"
            onClick={() => onOpenSettings("declarative")}
          >
            <IconCode size={16} />
            <div className="fs-quick-text">
              <span className="fs-quick-title">config.toml 声明式清单</span>
              <span className="fs-quick-sub">审阅、备份与即时校验全局状态</span>
            </div>
          </button>

          <button
            type="button"
            className="fs-quick-tile"
            onClick={() => onConnectAccount()}
          >
            <IconSliders size={16} />
            <div className="fs-quick-text">
              <span className="fs-quick-title">接入更多邮箱账号</span>
              <span className="fs-quick-sub">多邮箱顶栏秒切，数据与授权码独立隔离</span>
            </div>
          </button>
        </div>
      </div>
    </section>
  );
}
