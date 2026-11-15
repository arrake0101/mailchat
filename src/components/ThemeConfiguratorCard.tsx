import { useMemo, useRef, useState } from "react";
import {
  applyThemeToDom,
  buildSurfaceFromCustomPalette,
  COMMUNITY_PRESETS,
  DEFAULT_THEME_CONFIG,
  exportThemeTemplateToml,
  exportThemeToShareJson,
  normalizeThemeConfig,
  parseExternalThemeInput,
  resolveActiveThemeTemplate,
  resolveEffectiveMode,
  THEME_DENSITIES,
  THEME_FONT_SCALES,
  THEME_MODES,
  THEME_PRESETS,
} from "../theme";
import type { ConfigDiffItem, CustomThemePalette, ThemeConfig } from "../types";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconFolder,
  IconMonitor,
  IconMoon,
  IconPalette,
  IconPaste,
  IconPlus,
  IconRefresh,
  IconSun,
} from "./Icons";

export function ThemeConfiguratorCard({
  theme: rawTheme,
  changedSections,
  itemsByTarget,
  notify,
  onApplyTheme,
}: {
  theme?: Partial<ThemeConfig> | null;
  changedSections?: Set<string>;
  itemsByTarget?: Map<string, ConfigDiffItem[]>;
  notify?: (text: string, isError?: boolean) => void;
  onApplyTheme: (next: ThemeConfig, summaryLabel: string) => Promise<void> | void;
}) {
  const theme = normalizeThemeConfig(rawTheme);
  const resolvedMode = resolveEffectiveMode(theme.mode);
  const customThemes = theme.custom_themes ?? [];
  const activeTemplate = useMemo(
    () => resolveActiveThemeTemplate(theme, resolvedMode),
    [theme, resolvedMode],
  );

  const [busy, setBusy] = useState(false);

  // 主题模板加载工作台状态
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<"paste" | "community">("paste");
  const [rawSnippet, setRawSnippet] = useState("");
  const [fileHintName, setFileHintName] = useState("");
  const [customNameOverride, setCustomNameOverride] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [copiedShare, setCopiedShare] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedPreview = useMemo(() => {
    if (!rawSnippet.trim()) return null;
    return parseExternalThemeInput(rawSnippet, customNameOverride.trim() || fileHintName);
  }, [rawSnippet, customNameOverride, fileHintName]);

  const isDefault =
    theme.mode === DEFAULT_THEME_CONFIG.mode &&
    theme.preset === DEFAULT_THEME_CONFIG.preset &&
    theme.density === DEFAULT_THEME_CONFIG.density &&
    theme.font_scale === DEFAULT_THEME_CONFIG.font_scale;

  const hasDiff = (targetKey: string) => (itemsByTarget?.get(targetKey)?.length ?? 0) > 0;
  const sectionUpdated = changedSections?.has("theme") ?? false;

  const commitPatch = async (patch: Partial<ThemeConfig>, label: string) => {
    const next = normalizeThemeConfig({ ...theme, ...patch });
    applyThemeToDom(next);
    setBusy(true);
    try {
      await onApplyTheme(next, label);
    } finally {
      setBusy(false);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      setFileHintName(file.name);
      setRawSnippet(text);
      const res = parseExternalThemeInput(text, file.name);
      if (res.ok) {
        setCustomNameOverride(res.palette.name);
        setImportMsg(`已解析「${file.name}」（${res.formatLabel}），点击下方按钮即可加载启用`);
      } else {
        setImportMsg(res.error);
      }
    } catch {
      setImportMsg("读取主题模板文件失败，请确认文件为 UTF-8 文本格式");
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setImportMsg("剪贴板为空，请先复制外部主题模板 TOML / JSON / CSS 代码");
        return;
      }
      setRawSnippet(text);
      const res = parseExternalThemeInput(text);
      if (res.ok) {
        if (!customNameOverride.trim()) {
          setCustomNameOverride(res.palette.name);
        }
        setImportMsg(`已识别 ${res.formatLabel}：「${res.palette.name}」`);
      } else {
        setImportMsg(res.error);
      }
    } catch {
      setImportMsg("无法直接读取剪贴板，请在下方文本框按 Ctrl+V 粘贴模板内容");
    }
  };

  const handleApplyImportedTemplate = async () => {
    if (!parsedPreview || !parsedPreview.ok) return;
    const finalName = customNameOverride.trim() || parsedPreview.palette.name;
    const palette: CustomThemePalette = {
      ...parsedPreview.palette,
      name: finalName,
    };
    const mergedList = [...customThemes.filter((c) => c.id !== palette.id), palette];
    const nextPatch: Partial<ThemeConfig> = {
      custom_themes: mergedList,
      preset: palette.id,
      mode: palette.base_mode === "dark" ? "dark" : "light",
      ...(parsedPreview.density ? { density: parsedPreview.density } : {}),
      ...(parsedPreview.font_scale ? { font_scale: parsedPreview.font_scale } : {}),
    };
    await commitPatch(nextPatch, `已加载并启用主题模板「${palette.name}」`);
    setRawSnippet("");
    setCustomNameOverride("");
    setFileHintName("");
    setImportMsg(null);
    setImportOpen(false);
  };

  const handleRemoveCustomTheme = (target: CustomThemePalette, ev: React.MouseEvent) => {
    ev.stopPropagation();
    const nextList = customThemes.filter((x) => x.id !== target.id);
    const fallbackPreset = theme.preset === target.id ? "mist" : theme.preset;
    void commitPatch(
      {
        custom_themes: nextList,
        preset: fallbackPreset,
      },
      `已移除主题模板「${target.name}」`,
    );
  };

  const handleCopyShareTemplate = async () => {
    const jsonText = exportThemeToShareJson(theme);
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopiedShare(true);
      notify?.("已复制当前主题模板代码，可直接分享给他人加载");
      setTimeout(() => setCopiedShare(false), 1800);
    } catch {
      setImportOpen(true);
      setImportTab("paste");
      setRawSnippet(jsonText);
      setImportMsg("已生成当前主题模板代码，可全选复制分享给他人");
    }
  };

  const handleDownloadTemplateFile = (format: "toml" | "json") => {
    const filename = `${theme.preset || "mailchat"}.mailchat-theme.${format}`;
    const content =
      format === "toml" ? exportThemeTemplateToml(theme) : exportThemeToShareJson(theme);
    const mime = format === "toml" ? "application/toml;charset=utf-8" : "application/json;charset=utf-8";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify?.(`已导出主题模板文件 ${filename}`);
  };

  const activeCommunity = COMMUNITY_PRESETS.find((c) => c.id === theme.preset);

  return (
    <section
      className={`ins-card theme-config-card ${sectionUpdated ? "is-section-updated" : ""}`}
      data-config-section="theme"
      data-config-target="theme"
    >
      <div className="ins-card-head theme-card-head-wrap">
        <div className="ins-card-title-row">
          <span className="theme-card-icon">
            <IconPalette size={14} />
          </span>
          <span className="ins-card-title">界面主题与模板</span>
          <span className="ins-code-pill">[theme]</span>
          {sectionUpdated && <span className="ins-updated-badge">刚修改</span>}
        </div>
        <div className="theme-head-actions">
          <button
            type="button"
            className={`soft-btn compact-btn ${importOpen ? "active-soft" : ""}`}
            disabled={busy}
            onClick={() => {
              setImportOpen((v) => !v);
              setImportMsg(null);
            }}
            title="加载别人分享的主题模板文件 (.toml / .json / .css)、VS Code 主题或精选社区模板"
          >
            <IconPlus size={12} />
            <span>加载主题模板</span>
          </button>
          <button
            type="button"
            className="ghost-btn compact-btn"
            disabled={busy}
            onClick={() => void handleCopyShareTemplate()}
            title="复制当前生效的主题模板，可分享给他人直接加载"
          >
            {copiedShare ? <IconCheck size={12} /> : <IconCopy size={12} />}
            <span>{copiedShare ? "已复制模板" : "分享模板"}</span>
          </button>
          {!isDefault && (
            <button
              type="button"
              className="ghost-btn compact-btn"
              disabled={busy}
              onClick={() =>
                void commitPatch(
                  {
                    ...DEFAULT_THEME_CONFIG,
                    custom_themes: customThemes,
                  },
                  "已恢复默认主题模板",
                )
              }
              title="恢复默认清透雾蓝浅色模板（保留已导入的外部主题模板库）"
            >
              <IconRefresh size={12} />
              <span>默认</span>
            </button>
          )}
        </div>
      </div>

      {/* 外部主题模板加载与社区精选模板抽屉 */}
      {importOpen && (
        <div className="theme-import-drawer" data-config-target="theme.custom_themes">
          <div className="theme-import-top">
            <div className="theme-pill-seg theme-import-tabs">
              <button
                type="button"
                className={`theme-pill-btn ${importTab === "paste" ? "active" : ""}`}
                onClick={() => setImportTab("paste")}
              >
                导入模板文件 / 代码
              </button>
              <button
                type="button"
                className={`theme-pill-btn ${importTab === "community" ? "active" : ""}`}
                onClick={() => setImportTab("community")}
              >
                精选社区模板 ({COMMUNITY_PRESETS.length})
              </button>
            </div>
            <button
              type="button"
              className="ghost-btn compact-btn"
              onClick={() => setImportOpen(false)}
              title="收起面板"
            >
              <IconClose size={12} />
            </button>
          </div>

          {importTab === "paste" ? (
            <div className="theme-import-body">
              <input
                ref={fileInputRef}
                type="file"
                accept=".toml,.json,.jsonc,.css,.yaml,.yml,.txt"
                style={{ display: "none" }}
                onChange={handleFilePick}
              />
              <div className="theme-import-toolbar">
                <button
                  type="button"
                  className="soft-btn compact-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconFolder size={12} />
                  <span>选择模板文件 (.toml / .json / .css)</span>
                </button>
                <button
                  type="button"
                  className="soft-btn compact-btn"
                  onClick={() => void handlePasteClipboard()}
                >
                  <IconPaste size={12} />
                  <span>从剪贴板读取</span>
                </button>
                <button
                  type="button"
                  className="ghost-btn compact-btn"
                  onClick={() => handleDownloadTemplateFile("toml")}
                  title="将当前生效的主题导出为 .mailchat-theme.toml 模板文件"
                >
                  <IconDownload size={12} />
                  <span>导出 .toml 模板</span>
                </button>
                <button
                  type="button"
                  className="ghost-btn compact-btn"
                  onClick={() => handleDownloadTemplateFile("json")}
                  title="将当前生效的主题导出为 .mailchat-theme.json 模板文件"
                >
                  <IconDownload size={12} />
                  <span>导出 .json</span>
                </button>
              </div>

              <textarea
                className="theme-import-textarea"
                rows={4}
                value={rawSnippet}
                onChange={(e) => {
                  setRawSnippet(e.target.value);
                  setImportMsg(null);
                }}
                placeholder={`在此粘贴别人分享的主题模板，自动解析底色阶与配套主题色：\n1) MailChat 声明式模板 (.mailchat-theme.toml / .json)\n2) VS Code / Cursor 主题模板 *-color-theme.json\n3) Shadcn / Web :root { --background: ...; --primary: ... } CSS 模板`}
              />

              {importMsg && <div className="theme-import-hint">{importMsg}</div>}

              {parsedPreview && parsedPreview.ok && (
                <div className="theme-import-preview-card">
                  <div className="theme-import-preview-top">
                    <div className="theme-import-swatches">
                      <span
                        className="theme-import-chip"
                        style={{ background: parsedPreview.palette.canvas }}
                        title={`外框画布: ${parsedPreview.palette.canvas}`}
                      />
                      <span
                        className="theme-import-chip"
                        style={{ background: parsedPreview.palette.sidebar }}
                        title={`侧边列表: ${parsedPreview.palette.sidebar}`}
                      />
                      <span
                        className="theme-import-chip"
                        style={{ background: parsedPreview.palette.surface }}
                        title={`主界面: ${parsedPreview.palette.surface}`}
                      />
                      <span
                        className="theme-import-chip"
                        style={{ background: parsedPreview.palette.ink }}
                        title={`正文色: ${parsedPreview.palette.ink}`}
                      />
                      {parsedPreview.palette.accent && (
                        <span
                          className="theme-import-chip is-accent"
                          style={{ background: parsedPreview.palette.accent }}
                          title={`模板配套主题色: ${parsedPreview.palette.accent}`}
                        />
                      )}
                    </div>
                    <span className="ins-code-pill">
                      {parsedPreview.formatLabel} ·{" "}
                      {parsedPreview.palette.base_mode === "dark" ? "深色模板" : "浅色模板"}
                    </span>
                  </div>
                  <div className="theme-import-apply-row">
                    <input
                      className="theme-import-name-input"
                      value={customNameOverride}
                      placeholder={parsedPreview.palette.name}
                      onChange={(e) => setCustomNameOverride(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary-btn compact-btn"
                      disabled={busy}
                      onClick={() => void handleApplyImportedTemplate()}
                    >
                      <IconCheck size={12} />
                      <span>加载并启用模板</span>
                    </button>
                  </div>
                </div>
              )}

              {parsedPreview && !parsedPreview.ok && (
                <div className="theme-import-error">{parsedPreview.error}</div>
              )}
            </div>
          ) : (
            <div className="theme-community-grid">
              {COMMUNITY_PRESETS.map((cp) => {
                const active = theme.preset === cp.id;
                const pal = cp.defaultMode === "dark" ? cp.dark : cp.light;
                const tplAccent = cp.defaultMode === "dark" ? cp.darkAccent : cp.lightAccent;
                return (
                  <button
                    key={cp.id}
                    type="button"
                    className={`theme-preset-item ${active ? "active" : ""}`}
                    disabled={busy}
                    onClick={() => {
                      void commitPatch(
                        {
                          preset: cp.id,
                          mode: cp.defaultMode,
                        },
                        `已加载社区主题模板「${cp.label}」`,
                      );
                    }}
                    title={`${cp.label} · by ${cp.author} — ${cp.desc}`}
                  >
                    <span
                      className="theme-preset-miniwindow"
                      style={{
                        background: pal.canvasOuter,
                        borderColor: pal.hairline,
                      }}
                    >
                      <span className="mini-pane-list" style={{ background: pal.surfaceList }} />
                      <span className="mini-pane-main" style={{ background: pal.surfaceMain }}>
                        <span className="mini-accent-bar" style={{ background: tplAccent }} />
                      </span>
                    </span>
                    <span className="theme-preset-meta">
                      <span className="theme-preset-title">{cp.label}</span>
                      <span className="theme-preset-sub">{cp.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 1. 外观亮暗模式 */}
      <div
        className={`theme-block ${hasDiff("theme.mode") ? "is-field-updated" : ""}`}
        data-config-target="theme.mode"
      >
        <div className="theme-block-label-row">
          <span className="theme-block-label">外观模式</span>
          {hasDiff("theme.mode") && <span className="ins-updated-badge">AI 已改</span>}
        </div>
        <div className="theme-mode-seg">
          {THEME_MODES.map((m) => {
            const active = theme.mode === m.id;
            const ModeIcon = m.id === "light" ? IconSun : m.id === "dark" ? IconMoon : IconMonitor;
            return (
              <button
                key={m.id}
                type="button"
                className={`theme-mode-btn ${active ? "active" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (theme.mode !== m.id) {
                    void commitPatch({ mode: m.id }, `外观模式切换为「${m.label}」`);
                  }
                }}
              >
                <ModeIcon size={14} />
                <span className="theme-mode-name">{m.label}</span>
                <span className="theme-mode-desc">{m.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. 主题模板（官方内置 + 社区精选 + 已加载外部模板；主题强调色自动随模板联动） */}
      <div
        className={`theme-block ${hasDiff("theme.preset") || hasDiff("theme.custom_themes") ? "is-field-updated" : ""}`}
        data-config-target="theme.preset"
      >
        <div className="theme-block-label-row">
          <div className="theme-template-head-left">
            <span className="theme-block-label">主题模板</span>
            {(hasDiff("theme.preset") || hasDiff("theme.custom_themes")) && (
              <span className="ins-updated-badge">AI 已改</span>
            )}
          </div>
          <span
            className="theme-auto-accent-badge"
            title={`当前主题色 (${activeTemplate.accentHex}) 自动跟随「${activeTemplate.activeLabel}」模板`}
          >
            <span
              className="theme-auto-accent-dot"
              style={{ background: activeTemplate.accentHex }}
            />
            <span>主题色随模板自动联动</span>
          </span>
        </div>

        <div className="theme-preset-grid">
          {THEME_PRESETS.map((p) => {
            const active = theme.preset === p.id;
            const pal = resolvedMode === "dark" ? p.dark : p.light;
            const tplAccent = resolvedMode === "dark" ? p.darkAccent : p.lightAccent;
            return (
              <button
                key={p.id}
                type="button"
                className={`theme-preset-item ${active ? "active" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (theme.preset !== p.id) {
                    void commitPatch({ preset: p.id }, `主题模板切换为「${p.label}」`);
                  }
                }}
                title={`${p.label} (${p.id}) · ${p.desc}`}
              >
                <span
                  className="theme-preset-miniwindow"
                  style={{
                    background: pal.canvasOuter,
                    borderColor: pal.hairline,
                  }}
                >
                  <span className="mini-pane-list" style={{ background: pal.surfaceList }} />
                  <span className="mini-pane-main" style={{ background: pal.surfaceMain }}>
                    <span className="mini-accent-bar" style={{ background: tplAccent }} />
                  </span>
                </span>
                <span className="theme-preset-meta">
                  <span className="theme-preset-title">{p.label}</span>
                  <span className="theme-preset-sub">{p.desc}</span>
                </span>
              </button>
            );
          })}

          {activeCommunity ? (
            <button
              type="button"
              className="theme-preset-item active"
              disabled={busy}
              onClick={() => {
                setImportOpen(true);
                setImportTab("community");
              }}
              title={`当前启用社区主题模板：${activeCommunity.label}（点击切换其他社区模板）`}
            >
              <span
                className="theme-preset-miniwindow"
                style={{
                  background: (resolvedMode === "dark" ? activeCommunity.dark : activeCommunity.light)
                    .canvasOuter,
                  borderColor: (resolvedMode === "dark" ? activeCommunity.dark : activeCommunity.light)
                    .hairline,
                }}
              >
                <span
                  className="mini-pane-list"
                  style={{
                    background: (resolvedMode === "dark" ? activeCommunity.dark : activeCommunity.light)
                      .surfaceList,
                  }}
                />
                <span
                  className="mini-pane-main"
                  style={{
                    background: (resolvedMode === "dark" ? activeCommunity.dark : activeCommunity.light)
                      .surfaceMain,
                  }}
                >
                  <span
                    className="mini-accent-bar"
                    style={{
                      background:
                        resolvedMode === "dark"
                          ? activeCommunity.darkAccent
                          : activeCommunity.lightAccent,
                    }}
                  />
                </span>
              </span>
              <span className="theme-preset-meta">
                <span className="theme-preset-title">{activeCommunity.label}</span>
                <span className="theme-preset-sub">社区模板 · 点击更换</span>
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="theme-preset-item theme-more-templates-btn"
              disabled={busy}
              onClick={() => {
                setImportOpen(true);
                setImportTab("community");
              }}
              title="浏览并一键套用 Catppuccin、Tokyo Night、Nord、Dracula、Solarized 等精选社区主题模板"
            >
              <span className="theme-more-templates-icon">
                <IconPlus size={13} />
              </span>
              <span className="theme-preset-meta">
                <span className="theme-preset-title">更多社区模板</span>
                <span className="theme-preset-sub">Catppuccin / Nord 等 {COMMUNITY_PRESETS.length} 套</span>
              </span>
            </button>
          )}

          {customThemes.map((ct) => {
            const active = theme.preset === ct.id;
            const ctMode = ct.base_mode === "dark" ? "dark" : "light";
            const pal = buildSurfaceFromCustomPalette(ct, ctMode);
            const tplAccent = ct.accent || (ctMode === "dark" ? "#5b85ff" : "#3563e9");
            return (
              <div
                key={ct.id}
                role="button"
                tabIndex={0}
                className={`theme-preset-item theme-custom-preset-item ${active ? "active" : ""}`}
                onClick={() => {
                  if (!busy) {
                    void commitPatch(
                      {
                        preset: ct.id,
                        mode: ctMode,
                      },
                      `已启用外部主题模板「${ct.name}」`,
                    );
                  }
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !busy) {
                    e.preventDefault();
                    void commitPatch(
                      {
                        preset: ct.id,
                        mode: ctMode,
                      },
                      `已启用外部主题模板「${ct.name}」`,
                    );
                  }
                }}
                title={`已加载外部主题模板：${ct.name} (${ct.id})`}
              >
                <span
                  className="theme-preset-miniwindow"
                  style={{
                    background: pal.canvasOuter,
                    borderColor: pal.hairline,
                  }}
                >
                  <span className="mini-pane-list" style={{ background: pal.surfaceList }} />
                  <span className="mini-pane-main" style={{ background: pal.surfaceMain }}>
                    <span className="mini-accent-bar" style={{ background: tplAccent }} />
                  </span>
                </span>
                <span className="theme-preset-meta">
                  <span className="theme-preset-title">{ct.name}</span>
                  <span className="theme-preset-sub">
                    外部模板 · {ctMode === "dark" ? "深色" : "浅色"}
                  </span>
                </span>
                <button
                  type="button"
                  className="theme-custom-remove-btn"
                  onClick={(ev) => handleRemoveCustomTheme(ct, ev)}
                  title={`删除外部主题模板「${ct.name}」`}
                  aria-label={`删除外部主题模板 ${ct.name}`}
                >
                  <IconClose size={10} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. 排版密度与字号缩放 */}
      <div className="theme-dual-row">
        <div
          className={`theme-block ${hasDiff("theme.density") ? "is-field-updated" : ""}`}
          data-config-target="theme.density"
        >
          <div className="theme-block-label-row">
            <span className="theme-block-label">排版密度</span>
            {hasDiff("theme.density") && <span className="ins-updated-badge">AI 已改</span>}
          </div>
          <div className="theme-pill-seg">
            {THEME_DENSITIES.map((d) => {
              const active = theme.density === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`theme-pill-btn ${active ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    if (theme.density !== d.id) {
                      void commitPatch({ density: d.id }, `界面密度切换为「${d.label}」`);
                    }
                  }}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          className={`theme-block ${hasDiff("theme.font_scale") ? "is-field-updated" : ""}`}
          data-config-target="theme.font_scale"
        >
          <div className="theme-block-label-row">
            <span className="theme-block-label">全局字号</span>
            {hasDiff("theme.font_scale") && <span className="ins-updated-badge">AI 已改</span>}
          </div>
          <div className="theme-pill-seg">
            {THEME_FONT_SCALES.map((fs) => {
              const active = theme.font_scale === fs.id;
              return (
                <button
                  key={fs.id}
                  type="button"
                  className={`theme-pill-btn ${active ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    if (theme.font_scale !== fs.id) {
                      void commitPatch({ font_scale: fs.id }, `字号切换为「${fs.label}」`);
                    }
                  }}
                >
                  {fs.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
