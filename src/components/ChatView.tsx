import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type { Conversation, GroupInfo, GroupMember, Message, Status } from "../types";
import { Avatar, clockTime, dayLabel, GroupAvatar, senderColor } from "../util";
import {
  AttachmentLightbox,
  BubbleAttachments,
  DrawerAttachmentList,
  filesToPendingAttachments,
  type LightboxItem,
  PendingAttachmentsBar,
  type PendingAttachmentItem,
} from "./AttachmentItems";
import { ContactDrawer } from "./ContactDrawer";
import { hasHtmlBody, HtmlMailView, isRichHtmlEmail } from "./HtmlMailView";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconClose,
  IconCopy,
  IconDraft,
  IconImage,
  IconMore,
  IconMute,
  IconNote,
  IconOtp,
  IconPaperclip,
  IconReply,
  IconSearch,
  IconSend,
  IconSparkles,
  IconTag,
  IconUsers,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { analyzeMessageBody, highlightText, MessageContent } from "./MessageContent";
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

function shouldShowAgentSummary(
  m: Message,
  status: Status,
  showingHtml: boolean,
  mainText: string,
): boolean {
  const summary = m.summary.trim();
  if (m.outgoing || !summary) return false;
  // 通知与已屏蔽视图保留一句话摘要，方便快速扫读
  if (status !== "inbox") return true;
  const cleanMain = mainText.trim();
  // 日常聊天短消息（<= 140 字）绝不展示冗余的 AI 复读框（例如“具体什么情况”）
  if (!showingHtml && cleanMain.length <= 140) return false;
  if (cleanMain && summary.includes(cleanMain)) return false;
  if (!showingHtml && cleanMain.length > 0 && cleanMain.length < summary.length * 2.2) {
    return false;
  }
  return true;
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
  const [htmlOverrides, setHtmlOverrides] = useState<Map<number, boolean>>(new Map());

  // 附件与图片预览
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);

  // 引用回复与消息定位闪烁
  const [replyTarget, setReplyTarget] = useState<{
    id: number;
    sender: string;
    snippet: string;
  } | null>(null);
  const [flashMsgId, setFlashMsgId] = useState<number | null>(null);

  // 会话内搜索
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilterOnly, setSearchFilterOnly] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  // 右侧抽屉：单聊联系人详情 / 群聊设置
  const [showDetailDrawer, setShowDetailDrawer] = useState(false);
  const [showGroupDrawer, setShowGroupDrawer] = useState(false);
  const [editName, setEditName] = useState(conv.name);
  const [editMembers, setEditMembers] = useState<GroupMember[]>(conv.members);
  const [editMuted, setEditMuted] = useState(conv.muted);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const flashTimerRef = useRef<number | null>(null);

  const cleanTitle = conv.name.replace(/^🚀\s*/, "");
  const trimmedSearch = showSearchBar ? searchQuery.trim() : "";

  const matchedIds = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    if (!q) return [];
    return messages
      .filter((m) => {
        if (m.body.toLowerCase().includes(q)) return true;
        if (m.subject.toLowerCase().includes(q)) return true;
        if (m.summary.toLowerCase().includes(q)) return true;
        if (m.extracted_code.toLowerCase().includes(q)) return true;
        if (m.from_name.toLowerCase().includes(q) || m.from_addr.toLowerCase().includes(q)) return true;
        if (m.reply_to?.snippet.toLowerCase().includes(q)) return true;
        if ((m.attachments ?? []).some((a) => a.filename.toLowerCase().includes(q))) return true;
        return false;
      })
      .map((m) => m.id);
  }, [messages, trimmedSearch]);

  const matchedIdSet = useMemo(() => new Set(matchedIds), [matchedIds]);
  const activeMatchMsgId =
    matchedIds.length > 0
      ? matchedIds[Math.min(activeMatchIdx, matchedIds.length - 1)]
      : null;

  useEffect(() => {
    if (matchedIds.length > 0) {
      setActiveMatchIdx(matchedIds.length - 1);
    } else {
      setActiveMatchIdx(0);
    }
  }, [trimmedSearch, matchedIds.length]);

  useEffect(() => {
    if (!activeMatchMsgId || !trimmedSearch) return;
    const el = document.getElementById(`msg-${activeMatchMsgId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeMatchMsgId, trimmedSearch, searchFilterOnly]);

  const openSearchBar = useCallback(() => {
    setShowSearchBar(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 20);
  }, []);

  const closeSearchBar = useCallback(() => {
    setShowSearchBar(false);
    setSearchQuery("");
    setSearchFilterOnly(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearchBar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearchBar]);

  useEffect(() => {
    if (trimmedSearch) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conv.peer, trimmedSearch]);

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
    setPendingAttachments([]);
    setReplyTarget(null);
    setDragOver(false);
    setShowGroupDrawer(false);
    setShowDetailDrawer(false);
    setShowSearchBar(false);
    setSearchQuery("");
    setSearchFilterOnly(false);
  }, [conv.peer]);

  useEffect(() => {
    setEditName(conv.name);
    setEditMembers(conv.members);
    setEditMuted(conv.muted);
  }, [conv.peer, conv.name, conv.members, conv.muted]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const stepSearchMatch = (delta: number) => {
    if (matchedIds.length === 0) return;
    setActiveMatchIdx((prev) => (prev + delta + matchedIds.length) % matchedIds.length);
  };

  const jumpToMessage = (targetId: number) => {
    const exists = messages.some((m) => m.id === targetId);
    if (!exists) {
      notify("原引用消息不在当前会话视图中");
      return;
    }
    if (searchFilterOnly && !matchedIdSet.has(targetId)) {
      setSearchFilterOnly(false);
    }
    window.setTimeout(() => {
      const el = document.getElementById(`msg-${targetId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashMsgId(targetId);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashMsgId(null), 1600);
    }, 30);
  };

  const startReplyTo = (m: Message) => {
    const sender = m.outgoing
      ? "我"
      : (!conv.is_group ? cleanTitle : "") ||
        m.from_name ||
        m.from_addr.split("@")[0] ||
        m.from_addr;
    const rawBody = m.body.replace(/\s+/g, " ").trim();
    const atts = m.attachments ?? [];
    let snippet = rawBody.slice(0, 68);
    if (!snippet) {
      if (atts.length > 0) {
        snippet = atts.every((a) => a.is_image) ? "[图片]" : `[文件] ${atts[0].filename}`;
      } else {
        snippet = m.subject || "(无文字内容)";
      }
    }
    setReplyTarget({ id: m.id, sender, snippet });
    inputRef.current?.focus();
  };

  const appendFiles = async (files: FileList | File[]) => {
    const { items: accepted, errors } = await filesToPendingAttachments(files);
    for (const errMsg of errors) {
      notify(errMsg, true);
    }
    if (accepted.length > 0) {
      setPendingAttachments((prev) => {
        const combined = [...prev, ...accepted];
        if (combined.length > 12) {
          notify("单次最多添加 12 个附件，超出部分已忽略");
          return combined.slice(0, 12);
        }
        return combined;
      });
      inputRef.current?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const fileItems = items
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (fileItems.length > 0) {
      e.preventDefault();
      void appendFiles(fileItems);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (status === "blocked") return;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (status === "blocked") return;
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void appendFiles(e.dataTransfer.files);
    }
  };

  const insertMention = (label: string) => {
    const clean = label.trim();
    if (!clean) return;
    const token = `@${clean} `;
    setText((prev) => (prev.includes(`@${clean}`) ? prev : prev ? `${prev.trimEnd()} ${token}` : token));
    inputRef.current?.focus();
  };

  const canSend = !sending && (text.trim().length > 0 || pendingAttachments.length > 0);

  const send = async () => {
    const body = text.trim();
    if ((!body && pendingAttachments.length === 0) || sending) return;
    setSending(true);
    try {
      const attPayload = pendingAttachments.map((a) => ({
        filename: a.filename,
        mime: a.mime,
        data_base64: a.dataBase64,
      }));
      const m = await api.sendMessage(
        conv.peer,
        body,
        showSubjectInput ? customSubject : undefined,
        attPayload,
        replyTarget?.id ?? null,
      );
      setText("");
      setCustomSubject("");
      setShowSubjectInput(false);
      setPendingAttachments([]);
      setReplyTarget(null);
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
      setAiSummary(await api.summarizeConversation(conv.peer, cleanTitle));
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

  const toggleHtmlMode = (id: number, currentShowingHtml: boolean) =>
    setHtmlOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, !currentShowingHtml);
      return next;
    });

  const toggleHeaderDrawer = () => {
    if (conv.is_group) {
      setShowGroupDrawer((v) => !v);
    } else {
      setShowDetailDrawer((v) => !v);
    }
  };

  const latestSuggested = [...messages]
    .reverse()
    .find((m) => !m.outgoing && m.suggested_reply.trim() !== "")?.suggested_reply;

  const groupMemberSummary = conv.is_group
    ? ["我", ...conv.members.map((m) => m.name || m.email.split("@")[0])].join("、")
    : conv.peer;

  const directSubtitle = !conv.is_group
    ? [
        conv.peer,
        conv.raw_name && conv.raw_name !== cleanTitle ? `原名 ${conv.raw_name}` : "",
        conv.note ? conv.note : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const visibleMessages =
    searchFilterOnly && trimmedSearch
      ? messages.filter((m) => matchedIdSet.has(m.id))
      : messages;

  let lastDay = "";
  let lastSubject = "";

  const groupDrawerOpen = conv.is_group && showGroupDrawer;
  const contactDrawerOpen = !conv.is_group && showDetailDrawer;

  return (
    <section className="chat-workspace">
      <div
        className={`chat${dragOver ? " chat-drag-active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="chat-drop-overlay">
            <div className="chat-drop-card">
              <IconPaperclip size={22} />
              <span>松开鼠标添加图片或文件附件</span>
            </div>
          </div>
        )}

        <header
          className="chat-head"
          onMouseDown={startWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        >
          <button
            type="button"
            className="chat-identity-trigger"
            data-no-drag="true"
            onClick={toggleHeaderDrawer}
            title={conv.is_group ? "点击查看与编辑群聊信息" : "点击查看联系人详情、修改备注与管理会话"}
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
              <div className="chat-sub" title={conv.is_group ? groupMemberSummary : directSubtitle}>
                {conv.is_group ? `全员邮件互通 · ${groupMemberSummary}` : directSubtitle}
              </div>
            </div>
          </button>

          <div className="chat-actions">
            {messages.length > 0 && (
              <button
                type="button"
                className={`tool-btn ${showSearchBar ? "active" : ""}`}
                onClick={() => (showSearchBar ? closeSearchBar() : openSearchBar())}
                title="搜索当前对话内容 (Ctrl+F)"
              >
                <IconSearch size={15} />
              </button>
            )}

            {messages.length >= 2 && (
              <button type="button" className="soft-btn" onClick={runSummary} disabled={summarizing}>
                <IconNote size={14} />
                <span>{summarizing ? "提炼中…" : "纪要总结"}</span>
              </button>
            )}

            {status === "blocked" && !conv.is_group && (
              <button
                type="button"
                className="primary-btn"
                onClick={() => act(() => api.allowSender(conv.peer), "已恢复并加入白名单")}
              >
                <IconCheck size={14} />
                <span>恢复并信任</span>
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
              <button
                type="button"
                className={`soft-btn ${showDetailDrawer ? "active-soft" : ""}`}
                onClick={() => setShowDetailDrawer((v) => !v)}
                title="查看详情、修改备注及更多操作"
              >
                <IconMore size={15} />
                <span>详情</span>
              </button>
            )}
          </div>
        </header>

        {showSearchBar && (
          <div className="chat-search-bar">
            <IconSearch size={14} className="chat-search-icon" />
            <input
              ref={searchInputRef}
              className="chat-search-input"
              placeholder={`搜索与「${cleanTitle}」的聊天内容、文件名…`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearchBar();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  stepSearchMatch(e.shiftKey ? -1 : 1);
                }
              }}
            />
            {trimmedSearch && (
              <span className="chat-search-count">
                {matchedIds.length > 0 ? `${activeMatchIdx + 1} / ${matchedIds.length}` : "无匹配"}
              </span>
            )}
            {trimmedSearch && matchedIds.length > 0 && (
              <>
                <button
                  type="button"
                  className={`chat-search-filter ${searchFilterOnly ? "active" : ""}`}
                  onClick={() => setSearchFilterOnly((v) => !v)}
                  title="仅展示包含关键词的消息"
                >
                  仅看匹配
                </button>
                <button
                  type="button"
                  className="tool-btn small"
                  onClick={() => stepSearchMatch(-1)}
                  title="上一处 (Shift+Enter)"
                >
                  <IconArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="tool-btn small"
                  onClick={() => stepSearchMatch(1)}
                  title="下一处 (Enter)"
                >
                  <IconArrowDown size={13} />
                </button>
              </>
            )}
            <button
              type="button"
              className="tool-btn small"
              onClick={closeSearchBar}
              title="关闭搜索 (Esc)"
            >
              <IconClose size={13} />
            </button>
          </div>
        )}

        {aiSummary && (
          <div className="summary-banner">
            <div className="summary-banner-head">
              <span className="summary-banner-title">
                <IconNote size={14} />
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

          {messages.length > 0 && visibleMessages.length === 0 && trimmedSearch && (
            <div className="day-sep">
              <span>未找到包含「{trimmedSearch}」的消息</span>
            </div>
          )}

          {visibleMessages.map((m) => {
            const day = dayLabel(m.date);
            const showDay = day !== lastDay;
            lastDay = day;
            const subj = m.subject.replace(/^((re|fwd?|回复|转发)\s*[:：]\s*)+/i, "").trim();
            const isDefaultChatSubj = /^来自\s+.+\s+的消息$/.test(subj);
            const showSubject =
              subj !== "" &&
              !isDefaultChatSubj &&
              subj !== lastSubject &&
              (!conv.is_group || subj !== cleanTitle);
            if (subj !== "") lastSubject = subj;
            const isExpanded = expanded.has(m.id);
            const canShowHtml = hasHtmlBody(m.body_html);
            const defaultHtml = canShowHtml && isRichHtmlEmail(m.body_html, m.outgoing);
            const showingHtml = canShowHtml ? (htmlOverrides.get(m.id) ?? defaultHtml) : false;
            const analyzed = analyzeMessageBody(m.body, m.body_full);
            const speakerLabel = !conv.is_group && !m.outgoing
              ? cleanTitle
              : m.from_name || m.from_addr.split("@")[0] || cleanTitle;
            const atts = m.attachments ?? [];
            const hasTextContent =
              showingHtml || analyzed.main.trim().length > 0 || analyzed.hasExpandable;
            const showSummary = shouldShowAgentSummary(m, status, showingHtml, analyzed.main);
            const isActiveMatch = activeMatchMsgId === m.id && Boolean(trimmedSearch);
            const isJumpFlashing = flashMsgId === m.id;

            return (
              <div key={m.id} id={`msg-${m.id}`}>
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
                      onClick={
                        conv.is_group
                          ? () => insertMention(speakerLabel)
                          : () => setShowDetailDrawer(true)
                      }
                      title={conv.is_group ? `点击 @${speakerLabel}` : "点击查看联系人详情"}
                    />
                  )}
                  <div
                    className={[
                      "bubble",
                      showingHtml ? "bubble-html" : "",
                      isActiveMatch ? "bubble-search-active" : "",
                      isJumpFlashing ? "bubble-jump-flash" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
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

                    {showSubject && (
                      <div className="bubble-subject">
                        {trimmedSearch ? highlightText(subj, trimmedSearch) : subj}
                      </div>
                    )}

                    {m.reply_to && (
                      <button
                        type="button"
                        className="bubble-reply-quote"
                        onClick={() => jumpToMessage(m.reply_to!.id)}
                        title="点击定位到被引用的消息"
                      >
                        <span className="bubble-reply-sender">{m.reply_to.sender}</span>
                        <span className="bubble-reply-snippet">
                          {trimmedSearch
                            ? highlightText(m.reply_to.snippet, trimmedSearch)
                            : m.reply_to.snippet}
                        </span>
                      </button>
                    )}

                    {m.extracted_code && (
                      <div className="code-banner">
                        <span className="code-banner-left">
                          <IconOtp size={14} />
                          <span>验证码</span>
                          <b>{m.extracted_code}</b>
                        </span>
                        <button type="button" className="copy-btn" onClick={() => copyCode(m.extracted_code)}>
                          <IconCopy size={12} />
                          <span>复制</span>
                        </button>
                      </div>
                    )}

                    {hasTextContent && (
                      <div className="bubble-text">
                        {showingHtml ? (
                          <HtmlMailView html={m.body_html} status={status} />
                        ) : (
                          <MessageContent
                            analyzed={analyzed}
                            expanded={isExpanded}
                            status={status}
                            highlightQuery={trimmedSearch || undefined}
                          />
                        )}
                      </div>
                    )}

                    {atts.length > 0 && (
                      <BubbleAttachments
                        attachments={atts}
                        outgoing={m.outgoing}
                        highlightQuery={trimmedSearch || undefined}
                        onPreviewImage={(att, dataUrl) =>
                          setLightbox({
                            src: dataUrl,
                            title: att.filename,
                            size: att.size,
                            relPath: att.rel_path,
                          })
                        }
                        notify={notify}
                      />
                    )}

                    {showSummary && (
                      <div className="agent-note" title={m.reason || undefined}>
                        <IconSparkles size={11} />
                        <span>
                          {trimmedSearch ? highlightText(m.summary, trimmedSearch) : m.summary}
                        </span>
                      </div>
                    )}

                    {(status !== "inbox" || m.reason.includes("@提及")) && m.reason && (
                      <div className="bubble-reason">{m.reason}</div>
                    )}

                    <div className="bubble-meta">
                      {status !== "blocked" && (
                        <button
                          type="button"
                          className="text-link quote-action-btn"
                          onClick={() => startReplyTo(m)}
                          title="引用此条消息回复"
                        >
                          <IconReply size={11} />
                          <span>引用</span>
                        </button>
                      )}
                      {!showingHtml && analyzed.hasExpandable && (
                        <button type="button" className="text-link" onClick={() => toggle(m.id)}>
                          {isExpanded ? analyzed.collapseLabel : analyzed.expandLabel}
                        </button>
                      )}
                      {canShowHtml && (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => toggleHtmlMode(m.id, showingHtml)}
                        >
                          {showingHtml ? "精简文本" : "网页视图"}
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
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void appendFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void appendFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {latestSuggested && !text && !replyTarget && pendingAttachments.length === 0 && (
              <div className="suggest-bar" onClick={() => setText(latestSuggested)}>
                <IconDraft size={13} />
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

            {replyTarget && (
              <div className="reply-quote-bar">
                <IconReply size={13} className="reply-quote-icon" />
                <div
                  className="reply-quote-body"
                  onClick={() => jumpToMessage(replyTarget.id)}
                  title="点击查看原消息"
                >
                  <span className="reply-quote-sender">引用 {replyTarget.sender}：</span>
                  <span className="reply-quote-snippet">{replyTarget.snippet}</span>
                </div>
                <button
                  type="button"
                  className="tool-btn small"
                  onClick={() => setReplyTarget(null)}
                  title="取消引用 (Esc)"
                >
                  <IconClose size={12} />
                </button>
              </div>
            )}

            <PendingAttachmentsBar
              items={pendingAttachments}
              onRemove={(id) => setPendingAttachments((prev) => prev.filter((x) => x.id !== id))}
              onClear={() => setPendingAttachments([])}
              onPreviewImage={(item) => setLightbox(item)}
            />

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
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() => imageInputRef.current?.click()}
                  title="发送图片（支持 Ctrl+V 粘贴截图或拖拽）"
                >
                  <IconImage size={16} />
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="发送文件附件（支持拖拽添加）"
                >
                  <IconPaperclip size={15} />
                </button>
                {messages.length > 0 && (
                  <button
                    type="button"
                    className={`tool-btn ${showDraftMenu ? "active" : ""}`}
                    onClick={() => setShowDraftMenu((v) => !v)}
                    disabled={drafting}
                    title="AI 辅助起草回复"
                  >
                    <span className={drafting ? "spin" : ""}>
                      <IconDraft size={16} />
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
                    ? `全员回复 ${conv.members.length} 位群成员，支持粘贴图片或拖拽文件`
                    : "输入消息，Enter 发送，支持 Ctrl+V 粘贴图片或拖拽文件"
                }
                onChange={(e) => setText(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && replyTarget) {
                    e.preventDefault();
                    setReplyTarget(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />

              <button
                type="button"
                className={`composer-send-btn ${canSend ? "ready" : ""}`}
                onClick={() => void send()}
                disabled={!canSend}
                title="发送 (Enter)"
              >
                <IconSend size={15} />
              </button>
            </footer>
          </div>
        )}
      </div>

      {contactDrawerOpen && (
        <ContactDrawer
          conv={conv}
          status={status}
          messages={messages}
          onClose={() => setShowDetailDrawer(false)}
          onSaved={onChanged}
          onChanged={onChanged}
          onOpenSearch={openSearchBar}
          onRunSummary={() => void runSummary()}
          summarizing={summarizing}
          onPreviewImage={(att, dataUrl) =>
            setLightbox({
              src: dataUrl,
              title: att.filename,
              size: att.size,
              relPath: att.rel_path,
            })
          }
          notify={notify}
        />
      )}

      {groupDrawerOpen && (
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

            <div className="drawer-section">
              <div className="drawer-section-title">群内图片与文件</div>
              <DrawerAttachmentList
                messages={messages}
                onPreviewImage={(att, dataUrl) =>
                  setLightbox({
                    src: dataUrl,
                    title: att.filename,
                    size: att.size,
                    relPath: att.rel_path,
                  })
                }
                notify={notify}
              />
            </div>
          </div>
        </aside>
      )}

      <AttachmentLightbox item={lightbox} onClose={() => setLightbox(null)} notify={notify} />
    </section>
  );
}
