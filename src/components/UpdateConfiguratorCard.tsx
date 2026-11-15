import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  ConfigDiffItem,
  UpdateChannel,
  UpdateConfig,
  UpdateStatusSnapshot,
} from "../types";
import { copyText } from "../util";
import {
  IconAlert,
  IconCheck,
  IconChevron,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconLock,
  IconRefresh,
  IconUpdate,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  auto_check: true,
  auto_download: false,
  check_interval_hours: 6,
  channel: "stable",
  skipped_version: "",
  custom_endpoint: "",
};

const INTERVAL_OPTIONS: { hours: number; label: string }[] = [
  { hours: 1, label: "每 1 小时" },
  { hours: 6, label: "每 6 小时" },
  { hours: 12, label: "每 12 小时" },
  { hours: 24, label: "每天" },
  { hours: 168, label: "每周" },
];

export function normalizeUpdateConfig(raw?: Partial<UpdateConfig> | null): UpdateConfig {
  const hrs = Number(raw?.check_interval_hours ?? DEFAULT_UPDATE_CONFIG.check_interval_hours);
  const clampedHours = Number.isFinite(hrs)
    ? Math.min(168, Math.max(1, Math.round(hrs)))
    : DEFAULT_UPDATE_CONFIG.check_interval_hours;
  const ch = String(raw?.channel ?? "stable").trim().toLowerCase();
  const channel: UpdateChannel = ch === "beta" || ch === "preview" ? "beta" : "stable";
  return {
    auto_check: raw?.auto_check ?? DEFAULT_UPDATE_CONFIG.auto_check,
    auto_download: raw?.auto_download ?? DEFAULT_UPDATE_CONFIG.auto_download,
    check_interval_hours: clampedHours,
    channel,
    skipped_version: String(raw?.skipped_version ?? "")
      .trim()
      .replace(/^[vV]/, ""),
    custom_endpoint: String(raw?.custom_endpoint ?? "").trim(),
  };
}

function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCheckTime(tsSecs?: number): string {
  if (!tsSecs || tsSecs <= 0) return "尚未检查";
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - tsSecs);
  if (diffSec < 30) return "刚刚检查";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const d = new Date(tsSecs * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function formatPubDate(raw?: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw.slice(0, 10);
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function UpdateConfiguratorCard({
  update: rawUpdate,
  status: externalStatus,
  changedSections,
  itemsByTarget,
  notify,
  onApplyUpdateConfig,
}: {
  update?: Partial<UpdateConfig> | null;
  status?: UpdateStatusSnapshot | null;
  changedSections?: Set<string>;
  itemsByTarget?: Map<string, ConfigDiffItem[]>;
  notify?: (text: string, isError?: boolean) => void;
  onApplyUpdateConfig: (next: UpdateConfig, summaryLabel: string) => Promise<void> | void;
}) {
  const cfg = normalizeUpdateConfig(rawUpdate);
  const [internalStatus, setInternalStatus] = useState<UpdateStatusSnapshot | null>(
    externalStatus ?? null,
  );
  const [busyCfg, setBusyCfg] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(cfg.custom_endpoint));
  const [endpointDraft, setEndpointDraft] = useState(cfg.custom_endpoint);
  const [notesExpanded, setNotesExpanded] = useState(true);

  const status = externalStatus ?? internalStatus;

  useEffect(() => {
    setEndpointDraft(cfg.custom_endpoint);
    if (cfg.custom_endpoint) {
      setAdvancedOpen(true);
    }
  }, [cfg.custom_endpoint]);

  useEffect(() => {
    if (externalStatus !== undefined) return;
    let alive = true;
    api
      .getUpdateStatus()
      .then((snap) => {
        if (alive) setInternalStatus(snap);
      })
      .catch(() => {});
    const un = listen<UpdateStatusSnapshot>("app-update-status", (ev) => {
      if (alive) setInternalStatus(ev.payload);
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [externalStatus]);

  const hasDiff = (targetKey: string) => (itemsByTarget?.get(targetKey)?.length ?? 0) > 0;
  const sectionUpdated = changedSections?.has("update") ?? false;

  const isDefault =
    cfg.auto_check === DEFAULT_UPDATE_CONFIG.auto_check &&
    cfg.auto_download === DEFAULT_UPDATE_CONFIG.auto_download &&
    cfg.check_interval_hours === DEFAULT_UPDATE_CONFIG.check_interval_hours &&
    cfg.channel === DEFAULT_UPDATE_CONFIG.channel &&
    !cfg.skipped_version &&
    !cfg.custom_endpoint;

  const commitPatch = async (patch: Partial<UpdateConfig>, label: string) => {
    const next = normalizeUpdateConfig({ ...cfg, ...patch });
    setBusyCfg(true);
    try {
      await onApplyUpdateConfig(next, label);
    } finally {
      setBusyCfg(false);
    }
  };

  const phase = status?.phase ?? "idle";
  const isTransferring =
    phase === "checking" || phase === "downloading" || phase === "installing" || actionBusy;

  const handleManualCheck = async () => {
    if (isTransferring) return;
    setActionBusy(true);
    try {
      const snap = await api.checkAppUpdate(true);
      if (externalStatus === undefined) setInternalStatus(snap);
      if (snap.phase === "up_to_date") {
        notify?.(`当前 v${snap.current_version} 已是最新版本`);
      } else if (snap.latest_version) {
        notify?.(`发现新版本 v${snap.latest_version}`);
      } else if (snap.error) {
        notify?.(snap.error, true);
      }
    } catch (e) {
      notify?.(`检查更新失败：${e}`, true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadOnly = async () => {
    if (isTransferring) return;
    setActionBusy(true);
    try {
      const snap = await api.downloadAppUpdate();
      if (externalStatus === undefined) setInternalStatus(snap);
      notify?.("更新包已完成签名校验并缓存至本地，随时可点击立即重启升级");
    } catch (e) {
      notify?.(`下载更新包失败：${e}`, true);
    } finally {
      setActionBusy(false);
    }
  };

  const handleInstallNow = async () => {
    if (isTransferring) return;
    setActionBusy(true);
    try {
      notify?.("正在校验签名并应用更新，客户端即将自动重启…");
      const snap = await api.installAppUpdate();
      if (externalStatus === undefined) setInternalStatus(snap);
    } catch (e) {
      notify?.(`安装更新失败：${e}`, true);
      setActionBusy(false);
    }
  };

  const handleSkipVersion = async (ver: string) => {
    try {
      await commitPatch({ skipped_version: ver }, `已跳过 v${ver} 的顶栏更新提醒`);
      const snap = await api.getUpdateStatus().catch(() => null);
      if (snap && externalStatus === undefined) setInternalStatus(snap);
    } catch (e) {
      notify?.(`跳过版本失败：${e}`, true);
    }
  };

  const handleCopyCommand = async (cmd: string) => {
    const ok = await copyText(cmd);
    if (ok) {
      setCopiedCmd(true);
      notify?.(`已复制升级命令：${cmd}`);
      window.setTimeout(() => setCopiedCmd(false), 2000);
    }
  };

  const hasNewRelease =
    Boolean(status?.latest_version) &&
    (phase === "available" || phase === "downloading" || phase === "ready" || phase === "installing");

  const pubDateLabel = formatPubDate(status?.pub_date);
  const progressPct =
    phase === "ready" || phase === "installing"
      ? 100
      : Math.min(100, Math.max(0, status?.progress_percent ?? 0));

  return (
    <section
      id="mailchat-update-card"
      className={`ins-card update-config-card ${sectionUpdated ? "is-section-updated" : ""}`}
      data-config-section="update"
      data-config-target="update"
    >
      <div className="ins-card-head update-card-head-wrap">
        <div className="ins-card-title-row">
          <span className="theme-card-icon">
            <IconUpdate size={14} />
          </span>
          <span className="ins-card-title">客户端版本与自动更新</span>
          <span className="ins-code-pill">[update]</span>
          {sectionUpdated && <span className="ins-updated-badge">刚修改</span>}
        </div>
        <div className="theme-head-actions">
          <button
            type="button"
            className="soft-btn compact-btn"
            disabled={isTransferring}
            onClick={() => void handleManualCheck()}
            title="立即向远端签名清单或 GitHub Releases 检查最新版本"
          >
            <IconRefresh size={12} className={phase === "checking" ? "spin" : ""} />
            <span>{phase === "checking" ? "检查中…" : "检查更新"}</span>
          </button>
          {!isDefault && (
            <button
              type="button"
              className="ghost-btn compact-btn"
              disabled={busyCfg || isTransferring}
              onClick={() =>
                void commitPatch(DEFAULT_UPDATE_CONFIG, "已恢复默认自动更新策略")
              }
              title="恢复默认自动更新策略（每 6 小时检查、Stable 稳定版通道、手动确认安装）"
            >
              <span>默认</span>
            </button>
          )}
        </div>
      </div>

      {/* 版本与渠道遥测状态栏 */}
      <div className="update-telemetry-strip">
        <div className="update-ver-group">
          <span className="update-ver-chip">v{status?.current_version || "0.2.1"}</span>
          {status?.install_channel && (
            <span
              className="update-channel-chip"
              title={status.install_channel.hint}
            >
              {status.install_channel.channel_label}
            </span>
          )}
          <span
            className={`update-phase-pill phase-${phase}`}
          >
            {phase === "checking"
              ? "正在检查签名清单…"
              : phase === "up_to_date"
                ? "已是最新版本"
                : phase === "available"
                  ? `发现新版本 v${status?.latest_version}`
                  : phase === "downloading"
                    ? `正在下载 ${progressPct}%`
                    : phase === "ready"
                      ? `v${status?.latest_version} 已就绪`
                      : phase === "installing"
                        ? "正在应用更新并重启…"
                        : phase === "error"
                          ? "检查遇到网络异常"
                          : formatCheckTime(status?.last_checked_at)}
          </span>
        </div>
        {status && status.last_checked_at > 0 && phase !== "idle" && (
          <span className="update-last-checked">
            上次检查：{formatCheckTime(status.last_checked_at)}
          </span>
        )}
      </div>

      {/* 发现新版本 / 下载进度 / 安装确认横幅 */}
      {hasNewRelease && status && (
        <div className={`update-release-panel ${phase === "ready" ? "is-ready" : ""}`}>
          <div className="update-release-head">
            <div className="update-release-title-group">
              <span className="update-release-kicker">
                {phase === "ready" ? "更新包已就绪" : "发现可用更新"}
              </span>
              <div className="update-release-ver-line">
                <span className="old-ver">v{status.current_version}</span>
                <span className="ver-arrow">→</span>
                <strong className="new-ver">v{status.latest_version}</strong>
                {pubDateLabel && <span className="pub-date">{pubDateLabel}</span>}
                {status.is_skipped && (
                  <span className="skipped-tag">已静音顶栏提醒</span>
                )}
              </div>
            </div>

            <div className="update-trust-pill" title={status.install_channel.hint}>
              <IconLock size={12} />
              <span>
                {status.signature_verified && status.can_hot_install
                  ? "Minisign 签名强校验"
                  : status.install_channel.channel_label}
              </span>
            </div>
          </div>

          {(phase === "downloading" || phase === "ready" || phase === "installing") && (
            <div className="update-progress-wrap">
              <div className="update-progress-track">
                <div
                  className={`update-progress-fill ${phase === "ready" ? "ready" : ""}`}
                  style={{ width: `${Math.max(4, progressPct)}%` }}
                />
              </div>
              <div className="update-progress-meta">
                <span>
                  {phase === "ready"
                    ? "已完成下载与 Ed25519 签名校验"
                    : phase === "installing"
                      ? "正在安全停用后台连接并启动安装器…"
                      : `已下载 ${formatBytes(status.downloaded_bytes)}${
                          status.total_bytes ? ` / ${formatBytes(status.total_bytes)}` : ""
                        }`}
                </span>
                <strong>{progressPct}%</strong>
              </div>
            </div>
          )}

          {!status.can_hot_install && (
            <div className="update-channel-notice">
              {status.install_channel.hint}
            </div>
          )}

          {status.release_notes.trim() && (
            <div className="update-notes-box">
              <button
                type="button"
                className="update-notes-toggle"
                onClick={() => setNotesExpanded((v) => !v)}
              >
                <span>版本更新说明（Release Notes）</span>
                <IconChevron
                  size={12}
                  style={{
                    transform: notesExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.16s ease",
                  }}
                />
              </button>
              {notesExpanded && (
                <div className="update-notes-body">
                  <MarkdownText content={status.release_notes} />
                </div>
              )}
            </div>
          )}

          <div className="update-release-actions">
            {status.can_hot_install ? (
              <>
                <button
                  type="button"
                  className="primary-btn compact-btn"
                  disabled={phase === "downloading" || phase === "installing" || actionBusy}
                  onClick={() => void handleInstallNow()}
                >
                  <IconUpdate size={13} />
                  <span>
                    {phase === "installing"
                      ? "正在重启升级…"
                      : phase === "ready"
                        ? "立即重启完成升级"
                        : phase === "downloading"
                          ? "下载中…"
                          : "一键下载并重启升级"}
                  </span>
                </button>
                {phase === "available" && (
                  <button
                    type="button"
                    className="soft-btn compact-btn"
                    disabled={actionBusy}
                    onClick={() => void handleDownloadOnly()}
                    title="先在后台静默下载并校验签名，稍后空闲时再点击重启"
                  >
                    <IconDownload size={13} />
                    <span>仅预下载到本地</span>
                  </button>
                )}
              </>
            ) : (
              <>
                {status.install_channel.upgrade_command && (
                  <button
                    type="button"
                    className="primary-btn compact-btn"
                    onClick={() =>
                      void handleCopyCommand(status.install_channel.upgrade_command!)
                    }
                  >
                    {copiedCmd ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    <span>
                      {copiedCmd
                        ? "已复制命令"
                        : `复制命令：${status.install_channel.upgrade_command}`}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="soft-btn compact-btn"
                  onClick={() =>
                    void api.openExternalUrl(
                      status.download_url || status.release_page_url,
                    )
                  }
                >
                  <IconExternalLink size={13} />
                  <span>
                    {status.download_url ? "下载对应渠道安装包" : "前往 GitHub Releases"}
                  </span>
                </button>
              </>
            )}

            {status.latest_version && phase !== "installing" && (
              <button
                type="button"
                className="ghost-btn compact-btn"
                disabled={busyCfg}
                onClick={() =>
                  void handleSkipVersion(status.is_skipped ? "" : status.latest_version!)
                }
              >
                <span>{status.is_skipped ? "恢复此版本提醒" : "跳过此版本"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 检查异常横幅 */}
      {phase === "error" && status?.error && (
        <div className="update-error-banner">
          <div className="update-error-text">
            <IconAlert size={14} />
            <span>{status.error}</span>
          </div>
          <button
            type="button"
            className="ghost-btn compact-btn"
            onClick={() => void api.openExternalUrl(status.release_page_url)}
          >
            <IconExternalLink size={12} />
            <span>打开发布页</span>
          </button>
        </div>
      )}

      {/* 声明式 [update] 策略控制区 */}
      <div className="update-controls-grid">
        <label
          className={`update-switch-card ${hasDiff("update.auto_check") ? "is-field-updated" : ""}`}
          data-config-target="update.auto_check"
        >
          <div className="update-switch-copy">
            <div className="update-switch-title">
              <span>自动检查新版本</span>
              {hasDiff("update.auto_check") && <span className="ins-mini-dot" />}
            </div>
            <div className="update-switch-desc">
              启动后及后台定时静默检查签名清单，有新版本时在顶栏显示轻量胶囊提醒
            </div>
          </div>
          <input
            type="checkbox"
            checked={cfg.auto_check}
            disabled={busyCfg}
            onChange={(e) => {
              const checked = e.target.checked;
              void commitPatch(
                checked ? { auto_check: true } : { auto_check: false, auto_download: false },
                checked ? "已开启自动检查更新" : "已关闭自动检查更新",
              );
            }}
          />
        </label>

        <label
          className={`update-switch-card ${hasDiff("update.auto_download") ? "is-field-updated" : ""}`}
          data-config-target="update.auto_download"
        >
          <div className="update-switch-copy">
            <div className="update-switch-title">
              <span>后台静默预下载</span>
              {hasDiff("update.auto_download") && <span className="ins-mini-dot" />}
            </div>
            <div className="update-switch-desc">
              仅限支持签名热更新的安装版；预先缓存安装包，仍需你手动确认后才重启
            </div>
          </div>
          <input
            type="checkbox"
            checked={cfg.auto_download}
            disabled={busyCfg}
            onChange={(e) => {
              const checked = e.target.checked;
              void commitPatch(
                checked ? { auto_check: true, auto_download: true } : { auto_download: false },
                checked ? "已开启后台静默预下载" : "已改为手动确认后再下载更新包",
              );
            }}
          />
        </label>
      </div>

      <div className="theme-row-split update-row-split">
        <div
          className={`theme-control-block ${
            hasDiff("update.check_interval_hours") ? "is-field-updated" : ""
          }`}
          data-config-target="update.check_interval_hours"
        >
          <div className="theme-block-label">
            <span>定时检查频率</span>
            {hasDiff("update.check_interval_hours") && <span className="ins-mini-dot" />}
          </div>
          <div className="theme-pill-seg">
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.hours}
                type="button"
                className={`theme-pill-btn ${
                  cfg.check_interval_hours === opt.hours ? "active" : ""
                }`}
                disabled={busyCfg || !cfg.auto_check}
                onClick={() =>
                  void commitPatch(
                    { check_interval_hours: opt.hours },
                    `更新检查频率已设为${opt.label}`,
                  )
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div
          className={`theme-control-block ${hasDiff("update.channel") ? "is-field-updated" : ""}`}
          data-config-target="update.channel"
        >
          <div className="theme-block-label">
            <span>发布通道</span>
            {hasDiff("update.channel") && <span className="ins-mini-dot" />}
          </div>
          <div className="theme-pill-seg">
            <button
              type="button"
              className={`theme-pill-btn ${cfg.channel === "stable" ? "active" : ""}`}
              disabled={busyCfg}
              onClick={() =>
                void commitPatch({ channel: "stable" }, "已切换至 Stable 稳定版更新通道")
              }
            >
              Stable 稳定版
            </button>
            <button
              type="button"
              className={`theme-pill-btn ${cfg.channel === "beta" ? "active" : ""}`}
              disabled={busyCfg}
              onClick={() =>
                void commitPatch({ channel: "beta" }, "已切换至 Beta 预览测试版通道")
              }
            >
              Beta 测试版
            </button>
          </div>
        </div>
      </div>

      {cfg.skipped_version && (
        <div
          className={`update-skipped-bar ${
            hasDiff("update.skipped_version") ? "is-field-updated" : ""
          }`}
          data-config-target="update.skipped_version"
        >
          <span>
            当前已忽略版本 <code>v{cfg.skipped_version}</code> 的顶栏提醒
          </span>
          <button
            type="button"
            className="ghost-btn compact-btn"
            disabled={busyCfg}
            onClick={() => void handleSkipVersion("")}
          >
            <span>清除忽略</span>
          </button>
        </div>
      )}

      {/* 高级：私有镜像 / 企业自建更新清单端点 */}
      <div className="update-advanced-wrap" data-config-target="update.custom_endpoint">
        <button
          type="button"
          className="update-advanced-toggle"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <IconChevron
            size={12}
            style={{
              transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.16s ease",
            }}
          />
          <span>高级：自定义更新源 / 镜像端点（可选）</span>
          {cfg.custom_endpoint && <span className="ins-code-pill">已启用自定义源</span>}
        </button>

        {advancedOpen && (
          <div className="update-advanced-body">
            <div className="row">
              <input
                className="grow mono"
                placeholder="默认官方 GitHub Releases 签名端点（https://.../latest.json）"
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
              />
              <button
                type="button"
                className="soft-btn compact-btn"
                disabled={busyCfg || endpointDraft.trim() === cfg.custom_endpoint}
                onClick={() =>
                  void commitPatch(
                    { custom_endpoint: endpointDraft.trim() },
                    endpointDraft.trim()
                      ? "已保存自定义更新清单端点"
                      : "已恢复官方 GitHub Releases 更新端点",
                  )
                }
              >
                <span>保存端点</span>
              </button>
              {cfg.custom_endpoint && (
                <button
                  type="button"
                  className="ghost-btn compact-btn"
                  disabled={busyCfg}
                  onClick={() => {
                    setEndpointDraft("");
                    void commitPatch(
                      { custom_endpoint: "" },
                      "已恢复官方 GitHub Releases 更新端点",
                    );
                  }}
                >
                  <span>恢复官方源</span>
                </button>
              )}
            </div>
            <div className="muted tiny">
              支持配置企业内网或加速镜像的 <code>latest.json</code> HTTPS 地址；即使使用镜像源，客户端依然强制校验编译期嵌入的 Minisign 公钥签名。
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
