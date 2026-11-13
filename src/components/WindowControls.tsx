import { useEffect, useState, type MouseEvent } from "react";
import { api } from "../api";

const INTERACTIVE_SELECTOR =
  'button, input, textarea, select, a, label, code, [role="button"], .no-drag';

/** 在空白顶栏、导航侧栏或卡片间距处按住左键拖动无边框窗口 */
export function startWindowDrag(e: MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (!target || target.closest(INTERACTIVE_SELECTOR)) return;
  if (e.detail >= 2) return;
  api.windowAction("drag").catch(() => {});
}

/** 双击顶栏空白区域切换最大化 / 还原 */
export function toggleWindowMaximize(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target || target.closest(INTERACTIVE_SELECTOR)) return;
  api
    .windowAction("toggle_maximize")
    .then((max) => window.dispatchEvent(new CustomEvent("mailchat-win-max", { detail: max })))
    .catch(() => {});
}

/** 融入右上角卡片顶栏的轻量无边框窗口控制键（无独立标题横条） */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const sync = () => {
      api
        .windowAction("is_maximized")
        .then(setMaximized)
        .catch(() => {});
    };
    const onCustom = (ev: Event) => {
      const detail = (ev as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setMaximized(detail);
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("mailchat-win-max", onCustom);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("mailchat-win-max", onCustom);
    };
  }, []);

  return (
    <div className="win-controls no-drag" aria-label="窗口控制">
      <button
        type="button"
        className="win-ctl"
        onClick={() => api.windowAction("minimize")}
        title="最小化"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.35">
          <line x1="1.5" y1="6" x2="10.5" y2="6" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        className="win-ctl"
        onClick={async () => {
          try {
            setMaximized(await api.windowAction("toggle_maximize"));
          } catch {
            // ignore in plain browser preview
          }
        }}
        title={maximized ? "向下还原" : "最大化"}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <rect x="1.8" y="3.4" width="6.8" height="6.8" rx="1.2" />
            <path d="M3.8 3.4V2.5c0-.6.5-1 1-1h4.7c.6 0 1 .4 1 1v4.7c0 .5-.4 1-1 1H8.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="win-ctl close"
        onClick={() => api.windowAction("close")}
        title="关闭"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
