import { useEffect, useState } from "react";
import { api } from "../api";
import type { AttachmentMeta, Message } from "../types";
import { IconClose, IconExternalLink, IconFile, IconFolder, IconImage } from "./Icons";
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
  relPath?: string;
}

const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
const dataUrlCache = new Map<string, string>();

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

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtLabel(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx === -1 || idx === filename.length - 1) return "FILE";
  return filename.slice(idx + 1).toUpperCase().slice(0, 5);
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

function useAttachmentDataUrl(relPath: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => dataUrlCache.get(relPath) ?? null);

  useEffect(() => {
    if (!enabled || !relPath) return;
    const cached = dataUrlCache.get(relPath);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    api
      .readAttachmentDataUrl(relPath)
      .then((res) => {
        if (!cancelled && res) {
          dataUrlCache.set(relPath, res);
          setUrl(res);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [relPath, enabled]);

  return url;
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
          <div key={item.id} className={`pending-att-chip ${item.isImage ? "is-img" : ""}`}>
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
                title="点击预览大图"
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
  att,
  onPreview,
  notify,
}: {
  att: AttachmentMeta;
  onPreview: (att: AttachmentMeta, dataUrl: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const dataUrl = useAttachmentDataUrl(att.rel_path, true);

  const handleOpen = async () => {
    if (dataUrl) {
      onPreview(att, dataUrl);
      return;
    }
    try {
      await api.openAttachment(att.rel_path);
    } catch (e) {
      notify(`打开图片失败：${e}`, true);
    }
  };

  return (
    <button
      type="button"
      className="att-image-tile"
      onClick={handleOpen}
      title={`${att.filename} (${formatFileSize(att.size)}) · 点击查看大图`}
    >
      {dataUrl ? (
        <img src={dataUrl} alt={att.filename} loading="lazy" />
      ) : (
        <div className="att-image-placeholder">
          <IconImage size={18} />
          <span>{att.filename}</span>
        </div>
      )}
    </button>
  );
}

export function BubbleAttachments({
  attachments,
  outgoing,
  highlightQuery,
  onPreviewImage,
  notify,
}: {
  attachments?: AttachmentMeta[];
  outgoing?: boolean;
  highlightQuery?: string;
  onPreviewImage: (att: AttachmentMeta, dataUrl: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter((a) => a.is_image);
  const files = attachments.filter((a) => !a.is_image);

  const openFile = async (relPath: string) => {
    try {
      await api.openAttachment(relPath);
    } catch (e) {
      notify(`无法打开文件：${e}`, true);
    }
  };

  const revealFile = async (relPath: string) => {
    try {
      await api.revealAttachment(relPath);
    } catch (e) {
      notify(`无法定位文件：${e}`, true);
    }
  };

  return (
    <div className={`bubble-attachments ${outgoing ? "is-out" : "is-in"}`}>
      {images.length > 0 && (
        <div className={`att-image-grid ${images.length === 1 ? "single" : "multi"}`}>
          {images.map((img) => (
            <ImageAttachmentTile key={img.id || img.rel_path} att={img} onPreview={onPreviewImage} notify={notify} />
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="att-file-list">
          {files.map((f) => (
            <div key={f.id || f.rel_path} className="att-file-card">
              <div className="att-file-badge" onClick={() => openFile(f.rel_path)} title="点击打开文件">
                <IconFile size={15} />
                <span>{fileExtLabel(f.filename)}</span>
              </div>
              <div className="att-file-info" onClick={() => openFile(f.rel_path)} title={f.filename}>
                <div className="att-file-name">{highlightText(f.filename, highlightQuery)}</div>
                <div className="att-file-sub">{formatFileSize(f.size)}</div>
              </div>
              <div className="att-file-actions">
                <button
                  type="button"
                  className="tool-btn small"
                  onClick={() => openFile(f.rel_path)}
                  title="用系统默认程序打开"
                >
                  <IconExternalLink size={13} />
                </button>
                <button
                  type="button"
                  className="tool-btn small"
                  onClick={() => revealFile(f.rel_path)}
                  title="在文件夹中显示"
                >
                  <IconFolder size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DrawerThumb({
  att,
  onPreviewImage,
  notify,
}: {
  att: AttachmentMeta;
  onPreviewImage: (att: AttachmentMeta, dataUrl: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const dataUrl = useAttachmentDataUrl(att.rel_path, true);
  return (
    <button
      type="button"
      className="drawer-media-thumb"
      title={`${att.filename} (${formatFileSize(att.size)})`}
      onClick={async () => {
        if (dataUrl) onPreviewImage(att, dataUrl);
        else {
          try {
            await api.openAttachment(att.rel_path);
          } catch (e) {
            notify(`打开失败：${e}`, true);
          }
        }
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
  onPreviewImage: (att: AttachmentMeta, dataUrl: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const all: AttachmentMeta[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const atts = messages[i].attachments;
    if (!atts) continue;
    for (const a of atts) {
      if (!a.rel_path || seen.has(a.rel_path)) continue;
      seen.add(a.rel_path);
      all.push(a);
    }
  }

  if (all.length === 0) {
    return <div className="drawer-empty-note">当前会话暂无往来图片或文件附件</div>;
  }

  const images = all.filter((a) => a.is_image);
  const files = all.filter((a) => !a.is_image);

  return (
    <div className="drawer-att-wrap">
      {images.length > 0 && (
        <div className="drawer-media-grid">
          {images.slice(0, 12).map((img) => (
            <DrawerThumb key={img.rel_path} att={img} onPreviewImage={onPreviewImage} notify={notify} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="drawer-file-items">
          {files.slice(0, 12).map((f) => (
            <div key={f.rel_path} className="drawer-file-row">
              <IconFile size={14} />
              <button
                type="button"
                className="drawer-file-name"
                onClick={() => api.openAttachment(f.rel_path).catch((e) => notify(`打开失败：${e}`, true))}
                title={`${f.filename} (${formatFileSize(f.size)})`}
              >
                {f.filename}
              </button>
              <span className="drawer-file-size">{formatFileSize(f.size)}</span>
              <button
                type="button"
                className="tool-btn small"
                onClick={() => api.revealAttachment(f.rel_path).catch((e) => notify(`定位失败：${e}`, true))}
                title="在文件夹中显示"
              >
                <IconFolder size={12} />
              </button>
            </div>
          ))}
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
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  return (
    <div className="att-lightbox" onClick={onClose}>
      <div className="att-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="att-lightbox-title">
          {item.title}
          {item.size ? ` · ${formatFileSize(item.size)}` : ""}
        </span>
        <div className="att-lightbox-actions">
          {item.relPath && (
            <>
              <button
                type="button"
                className="soft-btn"
                onClick={() => api.openAttachment(item.relPath!).catch((e) => notify(`打开失败：${e}`, true))}
              >
                <IconExternalLink size={13} />
                <span>默认查看器</span>
              </button>
              <button
                type="button"
                className="soft-btn"
                onClick={() => api.revealAttachment(item.relPath!).catch((e) => notify(`定位失败：${e}`, true))}
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
      />
    </div>
  );
}
