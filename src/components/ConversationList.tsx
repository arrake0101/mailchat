import { useMemo, useState } from "react";
import { api } from "../api";
import type { Conversation, GroupMember } from "../types";
import { Avatar, GroupAvatar, shortTime } from "../util";
import { IconCheck, IconClose, IconMute, IconPlus, IconRefresh, IconSearch, IconSparkles, IconUsers } from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

interface Props {
  title: string;
  items: Conversation[];
  selected: string | null;
  onSelect: (peer: string) => void;
  onNewChat: (email: string, name?: string) => void;
  onCreateGroup: (name: string, members: GroupMember[]) => Promise<void>;
  onRefresh: () => void;
  onRunTriage: () => void;
  syncing: boolean;
  triaging: boolean;
  emptyHint: string;
}

export function ConversationList({
  title,
  items,
  selected,
  onSelect,
  onNewChat,
  onCreateGroup,
  onRefresh,
  onRunTriage,
  syncing,
  triaging,
  emptyHint,
}: Props) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"none" | "direct" | "group">("none");

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");

  const [groupName, setGroupName] = useState("");
  const [contacts, setContacts] = useState<GroupMember[]>([]);
  const [picked, setPicked] = useState<GroupMember[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return items;
    return items.filter(
      (c) =>
        c.name.toLowerCase().includes(k) ||
        c.peer.toLowerCase().includes(k) ||
        c.category.toLowerCase().includes(k) ||
        c.preview.toLowerCase().includes(k) ||
        c.members.some((m) => m.email.toLowerCase().includes(k) || m.name.toLowerCase().includes(k)),
    );
  }, [items, q]);

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

  return (
    <aside className="convlist">
      <div className="convlist-head" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
        <span className="convlist-title">{title}</span>
        <div className="convlist-tools">
          <button
            type="button"
            className={`tool-btn ${mode === "direct" ? "active" : ""}`}
            onClick={() => toggleMode("direct")}
            title="发起单聊"
          >
            <IconPlus size={16} />
          </button>
          <button
            type="button"
            className={`tool-btn ${mode === "group" ? "active" : ""}`}
            onClick={() => toggleMode("group")}
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
              <IconSparkles size={16} />
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
      </div>

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
        {filtered.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        {filtered.map((c) => (
          <div
            key={c.peer}
            className={`conv ${selected === c.peer ? "active" : ""}`}
            onClick={() => onSelect(c.peer)}
          >
            {c.is_group ? (
              <GroupAvatar members={c.members} seed={c.peer} />
            ) : (
              <Avatar name={c.name} seed={c.peer} />
            )}
            <div className="conv-main">
              <div className="conv-row">
                <div className="conv-name-wrap">
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
              </div>
              <div className="conv-row">
                <span className="conv-preview">{c.preview.replace(/^🔑\s*/, "") || c.peer}</span>
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
        ))}
      </div>
    </aside>
  );
}
