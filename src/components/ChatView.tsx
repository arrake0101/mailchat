import {
  type ClipboardEvent,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type {
  ComposeLaunchIntent,
  Conversation,
  GroupInfo,
  GroupMember,
  Message,
  Status,
} from "../types";
import { Avatar, clockTime, copyText, dayLabel, GroupAvatar, senderColor } from "../util";
import {
  AttachmentLightbox,
  BubbleAttachments,
  cacheSentMessageImagePreviews,
  DrawerAttachmentList,
  filesToPendingAttachments,
  type LightboxItem,
  PendingAttachmentsBar,
  type PendingAttachmentItem,
} from "./AttachmentItems";
import { ContactDrawer } from "./ContactDrawer";
import { type ContextMenuEntry, useContextMenu } from "./ContextMenu";
import { hasHtmlBody, HtmlMailView, type HtmlMailContextInfo, isRichHtmlEmail } from "./HtmlMailView";
import {
  IconAgentDock,
  IconArrowDown,
  IconArrowUp,
  IconAt,
  IconBell,
  IconChat,
  IconCheck,
  IconClose,
  IconCompose,
  IconCopy,
  IconDraft,
  IconEdit,
  IconExternalLink,
  IconFolder,
  IconForward,
  IconMore,
  IconMute,
  IconNote,
  IconOtp,
  IconPaperclip,
  IconPaste,
  IconReply,
  IconScissors,
  IconSearch,
  IconSelectAll,
  IconSend,
  IconShield,
  IconSmile,
  IconSparkles,
  IconTag,
  IconTrash,
  IconUnmute,
  IconUsers,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { analyzeMessageBody, highlightText, MessageContent } from "./MessageContent";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

interface Props {
  conv: Conversation;
  conversations?: Conversation[];
  status: Status;
  messages: Message[];
  initialDraft?: string;
  externalDraftSignal?: { seq: number; text: string } | null;
  openDrawerSeq?: number;
  onDraftChange?: (text: string) => void;
  onStartDirectChat?: (email: string, name?: string) => void;
  onOpenComposeStudio?: (intent: Omit<ComposeLaunchIntent, "id">) => void;
  agentDockOpen?: boolean;
  onToggleAgentDock?: () => void;
  onSent: (m: Message) => void;
  onChanged: () => void;
  onGroupUpdated: (grp: GroupInfo) => void;
  notify: (text: string, isError?: boolean) => void;
}

type ActivePopover = "none" | "emoji" | "draft" | "mention";

const COMPOSER_HEIGHT_STORAGE_KEY = "mailchat.composerHeight";

const COMMON_EMOJIS = [
  "😊", "😄", "😂", "🤣", "😉", "🥰", "🤔", "😅",
  "👍", "👏", "🙏", "🤝", "👌", "💪", "🎉", "❤️",
  "✅", "📌", "🔥", "👀", "💡", "☕", "📄", "🚀",
  "🫡", "🙌", "😭", "😮", "⏳", "📅", "📎", "✨",
];

const DRAFT_INTENTS = [
  { label: "智能起草", desc: "结合上下文自然回复", hint: "" },
  { label: "确认收到", desc: "简短得体地确认知悉", hint: "简短自然地表示同意或已收到确认" },
  { label: "同步进展", desc: "说明当前处理进度", hint: "针对讨论的事项简短同步我这边的进展" },
  { label: "礼貌婉拒", desc: "温和体面地拒绝邀约", hint: "温和礼貌地婉拒对方的请求或邀约" },
  { label: "稍后回复", desc: "告知对方稍后详复", hint: "告知对方已收到，稍后查看并详细回复" },
];

const POLISH_INTENTS = [
  { label: "润色得体", hint: "请将我草拟的这段话润色得更自然、得体（直接输出修改后的正文，不要解释）：" },
  { label: "精简干练", hint: "请将我草拟的这段话精简得更清晰干练，保留核心意思（直接输出修改后的正文）：" },
  { label: "正式商务语气", hint: "请将我草拟的这段话改写为专业礼貌的商务沟通语气（直接输出修改后的正文）：" },
];

function shouldShowAgentSummary(
  m: Message,
  status: Status,
  showingHtml: boolean,
  mainText: string,
): boolean {
  const summary = m.summary.trim();
  if (m.outgoing || !summary) return false;
  if (status !== "inbox") return true;
  const cleanMain = mainText.trim();
  if (!showingHtml && cleanMain.length <= 140) return false;
  if (cleanMain && summary.includes(cleanMain)) return false;
  if (!showingHtml && cleanMain.length > 0 && cleanMain.length < summary.length * 2.2) {
    return false;
  }
  return true;
}

export function ChatView({
  conv,
  conversations = [],
  status,
  messages,
  initialDraft = "",
  externalDraftSignal = null,
  openDrawerSeq = 0,
  onDraftChange,
  onStartDirectChat,
  onOpenComposeStudio,
  agentDockOpen = false,
  onToggleAgentDock,
  onSent,
  onChanged,
  onGroupUpdated,
  notify,
}: Props) {
  const { openContextMenu } = useContextMenu();
  const [text, setTextState] = useState(initialDraft);
  const [customSubject, setCustomSubject] = useState("");
  const [showSubjectInput, setShowSubjectInput] = useState(!conv.is_group && conv.count === 0);
  const [activePopover, setActivePopover] = useState<ActivePopover>("none");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [htmlOverrides, setHtmlOverrides] = useState<Map<number, boolean>>(new Map());
  const [dismissedSuggestMsgId, setDismissedSuggestMsgId] = useState<number | null>(null);

  // 输入框拖拽高度记忆
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= 92 && saved <= 280) return saved;
    } catch {
      // ignore
    }
    return 106;
  });

  // 附件与大图灯箱
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);

  // 引用回复、回到底部提示与气泡右键菜单 / 转发弹窗
  const [replyTarget, setReplyTarget] = useState<{
    id: number;
    sender: string;
    snippet: string;
  } | null>(null);
  const [flashMsgId, setFlashMsgId] = useState<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardManualPeer, setForwardManualPeer] = useState("");
  const [forwarding, setForwarding] = useState(false);

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

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<number | null>(null);

  const setText = useCallback(
    (next: string | ((prev: string) => string)) => {
      setTextState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        onDraftChange?.(resolved);
        return resolved;
      });
    },
    [onDraftChange],
  );

  const handledExternalDraftSeqRef = useRef(0);
  useEffect(() => {
    if (
      !externalDraftSignal ||
      externalDraftSignal.seq <= handledExternalDraftSeqRef.current
    ) {
      return;
    }
    handledExternalDraftSeqRef.current = externalDraftSignal.seq;
    setTextState(externalDraftSignal.text);
    window.setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 30);
  }, [externalDraftSignal]);

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
    setActivePopover("none");
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
      } else if (e.key === "Escape") {
        setActivePopover("none");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearchBar]);

  // 点击浮层外部自动收起表情 / AI 起草 / @提及面板
  useEffect(() => {
    if (activePopover === "none") return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-popover-zone='true']")) {
        setActivePopover("none");
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [activePopover]);

  useEffect(() => {
    if (openDrawerSeq <= 0) return;
    if (conv.is_group) {
      setShowGroupDrawer(true);
    } else {
      setShowDetailDrawer(true);
    }
  }, [openDrawerSeq, conv.is_group]);

  useEffect(() => {
    if (trimmedSearch) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conv.peer, trimmedSearch]);

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

  const handleChatScroll = () => {
    const el = chatBodyRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(dist > 240);
  };

  const scrollToLatest = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const startResizeComposer = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHeight;
    let latestH = startH;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      latestH = Math.max(92, Math.min(280, startH + delta));
      setComposerHeight(latestH);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(Math.round(latestH)));
      } catch {
        // ignore
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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

  const insertAtCursor = (snippet: string) => {
    const el = inputRef.current;
    if (!el) {
      setText((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const insertMention = (label: string) => {
    const clean = label.trim();
    if (!clean) return;
    setActivePopover("none");
    const token = `@${clean} `;
    const el = inputRef.current;
    if (el) {
      const pos = el.selectionStart ?? text.length;
      if (pos > 0 && text[pos - 1] === "@") {
        const next = text.slice(0, pos - 1) + token + text.slice(pos);
        setText(next);
        window.requestAnimationFrame(() => {
          el.focus();
          const newCursor = pos - 1 + token.length;
          el.setSelectionRange(newCursor, newCursor);
        });
        return;
      }
    }
    setText((prev) => (prev.includes(`@${clean}`) ? prev : prev ? `${prev.trimEnd()} ${token}` : token));
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

  const canSend = !sending && (text.trim().length > 0 || pendingAttachments.length > 0);

  const send = async () => {
    const body = text.trim();
    if ((!body && pendingAttachments.length === 0) || sending) return;
    setSending(true);
    setActivePopover("none");
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
      cacheSentMessageImagePreviews(m, pendingAttachments);
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
    setActivePopover("none");
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

  const polishCurrentText = async (prefixHint: string) => {
    const current = text.trim();
    if (!current) return;
    await draft(`${prefixHint}\n\n${current}`);
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

  const copyMessageText = async (m: Message, preferredSelection?: string) => {
    const content = preferredSelection?.trim() || m.body.trim() || m.subject.trim();
    if (!content) {
      notify("该消息暂无可复制的文本内容");
      return;
    }
    const ok = await copyText(content);
    if (ok) {
      notify(preferredSelection?.trim() ? "已复制选中内容" : "已复制消息内容");
    } else {
      notify("复制失败，请手动选中复制", true);
    }
  };

  const pasteFromClipboardSmart = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.read === "function") {
        const items = await navigator.clipboard.read();
        const imageFiles: File[] = [];
        for (const clipItem of items) {
          const imgType = clipItem.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            const blob = await clipItem.getType(imgType);
            const ext = imgType.split("/")[1]?.split("+")[0] || "png";
            const fileName = `粘贴截图_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${ext}`;
            imageFiles.push(new File([blob], fileName, { type: imgType }));
          }
        }
        if (imageFiles.length > 0) {
          await appendFiles(imageFiles);
          notify(`已从剪贴板粘贴 ${imageFiles.length} 张图片`);
          return;
        }
      }
    } catch {
      // 若浏览器未返回图片项则回退读取文本剪贴板
    }

    try {
      const clipText = await navigator.clipboard.readText();
      if (clipText) {
        insertAtCursor(clipText);
      } else {
        notify("剪贴板暂无可粘贴的文本或图片");
      }
    } catch {
      notify("无法读取系统剪贴板，请直接使用 Ctrl+V", true);
    }
  };

  const launchComposeStudioFromChat = (targetMsg?: Message) => {
    if (!onOpenComposeStudio) return;
    const to = conv.is_group
      ? conv.members.map((m) => m.email).filter(Boolean)
      : [conv.peer].filter(Boolean);
    const refMsg =
      targetMsg ??
      (replyTarget ? messages.find((m) => m.id === replyTarget.id) : undefined) ??
      [...messages].reverse().find((m) => !m.outgoing) ??
      messages[messages.length - 1];
    const baseSubj = customSubject.trim() || refMsg?.subject?.trim() || "";
    const normalizedSubj = baseSubj
      ? /^(re|回复)[:：]/i.test(baseSubj) || customSubject.trim()
        ? baseSubj
        : `Re: ${baseSubj}`
      : "";
    onOpenComposeStudio({
      to,
      subject: normalizedSubj,
      bodyPlain: text,
      replyToId: refMsg?.id ?? null,
      replyContext: refMsg
        ? `发件人: ${refMsg.from_name ? `${refMsg.from_name} <${refMsg.from_addr}>` : refMsg.from_addr}\n主题: ${refMsg.subject || "(无主题)"}\n\n${refMsg.body || ""}`
        : undefined,
    });
  };

  const buildMessageMenuEntries = (
    m: Message,
    opts: {
      canShowHtml: boolean;
      showingHtml: boolean;
      hasExpandable: boolean;
      isExpanded: boolean;
      expandLabel: string;
      collapseLabel: string;
      selectedText: string;
      linkUrl: string | null;
    },
  ): ContextMenuEntry[] => {
    const sender = m.outgoing
      ? "我"
      : (!conv.is_group ? cleanTitle : "") || m.from_name || m.from_addr.split("@")[0] || m.from_addr;

    const entries: ContextMenuEntry[] = [
      { kind: "header", label: sender, badge: clockTime(m.date) },
    ];

    if (opts.selectedText) {
      entries.push({
        label: "复制选中文字",
        shortcut: "Ctrl+C",
        icon: <IconCopy size={14} />,
        accent: true,
        onSelect: () => copyMessageText(m, opts.selectedText),
      });
    }

    if (opts.linkUrl) {
      if (opts.linkUrl.toLowerCase().startsWith("mailto:")) {
        const addr = opts.linkUrl.slice(7).split("?")[0].trim().toLowerCase();
        if (addr && onStartDirectChat) {
          entries.push({
            label: `向 ${addr} 发起单聊`,
            icon: <IconChat size={14} />,
            accent: true,
            onSelect: () => onStartDirectChat(addr),
          });
        }
        if (addr) {
          entries.push({
            label: "复制链接中的邮箱",
            icon: <IconCopy size={14} />,
            onSelect: async () => {
              await copyText(addr);
              notify(`已复制邮箱 ${addr}`);
            },
          });
        }
      } else {
        entries.push({
          label: "在默认浏览器打开链接",
          icon: <IconExternalLink size={14} />,
          onSelect: () => {
            if (status === "blocked") {
              const ok = window.confirm(
                `该邮件位于「拦截」列表，确定要在外部浏览器中打开此链接吗？\n\n${opts.linkUrl}`,
              );
              if (!ok) return;
            }
            void api.openExternalUrl(opts.linkUrl!);
          },
        });
        entries.push({
          label: "复制链接地址",
          icon: <IconCopy size={14} />,
          onSelect: async () => {
            await copyText(opts.linkUrl!);
            notify("已复制链接地址");
          },
        });
      }
      entries.push({ kind: "divider" });
    }

    if (m.extracted_code) {
      entries.push({
        label: `复制验证码 ${m.extracted_code}`,
        icon: <IconOtp size={14} />,
        accent: !opts.selectedText,
        onSelect: () => copyCode(m.extracted_code),
      });
    }

    if (status !== "blocked") {
      entries.push({
        label: "引用回复",
        icon: <IconReply size={14} />,
        onSelect: () => startReplyTo(m),
      });
    }

    entries.push({
      label: "转发消息…",
      icon: <IconForward size={14} />,
      onSelect: () => setForwardMsg(m),
    });

    if (!m.outgoing && status !== "blocked") {
      entries.push({
        label: "针对此条 AI 起草回复",
        icon: <IconDraft size={14} />,
        onSelect: () => {
          startReplyTo(m);
          const snippet = (m.body.trim() || m.subject.trim()).slice(0, 180);
          void draft(`请重点针对对方这条消息起草得体回复：${snippet}`);
        },
      });
    }

    if (onOpenComposeStudio && status !== "blocked") {
      entries.push({
        label: "在写信工坊中排版 HTML 回复",
        icon: <IconCompose size={14} />,
        onSelect: () => launchComposeStudioFromChat(m),
      });
    }

    entries.push({ kind: "divider" });

    if (m.body.trim()) {
      entries.push({
        label: "复制整条消息文本",
        icon: <IconCopy size={14} />,
        onSelect: () => copyMessageText(m),
      });
    }

    if (m.subject.trim()) {
      entries.push({
        label: "复制邮件主题",
        sublabel: m.subject.trim().slice(0, 28),
        icon: <IconTag size={14} />,
        onSelect: async () => {
          await copyText(m.subject.trim());
          notify("已复制邮件主题");
        },
      });
    }

    if (!opts.showingHtml && opts.hasExpandable) {
      entries.push({
        label: opts.isExpanded ? opts.collapseLabel : opts.expandLabel,
        icon: <IconNote size={14} />,
        onSelect: () => toggle(m.id),
      });
    }

    if (opts.canShowHtml) {
      entries.push({
        label: opts.showingHtml ? "切换为精简纯文本" : "切换为原版网页视图",
        icon: <IconNote size={14} />,
        onSelect: () => toggleHtmlMode(m.id, opts.showingHtml),
      });
    }

    entries.push({ kind: "divider" });

    if (!conv.is_group && !m.outgoing) {
      if (status === "inbox") {
        entries.push({
          label: "将此封移入「通知」",
          icon: <IconBell size={14} />,
          onSelect: () => act(() => api.setMessageStatus(m.id, "archived"), "已移入通知折叠"),
        });
      } else {
        entries.push({
          label: "将此封移回「消息」",
          icon: <IconChat size={14} />,
          onSelect: () => act(() => api.setMessageStatus(m.id, "inbox"), "已移回消息列表"),
        });
      }
    }

    entries.push({
      label: "删除此条本地消息",
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (!window.confirm("确定从本地客户端删除此条消息记录吗？（不会删除远端邮箱服务器原件）")) {
          return;
        }
        void act(() => api.deleteMessage(m.id), "已删除该条消息");
      },
    });

    return entries;
  };

  const openBubbleContextMenu = (
    e: ReactMouseEvent<HTMLElement>,
    m: Message,
    opts: {
      canShowHtml: boolean;
      showingHtml: boolean;
      hasExpandable: boolean;
      isExpanded: boolean;
      expandLabel: string;
      collapseLabel: string;
    },
  ) => {
    const sel = window.getSelection()?.toString().trim() ?? "";
    const anchor = (e.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
    const linkUrl = anchor?.getAttribute("href")?.trim() || null;
    openContextMenu(
      e,
      buildMessageMenuEntries(m, {
        ...opts,
        selectedText: sel,
        linkUrl,
      }),
    );
  };

  const openHtmlContextMenu = (
    info: HtmlMailContextInfo,
    m: Message,
    opts: {
      canShowHtml: boolean;
      showingHtml: boolean;
      hasExpandable: boolean;
      isExpanded: boolean;
      expandLabel: string;
      collapseLabel: string;
    },
  ) => {
    openContextMenu(
      { x: info.clientX, y: info.clientY },
      buildMessageMenuEntries(m, {
        ...opts,
        selectedText: info.selectedText,
        linkUrl: info.linkUrl,
      }),
    );
  };

  const openAvatarContextMenu = (
    e: ReactMouseEvent<HTMLElement>,
    m: Message,
    speakerLabel: string,
  ) => {
    const senderEmail = m.from_addr.trim().toLowerCase();
    openContextMenu(e, [
      { kind: "header", label: speakerLabel, badge: senderEmail },
      conv.is_group && status !== "blocked"
        ? {
            label: `在输入框 @${speakerLabel}`,
            icon: <IconAt size={14} />,
            accent: true,
            onSelect: () => insertMention(speakerLabel),
          }
        : null,
      conv.is_group && senderEmail && onStartDirectChat
        ? {
            label: "向 TA 发起私聊",
            icon: <IconChat size={14} />,
            onSelect: () => onStartDirectChat(senderEmail, m.from_name || speakerLabel),
          }
        : null,
      !conv.is_group
        ? {
            label: "查看联系人详情 / 修改备注",
            icon: <IconEdit size={14} />,
            accent: true,
            onSelect: () => setShowDetailDrawer(true),
          }
        : null,
      status !== "blocked"
        ? {
            label: "引用此条消息回复",
            icon: <IconReply size={14} />,
            onSelect: () => startReplyTo(m),
          }
        : null,
      senderEmail
        ? {
            label: "复制发件人邮箱",
            sublabel: senderEmail,
            icon: <IconCopy size={14} />,
            onSelect: async () => {
              await copyText(senderEmail);
              notify(`已复制邮箱 ${senderEmail}`);
            },
          }
        : null,
      { kind: "divider" },
      senderEmail && status !== "blocked"
        ? {
            label: "屏蔽该发件人",
            icon: <IconShield size={14} />,
            danger: true,
            onSelect: () => {
              if (!window.confirm(`确定屏蔽 ${senderEmail} 并将往来邮件移入「拦截」吗？`)) return;
              void act(() => api.blockSender(senderEmail), `已屏蔽 ${senderEmail}`);
            },
          }
        : null,
    ]);
  };

  const openHeaderContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const allGroupEmails = conv.is_group
      ? conv.members.map((m) => m.email).join(", ")
      : conv.peer;
    openContextMenu(e, [
      { kind: "header", label: cleanTitle },
      {
        label: conv.is_group ? "群聊成员与设置" : "联系人详情与修改备注",
        icon: conv.is_group ? <IconUsers size={14} /> : <IconEdit size={14} />,
        accent: true,
        onSelect: () => {
          if (conv.is_group) setShowGroupDrawer(true);
          else setShowDetailDrawer(true);
        },
      },
      messages.length > 0
        ? {
            label: "搜索会话聊天记录",
            shortcut: "Ctrl+F",
            icon: <IconSearch size={14} />,
            onSelect: openSearchBar,
          }
        : null,
      messages.length >= 2
        ? {
            label: conv.is_group ? "AI 提炼群聊纪要" : "AI 提炼对话要点",
            icon: <IconNote size={14} />,
            onSelect: () => void runSummary(),
          }
        : null,
      { kind: "divider" },
      {
        label: conv.muted ? "关闭免打扰（移回消息）" : "开启免打扰（折叠进通知）",
        icon: conv.muted ? <IconUnmute size={14} /> : <IconMute size={14} />,
        onSelect: () =>
          act(
            () => api.setConversationMuted(conv.peer, !conv.muted),
            conv.muted ? "已恢复正常消息提醒" : "已开启免打扰并归入通知",
          ),
      },
      allGroupEmails
        ? {
            label: conv.is_group ? "复制全部群成员邮箱" : "复制对方邮箱地址",
            sublabel: conv.is_group ? `共 ${conv.members.length} 位成员` : conv.peer,
            icon: <IconCopy size={14} />,
            onSelect: async () => {
              await copyText(allGroupEmails);
              notify(conv.is_group ? "已复制全部群成员邮箱" : `已复制 ${conv.peer}`);
            },
          }
        : null,
    ]);
  };

  const openComposerContextMenu = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
    const el = inputRef.current;
    const selStart = el?.selectionStart ?? 0;
    const selEnd = el?.selectionEnd ?? 0;
    const hasSel = selEnd > selStart;
    const selectedSlice = hasSel ? text.slice(selStart, selEnd) : "";

    openContextMenu(e, [
      {
        label: "粘贴（支持截图 / 文本）",
        shortcut: "Ctrl+V",
        icon: <IconPaste size={14} />,
        accent: true,
        onSelect: () => void pasteFromClipboardSmart(),
      },
      {
        label: "剪切",
        shortcut: "Ctrl+X",
        icon: <IconScissors size={14} />,
        disabled: !hasSel,
        onSelect: async () => {
          await copyText(selectedSlice);
          const next = text.slice(0, selStart) + text.slice(selEnd);
          setText(next);
          requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(selStart, selStart);
          });
        },
      },
      {
        label: "复制",
        shortcut: "Ctrl+C",
        icon: <IconCopy size={14} />,
        disabled: !hasSel,
        onSelect: () => copyText(selectedSlice),
      },
      {
        label: "全选",
        shortcut: "Ctrl+A",
        icon: <IconSelectAll size={14} />,
        disabled: text.length === 0,
        onSelect: () => {
          el?.focus();
          el?.select();
        },
      },
      { kind: "divider" },
      {
        label: "屏幕区域截图",
        sublabel: "截图后可直接右键粘贴",
        icon: <IconScissors size={14} />,
        onSelect: async () => {
          try {
            await api.startScreenSnip();
          } catch (err) {
            notify(`启动截图工具失败：${err}`, true);
          }
        },
      },
      {
        label: "发送本地图片或文件…",
        icon: <IconFolder size={14} />,
        onSelect: () => fileInputRef.current?.click(),
      },
      messages.length > 0
        ? {
            label: "AI 智能起草回复",
            icon: <IconDraft size={14} />,
            onSelect: () => void draft(),
          }
        : null,
      text.trim().length > 0
        ? {
            label: "AI 润色当前草稿",
            icon: <IconSparkles size={14} />,
            onSelect: () => void polishCurrentText(POLISH_INTENTS[0].hint),
          }
        : null,
      {
        label: showSubjectInput ? "隐藏自定义邮件主题栏" : "指定邮件主题栏",
        checked: showSubjectInput,
        icon: <IconTag size={14} />,
        onSelect: () => setShowSubjectInput((v) => !v),
      },
      text.length > 0 || pendingAttachments.length > 0
        ? { kind: "divider" }
        : null,
      text.length > 0 || pendingAttachments.length > 0
        ? {
            label: "清空当前输入与待发附件",
            icon: <IconTrash size={14} />,
            danger: true,
            onSelect: () => {
              setText("");
              setPendingAttachments([]);
              setReplyTarget(null);
            },
          }
        : null,
    ]);
  };

  const executeForward = async (targetPeer: string, targetLabel: string) => {
    if (!forwardMsg || forwarding) return;
    const peerClean = targetPeer.trim();
    if (!peerClean) return;
    setForwarding(true);
    try {
      const originSender = forwardMsg.outgoing
        ? "我"
        : forwardMsg.from_name || forwardMsg.from_addr || cleanTitle;
      const bodyPart = forwardMsg.body.trim() || "(见原邮件内容)";
      const forwardText = `【转发自 ${originSender}】\n${bodyPart}`;
      const subj = forwardMsg.subject.trim()
        ? `Fwd: ${forwardMsg.subject.replace(/^((re|fwd?|回复|转发)\s*[:：]\s*)+/i, "")}`
        : undefined;
      await api.sendMessage(peerClean, forwardText, subj);
      setForwardMsg(null);
      setForwardManualPeer("");
      notify(`已转发给 ${targetLabel}`);
      onChanged();
    } catch (e) {
      notify(`转发失败：${e}`, true);
    } finally {
      setForwarding(false);
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

  // 仅针对较正式/明确提问的长消息展示轻量建议胶囊，且支持一键 × 关闭
  const latestSuggestedMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.outgoing) break; // 若最新一条已经是我方回复，则不再提示旧建议
      if (m.suggested_reply.trim() !== "") {
        const cleanLen = m.body.trim().length;
        const hasQuestion = /[?？请能否是否方便如何怎么什么何时哪里]/.test(m.body);
        if (cleanLen < 24 && !hasQuestion) return null;
        return m;
      }
    }
    return null;
  }, [messages]);

  const showSuggestChip =
    Boolean(latestSuggestedMsg) &&
    latestSuggestedMsg!.id !== dismissedSuggestMsgId &&
    !text &&
    !replyTarget &&
    pendingAttachments.length === 0;

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
              <span>松开鼠标发送文件或图片</span>
            </div>
          </div>
        )}

        <header
          className="chat-head"
          onMouseDown={startWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        >
          <div className="chat-head-inner">
            <button
              type="button"
              className="chat-identity-trigger"
              data-no-drag="true"
              onClick={toggleHeaderDrawer}
              onContextMenu={openHeaderContextMenu}
              title={
                conv.is_group
                  ? "点击查看与编辑群聊信息 · 右键快捷操作"
                  : "点击查看联系人详情、修改备注与管理会话 · 右键快捷操作"
              }
            >
              {conv.is_group ? (
                <GroupAvatar members={conv.members} seed={conv.peer} size={38} />
              ) : (
                <Avatar name={cleanTitle} seed={conv.peer} size={38} />
              )}
              <div className="chat-title">
                <div className="chat-name">
                  <span className="chat-name-text">
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
                <button
                  type="button"
                  className="soft-btn chat-action-btn chat-summary-btn"
                  onClick={runSummary}
                  disabled={summarizing}
                  title={summarizing ? "正在提炼对话纪要…" : "AI 提炼对话纪要"}
                >
                  <IconNote size={14} />
                  <span className="chat-action-label">{summarizing ? "提炼中…" : "纪要总结"}</span>
                </button>
              )}

              {onToggleAgentDock && (
                <button
                  type="button"
                  className={`soft-btn chat-action-btn ${agentDockOpen ? "active-soft" : ""}`}
                  onClick={onToggleAgentDock}
                  title={
                    agentDockOpen
                      ? "收起右侧邮件 AI 面板 (Ctrl+J)"
                      : "向右展开邮件 AI 面板 (Ctrl+J) · 总结会话、起草回复或写 HTML 邮件"
                  }
                >
                  <IconAgentDock size={14} open={agentDockOpen} />
                  <span className="chat-action-label">邮件 AI</span>
                </button>
              )}

              {status === "blocked" && !conv.is_group && (
                <button
                  type="button"
                  className="primary-btn chat-action-btn"
                  onClick={() => act(() => api.allowSender(conv.peer), "已恢复并加入白名单")}
                >
                  <IconCheck size={14} />
                  <span className="chat-action-label">恢复并信任</span>
                </button>
              )}

              {conv.is_group ? (
                <button
                  type="button"
                  className={`soft-btn chat-action-btn chat-drawer-btn ${showGroupDrawer ? "active-soft" : ""}`}
                  onClick={() => setShowGroupDrawer((v) => !v)}
                  title="查看与编辑群聊信息"
                >
                  <IconUsers size={14} />
                  <span className="chat-action-label">群信息</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`soft-btn chat-action-btn chat-drawer-btn ${showDetailDrawer ? "active-soft" : ""}`}
                  onClick={() => setShowDetailDrawer((v) => !v)}
                  title="查看详情、修改备注及更多操作"
                >
                  <IconMore size={15} />
                  <span className="chat-action-label">详情</span>
                </button>
              )}
            </div>
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

        <div className="chat-body" ref={chatBodyRef} onScroll={handleChatScroll}>
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
            const speakerLabel =
              !conv.is_group && !m.outgoing
                ? cleanTitle
                : m.from_name || m.from_addr.split("@")[0] || cleanTitle;
            const atts = m.attachments ?? [];
            const hasTextContent =
              showingHtml || analyzed.main.trim().length > 0 || analyzed.hasExpandable;
            const showSummary = shouldShowAgentSummary(m, status, showingHtml, analyzed.main);
            const isActiveMatch = activeMatchMsgId === m.id && Boolean(trimmedSearch);
            const isJumpFlashing = flashMsgId === m.id;

            const hoverBar = status !== "blocked" && (
              <div className="bubble-hover-actions">
                <button
                  type="button"
                  className="bubble-hover-btn"
                  onClick={() => startReplyTo(m)}
                  title="引用回复"
                >
                  <IconReply size={12} />
                </button>
                {m.body.trim() && (
                  <button
                    type="button"
                    className="bubble-hover-btn"
                    onClick={() => void copyMessageText(m)}
                    title="复制内容"
                  >
                    <IconCopy size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="bubble-hover-btn"
                  onClick={() => setForwardMsg(m)}
                  title="转发消息"
                >
                  <IconForward size={12} />
                </button>
              </div>
            );

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
                      onContextMenu={(e) => openAvatarContextMenu(e, m, speakerLabel)}
                      title={
                        conv.is_group
                          ? `点击 @${speakerLabel} · 右键发起私聊或复制邮箱`
                          : "点击查看联系人详情 · 右键更多操作"
                      }
                    />
                  )}

                  {m.outgoing && hoverBar}

                  <div
                    className={[
                      "bubble",
                      showingHtml ? "bubble-html" : "",
                      isActiveMatch ? "bubble-search-active" : "",
                      isJumpFlashing ? "bubble-jump-flash" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onContextMenu={(e) =>
                      openBubbleContextMenu(e, m, {
                        canShowHtml,
                        showingHtml,
                        hasExpandable: analyzed.hasExpandable,
                        isExpanded,
                        expandLabel: analyzed.expandLabel,
                        collapseLabel: analyzed.collapseLabel,
                      })
                    }
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
                        <IconTag size={11} className="bubble-subject-icon" />
                        <span>{trimmedSearch ? highlightText(subj, trimmedSearch) : subj}</span>
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
                          <HtmlMailView
                            html={m.body_html}
                            status={status}
                            onContextMenuRequest={(info) =>
                              openHtmlContextMenu(info, m, {
                                canShowHtml,
                                showingHtml,
                                hasExpandable: analyzed.hasExpandable,
                                isExpanded,
                                expandLabel: analyzed.expandLabel,
                                collapseLabel: analyzed.collapseLabel,
                              })
                            }
                          />
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
                        messageId={m.id}
                        attachments={atts}
                        outgoing={m.outgoing}
                        highlightQuery={trimmedSearch || undefined}
                        onPreviewImage={(att, dataUrl, msgId, savedPath) =>
                          setLightbox({
                            src: dataUrl,
                            title: att.filename,
                            size: att.size,
                            messageId: msgId,
                            attachmentId: att.id,
                            savedPath,
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
                      {!showingHtml && analyzed.hasExpandable && (
                        <button type="button" className="bubble-meta-link" onClick={() => toggle(m.id)}>
                          {isExpanded ? analyzed.collapseLabel : analyzed.expandLabel}
                        </button>
                      )}
                      {canShowHtml && (
                        <button
                          type="button"
                          className="bubble-meta-link"
                          onClick={() => toggleHtmlMode(m.id, showingHtml)}
                        >
                          {showingHtml ? "精简文本" : "网页视图"}
                        </button>
                      )}
                      {status !== "inbox" && !m.outgoing && !conv.is_group && (
                        <button
                          type="button"
                          className="bubble-meta-link"
                          onClick={() => act(() => api.setMessageStatus(m.id, "inbox"), "已移回消息")}
                        >
                          移回消息
                        </button>
                      )}
                      <span className="bubble-time">{clockTime(m.date)}</span>
                    </div>
                  </div>

                  {!m.outgoing && hoverBar}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {showScrollBottom && (
          <button
            type="button"
            className="scroll-bottom-pill"
            onClick={scrollToLatest}
            title="回到最新消息"
          >
            <IconArrowDown size={13} />
            <span>回到底部</span>
          </button>
        )}

        {status !== "blocked" && (
          <div className="im-composer" ref={composerRef}>
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

            {showSuggestChip && latestSuggestedMsg && (
              <div className="im-suggest-row">
                <div className="im-suggest-chip" title={`点击填入建议回复：${latestSuggestedMsg.suggested_reply}`}>
                  <button
                    type="button"
                    className="im-suggest-fill"
                    onClick={() => {
                      setText(latestSuggestedMsg.suggested_reply);
                      inputRef.current?.focus();
                    }}
                  >
                    <IconSparkles size={12} />
                    <span className="im-suggest-prefix">建议回复：</span>
                    <span className="im-suggest-label">{latestSuggestedMsg.suggested_reply}</span>
                  </button>
                  <button
                    type="button"
                    className="im-suggest-close"
                    onClick={() => setDismissedSuggestMsgId(latestSuggestedMsg.id)}
                    title="忽略此条建议"
                  >
                    <IconClose size={11} />
                  </button>
                </div>
              </div>
            )}

            <div
              className="im-composer-card"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest("button, input, textarea, [data-popover-zone]")) return;
                inputRef.current?.focus();
              }}
            >
              <div
                className="im-composer-resizer"
                onMouseDown={startResizeComposer}
                title="上下拖动调整输入区高度"
              />

              {(replyTarget || pendingAttachments.length > 0 || showSubjectInput) && (
                <div className="im-composer-context">
                  {replyTarget && (
                    <div className="reply-quote-bar">
                      <IconReply size={13} className="reply-quote-icon" />
                      <div
                        className="reply-quote-body"
                        onClick={() => jumpToMessage(replyTarget.id)}
                        title="点击定位查看原消息"
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

                  {showSubjectInput && (
                    <div className="subject-bar">
                      <span className="subject-bar-badge">
                        <IconTag size={11} />
                        邮件主题
                      </span>
                      <input
                        className="grow"
                        placeholder={conv.is_group ? `默认沿用「${cleanTitle}」` : "留空则自动沿用会话主题"}
                        value={customSubject}
                        onChange={(e) => setCustomSubject(e.target.value)}
                      />
                      <button
                        type="button"
                        className="tool-btn small"
                        onClick={() => setShowSubjectInput(false)}
                        title="收起主题栏"
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
                </div>
              )}

              <div className="im-composer-stage" style={{ height: `${composerHeight}px` }}>
                <textarea
                  ref={inputRef}
                  className="im-composer-textarea"
                  value={text}
                  placeholder={
                    conv.is_group
                      ? `全员回复 ${conv.members.length} 位群成员（可输入 @ 提及成员，支持粘贴图片或拖拽文件）`
                      : "输入消息…（支持 Ctrl+V 粘贴图片/文件，拖拽发送附件）"
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    setText(val);
                    if (conv.is_group && val.endsWith("@")) {
                      setActivePopover("mention");
                    } else if (activePopover === "mention" && !val.includes("@")) {
                      setActivePopover("none");
                    }
                  }}
                  onPaste={handlePaste}
                  onContextMenu={openComposerContextMenu}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      if (activePopover !== "none") {
                        e.preventDefault();
                        setActivePopover("none");
                        return;
                      }
                      if (replyTarget) {
                        e.preventDefault();
                        setReplyTarget(null);
                        return;
                      }
                    }
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />

                <footer className="im-composer-bar">
                  <div className="im-composer-tools" data-popover-zone="true">
                    <div className="im-tool-anchor">
                      <button
                        type="button"
                        className={`im-tool-btn ${activePopover === "emoji" ? "active" : ""}`}
                        onClick={() => setActivePopover((p) => (p === "emoji" ? "none" : "emoji"))}
                        title="插入表情"
                      >
                        <IconSmile size={17} />
                      </button>
                      {activePopover === "emoji" && (
                        <div className="im-popover emoji-popover">
                          <div className="im-popover-title">常用表情</div>
                          <div className="emoji-grid">
                            {COMMON_EMOJIS.map((em) => (
                              <button
                                key={em}
                                type="button"
                                className="emoji-cell"
                                onClick={() => {
                                  insertAtCursor(em);
                                  setActivePopover("none");
                                }}
                              >
                                {em}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className="im-tool-btn"
                      onClick={() => fileInputRef.current?.click()}
                      title="发送文件或图片（支持拖拽添加或右键粘贴）"
                    >
                      <IconFolder size={17} />
                    </button>

                    <button
                      type="button"
                      className="im-tool-btn"
                      onClick={() => {
                        api.startScreenSnip().catch((err) => notify(`启动截图工具失败：${err}`, true));
                      }}
                      title="屏幕区域截图（截图后直接 Ctrl+V 或右键粘贴）"
                    >
                      <IconScissors size={16} />
                    </button>

                    {conv.is_group && conv.members.length > 0 && (
                      <div className="im-tool-anchor">
                        <button
                          type="button"
                          className={`im-tool-btn ${activePopover === "mention" ? "active" : ""}`}
                          onClick={() => setActivePopover((p) => (p === "mention" ? "none" : "mention"))}
                          title="@提及群成员"
                        >
                          <IconAt size={16} />
                        </button>
                        {activePopover === "mention" && (
                          <div className="im-popover mention-popover">
                            <div className="im-popover-title">选择要 @ 的成员</div>
                            <button
                              type="button"
                              className="im-popover-item"
                              onClick={() => insertMention("所有人")}
                            >
                              <span className="im-popover-item-main">@所有人</span>
                              <span className="im-popover-item-sub">提醒全体成员</span>
                            </button>
                            {conv.members.map((m) => {
                              const label = m.name || m.email.split("@")[0];
                              return (
                                <button
                                  key={m.email}
                                  type="button"
                                  className="im-popover-item"
                                  onClick={() => insertMention(label)}
                                >
                                  <span className="im-popover-item-main">@{label}</span>
                                  <span className="im-popover-item-sub">{m.email}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {(messages.length > 0 || text.trim().length > 0) && (
                      <div className="im-tool-anchor">
                        <button
                          type="button"
                          className={`im-tool-btn ${activePopover === "draft" ? "active" : ""}`}
                          onClick={() => setActivePopover((p) => (p === "draft" ? "none" : "draft"))}
                          disabled={drafting}
                          title="AI 辅助帮写与文本润色"
                        >
                          <span className={drafting ? "spin" : ""}>
                            <IconDraft size={16} />
                          </span>
                        </button>
                        {activePopover === "draft" && (
                          <div className="im-popover draft-popover">
                            {text.trim().length > 0 && (
                              <>
                                <div className="im-popover-title">润色当前草稿</div>
                                {POLISH_INTENTS.map((item) => (
                                  <button
                                    key={item.label}
                                    type="button"
                                    className="im-popover-item"
                                    onClick={() => void polishCurrentText(item.hint)}
                                  >
                                    <span className="im-popover-item-main">{item.label}</span>
                                  </button>
                                ))}
                                {messages.length > 0 && <div className="im-popover-sep" />}
                              </>
                            )}
                            {messages.length > 0 && (
                              <>
                                <div className="im-popover-title">结合上下文帮写</div>
                                {DRAFT_INTENTS.map((item) => (
                                  <button
                                    key={item.label}
                                    type="button"
                                    className="im-popover-item"
                                    onClick={() => void draft(item.hint)}
                                  >
                                    <span className="im-popover-item-main">{item.label}</span>
                                    <span className="im-popover-item-sub">{item.desc}</span>
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      type="button"
                      className={`im-tool-btn ${showSubjectInput || customSubject.trim() ? "active" : ""}`}
                      onClick={() => setShowSubjectInput((v) => !v)}
                      title="自定义邮件主题"
                    >
                      <IconTag size={15} />
                    </button>

                    {onOpenComposeStudio && (
                      <button
                        type="button"
                        className="im-tool-btn"
                        onClick={() => launchComposeStudioFromChat()}
                        title="转入传统写信 / Agent HTML 排版工坊（携带收件人、引用与草稿）"
                      >
                        <IconCompose size={15} />
                      </button>
                    )}
                  </div>

                  <div className="im-composer-right" data-popover-zone="true">
                    <span className="im-composer-hint">Enter 发送 · Shift+Enter 换行</span>
                    <button
                      type="button"
                      className={`im-send-btn ${canSend ? "ready" : ""}`}
                      onClick={() => void send()}
                      disabled={!canSend}
                      title="发送 (Enter 发送，Shift+Enter 换行)"
                    >
                      <IconSend size={13} />
                      <span>{sending ? "发送中…" : "发送"}</span>
                    </button>
                  </div>
                </footer>
              </div>
            </div>
          </div>
        )}
      </div>

      {forwardMsg && (
        <div className="modal-backdrop" onClick={() => !forwarding && setForwardMsg(null)}>
          <div className="forward-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <span>转发消息</span>
              <button
                type="button"
                className="tool-btn small"
                onClick={() => setForwardMsg(null)}
                disabled={forwarding}
              >
                <IconClose size={13} />
              </button>
            </div>
            <div className="forward-preview">
              {forwardMsg.body.trim().slice(0, 120) || forwardMsg.subject || "(无文字内容)"}
            </div>
            <div className="row">
              <input
                className="grow"
                placeholder="输入接收人邮箱直接转发…"
                value={forwardManualPeer}
                onChange={(e) => setForwardManualPeer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && forwardManualPeer.includes("@")) {
                    void executeForward(forwardManualPeer, forwardManualPeer.trim());
                  }
                }}
              />
              <button
                type="button"
                className="primary-btn"
                disabled={forwarding || !forwardManualPeer.includes("@")}
                onClick={() => void executeForward(forwardManualPeer, forwardManualPeer.trim())}
              >
                发送
              </button>
            </div>
            {conversations.filter((c) => c.peer !== conv.peer).length > 0 && (
              <div className="forward-conv-list">
                <div className="pick-caption">最近会话（点击直接转发）</div>
                {conversations
                  .filter((c) => c.peer !== conv.peer)
                  .slice(0, 8)
                  .map((target) => (
                    <button
                      key={target.peer}
                      type="button"
                      className="forward-conv-item"
                      disabled={forwarding}
                      onClick={() => void executeForward(target.peer, target.name)}
                    >
                      {target.is_group ? (
                        <GroupAvatar members={target.members} seed={target.peer} size={28} />
                      ) : (
                        <Avatar name={target.name} seed={target.peer} size={28} />
                      )}
                      <div className="forward-conv-info">
                        <span className="forward-conv-name">{target.name.replace(/^🚀\s*/, "")}</span>
                        <span className="forward-conv-peer">{target.peer}</span>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

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
          onPreviewImage={(att, dataUrl, msgId, savedPath) =>
            setLightbox({
              src: dataUrl,
              title: att.filename,
              size: att.size,
              messageId: msgId,
              attachmentId: att.id,
              savedPath,
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
                onPreviewImage={(att, dataUrl, msgId, savedPath) =>
                  setLightbox({
                    src: dataUrl,
                    title: att.filename,
                    size: att.size,
                    messageId: msgId,
                    attachmentId: att.id,
                    savedPath,
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
