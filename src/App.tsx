import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { Account, Conversation, GroupMember, MailboxStats, Message, Status, SyncReport } from "./types";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { ChatView } from "./components/ChatView";
import { ConversationList } from "./components/ConversationList";
import { IconBell, IconChat, IconMail, IconShield, IconSliders, IconSparkles } from "./components/Icons";
import { Settings, type SettingsTab } from "./components/Settings";
import { startWindowDrag, toggleWindowMaximize, WindowControls } from "./components/WindowControls";

type View = Status | "assistant" | "settings";

const MAIL_VIEWS: { key: Status; label: string; empty: string }[] = [
  { key: "inbox", label: "消息", empty: "暂无消息" },
  { key: "archived", label: "通知", empty: "自动折叠的验证码、账单与免打扰群会安静留在这里" },
  { key: "blocked", label: "拦截", empty: "被规则或模型拦截的推广与可疑来信会隔离在这里" },
];

const EMPTY_STATS: MailboxStats = {
  inbox_unread: 0,
  archived_unread: 0,
  blocked_count: 0,
  pending_count: 0,
  has_demo: false,
};

export default function App() {
  const [view, setView] = useState<View>("inbox");
  const [account, setAccount] = useState<Account | null>(null);
  const [stats, setStats] = useState<MailboxStats>(EMPTY_STATS);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftConv, setDraftConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("declarative");
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const toastTimer = useRef<number>();

  const cur = useRef({ view, selected, draftConv });
  cur.current = { view, selected, draftConv };

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 5500 : 3000);
  }, []);

  const refresh = useCallback(async () => {
    const { view, selected, draftConv } = cur.current;
    const [acc, st] = await Promise.all([api.getAccount(), api.getStats()]);
    setAccount(acc);
    setStats(st);

    if (view === "settings" || view === "assistant") return;
    const list = await api.listConversations(view);
    setConvs(list);
    if (selected && list.some((c) => c.peer === selected)) {
      setDraftConv(null);
      setMessages(await api.listMessages(selected, view));
      setStats(await api.getStats());
    } else if (selected && draftConv && draftConv.peer === selected) {
      setMessages([]);
    } else if (selected) {
      setSelected(null);
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [view, refresh]);

  useEffect(() => {
    const un = listen<SyncReport>("mail-updated", (e) => {
      if (e.payload.error) notify(`同步提示：${e.payload.error}`, true);
      refresh();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh, notify]);

  const select = async (peer: string) => {
    if (view === "settings" || view === "assistant") return;
    setDraftConv(null);
    setSelected(peer);
    setMessages(await api.listMessages(peer, view));
    refresh();
  };

  const startNewChat = (email: string, name?: string) => {
    const peer = email.trim().toLowerCase();
    if (!peer.includes("@")) {
      notify("请输入格式正确的邮箱地址", true);
      return;
    }
    setView("inbox");
    const existing = convs.find((c) => c.peer === peer);
    if (existing) {
      select(peer);
      return;
    }
    const created: Conversation = {
      peer,
      name: name?.trim() || peer.split("@")[0],
      preview: "新会话",
      last_date: Math.floor(Date.now() / 1000),
      unread: 0,
      count: 0,
      category: "",
      is_group: false,
      members: [],
      muted: false,
    };
    setDraftConv(created);
    setSelected(peer);
    setMessages([]);
  };

  const createGroup = async (name: string, members: GroupMember[]) => {
    try {
      const grp = await api.createGroup(name, members);
      setView("inbox");
      setDraftConv(null);
      setSelected(grp.peer);
      setMessages([]);
      const list = await api.listConversations("inbox");
      setConvs(list);
      notify(`已创建群聊「${grp.name}」（共 ${grp.members.length + 1} 人）`);
    } catch (e) {
      notify(`创建群聊失败：${e}`, true);
      throw e;
    }
  };

  const syncNow = async () => {
    if (!account) {
      notify("尚未连接邮箱账号，可直接在助手中一句话绑定");
      setView("assistant");
      return;
    }
    setSyncing(true);
    try {
      const r = await api.syncNow();
      if (!r.error) {
        notify(r.new_incoming > 0 ? `收到 ${r.new_incoming} 封新邮件` : "已是最新状态");
      }
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSyncing(false);
    }
  };

  const runAgentTriage = async () => {
    setTriaging(true);
    try {
      const count = await api.reclassifyMessages(true);
      await refresh();
      notify(count > 0 ? `已完成 ${count} 封邮件的智能分拣` : "没有需要重新分拣的来信");
    } catch (e) {
      notify(`分拣提示：${e}`, true);
    } finally {
      setTriaging(false);
    }
  };

  const loadDemo = async () => {
    try {
      const n = await api.loadDemoData();
      await refresh();
      setView("inbox");
      notify(n > 0 ? `已载入 ${n} 封演示邮件与 4 人群聊` : "演示数据已就绪");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab);
    setView("settings");
  };

  const switchNav = (target: View) => {
    setView(target);
    setDraftConv(null);
    if (target === "assistant" || target === "settings") {
      setSelected(null);
      setMessages([]);
    }
  };

  const activeConv =
    convs.find((c) => c.peer === selected) ??
    (draftConv && draftConv.peer === selected ? draftConv : undefined);
  const mailMeta = MAIL_VIEWS.find((v) => v.key === view);

  return (
    <div className="app-shell">
      <WindowControls />

      <div
        className="app-body"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) startWindowDrag(e);
        }}
      >
        <nav className="rail" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
          <div className="rail-brand" title="MailChat（按住空白处可拖动窗口）">
            <IconMail size={19} />
          </div>

          <div className="rail-group">
            {MAIL_VIEWS.map((v) => {
              const badge =
                v.key === "inbox"
                  ? stats.inbox_unread
                  : v.key === "archived"
                    ? stats.archived_unread
                    : stats.blocked_count;
              const Icon = v.key === "inbox" ? IconChat : v.key === "archived" ? IconBell : IconShield;
              return (
                <button
                  key={v.key}
                  type="button"
                  className={`rail-btn ${view === v.key ? "active" : ""}`}
                  onClick={() => switchNav(v.key)}
                  title={v.label}
                >
                  <Icon size={19} />
                  <span className="rail-label">{v.label}</span>
                  {badge > 0 && (
                    <span className={`rail-badge ${v.key !== "inbox" ? "muted" : ""}`}>
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              className={`rail-btn agent-rail-btn ${view === "assistant" ? "active" : ""}`}
              onClick={() => switchNav("assistant")}
              title="AI 助手（声明式配置与自动化管家）"
            >
              <IconSparkles size={19} />
              <span className="rail-label">助手</span>
            </button>
          </div>

          <div className="rail-bottom">
            <button
              type="button"
              className={`rail-btn ${view === "settings" ? "active" : ""}`}
              onClick={() => switchNav("settings")}
              title="声明式配置与隐私凭据保险箱"
            >
              <IconSliders size={18} />
              <span className="rail-label">配置</span>
            </button>
          </div>
        </nav>

        {view === "assistant" ? (
          <AgentWorkspace
            notify={notify}
            onDataChanged={refresh}
            onOpenManualSettings={() => openSettings("declarative")}
          />
        ) : view === "settings" ? (
          <Settings
            initialTab={settingsTab}
            hasDemo={stats.has_demo}
            notify={notify}
            onAccountSaved={() => {
              setView("inbox");
              refresh();
            }}
            onDataChanged={refresh}
            onGoToAgent={() => setView("assistant")}
          />
        ) : (
          <>
            <ConversationList
              title={mailMeta?.label ?? "消息"}
              items={convs}
              selected={selected}
              onSelect={select}
              onNewChat={startNewChat}
              onCreateGroup={createGroup}
              onRefresh={syncNow}
              onRunTriage={runAgentTriage}
              syncing={syncing}
              triaging={triaging}
              emptyHint={mailMeta?.empty ?? ""}
            />

            {activeConv ? (
              <ChatView
                conv={activeConv}
                status={view}
                messages={messages}
                onSent={(m) => {
                  setDraftConv(null);
                  const target = activeConv.is_group && activeConv.muted ? "archived" : "inbox";
                  if (view !== target) setView(target);
                  setMessages((ms) => [...ms, m]);
                  refresh();
                }}
                onChanged={refresh}
                onGroupUpdated={(grp) => {
                  const target = grp.muted ? "archived" : "inbox";
                  if (view !== target) setView(target);
                  setSelected(grp.peer);
                  refresh();
                }}
                notify={notify}
              />
            ) : (
              <section
                className="chat-workspace placeholder"
                onMouseDown={startWindowDrag}
                onDoubleClick={toggleWindowMaximize}
              >
                {!account && convs.length === 0 && !stats.has_demo ? (
                  <div className="welcome-card">
                    <div className="welcome-emblem">
                      <IconMail size={24} />
                    </div>
                    <h2>像聊天一样收发与管理邮件</h2>
                    <p>
                      兼容任意标准 IMAP / SMTP 单聊与多人全员群聊。通过内置助手即可一句话完成声明式配置与过滤编排，密码与密钥全程本机独立加密隔离。
                    </p>
                    <div className="welcome-actions">
                      <button type="button" className="primary-btn large" onClick={() => setView("assistant")}>
                        <IconSparkles size={15} />
                        <span>通过 AI 助手对话式配置</span>
                      </button>
                      <button type="button" className="soft-btn large" onClick={loadDemo}>
                        载入演示会话与 4 人群聊
                      </button>
                      <button type="button" className="text-link" onClick={() => openSettings("declarative")}>
                        查看 config.toml 声明式配置与隐私保险箱
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="empty-canvas-hint">选择左侧会话开始沟通，或通过「助手」用自然语言调整规则与配置</div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </div>
  );
}
