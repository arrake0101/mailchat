import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  Account,
  AccountEntry,
  ComposeAgentBridge,
  ComposeAgentResult,
  ComposeLaunchIntent,
  GroupMember,
  Message,
} from "../types";
import {
  AttachmentLightbox,
  cacheSentMessageImagePreviews,
  filesToPendingAttachments,
  type LightboxItem,
  PendingAttachmentsBar,
  type PendingAttachmentItem,
} from "./AttachmentItems";
import { HtmlMailView } from "./HtmlMailView";
import {
  IconAlert,
  IconClose,
  IconCode,
  IconEye,
  IconFolder,
  IconScissors,
  IconSend,
  IconSparkles,
  IconUndo,
} from "./Icons";

interface DraftSnapshot {
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
}

function stripHtmlForPlain(html: string): string {
  if (!html.trim()) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body?.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").trim();
  }
}

export interface ComposeWorkspaceProps {
  account: Account | null;
  accounts: AccountEntry[];
  hasDemo: boolean;
  launchIntent: ComposeLaunchIntent | null;
  agentDockOpen: boolean;
  onSummonGlobalAgent: (prefillPrompt?: string, autoSend?: boolean) => void;
  onBindComposeBridge: (bridge: ComposeAgentBridge | null) => void;
  notify: (text: string, isError?: boolean) => void;
  onSent?: (msg: Message, primaryPeer: string) => void;
  onOpenSettings?: () => void;
}

export function ComposeWorkspace({
  account,
  accounts,
  hasDemo,
  launchIntent,
  agentDockOpen,
  onSummonGlobalAgent,
  onBindComposeBridge,
  notify,
  onSent,
  onOpenSettings,
}: ComposeWorkspaceProps) {
  const [fromEmail, setFromEmail] = useState<string>(account?.email || "");
  const [toList, setToList] = useState<string[]>([]);
  const [toInput, setToInput] = useState("");
  const [ccList, setCcList] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  const [bccList, setBccList] = useState<string[]>([]);
  const [bccInput, setBccInput] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  const [subject, setSubject] = useState("");
  const [bodyPlain, setBodyPlain] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [editingHtmlSource, setEditingHtmlSource] = useState(false);

  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [replyContextText, setReplyContextText] = useState<string>("");
  const [redactPii, setRedactPii] = useState<boolean>(true);
  const [customRedactTerms, setCustomRedactTerms] = useState<string[]>([]);

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  const [undoStack, setUndoStack] = useState<DraftSnapshot[]>([]);
  const [contacts, setContacts] = useState<GroupMember[]>([]);
  const [focusedAddrField, setFocusedAddrField] = useState<"to" | "cc" | "bcc" | null>(null);
  const [sending, setSending] = useState(false);
  const [dlpBlockMessage, setDlpBlockMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handledIntentRef = useRef<string>("");

  // 同步默认发件邮箱、通讯录与脱敏词表
  useEffect(() => {
    if (account?.email && !fromEmail) {
      setFromEmail(account.email);
    }
  }, [account?.email, fromEmail]);

  useEffect(() => {
    api.listContacts().then(setContacts).catch(() => {});
    api
      .getReplyPolicy()
      .then((pol) => {
        setRedactPii(pol.redact_pii);
        setCustomRedactTerms(pol.custom_redact_terms || []);
      })
      .catch(() => {});
  }, []);

  // 监听截图事件自动粘贴为附件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ filename: string; mime: string; data_base64: string; data_url?: string }>(
      "screen-snip-captured",
      (ev) => {
        const p = ev.payload;
        if (!p?.data_base64) return;
        const approxSize = Math.floor((p.data_base64.length * 3) / 4);
        const mime = p.mime || "image/png";
        setPendingAttachments((prev) => [
          ...prev,
          {
            id: `snip-${Date.now()}`,
            filename: p.filename || `截图-${Date.now()}.png`,
            mime,
            size: approxSize,
            dataBase64: p.data_base64,
            previewUrl: p.data_url || `data:${mime};base64,${p.data_base64}`,
            isImage: true,
          },
        ]);
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 接收外部写信跳转意图
  useEffect(() => {
    if (!launchIntent || launchIntent.id === handledIntentRef.current) return;
    handledIntentRef.current = launchIntent.id;
    if (launchIntent.fromEmail) setFromEmail(launchIntent.fromEmail);
    setToList(launchIntent.to ?? []);
    setCcList(launchIntent.cc ?? []);
    setShowCc(Boolean(launchIntent.cc && launchIntent.cc.length > 0));
    setBccList([]);
    setShowBcc(false);
    setSubject(launchIntent.subject ?? "");
    setBodyHtml(launchIntent.bodyHtml ?? "");
    setBodyPlain(
      launchIntent.bodyPlain ??
        (launchIntent.bodyHtml ? stripHtmlForPlain(launchIntent.bodyHtml) : ""),
    );
    setEditingHtmlSource(false);
    setReplyToId(launchIntent.replyToId ?? null);
    setReplyContextText(launchIntent.replyContext ?? "");
    setDlpBlockMessage(null);
    if (launchIntent.agentPrompt?.trim()) {
      onSummonGlobalAgent(launchIntent.agentPrompt, true);
    }
  }, [launchIntent, onSummonGlobalAgent]);

  const snapshotRef = useRef<DraftSnapshot>({ subject, bodyPlain, bodyHtml });
  snapshotRef.current = { subject, bodyPlain, bodyHtml };
  const streamSavedSnapshotRef = useRef(false);

  const handleStreamHtml = useCallback((html: string) => {
    if (!streamSavedSnapshotRef.current) {
      streamSavedSnapshotRef.current = true;
      const snap = snapshotRef.current;
      setUndoStack((prev) => [...prev.slice(-9), snap]);
    }
    setEditingHtmlSource(false);
    setBodyHtml(html);
  }, []);

  const handleApplyAgentResult = useCallback((res: ComposeAgentResult) => {
    if (!streamSavedSnapshotRef.current) {
      const snap = snapshotRef.current;
      setUndoStack((prev) => [...prev.slice(-9), snap]);
    }
    streamSavedSnapshotRef.current = false;

    if (res.suggested_subject?.trim()) {
      setSubject(res.suggested_subject.trim());
    }
    if (res.suggested_html?.trim()) {
      const h = res.suggested_html.trim();
      setBodyHtml(h);
      setBodyPlain(res.suggested_plain?.trim() || stripHtmlForPlain(h));
      setEditingHtmlSource(false);
    } else if (res.suggested_plain?.trim()) {
      setBodyHtml("");
      setBodyPlain(res.suggested_plain.trim());
      setEditingHtmlSource(false);
    }
  }, []);

  const senderIdentity = useMemo(() => {
    const matched = accounts.find(
      (a) => a.email.toLowerCase() === fromEmail.trim().toLowerCase(),
    );
    if (matched) {
      return matched.display_name
        ? `${matched.display_name} <${matched.email}>`
        : matched.email;
    }
    return fromEmail || account?.email || (hasDemo ? "me@mailchat.local" : "");
  }, [account?.email, accounts, fromEmail, hasDemo]);

  // 向右侧全局 AI 面板注册实时写信上下文桥接
  useEffect(() => {
    onBindComposeBridge({
      senderIdentity,
      to: toList,
      cc: ccList,
      subject,
      bodyPlain,
      bodyHtml,
      replyContext: replyContextText.trim() ? replyContextText : null,
      redactPii,
      customRedactTerms,
      onToggleRedactPii: setRedactPii,
      onStreamHtml: handleStreamHtml,
      onApplyResult: handleApplyAgentResult,
    });
  }, [
    bodyHtml,
    bodyPlain,
    ccList,
    customRedactTerms,
    handleApplyAgentResult,
    handleStreamHtml,
    onBindComposeBridge,
    redactPii,
    replyContextText,
    senderIdentity,
    subject,
    toList,
  ]);

  useEffect(() => {
    return () => onBindComposeBridge(null);
  }, [onBindComposeBridge]);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setSubject(prev.subject);
    setBodyPlain(prev.bodyPlain);
    setBodyHtml(prev.bodyHtml);
  };

  // 收件人地址解析与联想
  const commitAddressTokens = (
    raw: string,
    list: string[],
    setList: (next: string[]) => void,
  ): boolean => {
    const parts = raw
      .split(/[,;，；\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return false;
    let changed = false;
    const next = [...list];
    for (const p of parts) {
      const m = p.match(/<([^>]+@[^>]+)>/) || p.match(/([^\s<>]+@[^\s<>]+)/);
      const email = m ? m[1].toLowerCase() : "";
      if (email && !next.includes(email)) {
        next.push(email);
        changed = true;
      }
    }
    if (changed) setList(next);
    return changed;
  };

  const handleAddressKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    val: string,
    setVal: (v: string) => void,
    list: string[],
    setList: (next: string[]) => void,
  ) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (val.trim()) {
        e.preventDefault();
        if (commitAddressTokens(val, list, setList)) {
          setVal("");
        } else {
          notify("请输入有效的邮箱地址（例如 name@example.com）", true);
        }
      }
    } else if (e.key === "Backspace" && !val && list.length > 0) {
      setList(list.slice(0, -1));
    }
  };

  const activeAddrQuery =
    focusedAddrField === "to"
      ? toInput
      : focusedAddrField === "cc"
        ? ccInput
        : focusedAddrField === "bcc"
          ? bccInput
          : "";

  const contactSuggestions = useMemo(() => {
    if (!focusedAddrField) return [];
    const q = activeAddrQuery.trim().toLowerCase();
    const chosen = new Set([...toList, ...ccList, ...bccList]);
    return contacts
      .filter((c) => {
        const em = c.email.toLowerCase();
        if (chosen.has(em)) return false;
        if (!q) return true;
        return em.includes(q) || (c.name || "").toLowerCase().includes(q);
      })
      .slice(0, 6);
  }, [activeAddrQuery, bccList, ccList, contacts, focusedAddrField, toList]);

  const pickSuggestedContact = (email: string) => {
    const clean = email.trim().toLowerCase();
    if (focusedAddrField === "to") {
      if (!toList.includes(clean)) setToList([...toList, clean]);
      setToInput("");
    } else if (focusedAddrField === "cc") {
      if (!ccList.includes(clean)) setCcList([...ccList, clean]);
      setCcInput("");
    } else if (focusedAddrField === "bcc") {
      if (!bccList.includes(clean)) setBccList([...bccList, clean]);
      setBccInput("");
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const { items, errors } = await filesToPendingAttachments(files);
    if (errors.length > 0) notify(errors[0], true);
    if (items.length > 0) {
      setPendingAttachments((prev) => [...prev, ...items]);
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const handleDrop = (e: DragEvent) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  };

  const executeSend = async (forceDlpOverride = false) => {
    const finalTo = [...toList];
    if (toInput.trim()) {
      const m = toInput.trim().match(/([^\s<>]+@[^\s<>]+)/);
      if (m && !finalTo.includes(m[1].toLowerCase())) {
        finalTo.push(m[1].toLowerCase());
      }
    }
    if (finalTo.length === 0) {
      notify("请填写收件人邮箱地址", true);
      return;
    }

    const finalCc = [...ccList];
    if (ccInput.trim()) {
      const m = ccInput.trim().match(/([^\s<>]+@[^\s<>]+)/);
      if (m && !finalCc.includes(m[1].toLowerCase())) finalCc.push(m[1].toLowerCase());
    }
    const finalBcc = [...bccList];
    if (bccInput.trim()) {
      const m = bccInput.trim().match(/([^\s<>]+@[^\s<>]+)/);
      if (m && !finalBcc.includes(m[1].toLowerCase())) finalBcc.push(m[1].toLowerCase());
    }

    const hasHtml = Boolean(bodyHtml.trim());
    const plainOut = bodyPlain.trim() || (hasHtml ? stripHtmlForPlain(bodyHtml) : "");
    if (!plainOut && !hasHtml && pendingAttachments.length === 0) {
      notify("请输入邮件正文或添加附件", true);
      return;
    }

    setSending(true);
    setDlpBlockMessage(null);
    try {
      const sent = await api.sendComposedMail({
        fromEmail: fromEmail || account?.email || null,
        to: finalTo,
        cc: finalCc,
        bcc: finalBcc,
        subject: subject.trim() || "(无主题)",
        bodyPlain: plainOut,
        bodyHtml: hasHtml ? bodyHtml : null,
        attachments: pendingAttachments.map((a) => ({
          filename: a.filename,
          mime: a.mime,
          data_base64: a.dataBase64,
        })),
        replyToId,
        forceDlpOverride,
      });
      cacheSentMessageImagePreviews(sent, pendingAttachments);
      notify(`邮件已发送至 ${finalTo.join(", ")}`);
      setToList([]);
      setToInput("");
      setCcList([]);
      setCcInput("");
      setBccList([]);
      setBccInput("");
      setSubject("");
      setBodyPlain("");
      setBodyHtml("");
      setPendingAttachments([]);
      setReplyToId(null);
      setReplyContextText("");
      onSent?.(sent, finalTo[0]);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("DLP_BLOCK:")) {
        setDlpBlockMessage(msg.replace(/^.*DLP_BLOCK:\s*/, ""));
      } else {
        notify(`发信失败：${msg}`, true);
      }
    } finally {
      setSending(false);
    }
  };

  const hasRichHtml = Boolean(bodyHtml.trim());

  return (
    <section
      className="compose-minimal-workspace"
      onPaste={handlePaste}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void executeSend(false);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="compose-sheet">
        {/* 极简传统信头 */}
        <div className="compose-envelope">
          {/* 发件人 */}
          <div className="compose-row">
            <span className="compose-label">发件人</span>
            <div className="compose-row-main compose-from-line">
              {accounts.length > 0 ? (
                <select
                  className="compose-from-select"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                >
                  {accounts.map((acc) => (
                    <option key={acc.email} value={acc.email}>
                      {acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email}
                    </option>
                  ))}
                </select>
              ) : hasDemo ? (
                <span className="compose-demo-from">me@mailchat.local（演示模式）</span>
              ) : (
                <button type="button" className="compose-link-btn" onClick={onOpenSettings}>
                  + 先绑定发件邮箱账号
                </button>
              )}

              <div className="compose-cc-links">
                {!showCc && (
                  <button
                    type="button"
                    className="compose-subtle-link"
                    onClick={() => setShowCc(true)}
                  >
                    抄送
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    className="compose-subtle-link"
                    onClick={() => setShowBcc(true)}
                  >
                    密送
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 收件人 */}
          <div className="compose-row">
            <span className="compose-label">收件人</span>
            <div className="compose-row-main compose-addr-wrap">
              {toList.map((em) => (
                <span key={em} className="compose-chip">
                  <span>{em}</span>
                  <button
                    type="button"
                    onClick={() => setToList(toList.filter((x) => x !== em))}
                    aria-label="移除"
                  >
                    <IconClose size={10} />
                  </button>
                </span>
              ))}
              <input
                className="compose-addr-input"
                placeholder={toList.length === 0 ? "输入收件人邮箱，回车添加…" : ""}
                value={toInput}
                onFocus={() => setFocusedAddrField("to")}
                onBlur={() => {
                  if (toInput.trim() && commitAddressTokens(toInput, toList, setToList)) {
                    setToInput("");
                  }
                  window.setTimeout(
                    () => setFocusedAddrField((f) => (f === "to" ? null : f)),
                    150,
                  );
                }}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => handleAddressKeyDown(e, toInput, setToInput, toList, setToList)}
              />
              {focusedAddrField === "to" && contactSuggestions.length > 0 && (
                <div className="compose-suggest-menu">
                  {contactSuggestions.map((c) => (
                    <button
                      key={c.email}
                      type="button"
                      className="compose-suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickSuggestedContact(c.email);
                      }}
                    >
                      <span className="compose-suggest-name">
                        {c.name || c.email.split("@")[0]}
                      </span>
                      <span className="compose-suggest-email">{c.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 抄送 */}
          {showCc && (
            <div className="compose-row">
              <span className="compose-label">抄送</span>
              <div className="compose-row-main compose-addr-wrap">
                {ccList.map((em) => (
                  <span key={em} className="compose-chip muted">
                    <span>{em}</span>
                    <button
                      type="button"
                      onClick={() => setCcList(ccList.filter((x) => x !== em))}
                    >
                      <IconClose size={10} />
                    </button>
                  </span>
                ))}
                <input
                  className="compose-addr-input"
                  placeholder="抄送邮箱…"
                  value={ccInput}
                  onFocus={() => setFocusedAddrField("cc")}
                  onBlur={() => {
                    if (ccInput.trim() && commitAddressTokens(ccInput, ccList, setCcList)) {
                      setCcInput("");
                    }
                    window.setTimeout(
                      () => setFocusedAddrField((f) => (f === "cc" ? null : f)),
                      150,
                    );
                  }}
                  onChange={(e) => setCcInput(e.target.value)}
                  onKeyDown={(e) => handleAddressKeyDown(e, ccInput, setCcInput, ccList, setCcList)}
                />
                {focusedAddrField === "cc" && contactSuggestions.length > 0 && (
                  <div className="compose-suggest-menu">
                    {contactSuggestions.map((c) => (
                      <button
                        key={c.email}
                        type="button"
                        className="compose-suggest-item"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickSuggestedContact(c.email);
                        }}
                      >
                        <span className="compose-suggest-name">
                          {c.name || c.email.split("@")[0]}
                        </span>
                        <span className="compose-suggest-email">{c.email}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 密送 */}
          {showBcc && (
            <div className="compose-row">
              <span className="compose-label">密送</span>
              <div className="compose-row-main compose-addr-wrap">
                {bccList.map((em) => (
                  <span key={em} className="compose-chip muted">
                    <span>{em}</span>
                    <button
                      type="button"
                      onClick={() => setBccList(bccList.filter((x) => x !== em))}
                    >
                      <IconClose size={10} />
                    </button>
                  </span>
                ))}
                <input
                  className="compose-addr-input"
                  placeholder="密送邮箱（其他收件人不可见）…"
                  value={bccInput}
                  onFocus={() => setFocusedAddrField("bcc")}
                  onBlur={() => {
                    if (bccInput.trim() && commitAddressTokens(bccInput, bccList, setBccList)) {
                      setBccInput("");
                    }
                    window.setTimeout(
                      () => setFocusedAddrField((f) => (f === "bcc" ? null : f)),
                      150,
                    );
                  }}
                  onChange={(e) => setBccInput(e.target.value)}
                  onKeyDown={(e) =>
                    handleAddressKeyDown(e, bccInput, setBccInput, bccList, setBccList)
                  }
                />
              </div>
            </div>
          )}

          {/* 主题 */}
          <div className="compose-row compose-subject-row">
            <span className="compose-label">主题</span>
            <div className="compose-row-main">
              <input
                className="compose-subject-input"
                placeholder="输入邮件主题"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              {replyToId && (
                <span className="compose-reply-pill">
                  回复原信
                  <button
                    type="button"
                    onClick={() => {
                      setReplyToId(null);
                      setReplyContextText("");
                    }}
                    title="取消关联原邮件"
                  >
                    <IconClose size={10} />
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 纯净单一正文区：默认传统纯文本；当 AI 生成 HTML 时自动展示渲染后信纸，仅保留轻量微调胶囊 */}
        <div className="compose-body-area">
          {hasRichHtml ? (
            <div className="compose-html-canvas">
              <div className="compose-html-floating-bar">
                <span className="compose-html-tag">HTML 富文本信纸</span>
                <button
                  type="button"
                  className={`compose-micro-btn ${editingHtmlSource ? "active" : ""}`}
                  onClick={() => setEditingHtmlSource((v) => !v)}
                >
                  {editingHtmlSource ? <IconEye size={12} /> : <IconCode size={12} />}
                  <span>{editingHtmlSource ? "查看渲染效果" : "源码微调"}</span>
                </button>
                <button
                  type="button"
                  className="compose-micro-btn"
                  onClick={() => {
                    setUndoStack((prev) => [
                      ...prev.slice(-9),
                      { subject, bodyPlain, bodyHtml },
                    ]);
                    setBodyPlain(stripHtmlForPlain(bodyHtml) || bodyPlain);
                    setBodyHtml("");
                    setEditingHtmlSource(false);
                  }}
                >
                  切回纯文本
                </button>
              </div>

              {editingHtmlSource ? (
                <textarea
                  className="compose-html-source-textarea"
                  value={bodyHtml}
                  spellCheck={false}
                  onChange={(e) => {
                    const val = e.target.value;
                    setBodyHtml(val);
                    setBodyPlain(stripHtmlForPlain(val));
                  }}
                />
              ) : (
                <div className="compose-html-preview-scroll">
                  <div className="compose-html-paper">
                    <HtmlMailView html={bodyHtml} status="inbox" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <textarea
              className="compose-plain-canvas"
              placeholder="写邮件正文…（如需让 AI 帮写或排版精美 HTML 卡片/表格，直接点击下方「AI 帮写」在右侧对话即可）"
              value={bodyPlain}
              onChange={(e) => setBodyPlain(e.target.value)}
            />
          )}
        </div>

        {/* 附件条（仅在有附件时出现） */}
        {pendingAttachments.length > 0 && (
          <div className="compose-att-strip">
            <PendingAttachmentsBar
              items={pendingAttachments}
              onRemove={(id) => setPendingAttachments((prev) => prev.filter((x) => x.id !== id))}
              onClear={() => setPendingAttachments([])}
              onPreviewImage={(item) => setLightbox(item)}
            />
          </div>
        )}

        {/* 出站 DLP 拦截确认条（仅在命中敏感泄露风险时出现） */}
        {dlpBlockMessage && (
          <div className="compose-dlp-alert">
            <IconAlert size={14} />
            <span>出站隐私提醒：{dlpBlockMessage}</span>
            <div className="compose-dlp-actions">
              <button
                type="button"
                className="ghost-btn compact-btn"
                onClick={() => setDlpBlockMessage(null)}
              >
                返回修改
              </button>
              <button
                type="button"
                className="soft-btn compact-btn danger-text"
                onClick={() => void executeSend(true)}
              >
                确认无误仍发送
              </button>
            </div>
          </div>
        )}

        {/* 极简底栏 */}
        <footer className="compose-footer">
          <div className="compose-footer-left">
            <button
              type="button"
              className="ghost-btn compact-btn"
              onClick={() => fileInputRef.current?.click()}
              title="添加本地附件（支持直接拖拽或 Ctrl+V 粘贴图片）"
            >
              <IconFolder size={14} />
              <span>附件{pendingAttachments.length > 0 ? ` (${pendingAttachments.length})` : ""}</span>
            </button>

            <button
              type="button"
              className="ghost-btn compact-btn"
              onClick={() => api.startScreenSnip().catch(() => {})}
              title="屏幕截图粘贴为附件"
            >
              <IconScissors size={14} />
              <span>截图</span>
            </button>

            {undoStack.length > 0 && (
              <button
                type="button"
                className="ghost-btn compact-btn"
                onClick={handleUndo}
                title="撤销上一次 AI 或模板修改"
              >
                <IconUndo size={13} />
                <span>撤销</span>
              </button>
            )}

            <button
              type="button"
              className={`compose-ai-trigger ${agentDockOpen ? "active" : ""}`}
              onClick={() => onSummonGlobalAgent()}
              title="向右展开全局 AI 助手协助写信或生成 HTML 邮件"
            >
              <IconSparkles size={13} />
              <span>{agentDockOpen ? "右侧 AI 联动中" : "AI 帮写 / HTML"}</span>
            </button>
          </div>

          <div className="compose-footer-right">
            <span className="compose-shortcut-hint">Ctrl + Enter</span>
            <button
              type="button"
              className="primary-btn compose-send-btn"
              disabled={sending}
              onClick={() => void executeSend(false)}
            >
              <IconSend size={14} />
              <span>{sending ? "发送中…" : "发送"}</span>
            </button>
          </div>
        </footer>
      </div>

      {lightbox && (
        <AttachmentLightbox item={lightbox} onClose={() => setLightbox(null)} notify={notify} />
      )}
    </section>
  );
}
