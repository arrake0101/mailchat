import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, MODEL_PRESETS, type ModelPreset } from "../api";
import { applyThemeToDom } from "../theme";
import {
  mailSecretKey,
  type AgentConfig,
  type AgentInstanceDescriptor,
  type AgentInstanceId,
  type AgentSessionSummary,
  type AgentTurnRecord,
  type ConfigDiffReport,
  type DeclarativeConfigSpec,
  type KernelClientEffect,
  type KernelInstanceSnapshot,
  type KernelStreamPayload,
  type KernelWorkspaceContext,
  type MagpieProbeReport,
  type SecretPrompt,
  type SecretStatus,
} from "../types";
import { ConfigChangeSummaryCard } from "./AgentConfigInspector";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconCode,
  IconHistory,
  IconKey,
  IconLock,
  IconPlus,
  IconSend,
  IconSliders,
  IconSparkles,
  IconStop,
  IconThink,
  IconTrash,
  IconUndo,
} from "./Icons";
import { MarkdownText } from "./MarkdownText";
import type { SettingsTab } from "./Settings";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

export interface RichTurn {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  thinkingMs?: number;
  thinkingContextLabel?: string;
  toolSteps?: string[];
  changes?: string[];
  configDiff?: ConfigDiffReport | null;
  snapshotToml?: string;
  secretPrompts?: SecretPrompt[];
  suggestions?: string[];
  badge?: string;
  streaming?: boolean;
  createdAt?: number;
}

export interface ConfiguredProviderOption {
  preset: ModelPreset;
  isActive: boolean;
  savedModel: string;
  candidateModels: string[];
  secretKey: string | null;
  maskedSecret: string;
}

export interface KernelStarterCard {
  title: string;
  desc: string;
  text: string;
}

export function parseActiveAgentMeta(tomlText: string, agentCfg: AgentConfig | null) {
  if (agentCfg && agentCfg.preset?.trim()) {
    return {
      presetId: agentCfg.preset.trim(),
      modelName: agentCfg.model?.trim() || "deepseek-v4.1-flash",
      baseUrl: agentCfg.base_url?.trim() || "",
    };
  }
  const agentBlockMatch = tomlText.match(/\[agent\]([\s\S]*?)(?:\n\[|$)/);
  const section = agentBlockMatch ? agentBlockMatch[1] : tomlText;
  const presetMatch = section.match(/^\s*preset\s*=\s*"([^"]+)"/m);
  const modelMatch = section.match(/^\s*model\s*=\s*"([^"]+)"/m);
  const baseMatch = section.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
  return {
    presetId: presetMatch?.[1]?.trim() || "deepseek",
    modelName: modelMatch?.[1]?.trim() || "deepseek-v4.1-flash",
    baseUrl: baseMatch?.[1]?.trim() || "",
  };
}

export function computeActiveAgentMeta(
  tomlText: string,
  agentCfg: AgentConfig | null,
  secrets: SecretStatus[],
) {
  const { presetId, modelName, baseUrl } = parseActiveAgentMeta(tomlText, agentCfg);
  const presetObj = MODEL_PRESETS.find((p) => p.id === presetId);
  const presetLabel = presetObj?.name ?? presetId;
  const secretSlot = presetId === "ollama" ? null : `llm_${presetId}`;
  const hasSecret = secretSlot ? secrets.some((s) => s.key === secretSlot && s.configured) : true;
  const isLocalMagpie =
    presetId === "magpie" &&
    (!baseUrl || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost"));
  const keylessOk =
    isLocalMagpie ||
    presetId === "ollama" ||
    presetId === "ollama_remote" ||
    (presetId === "custom" && Boolean(baseUrl));
  const ready = hasSecret || keylessOk;
  return { presetId, presetLabel, modelName, ready, secretSlot };
}

export function computeConfiguredProviders(
  agentConfig: AgentConfig | null,
  secrets: SecretStatus[],
  activePresetId: string,
  activeModelName: string,
  magpieProbe: MagpieProbeReport | null,
): ConfiguredProviderOption[] {
  const list: ConfiguredProviderOption[] = [];
  for (const preset of MODEL_PRESETS) {
    const secretKey = preset.id === "ollama" ? null : `llm_${preset.id}`;
    const sec = secretKey ? secrets.find((s) => s.key === secretKey) : undefined;
    const hasSecret = Boolean(sec?.configured);
    const prof = agentConfig?.profiles?.[preset.id];
    const isActive = activePresetId === preset.id;

    let isConfigured = false;
    if (preset.id === "magpie") {
      isConfigured =
        isActive ||
        Boolean(prof?.base_url?.trim()) ||
        hasSecret ||
        Boolean(magpieProbe?.gateway_online);
    } else if (preset.needsKey) {
      isConfigured = hasSecret;
    } else if (preset.id === "custom") {
      const activeCustomReady =
        isActive && Boolean(agentConfig?.base_url?.trim()) && Boolean(agentConfig?.model?.trim());
      const profCustomReady = Boolean(prof?.base_url?.trim() && prof?.model?.trim());
      isConfigured = hasSecret || activeCustomReady || profCustomReady;
    } else {
      const activeReady = isActive && Boolean(agentConfig?.base_url?.trim());
      const profReady = Boolean(prof?.base_url?.trim() || prof?.model?.trim());
      isConfigured = activeReady || profReady || hasSecret;
    }

    if (!isConfigured) continue;

    const savedModel =
      preset.id === "magpie"
        ? (isActive ? agentConfig?.model?.trim() : prof?.model?.trim()) ||
          magpieProbe?.recommended_model ||
          preset.defaultModel
        : (isActive ? agentConfig?.model?.trim() : prof?.model?.trim()) ||
          prof?.model?.trim() ||
          preset.defaultModel ||
          activeModelName;

    const dedupModels: string[] = [];
    const rawCandidates =
      preset.id === "magpie" && magpieProbe
        ? [
            savedModel,
            "auto",
            ...magpieProbe.agent_bindings.map((b) => b.model),
            ...magpieProbe.groups,
            ...magpieProbe.models,
          ]
        : [savedModel, ...preset.models];

    for (const m of rawCandidates) {
      const trimmed = m?.trim();
      if (trimmed && !dedupModels.includes(trimmed)) {
        dedupModels.push(trimmed);
      }
    }

    const maskedSecret =
      preset.id === "magpie"
        ? sec?.configured
          ? sec.masked
          : magpieProbe?.gateway_online
            ? `本机免配 · ${magpieProbe.models.length} 模型`
            : "免密钥直连"
        : sec?.configured
          ? sec.masked
          : preset.needsKey
            ? ""
            : "免密钥直连";

    list.push({
      preset,
      isActive,
      savedModel,
      candidateModels: dedupModels.slice(0, 7),
      secretKey,
      maskedSecret,
    });
  }

  list.sort((a, b) => Number(b.isActive) - Number(a.isActive));
  return list;
}

export function mapRecordToRichTurn(
  r: AgentTurnRecord,
  thinkingContextLabel?: string,
): RichTurn {
  return {
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    content: r.content,
    thinking: r.thinking || "",
    thinkingMs: r.thinking_ms || 0,
    thinkingContextLabel,
    toolSteps: r.tool_steps || [],
    changes: r.changes || [],
    configDiff: r.config_diff ?? null,
    snapshotToml: r.snapshot_toml || "",
    secretPrompts: r.secret_prompts || [],
    suggestions: r.suggestions || [],
    streaming: false,
    createdAt: r.created_at,
  };
}

export function extractLatestDiff(list: RichTurn[]): ConfigDiffReport | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i].configDiff;
    if (d && (d.items.length > 0 || d.before_toml.trim() !== d.after_toml.trim())) {
      return d;
    }
  }
  return null;
}

function formatSessionTime(unixSecs: number): string {
  if (!unixSecs) return "";
  const d = new Date(unixSecs * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export interface SnapshotSyncPayload {
  path: string;
  toml: string;
  spec: DeclarativeConfigSpec;
  secrets: SecretStatus[];
  activeDiff?: ConfigDiffReport | null;
  isLivePreview?: boolean;
}

export interface AgentKernelPaneProps {
  /** 实例唯一标识：`"config"`（声明式配置实例） | `"mail"`（邮件处理实例） */
  instanceId: AgentInstanceId;
  /** 面板挂载形态：全屏左栏工作台 | 右侧外挂可收缩面板 */
  variant?: "workspace" | "outrigger";
  activeAccountEmail?: string;
  /** 仅 `"mail"` 实例传入当前宿主页面的实时上下文快照 */
  workspaceContext?: KernelWorkspaceContext | null;
  /** 可选顶部上下文提示条（如当前收件人/待审项或 config 范围提示） */
  contextBanner?: React.ReactNode;
  /** 空状态自定义引导卡片 */
  starterCards?: KernelStarterCard[];
  emptyHeading?: string;
  emptyDescription?: React.ReactNode;
  emptyScopeBanner?: React.ReactNode;
  headerTitleOverride?: string;
  headerBadgeOverride?: string;
  headerSubtitleOverride?: string;
  placeholderOverride?: string;
  thinkingContextLabel?: string;
  /** 外部注入的快捷提问请求（例如写信工具栏「AI 润色」或批复页「让 AI 改写」） */
  externalPromptRequest?: { seq: number; prompt: string; autoSend?: boolean } | null;
  /** 外部请求打开凭据保险箱（例如右侧可视化检查器点击录入授权码或 API Key） */
  externalVaultRequest?: { seq: number; focusKey?: string | null } | null;
  /** 当外部手动编辑并应用了 config.toml 或保险箱凭据时递增以触发本实例状态刷新 */
  externalSyncToken?: number;
  /** 右侧外挂形态下的收起回调 */
  onCollapse?: () => void;
  /** 向宿主（如 AgentWorkspace 右侧配置检查器）同步最新声明式配置快照与 Diff */
  onSnapshotSync?: (payload: SnapshotSyncPayload) => void;
  /** 实时流式推送写信 HTML 预览 */
  onStreamPreviewHtml?: (html: string) => void;
  /** 执行完一轮内核工具循环后产出的结构化前端副作用（由宿主无分支直接消费） */
  onKernelEffects?: (effects: KernelClientEffect[]) => void;
  onLocateInForm?: (targetKey: string, diff?: ConfigDiffReport | null) => void;
  onOpenDiffTab?: (diff: ConfigDiffReport) => void;
  onRevertBeforeToml?: (beforeToml: string) => Promise<void>;
  onOpenSettings: (tab: SettingsTab) => void;
  onDataChanged: () => void;
  notify: (text: string, isError?: boolean) => void;
}

/**
 * 统一智能体内核前端视图（`AgentKernelPane`）：
 * - 同一套流式推理、`<think>` 折叠、工具轨迹、检查点回退、DPAPI 保险箱与独立模型切换内核；
 * - 通过 `instanceId`（`"config"` vs `"mail"`）实现会话命名空间、模型配置与工具能力包的彻底隔离。
 */
export function AgentKernelPane({
  instanceId,
  variant = "workspace",
  activeAccountEmail,
  workspaceContext,
  contextBanner,
  starterCards,
  emptyHeading,
  emptyDescription,
  emptyScopeBanner,
  headerTitleOverride,
  headerBadgeOverride,
  headerSubtitleOverride,
  placeholderOverride,
  thinkingContextLabel,
  externalPromptRequest,
  externalVaultRequest,
  externalSyncToken = 0,
  onCollapse,
  onSnapshotSync,
  onStreamPreviewHtml,
  onKernelEffects,
  onLocateInForm,
  onOpenDiffTab,
  onRevertBeforeToml,
  onOpenSettings,
  onDataChanged,
  notify,
}: AgentKernelPaneProps) {
  const isConfigInstance = instanceId === "config";
  const resolvedThinkingLabel =
    thinkingContextLabel ?? (isConfigInstance ? "配置方案" : "邮件任务");

  const [descriptor, setDescriptor] = useState<AgentInstanceDescriptor | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<RichTurn[]>([]);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [savedToml, setSavedToml] = useState("");
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [magpieProbe, setMagpieProbe] = useState<MagpieProbeReport | null>(null);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showVaultDrawer, setShowVaultDrawer] = useState(false);
  const [vaultFocusKey, setVaultFocusKey] = useState<string | null>(null);
  const [showModelQuickMenu, setShowModelQuickMenu] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);

  const [rewindConfirm, setRewindConfirm] = useState<{
    turnId: number;
    anchor: "user" | "latest";
  } | null>(null);
  const [rewinding, setRewinding] = useState(false);

  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const quickMenuRef = useRef<HTMLDivElement>(null);

  const activeRequestIdRef = useRef<string | null>(null);
  const streamingTurnIdRef = useRef<string | null>(null);
  const handledExternalSeqRef = useRef(0);
  const handledVaultSeqRef = useRef(0);

  const onSnapshotSyncRef = useRef(onSnapshotSync);
  onSnapshotSyncRef.current = onSnapshotSync;
  const onStreamPreviewHtmlRef = useRef(onStreamPreviewHtml);
  onStreamPreviewHtmlRef.current = onStreamPreviewHtml;

  const applyInstanceSnapshot = useCallback(
    (snap: KernelInstanceSnapshot, syncTurns: boolean) => {
      setDescriptor(snap.descriptor);
      setAgentConfig(snap.agent_config);
      setSessions(snap.sessions);
      setSavedToml(snap.toml);
      setSecrets(snap.secrets);
      if (snap.spec?.theme && isConfigInstance) {
        applyThemeToDom(snap.spec.theme);
      }
      let latestDiff: ConfigDiffReport | null = null;
      if (syncTurns) {
        setActiveSessionId(snap.active_session_id);
        const mapped = snap.turns.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel));
        setTurns(mapped);
        latestDiff = extractLatestDiff(mapped);
      }
      onSnapshotSyncRef.current?.({
        path: snap.path,
        toml: snap.toml,
        spec: snap.spec,
        secrets: snap.secrets,
        activeDiff: syncTurns ? latestDiff : undefined,
      });
    },
    [isConfigInstance, resolvedThinkingLabel],
  );

  const refreshInstanceMeta = useCallback(async () => {
    try {
      const snap = await api.getAgentInstanceState(instanceId);
      applyInstanceSnapshot(snap, false);
    } catch (e) {
      notify(String(e), true);
    }
  }, [applyInstanceSnapshot, instanceId, notify]);

  // 初始化挂载：加载本实例专属会话、轮次与本实例独立的激活模型配置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.getAgentInstanceState(instanceId);
        if (cancelled) return;
        applyInstanceSnapshot(snap, true);
        api
          .probeMagpie(
            snap.agent_config.preset === "magpie" ? snap.agent_config.base_url : undefined,
          )
          .then((rep) => {
            if (!cancelled) setMagpieProbe(rep);
          })
          .catch(() => {});
      } catch (e) {
        if (!cancelled) notify(`初始化智能体实例失败：${e}`, true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyInstanceSnapshot, instanceId, notify]);

  // 当顶栏切换邮箱账号或右侧配置检查器手工保存了配置时，同步刷新最新元数据（不重置当前会话轮次）
  const prevSyncKeyRef = useRef(`${activeAccountEmail ?? ""}::${externalSyncToken}`);
  useEffect(() => {
    const nextKey = `${activeAccountEmail ?? ""}::${externalSyncToken}`;
    if (prevSyncKeyRef.current !== nextKey) {
      prevSyncKeyRef.current = nextKey;
      void refreshInstanceMeta();
    }
  }, [activeAccountEmail, externalSyncToken, refreshInstanceMeta]);

  // 订阅统一内核流式总线 `"agent-kernel-stream"`，严格按 `instance_id === instanceId` 隔离消费
  useEffect(() => {
    const unlistenPromise = listen<KernelStreamPayload>("agent-kernel-stream", (ev) => {
      const p = ev.payload;
      if (
        !p ||
        p.instance_id !== instanceId ||
        !activeRequestIdRef.current ||
        p.request_id !== activeRequestIdRef.current
      ) {
        return;
      }

      if (p.kind === "compose_html_preview" && p.delta) {
        onStreamPreviewHtmlRef.current?.(p.delta);
        return;
      }

      if (p.kind === "toml" && p.delta) {
        setSavedToml(p.delta);
        return;
      }

      if (p.kind === "spec_preview" && p.delta) {
        try {
          const parsed = JSON.parse(p.delta) as {
            spec?: DeclarativeConfigSpec;
            config_diff?: ConfigDiffReport | null;
          };
          if (parsed.spec?.theme) {
            applyThemeToDom(parsed.spec.theme);
          }
          if (parsed.spec) {
            onSnapshotSyncRef.current?.({
              path: "",
              toml: parsed.config_diff?.after_toml || "",
              spec: parsed.spec,
              secrets: [],
              activeDiff: parsed.config_diff ?? null,
              isLivePreview: true,
            });
          }
          if (
            parsed.config_diff &&
            (parsed.config_diff.items.length > 0 ||
              parsed.config_diff.before_toml.trim() !== parsed.config_diff.after_toml.trim())
          ) {
            const tid = streamingTurnIdRef.current;
            if (tid) {
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === tid ? { ...t, configDiff: parsed.config_diff } : t,
                ),
              );
            }
          }
        } catch {
          // ignore malformed preview
        }
        return;
      }

      const targetId = streamingTurnIdRef.current;
      if (!targetId) return;

      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== targetId) return t;
          if (p.kind === "thinking") {
            return {
              ...t,
              thinking: (t.thinking || "") + p.delta,
              thinkingMs: p.thinking_ms || t.thinkingMs || 0,
            };
          }
          if (p.kind === "content") {
            return {
              ...t,
              content: t.content + p.delta,
              thinkingMs: p.thinking_ms || t.thinkingMs || 0,
            };
          }
          if (p.kind === "tool") {
            const existing = t.toolSteps || [];
            if (existing[existing.length - 1] === p.delta) return t;
            return {
              ...t,
              toolSteps: [...existing, p.delta],
            };
          }
          return t;
        }),
      );
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [instanceId]);

  const lastTurn = turns[turns.length - 1];
  const streamSignature = `${turns.length}:${lastTurn?.content.length ?? 0}:${lastTurn?.thinking?.length ?? 0}:${lastTurn?.toolSteps?.length ?? 0}`;

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (turns.length === 0) {
      el.scrollTop = 0;
      return;
    }
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamSignature, activeSessionId, turns.length]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const maxPx = 148;
    const contentH = el.scrollHeight;
    const nextH = Math.min(Math.max(24, contentH), maxPx);
    el.style.height = `${nextH}px`;
    el.style.overflowY = contentH > maxPx ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    if (!showModelQuickMenu) return;
    let cancelled = false;
    api
      .probeMagpie(agentConfig?.preset === "magpie" ? agentConfig.base_url : undefined)
      .then((rep) => {
        if (!cancelled) setMagpieProbe(rep);
      })
      .catch(() => {});
    const onDocClick = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowModelQuickMenu(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [showModelQuickMenu, agentConfig?.preset, agentConfig?.base_url]);

  const openVaultDrawer = useCallback((focusKey?: string | null) => {
    setShowModelQuickMenu(false);
    setShowHistoryDrawer(false);
    setVaultFocusKey(focusKey ?? null);
    setShowVaultDrawer(true);
  }, []);

  useEffect(() => {
    if (!externalVaultRequest || externalVaultRequest.seq <= handledVaultSeqRef.current) {
      return;
    }
    handledVaultSeqRef.current = externalVaultRequest.seq;
    openVaultDrawer(externalVaultRequest.focusKey ?? null);
  }, [externalVaultRequest, openVaultDrawer]);

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId === activeSessionId) {
      setShowHistoryDrawer(false);
      return;
    }
    if (busy) {
      notify("当前正在流式生成，请等待完成或点击停止后再切换会话");
      return;
    }
    try {
      stickToBottomRef.current = true;
      setActiveSessionId(sessionId);
      const records = await api.getInstanceSessionTurns(instanceId, sessionId);
      const mapped = records.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel));
      setTurns(mapped);
      if (isConfigInstance) {
        const snap = await api.getAgentInstanceState(instanceId);
        onSnapshotSyncRef.current?.({
          path: snap.path,
          toml: snap.toml,
          spec: snap.spec,
          secrets: snap.secrets,
          activeDiff: extractLatestDiff(mapped),
        });
      }
      setRewindConfirm(null);
      setShowHistoryDrawer(false);
    } catch (e) {
      notify(`加载历史会话失败：${e}`, true);
    }
  };

  const handleNewSession = async () => {
    if (busy) {
      notify("请先等待当前生成完成或点击停止");
      return;
    }
    try {
      const created = await api.createInstanceSession(instanceId);
      setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
      setActiveSessionId(created.id);
      setTurns([]);
      setRewindConfirm(null);
      setShowHistoryDrawer(false);
      stickToBottomRef.current = true;
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      notify(`新建对话失败：${e}`, true);
    }
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy && sessionId === activeSessionId) {
      await api.cancelAgentKernelTurn(activeRequestIdRef.current).catch(() => {});
    }
    try {
      const nextSessions = await api.deleteInstanceSession(instanceId, sessionId);
      setSessions(nextSessions);
      if (sessionId === activeSessionId) {
        setRewindConfirm(null);
        if (nextSessions.length > 0) {
          const nextId = nextSessions[0].id;
          setActiveSessionId(nextId);
          const records = await api.getInstanceSessionTurns(instanceId, nextId);
          setTurns(records.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel)));
        } else {
          const fresh = await api.createInstanceSession(instanceId);
          setSessions([fresh]);
          setActiveSessionId(fresh.id);
          setTurns([]);
        }
      }
    } catch (err) {
      notify(`删除会话失败：${err}`, true);
    }
  };

  const inspectRewindFromIndex = useCallback(
    (fromIdx: number) => {
      const target = turns[fromIdx];
      if (!target || typeof target.id !== "number") return null;
      const slice = turns.slice(fromIdx);
      const userRoundCount = Math.max(1, slice.filter((x) => x.role === "user").length);

      let rollbackToml: string | null = null;
      if (isConfigInstance) {
        if (target.snapshotToml && target.snapshotToml.trim().length > 0) {
          rollbackToml = target.snapshotToml;
        } else {
          for (const item of slice) {
            if (item.configDiff?.before_toml?.trim()) {
              rollbackToml = item.configDiff.before_toml;
              break;
            }
          }
        }
      }

      let changedItemCount = 0;
      let hasDiffInSlice = false;
      for (const item of slice) {
        const d = item.configDiff;
        if (d && (d.items.length > 0 || d.before_toml.trim() !== d.after_toml.trim())) {
          hasDiffInSlice = true;
          changedItemCount += d.items.length;
        }
      }
      const snapshotDiffers =
        rollbackToml !== null && rollbackToml.trim() !== savedToml.trim();
      const hasConfigChanges =
        isConfigInstance && Boolean(rollbackToml) && (hasDiffInSlice || snapshotDiffers);

      return {
        turnId: target.id,
        promptText: target.content,
        userRoundCount,
        hasConfigChanges,
        changedItemCount,
      };
    },
    [isConfigInstance, turns, savedToml],
  );

  const executeRewind = useCallback(
    async (turnId: number, promptText: string, restoreConfig: boolean) => {
      if (!activeSessionId || busy || rewinding) return;
      setRewinding(true);
      try {
        const res = await api.rewindInstanceSession(
          instanceId,
          activeSessionId,
          turnId,
          isConfigInstance && restoreConfig,
        );
        const mapped = res.turns.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel));
        const nextDiff = extractLatestDiff(mapped);
        setTurns(mapped);
        setSessions(res.sessions);
        setSavedToml(res.bundle.toml);
        setSecrets(res.bundle.secrets);
        if (res.config_restored) {
          if (res.bundle.spec?.theme) {
            applyThemeToDom(res.bundle.spec.theme);
          }
          onSnapshotSyncRef.current?.({
            path: res.bundle.path,
            toml: res.bundle.toml,
            spec: res.bundle.spec,
            secrets: res.bundle.secrets,
            activeDiff: nextDiff,
          });
          onDataChanged();
        } else if (isConfigInstance) {
          onSnapshotSyncRef.current?.({
            path: res.bundle.path,
            toml: res.bundle.toml,
            spec: res.bundle.spec,
            secrets: res.bundle.secrets,
            activeDiff: nextDiff,
          });
        }
        setRewindConfirm(null);
        setInput(promptText);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) {
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
          }
        });
        notify(
          res.config_restored
            ? "已回退对话并还原对应配置，原指令已填回输入框"
            : "已回退至该条消息，可修改指令后重新发送",
        );
      } catch (e) {
        notify(`回退对话失败：${e}`, true);
      } finally {
        setRewinding(false);
      }
    },
    [
      activeSessionId,
      busy,
      instanceId,
      isConfigInstance,
      notify,
      onDataChanged,
      resolvedThinkingLabel,
      rewinding,
    ],
  );

  const requestRewindAt = useCallback(
    (fromIdx: number, anchor: "user" | "latest") => {
      if (busy || rewinding) return;
      const info = inspectRewindFromIndex(fromIdx);
      if (!info) return;
      if (!info.hasConfigChanges && info.userRoundCount <= 1) {
        void executeRewind(info.turnId, info.promptText, false);
        return;
      }
      setRewindConfirm((prev) =>
        prev?.turnId === info.turnId && prev.anchor === anchor
          ? null
          : { turnId: info.turnId, anchor },
      );
    },
    [busy, executeRewind, inspectRewindFromIndex, rewinding],
  );

  const handleStopStreaming = async () => {
    const rid = activeRequestIdRef.current;
    try {
      await api.cancelAgentKernelTurn(rid);
    } catch {
      // ignore
    }
  };

  const handleSwitchModel = async (presetId: string, modelName?: string) => {
    if (switchingModel) return;
    setSwitchingModel(true);
    try {
      const instanceLabel = isConfigInstance ? "配置助手实例" : "邮件智能体实例";
      if (presetId === "magpie") {
        const res = await api.connectInstanceMagpie(instanceId, {
          baseUrl: agentConfig?.preset === "magpie" ? agentConfig.base_url : undefined,
          model: modelName,
          autoStart: true,
        });
        setMagpieProbe(res.probe);
        setAgentConfig(res.agent_config);
        setSavedToml(res.bundle.toml);
        setSecrets(res.bundle.secrets);
        setShowModelQuickMenu(false);
        if (isConfigInstance) {
          onSnapshotSyncRef.current?.({
            path: res.bundle.path,
            toml: res.bundle.toml,
            spec: res.bundle.spec,
            secrets: res.bundle.secrets,
          });
          onDataChanged();
        }
        notify(
          res.probe.gateway_online
            ? `${instanceLabel}已切换至 Magpie · ${res.agent_config.model}`
            : `${instanceLabel}已切换至 Magpie（${res.probe.message}）`,
        );
        return;
      }

      const res = await api.switchInstanceModel(instanceId, presetId, modelName);
      setAgentConfig(res.agent_config);
      setSavedToml(res.bundle.toml);
      setSecrets(res.bundle.secrets);
      setShowModelQuickMenu(false);
      if (isConfigInstance) {
        onSnapshotSyncRef.current?.({
          path: res.bundle.path,
          toml: res.bundle.toml,
          spec: res.bundle.spec,
          secrets: res.bundle.secrets,
        });
        onDataChanged();
      }
      const presetLabel = MODEL_PRESETS.find((p) => p.id === presetId)?.name ?? presetId;
      notify(`${instanceLabel}已切换为 ${presetLabel} · ${res.agent_config.model}`);
    } catch (e) {
      notify(`切换模型失败：${e}`, true);
    } finally {
      setSwitchingModel(false);
    }
  };

  const sendPrompt = useCallback(
    async (rawText?: string) => {
      const msg = (rawText ?? input).trim();
      if (!msg || busy) return;
      if (rawText === undefined) setInput("");
      setShowModelQuickMenu(false);
      setShowHistoryDrawer(false);
      setRewindConfirm(null);
      stickToBottomRef.current = true;

      const reqId = `kreq-${instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const streamTurnId = `stream-${reqId}`;
      activeRequestIdRef.current = reqId;
      streamingTurnIdRef.current = streamTurnId;

      const userTurn: RichTurn = {
        id: `user-${reqId}`,
        role: "user",
        content: msg,
        snapshotToml: isConfigInstance ? savedToml : "",
      };
      const optimisticAssistantTurn: RichTurn = {
        id: streamTurnId,
        role: "assistant",
        content: "",
        thinking: "",
        thinkingMs: 0,
        thinkingContextLabel: resolvedThinkingLabel,
        toolSteps: [],
        streaming: true,
      };

      setTurns((prev) => [...prev, userTurn, optimisticAssistantTurn]);
      setBusy(true);

      try {
        const res = await api.runAgentKernelTurn({
          instance_id: instanceId,
          message: msg,
          session_id: activeSessionId,
          request_id: reqId,
          workspace_context: isConfigInstance ? null : (workspaceContext ?? null),
        });

        setActiveSessionId(res.session_id);
        setSessions(res.sessions);
        setAgentConfig(res.agent_config);
        setSavedToml(res.toml);
        setSecrets(res.secrets);

        if (isConfigInstance) {
          if (res.spec?.theme) {
            applyThemeToDom(res.spec.theme);
          }
          onSnapshotSyncRef.current?.({
            path: "",
            toml: res.toml,
            spec: res.spec,
            secrets: res.secrets,
            activeDiff: res.config_diff ?? undefined,
          });
        }

        if (res.turns && res.turns.length > 0) {
          setTurns(res.turns.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel)));
        } else {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === streamTurnId
                ? {
                    id: streamTurnId,
                    role: "assistant",
                    content: res.reply,
                    thinking: res.thinking,
                    thinkingMs: res.thinking_ms,
                    thinkingContextLabel: resolvedThinkingLabel,
                    toolSteps: res.tool_steps,
                    changes: res.changes,
                    configDiff: res.config_diff ?? null,
                    secretPrompts: res.secret_prompts,
                    suggestions: res.suggestions,
                    streaming: false,
                  }
                : t,
            ),
          );
        }

        if (res.effects && res.effects.length > 0) {
          onKernelEffects?.(res.effects);
        }
        onDataChanged();
      } catch (e) {
        setTurns((prev) => {
          const target = prev.find((t) => t.id === streamTurnId);
          if (target && (target.content.trim() || target.thinking?.trim())) {
            return prev.map((t) =>
              t.id === streamTurnId
                ? { ...t, content: `${t.content}\n\n> 请求中断：${e}`, streaming: false }
                : t,
            );
          }
          return prev.filter((t) => t.id !== streamTurnId);
        });
        if (activeSessionId) {
          api
            .getInstanceSessionTurns(instanceId, activeSessionId)
            .then((records) => {
              if (records.length > 0) {
                setTurns(records.map((r) => mapRecordToRichTurn(r, resolvedThinkingLabel)));
              }
            })
            .catch(() => {});
        }
        notify(`智能体实例响应失败：${e}`, true);
      } finally {
        activeRequestIdRef.current = null;
        streamingTurnIdRef.current = null;
        setBusy(false);
      }
    },
    [
      activeSessionId,
      busy,
      input,
      instanceId,
      isConfigInstance,
      notify,
      onDataChanged,
      onKernelEffects,
      resolvedThinkingLabel,
      savedToml,
      workspaceContext,
    ],
  );

  // 响应宿主触发的快捷提问（如写信页「AI 润色」或批复页「让 AI 改写」）
  useEffect(() => {
    if (!externalPromptRequest || externalPromptRequest.seq <= handledExternalSeqRef.current) {
      return;
    }
    handledExternalSeqRef.current = externalPromptRequest.seq;
    const text = externalPromptRequest.prompt.trim();
    if (!text) return;
    if (externalPromptRequest.autoSend && !busy) {
      void sendPrompt(text);
    } else {
      setInput(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [busy, externalPromptRequest, sendPrompt]);

  const activeMeta = useMemo(
    () => computeActiveAgentMeta(savedToml, agentConfig, secrets),
    [savedToml, agentConfig, secrets],
  );

  const configuredProviders = useMemo<ConfiguredProviderOption[]>(
    () =>
      computeConfiguredProviders(
        agentConfig,
        secrets,
        activeMeta.presetId,
        activeMeta.modelName,
        magpieProbe,
      ),
    [agentConfig, secrets, activeMeta.presetId, activeMeta.modelName, magpieProbe],
  );

  const configuredSecretCount = secrets.filter((s) => s.configured).length;
  const canSend = !busy && input.trim().length > 0;
  const lastUserTurnIdx = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user" && typeof turns[i].id === "number") {
        return i;
      }
    }
    return -1;
  }, [turns]);

  const effectiveTitle =
    headerTitleOverride ?? descriptor?.title ?? (isConfigInstance ? "配置助手" : "邮件 Agent");
  const effectiveBadge =
    headerBadgeOverride ??
    (isConfigInstance ? "实例: config · config.toml" : "实例: mail · 隐私护栏");
  const effectiveSubtitle =
    headerSubtitleOverride ??
    descriptor?.subtitle ??
    (isConfigInstance
      ? "统一内核 · 配置实例 · 不读取邮件正文"
      : "统一内核 · 邮件实例 · 独立会话与模型状态");
  const effectivePlaceholder =
    placeholderOverride ??
    descriptor?.placeholder ??
    "输入指令，Enter 发送，Shift+Enter 换行…";

  const resolvedStarterCards: KernelStarterCard[] = useMemo(() => {
    if (starterCards && starterCards.length > 0) return starterCards;
    return (descriptor?.starter_prompts ?? []).map((p) => ({
      title: p.slice(0, 14),
      desc: p,
      text: p,
    }));
  }, [descriptor?.starter_prompts, starterCards]);

  return (
    <div
      className={`agent-chat-pane ${variant === "outrigger" ? "outrigger-agent-pane" : ""}`}
      data-agent-instance={instanceId}
    >
      <header
        className="pane-header"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <div className="pane-header-left">
          <div className="agent-orb">
            <IconSparkles size={17} />
          </div>

          <div className="pane-title-group">
            <div className="pane-title-row">
              <span className="pane-title">{effectiveTitle}</span>
              <span
                className="scope-only-pill"
                title={`当前运行在统一内核的独立实例 [${instanceId}]，会话历史与激活模型均彼此隔离`}
              >
                {effectiveBadge}
              </span>
            </div>
            <div className="pane-subtitle" title={effectiveSubtitle}>
              {effectiveSubtitle}
            </div>
          </div>
        </div>

        <div className="pane-header-actions no-drag">
          <button
            type="button"
            className={`soft-btn hdr-btn ${showHistoryDrawer ? "active-soft" : ""}`}
            onClick={() => {
              setShowVaultDrawer(false);
              setShowHistoryDrawer((v) => !v);
            }}
            title={`查看本实例 (${instanceId}) 的独立历史会话`}
          >
            <IconHistory size={14} />
            <span>
              {variant === "outrigger"
                ? `${sessions.length || ""}`
                : `历史${sessions.length > 0 ? ` (${sessions.length})` : ""}`}
            </span>
          </button>

          {turns.length > 0 && (
            <button
              type="button"
              className="soft-btn hdr-btn"
              onClick={handleNewSession}
              disabled={busy}
              title={`在 [${instanceId}] 实例下新建独立对话`}
            >
              <IconPlus size={13} />
              {variant !== "outrigger" && <span>新建</span>}
            </button>
          )}

          <button
            type="button"
            className={`soft-btn hdr-btn ${showVaultDrawer ? "active-soft" : ""}`}
            onClick={() => openVaultDrawer(activeMeta.ready ? null : activeMeta.secretSlot)}
            title="打开本机 DPAPI 凭据保险箱（各实例安全共享加密凭据，无需重复录入）"
          >
            <IconLock size={14} />
            <span>
              {variant === "outrigger"
                ? `${configuredSecretCount}`
                : `保险箱 (${configuredSecretCount})`}
            </span>
          </button>

          {onCollapse && (
            <button
              type="button"
              className="soft-btn hdr-btn outrigger-collapse-btn"
              onClick={onCollapse}
              title="向右收缩邮件 Agent 外挂面板"
            >
              <IconChevron size={13} className="outrigger-collapse-chevron" />
              <span>收起</span>
            </button>
          )}
        </div>
      </header>

      {contextBanner}

      <div
        ref={feedRef}
        className="agent-feed"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 110;
        }}
      >
        {turns.length === 0 ? (
          <div className="agent-empty">
            <div className="agent-empty-badge">
              <IconSparkles size={20} />
            </div>
            <h2>{emptyHeading ?? effectiveTitle}</h2>
            {emptyDescription ? (
              typeof emptyDescription === "string" ? (
                <p>{emptyDescription}</p>
              ) : (
                emptyDescription
              )
            ) : (
              <p>{effectiveSubtitle}</p>
            )}

            {emptyScopeBanner}

            <div className="starter-grid">
              {resolvedStarterCards.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  className="starter-card"
                  onClick={() => {
                    if (item.text.endsWith(" ") || item.text.endsWith("：")) {
                      setInput(item.text);
                      inputRef.current?.focus();
                    } else {
                      void sendPrompt(item.text);
                    }
                  }}
                >
                  <div className="starter-title">{item.title}</div>
                  <div className="starter-desc">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="agent-turns">
            <div className="agent-chat-scope-bar">
              <span>
                {isConfigInstance ? (
                  <>
                    独立实例 <code>config</code> · 仅维护脱敏 <code>config.toml</code>，与邮件 Agent 会话彻底隔离
                  </>
                ) : (
                  <>
                    独立实例 <code>mail</code> · 本地 PII 盲脱敏与分级权限生效中，与配置 Agent 会话彻底隔离
                  </>
                )}
              </span>
            </div>

            {turns.map((t, idx) => {
              const isLast = idx === turns.length - 1;
              const canRewindUserTurn =
                !busy && t.role === "user" && typeof t.id === "number";
              const isLatestUserTurn = idx === lastUserTurnIdx;
              const userRewindInfo =
                canRewindUserTurn &&
                rewindConfirm?.turnId === t.id &&
                rewindConfirm.anchor === "user"
                  ? inspectRewindFromIndex(idx)
                  : null;

              const canRewindLatestFromAssistant =
                isLast &&
                !busy &&
                !t.streaming &&
                t.role === "assistant" &&
                lastUserTurnIdx >= 0;
              const latestUserTurn = lastUserTurnIdx >= 0 ? turns[lastUserTurnIdx] : null;
              const latestRewindInfo =
                canRewindLatestFromAssistant &&
                latestUserTurn &&
                typeof latestUserTurn.id === "number" &&
                rewindConfirm?.turnId === latestUserTurn.id &&
                rewindConfirm.anchor === "latest"
                  ? inspectRewindFromIndex(lastUserTurnIdx)
                  : null;

              return (
                <div key={t.id} className={`agent-turn ${t.role}`}>
                  {t.role === "assistant" && (
                    <div className="agent-turn-avatar" aria-hidden="true">
                      <IconSparkles size={14} />
                    </div>
                  )}

                  <div className="agent-turn-col">
                    <div className="agent-bubble">
                      {t.role === "assistant" ? (
                        <AssistantTurnBody
                          turn={t}
                          onLocateInForm={onLocateInForm ?? (() => {})}
                          onOpenDiffTab={onOpenDiffTab}
                          onRevertBeforeToml={onRevertBeforeToml}
                          onSecretSaved={async (nextSecrets, msg) => {
                            setSecrets(nextSecrets);
                            await refreshInstanceMeta();
                            notify(msg);
                            onDataChanged();
                          }}
                          onSecretError={(err) => notify(err, true)}
                        />
                      ) : (
                        <div className="agent-user-text">{t.content}</div>
                      )}
                    </div>

                    {canRewindUserTurn && (
                      <div
                        className={`agent-user-actions ${isLatestUserTurn || Boolean(userRewindInfo) ? "is-latest" : ""}`}
                      >
                        <button
                          type="button"
                          className={`agent-rewind-chip ${userRewindInfo ? "active" : ""}`}
                          onClick={() => requestRewindAt(idx, "user")}
                          disabled={rewinding}
                          title="回退至此条消息前，并将指令填回输入框重新编辑"
                        >
                          <IconUndo size={11} />
                          <span>{isLatestUserTurn ? "回退重编" : "回退至此"}</span>
                        </button>
                      </div>
                    )}

                    {userRewindInfo && (
                      <RewindConfirmCard
                        userRoundCount={userRewindInfo.userRoundCount}
                        hasConfigChanges={userRewindInfo.hasConfigChanges}
                        changedItemCount={userRewindInfo.changedItemCount}
                        rewinding={rewinding}
                        onConfirm={(restoreCfg) =>
                          executeRewind(
                            userRewindInfo.turnId,
                            userRewindInfo.promptText,
                            restoreCfg,
                          )
                        }
                        onCancel={() => setRewindConfirm(null)}
                      />
                    )}

                    {isLast &&
                      !t.streaming &&
                      ((t.suggestions && t.suggestions.length > 0) ||
                        canRewindLatestFromAssistant) && (
                        <div className="followup-pills">
                          {t.suggestions?.map((sug) => (
                            <button
                              key={sug}
                              type="button"
                              className="followup-btn"
                              onClick={() => void sendPrompt(sug)}
                              disabled={busy || rewinding}
                            >
                              {sug}
                            </button>
                          ))}

                          {canRewindLatestFromAssistant && (
                            <button
                              type="button"
                              className={`followup-rewind-btn ${latestRewindInfo ? "active" : ""}`}
                              onClick={() => requestRewindAt(lastUserTurnIdx, "latest")}
                              disabled={busy || rewinding}
                              title="撤回上一轮问答并将原指令填回输入框"
                            >
                              <IconUndo size={12} />
                              <span>回退本轮</span>
                            </button>
                          )}
                        </div>
                      )}

                    {latestRewindInfo && (
                      <RewindConfirmCard
                        userRoundCount={latestRewindInfo.userRoundCount}
                        hasConfigChanges={latestRewindInfo.hasConfigChanges}
                        changedItemCount={latestRewindInfo.changedItemCount}
                        rewinding={rewinding}
                        onConfirm={(restoreCfg) =>
                          executeRewind(
                            latestRewindInfo.turnId,
                            latestRewindInfo.promptText,
                            restoreCfg,
                          )
                        }
                        onCancel={() => setRewindConfirm(null)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="agent-composer-wrap">
        <div
          className={`agent-composer-card ${busy ? "is-busy" : ""}`}
          onMouseDown={(e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (
              target &&
              target.tagName !== "BUTTON" &&
              target.tagName !== "TEXTAREA" &&
              !target.closest("button") &&
              !target.closest(".composer-model-menu")
            ) {
              requestAnimationFrame(() => inputRef.current?.focus());
            }
          }}
        >
          <div className="agent-composer-input-row">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              placeholder={effectivePlaceholder}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendPrompt();
                }
              }}
            />
          </div>

          <div className="agent-composer-footer">
            <div className="agent-composer-tools">
              <div className="composer-model-wrap" ref={quickMenuRef}>
                <button
                  type="button"
                  className={`composer-model-pill ${activeMeta.ready ? "ready" : "unconfigured"}`}
                  onClick={() => setShowModelQuickMenu((v) => !v)}
                  disabled={switchingModel}
                  title={`点击切换 [${instanceId}] 实例的激活模型（与另一实例互不干扰）`}
                >
                  <span className={`status-dot ${activeMeta.ready ? "ok" : "warn"}`} />
                  <span className="composer-model-name">{activeMeta.presetLabel}</span>
                  <span className="composer-model-sep">·</span>
                  <span className="composer-model-id">{activeMeta.modelName}</span>
                  {!activeMeta.ready && <span className="composer-model-tag">未配密钥</span>}
                  <IconChevron
                    size={12}
                    className={`composer-model-caret ${showModelQuickMenu ? "open" : ""}`}
                  />
                </button>

                {showModelQuickMenu && (
                  <div className="composer-model-menu">
                    <div className="composer-menu-header">
                      <span>
                        {isConfigInstance ? "配置实例" : "邮件实例"}模型 ({configuredProviders.length})
                      </span>
                      <span className="composer-menu-sub">实例独立切换</span>
                    </div>

                    {configuredProviders.length === 0 ? (
                      <div className="composer-menu-empty">
                        <div className="composer-menu-empty-title">暂未检测到已就绪的模型凭据</div>
                        <div className="composer-menu-empty-desc">
                          请先在「凭据保险箱」录入任一服务商 API Key，或接入本机 Magpie / Ollama。
                        </div>
                      </div>
                    ) : (
                      <div className="composer-configured-list">
                        {configuredProviders.map((item) => (
                          <div
                            key={item.preset.id}
                            className={`composer-provider-group ${item.isActive ? "active" : ""}`}
                          >
                            <button
                              type="button"
                              className="composer-provider-row"
                              onClick={() => handleSwitchModel(item.preset.id, item.savedModel)}
                              disabled={switchingModel}
                            >
                              <div className="composer-menu-item-main">
                                <span className="status-dot ok" />
                                <span className="composer-menu-item-title">{item.preset.name}</span>
                                {item.maskedSecret && (
                                  <span className="composer-menu-mask">{item.maskedSecret}</span>
                                )}
                              </div>
                              {item.isActive ? (
                                <span className="composer-menu-active-tag">
                                  <IconCheck size={11} />
                                  当前
                                </span>
                              ) : (
                                <span className="composer-menu-state">{item.savedModel}</span>
                              )}
                            </button>

                            {item.candidateModels.length > 0 && (
                              <div className="composer-submodels">
                                {item.candidateModels.map((m) => {
                                  const subActive = item.isActive && activeMeta.modelName === m;
                                  return (
                                    <button
                                      key={m}
                                      type="button"
                                      className={`composer-submodel-chip ${subActive ? "active" : ""}`}
                                      onClick={() => handleSwitchModel(item.preset.id, m)}
                                      disabled={switchingModel}
                                      title={`将 [${instanceId}] 实例切换至 ${item.preset.name} · ${m}`}
                                    >
                                      {m}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="composer-menu-divider" />
                    {activeMeta.presetId !== "magpie" &&
                      magpieProbe &&
                      !magpieProbe.gateway_online &&
                      (magpieProbe.cli_installed || magpieProbe.config_found) && (
                        <button
                          type="button"
                          className="composer-menu-action"
                          disabled={switchingModel}
                          onClick={() => handleSwitchModel("magpie")}
                        >
                          <IconSparkles size={13} />
                          <span>唤醒并免配沿用本机 Magpie 模型路由</span>
                        </button>
                      )}
                    <button
                      type="button"
                      className="composer-menu-action"
                      onClick={() =>
                        openVaultDrawer(activeMeta.ready ? null : activeMeta.secretSlot)
                      }
                    >
                      <IconKey size={13} />
                      <span>打开凭据保险箱录入 / 管理 API Key</span>
                    </button>
                    <button
                      type="button"
                      className="composer-menu-action secondary"
                      onClick={() => {
                        setShowModelQuickMenu(false);
                        onOpenSettings("visual");
                      }}
                    >
                      <IconSliders size={13} />
                      <span>前往模型接入页配置更多服务商</span>
                    </button>
                  </div>
                )}
              </div>

              {!activeMeta.ready && (
                <button
                  type="button"
                  className="composer-quick-chip accent"
                  onClick={() => openVaultDrawer(activeMeta.secretSlot)}
                >
                  <IconKey size={12} />
                  <span>录入密钥</span>
                </button>
              )}
            </div>

            <div className="agent-composer-right">
              <span className="composer-shortcut-hint">
                {busy ? "流式生成中" : variant === "outrigger" ? "Enter 发送" : "Enter 发送 · Shift+Enter 换行"}
              </span>
              {busy ? (
                <button
                  type="button"
                  className="composer-send-btn stop"
                  onClick={handleStopStreaming}
                  title="停止生成"
                >
                  <IconStop size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className={`composer-send-btn ${canSend ? "ready" : ""}`}
                  onClick={() => void sendPrompt()}
                  disabled={!canSend}
                  title="发送指令 (Enter)"
                >
                  <IconSend size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>

      {showHistoryDrawer && (
        <HistoryDrawerModal
          sessions={sessions}
          activeSessionId={activeSessionId}
          busy={busy}
          title={isConfigInstance ? "配置实例对话记录" : "邮件实例对话记录"}
          emptyHint={
            isConfigInstance
              ? "配置实例（config）的对话仅保存在自身命名空间中"
              : "邮件实例（mail）的对话与配置实例完全隔离保存"
          }
          onClose={() => setShowHistoryDrawer(false)}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
        />
      )}

      {showVaultDrawer && (
        <VaultDrawerModal
          secrets={secrets}
          activeAccountEmail={activeAccountEmail}
          activePresetId={activeMeta.presetId}
          initialFocusKey={vaultFocusKey}
          onClose={() => setShowVaultDrawer(false)}
          onUpdated={async (nextSecrets, msg) => {
            setSecrets(nextSecrets);
            await refreshInstanceMeta();
            if (msg) notify(msg);
            onDataChanged();
          }}
          onActivatePreset={(presetId) => handleSwitchModel(presetId)}
          onOpenFullVault={() => {
            setShowVaultDrawer(false);
            onOpenSettings("vault");
          }}
          onError={(err) => notify(err, true)}
        />
      )}
    </div>
  );
}

function RewindConfirmCard({
  userRoundCount,
  hasConfigChanges,
  changedItemCount,
  rewinding,
  onConfirm,
  onCancel,
}: {
  userRoundCount: number;
  hasConfigChanges: boolean;
  changedItemCount: number;
  rewinding: boolean;
  onConfirm: (restoreConfig: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="rewind-confirm-bar" role="region" aria-label="回退对话确认">
      <div className="rewind-confirm-desc">
        <IconUndo size={13} className="rewind-confirm-icon" />
        <span>
          {hasConfigChanges
            ? userRoundCount > 1
              ? `回退此条及后续共 ${userRoundCount} 轮对话 · 检测到期间修改了配置${changedItemCount > 0 ? ` (${changedItemCount} 项)` : ""}`
              : `回退本轮对话 · 检测到本轮修改了配置${changedItemCount > 0 ? ` (${changedItemCount} 项)` : ""}`
            : `确认回退此条及后续共 ${userRoundCount} 轮对话？（原指令将填回输入框）`}
        </span>
      </div>
      <div className="rewind-confirm-actions">
        {hasConfigChanges ? (
          <>
            <button
              type="button"
              className="rewind-confirm-btn primary"
              disabled={rewinding}
              onClick={() => onConfirm(true)}
              title="撤回对话记录，并将 config.toml 与各项设置还原到该条消息发送前的状态"
            >
              {rewinding ? "回退中…" : "回退并还原配置"}
            </button>
            <button
              type="button"
              className="rewind-confirm-btn secondary"
              disabled={rewinding}
              onClick={() => onConfirm(false)}
              title="仅撤回对话记录并将指令填回输入框，保留当前已生效的配置"
            >
              仅回退对话
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rewind-confirm-btn primary"
            disabled={rewinding}
            onClick={() => onConfirm(false)}
          >
            {rewinding ? "回退中…" : "确认回退"}
          </button>
        )}
        <button
          type="button"
          className="rewind-confirm-btn ghost"
          disabled={rewinding}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}

export function HistoryDrawerModal({
  sessions,
  activeSessionId,
  busy,
  title = "对话记录",
  emptyHint = "发送指令后将自动保存在本机 SQLite 数据库中",
  onClose,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  busy: boolean;
  title?: string;
  emptyHint?: string;
  onClose: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="history-drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="history-drawer-panel" aria-label={title}>
        <div className="history-drawer-head">
          <span className="agent-history-title">{title}</span>
          <div className="history-drawer-head-actions">
            <button
              type="button"
              className="primary-btn compact-btn"
              onClick={onNewSession}
              disabled={busy}
            >
              <IconPlus size={13} />
              <span>新建对话</span>
            </button>
            <button
              type="button"
              className="ghost-btn icon-only-btn"
              onClick={onClose}
              title="关闭 (Esc)"
            >
              <IconClose size={15} />
            </button>
          </div>
        </div>

        <div className="agent-history-list">
          {sessions.length === 0 ? (
            <div className="agent-history-empty">
              暂无历史对话记录
              <br />
              {emptyHint}
            </div>
          ) : (
            sessions.map((s) => {
              const active = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  className={`agent-session-item ${active ? "active" : ""}`}
                  onClick={() => onSelectSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectSession(s.id);
                    }
                  }}
                >
                  <div className="agent-session-top">
                    <span className="agent-session-name">{s.title || "新对话"}</span>
                    <span className="agent-session-time">{formatSessionTime(s.updated_at)}</span>
                  </div>
                  <div className="agent-session-bottom">
                    <span className="agent-session-preview">
                      {s.preview ? s.preview : "空白会话"}
                    </span>
                    <button
                      type="button"
                      className="agent-session-del"
                      onClick={(e) => onDeleteSession(s.id, e)}
                      title="删除此条历史会话"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

export function AssistantTurnBody({
  turn,
  onLocateInForm,
  onOpenDiffTab,
  onRevertBeforeToml,
  onSecretSaved,
  onSecretError,
}: {
  turn: RichTurn;
  onLocateInForm: (targetKey: string, diff?: ConfigDiffReport | null) => void;
  onOpenDiffTab?: (diff: ConfigDiffReport) => void;
  onRevertBeforeToml?: (beforeToml: string) => Promise<void>;
  onSecretSaved: (secrets: SecretStatus[], message: string) => void;
  onSecretError: (message: string) => void;
}) {
  const hasThinking = Boolean(turn.thinking && turn.thinking.trim().length > 0);
  const isActivelyThinking = Boolean(turn.streaming && !turn.content);

  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(turn.thinkingMs || 0);

  useEffect(() => {
    if (!isActivelyThinking) {
      if (turn.thinkingMs && turn.thinkingMs > 0) {
        setElapsedMs(turn.thinkingMs);
      }
      return;
    }
    const started = Date.now() - (turn.thinkingMs || 0);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 120);
    return () => window.clearInterval(timer);
  }, [isActivelyThinking, turn.thinkingMs]);

  const effectiveMs = turn.thinkingMs && turn.thinkingMs > 0 ? turn.thinkingMs : elapsedMs;
  const secsLabel = effectiveMs >= 100 ? `${(effectiveMs / 1000).toFixed(1)}s` : "";
  const isThinkingOpen = manualOpen !== null ? manualOpen : isActivelyThinking;
  const ctxLabel = turn.thinkingContextLabel || "任务";

  return (
    <div className="assistant-turn-body">
      {(hasThinking || isActivelyThinking) && (
        <div
          className={`thinking-foldout ${isThinkingOpen ? "open" : ""} ${isActivelyThinking ? "live" : ""}`}
        >
          <button
            type="button"
            className="thinking-foldout-head"
            onClick={() => {
              if (hasThinking) {
                setManualOpen((prev) => !(prev !== null ? prev : isActivelyThinking));
              }
            }}
          >
            <span className="thinking-foldout-left">
              {isActivelyThinking ? (
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <IconThink size={13} />
              )}
              <span className="thinking-foldout-title">
                {isActivelyThinking
                  ? hasThinking
                    ? `正在思考${ctxLabel}${secsLabel ? ` · ${secsLabel}` : "…"}`
                    : `正在连接模型处理${ctxLabel}${secsLabel ? ` · ${secsLabel}` : "…"}`
                  : `思考过程${secsLabel ? ` (${secsLabel})` : ""}`}
              </span>
            </span>
            {hasThinking && (
              <IconChevron
                size={12}
                className={`thinking-foldout-caret ${isThinkingOpen ? "open" : ""}`}
              />
            )}
          </button>

          {isThinkingOpen && hasThinking && (
            <div className="thinking-foldout-content">{turn.thinking}</div>
          )}
        </div>
      )}

      {turn.toolSteps && turn.toolSteps.length > 0 && (
        <div className="agent-tool-steps">
          {turn.toolSteps.map((step, i) => (
            <div key={i} className="agent-tool-step">
              <IconCode size={12} />
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}

      {turn.content ? (
        <MarkdownText content={turn.content} />
      ) : turn.streaming && !isActivelyThinking ? (
        <div className="thinking-inline-hint">{`正在生成${ctxLabel}答复…`}</div>
      ) : null}

      {turn.badge && (
        <div className="applied-changes">
          <span className="change-pill">
            <IconCheck size={12} />
            <span>{turn.badge}</span>
          </span>
        </div>
      )}

      <ConfigChangeSummaryCard
        configDiff={turn.configDiff}
        legacyChanges={turn.changes}
        streaming={turn.streaming}
        onLocateInForm={onLocateInForm}
        onOpenDiffTab={onOpenDiffTab}
        onRevertBeforeToml={onRevertBeforeToml}
      />

      {turn.secretPrompts && turn.secretPrompts.length > 0 && (
        <div className="secret-cards-stack">
          {turn.secretPrompts.map((sp) => (
            <InlineSecretVaultCard
              key={sp.key}
              prompt={sp}
              onSaved={onSecretSaved}
              onError={onSecretError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InlineSecretVaultCard({
  prompt,
  onSaved,
  onError,
}: {
  prompt: SecretPrompt;
  onSaved: (secrets: SecretStatus[], message: string) => void;
  onError: (message: string) => void;
}) {
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (verify: boolean) => {
    if (!val.trim() || saving) return;
    setSaving(true);
    try {
      const res = await api.setSecret(prompt.key, val, verify);
      setVal("");
      setDone(true);
      onSaved(res.secrets, res.message);
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="secret-inline-done">
        <IconLock size={14} />
        <span>{prompt.label} 已加密存入本机隐私保险箱</span>
      </div>
    );
  }

  return (
    <div className="secret-inline-card">
      <div className="secret-card-top">
        <div className="secret-card-title">
          <IconKey size={14} />
          <span>{prompt.label}</span>
        </div>
        <span className="vault-badge">
          <IconLock size={11} />
          本地 DPAPI 加密直存 · 不经大模型
        </span>
      </div>
      <div className="secret-card-hint">{prompt.hint}</div>
      <div className="secret-card-row">
        <input
          type="password"
          value={val}
          placeholder={
            prompt.configured ? "已配置加密凭据，输入新值可覆盖更新" : `输入 ${prompt.label}`
          }
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(true);
            }
          }}
        />
        <button
          type="button"
          className="soft-btn"
          onClick={() => void submit(false)}
          disabled={saving || !val.trim()}
        >
          仅保存
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => void submit(true)}
          disabled={saving || !val.trim()}
        >
          {saving ? "验证中…" : "加密保存并验证"}
        </button>
      </div>
    </div>
  );
}

export function VaultDrawerModal({
  secrets,
  activeAccountEmail,
  activePresetId,
  initialFocusKey,
  onClose,
  onUpdated,
  onActivatePreset,
  onOpenFullVault,
  onError,
}: {
  secrets: SecretStatus[];
  activeAccountEmail?: string;
  activePresetId: string;
  initialFocusKey: string | null;
  onClose: () => void;
  onUpdated: (secrets: SecretStatus[], message?: string) => void;
  onActivatePreset: (presetId: string) => void;
  onOpenFullVault: () => void;
  onError: (message: string) => void;
}) {
  const activeMailSecretKey = activeAccountEmail?.trim()
    ? mailSecretKey(activeAccountEmail)
    : null;
  const defaultExpanded = useMemo(() => {
    if (initialFocusKey) return initialFocusKey;
    const activeKey =
      activePresetId === "ollama" || activePresetId === "magpie" ? null : `llm_${activePresetId}`;
    const activeStatus = activeKey ? secrets.find((s) => s.key === activeKey) : null;
    if (activeKey && !activeStatus?.configured) return activeKey;
    return null;
  }, [initialFocusKey, activePresetId, secrets]);

  const [editingKey, setEditingKey] = useState<string | null>(defaultExpanded);
  const [draftVal, setDraftVal] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mailSecrets = useMemo(() => secrets.filter((s) => s.category === "mail"), [secrets]);
  const llmSecrets = useMemo(() => {
    const activeKey = activePresetId === "ollama" ? "" : `llm_${activePresetId}`;
    return [...secrets.filter((s) => s.category === "llm")].sort((a, b) => {
      const aActive = a.key === activeKey ? 1 : 0;
      const bActive = b.key === activeKey ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return Number(b.configured) - Number(a.configured);
    });
  }, [secrets, activePresetId]);

  const saveKey = async (key: string, verify: boolean) => {
    if (!draftVal.trim() || busyKey) return;
    setBusyKey(key);
    try {
      const res = await api.setSecret(key, draftVal, verify);
      setDraftVal("");
      setEditingKey(null);
      onUpdated(res.secrets, res.message);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const removeKey = async (item: SecretStatus) => {
    if (busyKey) return;
    setBusyKey(item.key);
    try {
      const next = await api.deleteSecret(item.key);
      onUpdated(next, `已从本机保险箱移除 ${item.label}`);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const renderSecretRow = (item: SecretStatus) => {
    const isEditing = editingKey === item.key;
    const isBusy = busyKey === item.key;
    const presetId = item.key.startsWith("llm_") ? item.key.slice(4) : null;
    const isCurrentPreset = presetId === activePresetId;
    const isCurrentMail = Boolean(activeMailSecretKey && item.key === activeMailSecretKey);

    return (
      <div key={item.key} className={`vault-drawer-item ${item.configured ? "configured" : ""}`}>
        <div className="vault-drawer-item-top">
          <div className="vault-drawer-item-info">
            <div className="vault-drawer-item-title-row">
              <span className="vault-drawer-item-label">{item.label}</span>
              {isCurrentPreset && <span className="composer-menu-active-tag">当前实例模型</span>}
              {isCurrentMail && <span className="composer-menu-active-tag">当前使用邮箱</span>}
            </div>
            <div className="vault-drawer-item-meta">
              <code>secret:{item.key}</code>
              <span>·</span>
              <span className={item.configured ? "vault-mask-ok" : "vault-mask-empty"}>
                {item.configured ? `已加密保存 (${item.masked})` : "未录入"}
              </span>
            </div>
          </div>

          <div className="vault-drawer-item-btns">
            {presetId && item.configured && !isCurrentPreset && (
              <button
                type="button"
                className="soft-btn compact-btn"
                onClick={() => onActivatePreset(presetId)}
                disabled={Boolean(busyKey)}
                title="立即切换为当前实例使用的模型服务"
              >
                设为当前
              </button>
            )}
            <button
              type="button"
              className={isEditing ? "ghost-btn compact-btn" : "soft-btn compact-btn"}
              onClick={() => {
                setEditingKey(isEditing ? null : item.key);
                setDraftVal("");
              }}
              disabled={isBusy}
            >
              {isEditing ? "收起" : item.configured ? "更新" : "录入"}
            </button>
            {item.configured && (
              <button
                type="button"
                className="ghost-btn compact-btn danger-text"
                onClick={() => void removeKey(item)}
                disabled={isBusy}
                title="删除本机加密凭据"
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
        </div>

        {isEditing && (
          <div className="vault-drawer-edit">
            <input
              type="password"
              autoFocus
              value={draftVal}
              placeholder={
                item.configured
                  ? "输入新密钥以覆盖原加密记录…"
                  : `输入 ${item.label}（明文仅存本机 DPAPI）`
              }
              onChange={(e) => setDraftVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftVal.trim()) {
                  e.preventDefault();
                  void saveKey(item.key, true);
                }
              }}
            />
            <div className="vault-drawer-edit-actions">
              <button
                type="button"
                className="soft-btn compact-btn"
                onClick={() => void saveKey(item.key, false)}
                disabled={isBusy || !draftVal.trim()}
              >
                仅加密保存
              </button>
              <button
                type="button"
                className="primary-btn compact-btn"
                onClick={() => void saveKey(item.key, true)}
                disabled={isBusy || !draftVal.trim()}
              >
                {isBusy ? "连通校验中…" : "保存并验证连通"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="vault-drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="vault-drawer-panel" aria-label="凭据保险箱">
        <div className="vault-drawer-header">
          <div className="vault-drawer-header-left">
            <div className="vault-hero-icon">
              <IconLock size={17} />
            </div>
            <div>
              <div className="vault-drawer-title">本机隐私凭据保险箱</div>
              <div className="vault-drawer-subtitle">
                Windows DPAPI 系统级加密 · 配置实例与邮件实例安全共享凭据
              </div>
            </div>
          </div>
          <button
            type="button"
            className="ghost-btn icon-only-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="vault-drawer-body">
          <div className="vault-drawer-section">
            <div className="vault-drawer-section-title">邮箱 IMAP / SMTP 授权码</div>
            {mailSecrets.map(renderSecretRow)}
          </div>

          <div className="vault-drawer-section">
            <div className="vault-drawer-section-title">
              <span>大模型服务商 API Key（录入一次，所有 Agent 实例均可按需切换使用）</span>
            </div>
            {llmSecrets.map(renderSecretRow)}
          </div>
        </div>

        <div className="vault-drawer-footer">
          <span className="vault-drawer-foot-note">
            配置文件仅保留 <code>secret:*</code> 占位符，可安全备份或纳入 Git
          </span>
          <button type="button" className="text-link" onClick={onOpenFullVault}>
            打开完整保险箱页
          </button>
        </div>
      </aside>
    </div>
  );
}
