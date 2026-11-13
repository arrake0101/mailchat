import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Conversation, GroupInfo, GroupMember, Message, Status } from "../types";
import { Avatar, clockTime, dayLabel, GroupAvatar, senderColor } from "../util";
import {
  IconBell,
  IconCheck,
  IconClose,
  IconCopy,
  IconKey,
  IconMute,
  IconNote,
  IconSend,
  IconShield,
  IconSparkles,
  IconTag,
  IconUsers,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

interface Props {
  conv: Conversation;
  status: Status;
  messages: Message[];
  onSent: (m: Message) => void;
  onChanged: () => void;
  onGroupUpdated: (grp: GroupInfo) => void;
  notify: (text: string, isError?: boolean) => void;
}

const DRAFT_INTENTS = [
  { label: "智能起草", hint: "" },
  { label: "确认收到", hint: "简短自然地表示同意或已收到确认" },
  { label: "同步进展", hint: "针对讨论的事项简短同步我这边的进展" },
  { label: "礼貌婉拒", hint: "温和礼貌地婉拒对方的请求或邀约" },
  { label: "稍后回复", hint: "告知对方已收到，稍后查看并详细回复" },
];

function renderBodyWithMentions(text: string) {
  const parts = text.split(/(@[^\s@，。！？,.!?:：;；()（）]{1,24})/g);
  return parts.map((part, i) =>
    part.startsWith("@") && part.length > 1 ? (
      <span key={i} className="mention-token">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function ChatView({ conv, status, messages, onSent, onChanged, onGroupUpdated, notify }: Props) {
  const [text, setText] = useState("");
  const [customSubject, setCustomSubject] = useState("");
  const [showSubjectInput, setShowSubjectInput] = useState(false);
  const [showDraftMenu, setShowDraftMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [showGroupDrawer, setShowGroupDrawer] = useState(false);
  const [editName, setEditName] = useState(conv.name);
  const [editMembers, setEditMembers] = useState<GroupMember[]>(conv.members);
  const [editMuted, setEditMuted] = useState(conv.muted);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conv.peer]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const maxPx = 152;
    const contentH = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(24, contentH), maxPx)}px`;
    el.style.overflowY = contentH > maxPx ? "auto" : "hidden";
  }, [text, conv.peer]);

  useEffect(() => {
    setText("");
    setCustomSubject("");
    setShowSubjectInput(!conv.is_group && conv.count === 0);
    setShowDraftMenu(false);
    setAiSummary(null);
    setShowGroupDrawer(false);
  }, [conv.peer]);

  useEffect(() => {
    setEditName(conv.name);
    setEditMembers(conv.members);
    setEditMuted(conv.muted);
  }, [conv.peer, conv.name, conv.members, conv.muted]);

  const insertMention = (label: string) => {
    const clean = label.trim();
    if (!clean) return;
    const token = `@${clean} `;
    setText((prev) => (prev.includes(`@${clean}`) ? prev : prev ? `${prev.trimEnd()} ${token}` : token));
    inputRef.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const m = await api.sendMessage(conv.peer, body, showSubjectInput ? customSubject : undefined);
      setText("");
      setCustomSubject("");
      setShowSubjectInput(false);
      onSent(m);
    } catch (e) {
      notify(`发送失败：${e}`, true);
    } finally {
      setSending(false);
    }
  };

  const draft = async (hint?: string) => {
    setShowDraftMenu(false);
    setDrafting(true);
    try {
      setText(await api.draftReply(conv.peer, hint));
      inputRef.current?.focus();
    } catch (e) {
      notify(`起草失败：${e}`, true);
    } finally {
      setDrafting(false);
    }
  };

  const runSummary = async () => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      setAiSummary(await api.summarizeConversation(conv.peer, conv.name));
    } catch (e) {
      notify(`总结失败：${e}`, true);
    } finally {
      setSummarizing(false);
    }
  };

  const addMemberToDraft = () => {
    const email = newMemberEmail.trim().toLowerCase();
    if (!email.includes("@")) {
      notify("请输入格式正确的成员邮箱", true);
      return;
    }
    if (editMembers.some((m) => m.email === email)) {
      notify("该成员已在群聊中");
      return;
    }
    setEditMembers((prev) => [...prev, { email, name: newMemberName.trim() }]);
    setNewMemberEmail("");
    setNewMemberName("");
  };

  const saveGroupSettings = async () => {
    const nextMembers = [...editMembers];
    if (newMemberEmail.trim().includes("@")) {
      const em = newMemberEmail.trim().toLowerCase();
      if (!nextMembers.some((m) => m.email === em)) {
        nextMembers.push({ email: em, name: newMemberName.trim() });
      }
    }
    if (nextMembers.length === 0) {
      notify("群聊至少需要保留 1 位成员", true);
      return;
    }
    setSavingGroup(true);
    try {
      const updated = await api.updateGroup(conv.peer, editName, nextMembers, editMuted);
      setNewMemberEmail("");
      setNewMemberName("");
      notify("群聊声明配置已更新");
      onGroupUpdated(updated);
    } catch (e) {
      notify(`保存失败：${e}`, true);
    } finally {
      setSavingGroup(false);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      notify(`已复制验证码：${code}`);
    } catch {
      notify(`验证码：${code}`);
    }
  };

  const act = async (fn: () => Promise<void>, msg: string) => {
    try {
      await fn();
      notify(msg);
      onChanged();
    } catch (e) {
      notify(String(e), true);
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const latestSuggested = [...messages]
    .reverse()
    .find((m) => !m.outgoing && m.suggested_reply.trim() !== "")?.suggested_reply;

  const groupMemberSummary = conv.is_group
    ? ["我", ...conv.members.map((m) => m.name || m.email.split("@")[0])].join("、")
    : conv.peer;

  const cleanTitle = conv.name.replace(/^🚀\s*/, "");

  let lastDay = "";
  let lastSubject = "";

  const drawerOpen = conv.is_group && showGroupDrawer;

  return (
    <section className="chat-workspace">
      <div className="chat">
        <header
          className="chat-head"
          onMouseDown={startWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        >
          {conv.is_group ? (
            <GroupAvatar members={conv.members} seed={conv.peer} size={38} />
          ) : (
            <Avatar name={cleanTitle} seed={conv.peer} size={38} />
          )}
          <div className="chat-title">
            <div className="chat-name">
              <span>
                {cleanTitle}
                {conv.is_group ? ` (${conv.members.length + 1})` : ""}
              </span>
              {conv.muted && (
                <span className="soft-chip muted">
                  <IconMute size={11} />
                  免打扰
                </span>
              )}
              {conv.category && <span className="soft-chip">{conv.category}</span>}
            </div>
            <div className="chat-sub" title={groupMemberSummary}>
              {conv.is_group ? `全员邮件互通 · ${groupMemberSummary}` : conv.peer}
            </div>
          </div>

          <div className="chat-actions">
            {messages.length >= 2 && (
              <button type="button" className="soft-btn" onClick={runSummary} disabled={summarizing}>
                <IconNote size={14} />
                <span>{summarizing ? "提炼中…" : "纪要总结"}</span>
              </button>
            )}

            {conv.is_group ? (
              <button
                type="button"
                className={`soft-btn ${showGroupDrawer ? "active-soft" : ""}`}
                onClick={() => setShowGroupDrawer((v) => !v)}
              >
                <IconUsers size={14} />
                <span>群信息</span>
              </button>
            ) : (
              <>
                {status === "inbox" && conv.count > 0 && (
                  <>
                    <button
                      type="button"
                      className="soft-btn"
                      onClick={() => act(() => api.moveConversation(conv.peer, "archived"), "已折叠至通知")}
                    >
                      <IconBell size={14} />
                      <span>归入通知</span>
                    </button>
                    <button
                      type="button"
                      className="ghost-btn danger-text"
                      onClick={() => act(() => api.blockSender(conv.peer), "已拦截该发件人")}
                    >
                      <IconShield size={14} />
                      <span>屏蔽</span>
                    </button>
                  </>
                )}
                {status === "archived" && (
                  <>
                    <button
                      type="button"
                      className="soft-btn"
                      onClick={() => act(() => api.moveConversation(conv.peer, "inbox"), "已移回消息列表")}
                    >
                      <span>移回消息</span>
                    </button>
                    <button
                      type="button"
                      className="ghost-btn danger-text"
                      onClick={() => act(() => api.blockSender(conv.peer), "已拦截该发件人")}
                    >
                      <IconShield size={14} />
                      <span>屏蔽</span>
                    </button>
                  </>
                )}
                {status === "blocked" && (
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => act(() => api.allowSender(conv.peer), "已恢复并加入白名单")}
                  >
                    <IconCheck size={14} />
                    <span>恢复并信任</span>
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        {aiSummary && (
          <div className="summary-banner">
            <div className="summary-banner-head">
              <span className="summary-banner-title">
                <IconSparkles size={14} />
                {conv.is_group ? "群聊纪要提炼" : "对话要点提炼"}
              </span>
              <button type="button" className="tool-btn small" onClick={() => setAiSummary(null)}>
                <IconClose size={13} />
              </button>
            </div>
            <div className="summary-banner-body">
              <MarkdownText content={aiSummary} />
            </div>
          </div>
        )}

        <div className="chat-body">
          {messages.length === 0 && (
            <div className="day-sep">
              <span>
                {conv.is_group
                  ? `发出的消息将通过标准多收件人邮件同步给全部 ${conv.members.length} 位群成员`
                  : `向 ${conv.peer} 发送第一封聊天式邮件`}
              </span>
            </div>
          )}

          {messages.map((m) => {
            const day = dayLabel(m.date);
            const showDay = day !== lastDay;
            lastDay = day;
            const subj = m.subject.replace(/^((re|fwd?|回复|转发)\s*[:：]\s*)+/i, "").trim();
            const showSubject = subj !== "" && subj !== lastSubject && (!conv.is_group || subj !== cleanTitle);
            lastSubject = subj;
            const isExpanded = expanded.has(m.id);
            const hasMore = m.body_full.trim() !== m.body.trim();
            const speakerLabel = m.from_name || m.from_addr.split("@")[0] || cleanTitle;

            return (
              <div key={m.id}>
                {showDay && (
                  <div className="day-sep">
                    <span>{day}</span>
                  </div>
                )}
                <div className={`msg-row ${m.outgoing ? "out" : "in"}`}>
                  {!m.outgoing && (
                    <Avatar
                      name={speakerLabel}
                      seed={m.from_addr}
                      size={32}
                      onClick={conv.is_group ? () => insertMention(speakerLabel) : undefined}
                      title={conv.is_group ? `点击 @${speakerLabel}` : m.from_addr}
                    />
                  )}
                  <div className="bubble">
                    {conv.is_group && !m.outgoing && (
                      <div className="bubble-sender">
                        <span
                          className="bubble-sender-name"
                          style={{ color: senderColor(m.from_addr) }}
                          onClick={() => insertMention(speakerLabel)}
                          title="点击 @TA"
                        >
                          {speakerLabel}
                        </span>
                        <span className="bubble-sender-email">{m.from_addr}</span>
                      </div>
                    )}

                    {showSubject && <div className="bubble-subject">{subj}</div>}

                    {m.extracted_code && (
                      <div className="code-banner">
                        <span className="code-banner-left">
                          <IconKey size={13} />
                          <span>验证码</span>
                          <b>{m.extracted_code}</b>
                        </span>
                        <button type="button" className="copy-btn" onClick={() => copyCode(m.extracted_code)}>
                          <IconCopy size={12} />
                          <span>复制</span>
                        </button>
                      </div>
                    )}

                    <div className="bubble-text">{renderBodyWithMentions(isExpanded ? m.body_full : m.body)}</div>

                    {!m.outgoing && m.summary && (
                      <div className="agent-note" title={m.reason || undefined}>
                        <IconSparkles size={11} />
                        <span>{m.summary}</span>
                      </div>
                    )}

                    {(status !== "inbox" || m.reason.includes("@提及")) && m.reason && (
                      <div className="bubble-reason">{m.reason}</div>
                    )}

                    <div className="bubble-meta">
                      {hasMore && (
                        <button type="button" className="text-link" onClick={() => toggle(m.id)}>
                          {isExpanded ? "收起引用" : "展开原文"}
                        </button>
                      )}
                      {status !== "inbox" && !m.outgoing && !conv.is_group && (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => act(() => api.setMessageStatus(m.id, "inbox"), "已移回消息")}
                        >
                          移回消息
                        </button>
                      )}
                      <span className="bubble-time">{clockTime(m.date)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {status !== "blocked" && (
          <div className="composer-shell">
            {latestSuggested && !text && (
              <div className="suggest-bar" onClick={() => setText(latestSuggested)}>
                <IconSparkles size={13} />
                <span className="suggest-text">建议回复：{latestSuggested}</span>
                <span className="suggest-fill">点击填入</span>
              </div>
            )}

            {conv.is_group && conv.members.length > 0 && (
              <div className="mention-bar">
                <button type="button" className="mention-pill" onClick={() => insertMention("所有人")}>
                  @所有人
                </button>
                {conv.members.map((m) => {
                  const label = m.name || m.email.split("@")[0];
                  return (
                    <button
                      key={m.email}
                      type="button"
                      className="mention-pill"
                      onClick={() => insertMention(label)}
                      title={m.email}
                    >
                      @{label}
                    </button>
                  );
                })}
              </div>
            )}

            {showDraftMenu && messages.length > 0 && (
              <div className="draft-menu">
                {DRAFT_INTENTS.map((item) => (
                  <button key={item.label} type="button" onClick={() => draft(item.hint)} disabled={drafting}>
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            {showSubjectInput && (
              <div className="subject-bar">
                <span>邮件主题</span>
                <input
                  className="grow"
                  placeholder={conv.is_group ? `默认沿用「${cleanTitle}」` : "留空则自动沿用会话主题"}
                  value={customSubject}
                  onChange={(e) => setCustomSubject(e.target.value)}
                />
              </div>
            )}

            <footer className="composer-box">
              <div className="composer-tools">
                {messages.length > 0 && (
                  <button
                    type="button"
                    className={`tool-btn ${showDraftMenu ? "active" : ""}`}
                    onClick={() => setShowDraftMenu((v) => !v)}
                    disabled={drafting}
                    title="AI 辅助起草回复"
                  >
                    <span className={drafting ? "spin" : ""}>
                      <IconSparkles size={16} />
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className={`tool-btn ${showSubjectInput ? "active" : ""}`}
                  onClick={() => setShowSubjectInput((v) => !v)}
                  title="自定义本封邮件主题"
                >
                  <IconTag size={15} />
                </button>
              </div>

              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                placeholder={
                  conv.is_group
                    ? `全员回复 ${conv.members.length} 位群成员，Enter 发送`
                    : "输入消息，Enter 发送，Shift+Enter 换行"
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />

              <button
                type="button"
                className={`composer-send-btn ${!sending && text.trim() ? "ready" : ""}`}
                onClick={send}
                disabled={sending || !text.trim()}
                title="发送 (Enter)"
              >
                <IconSend size={15} />
              </button>
            </footer>
          </div>
        )}
      </div>

      {drawerOpen && (
        <aside className="group-drawer">
          <div
            className="drawer-head"
            onMouseDown={startWindowDrag}
            onDoubleClick={toggleWindowMaximize}
          >
            <span>群聊设置</span>
            <button type="button" className="tool-btn small" onClick={() => setShowGroupDrawer(false)}>
              <IconClose size={14} />
            </button>
          </div>

          <div className="drawer-body">
            <div className="protocol-note">
              基于标准多收件人 SMTP 与 <code>Chat-Group-ID</code> 线程互通，外部邮箱成员点击「全部回复」即可直接参与。
            </div>

            <label className="drawer-field">
              <span>群聊名称</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="输入群聊名称" />
            </label>

            <label className="drawer-switch">
              <input type="checkbox" checked={editMuted} onChange={(e) => setEditMuted(e.target.checked)} />
              <div>
                <div className="drawer-switch-title">消息免打扰</div>
                <div className="drawer-switch-desc">日常群消息折叠进「通知」，正文 @你 时穿透提醒</div>
              </div>
            </label>

            <div className="drawer-section">
              <div className="drawer-section-title">群成员 ({editMembers.length + 1})</div>
              <div className="member-list">
                <div className="member-item">
                  <Avatar name="我" seed="me" size={28} />
                  <div className="member-info">
                    <div className="member-name">我（当前账号）</div>
                    <div className="member-email">发信人与参与者</div>
                  </div>
                </div>
                {editMembers.map((m) => (
                  <div key={m.email} className="member-item">
                    <Avatar name={m.name || m.email} seed={m.email} size={28} />
                    <div className="member-info">
                      <div className="member-name">{m.name || m.email.split("@")[0]}</div>
                      <div className="member-email">{m.email}</div>
                    </div>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => insertMention(m.name || m.email.split("@")[0])}
                    >
                      @TA
                    </button>
                    {editMembers.length > 1 && (
                      <button
                        type="button"
                        className="text-link danger-text"
                        onClick={() => setEditMembers((prev) => prev.filter((x) => x.email !== m.email))}
                      >
                        移除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="drawer-section">
              <div className="drawer-section-title">邀请新邮箱入群</div>
              <input
                placeholder="成员邮箱"
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMemberToDraft();
                  }
                }}
              />
              <div className="row">
                <input
                  className="grow"
                  placeholder="备注昵称（可选）"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addMemberToDraft();
                    }
                  }}
                />
                <button type="button" className="soft-btn" onClick={addMemberToDraft} disabled={!newMemberEmail.trim()}>
                  添加
                </button>
              </div>
            </div>

            <button type="button" className="primary-btn" onClick={saveGroupSettings} disabled={savingGroup}>
              {savingGroup ? "保存中…" : "保存群设置"}
            </button>
          </div>
        </aside>
      )}
    </section>
  );
}
