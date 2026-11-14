import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, MODEL_PRESETS, type ModelPreset } from "../api";
import {
  mailSecretKey,
  type AgentConfig,
  type AgentSessionSummary,
  type AgentStreamPayload,
  type AgentTurnRecord,
  type ChatTurn,
  type ConfigDiffReport,
  type DeclarativeBundle,
  type DeclarativeConfigSpec,
  type MagpieProbeReport,
  type SecretPrompt,
  type SecretStatus,
} from "../types";
import {
  AgentConfigInspector,
  ConfigChangeSummaryCard,
  type InspectorTab,
} from "./AgentConfigInspector";
import {
  IconChat,
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

interface RichTurn {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  thinkingMs?: number;
  toolSteps?: string[];
  changes?: string[];
  configDiff?: ConfigDiffReport | null;
  snapshotToml?: string;
  secretPrompts?: SecretPrompt[];
  suggestions?: string[];
  streaming?: boolean;
  createdAt?: number;
}

interface ConfiguredProviderOption {
  preset: ModelPreset;
  isActive: boolean;
  savedModel: string;
  candidateModels: string[];
  secretKey: string | null;
  maskedSecret: string;
}

const STARTER_PROMPTS = [
  {
    title: "接入或切换多邮箱",
    desc: "自动匹配 QQ / 163 / Gmail / Outlook 等多账号配置并支持自由切换",
    text: "帮我绑定邮箱 ",
  },
  {
    title: "体检当前配置",
    desc: "检查账号连接、模型密钥就绪状态与过滤规则覆盖情况",
    text: "检查我当前的 config.toml 配置状态和缺失项",
  },
  {
    title: "拦截促销与广告",
    desc: "写入 [triage] 屏蔽关键词并立即重扫现有收件箱",
    text: "屏蔽所有包含「退订」「限时优惠」的促销邮件",
  },
  {
    title: "账单验证码自动折叠",
    desc: "将验证码、账单与订阅周刊静默归入「通知」栏",
    text: "把包含「账单」「验证码」「订阅周刊」的邮件自动折叠进通知",
  },
  {
    title: "声明式创建邮件群聊",
    desc: "在 [[groups]] 中编排跨邮箱服务商的多人全员群聊",
    text: "创建一个名为「项目组」的邮件群聊，成员包含 ",
  },
  {
    title: "定制 AI 分拣策略",
    desc: "调整 [agent] 分拣指令与自动起草回复开关",
    text: "开启 AI 自动分拣与自动起草回复，并将客户来信优先保留在消息列表",
  },
];

function parseActiveAgentMeta(tomlText: string, agentCfg: AgentConfig | null) {
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

function mapRecordToRichTurn(r: AgentTurnRecord): RichTurn {
  return {
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    content: r.content,
    thinking: r.thinking || "",
    thinkingMs: r.thinking_ms || 0,
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

function extractLatestDiff(list: RichTurn[]): ConfigDiffReport | null {
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

export function AgentWorkspace({
  activeAccountEmail,
  onSwitchAccount,
  notify,
  onDataChanged,
  onOpenSettings,
  onGoToInbox,
}: {
  activeAccountEmail?: string;
  onSwitchAccount?: (email: string) => Promise<void> | void;
  notify: (text: string, isError?: boolean) => void;
  onDataChanged: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onGoToInbox: () => void;
}) {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);

  const [turns, setTurns] = useState<RichTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [spec, setSpec] = useState<DeclarativeConfigSpec | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [savedToml, setSavedToml] = useState("");
  const [draftToml, setDraftToml] = useState("");
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("visual");
  const [activeDiff, setActiveDiff] = useState<ConfigDiffReport | null>(null);
  const [focusSignal, setFocusSignal] = useState<{ seq: number; targetKey: string } | null>(null);
  const [applyingToml, setApplyingToml] = useState(false);

  const [showModelQuickMenu, setShowModelQuickMenu] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [magpieProbe, setMagpieProbe] = useState<MagpieProbeReport | null>(null);

  const [showVaultDrawer, setShowVaultDrawer] = useState(false);
  const [vaultFocusKey, setVaultFocusKey] = useState<string | null>(null);

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
  const tomlDirtyRef = useRef(false);

  const tomlDirty = draftToml !== savedToml;
  tomlDirtyRef.current = tomlDirty;

  const applyBundleState = useCallback(
    (bundle: DeclarativeBundle, msg?: string) => {
      setConfigPath(bundle.path);
      setSpec(bundle.spec);
      setSavedToml(bundle.toml);
      setDraftToml(bundle.toml);
      setSecrets(bundle.secrets);
      api
        .getAgentConfig()
        .then(setAgentConfig)
        .catch(() => {});
      if (msg) notify(msg);
    },
    [notify],
  );

  const refreshConfigState = useCallback(async () => {
    try {
      const [bundle, ag] = await Promise.all([api.getDeclarativeConfig(), api.getAgentConfig()]);
      setConfigPath(bundle.path);
      setSpec(bundle.spec);
      setSavedToml(bundle.toml);
      if (!tomlDirtyRef.current) {
        setDraftToml(bundle.toml);
      }
      setSecrets(bundle.secrets);
      setAgentConfig(ag);
    } catch (e) {
      notify(String(e), true);
    }
  }, [notify]);

  // 初始化加载：同步恢复声明式配置、模型档案与最近一次持久化对话历史
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bundle, ag, sessList] = await Promise.all([
          api.getDeclarativeConfig(),
          api.getAgentConfig(),
          api.listAgentSessions(),
        ]);
        if (cancelled) return;
        setConfigPath(bundle.path);
        setSpec(bundle.spec);
        setSavedToml(bundle.toml);
        setDraftToml(bundle.toml);
        setSecrets(bundle.secrets);
        setAgentConfig(ag);
        setSessions(sessList);

        api
          .probeMagpie(ag.preset === "magpie" ? ag.base_url : undefined)
          .then((rep) => {
            if (!cancelled) setMagpieProbe(rep);
          })
          .catch(() => {});

        if (sessList.length > 0) {
          const latestId = sessList[0].id;
          setActiveSessionId(latestId);
          const records = await api.getAgentSessionTurns(latestId);
          if (!cancelled) {
            const mapped = records.map(mapRecordToRichTurn);
            setTurns(mapped);
            setActiveDiff(extractLatestDiff(mapped));
          }
        }
      } catch (e) {
        if (!cancelled) notify(String(e), true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // 顶栏切换当前活跃邮箱时，实时同步右侧可视化表单、config.toml 与保险箱状态
  const prevAccEmailRef = useRef<string | undefined>(activeAccountEmail);
  useEffect(() => {
    if (prevAccEmailRef.current !== activeAccountEmail) {
      prevAccEmailRef.current = activeAccountEmail;
      refreshConfigState();
    }
  }, [activeAccountEmail, refreshConfigState]);

  // 订阅 Rust 原生流式引擎实时推理增量（思考片段 / 正文片段 / 工具步骤 / 实时 TOML / 结构化 Spec 预览与 Diff）
  useEffect(() => {
    const unlistenPromise = listen<AgentStreamPayload>("agent-chat-stream", (ev) => {
      const p = ev.payload;
      if (!p || !activeRequestIdRef.current || p.request_id !== activeRequestIdRef.current) {
        return;
      }

      if (p.kind === "toml" && p.delta) {
        setSavedToml(p.delta);
        if (!tomlDirtyRef.current) {
          setDraftToml(p.delta);
        }
        return;
      }

      if (p.kind === "spec_preview" && p.delta) {
        try {
          const parsed = JSON.parse(p.delta) as {
            spec?: DeclarativeConfigSpec;
            config_diff?: ConfigDiffReport | null;
          };
          if (parsed.spec) {
            setSpec(parsed.spec);
          }
          if (
            parsed.config_diff &&
            (parsed.config_diff.items.length > 0 ||
              parsed.config_diff.before_toml.trim() !== parsed.config_diff.after_toml.trim())
          ) {
            setActiveDiff(parsed.config_diff);
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
          // ignore malformed preview payload
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
  }, []);

  // 空白态始终保持在顶部；有对话内容且处于贴底状态时平滑跟随流式输出
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

  // 根据输入内容真实高度自适应伸缩
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

  // 点击外部关闭模型切换菜单，并在展开菜单时自动刷新本机 Magpie 路由状态
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

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId === activeSessionId) {
      setShowHistoryDrawer(false);
      return;
    }
    if (busy) {
      notify("当前正在流式生成配置响应，请等待完成或点击停止后再切换会话");
      return;
    }
    try {
      stickToBottomRef.current = true;
      setActiveSessionId(sessionId);
      const records = await api.getAgentSessionTurns(sessionId);
      const mapped = records.map(mapRecordToRichTurn);
      setTurns(mapped);
      setActiveDiff(extractLatestDiff(mapped));
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
      const created = await api.createAgentSession();
      setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
      setActiveSessionId(created.id);
      setTurns([]);
      setActiveDiff(null);
      setRewindConfirm(null);
      setShowHistoryDrawer(false);
      stickToBottomRef.current = true;
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      notify(`新建配置对话失败：${e}`, true);
    }
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy && sessionId === activeSessionId) {
      await api.cancelAgentChat(activeRequestIdRef.current).catch(() => {});
    }
    try {
      const nextSessions = await api.deleteAgentSession(sessionId);
      setSessions(nextSessions);
      if (sessionId === activeSessionId) {
        setRewindConfirm(null);
        if (nextSessions.length > 0) {
          const nextId = nextSessions[0].id;
          setActiveSessionId(nextId);
          const records = await api.getAgentSessionTurns(nextId);
          const mapped = records.map(mapRecordToRichTurn);
          setTurns(mapped);
          setActiveDiff(extractLatestDiff(mapped));
        } else {
          setActiveSessionId(null);
          setTurns([]);
          setActiveDiff(null);
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
        Boolean(rollbackToml) && (hasDiffInSlice || snapshotDiffers);

      return {
        turnId: target.id,
        promptText: target.content,
        userRoundCount,
        hasConfigChanges,
        changedItemCount,
      };
    },
    [turns, savedToml],
  );

  const executeRewind = useCallback(
    async (turnId: number, promptText: string, restoreConfig: boolean) => {
      if (!activeSessionId || busy || rewinding) return;
      setRewinding(true);
      try {
        const res = await api.rewindAgentSession(activeSessionId, turnId, restoreConfig);
        const mapped = res.turns.map(mapRecordToRichTurn);
        const nextDiff = extractLatestDiff(mapped);
        setTurns(mapped);
        setSessions(res.sessions);
        setActiveDiff(nextDiff);
        if (!nextDiff && inspectorTab === "diff") {
          setInspectorTab("visual");
        }
        if (res.config_restored) {
          applyBundleState(res.bundle);
          onDataChanged();
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
    [activeSessionId, applyBundleState, busy, inspectorTab, notify, onDataChanged, rewinding],
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
      await api.cancelAgentChat(rid);
    } catch {
      // ignore
    }
  };

  const handleSwitchModel = async (presetId: string, modelName?: string) => {
    if (switchingModel) return;
    setSwitchingModel(true);
    try {
      if (presetId === "magpie") {
        const res = await api.connectMagpie({
          baseUrl: agentConfig?.preset === "magpie" ? agentConfig.base_url : undefined,
          model: modelName,
          autoStart: true,
        });
        setMagpieProbe(res.probe);
        setAgentConfig(res.agent_config);
        setConfigPath(res.bundle.path);
        if (res.bundle.spec) setSpec(res.bundle.spec);
        setSavedToml(res.bundle.toml);
        if (!tomlDirtyRef.current) {
          setDraftToml(res.bundle.toml);
        }
        setSecrets(res.bundle.secrets);
        setShowModelQuickMenu(false);
        onDataChanged();
        notify(
          res.probe.gateway_online
            ? `已切换至 Magpie 模型路由 · ${res.agent_config.model}`
            : `已切换至 Magpie 模型路由（${res.probe.message}）`,
        );
        return;
      }

      const res = await api.switchActiveModel(presetId, modelName);
      setAgentConfig(res.agent_config);
      setConfigPath(res.bundle.path);
      if (res.bundle.spec) setSpec(res.bundle.spec);
      setSavedToml(res.bundle.toml);
      if (!tomlDirtyRef.current) {
        setDraftToml(res.bundle.toml);
      }
      setSecrets(res.bundle.secrets);
      setShowModelQuickMenu(false);
      onDataChanged();

      const presetLabel = MODEL_PRESETS.find((p) => p.id === presetId)?.name ?? presetId;
      notify(`已切换当前模型为 ${presetLabel} · ${res.agent_config.model}`);
    } catch (e) {
      notify(`切换模型失败：${e}`, true);
    } finally {
      setSwitchingModel(false);
    }
  };

  const sendPrompt = async (rawText?: string) => {
    const msg = (rawText ?? input).trim();
    if (!msg || busy) return;
    if (rawText === undefined) setInput("");
    setShowModelQuickMenu(false);
    setShowHistoryDrawer(false);
    setRewindConfirm(null);
    stickToBottomRef.current = true;

    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamTurnId = `stream-${reqId}`;
    activeRequestIdRef.current = reqId;
    streamingTurnIdRef.current = streamTurnId;

    const historyPayload: ChatTurn[] = turns
      .filter((t) => !t.streaming && t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content }));

    const userTurn: RichTurn = {
      id: `user-${reqId}`,
      role: "user",
      content: msg,
      snapshotToml: savedToml,
    };
    const optimisticAssistantTurn: RichTurn = {
      id: streamTurnId,
      role: "assistant",
      content: "",
      thinking: "",
      thinkingMs: 0,
      toolSteps: [],
      streaming: true,
    };

    setTurns((prev) => [...prev, userTurn, optimisticAssistantTurn]);
    setBusy(true);

    try {
      const res = await api.chatWithAgent(msg, historyPayload, activeSessionId, reqId);
      setActiveSessionId(res.session_id);
      setSessions(res.sessions);
      setSpec(res.spec);
      setSavedToml(res.toml);
      if (!tomlDirtyRef.current) {
        setDraftToml(res.toml);
      }
      setSecrets(res.secrets);
      if (
        res.config_diff &&
        (res.config_diff.items.length > 0 ||
          res.config_diff.before_toml.trim() !== res.config_diff.after_toml.trim())
      ) {
        setActiveDiff(res.config_diff);
      }
      api
        .getAgentConfig()
        .then(setAgentConfig)
        .catch(() => {});

      if (res.turns && res.turns.length > 0) {
        setTurns(res.turns.map(mapRecordToRichTurn));
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
          .getAgentSessionTurns(activeSessionId)
          .then((records) => {
            if (records.length > 0) {
              setTurns(records.map(mapRecordToRichTurn));
            }
          })
          .catch(() => {});
      }
      notify(`配置助手响应失败：${e}`, true);
    } finally {
      activeRequestIdRef.current = null;
      streamingTurnIdRef.current = null;
      setBusy(false);
    }
  };

  const applyManualToml = async () => {
    setApplyingToml(true);
    try {
      const b = await api.applyDeclarativeConfig(draftToml);
      applyBundleState(b, "声明式 config.toml 已校验并生效");
      onDataChanged();
    } catch (e) {
      notify(`TOML 校验失败：${e}`, true);
    } finally {
      setApplyingToml(false);
    }
  };

  const handleLocateInForm = useCallback(
    (targetKey: string, diff?: ConfigDiffReport | null) => {
      if (diff) {
        setActiveDiff(diff);
      }
      setInspectorTab("visual");
      setFocusSignal((prev) => ({ seq: (prev?.seq ?? 0) + 1, targetKey }));
    },
    [],
  );

  const handleOpenDiffTab = useCallback((diff: ConfigDiffReport) => {
    setActiveDiff(diff);
    setInspectorTab("diff");
  }, []);

  const handleRevertBeforeToml = useCallback(
    async (beforeToml: string) => {
      try {
        const b = await api.applyDeclarativeConfig(beforeToml);
        applyBundleState(b, "已还原至该轮修改前的配置");
        setActiveDiff(null);
        onDataChanged();
      } catch (e) {
        notify(`还原配置失败：${e}`, true);
        throw e;
      }
    },
    [applyBundleState, notify, onDataChanged],
  );

  // 当前激活模型元信息
  const activeMeta = useMemo(() => {
    const { presetId, modelName, baseUrl } = parseActiveAgentMeta(savedToml, agentConfig);
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
  }, [savedToml, agentConfig, secrets]);

  // 动态提取「已配置好的模型服务商及候选模型」（含自动发现的本机在线 Magpie 路由）
  const configuredProviders = useMemo<ConfiguredProviderOption[]>(() => {
    const list: ConfiguredProviderOption[] = [];
    for (const preset of MODEL_PRESETS) {
      const secretKey = preset.id === "ollama" ? null : `llm_${preset.id}`;
      const sec = secretKey ? secrets.find((s) => s.key === secretKey) : undefined;
      const hasSecret = Boolean(sec?.configured);
      const prof = agentConfig?.profiles?.[preset.id];
      const isActive = activeMeta.presetId === preset.id;

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
            activeMeta.modelName;

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
  }, [agentConfig, secrets, activeMeta.presetId, activeMeta.modelName, magpieProbe]);

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

  return (
    <section className="agent-workspace">
      <div className="agent-chat-pane">
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
                <span className="pane-title">配置助手</span>
                <span className="scope-only-pill" title="该助手仅读写脱敏的 config.toml 声明式配置文件">
                  仅限 config.toml
                </span>
              </div>
              <div className="pane-subtitle" title="编排账号、模型、过滤规则与群聊声明 · 不读取邮件正文、不代写发信">
                对话式编排账号、模型、规则与群聊 · 不读正文不代发
              </div>
            </div>
          </div>

          <div className="pane-header-actions">
            <button
              type="button"
              className={`soft-btn hdr-btn ${showHistoryDrawer ? "active-soft" : ""}`}
              onClick={() => {
                setShowVaultDrawer(false);
                setShowHistoryDrawer((v) => !v);
              }}
              title="查看或切换历史配置对话记录"
            >
              <IconHistory size={14} />
              <span>历史{sessions.length > 0 ? ` (${sessions.length})` : ""}</span>
            </button>

            {turns.length > 0 && (
              <button
                type="button"
                className="soft-btn hdr-btn"
                onClick={handleNewSession}
                disabled={busy}
                title="新建空白配置对话"
              >
                <IconPlus size={13} />
                <span>新建</span>
              </button>
            )}

            <button
              type="button"
              className={`soft-btn hdr-btn ${showVaultDrawer ? "active-soft" : ""}`}
              onClick={() => openVaultDrawer(activeMeta.ready ? null : activeMeta.secretSlot)}
              title="打开本机 DPAPI 凭据保险箱（管理邮箱授权码与各模型 API Key）"
            >
              <IconLock size={14} />
              <span>保险箱 ({configuredSecretCount})</span>
            </button>
          </div>
        </header>

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
              <h2>声明式配置助手</h2>
              <p>
                用自然语言编排邮箱账号、模型参数、过滤规则与多人邮件群聊，变更实时同步至右侧
                <strong>可视化表单</strong>与 <code>config.toml</code>（可自由切换），并清晰标明每次修改的具体字段。
              </p>

              <div className="agent-scope-strip">
                <span className="agent-scope-strip-text">
                  职责说明：本助手<strong>仅维护配置文件</strong>，不读邮件正文、不总结来信、不代写发信
                </span>
                <button
                  type="button"
                  className="agent-scope-link"
                  onClick={onGoToInbox}
                  title="前往消息列表查看来信、生成纪要或起草邮件回复"
                >
                  <IconChat size={12} />
                  <span>去消息会话处理邮件</span>
                </button>
              </div>

              <div className="starter-grid">
                {STARTER_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className="starter-card"
                    onClick={() => {
                      if (item.text.endsWith(" ")) {
                        setInput(item.text);
                        inputRef.current?.focus();
                      } else {
                        sendPrompt(item.text);
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
                  本对话仅编排脱敏 <code>config.toml</code> 配置文件 · 聊天记录已自动保存至本机
                </span>
              </div>

              {turns.map((t, idx) => {
                const isLast = idx === turns.length - 1;
                const canRewindUserTurn =
                  !busy && t.role === "user" && typeof t.id === "number";
                const isLatestUserTurn = idx === lastUserTurnIdx;
                const userRewindInfo =
                  canRewindUserTurn && rewindConfirm?.turnId === t.id && rewindConfirm.anchor === "user"
                    ? inspectRewindFromIndex(idx)
                    : null;

                const canRewindLatestFromAssistant =
                  isLast &&
                  !busy &&
                  !t.streaming &&
                  t.role === "assistant" &&
                  lastUserTurnIdx >= 0;
                const latestUserTurn =
                  lastUserTurnIdx >= 0 ? turns[lastUserTurnIdx] : null;
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
                            onLocateInForm={handleLocateInForm}
                            onOpenDiffTab={handleOpenDiffTab}
                            onRevertBeforeToml={handleRevertBeforeToml}
                            onSecretSaved={async (nextSecrets, msg) => {
                              setSecrets(nextSecrets);
                              await refreshConfigState();
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
                            executeRewind(userRewindInfo.turnId, userRewindInfo.promptText, restoreCfg)
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
                                onClick={() => sendPrompt(sug)}
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
                                title="撤回上一轮问答并将原指令填回输入框（如修改了配置可选择同步还原）"
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
                placeholder="输入 config.toml 配置指令，如：绑定 xxx@qq.com / 屏蔽包含退订的邮件 / 把账单折叠进通知…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendPrompt();
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
                    title="点击切换已配置好的模型，或打开凭据保险箱接入新模型"
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
                        <span>已配置好的模型 ({configuredProviders.length})</span>
                        <span className="composer-menu-sub">点击即刻切换</span>
                      </div>

                      {configuredProviders.length === 0 ? (
                        <div className="composer-menu-empty">
                          <div className="composer-menu-empty-title">暂未检测到已就绪的模型凭据</div>
                          <div className="composer-menu-empty-desc">
                            请先在「凭据保险箱」录入任一服务商 API Key，或在模型配置页启用本地 Ollama。
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
                                        title={`切换至 ${item.preset.name} · ${m}`}
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
                  {busy ? "流式生成中" : "Enter 发送 · Shift+Enter 换行"}
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
                    onClick={() => sendPrompt()}
                    disabled={!canSend}
                    title="发送配置指令 (Enter)"
                  >
                    <IconSend size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </footer>
      </div>

      <AgentConfigInspector
        tab={inspectorTab}
        onTabChange={setInspectorTab}
        spec={spec}
        secrets={secrets}
        configPath={configPath}
        savedToml={savedToml}
        draftToml={draftToml}
        onDraftTomlChange={setDraftToml}
        tomlDirty={tomlDirty}
        applyingToml={applyingToml}
        onApplyToml={applyManualToml}
        onResetToml={() => setDraftToml(savedToml)}
        activeDiff={activeDiff}
        focusSignal={focusSignal}
        onClearHighlight={() => setActiveDiff(null)}
        onBundleUpdated={applyBundleState}
        onSecretUpdated={async (nextSecrets, msg) => {
          setSecrets(nextSecrets);
          await refreshConfigState();
          if (msg) notify(msg);
        }}
        onSwitchAccount={onSwitchAccount}
        onOpenVault={openVaultDrawer}
        onOpenFullSettings={() => onOpenSettings("visual")}
        notify={notify}
        onDataChanged={onDataChanged}
        onRevertBeforeToml={handleRevertBeforeToml}
      />

      {showHistoryDrawer && (
        <HistoryDrawerModal
          sessions={sessions}
          activeSessionId={activeSessionId}
          busy={busy}
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
            await refreshConfigState();
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
    </section>
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

function HistoryDrawerModal({
  sessions,
  activeSessionId,
  busy,
  onClose,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  busy: boolean;
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
      <aside className="history-drawer-panel" aria-label="历史配置对话">
        <div className="history-drawer-head">
          <span className="agent-history-title">配置对话记录</span>
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
              发送配置指令后将自动保存在本机 SQLite 数据库中
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
                    <span className="agent-session-name">{s.title || "新配置对话"}</span>
                    <span className="agent-session-time">{formatSessionTime(s.updated_at)}</span>
                  </div>
                  <div className="agent-session-bottom">
                    <span className="agent-session-preview">
                      {s.preview ? s.preview : "空白配置会话"}
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

function AssistantTurnBody({
  turn,
  onLocateInForm,
  onOpenDiffTab,
  onRevertBeforeToml,
  onSecretSaved,
  onSecretError,
}: {
  turn: RichTurn;
  onLocateInForm: (targetKey: string, diff?: ConfigDiffReport | null) => void;
  onOpenDiffTab: (diff: ConfigDiffReport) => void;
  onRevertBeforeToml: (beforeToml: string) => Promise<void>;
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

  return (
    <div className="assistant-turn-body">
      {(hasThinking || isActivelyThinking) && (
        <div className={`thinking-foldout ${isThinkingOpen ? "open" : ""} ${isActivelyThinking ? "live" : ""}`}>
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
                    ? `正在思考配置方案${secsLabel ? ` · ${secsLabel}` : "…"}`
                    : `正在连接模型分析 config.toml${secsLabel ? ` · ${secsLabel}` : "…"}`
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
        <div className="thinking-inline-hint">正在生成配置答复…</div>
      ) : null}

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
              submit(true);
            }
          }}
        />
        <button
          type="button"
          className="soft-btn"
          onClick={() => submit(false)}
          disabled={saving || !val.trim()}
        >
          仅保存
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => submit(true)}
          disabled={saving || !val.trim()}
        >
          {saving ? "验证中…" : "加密保存并验证"}
        </button>
      </div>
    </div>
  );
}

function VaultDrawerModal({
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
              {isCurrentPreset && <span className="composer-menu-active-tag">当前模型服务</span>}
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
                title="立即切换为当前使用的模型服务"
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
                onClick={() => removeKey(item)}
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
                item.configured ? "输入新密钥以覆盖原加密记录…" : `输入 ${item.label}（明文仅存本机 DPAPI）`
              }
              onChange={(e) => setDraftVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftVal.trim()) {
                  e.preventDefault();
                  saveKey(item.key, true);
                }
              }}
            />
            <div className="vault-drawer-edit-actions">
              <button
                type="button"
                className="soft-btn compact-btn"
                onClick={() => saveKey(item.key, false)}
                disabled={isBusy || !draftVal.trim()}
              >
                仅加密保存
              </button>
              <button
                type="button"
                className="primary-btn compact-btn"
                onClick={() => saveKey(item.key, true)}
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
                Windows DPAPI 系统级加密隔离 · 绝不写入 config.toml 或上传模型
              </div>
            </div>
          </div>
          <button type="button" className="ghost-btn icon-only-btn" onClick={onClose} title="关闭 (Esc)">
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
              <span>大模型服务商 API Key（录入后自动出现在底部模型切换列表）</span>
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
