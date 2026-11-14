import { useEffect, useState } from "react";
import { api } from "../api";
import type { AttachmentMeta, Message } from "../types";
import { copyText } from "../util";
import { useContextMenu } from "./ContextMenu";
import {
  IconAlert,
  IconClose,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconFile,
  IconFolder,
  IconImage,
  IconTrash,
} from "./Icons";
import { highlightText } from "./MessageContent";

export interface PendingAttachmentItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  dataBase64: string;
  previewUrl?: string;
  isImage: boolean;
}

export interface LightboxItem {
  src: string;
  title: string;
  size?: number;
  messageId?: number;
  attachmentId?: string;
  savedPath?: string;
}

const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
const dataUrlCache = new Map<string, string>();
const savedPathOverrides = new Map<string, string>();

const DANGEROUS_EXTENSIONS = new Set([
  "exe",
  "msi",
  "msp",
  "bat",
  "cmd",
  "com",
  "scr",
  "pif",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "hta",
  "cpl",
  "jar",
  "reg",
  "lnk",
  "dll",
  "sys",
  "msc",
  "application",
  "appref-ms",
  "iso",
  "img",
  "vhd",
  "vhdx",
]);

const EXT_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

function attCacheKey(messageId: number, attId: string): string {
  return `${messageId}:${attId}`;
}

export function isDangerousAttachment(filename: string): boolean {
  const cleaned = filename.trim().replace(/[. ]+$/g, "");
  const idx = cleaned.lastIndexOf(".");
  if (idx === -1 || idx === cleaned.length - 1) return false;
  const ext = cleaned.slice(idx + 1).trim().toLowerCase();
  return DANGEROUS_EXTENSIONS.has(ext);
}

/** 将本会话刚刚由用户发出的图片内存预览绑定到新消息附件上，实现零落盘即时回显 */
export function cacheSentMessageImagePreviews(
  msg: Message,
  pending: PendingAttachmentItem[],
): void {
  const metas = msg.attachments;
  if (!metas || metas.length === 0 || pending.length === 0) return;
  const limit = Math.min(metas.length, pending.length);
  for (let i = 0; i < limit; i += 1) {
    const p = pending[i];
    const m = metas[i];
    if (p.isImage && p.previewUrl && m?.id) {
      dataUrlCache.set(attCacheKey(msg.id, m.id), p.previewUrl);
    }
  }
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtLabel(filename: string): string {
  const cleaned = filename.trim().replace(/[. ]+$/g, "");
  const idx = cleaned.lastIndexOf(".");
  if (idx === -1 || idx === cleaned.length - 1) return "FILE";
  return cleaned.slice(idx + 1).toUpperCase().slice(0, 5);
}

function inferMime(file: File): string {
  if (file.type && file.type.trim() !== "") return file.type.trim();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME_MAP[ext] || "application/octet-stream";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function filesToPendingAttachments(
  rawFiles: FileList | File[],
): Promise<{ items: PendingAttachmentItem[]; errors: string[] }> {
  const list = Array.from(rawFiles);
  const items: PendingAttachmentItem[] = [];
  const errors: string[] = [];

  for (const file of list) {
    if (file.size > MAX_SINGLE_FILE_BYTES) {
      errors.push(`「${file.name}」超过单文件 25 MB 邮件附件上限`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const commaIdx = dataUrl.indexOf(",");
      if (commaIdx === -1) {
        errors.push(`无法编码文件「${file.name}」`);
        continue;
      }
      const mime = inferMime(file);
      const isImage = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(mime);
      const fallbackName =
        file.name && file.name.trim() !== ""
          ? file.name.trim()
          : isImage
            ? `粘贴图片_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`
            : "未命名附件.bin";

      items.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: fallbackName,
        mime,
        size: file.size,
        dataBase64: dataUrl.slice(commaIdx + 1),
        previewUrl: isImage ? dataUrl : undefined,
        isImage,
      });
    } catch (e) {
      errors.push(String(e));
    }
  }

  return { items, errors };
}

async function copyDataUrlImageToClipboard(dataUrl: string): Promise<void> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width || 1;
  canvas.height = img.naturalHeight || img.height || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布初始化失败");
  ctx.drawImage(img, 0, 0);
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 转换失败"))), "image/png");
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
}

async function confirmAndSaveAttachment(
  messageId: number,
  att: AttachmentMeta,
  notify: (text: string, isError?: boolean) => void,
): Promise<AttachmentMeta | null> {
  if (isDangerousAttachment(att.filename)) {
    const ok = window.confirm(
      `安全警告：「${att.filename}」属于可执行程序或高风险脚本文件。\n\n运行未知来源的可执行文件可能导致设备感染木马或隐私泄露。确定仍要将其另存到本地吗？`,
    );
    if (!ok) return null;
  }
  const updated = await api.saveAttachmentAs(messageId, att.id);
  if (!updated) {
    // 用户在系统“另存为”窗口点击了取消
    return null;
  }
  if (updated.saved_path) {
    savedPathOverrides.set(attCacheKey(messageId, att.id), updated.saved_path);
  }
  notify(`已保存附件：${att.filename}`);
  return updated;
}

function getEffectiveSavedPath(messageId: number, att: AttachmentMeta): string {
  return savedPathOverrides.get(attCacheKey(messageId, att.id)) || att.saved_path || "";
}

export function PendingAttachmentsBar({
  items,
  onRemove,
  onClear,
  onPreviewImage,
}: {
  items: PendingAttachmentItem[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onPreviewImage?: (item: LightboxItem) => void;
}) {
  const { openContextMenu } = useContextMenu();
  if (items.length === 0) return null;
  const totalBytes = items.reduce((acc, it) => acc + it.size, 0);

  return (
    <div className="pending-att-bar">
      <div className="pending-att-head">
        <span>
          待发送附件 ({items.length}) · 共 {formatFileSize(totalBytes)}
        </span>
        {items.length > 1 && (
          <button type="button" className="text-link" onClick={onClear}>
            清空
          </button>
        )}
      </div>
      <div className="pending-att-list">
        {items.map((item) => (
          <div
            key={item.id}
            className={`pending-att-chip ${item.isImage ? "is-img" : ""}`}
            onContextMenu={(e) => {
              openContextMenu(e, [
                { kind: "header", label: item.filename, badge: formatFileSize(item.size) },
                item.isImage && item.previewUrl
                  ? {
                      label: "预览大图",
                      icon: <IconImage size={14} />,
                      onSelect: () =>
                        onPreviewImage?.({
                          src: item.previewUrl!,
                          title: item.filename,
                          size: item.size,
                        }),
                    }
                  : null,
                {
                  label: "复制文件名",
                  icon: <IconCopy size={14} />,
                  onSelect: () => {
                    void copyText(item.filename);
                  },
                },
                { kind: "divider" },
                {
                  label: "移除此附件",
                  icon: <IconTrash size={14} />,
                  danger: true,
                  onSelect: () => onRemove(item.id),
                },
                items.length > 1
                  ? {
                      label: `清空全部待发附件 (${items.length})`,
                      icon: <IconClose size={14} />,
                      danger: true,
                      onSelect: onClear,
                    }
                  : null,
              ]);
            }}
          >
            {item.isImage && item.previewUrl ? (
              <img
                src={item.previewUrl}
                alt={item.filename}
                className="pending-att-thumb"
                onClick={() =>
                  onPreviewImage?.({
                    src: item.previewUrl!,
                    title: item.filename,
                    size: item.size,
                  })
                }
                title="点击预览大图 · 右键更多操作"
              />
            ) : (
              <span className="pending-att-ext">{fileExtLabel(item.filename)}</span>
            )}
            <div className="pending-att-meta">
              <span className="pending-att-name" title={item.filename}>
                {item.filename}
              </span>
              <span className="pending-att-size">{formatFileSize(item.size)}</span>
            </div>
            <button
              type="button"
              className="pending-att-remove"
              onClick={() => onRemove(item.id)}
              title="移除此附件"
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImageAttachmentTile({
  messageId,
  att,
  onPreview,
  notify,
}: {
  messageId: number;
  att: AttachmentMeta;
  onPreview: (att: AttachmentMeta, dataUrl: string, messageId: number, savedPath?: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const { openContextMenu } = useContextMenu();
  const key = attCacheKey(messageId, att.id);
  const [dataUrl, setDataUrl] = useState<string | null>(() => dataUrlCache.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [savedPath, setSavedPath] = useState<string>(() => getEffectiveSavedPath(messageId, att));

  useEffect(() => {
    setDataUrl(dataUrlCache.get(key) ?? null);
    setSavedPath(getEffectiveSavedPath(messageId, att));
  }, [key, messageId, att]);

  const loadIntoMemory = async (openLightboxAfter: boolean) => {
    if (loading) return;
    if (dataUrl) {
      if (openLightboxAfter) {
        onPreview(att, dataUrl, messageId, savedPath);
      }
      return;
    }
    setLoading(true);
    try {
      const url = await api.previewAttachmentDataUrl(messageId, att.id);
      dataUrlCache.set(key, url);
      setDataUrl(url);
      if (openLightboxAfter) {
        onPreview(att, url, messageId, savedPath);
      }
    } catch (e) {
      notify(`加载图片预览失败：${e}`, true);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAs = async () => {
    try {
      const updated = await confirmAndSaveAttachment(messageId, att, notify);
      if (updated?.saved_path) {
        setSavedPath(updated.saved_path);
      }
    } catch (e) {
      notify(`保存图片失败：${e}`, true);
    }
  };

  return (
    <button
      type="button"
      className={`att-image-tile ${dataUrl ? "is-loaded" : "is-unloaded"}`}
      onClick={() => {
        if (dataUrl) {
          onPreview(att, dataUrl, messageId, savedPath);
        } else {
          void loadIntoMemory(false);
        }
      }}
      onContextMenu={(e) => {
        openContextMenu(e, [
          { kind: "header", label: att.filename, badge: formatFileSize(att.size) },
          dataUrl
            ? {
                label: "查看大图",
                icon: <IconImage size={14} />,
                accent: true,
                onSelect: () => onPreview(att, dataUrl, messageId, savedPath),
              }
            : {
                label: "加载图片预览（仅内存，不自动落盘）",
                icon: <IconImage size={14} />,
                accent: true,
                onSelect: () => void loadIntoMemory(false),
              },
          dataUrl
            ? {
                label: "复制图片到剪贴板",
                icon: <IconCopy size={14} />,
                onSelect: async () => {
                  try {
                    await copyDataUrlImageToClipboard(dataUrl);
                    notify("已复制图片到剪贴板");
                  } catch (err) {
                    notify(`复制图片失败：${err}`, true);
                  }
                },
              }
            : null,
          {
            label: "另存为…",
            icon: <IconDownload size={14} />,
            onSelect: () => void handleSaveAs(),
          },
          savedPath
            ? {
                label: "用系统默认查看器打开",
                icon: <IconExternalLink size={14} />,
                onSelect: () =>
                  api
                    .openSavedAttachment(messageId, att.id)
                    .catch((err) => notify(`打开图片失败：${err}`, true)),
              }
            : null,
          savedPath
            ? {
                label: "在文件夹中显示",
                icon: <IconFolder size={14} />,
                onSelect: () =>
                  api
                    .revealSavedAttachment(messageId, att.id)
                    .catch((err) => notify(`无法定位文件：${err}`, true)),
              }
            : null,
          { kind: "divider" },
          {
            label: "复制文件名",
            icon: <IconFile size={14} />,
            onSelect: async () => {
              await copyText(att.filename);
              notify("已复制文件名");
            },
          },
        ]);
      }}
      title={
        dataUrl
          ? `${att.filename} (${formatFileSize(att.size)}) · 点击查看大图，右键可另存为`
          : `${att.filename} (${formatFileSize(att.size)}) · 点击按需加载内存预览（不会自动下载到磁盘）`
      }
    >
      {dataUrl ? (
        <img src={dataUrl} alt={att.filename} loading="lazy" />
      ) : (
        <div className="att-image-placeholder">
          <IconImage size={18} />
          <div className="att-image-placeholder-meta">
            <span className="att-image-placeholder-name">{att.filename}</span>
            <span className="att-image-placeholder-hint">
              {loading ? "正在加载内存预览…" : `${formatFileSize(att.size)} · 点击加载预览`}
            </span>
          </div>
        </div>
      )}
    </button>
  );
}

function FileAttachmentCard({
  messageId,
  att,
  highlightQuery,
  notify,
}: {
  messageId: number;
  att: AttachmentMeta;
  highlightQuery?: string;
  notify: (text: string, isError?: boolean) => void;
}) {
  const { openContextMenu } = useContextMenu();
  const isDanger = isDangerousAttachment(att.filename);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string>(() => getEffectiveSavedPath(messageId, att));

  useEffect(() => {
    setSavedPath(getEffectiveSavedPath(messageId, att));
  }, [messageId, att]);

  const handleSaveAs = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await confirmAndSaveAttachment(messageId, att, notify);
      if (updated?.saved_path) {
        setSavedPath(updated.saved_path);
      }
    } catch (e) {
      notify(`下载附件失败：${e}`, true);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenSaved = async () => {
    if (isDanger) {
      notify("安全保护：禁止在邮件客户端内直接运行可执行程序或脚本附件", true);
      return;
    }
    try {
      await api.openSavedAttachment(messageId, att.id);
    } catch (e) {
      notify(`无法打开文件：${e}`, true);
    }
  };

  const handleRevealSaved = async () => {
    try {
      await api.revealSavedAttachment(messageId, att.id);
    } catch (e) {
      notify(`无法定位文件：${e}`, true);
    }
  };

  return (
    <div
      className={`att-file-card ${isDanger ? "is-danger" : ""}`}
      onContextMenu={(e) => {
        openContextMenu(e, [
          { kind: "header", label: att.filename, badge: formatFileSize(att.size) },
          {
            label: savedPath ? "重新另存为…" : "下载（另存为…）",
            icon: <IconDownload size={14} />,
            accent: !isDanger,
            danger: isDanger,
            onSelect: () => void handleSaveAs(),
          },
          savedPath && !isDanger
            ? {
                label: "打开已保存的文件",
                icon: <IconExternalLink size={14} />,
                onSelect: () => void handleOpenSaved(),
              }
            : null,
          savedPath
            ? {
                label: "在文件夹中显示",
                icon: <IconFolder size={14} />,
                onSelect: () => void handleRevealSaved(),
              }
            : null,
          { kind: "divider" },
          {
            label: "复制文件名",
            icon: <IconCopy size={14} />,
            onSelect: async () => {
              await copyText(att.filename);
              notify("已复制文件名");
            },
          },
        ]);
      }}
    >
      <div
        className={`att-file-badge ${isDanger ? "is-danger" : ""}`}
        title={isDanger ? "高危可执行或脚本附件（禁止自动下载与直接运行）" : att.filename}
      >
        {isDanger ? <IconAlert size={15} /> : <IconFile size={15} />}
        <span>{fileExtLabel(att.filename)}</span>
      </div>
      <div className="att-file-info" title={att.filename}>
        <div className="att-file-name">{highlightText(att.filename, highlightQuery)}</div>
        <div className={`att-file-sub ${isDanger ? "is-danger" : ""}`}>
          {isDanger
            ? `${formatFileSize(att.size)} · 高危可执行文件，请勿轻易下载运行`
            : `${formatFileSize(att.size)} · ${savedPath ? "已手动保存" : "未下载"}`}
        </div>
      </div>
      <div className="att-file-actions">
        {!savedPath ? (
          <button
            type="button"
            className={`att-download-btn ${isDanger ? "is-danger" : ""}`}
            onClick={() => void handleSaveAs()}
            disabled={saving}
            title="选择位置并手动另存到本地"
          >
            <IconDownload size={13} />
            <span>{saving ? "保存中…" : "下载"}</span>
          </button>
        ) : (
          <>
            {!isDanger && (
              <button
                type="button"
                className="tool-btn small"
                onClick={() => void handleOpenSaved()}
                title="用系统默认程序打开已保存的文件"
              >
                <IconExternalLink size={13} />
              </button>
            )}
            <button
              type="button"
              className="tool-btn small"
              onClick={() => void handleRevealSaved()}
              title="在文件夹中显示已保存的文件"
            >
              <IconFolder size={13} />
            </button>
            <button
              type="button"
              className="tool-btn small"
              onClick={() => void handleSaveAs()}
              disabled={saving}
              title="重新另存为…"
            >
              <IconDownload size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function BubbleAttachments({
  messageId,
  attachments,
  outgoing,
  highlightQuery,
  onPreviewImage,
  notify,
}: {
  messageId: number;
  attachments?: AttachmentMeta[];
  outgoing?: boolean;
  highlightQuery?: string;
  onPreviewImage: (
    att: AttachmentMeta,
    dataUrl: string,
    messageId: number,
    savedPath?: string,
  ) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter((a) => a.is_image && !isDangerousAttachment(a.filename));
  const files = attachments.filter((a) => !a.is_image || isDangerousAttachment(a.filename));

  return (
    <div className={`bubble-attachments ${outgoing ? "is-out" : "is-in"}`}>
      {images.length > 0 && (
        <div className={`att-image-grid ${images.length === 1 ? "single" : "multi"}`}>
          {images.map((img, idx) => (
            <ImageAttachmentTile
              key={img.id || `${messageId}-img-${idx}`}
              messageId={messageId}
              att={img}
              onPreview={onPreviewImage}
              notify={notify}
            />
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="att-file-list">
          {files.map((f, idx) => (
            <FileAttachmentCard
              key={f.id || `${messageId}-file-${idx}`}
              messageId={messageId}
              att={f}
              highlightQuery={highlightQuery}
              notify={notify}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DrawerThumb({
  messageId,
  att,
  onPreviewImage,
  notify,
}: {
  messageId: number;
  att: AttachmentMeta;
  onPreviewImage: (
    att: AttachmentMeta,
    dataUrl: string,
    messageId: number,
    savedPath?: string,
  ) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const { openContextMenu } = useContextMenu();
  const key = attCacheKey(messageId, att.id);
  const [dataUrl, setDataUrl] = useState<string | null>(() => dataUrlCache.get(key) ?? null);
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    const savedPath = getEffectiveSavedPath(messageId, att);
    if (dataUrl) {
      onPreviewImage(att, dataUrl, messageId, savedPath);
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const url = await api.previewAttachmentDataUrl(messageId, att.id);
      dataUrlCache.set(key, url);
      setDataUrl(url);
      onPreviewImage(att, url, messageId, savedPath);
    } catch (e) {
      notify(`加载图片预览失败：${e}`, true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      className="drawer-media-thumb"
      title={`${att.filename} (${formatFileSize(att.size)}) · 点击按需预览`}
      onClick={() => void handleOpen()}
      onContextMenu={(e) => {
        const savedPath = getEffectiveSavedPath(messageId, att);
        openContextMenu(e, [
          { kind: "header", label: att.filename, badge: formatFileSize(att.size) },
          {
            label: "预览大图",
            icon: <IconImage size={14} />,
            accent: true,
            onSelect: () => void handleOpen(),
          },
          dataUrl
            ? {
                label: "复制图片到剪贴板",
                icon: <IconCopy size={14} />,
                onSelect: async () => {
                  try {
                    await copyDataUrlImageToClipboard(dataUrl);
                    notify("已复制图片到剪贴板");
                  } catch (err) {
                    notify(`复制图片失败：${err}`, true);
                  }
                },
              }
            : null,
          {
            label: "另存为…",
            icon: <IconDownload size={14} />,
            onSelect: () => {
              confirmAndSaveAttachment(messageId, att, notify).catch((err) =>
                notify(`保存失败：${err}`, true),
              );
            },
          },
          savedPath
            ? {
                label: "在文件夹中显示",
                icon: <IconFolder size={14} />,
                onSelect: () =>
                  api
                    .revealSavedAttachment(messageId, att.id)
                    .catch((err) => notify(`定位失败：${err}`, true)),
              }
            : null,
          {
            label: "复制文件名",
            icon: <IconFile size={14} />,
            onSelect: async () => {
              await copyText(att.filename);
              notify("已复制文件名");
            },
          },
        ]);
      }}
    >
      {dataUrl ? <img src={dataUrl} alt={att.filename} /> : <IconImage size={16} />}
    </button>
  );
}

export function DrawerAttachmentList({
  messages,
  onPreviewImage,
  notify,
}: {
  messages: Message[];
  onPreviewImage: (
    att: AttachmentMeta,
    dataUrl: string,
    messageId: number,
    savedPath?: string,
  ) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const { openContextMenu } = useContextMenu();
  const [, setTick] = useState(0);

  const all: { messageId: number; att: AttachmentMeta }[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const atts = m.attachments;
    if (!atts) continue;
    for (const a of atts) {
      const k = `${m.id}:${a.id || a.filename}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push({ messageId: m.id, att: a });
    }
  }

  if (all.length === 0) {
    return <div className="drawer-empty-note">当前会话暂无往来图片或文件附件</div>;
  }

  const images = all.filter(
    ({ att }) => att.is_image && !isDangerousAttachment(att.filename),
  );
  const files = all.filter(
    ({ att }) => !att.is_image || isDangerousAttachment(att.filename),
  );

  const saveFromDrawer = async (messageId: number, att: AttachmentMeta) => {
    try {
      const updated = await confirmAndSaveAttachment(messageId, att, notify);
      if (updated) setTick((n) => n + 1);
    } catch (e) {
      notify(`下载失败：${e}`, true);
    }
  };

  return (
    <div className="drawer-att-wrap">
      {images.length > 0 && (
        <div className="drawer-media-grid">
          {images.slice(0, 12).map(({ messageId, att }) => (
            <DrawerThumb
              key={`${messageId}:${att.id}`}
              messageId={messageId}
              att={att}
              onPreviewImage={onPreviewImage}
              notify={notify}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="drawer-file-items">
          {files.slice(0, 12).map(({ messageId, att }) => {
            const isDanger = isDangerousAttachment(att.filename);
            const savedPath = getEffectiveSavedPath(messageId, att);
            return (
              <div
                key={`${messageId}:${att.id}`}
                className={`drawer-file-row ${isDanger ? "is-danger" : ""}`}
                onContextMenu={(e) => {
                  openContextMenu(e, [
                    { kind: "header", label: att.filename, badge: formatFileSize(att.size) },
                    {
                      label: savedPath ? "重新另存为…" : "下载（另存为…）",
                      icon: <IconDownload size={14} />,
                      accent: !isDanger,
                      danger: isDanger,
                      onSelect: () => void saveFromDrawer(messageId, att),
                    },
                    savedPath && !isDanger
                      ? {
                          label: "打开已保存的文件",
                          icon: <IconExternalLink size={14} />,
                          onSelect: () =>
                            api
                              .openSavedAttachment(messageId, att.id)
                              .catch((err) => notify(`打开失败：${err}`, true)),
                        }
                      : null,
                    savedPath
                      ? {
                          label: "在文件夹中显示",
                          icon: <IconFolder size={14} />,
                          onSelect: () =>
                            api
                              .revealSavedAttachment(messageId, att.id)
                              .catch((err) => notify(`定位失败：${err}`, true)),
                        }
                      : null,
                    {
                      label: "复制文件名",
                      icon: <IconCopy size={14} />,
                      onSelect: async () => {
                        await copyText(att.filename);
                        notify("已复制文件名");
                      },
                    },
                  ]);
                }}
              >
                {isDanger ? <IconAlert size={14} /> : <IconFile size={14} />}
                <span
                  className="drawer-file-name"
                  title={
                    isDanger
                      ? `${att.filename}（高危可执行文件，请勿轻易下载运行）`
                      : `${att.filename} (${formatFileSize(att.size)})`
                  }
                >
                  {att.filename}
                </span>
                <span className="drawer-file-size">{formatFileSize(att.size)}</span>
                {savedPath ? (
                  <button
                    type="button"
                    className="tool-btn small"
                    onClick={() =>
                      api
                        .revealSavedAttachment(messageId, att.id)
                        .catch((e) => notify(`定位失败：${e}`, true))
                    }
                    title="在文件夹中显示已保存的文件"
                  >
                    <IconFolder size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="tool-btn small"
                    onClick={() => void saveFromDrawer(messageId, att)}
                    title="手动另存到本地"
                  >
                    <IconDownload size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AttachmentLightbox({
  item,
  onClose,
  notify,
}: {
  item: LightboxItem | null;
  onClose: () => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const { openContextMenu } = useContextMenu();
  const [savedPath, setSavedPath] = useState<string>("");

  useEffect(() => {
    if (!item) {
      setSavedPath("");
      return;
    }
    const override =
      item.messageId && item.attachmentId
        ? savedPathOverrides.get(attCacheKey(item.messageId, item.attachmentId))
        : undefined;
    setSavedPath(override || item.savedPath || "");
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const canSaveRemote = Boolean(item.messageId && item.attachmentId);

  const handleSaveImageAs = async () => {
    if (!item.messageId || !item.attachmentId) return;
    try {
      const updated = await api.saveAttachmentAs(item.messageId, item.attachmentId);
      if (updated?.saved_path) {
        savedPathOverrides.set(attCacheKey(item.messageId, item.attachmentId), updated.saved_path);
        setSavedPath(updated.saved_path);
        notify(`已保存图片：${item.title}`);
      }
    } catch (e) {
      notify(`保存图片失败：${e}`, true);
    }
  };

  return (
    <div className="att-lightbox" onClick={onClose}>
      <div className="att-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="att-lightbox-title">
          {item.title}
          {item.size ? ` · ${formatFileSize(item.size)}` : ""}
        </span>
        <div className="att-lightbox-actions">
          {canSaveRemote && (
            <button type="button" className="soft-btn" onClick={() => void handleSaveImageAs()}>
              <IconDownload size={13} />
              <span>另存为…</span>
            </button>
          )}
          {canSaveRemote && savedPath && (
            <>
              <button
                type="button"
                className="soft-btn"
                onClick={() =>
                  api
                    .openSavedAttachment(item.messageId!, item.attachmentId!)
                    .catch((e) => notify(`打开失败：${e}`, true))
                }
              >
                <IconExternalLink size={13} />
                <span>默认查看器</span>
              </button>
              <button
                type="button"
                className="soft-btn"
                onClick={() =>
                  api
                    .revealSavedAttachment(item.messageId!, item.attachmentId!)
                    .catch((e) => notify(`定位失败：${e}`, true))
                }
              >
                <IconFolder size={13} />
                <span>打开所在文件夹</span>
              </button>
            </>
          )}
          <button type="button" className="tool-btn" onClick={onClose} title="关闭 (Esc)">
            <IconClose size={15} />
          </button>
        </div>
      </div>
      <img
        src={item.src}
        alt={item.title}
        className="att-lightbox-img"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          openContextMenu(e, [
            { kind: "header", label: item.title },
            {
              label: "复制图片到剪贴板",
              icon: <IconCopy size={14} />,
              accent: true,
              onSelect: async () => {
                try {
                  await copyDataUrlImageToClipboard(item.src);
                  notify("已复制图片到剪贴板");
                } catch (err) {
                  notify(`复制图片失败：${err}`, true);
                }
              },
            },
            canSaveRemote
              ? {
                  label: "另存为…",
                  icon: <IconDownload size={14} />,
                  onSelect: () => void handleSaveImageAs(),
                }
              : null,
            canSaveRemote && savedPath
              ? {
                  label: "用默认查看器打开",
                  icon: <IconExternalLink size={14} />,
                  onSelect: () =>
                    api
                      .openSavedAttachment(item.messageId!, item.attachmentId!)
                      .catch((err) => notify(`打开失败：${err}`, true)),
                }
              : null,
            canSaveRemote && savedPath
              ? {
                  label: "打开所在文件夹",
                  icon: <IconFolder size={14} />,
                  onSelect: () =>
                    api
                      .revealSavedAttachment(item.messageId!, item.attachmentId!)
                      .catch((err) => notify(`定位失败：${err}`, true)),
                }
              : null,
            { kind: "divider" },
            {
              label: "关闭大图预览",
              shortcut: "Esc",
              icon: <IconClose size={14} />,
              onSelect: onClose,
            },
          ]);
        }}
      />
    </div>
  );
}
