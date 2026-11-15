import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type {
  Account,
  AccountEntry,
  ComposeAgentBridge,
  ComposeLaunchIntent,
  Conversation,
  GroupMember,
  MailboxStats,
  Message,
  ReplyAgentBridge,
  Status,
  SyncReport,
  ThemeConfig,
  UpdateStatusSnapshot,
} from "./types";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { ChatView } from "./components/ChatView";
import { ComposeWorkspace } from "./components/ComposeWorkspace";
import { ContextMenuProvider, useContextMenu } from "./components/ContextMenu";
import { type ComposePanelIntent, ConversationList } from "./components/ConversationList";
import { FirstScreenWorkspace } from "./components/FirstScreenWorkspace";
import { GlobalAgentDock } from "./components/GlobalAgentDock";
import {
  BrandAppIcon,
  IconBell,
  IconChat,
  IconCode,
  IconCompose,
  IconLock,
  IconMailRead,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconReplyHub,
  IconShield,
  IconSliders,
  IconSparkles,
  IconSun,
  IconTriage,
  IconUpdate,
} from "./components/Icons";
import { ReplyHubWorkspace } from "./components/ReplyHubWorkspace";
import { Settings, type AccountFormIntent, type SettingsTab } from "./components/Settings";
import { startWindowDrag, toggleWindowMaximize, WindowControls } from "./components/WindowControls";
import { applyThemeToDom, DEFAULT_THEME_CONFIG, normalizeThemeConfig } from "./theme";

type View = Status | "compose" | "reply_hub" | "assistant" | "settings";

function isStandaloneView(v: View): v is "compose" | "reply_hub" | "assistant" | "settings" {
  return v === "compose" || v === "reply_hub" || v === "assistant" || v === "settings";
}

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
  reply_pending_count: 0,
  has_demo: false,
};

function AppContent({
  notify,
  toast,
}: {
  notify: (text: string, error?: boolean) => void;
  toast: { text: string; error: boolean } | null;
}) {
  const { openContextMenu } = useContextMenu();
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("inbox");
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [stats, setStats] = useState<MailboxStats>(EMPTY_STATS);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftConv, setDraftConv] = useState<Conversation | null>(null);
  const [draftTexts, setDraftTexts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("visual");
  const [accountIntent, setAccountIntent] = useState<AccountFormIntent>({
    seq: 0,
    mode: "manage",
  });
  const [composeIntent, setComposeIntent] = useState<ComposePanelIntent>({
    seq: 0,
    mode: "direct",
  });
  const [openDrawerReq, setOpenDrawerReq] = useState<{ peer: string; seq: number }>({
    peer: "",
    seq: 0,
  });
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(DEFAULT_THEME_CONFIG);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusSnapshot | null>(null);
  const [composeLaunchIntent, setComposeLaunchIntent] = useState<ComposeLaunchIntent | null>(null);
  const [agentDockOpen, setAgentDockOpen] = useState(false);
  const [composeBridge, setComposeBridge] = useState<ComposeAgentBridge | null>(null);
  const [replyBridge, setReplyBridge] = useState<ReplyAgentBridge | null>(null);
  const [dockPromptReq, setDockPromptReq] = useState<{
    seq: number;
    prompt: string;
    autoSend?: boolean;
  } | null>(null);
  const [agentChatDraftReq, setAgentChatDraftReq] = useState<{
    seq: number;
    peer: string;
    text: string;
  } | null>(null);

  const OUTRIGGER_DOCK_TOTAL_WIDTH = 448;

  const toggleAgentDock = useCallback((next?: boolean) => {
    setAgentDockOpen((prev) => {
      const target = typeof next === "boolean" ? next : !prev;
      if (target !== prev) {
        api.setAgentDockExpanded(target, OUTRIGGER_DOCK_TOTAL_WIDTH).catch(() => {});
      }
      return target;
    });
  }, []);

  const summonGlobalAgent = useCallback((prefillPrompt?: string, autoSend?: boolean) => {
    setAgentDockOpen((prev) => {
      if (!prev) {
        api.setAgentDockExpanded(true, OUTRIGGER_DOCK_TOTAL_WIDTH).catch(() => {});
      }
      return true;
    });
    if (prefillPrompt !== undefined) {
      setDockPromptReq((prev) => ({
        seq: (prev?.seq ?? 0) + 1,
        prompt: prefillPrompt,
        autoSend,
      }));
    }
  }, []);

  const cur = useRef({ view, selected, draftConv });
  cur.current = { view, selected, draftConv };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (cur.current.view === "assistant") return;
        toggleAgentDock();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleAgentDock]);

  useEffect(() => {
    api
      .getThemeConfig()
      .then((t) => {
        const norm = applyThemeToDom(t);
        setThemeConfig(norm);
      })
      .catch(() => {
        applyThemeToDom(DEFAULT_THEME_CONFIG);
      });

    const unTheme = listen<ThemeConfig>("theme-updated", (e) => {
      const norm = applyThemeToDom(e.payload);
      setThemeConfig(norm);
    });
    api
      .getUpdateStatus()
      .then((snap) => setUpdateStatus(snap))
      .catch(() => {});
    const unUpdate = listen<UpdateStatusSnapshot>("app-update-status", (e) => {
      setUpdateStatus(e.payload);
    });
    return () => {
      unTheme.then((f) => f());
      unUpdate.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (normalizeThemeConfig(themeConfig).mode !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyThemeToDom(themeConfig);
    };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
    };
  }, [themeConfig]);

  const refresh = useCallback(async () => {
    try {
      const { view, selected, draftConv } = cur.current;
      const [acc, accList, st] = await Promise.all([
        api.getAccount(),
        api.listAccounts().catch(() => [] as AccountEntry[]),
        api.getStats(),
      ]);
      setAccount(acc);
      setAccounts(accList);
      setStats(st);

      if (isStandaloneView(view)) return;
      const list = await api.listConversations(view);
      setConvs(list);
      if (selected && list.some((c) => c.peer === selected)) {
        setDraftConv(null);
        setMessages(await api.listMessages(selected, view));
        const [freshSt, freshAccounts] = await Promise.all([
          api.getStats(),
          api.listAccounts().catch(() => accList),
        ]);
        setStats(freshSt);
        setAccounts(freshAccounts);
      } else if (selected && draftConv && draftConv.peer === selected) {
        setMessages([]);
      } else if (selected) {
        setSelected(null);
        setMessages([]);
      }
    } finally {
      setHydrated(true);
    }
  }, []);

  const handleSwitchAccount = useCallback(
    async (targetEmail: string) => {
      const clean = targetEmail.trim().toLowerCase();
      if (!clean || switchingAccount) return;
      if (account?.email?.trim().toLowerCase() === clean) return;
      setSwitchingAccount(true);
      try {
        const nextAccounts = await api.switchAccount(clean);
        setAccounts(nextAccounts);
        cur.current = { ...cur.current, selected: null, draftConv: null };
        setSelected(null);
        setDraftConv(null);
        setMessages([]);
        await refresh();
        notify(`已切换至邮箱 ${clean}`);
      } catch (e) {
        notify(`切换邮箱失败：${e}`, true);
      } finally {
        setSwitchingAccount(false);
      }
    },
    [account?.email, switchingAccount, refresh, notify],
  );

  const handleReorderAccounts = useCallback(
    async (orderedEmails: string[]) => {
      setAccounts((prev) => {
        const byEmail = new Map(prev.map((a) => [a.email.toLowerCase(), a]));
        const next: AccountEntry[] = [];
        for (const raw of orderedEmails) {
          const hit = byEmail.get(raw.toLowerCase());
          if (hit) {
            next.push(hit);
            byEmail.delete(raw.toLowerCase());
          }
        }
        for (const rest of byEmail.values()) next.push(rest);
        return next;
      });
      try {
        const updated = await api.reorderAccounts(orderedEmails);
        setAccounts(updated);
      } catch (e) {
        notify(`调整邮箱顺序失败：${e}`, true);
        refresh();
      }
    },
    [notify, refresh],
  );

  useEffect(() => {
    refresh();
  }, [view, refresh]);

  useEffect(() => {
    const un = listen<SyncReport>("mail-updated", (e) => {
      if (e.payload.error) notify(`同步提示：${e.payload.error}`, true);
      refresh();
    });
    const unTrayInbox = listen<boolean>("tray-open-inbox", () => {
      if (cur.current.view !== "compose") {
        setView("inbox");
      }
      refresh();
    });
    return () => {
      un.then((f) => f());
      unTrayInbox.then((f) => f());
    };
  }, [refresh, notify]);

  useEffect(() => {
    let lastPoke = 0;
    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastPoke < 8000) return;
      lastPoke = now;
      api.pokeMailSync();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, []);

  const select = useCallback(
    async (peer: string) => {
      const targetView: Status = isStandaloneView(cur.current.view) ? "inbox" : cur.current.view;
      if (cur.current.view !== targetView) {
        setView(targetView);
      }
      setDraftConv(null);
      setSelected(peer);
      setMessages(await api.listMessages(peer, targetView));
      void refresh();
    },
    [refresh],
  );

  const openDrawerForPeer = useCallback(
    async (peer: string) => {
      await select(peer);
      setOpenDrawerReq((prev) => ({ peer, seq: prev.seq + 1 }));
    },
    [select],
  );

  const startNewChat = useCallback(
    (email: string, name?: string) => {
      const peer = email.trim().toLowerCase();
      if (!peer.includes("@")) {
        notify("请输入格式正确的邮箱地址", true);
        return;
      }
      setView("inbox");
      const existing = convs.find((c) => c.peer === peer);
      if (existing) {
        void select(peer);
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
    },
    [convs, notify, select],
  );

  // 支持从全局右键菜单（如选中任意文本邮箱点击“发起单聊”）呼起对话
  useEffect(() => {
    const onGlobalStartChat = (ev: Event) => {
      const email = (ev as CustomEvent<string>).detail;
      if (email) startNewChat(email);
    };
    window.addEventListener("mailchat-start-chat", onGlobalStartChat);
    return () => window.removeEventListener("mailchat-start-chat", onGlobalStartChat);
  }, [startNewChat]);

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

  const openAccountForm = (mode: "add" | "manage" | "update", presetDomain?: string) => {
    setSettingsTab("visual");
    setAccountIntent((prev) => ({ seq: prev.seq + 1, mode, presetDomain }));
    setView("settings");
  };

  const openComposePanel = (mode: "direct" | "group") => {
    if (isStandaloneView(view)) {
      setView("inbox");
    }
    setComposeIntent((prev) => ({ seq: prev.seq + 1, mode }));
  };

  const openComposeStudio = useCallback((intent?: Omit<ComposeLaunchIntent, "id">) => {
    if (intent) {
      setComposeLaunchIntent({
        ...intent,
        id: `launch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      });
    }
    cur.current = { view: "compose", selected: null, draftConv: null };
    setSelected(null);
    setDraftConv(null);
    setMessages([]);
    setView("compose");
  }, []);

  const goFirstScreen = useCallback(() => {
    cur.current = { view: "inbox", selected: null, draftConv: null };
    setSelected(null);
    setDraftConv(null);
    setMessages([]);
    setComposeIntent((prev) => ({ seq: prev.seq + 1, mode: "none" }));
    if (view !== "inbox") {
      setView("inbox");
    } else {
      void refresh();
    }
  }, [view, refresh]);

  // 进入独立「助手」配置工作台时自动收起右侧弹出面板，保持原版双栏体验且不重复渲染
  useEffect(() => {
    if (view === "assistant" && agentDockOpen) {
      toggleAgentDock(false);
    }
  }, [view, agentDockOpen, toggleAgentDock]);

  const switchNav = (target: View) => {
    if (target === view && !isStandaloneView(target) && selected !== null) {
      // 再次点击当前所处的「消息/通知/拦截」导航图标时，返回对应视图总览台
      cur.current = { ...cur.current, selected: null, draftConv: null };
      setSelected(null);
      setDraftConv(null);
      setMessages([]);
      return;
    }
    if (target === "assistant" && agentDockOpen) {
      toggleAgentDock(false);
    }
    const clearConv = isStandaloneView(target);
    cur.current = {
      view: target,
      selected: clearConv ? null : cur.current.selected,
      draftConv: null,
    };
    setView(target);
    setDraftConv(null);
    if (clearConv) {
      setSelected(null);
      setMessages([]);
    }
  };

  const activeScope = (account?.email || "__unbound__").trim().toLowerCase();
  const scopedDrafts: Record<string, string> = {};
  const scopePrefix = `${activeScope}::`;
  for (const [k, v] of Object.entries(draftTexts)) {
    if (k.startsWith(scopePrefix) && v.trim()) {
      scopedDrafts[k.slice(scopePrefix.length)] = v;
    }
  }

  const updatePeerDraft = useCallback(
    (peer: string, value: string) => {
      const key = `${activeScope}::${peer}`;
      setDraftTexts((prev) => {
        if (!value) {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        if (prev[key] === value) return prev;
        return { ...prev, [key]: value };
      });
    },
    [activeScope],
  );

  const applyAgentChatDraft = useCallback(
    (peer: string, text: string) => {
      const targetPeer = peer.trim() || (selected ?? "");
      if (!targetPeer) return;
      updatePeerDraft(targetPeer, text);
      setAgentChatDraftReq((prev) => ({
        seq: (prev?.seq ?? 0) + 1,
        peer: targetPeer,
        text,
      }));
    },
    [selected, updatePeerDraft],
  );

  const activeConv =
    convs.find((c) => c.peer === selected) ??
    (draftConv && draftConv.peer === selected ? draftConv : undefined);
  const mailMeta = MAIL_VIEWS.find((v) => v.key === view);
  const isAtFirstScreen = view === "inbox" && !activeConv;

  return (
    <div className="app-shell">
      <WindowControls
        hydrated={hydrated}
        accountEmail={account?.email}
        accountName={account?.display_name}
        accounts={accounts}
        syncing={syncing}
        switchingAccount={switchingAccount}
        hasDemo={stats.has_demo}
        updateStatus={updateStatus}
        onClickUpdate={() => openAccountForm("update")}
        onClickAccount={() => openAccountForm("manage")}
        onSwitchAccount={handleSwitchAccount}
        onReorderAccounts={handleReorderAccounts}
        onAddAccount={() => openAccountForm("add")}
        onManageAccounts={() => openAccountForm("manage")}
        onSyncNow={syncNow}
        showAgentDockToggle={view !== "assistant"}
        agentDockOpen={agentDockOpen}
        onToggleAgentDock={() => toggleAgentDock()}
        onOpenConfigAssistant={() => switchNav("assistant")}
        notify={notify}
      />

      <div
        className="app-body"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) startWindowDrag(e);
        }}
      >
        <nav className="rail" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
          <button
            type="button"
            className={`rail-brand no-drag ${isAtFirstScreen ? "is-home" : ""}`}
            aria-label="切换回第一屏"
            title={
              isAtFirstScreen
                ? "当前已在第一屏信箱总览 · 右键快捷操作"
                : "点击切换回第一屏信箱总览 · 右键快捷操作"
            }
            onClick={goFirstScreen}
            onContextMenu={(e) => {
              openContextMenu(e, [
                {
                  kind: "header",
                  label: "MailChat 第一屏",
                  badge: isAtFirstScreen ? "当前所在" : undefined,
                },
                {
                  label: "切换回第一屏信箱总览",
                  icon: <IconChat size={14} />,
                  accent: true,
                  onSelect: goFirstScreen,
                },
                {
                  label: syncing ? "正在同步收信…" : "立即同步收信",
                  icon: <IconRefresh size={14} />,
                  disabled: syncing,
                  onSelect: syncNow,
                },
                { kind: "divider" },
                {
                  label: "AI 助手对话编排",
                  icon: <IconSparkles size={14} />,
                  onSelect: () => switchNav("assistant"),
                },
                {
                  label: "多账号与系统设置",
                  icon: <IconSliders size={14} />,
                  onSelect: () => openAccountForm("manage"),
                },
              ]);
            }}
          >
            <BrandAppIcon size={38} />
          </button>

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
                  onContextMenu={(e) => {
                    openContextMenu(e, [
                      { kind: "header", label: `${v.label}视图` },
                      {
                        label: view === v.key && selected !== null ? "返回信箱总览第一屏" : `切换至「${v.label}」`,
                        icon: <Icon size={14} />,
                        accent: true,
                        onSelect: () => switchNav(v.key),
                      },
                      v.key !== "blocked" && badge > 0
                        ? {
                            label: `将「${v.label}」全部标为已读 (${badge})`,
                            icon: <IconMailRead size={14} />,
                            onSelect: async () => {
                              try {
                                await api.markAllRead(v.key);
                                await refresh();
                                notify(`已将「${v.label}」全部标为已读`);
                              } catch (err) {
                                notify(`操作失败：${err}`, true);
                              }
                            },
                          }
                        : null,
                      { kind: "divider" },
                      {
                        label: syncing ? "正在同步…" : "立即同步收信",
                        icon: <IconRefresh size={14} />,
                        disabled: syncing,
                        onSelect: syncNow,
                      },
                      {
                        label: triaging ? "正在重分拣…" : "AI 重新分拣现有邮件",
                        icon: <IconTriage size={14} />,
                        disabled: triaging,
                        onSelect: runAgentTriage,
                      },
                    ]);
                  }}
                  title={
                    view === v.key && selected !== null
                      ? `${v.label}（再次点击返回信箱总览）`
                      : `${v.label} · 右键快捷操作`
                  }
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
              className={`rail-btn ${view === "compose" ? "active" : ""}`}
              onClick={() => switchNav("compose")}
              onContextMenu={(e) => {
                openContextMenu(e, [
                  { kind: "header", label: "传统写信与 Agent HTML 工坊" },
                  {
                    label: "打开写信工坊",
                    icon: <IconCompose size={14} />,
                    accent: true,
                    onSelect: () => switchNav("compose"),
                  },
                  {
                    label: "新建空白商务信函",
                    icon: <IconPlus size={14} />,
                    onSelect: () =>
                      openComposeStudio({
                        to: [],
                        subject: "",
                        bodyPlain: "",
                      }),
                  },
                ]);
              }}
              title="写信工坊（传统完整信头 To/Cc/Bcc + Agent 实时 HTML 富文本邮件编排）"
            >
              <IconCompose size={19} />
              <span className="rail-label">写信</span>
            </button>

            <button
              type="button"
              className={`rail-btn ${view === "reply_hub" ? "active" : ""}`}
              onClick={() => switchNav("reply_hub")}
              onContextMenu={(e) => {
                openContextMenu(e, [
                  { kind: "header", label: "跨邮箱隐私统一批复中心" },
                  {
                    label: "打开待审与批复队列",
                    icon: <IconReplyHub size={14} />,
                    accent: true,
                    onSelect: () => switchNav("reply_hub"),
                  },
                  {
                    label: "查看 config.toml [reply_policy]",
                    icon: <IconCode size={14} />,
                    onSelect: () => openSettings("declarative"),
                  },
                ]);
              }}
              title="跨邮箱统一批复（按授权邮箱范围隔离读取 + 入模前本地 PII 盲脱敏 + 分级发信权限）"
            >
              <IconReplyHub size={19} />
              <span className="rail-label">批复</span>
              {(stats.reply_pending_count ?? 0) > 0 && (
                <span className="rail-badge">
                  {(stats.reply_pending_count ?? 0) > 99
                    ? "99+"
                    : stats.reply_pending_count}
                </span>
              )}
            </button>

            <button
              type="button"
              className={`rail-btn agent-rail-btn ${view === "assistant" ? "active" : ""}`}
              onClick={() => switchNav("assistant")}
              onContextMenu={(e) => {
                openContextMenu(e, [
                  { kind: "header", label: "AI 配置助手工作台" },
                  {
                    label: "打开配置助手工作台",
                    icon: <IconSparkles size={14} />,
                    accent: true,
                    onSelect: () => switchNav("assistant"),
                  },
                  view !== "assistant"
                    ? {
                        label: agentDockOpen
                          ? "收起右侧上下文 AI 面板 (Ctrl+J)"
                          : "向右弹出当前页面 AI 面板 (Ctrl+J)",
                        icon: <IconSliders size={14} />,
                        onSelect: () => toggleAgentDock(),
                      }
                    : null,
                  {
                    label: "直接查看 config.toml 清单",
                    icon: <IconCode size={14} />,
                    onSelect: () => openSettings("declarative"),
                  },
                ]);
              }}
              title="AI 配置助手（对话式编排 config.toml，支持可视化对照与凭据保险箱）"
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
              onContextMenu={(e) => {
                openContextMenu(e, [
                  { kind: "header", label: "配置与隐私中心" },
                  {
                    label: "声明式配置 (config.toml)",
                    icon: <IconCode size={14} />,
                    onSelect: () => openSettings("declarative"),
                  },
                  {
                    label: "隐私凭据保险箱 (DPAPI)",
                    icon: <IconLock size={14} />,
                    onSelect: () => openSettings("vault"),
                  },
                  {
                    label: "可视化表单与多账号管理",
                    icon: <IconSliders size={14} />,
                    onSelect: () => openAccountForm("manage"),
                  },
                  {
                    label:
                      updateStatus &&
                      !updateStatus.is_skipped &&
                      updateStatus.latest_version &&
                      (updateStatus.phase === "available" ||
                        updateStatus.phase === "downloading" ||
                        updateStatus.phase === "ready")
                        ? `客户端更新 (发现 v${updateStatus.latest_version})`
                        : "客户端版本与检查更新",
                    icon: <IconUpdate size={14} />,
                    accent: Boolean(
                      updateStatus &&
                        !updateStatus.is_skipped &&
                        (updateStatus.phase === "available" || updateStatus.phase === "ready"),
                    ),
                    onSelect: () => openAccountForm("update"),
                  },
                  { kind: "divider" },
                  {
                    label: "接入新邮箱账号…",
                    icon: <IconPlus size={14} />,
                    accent: true,
                    onSelect: () => openAccountForm("add"),
                  },
                  { kind: "divider" },
                  { kind: "header", label: "客户端外观主题 [theme]" },
                  {
                    label: `浅色日间模式${themeConfig.mode === "light" ? " (当前)" : ""}`,
                    icon: <IconSun size={14} />,
                    onSelect: async () => {
                      const next = normalizeThemeConfig({ ...themeConfig, mode: "light" });
                      setThemeConfig(applyThemeToDom(next));
                      await api.saveThemeConfig(next).catch(() => {});
                    },
                  },
                  {
                    label: `深色暗夜模式${themeConfig.mode === "dark" ? " (当前)" : ""}`,
                    icon: <IconMoon size={14} />,
                    onSelect: async () => {
                      const next = normalizeThemeConfig({ ...themeConfig, mode: "dark" });
                      setThemeConfig(applyThemeToDom(next));
                      await api.saveThemeConfig(next).catch(() => {});
                    },
                  },
                  {
                    label: `跟随系统亮暗${themeConfig.mode === "system" ? " (当前)" : ""}`,
                    icon: <IconMonitor size={14} />,
                    onSelect: async () => {
                      const next = normalizeThemeConfig({ ...themeConfig, mode: "system" });
                      setThemeConfig(applyThemeToDom(next));
                      await api.saveThemeConfig(next).catch(() => {});
                    },
                  },
                ]);
              }}
              title="声明式配置与隐私凭据保险箱 · 右键直达子页面"
            >
              <IconSliders size={18} />
              <span className="rail-label">配置</span>
              {updateStatus &&
                !updateStatus.is_skipped &&
                (updateStatus.phase === "available" ||
                  updateStatus.phase === "downloading" ||
                  updateStatus.phase === "ready") && (
                  <span
                    className={`rail-update-dot ${
                      updateStatus.phase === "ready" ? "is-ready" : ""
                    }`}
                  />
                )}
            </button>
          </div>
        </nav>

        {view === "compose" ? (
          <ComposeWorkspace
            account={account}
            accounts={accounts}
            hasDemo={stats.has_demo}
            launchIntent={composeLaunchIntent}
            agentDockOpen={agentDockOpen}
            onSummonGlobalAgent={summonGlobalAgent}
            onBindComposeBridge={setComposeBridge}
            notify={notify}
            onOpenSettings={() => openAccountForm("add")}
            onSent={(_m, primaryPeer) => {
              void refresh().then(() => {
                if (primaryPeer) {
                  void select(primaryPeer);
                }
              });
            }}
          />
        ) : view === "reply_hub" ? (
          <ReplyHubWorkspace
            accounts={accounts}
            hasDemo={stats.has_demo}
            agentDockOpen={agentDockOpen}
            onSummonGlobalAgent={summonGlobalAgent}
            onBindReplyBridge={setReplyBridge}
            notify={notify}
            onOpenInCompose={(intent) => openComposeStudio(intent)}
            onDataChanged={refresh}
          />
        ) : view === "assistant" ? (
          <AgentWorkspace
            activeAccountEmail={account?.email}
            onSwitchAccount={handleSwitchAccount}
            notify={notify}
            onDataChanged={refresh}
            onOpenSettings={(tab) => openSettings(tab)}
            onGoToInbox={() => switchNav("inbox")}
          />
        ) : view === "settings" ? (
          <Settings
            initialTab={settingsTab}
            accountIntent={accountIntent}
            activeAccountEmail={account?.email}
            hasDemo={stats.has_demo}
            notify={notify}
            onAccountSaved={() => {
              setView("inbox");
              refresh();
            }}
            onSwitchAccount={handleSwitchAccount}
            onReorderAccounts={handleReorderAccounts}
            onDataChanged={refresh}
            onGoToAgent={() => setView("assistant")}
          />
        ) : (
          <>
            <ConversationList
              title={mailMeta?.label ?? "消息"}
              status={view}
              hydrated={hydrated}
              hasAccount={Boolean(account) || accounts.length > 0}
              hasDemo={stats.has_demo}
              items={convs}
              drafts={scopedDrafts}
              selected={selected}
              composeIntent={composeIntent}
              onSelect={select}
              onDeselect={() => {
                setSelected(null);
                setDraftConv(null);
                setMessages([]);
              }}
              onOpenDrawer={openDrawerForPeer}
              onNewChat={startNewChat}
              onCreateGroup={createGroup}
              onRefresh={syncNow}
              onRunTriage={runAgentTriage}
              onDataChanged={refresh}
              onBindAccount={() => openAccountForm("add")}
              onLoadDemo={loadDemo}
              notify={notify}
              syncing={syncing}
              triaging={triaging}
              emptyHint={mailMeta?.empty ?? ""}
            />

            {activeConv ? (
              <ChatView
                key={`${account?.email || "__unbound__"}:${activeConv.peer}`}
                conv={activeConv}
                conversations={convs}
                status={view}
                messages={messages}
                initialDraft={draftTexts[`${activeScope}::${activeConv.peer}`] ?? ""}
                externalDraftSignal={
                  agentChatDraftReq && agentChatDraftReq.peer === activeConv.peer
                    ? { seq: agentChatDraftReq.seq, text: agentChatDraftReq.text }
                    : null
                }
                openDrawerSeq={openDrawerReq.peer === activeConv.peer ? openDrawerReq.seq : 0}
                onDraftChange={(val) => updatePeerDraft(activeConv.peer, val)}
                onStartDirectChat={startNewChat}
                onOpenComposeStudio={openComposeStudio}
                agentDockOpen={agentDockOpen}
                onToggleAgentDock={() => toggleAgentDock()}
                onSent={(m) => {
                  updatePeerDraft(activeConv.peer, "");
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
              <FirstScreenWorkspace
                hydrated={hydrated}
                status={view}
                account={account}
                accounts={accounts}
                stats={stats}
                conversations={convs}
                syncing={syncing}
                triaging={triaging}
                onSwitchStatus={(st) => switchNav(st)}
                onSelectConversation={select}
                onOpenConversationDrawer={openDrawerForPeer}
                onOpenComposePanel={openComposePanel}
                onOpenComposeStudio={() => switchNav("compose")}
                onOpenReplyHub={() => switchNav("reply_hub")}
                agentDockOpen={agentDockOpen}
                onToggleAgentDock={() => toggleAgentDock()}
                onConnectAccount={(presetDomain) => openAccountForm("add", presetDomain)}
                onManageAccounts={() => openAccountForm("manage")}
                onOpenAssistant={() => switchNav("assistant")}
                onOpenSettings={openSettings}
                onSyncNow={syncNow}
                onRunTriage={runAgentTriage}
                onLoadDemo={loadDemo}
                onDataChanged={refresh}
                notify={notify}
              />
            )}
          </>
        )}

        <GlobalAgentDock
          expanded={agentDockOpen}
          onToggle={toggleAgentDock}
          activeView={view}
          activeAccountEmail={account?.email}
          focusedPeer={activeConv ? activeConv.peer : null}
          focusedPeerName={activeConv ? activeConv.name : null}
          composeBridge={view === "compose" ? composeBridge : null}
          replyBridge={view === "reply_hub" ? replyBridge : null}
          externalPromptRequest={dockPromptReq}
          notify={notify}
          onDataChanged={refresh}
          onOpenSettings={(tab) => openSettings(tab ?? "visual")}
          onSwitchView={(target) => switchNav(target)}
          onOpenComposeWithPeer={(peerEmail) =>
            openComposeStudio({
              to: [peerEmail],
              subject: "",
              bodyPlain: "",
            })
          }
          onOpenComposeFromAgent={(intent) => openComposeStudio(intent)}
          onApplyChatDraft={applyAgentChatDraft}
        />
      </div>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </div>
  );
}

export default function App() {
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const toastTimer = useRef<number>();

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 5500 : 3000);
  }, []);

  const handleStartChatFromGlobal = useCallback((email: string) => {
    window.dispatchEvent(new CustomEvent("mailchat-start-chat", { detail: email }));
  }, []);

  return (
    <ContextMenuProvider notify={notify} onStartChatWithEmail={handleStartChatFromGlobal}>
      <AppContent notify={notify} toast={toast} />
    </ContextMenuProvider>
  );
}
