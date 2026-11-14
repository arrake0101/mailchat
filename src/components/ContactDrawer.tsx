import { useEffect, useState } from "react";
import { api } from "../api";
import type { AttachmentMeta, ContactProfile, Conversation, Message, Status } from "../types";
import { Avatar } from "../util";
import { DrawerAttachmentList } from "./AttachmentItems";
import {
  IconBell,
  IconChat,
  IconCheck,
  IconClose,
  IconCopy,
  IconNote,
  IconSearch,
  IconShield,
} from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

const QUICK_TAGS = ["个人", "工作", "客户", "重要", "朋友"];

interface ContactDrawerProps {
  conv: Conversation;
  status: Status;
  messages: Message[];
  summarizing: boolean;
  onClose: () => void;
  onOpenSearch: () => void;
  onRunSummary: () => void;
  onPreviewImage: (
    att: AttachmentMeta,
    dataUrl: string,
    messageId: number,
    savedPath?: string,
  ) => void;
  onSaved: (profile: ContactProfile, prevMuted: boolean) => void;
  onChanged: () => void;
  notify: (text: string, isError?: boolean) => void;
}

export function ContactDrawer({
  conv,
  status,
  messages,
  summarizing,
  onClose,
  onOpenSearch,
  onRunSummary,
  onPreviewImage,
  onSaved,
  onChanged,
  notify,
}: ContactDrawerProps) {
  const [alias, setAlias] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(conv.muted);
  const [initialMuted, setInitialMuted] = useState(conv.muted);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfirmBlock(false);
    api
      .getContactProfile(conv.peer)
      .then((p) => {
        if (cancelled) return;
        setAlias(p.alias || "");
        setTag(p.tag || conv.category || "");
        setNote(p.note || "");
        setMuted(p.muted);
        setInitialMuted(p.muted);
      })
      .catch(() => {
        if (cancelled) return;
        setAlias("");
        setTag(conv.category || "");
        setNote(conv.note || "");
        setMuted(conv.muted);
        setInitialMuted(conv.muted);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conv.peer, conv.category, conv.muted, conv.note]);

  const rawSenderName =
    conv.raw_name ||
    [...messages]
      .reverse()
      .find((m) => !m.outgoing && m.from_name.trim() !== "")?.from_name ||
    "";

  const effectiveTitle = alias.trim() || rawSenderName || conv.name || conv.peer;

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(conv.peer);
      notify(`已复制邮箱：${conv.peer}`);
    } catch {
      notify(conv.peer);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await api.saveContactProfile({
        email: conv.peer,
        alias: alias.trim(),
        note: note.trim(),
        tag: tag.trim(),
        muted,
      });
      setInitialMuted(saved.muted);
      notify("联系人备注与偏好已保存");
      onSaved(saved, initialMuted);
    } catch (e) {
      notify(`保存失败：${e}`, true);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (fn: () => Promise<void>, successText: string) => {
    try {
      await fn();
      notify(successText);
      onClose();
      onChanged();
    } catch (e) {
      notify(String(e), true);
    }
  };

  return (
    <aside className="group-drawer contact-drawer">
      <div
        className="drawer-head"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <span>联系人详情</span>
        <button type="button" className="tool-btn small" onClick={onClose} title="关闭详情">
          <IconClose size={14} />
        </button>
      </div>

      <div className="drawer-body">
        <div className="contact-hero-card">
          <Avatar name={effectiveTitle} seed={conv.peer} size={46} />
          <div className="contact-hero-main">
            <div className="contact-hero-name">{effectiveTitle}</div>
            {alias.trim() && rawSenderName && rawSenderName !== alias.trim() && (
              <div className="contact-hero-origin">原发信昵称：{rawSenderName}</div>
            )}
            <div className="contact-hero-email-row">
              <span className="contact-hero-email" title={conv.peer}>
                {conv.peer}
              </span>
              <button type="button" className="tool-btn small" onClick={copyEmail} title="复制邮箱地址">
                <IconCopy size={12} />
              </button>
            </div>
            <div className="contact-hero-stats">
              <span>{messages.length} 条消息</span>
              <span>·</span>
              <span>
                {status === "inbox" ? "当前在消息" : status === "archived" ? "当前在通知" : "已拦截隔离"}
              </span>
            </div>
          </div>
        </div>

        <div className="contact-quick-grid">
          <button
            type="button"
            className="soft-btn"
            onClick={() => {
              onOpenSearch();
            }}
          >
            <IconSearch size={14} />
            <span>查找聊天内容</span>
          </button>
          <button
            type="button"
            className="soft-btn"
            onClick={onRunSummary}
            disabled={summarizing || messages.length < 2}
          >
            <IconNote size={14} />
            <span>{summarizing ? "提炼中…" : "提炼对话纪要"}</span>
          </button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">备注与分类</div>

          <label className="drawer-field">
            <span>备注名</span>
            <input
              value={alias}
              disabled={loading}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={rawSenderName ? `默认显示「${rawSenderName}」` : "设置易识别的备注姓名"}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
            />
          </label>

          <label className="drawer-field">
            <span>分类标签</span>
            <input
              value={tag}
              disabled={loading}
              onChange={(e) => setTag(e.target.value)}
              placeholder="例如：工作、个人、客户、重要"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
            />
            <div className="tag-preset-row">
              {QUICK_TAGS.map((preset) => {
                const active = tag.trim() === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    className={`contact-chip ${active ? "selected" : ""}`}
                    onClick={() => setTag(active ? "" : preset)}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </label>

          <label className="drawer-field">
            <span>详细备注</span>
            <textarea
              className="drawer-textarea"
              rows={3}
              value={note}
              disabled={loading}
              onChange={(e) => setNote(e.target.value)}
              placeholder="记录联系方式、所属团队、合作事项或备忘说明…"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
            />
          </label>

          <label className="drawer-switch">
            <input
              type="checkbox"
              checked={muted}
              disabled={loading}
              onChange={(e) => setMuted(e.target.checked)}
            />
            <div>
              <div className="drawer-switch-title">消息免打扰</div>
              <div className="drawer-switch-desc">开启后该联系人的新邮件自动静默归入「通知」列表</div>
            </div>
          </label>

          <button
            type="button"
            className="primary-btn"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? "保存中…" : "保存备注设置"}
          </button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">往来图片与文件</div>
          <DrawerAttachmentList messages={messages} onPreviewImage={onPreviewImage} notify={notify} />
        </div>

        <div className="drawer-section drawer-danger-zone">
          <div className="drawer-section-title">会话分组与安全</div>

          {status === "inbox" && conv.count > 0 && (
            <button
              type="button"
              className="soft-btn full-width-btn"
              onClick={() => runAction(() => api.moveConversation(conv.peer, "archived"), "已折叠至通知列表")}
            >
              <IconBell size={14} />
              <span>归入通知折叠</span>
            </button>
          )}

          {status === "archived" && (
            <button
              type="button"
              className="soft-btn full-width-btn"
              onClick={() => runAction(() => api.moveConversation(conv.peer, "inbox"), "已移回消息列表")}
            >
              <IconChat size={14} />
              <span>移回消息列表</span>
            </button>
          )}

          {status === "blocked" ? (
            <button
              type="button"
              className="primary-btn full-width-btn"
              onClick={() => runAction(() => api.allowSender(conv.peer), "已解除屏蔽并加入白名单")}
            >
              <IconCheck size={14} />
              <span>恢复并信任该发件人</span>
            </button>
          ) : !confirmBlock ? (
            <button
              type="button"
              className="ghost-btn danger-text full-width-btn danger-outline-btn"
              onClick={() => setConfirmBlock(true)}
            >
              <IconShield size={14} />
              <span>屏蔽该发件人</span>
            </button>
          ) : (
            <div className="confirm-block-box">
              <span>确定屏蔽 {conv.peer} 并将后续来信移入拦截箱吗？</span>
              <div className="row">
                <button
                  type="button"
                  className="soft-btn grow"
                  onClick={() => setConfirmBlock(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="danger-solid-btn grow"
                  onClick={() => runAction(() => api.blockSender(conv.peer), "已屏蔽该发件人")}
                >
                  确认屏蔽
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
