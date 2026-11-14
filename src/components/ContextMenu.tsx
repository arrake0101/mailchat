import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { copyText } from "../util";
import {
  IconChat,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconPaste,
  IconScissors,
  IconSelectAll,
  IconTrash,
} from "./Icons";

export interface ContextMenuActionItem {
  kind?: "item";
  id?: string;
  label: string;
  sublabel?: string;
  shortcut?: string;
  icon?: ReactNode;
  danger?: boolean;
  accent?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface ContextMenuDivider {
  kind: "divider";
}

export interface ContextMenuHeader {
  kind: "header";
  label: string;
  badge?: string;
}

export type ContextMenuEntry =
  | ContextMenuActionItem
  | ContextMenuDivider
  | ContextMenuHeader
  | null
  | undefined
  | false;

export type ContextMenuTrigger =
  | ReactMouseEvent<HTMLElement>
  | MouseEvent
  | { x: number; y: number };

interface NormalizedMenuState {
  x: number;
  y: number;
  items: Array<ContextMenuActionItem | ContextMenuDivider | ContextMenuHeader>;
}

interface ContextMenuApi {
  openContextMenu: (trigger: ContextMenuTrigger, entries: ContextMenuEntry[]) => void;
  closeContextMenu: () => void;
}

const ContextMenuContext = createContext<ContextMenuApi>({
  openContextMenu: () => {},
  closeContextMenu: () => {},
});

export function useContextMenu(): ContextMenuApi {
  return useContext(ContextMenuContext);
}

function normalizeEntries(
  entries: ContextMenuEntry[],
): Array<ContextMenuActionItem | ContextMenuDivider | ContextMenuHeader> {
  const filtered = entries.filter(Boolean) as Array<
    ContextMenuActionItem | ContextMenuDivider | ContextMenuHeader
  >;
  const out: Array<ContextMenuActionItem | ContextMenuDivider | ContextMenuHeader> = [];
  for (const item of filtered) {
    if (item.kind === "divider") {
      if (out.length === 0) continue;
      const prev = out[out.length - 1];
      if (prev.kind === "divider" || prev.kind === "header") continue;
      out.push(item);
    } else {
      out.push(item);
    }
  }
  while (out.length > 0 && out[out.length - 1].kind === "divider") {
    out.pop();
  }
  return out;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextEditableControl(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  }
  return false;
}

/** 更新受控 React input/textarea 的值并触发合成 onChange */
export function setNativeInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
  caretPos?: number,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  if (typeof caretPos === "number") {
    try {
      el.setSelectionRange(caretPos, caretPos);
    } catch {
      // 部分 input type（如 email/number）不支持 setSelectionRange，安全忽略
    }
  }
}

export function insertTextIntoControl(
  el: HTMLInputElement | HTMLTextAreaElement,
  inserted: string,
) {
  const val = el.value ?? "";
  let start = val.length;
  let end = val.length;
  try {
    if (typeof el.selectionStart === "number") start = el.selectionStart;
    if (typeof el.selectionEnd === "number") end = el.selectionEnd;
  } catch {
    // ignore
  }
  const next = val.slice(0, start) + inserted + val.slice(end);
  setNativeInputValue(el, next, start + inserted.length);
}

const SINGLE_EMAIL_RE = /^[^\s@<>()[\],;:"']+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const SINGLE_URL_RE = /^https?:\/\/[^\s<>"]+$/i;

export function ContextMenuProvider({
  children,
  notify,
  onStartChatWithEmail,
}: {
  children: ReactNode;
  notify?: (text: string, isError?: boolean) => void;
  onStartChatWithEmail?: (email: string) => void;
}) {
  const [menu, setMenu] = useState<NormalizedMenuState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const closeContextMenu = useCallback(() => {
    setMenu(null);
    setActiveIndex(-1);
  }, []);

  const openContextMenu = useCallback(
    (trigger: ContextMenuTrigger, entries: ContextMenuEntry[]) => {
      let x = 0;
      let y = 0;
      if ("clientX" in trigger && typeof trigger.clientX === "number") {
        trigger.preventDefault();
        trigger.stopPropagation();
        x = trigger.clientX;
        y = trigger.clientY;
      } else if ("x" in trigger) {
        x = trigger.x;
        y = trigger.y;
      }
      const normalized = normalizeEntries(entries);
      if (normalized.length === 0) {
        setMenu(null);
        return;
      }
      setPos({ left: x, top: y });
      setMenu({ x, y, items: normalized });
      setActiveIndex(-1);
    },
    [],
  );

  // 视口碰撞自适应定位：确保右缘与底缘永不溢出无边框窗口
  useLayoutEffect(() => {
    if (!menu || !surfaceRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextLeft = menu.x;
    let nextTop = menu.y;
    if (nextLeft + rect.width + margin > vw) {
      nextLeft = Math.max(margin, vw - rect.width - margin);
    }
    if (nextTop + rect.height + margin > vh) {
      nextTop = Math.max(margin, vh - rect.height - margin);
    }
    nextLeft = Math.max(margin, nextLeft);
    nextTop = Math.max(margin, nextTop);
    setPos({ left: Math.round(nextLeft), top: Math.round(nextTop) });
  }, [menu]);

  // 全局点击外部、滚动、缩放、失焦与键盘方向键支持
  useEffect(() => {
    if (!menu) return;

    const actionableIndices: number[] = [];
    menu.items.forEach((it, idx) => {
      if ((!it.kind || it.kind === "item") && !it.disabled) {
        actionableIndices.push(idx);
      }
    });

    const handlePointerDown = (e: PointerEvent) => {
      if (surfaceRef.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };

    const handleScrollOrWheel = (e: Event) => {
      if (surfaceRef.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        return;
      }
      if (actionableIndices.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => {
          const curPos = actionableIndices.indexOf(prev);
          const nextPos = curPos < 0 ? 0 : (curPos + 1) % actionableIndices.length;
          return actionableIndices[nextPos];
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => {
          const curPos = actionableIndices.indexOf(prev);
          const nextPos =
            curPos <= 0 ? actionableIndices.length - 1 : curPos - 1;
          return actionableIndices[nextPos];
        });
      } else if (e.key === "Enter" && activeIndex >= 0) {
        const item = menu.items[activeIndex];
        if (item && (!item.kind || item.kind === "item") && !item.disabled) {
          e.preventDefault();
          closeContextMenu();
          void item.onSelect();
        }
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", handleScrollOrWheel, true);
    window.addEventListener("wheel", handleScrollOrWheel, { passive: true });
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", handleScrollOrWheel, true);
      window.removeEventListener("wheel", handleScrollOrWheel);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menu, activeIndex, closeContextMenu]);

  // 全局兜底右键拦截：彻底屏蔽 WebView2 浏览器生硬菜单，并为输入框、超链接、选中文本提供智能菜单
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (surfaceRef.current?.contains(target)) {
        e.preventDefault();
        return;
      }

      e.preventDefault();

      // 1. 文本输入框 / 多行文本框智能编辑菜单
      const editable = target?.closest("input, textarea") ?? null;
      if (isTextEditableControl(editable)) {
        editable.focus();
        const isPassword =
          editable instanceof HTMLInputElement && editable.type === "password";
        const isReadOnly = editable.readOnly || editable.disabled;
        const val = editable.value ?? "";
        let selStart = 0;
        let selEnd = 0;
        let hasRange = false;
        try {
          selStart = editable.selectionStart ?? 0;
          selEnd = editable.selectionEnd ?? 0;
          hasRange = selEnd > selStart;
        } catch {
          hasRange = val.length > 0;
          selStart = 0;
          selEnd = val.length;
        }
        const selectedSlice = hasRange ? val.slice(selStart, selEnd) : "";

        openContextMenu({ x: e.clientX, y: e.clientY }, [
          {
            label: "剪切",
            shortcut: "Ctrl+X",
            icon: <IconScissors size={14} />,
            disabled: isReadOnly || isPassword || !hasRange,
            onSelect: async () => {
              await copyText(selectedSlice);
              const next = val.slice(0, selStart) + val.slice(selEnd);
              setNativeInputValue(editable, next, selStart);
            },
          },
          {
            label: "复制",
            shortcut: "Ctrl+C",
            icon: <IconCopy size={14} />,
            disabled: isPassword || !hasRange,
            onSelect: async () => {
              await copyText(selectedSlice);
            },
          },
          {
            label: "粘贴",
            shortcut: "Ctrl+V",
            icon: <IconPaste size={14} />,
            disabled: isReadOnly,
            onSelect: async () => {
              try {
                const clip = await navigator.clipboard.readText();
                if (clip) insertTextIntoControl(editable, clip);
              } catch {
                notify?.("读取系统剪贴板失败，请直接使用 Ctrl+V", true);
              }
            },
          },
          { kind: "divider" },
          {
            label: "全选",
            shortcut: "Ctrl+A",
            icon: <IconSelectAll size={14} />,
            disabled: val.length === 0,
            onSelect: () => {
              editable.focus();
              editable.select();
            },
          },
          !isReadOnly && val.length > 0
            ? {
                label: "清空输入",
                icon: <IconTrash size={14} />,
                danger: true,
                onSelect: () => setNativeInputValue(editable, "", 0),
              }
            : null,
        ]);
        return;
      }

      // 2. 超链接与选中文本智能识别
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      const href = anchor?.getAttribute("href")?.trim() || "";
      const selectedText = window.getSelection()?.toString().trim() ?? "";

      const fallbackEntries: ContextMenuEntry[] = [];

      if (selectedText) {
        fallbackEntries.push({
          label: "复制选中内容",
          shortcut: "Ctrl+C",
          icon: <IconCopy size={14} />,
          onSelect: async () => {
            await copyText(selectedText);
            notify?.("已复制选中文本");
          },
        });

        const cleanedCandidate = selectedText.replace(/^[<\s]+|[>\s]+$/g, "");
        if (SINGLE_EMAIL_RE.test(cleanedCandidate)) {
          const email = cleanedCandidate.toLowerCase();
          if (onStartChatWithEmail) {
            fallbackEntries.push({
              label: `向 ${email} 发起单聊`,
              icon: <IconChat size={14} />,
              accent: true,
              onSelect: () => onStartChatWithEmail(email),
            });
          }
        } else if (SINGLE_URL_RE.test(cleanedCandidate)) {
          fallbackEntries.push({
            label: "在默认浏览器打开选中链接",
            icon: <IconExternalLink size={14} />,
            onSelect: () => {
              void api.openExternalUrl(cleanedCandidate);
            },
          });
        }
      }

      if (href) {
        if (fallbackEntries.length > 0) fallbackEntries.push({ kind: "divider" });
        if (href.toLowerCase().startsWith("mailto:")) {
          const mailAddr = href
            .slice(7)
            .split("?")[0]
            .trim()
            .toLowerCase();
          if (mailAddr && onStartChatWithEmail) {
            fallbackEntries.push({
              label: `向 ${mailAddr} 发起单聊`,
              icon: <IconChat size={14} />,
              accent: true,
              onSelect: () => onStartChatWithEmail(mailAddr),
            });
          }
          if (mailAddr) {
            fallbackEntries.push({
              label: "复制邮箱地址",
              icon: <IconCopy size={14} />,
              onSelect: async () => {
                await copyText(mailAddr);
                notify?.(`已复制邮箱 ${mailAddr}`);
              },
            });
          }
        } else if (/^https?:\/\//i.test(href)) {
          fallbackEntries.push({
            label: "在浏览器中打开链接",
            icon: <IconExternalLink size={14} />,
            onSelect: () => {
              void api.openExternalUrl(href);
            },
          });
          fallbackEntries.push({
            label: "复制链接地址",
            icon: <IconCopy size={14} />,
            onSelect: async () => {
              await copyText(href);
              notify?.("已复制链接地址");
            },
          });
        }
      }

      if (fallbackEntries.length > 0) {
        openContextMenu({ x: e.clientX, y: e.clientY }, fallbackEntries);
      } else {
        closeContextMenu();
      }
    };

    window.addEventListener("contextmenu", handleGlobalContextMenu);
    return () => window.removeEventListener("contextmenu", handleGlobalContextMenu);
  }, [openContextMenu, closeContextMenu, notify, onStartChatWithEmail]);

  const ctxValue = useMemo(
    () => ({ openContextMenu, closeContextMenu }),
    [openContextMenu, closeContextMenu],
  );

  return (
    <ContextMenuContext.Provider value={ctxValue}>
      {children}
      {menu &&
        createPortal(
          <div
            ref={surfaceRef}
            className="ctx-menu-surface"
            role="menu"
            style={{
              left: pos.left,
              top: pos.top,
              maxHeight: "calc(100vh - 16px)",
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {menu.items.map((entry, idx) => {
              if (entry.kind === "divider") {
                return <div key={`div-${idx}`} className="ctx-menu-divider" role="separator" />;
              }
              if (entry.kind === "header") {
                return (
                  <div key={`hdr-${idx}`} className="ctx-menu-header">
                    <span className="ctx-menu-header-text">{entry.label}</span>
                    {entry.badge && <span className="ctx-menu-header-badge">{entry.badge}</span>}
                  </div>
                );
              }
              const isFocused = activeIndex === idx;
              return (
                <button
                  key={entry.id ?? `act-${idx}`}
                  type="button"
                  role="menuitem"
                  disabled={entry.disabled}
                  className={[
                    "ctx-menu-item",
                    entry.danger ? "is-danger" : "",
                    entry.accent ? "is-accent" : "",
                    isFocused ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseDown={(e) => {
                    // 保留下层输入框光标选区或页面文本选区不丢失
                    e.preventDefault();
                  }}
                  onMouseEnter={() => {
                    if (!entry.disabled) setActiveIndex(idx);
                  }}
                  onClick={() => {
                    if (entry.disabled) return;
                    closeContextMenu();
                    void entry.onSelect();
                  }}
                >
                  <span className="ctx-menu-icon">
                    {entry.checked ? <IconCheck size={14} /> : entry.icon}
                  </span>
                  <span className="ctx-menu-body">
                    <span className="ctx-menu-label">{entry.label}</span>
                    {entry.sublabel && (
                      <span className="ctx-menu-sublabel">{entry.sublabel}</span>
                    )}
                  </span>
                  {entry.shortcut && (
                    <span className="ctx-menu-shortcut">{entry.shortcut}</span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </ContextMenuContext.Provider>
  );
}
