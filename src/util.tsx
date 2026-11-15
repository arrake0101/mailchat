import type { MouseEvent as ReactMouseEvent } from "react";
import type { GroupMember } from "./types";

// 低饱和柔和莫兰迪/石板色系，避免刺眼的 AI 模板高饱和色
const PALETTE = [
  "#5b7cfa",
  "#389886",
  "#d97757",
  "#7c69ef",
  "#4c8eda",
  "#c66b93",
  "#5c8d73",
];

const NAME_COLORS = [
  "#3b5bdb",
  "#0f766e",
  "#b45309",
  "#6d28d9",
  "#0369a1",
  "#9d174d",
  "#15803d",
];

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function senderColor(seed: string) {
  const idx = hash(seed) % NAME_COLORS.length;
  return `var(--sender-color-${idx}, ${NAME_COLORS[idx]})`;
}

export function Avatar({
  name,
  seed,
  size = 42,
  onClick,
  onContextMenu,
  title,
}: {
  name: string;
  seed: string;
  size?: number;
  onClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  title?: string;
}) {
  const ch = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      className={`avatar ${onClick || onContextMenu ? "clickable-avatar" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: PALETTE[hash(seed) % PALETTE.length],
      }}
    >
      {ch}
    </div>
  );
}

/** 安全复制文本到系统剪贴板（兼容剪贴板权限回退） */
export async function copyText(text: string): Promise<boolean> {
  const val = text ?? "";
  if (!val) return false;
  try {
    await navigator.clipboard.writeText(val);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = val;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 柔和圆角四宫格拼接群头像 */
export function GroupAvatar({
  members,
  seed,
  size = 42,
}: {
  members: GroupMember[];
  seed: string;
  size?: number;
}) {
  const tiles = [
    ...members.slice(0, 3).map((m) => ({
      label: (m.name.trim()[0] || m.email.trim()[0] || "?").toUpperCase(),
      color: PALETTE[hash(m.email || seed) % PALETTE.length],
    })),
    { label: "我", color: "#475569" },
  ].slice(0, 4);

  return (
    <div className="group-avatar" style={{ width: size, height: size }}>
      {tiles.map((t, idx) => (
        <span
          key={idx}
          className="group-avatar-tile"
          style={{ background: t.color, fontSize: Math.max(9, Math.round(size * 0.24)) }}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}

export function shortTime(ts: number) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

export function clockTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
