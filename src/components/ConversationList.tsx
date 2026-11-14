import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "../api";
import type { Conversation, GroupMember, Status } from "../types";
import { Avatar, copyText, GroupAvatar, shortTime } from "../util";
import { type ContextMenuEntry, useContextMenu } from "./ContextMenu";
import {
  IconBell,
  IconChat,
  IconCheck,
  IconClose,
  IconCopy,
  IconEdit,
  IconMailRead,
  IconMailUnread,
  IconMore,
  IconMute,
  IconOtp,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTrash,
  IconTriage,
  IconUnmute,
  IconUsers,
} from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

export interface ComposePanelIntent {
  seq: number;
  mode: "none" | "direct" | "group";
}

type QuickFilter = "all" | "unread" | "pinned" | "group";

function extractPreviewOtp(preview: string): string | null {
  const m = preview.match(/验证码\s*([A-Za-z0-9-]{4,10})/);
  return m ? m[1] : null;
}

export function buildConversationMenuEntries({
  conv,
  status,
  isSelected,
  onSelect,
  onDeselect,
  onOpenDrawer,
  onChanged,
  notify,
}: {
  conv: Conversation;
  status: Status;
  isSelected: boolean;
  onSelect: (peer: string) => void;
  onDeselect: () => void;
  onOpenDrawer: (peer: string) => void;
  onChanged: () => Promise<void> | void;
  notify: (text: string, isError?: boolean) => void;
}): ContextMenuEntry[] {
  const cleanName = conv.name.replace(/^🚀\s*/, "");
  const otpCode = extractPreviewOtp(conv.preview);
  const copyTarget = conv.is_group
    ? conv.members.map((m) => m.email).join(", ")
    : conv.peer;

  const runAction = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      await onChanged();
      notify(okMsg);
    } catch (e) {
      notify(`操作失败：${e}`, true);
    }
  };

  return [
    {
      kind: "header",
      label: cleanName,
      badge: conv.is_group ? `${conv.members.length + 1}人` : conv.pinned ? "已置顶" : undefined,
    },
    !isSelected
      ? {
          label: "打开对话",
          icon: <IconChat size={14} />,
          accent: true,
          onSelect: () => onSelect(conv.peer),
        }
      : null,
    otpCode
      ? {
          label: `复制验证码 ${otpCode}`,
          icon: <IconOtp size={14} />,
          accent: true,
          onSelect: async () => {
            await copyText(otpCode);
            notify(`已复制验证码：${otpCode}`);
          },
        }
      : null,
    {
      label: conv.pinned ? "取消置顶" : "置顶会话",
      icon: <IconPin size={14} />,
      onSelect: () =>
        runAction(
          () => api.setConversationPinned(conv.peer, !conv.pinned),
          conv.pinned ? `已取消「${cleanName}」置顶` : `已置顶「${cleanName}」`,
        ),
    },
    conv.unread > 0
      ? {
          label: "标为已读",
          icon: <IconMailRead size={14} />,
          onSelect: () =>
            runAction(
              () => api.setConversationRead(conv.peer, status, true),
              `已将「${cleanName}」标为已读`,
            ),
        }
      : {
          label: "标为未读",
          icon: <IconMailUnread size={14} />,
          onSelect: async () => {
            if (isSelected) {
              onDeselect();
            }
            await runAction(
              () => api.setConversationRead(conv.peer, status, false),
              `已将「${cleanName}」标为未读`,
            );
          },
        },
    status !== "blocked"
      ? {
          label: conv.muted ? "关闭免打扰（恢复至消息）" : "开启免打扰（归入通知）",
          icon: conv.muted ? <IconUnmute size={14} /> : <IconMute size={14} />,
          onSelect: async () => {
            if (isSelected) onDeselect();
            await runAction(
              () => api.setConversationMuted(conv.peer, !conv.muted),
              conv.muted ? "已关闭免打扰并移回消息" : "已开启免打扰并折叠至通知",
            );
          },
        }
      : null,
    { kind: "divider" },
    {
      label: conv.is_group ? "群聊成员与设置…" : "联系人详情 / 修改备注…",
      icon: conv.is_group ? <IconUsers size={14} /> : <IconEdit size={14} />,
      onSelect: () => onOpenDrawer(conv.peer),
    },
    copyTarget
      ? {
          label: conv.is_group ? "复制全部群成员邮箱" : "复制邮箱地址",
          sublabel: conv.is_group ? `共 ${conv.members.length} 位成员` : conv.peer,
          icon: <IconCopy size={14} />,
          onSelect: async () => {
            await copyText(copyTarget);
            notify(conv.is_group ? "已复制全部群成员邮箱" : `已复制 ${conv.peer}`);
          },
        }
      : null,
    { kind: "divider" },
    !conv.is_group && status === "inbox"
      ? {
          label: "移入「通知」折叠",
          icon: <IconBell size={14} />,
          onSelect: async () => {
            if (isSelected) onDeselect();
            await runAction(() => api.moveConversation(conv.peer, "archived"), "已移入通知列表");
          },
        }
      : null,
    !conv.is_group && status === "archived"
      ? {
          label: "移回「消息」收件箱",
          icon: <IconChat size={14} />,
          onSelect: async () => {
            if (isSelected) onDeselect();
            await runAction(() => api.moveConversation(conv.peer, "inbox"), "已移回消息列表");
          },
        }
      : null,
    !conv.is_group && status === "blocked"
      ? {
          label: "恢复并加入白名单",
          icon: <IconCheck size={14} />,
          accent: true,
          onSelect: async () => {
            if (isSelected) onDeselect();
            await runAction(
              () => api.allowSender(conv.peer),
              `已信任 ${conv.peer} 并移回消息`,
            );
          },
        }
      : null,
    !conv.is_group && status !== "blocked"
      ? {
          label: "屏蔽该发件人",
          icon: <IconShield size={14} />,
          danger: true,
          onSelect: () => {
            if (!window.confirm(`确定屏蔽 ${conv.peer} 并将所有往来邮件移入「拦截」吗？`)) return;
            if (isSelected) onDeselect();
            void runAction(() => api.blockSender(conv.peer), `已屏蔽 ${conv.peer}`);
          },
        }
      : null,
    {
      label: conv.is_group ? "解散 / 删除本地群聊" : "删除本地会话记录",
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        const msg = conv.is_group
          ? `确定删除群聊「${cleanName}」及其本地聊天记录吗？`
          : `确定从本地客户端删除与「${cleanName}」的会话记录吗？（远端邮箱服务器原件不受影响）`;
        if (!window.confirm(msg)) return;
        if (isSelected) onDeselect();
        void runAction(
          () => api.deleteConversation(conv.peer, conv.is_group ? undefined : status),
          `已删除会话「${cleanName}」`,
        );
      },
    },
  ];
}

interface Props {
  title: string;
  status: Status;
  hydrated?: boolean;
  hasAccount?: boolean;
  hasDemo?: boolean;
  items: Conversation[];
  drafts?: Record<string, string>;
  selected: string | null;
  composeIntent?: ComposePanelIntent;
  onSelect: (peer: string) => void;
  onDeselect: () => void;
  onOpenDrawer: (peer: string) => void;
  onNewChat: (email: string, name?: string) => void;
  onCreateGroup: (name: string, members: GroupMember[]) => Promise<void>;
  onRefresh: () => void;
  onRunTriage: () => void;
  onDataChanged: () => Promise<void> | void;
  onBindAccount?: () => void;
  onLoadDemo?: () => void;
  notify: (text: string, isError?: boolean) => void;
  syncing: boolean;
  triaging: boolean;
  emptyHint: string;
}

export function ConversationList({
  title,
  status,
  hydrated = true,
  hasAccount = false,
  hasDemo = false,
  items,
  drafts,
  selected,
  composeIntent,
  onSelect,
  onDeselect,
  onOpenDrawer,
  onNewChat,
  onCreateGroup,
  onRefresh,
  onRunTriage,
  onDataChanged,
  onBindAccount,
  onLoadDemo,
  notify,
  syncing,
  triaging,
  emptyHint,
}: Props) {
  const { openContextMenu } = useContextMenu();
  const [q, setQ] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [mode, setMode] = useState<"none" | "direct" | "group">("none");

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");

  const [groupName, setGroupName] = useState("");
  const [contacts, setContacts] = useState<GroupMember[]>([]);
  const [picked, setPicked] = useState<GroupMember[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  // 响应外部（如第一屏工作台）触发的发起单聊 / 新建群聊面板请求
  useEffect(() => {
    if (!composeIntent || composeIntent.seq <= 0) return;
    setMode(composeIntent.mode);
    if (composeIntent.mode === "group") {
      api
        .listContacts()
        .then(setContacts)
        .catch(() => setContacts([]));
    }
  }, [composeIntent?.seq, composeIntent?.mode]);

  useEffect(() => {
    setQuickFilter("all");
  }, [status]);

  const counts = useMemo(() => {
    let unread = 0;
    let pinned = 0;
    let group = 0;
    for (const c of items) {
      if (c.unread > 0) unread += 1;
      if (c.pinned) pinned += 1;
      if (c.is_group) group += 1;
    }
    return { unread, pinned, group };
  }, [items]);

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    return items.filter((c) => {
      if (quickFilter === "unread" && c.unread <= 0) return false;
      if (quickFilter === "pinned" && !c.pinned) return false;
      if (quickFilter === "group" && !c.is_group) return false;
      if (!k) return true;
      return (
        c.name.toLowerCase().includes(k) ||
        (c.raw_name ?? "").toLowerCase().includes(k) ||
        (c.note ?? "").toLowerCase().includes(k) ||
        c.peer.toLowerCase().includes(k) ||
        c.category.toLowerCase().includes(k) ||
        c.preview.toLowerCase().includes(k) ||
        c.members.some((m) => m.email.toLowerCase().includes(k) || m.name.toLowerCase().includes(k))
      );
    });
  }, [items, q, quickFilter]);

  const toggleMode = async (target: "direct" | "group") => {
    if (mode === target) {
      setMode("none");
      return;
    }
    setMode(target);
    if (target === "group") {
      try {
        setContacts(await api.listContacts());
      } catch {
        setContacts([]);
      }
    }
  };

  const submitNew = () => {
    if (!newEmail.trim()) return;
    if (newName.trim()) {
      void api
        .saveContactProfile({
          email: newEmail.trim().toLowerCase(),
          alias: newName.trim(),
          note: "",
          tag: "",
          muted: false,
        })
        .catch(() => {});
    }
    onNewChat(newEmail, newName);
    setNewEmail("");
    setNewName("");
    setMode("none");
  };

  const toggleContact = (c: GroupMember) => {
    setPicked((prev) =>
      prev.some((p) => p.email === c.email) ? prev.filter((p) => p.email !== c.email) : [...prev, c],
    );
  };

  const parseMemberEntries = (raw: string): GroupMember[] => {
    const out: GroupMember[] = [];
    for (const part of raw.split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)<([^>]+)>$/);
      if (m && m[2].includes("@")) {
        out.push({ name: m[1].trim(), email: m[2].trim().toLowerCase() });
      } else if (part.includes("@")) {
        out.push({ name: "", email: part.toLowerCase() });
      }
    }
    return out;
  };

  const addManualMember = () => {
    const parsed = parseMemberEntries(memberInput);
    if (parsed.length === 0) return;
    setPicked((prev) => {
      const map = new Map(prev.map((p) => [p.email, p]));
      for (const p of parsed) {
        if (!map.has(p.email)) map.set(p.email, p);
      }
      return Array.from(map.values());
    });
    setMemberInput("");
  };

  const submitGroup = async () => {
    const finalMembers = [...picked];
    if (memberInput.trim()) {
      for (const p of parseMemberEntries(memberInput)) {
        if (!finalMembers.some((m) => m.email === p.email)) finalMembers.push(p);
      }
    }
    if (finalMembers.length === 0 || creatingGroup) return;
    setCreatingGroup(true);
    try {
      await onCreateGroup(groupName, finalMembers);
      setGroupName("");
      setPicked([]);
      setMemberInput("");
      setMode("none");
    } finally {
      setCreatingGroup(false);
    }
  };

  const openListSurfaceMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    if (target?.closest(".conv, input, textarea, .floating-panel")) return;
    const hasUnreadInList = items.some((c) => c.unread > 0);
    openContextMenu(e, [
      { kind: "header", label: `${title}列表`, badge: `${items.length} 个会话` },
      {
        label: syncing ? "正在同步收信…" : "立即同步收信",
        icon: <IconRefresh size={14} />,
        accent: true,
        disabled: syncing,
        onSelect: onRefresh,
      },
      hasUnreadInList
        ? {
            label: `将当前「${title}」全部标为已读`,
            icon: <IconMailRead size={14} />,
            onSelect: async () => {
              try {
                await api.markAllRead(status);
                await onDataChanged();
                notify(`已将「${title}」列表全部标为已读`);
              } catch (err) {
                notify(`操作失败：${err}`, true);
              }
            },
          }
        : null,
      { kind: "divider" },
      {
        label: "发起新单聊",
        icon: <IconPlus size={14} />,
        onSelect: () => void toggleMode("direct"),
      },
      {
        label: "发起多人邮件群聊",
        icon: <IconUsers size={14} />,
        onSelect: () => void toggleMode("group"),
      },
      {
        label: triaging ? "AI 正在重分拣…" : "AI 重新分拣现有来信",
        icon: <IconTriage size={14} />,
        disabled: triaging,
        onSelect: onRunTriage,
      },
    ]);
  };

  const openItemMenu = (e: ReactMouseEvent<HTMLElement>, c: Conversation) => {
    openContextMenu(
      e,
      buildConversationMenuEntries({
        conv: c,
        status,
        isSelected: selected === c.peer,
        onSelect,
        onDeselect,
        onOpenDrawer,
        onChanged: onDataChanged,
        notify,
      }),
    );
  };

  return (
    <aside className="convlist" onContextMenu={openListSurfaceMenu}>
      <div className="convlist-head" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
        <div className="convlist-title-group">
          <span className="convlist-title">{title}</span>
          {hydrated && items.length > 0 && (
            <span className="convlist-count-pill">{items.length}</span>
          )}
        </div>
        <div className="convlist-tools">
          <button
            type="button"
            className={`tool-btn ${mode === "direct" ? "active" : ""}`}
            onClick={() => void toggleMode("direct")}
            title="发起单聊"
          >
            <IconPlus size={16} />
          </button>
          <button
            type="button"
            className={`tool-btn ${mode === "group" ? "active" : ""}`}
            onClick={() => void toggleMode("group")}
            title="发起多人邮件群聊"
          >
            <IconUsers size={16} />
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={onRunTriage}
            disabled={triaging}
            title="让 AI 重新分拣现有邮件"
          >
            <span className={triaging ? "spin" : ""}>
              <IconTriage size={16} />
            </span>
          </button>
          <button type="button" className="tool-btn" onClick={onRefresh} disabled={syncing} title="立即同步收信">
            <span className={syncing ? "spin" : ""}>
              <IconRefresh size={15} />
            </span>
          </button>
        </div>
      </div>

      <div className="search-wrap">
        <IconSearch size={14} className="search-icon" />
        <input
          className="search-input"
          placeholder="搜索联系人、群聊或内容"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => setQ("")}
            title="清空搜索"
          >
            <IconClose size={12} />
          </button>
        )}
      </div>

      {hydrated && items.length > 0 && (
        <div className="conv-filter-bar">
          <button
            type="button"
            className={`conv-filter-chip ${quickFilter === "all" ? "active" : ""}`}
            onClick={() => setQuickFilter("all")}
          >
            <span>全部</span>
          </button>
          <button
            type="button"
            className={`conv-filter-chip ${quickFilter === "unread" ? "active" : ""}`}
            onClick={() => setQuickFilter(quickFilter === "unread" ? "all" : "unread")}
          >
            <span>未读</span>
            {counts.unread > 0 && <span className="conv-filter-num">{counts.unread}</span>}
          </button>
          {counts.pinned > 0 && (
            <button
              type="button"
              className={`conv-filter-chip ${quickFilter === "pinned" ? "active" : ""}`}
              onClick={() => setQuickFilter(quickFilter === "pinned" ? "all" : "pinned")}
            >
              <span>置顶</span>
              <span className="conv-filter-num muted">{counts.pinned}</span>
            </button>
          )}
          {counts.group > 0 && (
            <button
              type="button"
              className={`conv-filter-chip ${quickFilter === "group" ? "active" : ""}`}
              onClick={() => setQuickFilter(quickFilter === "group" ? "all" : "group")}
            >
              <span>群聊</span>
              <span className="conv-filter-num muted">{counts.group}</span>
            </button>
          )}
        </div>
      )}

      {mode === "direct" && (
        <div className="floating-panel">
          <div className="panel-head">
            <span>新建单聊</span>
            <button type="button" className="tool-btn small" onClick={() => setMode("none")}>
              <IconClose size={13} />
            </button>
          </div>
          <input
            autoFocus
            placeholder="对方邮箱（如 alice@example.com）"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitNew()}
          />
          <div className="row">
            <input
              className="grow"
              placeholder="备注昵称（可选）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitNew()}
            />
            <button type="button" className="primary-btn" onClick={submitNew} disabled={!newEmail.trim()}>
              开始
            </button>
          </div>
        </div>
      )}

      {mode === "group" && (
        <div className="floating-panel">
          <div className="panel-head">
            <span>发起邮件群聊</span>
            <button type="button" className="tool-btn small" onClick={() => setMode("none")}>
              <IconClose size={13} />
            </button>
          </div>
          <input
            autoFocus
            placeholder="群聊名称（可选，如：产品推进群）"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />

          {contacts.length > 0 && (
            <div className="contact-pick-area">
              <div className="pick-caption">往来联系人</div>
              <div className="contact-chips">
                {contacts.slice(0, 12).map((c) => {
                  const active = picked.some((p) => p.email === c.email);
                  return (
                    <button
                      key={c.email}
                      type="button"
                      className={`contact-chip ${active ? "selected" : ""}`}
                      onClick={() => toggleContact(c)}
                      title={c.email}
                    >
                      {active && <IconCheck size={11} />}
                      <span>{c.name || c.email.split("@")[0]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="row">
            <input
              className="grow"
              placeholder="输入成员邮箱，回车添加"
              value={memberInput}
              onChange={(e) => setMemberInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManualMember();
                }
              }}
            />
            <button type="button" className="soft-btn" onClick={addManualMember} disabled={!memberInput.trim()}>
              添加
            </button>
          </div>

          {picked.length > 0 && (
            <div className="picked-members">
              {picked.map((m) => (
                <span key={m.email} className="picked-pill" title={m.email}>
                  <span>{m.name || m.email}</span>
                  <button
                    type="button"
                    className="pill-remove"
                    onClick={() => setPicked((prev) => prev.filter((x) => x.email !== m.email))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="row space-between">
            <span className="pick-caption">共 {picked.length + 1} 人（含自己）</span>
            <button
              type="button"
              className="primary-btn"
              onClick={submitGroup}
              disabled={creatingGroup || (picked.length === 0 && !memberInput.includes("@"))}
            >
              {creatingGroup ? "创建中…" : "创建群聊"}
            </button>
          </div>
        </div>
      )}

      <div className="convlist-items">
        {!hydrated ? (
          <div className="conv-skeleton-list" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((idx) => (
              <div key={idx} className="conv-skeleton-row">
                <div className="conv-skeleton-avatar" />
                <div className="conv-skeleton-lines">
                  <div className="conv-skeleton-line short" />
                  <div className="conv-skeleton-line long" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="conv-empty-card">
            {q.trim() || quickFilter !== "all" ? (
              <>
                <div className="conv-empty-title">没有匹配的会话</div>
                <div className="conv-empty-desc">
                  可尝试调整关键词或切换回「全部」视图
                </div>
                <button
                  type="button"
                  className="soft-btn"
                  onClick={() => {
                    setQ("");
                    setQuickFilter("all");
                  }}
                >
                  清除筛选条件
                </button>
              </>
            ) : !hasAccount && !hasDemo && status === "inbox" ? (
              <>
                <div className="conv-empty-title">尚未连接邮箱账号</div>
                <div className="conv-empty-desc">
                  绑定任意 IMAP / SMTP 邮箱后，往来邮件将自动聚合为清爽的单聊与群聊列表
                </div>
                <div className="conv-empty-actions">
                  {onBindAccount && (
                    <button type="button" className="primary-btn" onClick={onBindAccount}>
                      <IconPlus size={13} />
                      <span>绑定邮箱</span>
                    </button>
                  )}
                  {onLoadDemo && (
                    <button type="button" className="soft-btn" onClick={onLoadDemo}>
                      <span>体验演示</span>
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="conv-empty-desc">{emptyHint}</div>
                {status === "inbox" && (
                  <div className="conv-empty-actions">
                    <button
                      type="button"
                      className="soft-btn"
                      onClick={() => void toggleMode("direct")}
                    >
                      <IconPlus size={13} />
                      <span>发起单聊</span>
                    </button>
                    {hasAccount && (
                      <button
                        type="button"
                        className="soft-btn"
                        onClick={onRefresh}
                        disabled={syncing}
                      >
                        <IconSparkles size={13} />
                        <span>{syncing ? "同步中…" : "同步收信"}</span>
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          filtered.map((c) => {
            const otp = extractPreviewOtp(c.preview);
            return (
              <div
                key={c.peer}
                className={[
                  "conv",
                  selected === c.peer ? "active" : "",
                  c.pinned ? "is-pinned" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect(c.peer)}
                onContextMenu={(e) => openItemMenu(e, c)}
              >
                {c.is_group ? (
                  <GroupAvatar members={c.members} seed={c.peer} />
                ) : (
                  <Avatar name={c.name} seed={c.peer} />
                )}
                <div className="conv-main">
                  <div className="conv-row">
                    <div className="conv-name-wrap">
                      {c.pinned && (
                        <span className="conv-pin-badge" title="已置顶会话">
                          <IconPin size={11} />
                        </span>
                      )}
                      <span className="conv-name">
                        {c.name.replace(/^🚀\s*/, "")}
                        {c.is_group && <span className="group-count">({c.members.length + 1})</span>}
                      </span>
                      {c.muted && (
                        <span className="mute-icon" title="已开启免打扰">
                          <IconMute size={12} />
                        </span>
                      )}
                    </div>
                    <span className="conv-time">{shortTime(c.last_date)}</span>
                    <button
                      type="button"
                      className="conv-more-btn"
                      title="更多会话操作"
                      onClick={(e) => openItemMenu(e, c)}
                    >
                      <IconMore size={13} />
                    </button>
                  </div>
                  <div className="conv-row">
                    {drafts?.[c.peer]?.trim() && selected !== c.peer ? (
                      <span className="conv-preview">
                        <span className="conv-draft-tag">[草稿]</span>{" "}
                        {drafts[c.peer].replace(/\s+/g, " ").trim()}
                      </span>
                    ) : otp ? (
                      <span className="conv-preview">
                        <span
                          className="conv-otp-pill"
                          title="点击直接复制验证码"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copyText(otp).then(() => notify(`已复制验证码：${otp}`));
                          }}
                        >
                          验证码 {otp}
                        </span>{" "}
                        {c.preview.replace(/^🔑\s*验证码\s*[A-Za-z0-9-]+\s*·?\s*/, "")}
                      </span>
                    ) : (
                      <span className="conv-preview">{c.preview.replace(/^🔑\s*/, "") || c.peer}</span>
                    )}
                    {c.unread > 0 ? (
                      <span className={`badge ${c.muted ? "badge-muted" : ""}`}>
                        {c.unread > 99 ? "99+" : c.unread}
                      </span>
                    ) : (
                      c.category && <span className="mini-tag">{c.category}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
