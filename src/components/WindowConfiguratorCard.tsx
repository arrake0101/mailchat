import { useState } from "react";
import type { ConfigDiffItem, WindowConfig } from "../types";
import { IconBell } from "./Icons";

export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  close_to_tray: true,
  tray_flash_on_message: true,
  taskbar_flash_on_message: true,
};

export function normalizeWindowConfig(raw?: Partial<WindowConfig> | null): WindowConfig {
  return {
    close_to_tray: raw?.close_to_tray ?? DEFAULT_WINDOW_CONFIG.close_to_tray,
    tray_flash_on_message:
      raw?.tray_flash_on_message ?? DEFAULT_WINDOW_CONFIG.tray_flash_on_message,
    taskbar_flash_on_message:
      raw?.taskbar_flash_on_message ?? DEFAULT_WINDOW_CONFIG.taskbar_flash_on_message,
  };
}

export function WindowConfiguratorCard({
  windowCfg: rawWindow,
  changedSections,
  itemsByTarget,
  onApplyWindowConfig,
}: {
  windowCfg?: Partial<WindowConfig> | null;
  changedSections?: Set<string>;
  itemsByTarget?: Map<string, ConfigDiffItem[]>;
  onApplyWindowConfig: (next: WindowConfig, summaryLabel: string) => Promise<void> | void;
}) {
  const cfg = normalizeWindowConfig(rawWindow);
  const [busy, setBusy] = useState(false);

  const hasDiff = (targetKey: string) => (itemsByTarget?.get(targetKey)?.length ?? 0) > 0;
  const sectionUpdated = changedSections?.has("window") ?? false;

  const isDefault =
    cfg.close_to_tray === DEFAULT_WINDOW_CONFIG.close_to_tray &&
    cfg.tray_flash_on_message === DEFAULT_WINDOW_CONFIG.tray_flash_on_message &&
    cfg.taskbar_flash_on_message === DEFAULT_WINDOW_CONFIG.taskbar_flash_on_message;

  const commitPatch = async (patch: Partial<WindowConfig>, label: string) => {
    const next = normalizeWindowConfig({ ...cfg, ...patch });
    setBusy(true);
    try {
      await onApplyWindowConfig(next, label);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="mailchat-window-card"
      className={`ins-card window-config-card ${sectionUpdated ? "is-section-updated" : ""}`}
      data-config-section="window"
      data-config-target="window"
    >
      <div className="ins-card-head update-card-head-wrap">
        <div className="ins-card-title-row">
          <span className="theme-card-icon">
            <IconBell size={14} />
          </span>
          <span className="ins-card-title">窗口关闭最小化与新消息闪烁提醒</span>
          <span className="ins-code-pill">[window]</span>
          {sectionUpdated && <span className="ins-updated-badge">刚修改</span>}
        </div>
        <div className="theme-head-actions">
          {!isDefault && (
            <button
              type="button"
              className="ghost-btn compact-btn"
              disabled={busy}
              onClick={() =>
                void commitPatch(
                  DEFAULT_WINDOW_CONFIG,
                  "已恢复默认系统托盘常驻与新消息闪烁策略",
                )
              }
              title="恢复默认行为（点击关闭隐藏到系统托盘、收到新消息时托盘与任务栏联动闪烁）"
            >
              <span>默认</span>
            </button>
          )}
        </div>
      </div>

      <div
        className={`theme-control-block ${
          hasDiff("window.close_to_tray") ? "is-field-updated" : ""
        }`}
        data-config-target="window.close_to_tray"
        style={{ marginBottom: 10 }}
      >
        <div className="theme-block-label">
          <span>点击右上角关闭按钮（×）时</span>
          {hasDiff("window.close_to_tray") && <span className="ins-mini-dot" />}
        </div>
        <div className="theme-pill-seg">
          <button
            type="button"
            className={`theme-pill-btn ${cfg.close_to_tray ? "active" : ""}`}
            disabled={busy}
            onClick={() =>
              void commitPatch(
                { close_to_tray: true },
                "点击关闭按钮已设为隐藏到右下角系统托盘",
              )
            }
          >
            隐藏到系统托盘（后台常驻收信）
          </button>
          <button
            type="button"
            className={`theme-pill-btn ${!cfg.close_to_tray ? "active" : ""}`}
            disabled={busy}
            onClick={() =>
              void commitPatch({ close_to_tray: false }, "点击关闭按钮已改为直接退出程序")
            }
          >
            直接退出程序
          </button>
        </div>
      </div>

      <div className="update-controls-grid">
        <label
          className={`update-switch-card ${
            hasDiff("window.tray_flash_on_message") ? "is-field-updated" : ""
          }`}
          data-config-target="window.tray_flash_on_message"
        >
          <div className="update-switch-copy">
            <div className="update-switch-title">
              <span>系统托盘图标闪动</span>
              {hasDiff("window.tray_flash_on_message") && <span className="ins-mini-dot" />}
            </div>
            <div className="update-switch-desc">
              仅「消息」列表收到新来信且窗口隐藏/失焦时，右下角托盘图标交替闪动（免打扰通知与拦截邮件不闪），点击托盘或切回窗口即停
            </div>
          </div>
          <input
            type="checkbox"
            checked={cfg.tray_flash_on_message}
            disabled={busy}
            onChange={(e) => {
              const checked = e.target.checked;
              void commitPatch(
                { tray_flash_on_message: checked },
                checked ? "已开启新消息系统托盘图标闪动" : "已关闭系统托盘图标闪动",
              );
            }}
          />
        </label>

        <label
          className={`update-switch-card ${
            hasDiff("window.taskbar_flash_on_message") ? "is-field-updated" : ""
          }`}
          data-config-target="window.taskbar_flash_on_message"
        >
          <div className="update-switch-copy">
            <div className="update-switch-title">
              <span>底部任务栏高亮闪烁</span>
              {hasDiff("window.taskbar_flash_on_message") && <span className="ins-mini-dot" />}
            </div>
            <div className="update-switch-desc">
              当窗口最小化在底部任务栏或处于后台未聚焦状态时，收到「消息」新来信同步触发系统任务栏高亮提醒
            </div>
          </div>
          <input
            type="checkbox"
            checked={cfg.taskbar_flash_on_message}
            disabled={busy}
            onChange={(e) => {
              const checked = e.target.checked;
              void commitPatch(
                { taskbar_flash_on_message: checked },
                checked ? "已开启底部任务栏高亮闪烁联动" : "已关闭底部任务栏高亮闪烁",
              );
            }}
          />
        </label>
      </div>
    </section>
  );
}
