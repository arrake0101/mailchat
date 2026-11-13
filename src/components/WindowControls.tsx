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

/** 微信桌面端风格的外层顶部窗口栏（置顶 / 最小化 / 最大化 / 关闭独立于内容卡片之外） */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(false);

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
    api
      .windowAction("is_pinned")
      .then(setPinned)
      .catch(() => {});
    window.addEventListener("resize", sync);
    window.addEventListener("mailchat-win-max", onCustom);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("mailchat-win-max", onCustom);
    };
  }, []);

  return (
    <header
      className="window-titlebar"
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <div className="win-controls no-drag" aria-label="窗口控制">
        <button
          type="button"
          className={`win-ctl ${pinned ? "pinned" : ""}`}
          onClick={async () => {
            try {
              setPinned(await api.windowAction("toggle_pin"));
            } catch {
              // ignore in plain browser preview
            }
          }}
          title={pinned ? "取消置顶" : "置顶"}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill={pinned ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4.3 2.2h5.4" fill="none" />
            <path d="M5.2 2.2h3.6v3.1l1.6 1.6v.8H3.6v-.8l1.6-1.6V2.2Z" />
            <path d="M7 7.7v4.1" fill="none" />
          </svg>
        </button>

        <button
          type="button"
          className="win-ctl"
          onClick={() => api.windowAction("minimize").catch(() => {})}
          title="最小化"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="2" y1="6" x2="10" y2="6" />
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
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15">
              <rect x="1.8" y="3.5" width="6.7" height="6.7" rx="0.8" />
              <path d="M3.6 3.5V2.4c0-.5.4-.9.9-.9h5.2c.5 0 .9.4.9.9v5.2c0 .5-.4.9-.9.9H8.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2.1" y="2.1" width="7.8" height="7.8" rx="0.9" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="win-ctl close"
          onClick={() => api.windowAction("close").catch(() => {})}
          title="关闭"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M2.4 2.4l7.2 7.2M9.6 2.4l-7.2 7.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}
