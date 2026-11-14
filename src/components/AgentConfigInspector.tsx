import { useEffect, useMemo, useRef, useState } from "react";
import { api, MODEL_PRESETS, PRESETS } from "../api";
import {
  mailSecretKey,
  type Account,
  type AccountSpec,
  type AgentConfig,
  type ConfigDiffItem,
  type ConfigDiffReport,
  type DeclarativeBundle,
  type DeclarativeConfigSpec,
  type GroupSpec,
  type MagpieProbeReport,
  type ProviderPresetId,
  type RuleKind,
  type SecretStatus,
  type TriageSpec,
} from "../types";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCode,
  IconExternalLink,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSliders,
  IconTrash,
} from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

export type InspectorTab = "visual" | "diff" | "toml";

export interface NormalizedDeclarativeSpec {
  active_account: string;
  accounts: AccountSpec[];
  agent: DeclarativeConfigSpec["agent"];
  triage: TriageSpec;
  groups: GroupSpec[];
}

export function normalizeDeclarativeSpec(
  raw?: DeclarativeConfigSpec | null,
): NormalizedDeclarativeSpec {
  return {
    active_account: raw?.active_account?.trim() ?? "",
    accounts: (raw?.accounts ?? []).map((a) => ({
      email: a.email ?? "",
      display_name: a.display_name ?? "",
      username: a.username || a.email || "",
      imap_host: a.imap_host ?? "",
      imap_port: a.imap_port || 993,
      smtp_host: a.smtp_host ?? "",
      smtp_port: a.smtp_port || 465,
      password_ref: a.password_ref || mailSecretKey(a.email),
    })),
    agent: {
      enabled: raw?.agent?.enabled ?? false,
      preset: raw?.agent?.preset || "deepseek",
      provider: raw?.agent?.provider || "openai",
      base_url: raw?.agent?.base_url ?? "",
      model: raw?.agent?.model || "deepseek-v4.1-flash",
      api_key_ref: raw?.agent?.api_key_ref ?? "secret:llm_deepseek",
      auto_draft: raw?.agent?.auto_draft ?? true,
      auto_block_sender: raw?.agent?.auto_block_sender ?? false,
      instructions: raw?.agent?.instructions ?? "",
      profiles: raw?.agent?.profiles ?? {},
    },
    triage: {
      allow_senders: raw?.triage?.allow_senders ?? [],
      block_senders: raw?.triage?.block_senders ?? [],
      block_domains: raw?.triage?.block_domains ?? [],
      block_keywords: raw?.triage?.block_keywords ?? [],
      archive_senders: raw?.triage?.archive_senders ?? [],
      archive_keywords: raw?.triage?.archive_keywords ?? [],
    },
    groups: (raw?.groups ?? []).map((g) => ({
      id: g.id ?? "",
      name: g.name ?? "未命名群聊",
      muted: Boolean(g.muted),
      members: g.members ?? [],
    })),
  };
}

/* ---------------- TOML 行级 LCS Diff 引擎 ---------------- */

interface DiffLine {
  kind: "same" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface DiffHunkRow {
  type: "line" | "section_ctx" | "skip";
  line?: DiffLine;
  sectionText?: string;
  skippedCount?: number;
}

function stripHeaderComments(tomlText: string): string[] {
  const rawLines = tomlText.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < rawLines.length && (rawLines[start].trim().startsWith("#") || rawLines[start].trim() === "")) {
    start++;
  }
  const body = rawLines.slice(start);
  while (body.length > 0 && body[body.length - 1].trim() === "") {
    body.pop();
  }
  return body;
}

function computeDiffLines(beforeToml: string, afterToml: string): DiffLine[] {
  const a = stripHeaderComments(beforeToml);
  const b = stripHeaderComments(afterToml);
  const n = a.length;
  const m = b.length;

  // 防御超大手动文本，正常 config.toml 仅 30~180 行
  if (n * m > 250000) {
    const fallback: DiffLine[] = [];
    a.forEach((t, idx) => fallback.push({ kind: "del", oldLine: idx + 1, text: t }));
    b.forEach((t, idx) => fallback.push({ kind: "add", newLine: idx + 1, text: t }));
    return fallback;
  }

  const dp = new Uint16Array((n + 1) * (m + 1));
  const stride = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * stride + j];
        const right = dp[i * stride + (j + 1)];
        dp[i * stride + j] = down >= right ? down : right;
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      out.push({ kind: "del", oldLine: i + 1, text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", newLine: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "del", oldLine: i + 1, text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ kind: "add", newLine: j + 1, text: b[j] });
    j++;
  }
  return out;
}

function buildCompactHunkRows(lines: DiffLine[], contextRadius = 2): DiffHunkRow[] {
  const keep = new Uint8Array(lines.length);
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].kind !== "same") {
      const lo = Math.max(0, idx - contextRadius);
      const hi = Math.min(lines.length - 1, idx + contextRadius);
      for (let k = lo; k <= hi; k++) {
        keep[k] = 1;
      }
    }
  }

  const rows: DiffHunkRow[] = [];
  let activeSection = "";
  let lastShownSection = "";
  let skipped = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    const trimmed = ln.text.trim();
    if (ln.kind !== "del" && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      activeSection = trimmed;
    }

    if (!keep[idx]) {
      skipped++;
      continue;
    }

    if (skipped > 0) {
      rows.push({ type: "skip", skippedCount: skipped });
      skipped = 0;
      if (activeSection && activeSection !== lastShownSection && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        rows.push({ type: "section_ctx", sectionText: activeSection });
        lastShownSection = activeSection;
      }
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      lastShownSection = trimmed;
    }
    rows.push({ type: "line", line: ln });
  }

  if (skipped > 0 && rows.length > 0) {
    rows.push({ type: "skip", skippedCount: skipped });
  }
  return rows;
}

export function TomlDiffViewer({
  beforeToml,
  afterToml,
  defaultShowFull = false,
}: {
  beforeToml: string;
  afterToml: string;
  defaultShowFull?: boolean;
}) {
  const [showFull, setShowFull] = useState(defaultShowFull);

  const { lines, addCount, delCount, hunkRows } = useMemo(() => {
    const diffLines = computeDiffLines(beforeToml, afterToml);
    let adds = 0;
    let dels = 0;
    for (const l of diffLines) {
      if (l.kind === "add") adds++;
      else if (l.kind === "del") dels++;
    }
    return {
      lines: diffLines,
      addCount: adds,
      delCount: dels,
      hunkRows: buildCompactHunkRows(diffLines, 2),
    };
  }, [beforeToml, afterToml]);

  if (addCount === 0 && delCount === 0) {
    return <div className="toml-diff-empty">配置文件内容无行级差异</div>;
  }

  return (
    <div className="toml-diff-box">
      <div className="toml-diff-bar">
        <div className="toml-diff-stats">
          <span className="toml-diff-file">config.toml</span>
          {addCount > 0 && <span className="diff-stat-add">+{addCount} 行</span>}
          {delCount > 0 && <span className="diff-stat-del">−{delCount} 行</span>}
        </div>
        <button
          type="button"
          className="toml-diff-mode-btn"
          onClick={() => setShowFull((v) => !v)}
        >
          {showFull ? "仅看变更片段" : "展开完整文件"}
        </button>
      </div>

      <div className="toml-diff-scroll">
        {showFull
          ? lines.map((ln, idx) => (
              <div key={idx} className={`toml-diff-line ${ln.kind}`}>
                <span className="toml-diff-ln">{ln.oldLine ?? ""}</span>
                <span className="toml-diff-ln">{ln.newLine ?? ""}</span>
                <span className="toml-diff-sign">
                  {ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " "}
                </span>
                <span className="toml-diff-code">{ln.text || " "}</span>
              </div>
            ))
          : hunkRows.map((row, idx) => {
              if (row.type === "skip") {
                return (
                  <div key={`skip-${idx}`} className="toml-diff-skip">
                    ⋯ 隐藏未变动的 {row.skippedCount} 行配置 ⋯
                  </div>
                );
              }
              if (row.type === "section_ctx") {
                return (
                  <div key={`ctx-${idx}`} className="toml-diff-ctx">
                    所在段落：{row.sectionText}
                  </div>
                );
              }
              const ln = row.line!;
              return (
                <div key={`ln-${idx}`} className={`toml-diff-line ${ln.kind}`}>
                  <span className="toml-diff-ln">{ln.oldLine ?? ""}</span>
                  <span className="toml-diff-ln">{ln.newLine ?? ""}</span>
                  <span className="toml-diff-sign">
                    {ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " "}
                  </span>
                  <span className="toml-diff-code">{ln.text || " "}</span>
                </div>
              );
            })}
      </div>
    </div>
  );
}

/* ---------------- 对话气泡内嵌「配置修改明细」卡片 ---------------- */

const SIDE_EFFECT_PREFIXES = [
  "按新规则自动归整",
  "AI 重新分拣",
  "已启动后台 IMAP",
  "注入 ",
  "演示会话已就绪",
  "已清理 ",
];

export function ConfigChangeSummaryCard({
  configDiff,
  legacyChanges,
  streaming,
  onLocateInForm,
  onOpenDiffTab,
  onRevertBeforeToml,
}: {
  configDiff?: ConfigDiffReport | null;
  legacyChanges?: string[];
  streaming?: boolean;
  onLocateInForm: (targetKey: string, diff?: ConfigDiffReport | null) => void;
  onOpenDiffTab?: (diff: ConfigDiffReport) => void;
  onRevertBeforeToml?: (beforeToml: string) => Promise<void>;
}) {
  const [showInlineDiff, setShowInlineDiff] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [reverted, setReverted] = useState(false);

  const items = configDiff?.items ?? [];
  const hasTomlDiff = Boolean(
    configDiff?.before_toml?.trim() &&
      configDiff?.after_toml?.trim() &&
      configDiff.before_toml.trim() !== configDiff.after_toml.trim(),
  );

  // 提取不体现在 config.toml 字段对比中的附加执行动作（如立即扫描邮件、同步收信）
  const extraActions = useMemo(() => {
    const raw = legacyChanges ?? [];
    if (items.length === 0) return raw;
    return raw.filter((ch) => SIDE_EFFECT_PREFIXES.some((p) => ch.startsWith(p)));
  }, [items.length, legacyChanges]);

  if (items.length === 0 && extraActions.length === 0 && !hasTomlDiff) {
    return null;
  }

  const firstTarget = items[0]?.target_key || "accounts";

  const handleRevert = async () => {
    if (!configDiff?.before_toml || !onRevertBeforeToml || reverting) return;
    setReverting(true);
    try {
      await onRevertBeforeToml(configDiff.before_toml);
      setReverted(true);
      setConfirmRevert(false);
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className={`agent-change-card ${streaming ? "is-live" : ""}`}>
      <div className="agent-change-card-head">
        <div className="agent-change-card-title">
          <span className="agent-change-icon">
            <IconCheck size={12} />
          </span>
          <span>
            {streaming
              ? `正在修改 ${items.length || extraActions.length} 项设置…`
              : items.length > 0
                ? `本次修改了 ${items.length} 项设置`
                : `已执行 ${extraActions.length} 项配置变更`}
          </span>
          {reverted && <span className="change-reverted-tag">已还原修改前状态</span>}
        </div>

        <div className="agent-change-card-actions">
          {items.length > 0 && (
            <button
              type="button"
              className="change-action-btn accent"
              onClick={() => onLocateInForm(firstTarget, configDiff)}
              title="打开右侧可视化表单并高亮定位本次修改的设置项"
            >
              <IconSliders size={11} />
              <span>在表单中查看</span>
            </button>
          )}

          {hasTomlDiff && (
            <button
              type="button"
              className={`change-action-btn ${showInlineDiff ? "active" : ""}`}
              onClick={() => setShowInlineDiff((v) => !v)}
              title="展开或收起 config.toml 具体增删行对比"
            >
              <IconCode size={11} />
              <span>{showInlineDiff ? "收起对比" : "文件 Diff"}</span>
            </button>
          )}

          {hasTomlDiff && onOpenDiffTab && configDiff && (
            <button
              type="button"
              className="change-action-btn"
              onClick={() => onOpenDiffTab(configDiff)}
              title="在右侧面板打开完整变更对比视图"
            >
              <span>右侧对比</span>
            </button>
          )}

          {!streaming && hasTomlDiff && onRevertBeforeToml && !reverted && (
            confirmRevert ? (
              <span className="change-revert-confirm">
                <button
                  type="button"
                  className="change-action-btn danger"
                  disabled={reverting}
                  onClick={handleRevert}
                >
                  {reverting ? "还原中…" : "确认撤销"}
                </button>
                <button
                  type="button"
                  className="change-action-btn"
                  disabled={reverting}
                  onClick={() => setConfirmRevert(false)}
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="change-action-btn muted"
                onClick={() => setConfirmRevert(true)}
                title="一键还原到本轮助手修改之前的配置"
              >
                <span>撤销修改</span>
              </button>
            )
          )}
        </div>
      </div>

      {items.length > 0 && (
        <div className="agent-change-list">
          {items.map((item, idx) => (
            <button
              key={`${item.target_key}-${item.field_label}-${idx}`}
              type="button"
              className={`agent-change-row kind-${item.kind}`}
              onClick={() => onLocateInForm(item.target_key, configDiff)}
              title="点击在右侧可视化表单中定位此项"
            >
              <div className="agent-change-row-left">
                <span className={`change-sec-badge sec-${item.section}`}>
                  {item.section_label}
                </span>
                <span className="change-field-name">{item.field_label}</span>
              </div>

              <div className="agent-change-row-vals">
                {item.kind === "added" ? (
                  <span className="diff-val-pill added">+ {item.after}</span>
                ) : item.kind === "removed" ? (
                  <span className="diff-val-pill removed">− {item.before}</span>
                ) : (
                  <>
                    <span className="diff-val-pill old" title={`修改前：${item.before}`}>
                      {item.before}
                    </span>
                    <span className="diff-val-arrow">→</span>
                    <span className="diff-val-pill new" title={`修改后：${item.after}`}>
                      {item.after}
                    </span>
                  </>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {extraActions.length > 0 && (
        <div className="agent-extra-changes">
          {extraActions.map((act, idx) => (
            <span key={idx} className="change-pill">
              <IconCheck size={11} />
              <span>{act}</span>
            </span>
          ))}
        </div>
      )}

      {showInlineDiff && hasTomlDiff && configDiff && (
        <div className="agent-inline-diff-wrap">
          <TomlDiffViewer
            beforeToml={configDiff.before_toml}
            afterToml={configDiff.after_toml}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------- 右侧实时配置面板（可视化表单 / 变更对比 / config.toml 自由切换） ---------------- */

type TriageFieldKey = keyof TriageSpec;

const TRIAGE_FIELD_META: {
  key: TriageFieldKey;
  ruleKind: RuleKind;
  shortLabel: string;
  groupLabel: string;
  badgeTone: "allow" | "archive" | "block";
}[] = [
  {
    key: "allow_senders",
    ruleKind: "allow_sender",
    shortLabel: "白名单发件人（始终进消息）",
    groupLabel: "白名单发件人",
    badgeTone: "allow",
  },
  {
    key: "archive_keywords",
    ruleKind: "archive_keyword",
    shortLabel: "折叠关键词（自动进通知）",
    groupLabel: "折叠进通知 · 关键词",
    badgeTone: "archive",
  },
  {
    key: "archive_senders",
    ruleKind: "archive_sender",
    shortLabel: "折叠发件人（自动进通知）",
    groupLabel: "折叠进通知 · 发件人",
    badgeTone: "archive",
  },
  {
    key: "block_keywords",
    ruleKind: "block_keyword",
    shortLabel: "屏蔽关键词（主题或正文）",
    groupLabel: "自动屏蔽 · 关键词",
    badgeTone: "block",
  },
  {
    key: "block_domains",
    ruleKind: "block_domain",
    shortLabel: "屏蔽发件域名",
    groupLabel: "自动屏蔽 · 域名",
    badgeTone: "block",
  },
  {
    key: "block_senders",
    ruleKind: "block_sender",
    shortLabel: "屏蔽发件人邮箱",
    groupLabel: "自动屏蔽 · 发件人",
    badgeTone: "block",
  },
];

interface AccountFormDraft {
  mode: "edit" | "add";
  originalEmail: string;
  email: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  password: string;
  setActive: boolean;
}

const EMPTY_ACC_DRAFT: AccountFormDraft = {
  mode: "add",
  originalEmail: "",
  email: "",
  display_name: "",
  imap_host: "",
  imap_port: 993,
  smtp_host: "",
  smtp_port: 465,
  password: "",
  setActive: true,
};

export function AgentConfigInspector({
  tab,
  onTabChange,
  spec: rawSpec,
  secrets,
  configPath,
  savedToml: _savedToml,
  draftToml,
  onDraftTomlChange,
  tomlDirty,
  applyingToml,
  onApplyToml,
  onResetToml,
  activeDiff,
  focusSignal,
  onClearHighlight,
  onBundleUpdated,
  onSecretUpdated,
  onSwitchAccount,
  onOpenVault,
  onOpenFullSettings,
  notify,
  onDataChanged,
  onRevertBeforeToml,
}: {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  spec: DeclarativeConfigSpec | null;
  secrets: SecretStatus[];
  configPath: string;
  savedToml: string;
  draftToml: string;
  onDraftTomlChange: (val: string) => void;
  tomlDirty: boolean;
  applyingToml: boolean;
  onApplyToml: () => void;
  onResetToml: () => void;
  activeDiff: ConfigDiffReport | null;
  focusSignal: { seq: number; targetKey: string } | null;
  onClearHighlight: () => void;
  onBundleUpdated: (bundle: DeclarativeBundle, msg?: string) => void;
  onSecretUpdated: (secrets: SecretStatus[], msg?: string) => Promise<void> | void;
  onSwitchAccount?: (email: string) => Promise<void> | void;
  onOpenVault: (focusKey?: string | null) => void;
  onOpenFullSettings: () => void;
  notify: (text: string, isError?: boolean) => void;
  onDataChanged: () => void;
  onRevertBeforeToml?: (beforeToml: string) => Promise<void>;
}) {
  const spec = useMemo(() => normalizeDeclarativeSpec(rawSpec), [rawSpec]);
  const diffCount = activeDiff?.items.length ?? 0;

  return (
    <aside className="config-inspector-pane">
      <div
        className="inspector-head"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <div className="inspector-segmented" role="tablist" aria-label="设置视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "visual"}
            className={tab === "visual" ? "active" : ""}
            onClick={() => onTabChange("visual")}
            title="可视化卡片与表单视图"
          >
            <IconSliders size={13} />
            <span>可视化表单</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === "diff"}
            className={tab === "diff" ? "active" : ""}
            onClick={() => onTabChange("diff")}
            title="查看助手最近一次修改前后的具体对比"
          >
            <span>变更对比</span>
            {diffCount > 0 && <span className="inspector-diff-badge">{diffCount}</span>}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === "toml"}
            className={tab === "toml" ? "active" : ""}
            onClick={() => onTabChange("toml")}
            title="切换至 config.toml 声明式源码编辑器"
          >
            <IconCode size={13} />
            <span>config.toml</span>
            {tomlDirty && <span className="inspector-dirty-dot" title="有未应用的源码修改" />}
          </button>
        </div>

        <div className="inspector-head-actions">
          <button
            type="button"
            className="ghost-btn icon-only-btn inspector-icon-btn"
            onClick={onOpenFullSettings}
            title="打开全屏配置与隐私中心"
          >
            <IconExternalLink size={13} />
          </button>
        </div>
      </div>

      {tab === "visual" && (
        <InspectorVisualView
          spec={spec}
          secrets={secrets}
          tomlDirty={tomlDirty}
          applyingToml={applyingToml}
          onApplyToml={onApplyToml}
          onResetToml={onResetToml}
          activeDiff={activeDiff}
          focusSignal={focusSignal}
          onClearHighlight={onClearHighlight}
          onOpenDiffTab={() => onTabChange("diff")}
          onBundleUpdated={onBundleUpdated}
          onSecretUpdated={onSecretUpdated}
          onSwitchAccount={onSwitchAccount}
          onOpenVault={onOpenVault}
          notify={notify}
          onDataChanged={onDataChanged}
        />
      )}

      {tab === "diff" && (
        <InspectorDiffView
          activeDiff={activeDiff}
          onJumpToVisual={(targetKey) => {
            onTabChange("visual");
            // 交由父级或内部滚动定位
            requestAnimationFrame(() => {
              const el = document.querySelector<HTMLElement>(
                `[data-config-target="${CSS.escape(targetKey)}"]`,
              );
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }}
          onRevertBeforeToml={onRevertBeforeToml}
        />
      )}

      {tab === "toml" && (
        <div className="inspector-toml-wrap">
          <div className="inspector-toml-subbar">
            <div className="inspector-toml-meta">
              <span className="privacy-pill">
                <IconLock size={11} />
                密钥脱敏
              </span>
              {configPath && (
                <span className="inspector-toml-path" title={configPath}>
                  {configPath}
                </span>
              )}
            </div>
            <div className="inspector-toml-btns">
              {tomlDirty && (
                <button type="button" className="ghost-btn compact-btn" onClick={onResetToml}>
                  还原
                </button>
              )}
              <button
                type="button"
                className={`${tomlDirty ? "primary-btn" : "soft-btn"} compact-btn`}
                onClick={onApplyToml}
                disabled={applyingToml || !tomlDirty}
              >
                {applyingToml ? "校验中…" : tomlDirty ? "应用变更" : "已同步"}
              </button>
            </div>
          </div>

          <textarea
            className="toml-editor"
            spellCheck={false}
            value={draftToml}
            onChange={(e) => onDraftTomlChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (tomlDirty) onApplyToml();
              }
            }}
          />
        </div>
      )}
    </aside>
  );
}

/* ---------------- 右侧「可视化表单」主体 ---------------- */

function InspectorVisualView({
  spec,
  secrets,
  tomlDirty,
  applyingToml,
  onApplyToml,
  onResetToml,
  activeDiff,
  focusSignal,
  onClearHighlight,
  onOpenDiffTab,
  onBundleUpdated,
  onSecretUpdated,
  onSwitchAccount,
  onOpenVault,
  notify,
  onDataChanged,
}: {
  spec: NormalizedDeclarativeSpec;
  secrets: SecretStatus[];
  tomlDirty: boolean;
  applyingToml: boolean;
  onApplyToml: () => void;
  onResetToml: () => void;
  activeDiff: ConfigDiffReport | null;
  focusSignal: { seq: number; targetKey: string } | null;
  onClearHighlight: () => void;
  onOpenDiffTab: () => void;
  onBundleUpdated: (bundle: DeclarativeBundle, msg?: string) => void;
  onSecretUpdated: (secrets: SecretStatus[], msg?: string) => Promise<void> | void;
  onSwitchAccount?: (email: string) => Promise<void> | void;
  onOpenVault: (focusKey?: string | null) => void;
  notify: (text: string, isError?: boolean) => void;
  onDataChanged: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 按 target_key 与 section 索引当前高亮变更项
  const { itemsByTarget, changedSections } = useMemo(() => {
    const map = new Map<string, ConfigDiffItem[]>();
    const secs = new Set<string>();
    for (const item of activeDiff?.items ?? []) {
      secs.add(item.section);
      const list = map.get(item.target_key) ?? [];
      list.push(item);
      map.set(item.target_key, list);
    }
    return { itemsByTarget: map, changedSections: secs };
  }, [activeDiff]);

  // 邮箱编辑抽屉状态
  const [accForm, setAccForm] = useState<AccountFormDraft | null>(null);
  const [savingAcc, setSavingAcc] = useState(false);
  const [switchingEmail, setSwitchingEmail] = useState<string | null>(null);
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState<string | null>(null);

  // 模型表单草稿状态（与 spec.agent 同步）
  const [agentDraft, setAgentDraft] = useState(() => ({
    preset: spec.agent.preset,
    provider: spec.agent.provider,
    base_url: spec.agent.base_url,
    model: spec.agent.model,
    instructions: spec.agent.instructions,
  }));
  const [savingAgent, setSavingAgent] = useState(false);
  const [testingAgent, setTestingAgent] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [magpieProbe, setMagpieProbe] = useState<MagpieProbeReport | null>(null);
  const [connectingMagpie, setConnectingMagpie] = useState(false);
  const [inlineKeyInput, setInlineKeyInput] = useState("");
  const [showInlineKeyBox, setShowInlineKeyBox] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .probeMagpie(spec.agent.preset === "magpie" ? spec.agent.base_url : undefined)
      .then((rep) => {
        if (!cancelled) setMagpieProbe(rep);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [spec.agent.preset, spec.agent.base_url]);

  // 分流规则快速添加状态
  const [newRuleField, setNewRuleField] = useState<TriageFieldKey>("block_keywords");
  const [newRuleValue, setNewRuleValue] = useState("");
  const [busyRule, setBusyRule] = useState(false);

  useEffect(() => {
    setAgentDraft({
      preset: spec.agent.preset,
      provider: spec.agent.provider,
      base_url: spec.agent.base_url,
      model: spec.agent.model,
      instructions: spec.agent.instructions,
    });
  }, [
    spec.agent.preset,
    spec.agent.provider,
    spec.agent.base_url,
    spec.agent.model,
    spec.agent.instructions,
  ]);

  // 响应从对话气泡点击「在表单中查看 / 定位某项」
  useEffect(() => {
    if (!focusSignal) return;
    const tk = focusSignal.targetKey;
    if (tk.startsWith("account:")) {
      const em = tk.slice("account:".length).toLowerCase();
      const matched = spec.accounts.find((a) => a.email.trim().toLowerCase() === em);
      if (matched) {
        const activeEm = (
          spec.active_account ||
          spec.accounts[0]?.email ||
          ""
        ).toLowerCase();
        setAccForm({
          mode: "edit",
          originalEmail: matched.email,
          email: matched.email,
          display_name: matched.display_name,
          imap_host: matched.imap_host,
          imap_port: matched.imap_port || 993,
          smtp_host: matched.smtp_host,
          smtp_port: matched.smtp_port || 465,
          password: "",
          setActive: matched.email.trim().toLowerCase() === activeEm,
        });
      }
    }

    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const exact =
        container.querySelector<HTMLElement>(`[data-config-target="${CSS.escape(tk)}"]`) ??
        container.querySelector<HTMLElement>(
          `[data-config-section="${CSS.escape(tk.split(".")[0].split(":")[0])}"]`,
        );
      exact?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusSignal, spec.accounts, spec.active_account]);

  const activeEmailNorm = useMemo(() => {
    const preferred = spec.active_account.trim().toLowerCase();
    if (preferred && spec.accounts.some((a) => a.email.trim().toLowerCase() === preferred)) {
      return preferred;
    }
    return spec.accounts[0]?.email.trim().toLowerCase() ?? "";
  }, [spec.accounts, spec.active_account]);

  const openEditAccount = (entry: AccountSpec) => {
    setConfirmRemoveEmail(null);
    const isAct = entry.email.trim().toLowerCase() === activeEmailNorm;
    setAccForm({
      mode: "edit",
      originalEmail: entry.email,
      email: entry.email,
      display_name: entry.display_name,
      imap_host: entry.imap_host,
      imap_port: entry.imap_port || 993,
      smtp_host: entry.smtp_host,
      smtp_port: entry.smtp_port || 465,
      password: "",
      setActive: isAct,
    });
  };

  const openAddAccount = () => {
    setConfirmRemoveEmail(null);
    setAccForm({ ...EMPTY_ACC_DRAFT, setActive: true });
  };

  const handleDraftEmailChange = (rawEmail: string) => {
    const trimmed = rawEmail.trim();
    setAccForm((prev) => {
      if (!prev) return prev;
      const next = { ...prev, email: trimmed };
      const atIdx = trimmed.indexOf("@");
      if (atIdx > 0) {
        const domain = trimmed.slice(atIdx + 1).toLowerCase();
        const preset = PRESETS[domain];
        if (preset && (!prev.imap_host || !prev.smtp_host)) {
          next.imap_host = preset.imap_host;
          next.imap_port = preset.imap_port;
          next.smtp_host = preset.smtp_host;
          next.smtp_port = preset.smtp_port;
        }
      }
      return next;
    });
  };

  const applyMailDomainPreset = (domain: string) => {
    const preset = PRESETS[domain];
    if (!preset) return;
    setAccForm((prev) => {
      if (!prev) return prev;
      const localPart = prev.email.includes("@")
        ? prev.email.split("@")[0]
        : prev.email || "name";
      const nextEmail = prev.email.endsWith(`@${domain}`)
        ? prev.email
        : `${localPart}@${domain}`;
      return {
        ...prev,
        email: nextEmail,
        imap_host: preset.imap_host,
        imap_port: preset.imap_port,
        smtp_host: preset.smtp_host,
        smtp_port: preset.smtp_port,
      };
    });
  };

  const saveAccountParamsOnly = async () => {
    if (!accForm) return;
    const cleanEmail = accForm.email.trim().toLowerCase();
    if (!cleanEmail.includes("@")) {
      notify("请填写格式正确的邮箱地址", true);
      return;
    }
    setSavingAcc(true);
    try {
      if (accForm.password.trim()) {
        const secRes = await api.setSecret(
          mailSecretKey(cleanEmail),
          accForm.password.trim(),
          false,
        );
        await onSecretUpdated(secRes.secrets);
      }

      const nextAccounts = [...spec.accounts];
      const targetNorm = (accForm.originalEmail || cleanEmail).trim().toLowerCase();
      const idx = nextAccounts.findIndex(
        (a) => a.email.trim().toLowerCase() === targetNorm,
      );
      const updatedEntry: AccountSpec = {
        email: cleanEmail,
        display_name: accForm.display_name.trim(),
        username: cleanEmail,
        imap_host: accForm.imap_host.trim(),
        imap_port: Number(accForm.imap_port) || 993,
        smtp_host: accForm.smtp_host.trim(),
        smtp_port: Number(accForm.smtp_port) || 465,
        password_ref: `secret:${mailSecretKey(cleanEmail)}`,
      };
      if (idx >= 0) {
        nextAccounts[idx] = updatedEntry;
      } else {
        nextAccounts.push(updatedEntry);
      }

      const nextActive =
        accForm.setActive || !spec.active_account
          ? cleanEmail
          : spec.active_account === accForm.originalEmail
            ? cleanEmail
            : spec.active_account;

      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        active_account: nextActive,
        accounts: nextAccounts,
      });
      setAccForm(null);
      onBundleUpdated(bundle, `已保存邮箱配置 ${cleanEmail}`);
      onDataChanged();
    } catch (e) {
      notify(`保存失败：${e}`, true);
    } finally {
      setSavingAcc(false);
    }
  };

  const saveAndVerifyAccount = async () => {
    if (!accForm) return;
    const cleanEmail = accForm.email.trim().toLowerCase();
    if (!cleanEmail.includes("@")) {
      notify("请填写格式正确的邮箱地址", true);
      return;
    }
    setSavingAcc(true);
    try {
      const payload: Account = {
        email: cleanEmail,
        display_name: accForm.display_name.trim(),
        username: cleanEmail,
        imap_host: accForm.imap_host.trim(),
        imap_port: Number(accForm.imap_port) || 993,
        smtp_host: accForm.smtp_host.trim(),
        smtp_port: Number(accForm.smtp_port) || 465,
        password: accForm.password.trim(),
      };
      await api.saveAccount(payload, accForm.setActive || spec.accounts.length === 0);
      const bundle = await api.getDeclarativeConfig();
      setAccForm(null);
      onBundleUpdated(bundle, `邮箱 ${cleanEmail} 验证通过并已生效`);
      onDataChanged();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSavingAcc(false);
    }
  };

  const handleQuickSwitchAccount = async (email: string) => {
    if (switchingEmail) return;
    setSwitchingEmail(email);
    try {
      if (onSwitchAccount) {
        await onSwitchAccount(email);
      } else {
        await api.switchAccount(email);
        onDataChanged();
        notify(`已切换至邮箱 ${email}`);
      }
      const bundle = await api.getDeclarativeConfig();
      onBundleUpdated(bundle);
    } catch (e) {
      notify(`切换失败：${e}`, true);
    } finally {
      setSwitchingEmail(null);
    }
  };

  const handleRemoveAccount = async (email: string, deleteLocal: boolean) => {
    try {
      await api.removeAccount(email, deleteLocal);
      setConfirmRemoveEmail(null);
      if (accForm?.originalEmail.toLowerCase() === email.toLowerCase()) {
        setAccForm(null);
      }
      const bundle = await api.getDeclarativeConfig();
      onBundleUpdated(
        bundle,
        deleteLocal ? `已解绑 ${email} 并清理缓存` : `已解绑 ${email}`,
      );
      onDataChanged();
    } catch (e) {
      notify(`解绑失败：${e}`, true);
    }
  };

  // Agent 开关即时保存
  const toggleAgentFlag = async (
    field: "enabled" | "auto_draft" | "auto_block_sender",
    value: boolean,
  ) => {
    try {
      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        agent: {
          ...spec.agent,
          ...agentDraft,
          [field]: value,
        },
      });
      onBundleUpdated(bundle);
      onDataChanged();
    } catch (e) {
      notify(`更新开关失败：${e}`, true);
    }
  };

  const selectAgentPreset = (presetId: string) => {
    const presetMeta = MODEL_PRESETS.find((p) => p.id === presetId);
    const savedProf = spec.agent.profiles?.[presetId];
    setFetchedModels(presetId === "magpie" && magpieProbe?.models ? magpieProbe.models : []);
    const defaultBase =
      presetId === "magpie"
        ? magpieProbe?.base_url || presetMeta?.baseUrl || ""
        : presetMeta?.baseUrl || "";
    const defaultModel =
      presetId === "magpie"
        ? magpieProbe?.recommended_model || presetMeta?.defaultModel || "auto"
        : presetMeta?.defaultModel || "";
    setAgentDraft((prev) => ({
      ...prev,
      preset: presetId,
      provider: presetMeta?.provider ?? prev.provider,
      base_url: savedProf?.base_url || defaultBase,
      model: savedProf?.model || defaultModel || prev.model,
    }));
  };

  const handleQuickAdoptMagpie = async () => {
    if (connectingMagpie) return;
    setConnectingMagpie(true);
    try {
      const res = await api.connectMagpie({ autoStart: true });
      setMagpieProbe(res.probe);
      onBundleUpdated(
        res.bundle,
        res.probe.gateway_online
          ? `已沿用本机 Magpie 路由配置（${res.agent_config.model}）`
          : `已切换至 Magpie 路由（${res.probe.message}）`,
      );
      onDataChanged();
    } catch (e) {
      notify(`接入 Magpie 失败：${e}`, true);
    } finally {
      setConnectingMagpie(false);
    }
  };

  const agentDirty =
    agentDraft.preset !== spec.agent.preset ||
    agentDraft.provider !== spec.agent.provider ||
    agentDraft.base_url.trim() !== spec.agent.base_url.trim() ||
    agentDraft.model.trim() !== spec.agent.model.trim() ||
    agentDraft.instructions.trim() !== spec.agent.instructions.trim();

  const saveAgentDetails = async () => {
    setSavingAgent(true);
    try {
      const trimmedBase = agentDraft.base_url.trim();
      const isLocalMagpie =
        agentDraft.preset === "magpie" &&
        (!trimmedBase || trimmedBase.includes("127.0.0.1") || trimmedBase.includes("localhost"));
      const nextProfiles = {
        ...(spec.agent.profiles ?? {}),
        [agentDraft.preset]: {
          base_url: trimmedBase,
          model: agentDraft.model.trim(),
        },
      };
      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        agent: {
          ...spec.agent,
          preset: agentDraft.preset,
          provider: agentDraft.provider,
          base_url: trimmedBase,
          model: agentDraft.model.trim(),
          api_key_ref:
            agentDraft.preset === "ollama"
              ? "none (local)"
              : isLocalMagpie
                ? "none (magpie-local)"
                : `secret:llm_${agentDraft.preset}`,
          instructions: agentDraft.instructions.trim(),
          profiles: nextProfiles,
        },
      });
      onBundleUpdated(bundle, "模型与分拣参数已保存生效");
      onDataChanged();
    } catch (e) {
      notify(`保存模型参数失败：${e}`, true);
    } finally {
      setSavingAgent(false);
    }
  };

  const buildTempAgentConfig = (): AgentConfig => ({
    enabled: spec.agent.enabled,
    preset: agentDraft.preset as ProviderPresetId,
    provider: (agentDraft.provider as AgentConfig["provider"]) || "openai",
    base_url: agentDraft.base_url.trim(),
    api_key: "",
    model: agentDraft.model.trim(),
    instructions: agentDraft.instructions,
    auto_draft: spec.agent.auto_draft,
    auto_block_sender: spec.agent.auto_block_sender,
    profiles: {},
  });

  const handleFetchRemoteModels = async () => {
    if (fetchingModels) return;
    setFetchingModels(true);
    try {
      const list = await api.fetchModels(buildTempAgentConfig());
      setFetchedModels(list);
      if (list.length > 0 && !list.includes(agentDraft.model)) {
        setAgentDraft((prev) => ({ ...prev, model: list[0] }));
      }
      notify(`已拉取到 ${list.length} 个可用模型`);
    } catch (e) {
      notify(String(e), true);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestAgentLlm = async () => {
    if (testingAgent) return;
    setTestingAgent(true);
    try {
      if (agentDirty) {
        await saveAgentDetails();
      }
      const v = await api.testAgent(buildTempAgentConfig());
      notify(`连通正常：示例判定 ${v.action}（${v.category}）`);
    } catch (e) {
      notify(`模型测试失败：${e}`, true);
    } finally {
      setTestingAgent(false);
    }
  };

  const saveInlineLlmSecret = async (verify: boolean) => {
    const val = inlineKeyInput.trim();
    if (!val || savingKey) return;
    const sk = `llm_${agentDraft.preset}`;
    setSavingKey(true);
    try {
      if (agentDirty) {
        await saveAgentDetails();
      }
      const res = await api.setSecret(sk, val, verify);
      setInlineKeyInput("");
      setShowInlineKeyBox(false);
      await onSecretUpdated(res.secrets, res.message);
      onDataChanged();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSavingKey(false);
    }
  };

  // 分流规则增删
  const handleAddRule = async () => {
    const clean =
      newRuleField === "block_domains"
        ? newRuleValue.trim().replace(/^@+/, "").toLowerCase()
        : newRuleValue.trim().toLowerCase();
    if (!clean || busyRule) return;
    setBusyRule(true);
    try {
      const curList = spec.triage[newRuleField] ?? [];
      if (curList.some((x) => x.toLowerCase() === clean)) {
        setNewRuleValue("");
        notify("该规则已存在");
        return;
      }
      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        triage: {
          ...spec.triage,
          [newRuleField]: [...curList, clean],
        },
      });
      setNewRuleValue("");
      onBundleUpdated(bundle, `已添加规则「${clean}」并重扫现有邮件`);
      onDataChanged();
    } catch (e) {
      notify(`添加规则失败：${e}`, true);
    } finally {
      setBusyRule(false);
    }
  };

  const handleRemoveRuleItem = async (field: TriageFieldKey, targetVal: string) => {
    if (busyRule) return;
    setBusyRule(true);
    try {
      const nextList = (spec.triage[field] ?? []).filter(
        (x) => x.toLowerCase() !== targetVal.toLowerCase(),
      );
      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        triage: {
          ...spec.triage,
          [field]: nextList,
        },
      });
      onBundleUpdated(bundle, `已移除规则「${targetVal}」`);
      onDataChanged();
    } catch (e) {
      notify(`移除规则失败：${e}`, true);
    } finally {
      setBusyRule(false);
    }
  };

  // 群免打扰切换
  const handleToggleGroupMute = async (groupId: string, nextMuted: boolean) => {
    try {
      const nextGroups = spec.groups.map((g) =>
        g.id === groupId ? { ...g, muted: nextMuted } : g,
      );
      const bundle = await api.applyDeclarativeSpec({
        ...spec,
        groups: nextGroups,
      });
      onBundleUpdated(bundle, nextMuted ? "已开启群免打扰" : "已恢复群消息提醒");
      onDataChanged();
    } catch (e) {
      notify(`更新群设置失败：${e}`, true);
    }
  };

  const currentPresetMeta =
    MODEL_PRESETS.find((p) => p.id === agentDraft.preset) ?? MODEL_PRESETS[0];
  const currentLlmSecretKey =
    agentDraft.preset === "ollama" ? null : `llm_${agentDraft.preset}`;
  const currentLlmSecret = currentLlmSecretKey
    ? secrets.find((s) => s.key === currentLlmSecretKey)
    : undefined;

  const totalRuleCount =
    spec.triage.allow_senders.length +
    spec.triage.block_senders.length +
    spec.triage.block_domains.length +
    spec.triage.block_keywords.length +
    spec.triage.archive_senders.length +
    spec.triage.archive_keywords.length;

  const candidateModelChips = useMemo(() => {
    if (agentDraft.preset === "magpie" && magpieProbe) {
      const bound = magpieProbe.agent_bindings.map((b) => b.model);
      return Array.from(
        new Set(["auto", ...bound, ...magpieProbe.groups, ...fetchedModels, ...magpieProbe.models]),
      ).slice(0, 10);
    }
    return Array.from(new Set([...fetchedModels, ...currentPresetMeta.models])).slice(0, 8);
  }, [agentDraft.preset, magpieProbe, fetchedModels, currentPresetMeta.models]);

  return (
    <div ref={scrollRef} className="inspector-visual-scroll">
      {tomlDirty && (
        <div className="inspector-unsaved-banner">
          <span>你在源码视图中有未应用的手动修改</span>
          <div className="inspector-unsaved-btns">
            <button type="button" className="ghost-btn compact-btn" onClick={onResetToml}>
              放弃
            </button>
            <button
              type="button"
              className="primary-btn compact-btn"
              disabled={applyingToml}
              onClick={onApplyToml}
            >
              {applyingToml ? "应用中…" : "立即应用"}
            </button>
          </div>
        </div>
      )}

      {activeDiff && activeDiff.items.length > 0 && (
        <div className="inspector-diff-banner">
          <div className="inspector-diff-banner-top">
            <span className="inspector-diff-banner-title">
              <IconCheck size={12} />
              <span>AI 刚更新了 {activeDiff.items.length} 处配置（已在下方高亮标出）</span>
            </span>
            <div className="inspector-diff-banner-actions">
              <button
                type="button"
                className="inspector-banner-link"
                onClick={onOpenDiffTab}
              >
                对比详情
              </button>
              <button
                type="button"
                className="inspector-banner-dismiss"
                onClick={onClearHighlight}
                title="清除修改高亮标记"
              >
                清除标记
              </button>
            </div>
          </div>
          <div className="inspector-diff-jump-pills">
            {activeDiff.items.map((it, idx) => (
              <button
                key={`${it.target_key}-${idx}`}
                type="button"
                className="inspector-jump-chip"
                onClick={() => {
                  const el = scrollRef.current?.querySelector<HTMLElement>(
                    `[data-config-target="${CSS.escape(it.target_key)}"]`,
                  );
                  el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                {it.field_label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 1. 邮箱账号卡片 */}
      <section
        className={`ins-card ${changedSections.has("accounts") ? "is-section-updated" : ""}`}
        data-config-section="accounts"
        data-config-target="accounts"
      >
        <div className="ins-card-head">
          <div className="ins-card-title-row">
            <span className="ins-card-title">邮箱账号</span>
            <span className="ins-count-pill">{spec.accounts.length}</span>
            {changedSections.has("accounts") && (
              <span className="ins-updated-badge">刚修改</span>
            )}
          </div>
          <button
            type="button"
            className="soft-btn compact-btn"
            onClick={() =>
              accForm?.mode === "add" ? setAccForm(null) : openAddAccount()
            }
          >
            <IconPlus size={12} />
            <span>{accForm?.mode === "add" ? "收起" : "新增账号"}</span>
          </button>
        </div>

        {spec.accounts.length === 0 && !accForm ? (
          <div className="ins-empty-box">
            <span>尚未绑定邮箱账号，可点击右上角「新增账号」或直接告诉左侧助手绑定</span>
          </div>
        ) : (
          <div className="ins-account-list">
            {spec.accounts.map((entry) => {
              const normEm = entry.email.trim().toLowerCase();
              const isActive = normEm === activeEmailNorm;
              const secKey = mailSecretKey(normEm);
              const hasPwd = secrets.some((s) => s.key === secKey && s.configured);
              const targetKey = `account:${normEm}`;
              const fieldDiffs = itemsByTarget.get(targetKey) ?? [];
              const isEditingThis =
                accForm?.mode === "edit" &&
                accForm.originalEmail.trim().toLowerCase() === normEm;
              const isConfirming = confirmRemoveEmail === entry.email;

              return (
                <div
                  key={entry.email}
                  data-config-target={targetKey}
                  className={`ins-acc-item ${isActive ? "active" : ""} ${fieldDiffs.length > 0 ? "is-item-updated" : ""}`}
                >
                  <div className="ins-acc-top">
                    <div className="ins-acc-identity">
                      <span className={`ins-acc-avatar ${isActive ? "active" : ""}`}>
                        {(entry.display_name?.trim() || entry.email)[0]?.toUpperCase() || "@"}
                      </span>
                      <div className="ins-acc-meta">
                        <div className="ins-acc-email-row">
                          <span className="ins-acc-email">{entry.email}</span>
                          {entry.display_name && (
                            <span className="ins-acc-nick">({entry.display_name})</span>
                          )}
                        </div>
                        <div className="ins-acc-badges">
                          {isActive && <span className="ins-mini-pill primary">当前主用</span>}
                          {hasPwd ? (
                            <span className="ins-mini-pill ok">授权码已加密</span>
                          ) : (
                            <button
                              type="button"
                              className="ins-mini-pill warn clickable"
                              onClick={() => onOpenVault(secKey)}
                              title="点击录入该邮箱授权码"
                            >
                              待录授权码
                            </button>
                          )}
                          {fieldDiffs.length > 0 && (
                            <span className="ins-updated-badge">
                              {fieldDiffs.some((d) => d.kind === "added") ? "AI 新增" : "AI 已改"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="ins-acc-btns">
                      {!isActive && (
                        <button
                          type="button"
                          className="soft-btn compact-btn"
                          disabled={switchingEmail === entry.email}
                          onClick={() => handleQuickSwitchAccount(entry.email)}
                        >
                          {switchingEmail === entry.email ? "…" : "设为主用"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={`ghost-btn compact-btn ${isEditingThis ? "active-soft" : ""}`}
                        onClick={() => (isEditingThis ? setAccForm(null) : openEditAccount(entry))}
                      >
                        {isEditingThis ? "收起" : "编辑"}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn compact-btn danger-text"
                        onClick={() =>
                          setConfirmRemoveEmail(isConfirming ? null : entry.email)
                        }
                        title="解绑此邮箱"
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>

                  <div className="ins-acc-servers">
                    <span>
                      IMAP <code>{entry.imap_host || "未填写"}:{entry.imap_port}</code>
                    </span>
                    <span className="ins-dot">·</span>
                    <span>
                      SMTP <code>{entry.smtp_host || "未填写"}:{entry.smtp_port}</code>
                    </span>
                  </div>

                  {fieldDiffs.length > 0 && (
                    <div className="ins-inline-diff-notes">
                      {fieldDiffs.map((fd, idx) => (
                        <div key={idx} className="ins-inline-diff-row">
                          <span className="ins-inline-diff-label">
                            {fd.field_label.replace(`${entry.email} · `, "")}：
                          </span>
                          {fd.kind === "added" ? (
                            <span className="ins-inline-diff-new">+ {fd.after}</span>
                          ) : (
                            <>
                              <span className="ins-inline-diff-old">{fd.before}</span>
                              <span className="diff-val-arrow">→</span>
                              <span className="ins-inline-diff-new">{fd.after}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {isConfirming && (
                    <div className="ins-remove-confirm">
                      <span>确认解绑 {entry.email}？</span>
                      <div className="ins-remove-btns">
                        <button
                          type="button"
                          className="soft-btn compact-btn"
                          onClick={() => handleRemoveAccount(entry.email, false)}
                        >
                          保留邮件解绑
                        </button>
                        <button
                          type="button"
                          className="ghost-btn compact-btn danger-text"
                          onClick={() => handleRemoveAccount(entry.email, true)}
                        >
                          解绑并清空
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {accForm && (
          <div className="ins-subform">
            <div className="ins-subform-head">
              <span>
                {accForm.mode === "add"
                  ? "新增绑定邮箱账号"
                  : `编辑账号参数 · ${accForm.originalEmail}`}
              </span>
              <button
                type="button"
                className="ghost-btn compact-btn"
                onClick={() => setAccForm(null)}
              >
                取消
              </button>
            </div>

            <div className="ins-preset-chips">
              {["qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "aliyun.com"].map(
                (d) => (
                  <button
                    key={d}
                    type="button"
                    className="ins-chip-btn"
                    onClick={() => applyMailDomainPreset(d)}
                  >
                    {PRESETS[d].label}
                  </button>
                ),
              )}
            </div>

            <div className="ins-form-grid">
              <label className="ins-field full">
                <span>邮箱地址</span>
                <input
                  value={accForm.email}
                  placeholder="name@example.com"
                  onChange={(e) => handleDraftEmailChange(e.target.value)}
                />
              </label>

              <label className="ins-field full">
                <span>发信显示昵称（选填）</span>
                <input
                  value={accForm.display_name}
                  placeholder="如：张三 / 工作号"
                  onChange={(e) =>
                    setAccForm({ ...accForm, display_name: e.target.value })
                  }
                />
              </label>

              <label className="ins-field">
                <span>IMAP 服务器</span>
                <input
                  value={accForm.imap_host}
                  placeholder="imap.example.com"
                  onChange={(e) =>
                    setAccForm({ ...accForm, imap_host: e.target.value.trim() })
                  }
                />
              </label>

              <label className="ins-field port">
                <span>IMAP 端口</span>
                <input
                  type="number"
                  value={accForm.imap_port}
                  onChange={(e) =>
                    setAccForm({ ...accForm, imap_port: Number(e.target.value) })
                  }
                />
              </label>

              <label className="ins-field">
                <span>SMTP 服务器</span>
                <input
                  value={accForm.smtp_host}
                  placeholder="smtp.example.com"
                  onChange={(e) =>
                    setAccForm({ ...accForm, smtp_host: e.target.value.trim() })
                  }
                />
              </label>

              <label className="ins-field port">
                <span>SMTP 端口</span>
                <input
                  type="number"
                  value={accForm.smtp_port}
                  onChange={(e) =>
                    setAccForm({ ...accForm, smtp_port: Number(e.target.value) })
                  }
                />
              </label>

              <label className="ins-field full">
                <span>授权码 / 应用密码（本地 DPAPI 加密存储，不改可留空）</span>
                <input
                  type="password"
                  value={accForm.password}
                  placeholder="填入授权码可一并加密保存"
                  onChange={(e) =>
                    setAccForm({ ...accForm, password: e.target.value })
                  }
                />
              </label>
            </div>

            {spec.accounts.length > 0 && (
              <label className="clean-switch compact-switch">
                <input
                  type="checkbox"
                  checked={accForm.setActive}
                  onChange={(e) =>
                    setAccForm({ ...accForm, setActive: e.target.checked })
                  }
                />
                <span>保存后设为当前主用邮箱</span>
              </label>
            )}

            <div className="ins-subform-actions">
              <button
                type="button"
                className="soft-btn compact-btn"
                disabled={savingAcc || !accForm.email.trim()}
                onClick={saveAccountParamsOnly}
              >
                仅保存参数
              </button>
              <button
                type="button"
                className="primary-btn compact-btn"
                disabled={savingAcc || !accForm.email.trim()}
                onClick={saveAndVerifyAccount}
              >
                {savingAcc ? "验证中…" : "验证连接并保存"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. AI 模型与自动分拣卡片 */}
      <section
        className={`ins-card ${changedSections.has("agent") ? "is-section-updated" : ""}`}
        data-config-section="agent"
      >
        <div className="ins-card-head">
          <div className="ins-card-title-row">
            <span className="ins-card-title">AI 模型与分拣</span>
            <span className={`ins-mini-pill ${spec.agent.enabled ? "ok" : "muted"}`}>
              {spec.agent.enabled ? "分拣已开启" : "分拣已暂停"}
            </span>
            {changedSections.has("agent") && (
              <span className="ins-updated-badge">刚修改</span>
            )}
          </div>
        </div>

        <div className="ins-switch-stack">
          <label
            className={`ins-switch-row ${itemsByTarget.has("agent.enabled") ? "is-field-updated" : ""}`}
            data-config-target="agent.enabled"
          >
            <span className="ins-switch-text">
              <span>启用新来信 AI 自动分拣与摘要</span>
              {itemsByTarget.get("agent.enabled")?.[0] && (
                <em className="ins-field-diff-hint">
                  {itemsByTarget.get("agent.enabled")![0].before} →{" "}
                  {itemsByTarget.get("agent.enabled")![0].after}
                </em>
              )}
            </span>
            <input
              type="checkbox"
              checked={spec.agent.enabled}
              onChange={(e) => toggleAgentFlag("enabled", e.target.checked)}
            />
          </label>

          <label
            className={`ins-switch-row ${itemsByTarget.has("agent.auto_draft") ? "is-field-updated" : ""}`}
            data-config-target="agent.auto_draft"
          >
            <span className="ins-switch-text">
              <span>自动生成快捷回复建议</span>
              {itemsByTarget.get("agent.auto_draft")?.[0] && (
                <em className="ins-field-diff-hint">
                  {itemsByTarget.get("agent.auto_draft")![0].before} →{" "}
                  {itemsByTarget.get("agent.auto_draft")![0].after}
                </em>
              )}
            </span>
            <input
              type="checkbox"
              checked={spec.agent.auto_draft}
              onChange={(e) => toggleAgentFlag("auto_draft", e.target.checked)}
            />
          </label>

          <label
            className={`ins-switch-row ${itemsByTarget.has("agent.auto_block_sender") ? "is-field-updated" : ""}`}
            data-config-target="agent.auto_block_sender"
          >
            <span className="ins-switch-text">
              <span>AI 判定垃圾邮件自动拉黑发件人</span>
              {itemsByTarget.get("agent.auto_block_sender")?.[0] && (
                <em className="ins-field-diff-hint">
                  {itemsByTarget.get("agent.auto_block_sender")![0].before} →{" "}
                  {itemsByTarget.get("agent.auto_block_sender")![0].after}
                </em>
              )}
            </span>
            <input
              type="checkbox"
              checked={spec.agent.auto_block_sender}
              onChange={(e) => toggleAgentFlag("auto_block_sender", e.target.checked)}
            />
          </label>
        </div>

        {agentDraft.preset !== "magpie" &&
          magpieProbe &&
          (magpieProbe.gateway_online || magpieProbe.cli_installed || magpieProbe.config_found) && (
            <div className="ins-magpie-tip">
              <span>
                检测到本机 Magpie 路由
                {magpieProbe.models.length > 0 ? `（${magpieProbe.models.length} 个模型免配可用）` : ""}
              </span>
              <button
                type="button"
                className="soft-btn compact-btn"
                disabled={connectingMagpie}
                onClick={handleQuickAdoptMagpie}
              >
                {connectingMagpie ? "接入中…" : "一键沿用"}
              </button>
            </div>
          )}

        <div className="ins-form-stack">
          <label
            className={`ins-field full ${itemsByTarget.has("agent.preset") ? "is-field-updated" : ""}`}
            data-config-target="agent.preset"
          >
            <span className="ins-label-line">
              <span>模型服务商预设</span>
              {itemsByTarget.get("agent.preset")?.[0] && (
                <em className="ins-field-diff-hint">
                  {itemsByTarget.get("agent.preset")![0].before} →{" "}
                  {itemsByTarget.get("agent.preset")![0].after}
                </em>
              )}
            </span>
            <select
              value={agentDraft.preset}
              onChange={(e) => selectAgentPreset(e.target.value)}
            >
              {MODEL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.badge}）
                </option>
              ))}
            </select>
          </label>

          <label
            className={`ins-field full ${itemsByTarget.has("agent.model") ? "is-field-updated" : ""}`}
            data-config-target="agent.model"
          >
            <span className="ins-label-line">
              <span className="ins-label-main">
                <span>模型名称</span>
                {itemsByTarget.get("agent.model")?.[0] && (
                  <em className="ins-field-diff-hint">
                    {itemsByTarget.get("agent.model")![0].before} →{" "}
                    {itemsByTarget.get("agent.model")![0].after}
                  </em>
                )}
              </span>
              {currentPresetMeta.supportsModelFetch && (
                <button
                  type="button"
                  className="text-link inline-fetch-btn"
                  disabled={fetchingModels}
                  onClick={handleFetchRemoteModels}
                >
                  <span className={fetchingModels ? "spin" : ""}>
                    <IconRefresh size={11} />
                  </span>
                  <span>{fetchingModels ? "拉取中…" : "拉取模型"}</span>
                </button>
              )}
            </span>
            <input
              value={agentDraft.model}
              placeholder={currentPresetMeta.defaultModel || "输入模型名称"}
              onChange={(e) => setAgentDraft({ ...agentDraft, model: e.target.value })}
            />
          </label>

          {candidateModelChips.length > 0 && (
            <div className="ins-preset-chips">
              {candidateModelChips.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`ins-chip-btn ${agentDraft.model === m ? "active" : ""}`}
                  onClick={() => setAgentDraft({ ...agentDraft, model: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          <label
            className={`ins-field full ${itemsByTarget.has("agent.base_url") ? "is-field-updated" : ""}`}
            data-config-target="agent.base_url"
          >
            <span className="ins-label-line">
              <span>接口地址 (Base URL)</span>
              {itemsByTarget.get("agent.base_url")?.[0] && (
                <em className="ins-field-diff-hint">
                  {itemsByTarget.get("agent.base_url")![0].before} →{" "}
                  {itemsByTarget.get("agent.base_url")![0].after}
                </em>
              )}
            </span>
            <input
              value={agentDraft.base_url}
              placeholder={currentPresetMeta.baseUrl || "https://your-endpoint/v1"}
              onChange={(e) =>
                setAgentDraft({ ...agentDraft, base_url: e.target.value })
              }
            />
          </label>

          {currentLlmSecretKey && (
            <div
              className={`ins-secret-strip ${itemsByTarget.has(`vault:${currentLlmSecretKey}`) ? "is-field-updated" : ""}`}
              data-config-target={`vault:${currentLlmSecretKey}`}
            >
              <div className="ins-secret-strip-main">
                <div className="ins-secret-strip-left">
                  <IconKey size={13} />
                  <span>{agentDraft.preset === "magpie" ? "网关密钥" : "API Key"}</span>
                  {currentLlmSecret?.configured ? (
                    <span className="ins-mini-pill ok">{currentLlmSecret.masked}</span>
                  ) : agentDraft.preset === "magpie" &&
                    (!agentDraft.base_url.trim() ||
                      agentDraft.base_url.includes("127.0.0.1") ||
                      agentDraft.base_url.includes("localhost")) ? (
                    <span className="ins-mini-pill ok">本机免密直连</span>
                  ) : (
                    <span className="ins-mini-pill warn">
                      {currentPresetMeta.optionalKey ? "免密或选填" : "未配置"}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-btn compact-btn"
                  onClick={() => {
                    setShowInlineKeyBox((v) => !v);
                    setInlineKeyInput("");
                  }}
                >
                  {showInlineKeyBox
                    ? "收起"
                    : currentLlmSecret?.configured
                      ? "更换密钥"
                      : "录入密钥"}
                </button>
              </div>

              {showInlineKeyBox && (
                <div className="ins-secret-inline-row">
                  <input
                    type="password"
                    autoFocus
                    value={inlineKeyInput}
                    placeholder={`输入 ${currentPresetMeta.name} API Key（本地加密）`}
                    onChange={(e) => setInlineKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveInlineLlmSecret(true);
                    }}
                  />
                  <button
                    type="button"
                    className="soft-btn compact-btn"
                    disabled={savingKey || !inlineKeyInput.trim()}
                    onClick={() => saveInlineLlmSecret(false)}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="primary-btn compact-btn"
                    disabled={savingKey || !inlineKeyInput.trim()}
                    onClick={() => saveInlineLlmSecret(true)}
                  >
                    {savingKey ? "验证…" : "保存并验证"}
                  </button>
                </div>
              )}
            </div>
          )}

          <label
            className={`ins-field full ${itemsByTarget.has("agent.instructions") ? "is-field-updated" : ""}`}
            data-config-target="agent.instructions"
          >
            <span>自然语言分拣偏好</span>
            <textarea
              rows={2}
              value={agentDraft.instructions}
              placeholder="例如：客户与同事来信优先保留在消息列表，促销周刊折叠进通知…"
              onChange={(e) =>
                setAgentDraft({ ...agentDraft, instructions: e.target.value })
              }
            />
          </label>

          <div className="ins-subform-actions">
            <button
              type="button"
              className="soft-btn compact-btn"
              disabled={testingAgent}
              onClick={handleTestAgentLlm}
            >
              {testingAgent ? "测试中…" : "测试模型连通"}
            </button>
            <button
              type="button"
              className={`${agentDirty ? "primary-btn" : "soft-btn"} compact-btn`}
              disabled={savingAgent || !agentDirty}
              onClick={saveAgentDetails}
            >
              {savingAgent ? "保存中…" : agentDirty ? "保存模型参数" : "参数已同步"}
            </button>
          </div>
        </div>
      </section>

      {/* 3. 分流过滤规则卡片 */}
      <section
        className={`ins-card ${changedSections.has("triage") ? "is-section-updated" : ""}`}
        data-config-section="triage"
      >
        <div className="ins-card-head">
          <div className="ins-card-title-row">
            <span className="ins-card-title">分流过滤规则</span>
            <span className="ins-count-pill">{totalRuleCount}</span>
            {changedSections.has("triage") && (
              <span className="ins-updated-badge">刚修改</span>
            )}
          </div>
        </div>

        <div className="ins-rule-adder">
          <select
            value={newRuleField}
            onChange={(e) => setNewRuleField(e.target.value as TriageFieldKey)}
          >
            {TRIAGE_FIELD_META.map((m) => (
              <option key={m.key} value={m.key}>
                {m.shortLabel}
              </option>
            ))}
          </select>
          <div className="ins-rule-adder-input">
            <input
              value={newRuleValue}
              placeholder="输入关键词、邮箱或域名，回车添加…"
              onChange={(e) => setNewRuleValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddRule();
                }
              }}
            />
            <button
              type="button"
              className="primary-btn compact-btn"
              disabled={busyRule || !newRuleValue.trim()}
              onClick={handleAddRule}
            >
              添加
            </button>
          </div>
        </div>

        {totalRuleCount === 0 ? (
          <div className="ins-empty-box">
            <span>暂未设置过滤规则（0 延迟优先于大模型匹配白名单、折叠与屏蔽）</span>
          </div>
        ) : (
          <div className="ins-rule-groups">
            {TRIAGE_FIELD_META.map((meta) => {
              const values = spec.triage[meta.key] ?? [];
              const targetKey = `triage.${meta.key}`;
              const fieldDiffs = itemsByTarget.get(targetKey) ?? [];
              if (values.length === 0 && fieldDiffs.length === 0) return null;

              const newlyAddedSet = new Set<string>();
              for (const fd of fieldDiffs) {
                if (fd.kind === "added" || fd.kind === "modified") {
                  fd.after
                    .replace(/^新增\s*/, "")
                    .split("、")
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean)
                    .forEach((s) => newlyAddedSet.add(s));
                }
              }

              return (
                <div
                  key={meta.key}
                  data-config-target={targetKey}
                  className={`ins-rule-group ${fieldDiffs.length > 0 ? "is-field-updated" : ""}`}
                >
                  <div className="ins-rule-group-head">
                    <span className={`ins-rule-dot tone-${meta.badgeTone}`} />
                    <span className="ins-rule-group-title">{meta.groupLabel}</span>
                    {fieldDiffs.length > 0 && (
                      <span className="ins-updated-badge">刚更新</span>
                    )}
                  </div>
                  <div className="ins-rule-tags">
                    {values.map((v) => {
                      const isNewChip = newlyAddedSet.has(v.trim().toLowerCase());
                      return (
                        <span
                          key={v}
                          className={`ins-rule-tag tone-${meta.badgeTone} ${isNewChip ? "is-new-tag" : ""}`}
                        >
                          <span>{v}</span>
                          <button
                            type="button"
                            className="ins-rule-tag-del"
                            disabled={busyRule}
                            onClick={() => handleRemoveRuleItem(meta.key, v)}
                            title={`移除规则「${v}」`}
                          >
                            <IconClose size={10} />
                          </button>
                        </span>
                      );
                    })}
                    {values.length === 0 && fieldDiffs[0]?.kind === "removed" && (
                      <span className="ins-removed-note">
                        已移除：{fieldDiffs[0].before}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. 邮件群聊声明卡片 */}
      <section
        className={`ins-card ${changedSections.has("groups") ? "is-section-updated" : ""}`}
        data-config-section="groups"
        data-config-target="groups"
      >
        <div className="ins-card-head">
          <div className="ins-card-title-row">
            <span className="ins-card-title">邮件群聊声明</span>
            <span className="ins-count-pill">{spec.groups.length}</span>
            {changedSections.has("groups") && (
              <span className="ins-updated-badge">刚修改</span>
            )}
          </div>
        </div>

        {spec.groups.length === 0 ? (
          <div className="ins-empty-box">
            <span>暂无群聊声明，可在左侧对助手说「创建一个项目组群聊，成员包含…」</span>
          </div>
        ) : (
          <div className="ins-group-list">
            {spec.groups.map((grp) => {
              const cleanId = grp.id.replace(/^group:/, "");
              const targetKey = `group:${cleanId}`;
              const fieldDiffs = itemsByTarget.get(targetKey) ?? [];
              return (
                <div
                  key={grp.id}
                  data-config-target={targetKey}
                  className={`ins-group-item ${fieldDiffs.length > 0 ? "is-item-updated" : ""}`}
                >
                  <div className="ins-group-top">
                    <div className="ins-group-title-wrap">
                      <span className="ins-group-name">{grp.name}</span>
                      <span className="ins-mini-pill muted">
                        {grp.members.length} 位成员
                      </span>
                      {fieldDiffs.length > 0 && (
                        <span className="ins-updated-badge">AI 已改</span>
                      )}
                    </div>
                    <label className="clean-switch compact-switch">
                      <input
                        type="checkbox"
                        checked={grp.muted}
                        onChange={(e) => handleToggleGroupMute(grp.id, e.target.checked)}
                      />
                      <span>免打扰</span>
                    </label>
                  </div>
                  {grp.members.length > 0 && (
                    <div className="ins-group-members">
                      {grp.members.map((m) => (
                        <span key={m.email} className="ins-member-chip">
                          {m.name ? `${m.name} <${m.email}>` : m.email}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------- 右侧「变更对比」专页 ---------------- */

function InspectorDiffView({
  activeDiff,
  onJumpToVisual,
  onRevertBeforeToml,
}: {
  activeDiff: ConfigDiffReport | null;
  onJumpToVisual: (targetKey: string) => void;
  onRevertBeforeToml?: (beforeToml: string) => Promise<void>;
}) {
  const [reverting, setReverting] = useState(false);

  if (
    !activeDiff ||
    (activeDiff.items.length === 0 &&
      activeDiff.before_toml.trim() === activeDiff.after_toml.trim())
  ) {
    return (
      <div className="inspector-diff-empty-pane">
        <div className="inspector-diff-empty-card">
          <IconCode size={20} />
          <div className="inspector-diff-empty-title">暂无最近修改记录</div>
          <p>
            每当配置助手修改邮箱账号、模型服务、过滤规则或群聊设置时，这里都会清晰列出具体修改了哪些字段以及{" "}
            <code>config.toml</code> 的前后对比。
          </p>
        </div>
      </div>
    );
  }

  const hasTomlDiff =
    Boolean(activeDiff.before_toml.trim()) &&
    Boolean(activeDiff.after_toml.trim()) &&
    activeDiff.before_toml.trim() !== activeDiff.after_toml.trim();

  return (
    <div className="inspector-diff-pane-scroll">
      <div className="ins-card">
        <div className="ins-card-head">
          <div className="ins-card-title-row">
            <span className="ins-card-title">最近一次修改明细</span>
            <span className="ins-count-pill">{activeDiff.items.length} 项</span>
          </div>
          {hasTomlDiff && onRevertBeforeToml && (
            <button
              type="button"
              className="soft-btn compact-btn danger-text"
              disabled={reverting}
              onClick={async () => {
                setReverting(true);
                try {
                  await onRevertBeforeToml(activeDiff.before_toml);
                } finally {
                  setReverting(false);
                }
              }}
            >
              {reverting ? "还原中…" : "撤销此次修改"}
            </button>
          )}
        </div>

        {activeDiff.items.length > 0 && (
          <div className="agent-change-list">
            {activeDiff.items.map((item, idx) => (
              <button
                key={`${item.target_key}-${idx}`}
                type="button"
                className={`agent-change-row kind-${item.kind}`}
                onClick={() => onJumpToVisual(item.target_key)}
                title="点击跳转到可视化表单对应位置"
              >
                <div className="agent-change-row-left">
                  <span className={`change-sec-badge sec-${item.section}`}>
                    {item.section_label}
                  </span>
                  <span className="change-field-name">{item.field_label}</span>
                </div>
                <div className="agent-change-row-vals">
                  {item.kind === "added" ? (
                    <span className="diff-val-pill added">+ {item.after}</span>
                  ) : item.kind === "removed" ? (
                    <span className="diff-val-pill removed">− {item.before}</span>
                  ) : (
                    <>
                      <span className="diff-val-pill old">{item.before}</span>
                      <span className="diff-val-arrow">→</span>
                      <span className="diff-val-pill new">{item.after}</span>
                    </>
                  )}
                  <IconChevron size={11} className="diff-jump-chevron" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {hasTomlDiff && (
        <div className="ins-card">
          <div className="ins-card-head">
            <span className="ins-card-title">配置文件差异 (config.toml Diff)</span>
          </div>
          <TomlDiffViewer
            beforeToml={activeDiff.before_toml}
            afterToml={activeDiff.after_toml}
          />
        </div>
      )}
    </div>
  );
}
