import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  AccountEntry,
  AutoReplyRuleSpec,
  ComposeLaunchIntent,
  PrivacyScrubPreview,
  ReplyAgentBridge,
  ReplyPolicySpec,
  ReplyQueueItem,
  ReplyQueueStats,
  UnifiedScanReport,
} from "../types";
import { shortTime } from "../util";
import { HtmlMailView } from "./HtmlMailView";
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconCode,
  IconCompose,
  IconEye,
  IconLock,
  IconPlus,
  IconRefresh,
  IconReplyHub,
  IconSend,
  IconShield,
  IconSliders,
  IconSparkles,
  IconTrash,
} from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

type HubTab = "queue" | "automation" | "policy";
type QueueFilter = "pending_review" | "auto_sent" | "sent" | "failed" | "all";
type ContextAuditTab = "sanitized" | "original";

const DEFAULT_POLICY: ReplyPolicySpec = {
  enabled: false,
  auto_scan_on_sync: false,
  enabled_accounts: [],
  allowed_statuses: ["inbox"],
  sender_filter_mode: "all_allowed",
  allow_senders: [],
  allow_domains: [],
  exclude_senders: [],
  exclude_keywords: [],
  skip_sensitive_mails: true,
  include_groups: false,
  max_context_chars: 1600,
  redact_pii: true,
  custom_redact_terms: [],
  auto_send_enabled: false,
  auto_send_senders: [],
  auto_send_domains: [],
  auto_send_hourly_limit: 10,
  outbound_dlp_guard: true,
  persona_instructions:
    "礼貌、专业、简洁地回复来信；对需要确认排期、金额、审批或合同条款的事项，先得体确认已收到并说明将尽快核实答复，绝不擅自做出未授权承诺。",
  auto_rules: [],
};

const EMPTY_QUEUE_STATS: ReplyQueueStats = {
  pending_count: 0,
  approved_sent_count: 0,
  auto_sent_count: 0,
  dismissed_count: 0,
  failed_count: 0,
  auto_sent_last_hour: 0,
};

interface RuleFormState {
  id: string;
  name: string;
  enabled: boolean;
  accounts: string[];
  matchSendersText: string;
  matchDomainsText: string;
  matchKeywordsText: string;
  mode: "ai" | "template";
  instructionsOrTemplate: string;
  templateHtml: string;
  requireReview: boolean;
  cooldownMinutes: number;
}

function emptyRuleForm(): RuleFormState {
  return {
    id: `rule-${Date.now().toString(36)}`,
    name: "",
    enabled: true,
    accounts: [],
    matchSendersText: "",
    matchDomainsText: "",
    matchKeywordsText: "",
    mode: "ai",
    instructionsOrTemplate:
      "礼貌确认已收到对方来信，针对对方核心诉求给出简明专业回应，并说明将尽快安排跟进。",
    templateHtml: "",
    requireReview: false,
    cooldownMinutes: 60,
  };
}

function ruleToForm(r: AutoReplyRuleSpec): RuleFormState {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    accounts: r.accounts || [],
    matchSendersText: (r.match_senders || []).join(", "),
    matchDomainsText: (r.match_domains || []).join(", "),
    matchKeywordsText: (r.match_keywords || []).join(", "),
    mode: r.mode === "template" ? "template" : "ai",
    instructionsOrTemplate: r.instructions_or_template || "",
    templateHtml: r.template_html || "",
    requireReview: Boolean(r.require_review),
    cooldownMinutes: r.cooldown_minutes || 60,
  };
}

function parseLinesOrCommas(raw: string): string[] {
  return raw
    .split(/[\n,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatListForInput(items: string[] | undefined): string {
  return (items || []).join(", ");
}

export interface ReplyHubWorkspaceProps {
  accounts: AccountEntry[];
  hasDemo: boolean;
  agentDockOpen: boolean;
  onSummonGlobalAgent: (prefillPrompt?: string, autoSend?: boolean) => void;
  onBindReplyBridge: (bridge: ReplyAgentBridge | null) => void;
  notify: (text: string, isError?: boolean) => void;
  onOpenInCompose: (intent: Omit<ComposeLaunchIntent, "id">) => void;
  onDataChanged?: () => void;
}

export function ReplyHubWorkspace({
  accounts,
  hasDemo,
  agentDockOpen,
  onSummonGlobalAgent,
  onBindReplyBridge,
  notify,
  onOpenInCompose,
  onDataChanged,
}: ReplyHubWorkspaceProps) {
  const [tab, setTab] = useState<HubTab>("queue");
  const [statusFilter, setStatusFilter] = useState<QueueFilter>("pending_review");
  const [accountFilter, setAccountFilter] = useState<string>("all");

  const [policy, setPolicy] = useState<ReplyPolicySpec>(DEFAULT_POLICY);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [allowSendersText, setAllowSendersText] = useState("");
  const [allowDomainsText, setAllowDomainsText] = useState("");
  const [excludeSendersText, setExcludeSendersText] = useState("");
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("");
  const [customRedactText, setCustomRedactText] = useState("");
  const [autoSendSendersText, setAutoSendSendersText] = useState("");
  const [autoSendDomainsText, setAutoSendDomainsText] = useState("");

  const [items, setItems] = useState<ReplyQueueItem[]>([]);
  const [stats, setStats] = useState<ReplyQueueStats>(EMPTY_QUEUE_STATS);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [auditTab, setAuditTab] = useState<ContextAuditTab>("sanitized");

  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editHtml, setEditHtml] = useState("");
  const [editingHtmlCode, setEditingHtmlCode] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [lastScanReport, setLastScanReport] = useState<UnifiedScanReport | null>(null);

  // 自动化回复规则编辑器状态
  const [ruleForm, setRuleForm] = useState<RuleFormState | null>(null);
  const [savingRule, setSavingRule] = useState(false);

  // 本地脱敏实时验证沙盒
  const [scrubSample, setScrubSample] = useState(
    "王总您好，我的手机是 13812345678，身份证 310101199205183412，打款卡号 6222021001123456789，测试密钥 sk-proj-9876543210abcdefghij。",
  );
  const [scrubPreview, setScrubPreview] = useState<PrivacyScrubPreview | null>(null);

  const syncFormStringsFromPolicy = useCallback((p: ReplyPolicySpec) => {
    setAllowSendersText(formatListForInput(p.allow_senders));
    setAllowDomainsText(formatListForInput(p.allow_domains));
    setExcludeSendersText(formatListForInput(p.exclude_senders));
    setExcludeKeywordsText(formatListForInput(p.exclude_keywords));
    setCustomRedactText(formatListForInput(p.custom_redact_terms));
    setAutoSendSendersText(formatListForInput(p.auto_send_senders));
    setAutoSendDomainsText(formatListForInput(p.auto_send_domains));
  }, []);

  const loadPolicy = useCallback(async () => {
    try {
      const pol = await api.getReplyPolicy();
      const merged: ReplyPolicySpec = {
        ...DEFAULT_POLICY,
        ...pol,
        auto_rules: pol.auto_rules || [],
      };
      setPolicy(merged);
      syncFormStringsFromPolicy(merged);
      setPolicyDirty(false);
    } catch (e) {
      notify(`读取统一回复策略失败：${e}`, true);
    }
  }, [notify, syncFormStringsFromPolicy]);

  const loadQueue = useCallback(async () => {
    try {
      const apiStatus =
        statusFilter === "all" || statusFilter === "sent" ? "all" : statusFilter;
      const [rawList, qStats] = await Promise.all([
        api.listReplyQueue(apiStatus, accountFilter === "all" ? undefined : accountFilter),
        api.getReplyQueueStats(),
      ]);
      setStats(qStats);

      const filtered =
        statusFilter === "sent"
          ? rawList.filter((it) => it.status === "approved_sent" || it.status === "auto_sent")
          : rawList;

      setItems(filtered);
      setCheckedIds((prev) =>
        prev.filter((id) => filtered.some((x) => x.id === id && x.status === "pending_review")),
      );
      setSelectedId((prev) => {
        if (prev && filtered.some((x) => x.id === prev)) return prev;
        return filtered.length > 0 ? filtered[0].id : null;
      });
    } catch (e) {
      notify(`加载待审队列失败：${e}`, true);
    }
  }, [accountFilter, notify, statusFilter]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    let unlistenMail: (() => void) | undefined;
    let unlistenQueue: (() => void) | undefined;
    listen("mail-updated", () => {
      void loadQueue();
      void loadPolicy();
    }).then((fn) => {
      unlistenMail = fn;
    });
    listen("reply-queue-updated", () => {
      void loadQueue();
      void loadPolicy();
    }).then((fn) => {
      unlistenQueue = fn;
    });
    return () => {
      if (unlistenMail) unlistenMail();
      if (unlistenQueue) unlistenQueue();
    };
  }, [loadPolicy, loadQueue]);

  const selectedItem = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  );

  useEffect(() => {
    if (selectedItem) {
      setEditSubject(selectedItem.draft_subject);
      setEditBody(selectedItem.draft_body);
      setEditHtml(selectedItem.draft_html || "");
      setEditingHtmlCode(false);
      setDraftDirty(false);
    } else {
      setEditSubject("");
      setEditBody("");
      setEditHtml("");
      setDraftDirty(false);
    }
  }, [selectedItem]);

  // 向右侧全局 AI 助手面板注册桥接上下文
  const handleBridgeStreamHtml = useCallback((html: string) => {
    setEditHtml(html);
    setEditingHtmlCode(false);
    setDraftDirty(true);
  }, []);

  const handleBridgeItemUpdated = useCallback(
    (updated: ReplyQueueItem) => {
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      if (selectedId === updated.id) {
        setEditSubject(updated.draft_subject);
        setEditBody(updated.draft_body);
        setEditHtml(updated.draft_html || "");
        setDraftDirty(false);
      }
      onDataChanged?.();
    },
    [onDataChanged, selectedId],
  );

  const handleBridgeRefreshAll = useCallback(() => {
    void loadPolicy();
    void loadQueue();
    onDataChanged?.();
  }, [loadPolicy, loadQueue, onDataChanged]);

  useEffect(() => {
    onBindReplyBridge({
      selectedItem,
      onStreamHtml: handleBridgeStreamHtml,
      onItemUpdated: handleBridgeItemUpdated,
      onPolicyOrQueueChanged: handleBridgeRefreshAll,
    });
  }, [
    handleBridgeItemUpdated,
    handleBridgeRefreshAll,
    handleBridgeStreamHtml,
    onBindReplyBridge,
    selectedItem,
  ]);

  useEffect(() => {
    return () => onBindReplyBridge(null);
  }, [onBindReplyBridge]);

  const availableAccountChoices = useMemo(() => {
    if (accounts.length > 0) {
      return accounts.map((a) => ({
        email: a.email.toLowerCase(),
        label: a.display_name ? `${a.display_name} (${a.email})` : a.email,
      }));
    }
    if (hasDemo) {
      return [{ email: "demo@mailchat.local", label: "演示收件箱 (demo@mailchat.local)" }];
    }
    return [];
  }, [accounts, hasDemo]);

  const updatePolicyField = <K extends keyof ReplyPolicySpec>(
    key: K,
    val: ReplyPolicySpec[K],
  ) => {
    setPolicy((prev) => ({ ...prev, [key]: val }));
    setPolicyDirty(true);
  };

  const toggleAuthorizedAccount = (email: string) => {
    const norm = email.trim().toLowerCase();
    const exists = policy.enabled_accounts.some((x) => x.toLowerCase() === norm);
    const next = exists
      ? policy.enabled_accounts.filter((x) => x.toLowerCase() !== norm)
      : [...policy.enabled_accounts, norm];
    updatePolicyField("enabled_accounts", next);
  };

  const buildPolicyPayload = (): ReplyPolicySpec => ({
    ...policy,
    allow_senders: parseLinesOrCommas(allowSendersText),
    allow_domains: parseLinesOrCommas(allowDomainsText),
    exclude_senders: parseLinesOrCommas(excludeSendersText),
    exclude_keywords: parseLinesOrCommas(excludeKeywordsText),
    custom_redact_terms: parseLinesOrCommas(customRedactText),
    auto_send_senders: parseLinesOrCommas(autoSendSendersText),
    auto_send_domains: parseLinesOrCommas(autoSendDomainsText),
  });

  const handleSavePolicy = async () => {
    setSavingPolicy(true);
    try {
      const saved = await api.saveReplyPolicy(buildPolicyPayload());
      setPolicy(saved);
      syncFormStringsFromPolicy(saved);
      setPolicyDirty(false);
      notify("隐私与统一回复权限策略已保存");
      onDataChanged?.();
    } catch (e) {
      notify(`保存策略失败：${e}`, true);
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleScanNow = async () => {
    if (policyDirty) {
      try {
        const saved = await api.saveReplyPolicy(buildPolicyPayload());
        setPolicy(saved);
        setPolicyDirty(false);
      } catch (e) {
        notify(`保存策略失败：${e}`, true);
        return;
      }
    }

    if (policy.enabled_accounts.length === 0 && availableAccountChoices.length > 0) {
      // 若尚未勾选任何授权邮箱且只有 1 个邮箱/演示邮箱，提示或自动引导
      setTab("policy");
      notify("请先勾选允许读取的授权邮箱，确保非授权邮箱 100% 物理隔离", true);
      return;
    }

    setScanning(true);
    try {
      const report = await api.scanUnifiedReplies(false);
      setLastScanReport(report);
      await loadQueue();
      onDataChanged?.();
      if (report.queued_review_count === 0 && report.auto_sent_count === 0) {
        notify(
          `扫描完成：检查 ${report.scanned_candidates} 封候选邮件，隐私过滤跳过 ${report.skipped_by_privacy_count} 封，暂无新增待回复项`,
        );
      } else {
        notify(
          `扫描完成：待审草稿 ${report.queued_review_count} 封，自动发出 ${report.auto_sent_count} 封（入模脱敏 ${report.total_redactions} 处）`,
        );
      }
    } catch (e) {
      notify(`扫描失败：${e}`, true);
    } finally {
      setScanning(false);
    }
  };

  // ---------------- 自动化回复规则保存 / 启停 / 删除 ----------------
  const persistUpdatedRules = async (
    nextRules: AutoReplyRuleSpec[],
    extraPatch?: Partial<ReplyPolicySpec>,
    toastMsg?: string,
  ) => {
    setSavingRule(true);
    try {
      const base = buildPolicyPayload();
      const mergedAccounts = new Set(base.enabled_accounts.map((a) => a.toLowerCase()));
      for (const r of nextRules) {
        if (r.enabled) {
          for (const acc of r.accounts) mergedAccounts.add(acc.toLowerCase());
        }
      }
      if (
        mergedAccounts.size === 0 &&
        nextRules.some((r) => r.enabled) &&
        availableAccountChoices.length > 0
      ) {
        mergedAccounts.add(availableAccountChoices[0].email);
      }

      const payload: ReplyPolicySpec = {
        ...base,
        ...extraPatch,
        enabled_accounts: Array.from(mergedAccounts),
        auto_rules: nextRules,
      };
      const saved = await api.saveReplyPolicy(payload);
      setPolicy(saved);
      syncFormStringsFromPolicy(saved);
      setPolicyDirty(false);
      setRuleForm(null);
      if (toastMsg) notify(toastMsg);
      onDataChanged?.();
    } catch (e) {
      notify(`保存自动化规则失败：${e}`, true);
    } finally {
      setSavingRule(false);
    }
  };

  const handleSaveRuleForm = async () => {
    if (!ruleForm) return;
    if (!ruleForm.name.trim()) {
      notify("请填写自动化规则名称", true);
      return;
    }
    const spec: AutoReplyRuleSpec = {
      id: ruleForm.id.trim() || `rule-${Date.now().toString(36)}`,
      name: ruleForm.name.trim(),
      enabled: ruleForm.enabled,
      accounts: ruleForm.accounts,
      match_senders: parseLinesOrCommas(ruleForm.matchSendersText),
      match_domains: parseLinesOrCommas(ruleForm.matchDomainsText),
      match_keywords: parseLinesOrCommas(ruleForm.matchKeywordsText),
      mode: ruleForm.mode,
      instructions_or_template: ruleForm.instructionsOrTemplate.trim(),
      template_html: ruleForm.templateHtml.trim(),
      require_review: ruleForm.requireReview,
      cooldown_minutes: Math.max(5, Math.min(10080, Number(ruleForm.cooldownMinutes) || 60)),
    };
    const existing = policy.auto_rules || [];
    const idx = existing.findIndex((r) => r.id === spec.id);
    const next =
      idx >= 0 ? existing.map((r, i) => (i === idx ? spec : r)) : [...existing, spec];
    await persistUpdatedRules(
      next,
      spec.enabled ? { enabled: true, auto_scan_on_sync: true } : undefined,
      `自动化回复规则「${spec.name}」已保存并生效`,
    );
  };

  const handleToggleRule = async (rule: AutoReplyRuleSpec) => {
    const nextEnabled = !rule.enabled;
    const next = (policy.auto_rules || []).map((r) =>
      r.id === rule.id ? { ...r, enabled: nextEnabled } : r,
    );
    await persistUpdatedRules(
      next,
      nextEnabled ? { enabled: true, auto_scan_on_sync: true } : undefined,
      `规则「${rule.name}」已${nextEnabled ? "启用" : "暂停"}`,
    );
  };

  const handleDeleteRule = async (rule: AutoReplyRuleSpec) => {
    const next = (policy.auto_rules || []).filter((r) => r.id !== rule.id);
    await persistUpdatedRules(next, undefined, `已移除规则「${rule.name}」`);
  };

  const openPresetRule = (preset: "inquiry" | "vacation" | "support") => {
    if (preset === "inquiry") {
      setRuleForm({
        ...emptyRuleForm(),
        name: "商务询价与合作自动接待",
        matchKeywordsText: "报价, 合作, 咨询, 方案, 采购",
        mode: "ai",
        instructionsOrTemplate:
          "热情专业地确认已收到对方的合作/询价需求，告知我们正在评估细节并将在 1 个工作日内安排专人详细对接，不擅自承诺具体报价数字。",
        requireReview: false,
        cooldownMinutes: 120,
      });
    } else if (preset === "vacation") {
      setRuleForm({
        ...emptyRuleForm(),
        name: "休假 / 外出自动回复",
        mode: "template",
        instructionsOrTemplate:
          "您好，感谢您的来信！我目前正在外出/休假中，可能无法及时查看邮件，归来后将第一时间回复您。如有紧急事务请电话联系，祝好！",
        requireReview: false,
        cooldownMinutes: 720,
      });
    } else {
      setRuleForm({
        ...emptyRuleForm(),
        name: "客户问题反馈收悉回执",
        matchKeywordsText: "反馈, 故障, 报错, 售后, 工单",
        mode: "ai",
        instructionsOrTemplate:
          "诚恳礼貌地确认已收到问题反馈，安抚对方情绪，说明技术团队已介入排查并将在核实进展后第一时间同步结果。",
        requireReview: false,
        cooldownMinutes: 60,
      });
    }
  };

  // ---------------- 草稿编辑与审批发信 ----------------
  const handleSaveDraft = async () => {
    if (!selectedItem) return;
    setSavingDraft(true);
    try {
      const updated = await api.updateReplyQueueItem(
        selectedItem.id,
        editSubject,
        editBody,
        editHtml || null,
      );
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setDraftDirty(false);
      notify("草稿修改已保存");
    } catch (e) {
      notify(`保存草稿失败：${e}`, true);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleApproveSend = async (ids: number[], forceDlpOverride = false) => {
    if (ids.length === 0) return;
    if (selectedItem && ids.includes(selectedItem.id) && draftDirty) {
      try {
        await api.updateReplyQueueItem(selectedItem.id, editSubject, editBody, editHtml || null);
        setDraftDirty(false);
      } catch (e) {
        notify(`保存当前草稿失败：${e}`, true);
        return;
      }
    }

    setApproving(true);
    try {
      const res = await api.approveSendReplyQueue(ids, forceDlpOverride);
      await loadQueue();
      onDataChanged?.();
      if (res.failed_count > 0) {
        notify(
          `成功发出 ${res.sent_count} 封，拦截/失败 ${res.failed_count} 封：${res.errors[0] || ""}`,
          true,
        );
      } else {
        notify(`已通过对应原属邮箱发出 ${res.sent_count} 封回复`);
      }
    } catch (e) {
      notify(`批准发信失败：${e}`, true);
    } finally {
      setApproving(false);
    }
  };

  const handleDismiss = async (ids: number[]) => {
    if (ids.length === 0) return;
    try {
      await api.dismissReplyQueueItems(ids);
      await loadQueue();
      onDataChanged?.();
      notify(`已忽略 ${ids.length} 封邮件`);
    } catch (e) {
      notify(`操作失败：${e}`, true);
    }
  };

  const handleClearFinished = async () => {
    try {
      const n = await api.clearFinishedReplyQueue();
      await loadQueue();
      onDataChanged?.();
      notify(`已清理 ${n} 条历史记录`);
    } catch (e) {
      notify(`清理失败：${e}`, true);
    }
  };

  const toggleCheckItem = (id: number) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const pendingItemsInView = useMemo(
    () => items.filter((it) => it.status === "pending_review"),
    [items],
  );

  const toggleCheckAllPending = () => {
    if (checkedIds.length === pendingItemsInView.length && pendingItemsInView.length > 0) {
      setCheckedIds([]);
    } else {
      setCheckedIds(pendingItemsInView.map((x) => x.id));
    }
  };

  const runLiveScrubTest = async () => {
    try {
      const terms = parseLinesOrCommas(customRedactText);
      const res = await api.previewPrivacyScrub(scrubSample, policy.redact_pii, terms);
      setScrubPreview(res);
    } catch (e) {
      notify(`脱敏预览失败：${e}`, true);
    }
  };

  useEffect(() => {
    if (tab === "policy") {
      void runLiveScrubTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, policy.redact_pii]);

  const enabledAutoRulesCount = useMemo(
    () => (policy.auto_rules || []).filter((r) => r.enabled).length,
    [policy.auto_rules],
  );

  return (
    <section className="reply-hub-workspace">
      {/* 顶栏 */}
      <header
        className="reply-hub-topbar"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <div className="reply-hub-title-group no-drag">
          <div className="reply-hub-icon-badge">
            <IconReplyHub size={16} />
          </div>
          <div>
            <div className="reply-hub-title">统一批复与自动化回复</div>
            <div className="reply-hub-subtitle">
              授权邮箱隔离 · 入模前本地 PII 盲脱敏 · 条件自动回复与防循环守卫
            </div>
          </div>
        </div>

        <div className="reply-hub-top-tabs no-drag" role="tablist">
          <button
            type="button"
            className={`reply-hub-tab ${tab === "queue" ? "active" : ""}`}
            onClick={() => setTab("queue")}
          >
            <span>待审与发信记录</span>
            {stats.pending_count > 0 && (
              <span className="reply-hub-badge">{stats.pending_count}</span>
            )}
          </button>
          <button
            type="button"
            className={`reply-hub-tab ${tab === "automation" ? "active" : ""}`}
            onClick={() => setTab("automation")}
          >
            <span>⚡ 自动化回复规则</span>
            {enabledAutoRulesCount > 0 && (
              <span className="reply-hub-badge accent">{enabledAutoRulesCount}</span>
            )}
          </button>
          <button
            type="button"
            className={`reply-hub-tab ${tab === "policy" ? "active" : ""}`}
            onClick={() => setTab("policy")}
          >
            <IconShield size={13} />
            <span>隐私与权限边界</span>
            {policyDirty && <span className="reply-hub-dirty-dot" />}
          </button>
        </div>

        <div className="reply-hub-top-actions no-drag">
          <button
            type="button"
            className="btn ghost small"
            disabled={scanning}
            onClick={() => void handleScanNow()}
          >
            <IconRefresh size={13} className={scanning ? "spin" : ""} />
            <span>{scanning ? "扫描执行中…" : "扫描待回邮件"}</span>
          </button>

          <button
            type="button"
            className={`compose-ai-trigger ${agentDockOpen ? "active" : ""}`}
            onClick={() => onSummonGlobalAgent()}
            title="展开右侧全局 AI 助手面板（可一句话建自动回复规则或改写当前草稿）"
          >
            <IconSparkles size={13} />
            <span>{agentDockOpen ? "AI 助手已展开" : "AI 助手"}</span>
          </button>
        </div>
      </header>

      {/* 安全状态态势条 */}
      <div className="reply-hub-posture-strip">
        <span className="posture-chip ok">
          <IconLock size={12} />
          <span>
            已授权 {policy.enabled_accounts.length} 个邮箱（其余邮箱 100% 物理隔离）
          </span>
        </span>
        <span className={`posture-chip ${policy.redact_pii ? "ok" : "warn"}`}>
          <span>{policy.redact_pii ? "入模 PII 脱敏已开启" : "入模 PII 脱敏已关闭"}</span>
        </span>
        <span className={`posture-chip ${enabledAutoRulesCount > 0 ? "accent" : "neutral"}`}>
          <span>
            {enabledAutoRulesCount > 0
              ? `${enabledAutoRulesCount} 条自动回复规则运行中 · 本小时自动发出 ${stats.auto_sent_last_hour}/${policy.auto_send_hourly_limit}`
              : "支持按发件人/关键词配置自动秒回或休假回复"}
          </span>
        </span>
      </div>

      {/* ==================== Tab 1: 待审与发信记录 ==================== */}
      {tab === "queue" && (
        <div className="reply-hub-queue-layout">
          <div className="reply-queue-list-pane">
            <div className="reply-queue-filters">
              <div className="reply-filter-pills">
                <button
                  type="button"
                  className={statusFilter === "pending_review" ? "active" : ""}
                  onClick={() => setStatusFilter("pending_review")}
                >
                  待审 ({stats.pending_count})
                </button>
                <button
                  type="button"
                  className={statusFilter === "auto_sent" ? "active" : ""}
                  onClick={() => setStatusFilter("auto_sent")}
                >
                  ⚡ 自动已回 ({stats.auto_sent_count})
                </button>
                <button
                  type="button"
                  className={statusFilter === "sent" ? "active" : ""}
                  onClick={() => setStatusFilter("sent")}
                >
                  全部已发 ({stats.approved_sent_count + stats.auto_sent_count})
                </button>
                {stats.failed_count > 0 && (
                  <button
                    type="button"
                    className={statusFilter === "failed" ? "active" : ""}
                    onClick={() => setStatusFilter("failed")}
                  >
                    失败 ({stats.failed_count})
                  </button>
                )}
                <button
                  type="button"
                  className={statusFilter === "all" ? "active" : ""}
                  onClick={() => setStatusFilter("all")}
                >
                  全部
                </button>
              </div>

              <select
                className="reply-account-filter-select"
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
              >
                <option value="all">全部授权邮箱</option>
                {availableAccountChoices.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.email}
                  </option>
                ))}
              </select>
            </div>

            {pendingItemsInView.length > 0 && (
              <div className="reply-batch-bar">
                <label className="reply-check-all">
                  <input
                    type="checkbox"
                    checked={
                      checkedIds.length === pendingItemsInView.length &&
                      pendingItemsInView.length > 0
                    }
                    onChange={toggleCheckAllPending}
                  />
                  <span>已选 {checkedIds.length} 封</span>
                </label>
                <div className="reply-batch-btns">
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={checkedIds.length === 0 || approving}
                    onClick={() => void handleApproveSend(checkedIds, false)}
                  >
                    <IconSend size={12} />
                    <span>批量批准发送</span>
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={checkedIds.length === 0}
                    onClick={() => void handleDismiss(checkedIds)}
                  >
                    忽略
                  </button>
                </div>
              </div>
            )}

            <div className="reply-queue-items-scroll">
              {items.length === 0 ? (
                <div className="reply-queue-empty">
                  <IconReplyHub size={28} />
                  <div className="reply-queue-empty-title">
                    {policy.enabled_accounts.length === 0
                      ? "尚未授权需要统一处理或自动回复的邮箱"
                      : "当前筛选下暂无记录"}
                  </div>
                  <p>
                    {policy.enabled_accounts.length === 0
                      ? "你可以前往「隐私与权限边界」勾选授权邮箱，或直接点击右上角「AI 助手」一句话创建自动化回复规则。"
                      : "点击上方「扫描待回邮件」，或配置「自动化回复规则」在新邮件到达时自动回复。"}
                  </p>
                  <div className="reply-empty-actions">
                    {policy.enabled_accounts.length === 0 ? (
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => setTab("policy")}
                      >
                        配置授权邮箱
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => setTab("automation")}
                      >
                        配置自动化回复规则
                      </button>
                    )}
                    {(stats.approved_sent_count > 0 ||
                      stats.auto_sent_count > 0 ||
                      stats.dismissed_count > 0) && (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={handleClearFinished}
                      >
                        清理已完成记录
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                items.map((item) => {
                  const isSelected = item.id === selectedId;
                  const isPending = item.status === "pending_review";
                  const accBadge =
                    item.account_email === "__unbound__"
                      ? "demo@mailchat.local"
                      : item.account_email;
                  return (
                    <div
                      key={item.id}
                      className={`reply-queue-card ${isSelected ? "selected" : ""} status-${item.status}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="reply-card-top">
                        {isPending && (
                          <input
                            type="checkbox"
                            checked={checkedIds.includes(item.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleCheckItem(item.id)}
                          />
                        )}
                        <span className="reply-card-account-pill">{accBadge}</span>
                        <span className="reply-card-time">{shortTime(item.created_at)}</span>
                      </div>

                      <div className="reply-card-sender">
                        <strong>{item.sender_name || item.sender_addr.split("@")[0]}</strong>
                        <span>&lt;{item.sender_addr}&gt;</span>
                      </div>
                      <div className="reply-card-subject">
                        {item.original_subject || "(无主题)"}
                      </div>

                      <div className="reply-card-badges">
                        {item.redactions.length > 0 && (
                          <span className="reply-mini-badge ok">
                            已脱敏 {item.redactions.length} 处
                          </span>
                        )}
                        {item.draft_html?.trim() && (
                          <span className="reply-mini-badge info">HTML</span>
                        )}
                        {item.dlp_warning && (
                          <span className="reply-mini-badge warn">DLP 提醒</span>
                        )}
                        <span className={`reply-mini-badge state-${item.status}`}>
                          {item.status === "pending_review"
                            ? "待审阅"
                            : item.status === "approved_sent"
                              ? "人工批准已发"
                              : item.status === "auto_sent"
                                ? "⚡ 自动已回"
                                : item.status === "failed"
                                  ? "发送失败"
                                  : "已忽略"}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {lastScanReport && (
              <div className="reply-scan-summary-foot">
                <div>
                  最近扫描：候选 {lastScanReport.scanned_candidates} 封 · 隐私拦截{" "}
                  {lastScanReport.skipped_by_privacy_count} 封 · 自动发出{" "}
                  {lastScanReport.auto_sent_count} 封
                </div>
              </div>
            )}
          </div>

          {/* 右侧详情与草稿审阅 */}
          <div className="reply-queue-detail-pane">
            {!selectedItem ? (
              <div className="reply-detail-placeholder">
                <IconSparkles size={26} />
                <p>从左侧选择一封记录，查看入模脱敏审计或让右侧 AI 助手协助改写回复草稿。</p>
              </div>
            ) : (
              <div className="reply-detail-content">
                <div className="reply-detail-meta-card">
                  <div className="reply-detail-meta-header">
                    <div>
                      <div className="reply-detail-origin">
                        回复发件身份：
                        <strong>
                          {selectedItem.account_email === "__unbound__"
                            ? "demo@mailchat.local"
                            : selectedItem.account_email}
                        </strong>
                        <span className="reply-detail-arrow">→</span>
                        收件方：<strong>{selectedItem.sender_addr}</strong>
                      </div>
                      <div className="reply-detail-perm-line">
                        裁决说明：{selectedItem.permission_reason}
                        {selectedItem.confidence_note
                          ? ` · ${selectedItem.confidence_note}`
                          : ""}
                      </div>
                    </div>

                    <div className="reply-detail-audit-tabs">
                      <button
                        type="button"
                        className={auditTab === "sanitized" ? "active" : ""}
                        onClick={() => setAuditTab("sanitized")}
                      >
                        <IconLock size={11} />
                        <span>AI 实际所见（脱敏后）</span>
                      </button>
                      <button
                        type="button"
                        className={auditTab === "original" ? "active" : ""}
                        onClick={() => setAuditTab("original")}
                      >
                        <IconEye size={11} />
                        <span>本地原信摘要</span>
                      </button>
                    </div>
                  </div>

                  {selectedItem.redactions.length > 0 && (
                    <div className="reply-redaction-summary">
                      <span>本地入模前已剥离敏感项：</span>
                      {selectedItem.redactions.map((h, i) => (
                        <span key={i} className="reply-redact-pill">
                          {h.placeholder} ({h.kind_label} · {h.masked_preview})
                        </span>
                      ))}
                    </div>
                  )}

                  <pre className="reply-audit-box">
                    {auditTab === "sanitized"
                      ? selectedItem.sanitized_input
                      : `主题: ${selectedItem.original_subject}\n\n${selectedItem.original_snippet}`}
                  </pre>
                </div>

                {selectedItem.dlp_warning && (
                  <div className="reply-dlp-banner">
                    <IconAlert size={14} />
                    <span>出站 DLP 提醒：{selectedItem.dlp_warning}</span>
                  </div>
                )}

                {selectedItem.error_msg && (
                  <div className="reply-error-banner">
                    <IconAlert size={14} />
                    <span>发信诊断：{selectedItem.error_msg}</span>
                  </div>
                )}

                {/* 草稿编辑区 */}
                <div className="reply-draft-editor-card">
                  <div className="reply-draft-field">
                    <label>回复主题</label>
                    <input
                      value={editSubject}
                      disabled={
                        selectedItem.status === "approved_sent" ||
                        selectedItem.status === "auto_sent"
                      }
                      onChange={(e) => {
                        setEditSubject(e.target.value);
                        setDraftDirty(true);
                      }}
                    />
                  </div>

                  <div className="reply-draft-field grow">
                    <div className="reply-draft-label-row">
                      <label>
                        {editHtml.trim() ? "回复正文（HTML 富文本）" : "回复草稿正文"}
                      </label>
                      <div className="reply-draft-micro-tools">
                        {editHtml.trim() && (
                          <>
                            <button
                              type="button"
                              className="compose-micro-btn"
                              onClick={() => setEditingHtmlCode((v) => !v)}
                            >
                              <IconCode size={11} />
                              <span>{editingHtmlCode ? "预览渲染" : "HTML 源码"}</span>
                            </button>
                            <button
                              type="button"
                              className="compose-micro-btn"
                              onClick={() => {
                                setEditHtml("");
                                setDraftDirty(true);
                              }}
                            >
                              转为纯文本
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="compose-micro-btn accent"
                          onClick={() => onSummonGlobalAgent()}
                          title="在右侧全局 AI 面板中直接输入修改要求，实时改写当前草稿"
                        >
                          <IconSparkles size={11} />
                          <span>让右侧 AI 改写</span>
                        </button>
                      </div>
                    </div>

                    {editHtml.trim() && !editingHtmlCode ? (
                      <div className="reply-html-preview-wrap">
                        <HtmlMailView html={editHtml} status="inbox" />
                      </div>
                    ) : editHtml.trim() && editingHtmlCode ? (
                      <textarea
                        value={editHtml}
                        spellCheck={false}
                        onChange={(e) => {
                          setEditHtml(e.target.value);
                          setDraftDirty(true);
                        }}
                      />
                    ) : (
                      <textarea
                        value={editBody}
                        disabled={
                          selectedItem.status === "approved_sent" ||
                          selectedItem.status === "auto_sent"
                        }
                        onChange={(e) => {
                          setEditBody(e.target.value);
                          setDraftDirty(true);
                        }}
                      />
                    )}
                  </div>

                  <div className="reply-draft-actions">
                    <div className="reply-draft-actions-left">
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() =>
                          onOpenInCompose({
                            fromEmail:
                              selectedItem.account_email === "__unbound__"
                                ? undefined
                                : selectedItem.account_email,
                            to: [selectedItem.sender_addr],
                            subject: editSubject,
                            bodyPlain: editBody,
                            bodyHtml: editHtml || undefined,
                            replyToId: selectedItem.message_id_ref,
                            replyContext: selectedItem.sanitized_input,
                          })
                        }
                      >
                        <IconCompose size={13} />
                        <span>转入写信页</span>
                      </button>

                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => {
                          setRuleForm({
                            ...emptyRuleForm(),
                            name: `自动回复 ${selectedItem.sender_name || selectedItem.sender_addr}`,
                            accounts:
                              selectedItem.account_email === "__unbound__"
                                ? []
                                : [selectedItem.account_email],
                            matchSendersText: selectedItem.sender_addr,
                            mode: "ai",
                          });
                          setTab("automation");
                        }}
                      >
                        <span>⚡ 为此人建自动回复</span>
                      </button>

                      {draftDirty && (
                        <button
                          type="button"
                          className="btn ghost small"
                          disabled={savingDraft}
                          onClick={() => void handleSaveDraft()}
                        >
                          {savingDraft ? "保存中…" : "保存草稿"}
                        </button>
                      )}
                    </div>

                    {selectedItem.status !== "approved_sent" &&
                      selectedItem.status !== "auto_sent" && (
                        <div className="reply-draft-actions-right">
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => void handleDismiss([selectedItem.id])}
                          >
                            <IconTrash size={13} />
                            <span>忽略</span>
                          </button>

                          {selectedItem.dlp_warning ? (
                            <button
                              type="button"
                              className="btn danger small"
                              disabled={approving}
                              onClick={() => void handleApproveSend([selectedItem.id], true)}
                            >
                              <IconSend size={13} />
                              <span>确认无泄密并强制发送</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn primary"
                              disabled={approving}
                              onClick={() => void handleApproveSend([selectedItem.id], false)}
                            >
                              <IconCheck size={14} />
                              <span>{approving ? "正在发送…" : "批准并发送"}</span>
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== Tab 2: 自动化回复规则引擎 ==================== */}
      {tab === "automation" && (
        <div className="reply-policy-scroll">
          <div className="reply-policy-grid">
            <section className="policy-card">
              <div className="policy-card-head">
                <div>
                  <h3>⚡ 自动化回复规则（收信实时触发 + 防死循环保护）</h3>
                  <p>
                    当授权邮箱收到匹配发件人、域名或关键词的新邮件时，自动按规则调用 AI（基于脱敏正文）或固定模板回复。系统内置{" "}
                    <code>no-reply</code> 过滤、发件人冷却窗口、每小时速率上限与出站 DLP 拦截。你也可以直接在右侧「AI 助手」用自然语言增删规则。
                  </p>
                </div>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => setRuleForm(emptyRuleForm())}
                >
                  <IconPlus size={13} />
                  <span>新建自动回复规则</span>
                </button>
              </div>

              {/* 快捷场景模板按钮 */}
              <div className="auto-rule-presets-bar">
                <span className="auto-rule-presets-label">快速创建场景：</span>
                <button
                  type="button"
                  className="dock-mini-chip"
                  onClick={() => openPresetRule("inquiry")}
                >
                  💼 询价 / 合作 AI 自动接待
                </button>
                <button
                  type="button"
                  className="dock-mini-chip"
                  onClick={() => openPresetRule("vacation")}
                >
                  🏖️ 休假 / 外出模板秒回
                </button>
                <button
                  type="button"
                  className="dock-mini-chip"
                  onClick={() => openPresetRule("support")}
                >
                  🛠️ 售后反馈自动确认
                </button>
              </div>

              {/* 新建 / 编辑规则表单 */}
              {ruleForm && (
                <div className="auto-rule-editor">
                  <div className="auto-rule-editor-head">
                    <strong>
                      {(policy.auto_rules || []).some((r) => r.id === ruleForm.id)
                        ? `编辑规则：${ruleForm.name || ruleForm.id}`
                        : "新建自动化回复规则"}
                    </strong>
                    <button
                      type="button"
                      className="ghost-btn compact-btn"
                      onClick={() => setRuleForm(null)}
                    >
                      <IconClose size={13} />
                      <span>取消</span>
                    </button>
                  </div>

                  <div className="policy-two-cols">
                    <div className="policy-field">
                      <label>规则名称</label>
                      <input
                        placeholder="如：商务报价自动接待 / 春节休假自动回复"
                        value={ruleForm.name}
                        onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
                      />
                    </div>
                    <div className="policy-field">
                      <label>回复生成方式</label>
                      <select
                        value={ruleForm.mode}
                        onChange={(e) =>
                          setRuleForm({
                            ...ruleForm,
                            mode: e.target.value === "template" ? "template" : "ai",
                          })
                        }
                      >
                        <option value="ai">AI 动态生成回复（仅读本地脱敏后正文）</option>
                        <option value="template">固定文案 / HTML 模板秒回（零大模型调用）</option>
                      </select>
                    </div>
                  </div>

                  {availableAccountChoices.length > 0 && (
                    <div className="policy-field">
                      <label>生效邮箱范围（不勾选代表对所有已授权邮箱生效）</label>
                      <div className="auto-rule-acc-checks">
                        {availableAccountChoices.map((acc) => {
                          const checked = ruleForm.accounts.some(
                            (a) => a.toLowerCase() === acc.email,
                          );
                          return (
                            <label key={acc.email} className="auto-rule-acc-pill">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? ruleForm.accounts.filter(
                                        (a) => a.toLowerCase() !== acc.email,
                                      )
                                    : [...ruleForm.accounts, acc.email];
                                  setRuleForm({ ...ruleForm, accounts: next });
                                }}
                              />
                              <span>{acc.email}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="policy-two-cols">
                    <div className="policy-field">
                      <label>匹配发件人邮箱（可选，逗号分隔）</label>
                      <input
                        placeholder="vip@partner.com（留空则不限特定邮箱）"
                        value={ruleForm.matchSendersText}
                        onChange={(e) =>
                          setRuleForm({ ...ruleForm, matchSendersText: e.target.value })
                        }
                      />
                    </div>
                    <div className="policy-field">
                      <label>匹配发件人域名（可选，逗号分隔）</label>
                      <input
                        placeholder="client.com, partner.org"
                        value={ruleForm.matchDomainsText}
                        onChange={(e) =>
                          setRuleForm({ ...ruleForm, matchDomainsText: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="policy-field">
                    <label>
                      匹配主题或正文关键词（逗号分隔；若发件人/域名/关键词全留空，则作为全量休假自动回复生效）
                    </label>
                    <input
                      placeholder="报价, 合作, 咨询, 预约演示"
                      value={ruleForm.matchKeywordsText}
                      onChange={(e) =>
                        setRuleForm({ ...ruleForm, matchKeywordsText: e.target.value })
                      }
                    />
                  </div>

                  <div className="policy-field">
                    <label>
                      {ruleForm.mode === "ai"
                        ? "AI 回复要求与话术规范"
                        : "固定回复纯文本内容"}
                    </label>
                    <textarea
                      rows={3}
                      value={ruleForm.instructionsOrTemplate}
                      onChange={(e) =>
                        setRuleForm({
                          ...ruleForm,
                          instructionsOrTemplate: e.target.value,
                        })
                      }
                    />
                  </div>

                  {ruleForm.mode === "template" && (
                    <div className="policy-field">
                      <label>可选：固定 HTML 富文本模板（留空则发送纯文本）</label>
                      <textarea
                        rows={3}
                        placeholder='<div style="padding:16px;border-radius:10px;border:1px solid #e2e8f0;">您好，已收到您的来信…</div>'
                        value={ruleForm.templateHtml}
                        onChange={(e) =>
                          setRuleForm({ ...ruleForm, templateHtml: e.target.value })
                        }
                      />
                    </div>
                  )}

                  <div className="policy-two-cols">
                    <div className="policy-field">
                      <label>发信执行动作</label>
                      <select
                        value={ruleForm.requireReview ? "review" : "auto"}
                        onChange={(e) =>
                          setRuleForm({
                            ...ruleForm,
                            requireReview: e.target.value === "review",
                          })
                        }
                      >
                        <option value="auto">满足条件并校验安全后直接自动发出</option>
                        <option value="review">仅自动生成回复草稿，放入待审队列由我确认</option>
                      </select>
                    </div>

                    <div className="policy-field">
                      <label>同一发件人防循环冷却间隔（分钟，5 ~ 10080）</label>
                      <input
                        type="number"
                        min={5}
                        max={10080}
                        value={ruleForm.cooldownMinutes}
                        onChange={(e) =>
                          setRuleForm({
                            ...ruleForm,
                            cooldownMinutes: Number(e.target.value) || 60,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="auto-rule-editor-foot">
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setRuleForm(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn primary small"
                      disabled={savingRule}
                      onClick={() => void handleSaveRuleForm()}
                    >
                      <IconCheck size={13} />
                      <span>{savingRule ? "保存中…" : "保存并启用规则"}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* 已配置规则列表 */}
              {(policy.auto_rules || []).length === 0 ? (
                <div className="policy-empty-hint">
                  当前尚未配置自动化回复规则。可点击上方场景模板一键创建，或对右侧 AI 助手说：「新增自动回复规则：包含报价咨询的邮件自动礼貌回复」。
                </div>
              ) : (
                <div className="auto-rules-list">
                  {(policy.auto_rules || []).map((rule) => {
                    const hasCond =
                      rule.match_senders.length > 0 ||
                      rule.match_domains.length > 0 ||
                      rule.match_keywords.length > 0;
                    return (
                      <div
                        key={rule.id}
                        className={`auto-rule-card ${rule.enabled ? "enabled" : "paused"}`}
                      >
                        <div className="auto-rule-card-top">
                          <div className="auto-rule-title-row">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={() => void handleToggleRule(rule)}
                              title="启用或暂停此规则"
                            />
                            <strong className="auto-rule-name">{rule.name}</strong>
                            <span
                              className={`reply-mini-badge ${rule.mode === "template" ? "info" : "ok"}`}
                            >
                              {rule.mode === "template" ? "固定模板秒回" : "AI 动态回复"}
                            </span>
                            <span
                              className={`reply-mini-badge ${rule.require_review ? "state-pending_review" : "state-auto_sent"}`}
                            >
                              {rule.require_review ? "人工确认后发" : "⚡ 自动直接发出"}
                            </span>
                            <span className="reply-mini-badge">
                              冷却 {rule.cooldown_minutes} 分钟
                            </span>
                          </div>

                          <div className="auto-rule-card-btns">
                            <button
                              type="button"
                              className="ghost-btn compact-btn"
                              onClick={() => setRuleForm(ruleToForm(rule))}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="ghost-btn compact-btn danger-text"
                              onClick={() => void handleDeleteRule(rule)}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        </div>

                        <div className="auto-rule-triggers">
                          {rule.accounts.length > 0 ? (
                            <span className="auto-trigger-chip">
                              邮箱: {rule.accounts.join(", ")}
                            </span>
                          ) : (
                            <span className="auto-trigger-chip">邮箱: 全部已授权邮箱</span>
                          )}
                          {rule.match_senders.length > 0 && (
                            <span className="auto-trigger-chip">
                              发件人: {rule.match_senders.join(", ")}
                            </span>
                          )}
                          {rule.match_domains.length > 0 && (
                            <span className="auto-trigger-chip">
                              域名: {rule.match_domains.join(", ")}
                            </span>
                          )}
                          {rule.match_keywords.length > 0 && (
                            <span className="auto-trigger-chip">
                              关键词: {rule.match_keywords.join(", ")}
                            </span>
                          )}
                          {!hasCond && (
                            <span className="auto-trigger-chip warn">
                              全量准入来信触发（休假外出模式）
                            </span>
                          )}
                        </div>

                        <div className="auto-rule-instruction">
                          {rule.instructions_or_template}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* ==================== Tab 3: 隐私与权限边界配置 ==================== */}
      {tab === "policy" && (
        <div className="reply-policy-scroll">
          <div className="reply-policy-grid">
            <section className="policy-card">
              <div className="policy-card-head">
                <div>
                  <h3>1. 邮箱与邮件读取边界（哪些邮件允许被 Agent 读取）</h3>
                  <p>
                    采用零信任默认拒绝机制：未勾选的私人邮箱在数据库查询层直接隔离；拦截箱、系统免回复邮件与验证码/账单邮件在读取正文前即跳过。
                  </p>
                </div>
                <label className="policy-switch">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={(e) => updatePolicyField("enabled", e.target.checked)}
                  />
                  <span>启用统一批复引擎</span>
                </label>
              </div>

              <div className="policy-account-matrix">
                {availableAccountChoices.length === 0 ? (
                  <div className="policy-empty-hint">
                    当前尚未绑定任何邮箱账号。请先通过设置或右侧 AI 助手接入邮箱。
                  </div>
                ) : (
                  availableAccountChoices.map((acc) => {
                    const authorized = policy.enabled_accounts.some(
                      (x) => x.toLowerCase() === acc.email,
                    );
                    return (
                      <label
                        key={acc.email}
                        className={`policy-account-tile ${authorized ? "authorized" : "isolated"}`}
                      >
                        <input
                          type="checkbox"
                          checked={authorized}
                          onChange={() => toggleAuthorizedAccount(acc.email)}
                        />
                        <div className="policy-account-info">
                          <strong>{acc.label}</strong>
                          <span>
                            {authorized
                              ? "已授权读取未回人工来信"
                              : "严格物理隔离（Agent 不可见）"}
                          </span>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>

              <div className="policy-checks-row">
                <label className="policy-check-item">
                  <input
                    type="checkbox"
                    checked={policy.auto_scan_on_sync}
                    onChange={(e) => updatePolicyField("auto_scan_on_sync", e.target.checked)}
                  />
                  <span>每次 IMAP 收信同步后后台自动扫描并执行自动回复规则</span>
                </label>
                <label className="policy-check-item">
                  <input
                    type="checkbox"
                    checked={policy.skip_sensitive_mails}
                    onChange={(e) => updatePolicyField("skip_sensitive_mails", e.target.checked)}
                  />
                  <span>自动跳过验证码 / 密码重置 / 银行账单 / 保密函件（推荐必开）</span>
                </label>
              </div>

              <div className="policy-two-cols">
                <div className="policy-field">
                  <label>发件人读取范围模式</label>
                  <select
                    value={policy.sender_filter_mode}
                    onChange={(e) => updatePolicyField("sender_filter_mode", e.target.value)}
                  >
                    <option value="all_allowed">
                      允许所有人工来信（排除下方黑名单与敏感词）
                    </option>
                    <option value="whitelist_only">
                      严格白名单模式（仅读取白名单邮箱/域名的来信）
                    </option>
                  </select>
                </div>

                <div className="policy-field">
                  <label>单封邮件入模最大字符截断（200 ~ 8000）</label>
                  <input
                    type="number"
                    min={200}
                    max={8000}
                    step={100}
                    value={policy.max_context_chars}
                    onChange={(e) =>
                      updatePolicyField("max_context_chars", Number(e.target.value) || 1600)
                    }
                  />
                </div>
              </div>

              {policy.sender_filter_mode === "whitelist_only" && (
                <div className="policy-two-cols">
                  <div className="policy-field">
                    <label>允许读取的发件人白名单</label>
                    <input
                      placeholder="partner@company.com, vip@client.org"
                      value={allowSendersText}
                      onChange={(e) => {
                        setAllowSendersText(e.target.value);
                        setPolicyDirty(true);
                      }}
                    />
                  </div>
                  <div className="policy-field">
                    <label>允许读取的发件人域名白名单</label>
                    <input
                      placeholder="company.com, client.org"
                      value={allowDomainsText}
                      onChange={(e) => {
                        setAllowDomainsText(e.target.value);
                        setPolicyDirty(true);
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="policy-two-cols">
                <div className="policy-field">
                  <label>禁止读取的发件人黑名单</label>
                  <input
                    placeholder="hr-confidential@corp.com, bank@notice.com"
                    value={excludeSendersText}
                    onChange={(e) => {
                      setExcludeSendersText(e.target.value);
                      setPolicyDirty(true);
                    }}
                  />
                </div>
                <div className="policy-field">
                  <label>禁止读取的主题/正文隐私关键词</label>
                  <input
                    placeholder="薪资单, 体检报告, 股权协议"
                    value={excludeKeywordsText}
                    onChange={(e) => {
                      setExcludeKeywordsText(e.target.value);
                      setPolicyDirty(true);
                    }}
                  />
                </div>
              </div>
            </section>

            <section className="policy-card">
              <div className="policy-card-head">
                <div>
                  <h3>2. 邮件内容隐私保护（入模前本地 PII 与密钥盲脱敏）</h3>
                  <p>
                    在任何文本离开本机发往云端大模型前，自动将手机号、身份证号、银行卡号、API Key 及自定义敏感词替换为占位符，且不保存明文映射。
                  </p>
                </div>
                <label className="policy-switch">
                  <input
                    type="checkbox"
                    checked={policy.redact_pii}
                    onChange={(e) => updatePolicyField("redact_pii", e.target.checked)}
                  />
                  <span>开启入模 PII 脱敏</span>
                </label>
              </div>

              <div className="policy-field">
                <label>自定义内部保密词脱敏列表（项目代号、客户真名、内部价格等）</label>
                <input
                  placeholder="Project-Titan, 内部底价, 核心客户名"
                  value={customRedactText}
                  onChange={(e) => {
                    setCustomRedactText(e.target.value);
                    setPolicyDirty(true);
                  }}
                />
              </div>

              <div className="policy-scrub-tester">
                <div className="policy-scrub-tester-head">
                  <span>本地脱敏效果实时验证器</span>
                  <button type="button" className="btn ghost small" onClick={runLiveScrubTest}>
                    测试脱敏效果
                  </button>
                </div>
                <div className="policy-two-cols">
                  <textarea
                    rows={3}
                    value={scrubSample}
                    onChange={(e) => setScrubSample(e.target.value)}
                  />
                  <div className="policy-scrub-result">
                    {scrubPreview ? scrubPreview.scrubbed : "点击「测试脱敏效果」查看结果…"}
                  </div>
                </div>
              </div>
            </section>

            <section className="policy-card">
              <div className="policy-card-head">
                <div>
                  <h3>3. 发信权限与出站安全守卫</h3>
                  <p>
                    除「自动化回复规则」明确授权的规则外，其余邮件默认仅生成待审草稿；也可为固定可信发件人开启白名单自动发信。
                  </p>
                </div>
                <label className="policy-switch">
                  <input
                    type="checkbox"
                    checked={policy.auto_send_enabled}
                    onChange={(e) => updatePolicyField("auto_send_enabled", e.target.checked)}
                  />
                  <span>启用可信白名单自动发信</span>
                </label>
              </div>

              <div className="policy-checks-row">
                <label className="policy-check-item">
                  <input
                    type="checkbox"
                    checked={policy.outbound_dlp_guard}
                    onChange={(e) => updatePolicyField("outbound_dlp_guard", e.target.checked)}
                  />
                  <span>开启出站 DLP 泄露守卫（拦截残留占位符与高危密钥外发）</span>
                </label>
              </div>

              {policy.auto_send_enabled && (
                <div className="policy-two-cols">
                  <div className="policy-field">
                    <label>允许直接自动回复的发件人白名单</label>
                    <input
                      placeholder="colleague@team.com"
                      value={autoSendSendersText}
                      onChange={(e) => {
                        setAutoSendSendersText(e.target.value);
                        setPolicyDirty(true);
                      }}
                    />
                  </div>
                  <div className="policy-field">
                    <label>允许直接自动回复的域名白名单</label>
                    <input
                      placeholder="internal-team.com"
                      value={autoSendDomainsText}
                      onChange={(e) => {
                        setAutoSendDomainsText(e.target.value);
                        setPolicyDirty(true);
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="policy-two-cols">
                <div className="policy-field">
                  <label>每小时自动发信速率上限（防异常循环，1 ~ 120 封/小时）</label>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={policy.auto_send_hourly_limit}
                    onChange={(e) =>
                      updatePolicyField("auto_send_hourly_limit", Number(e.target.value) || 10)
                    }
                  />
                </div>
                <div className="policy-field">
                  <label>全局回复语气与人设指令</label>
                  <input
                    value={policy.persona_instructions}
                    onChange={(e) => updatePolicyField("persona_instructions", e.target.value)}
                  />
                </div>
              </div>

              <div className="policy-save-bar">
                <span>
                  所有配置将同步写入声明式 <code>config.toml [reply_policy]</code>
                </span>
                <button
                  type="button"
                  className="btn primary"
                  disabled={savingPolicy}
                  onClick={() => void handleSavePolicy()}
                >
                  <IconSliders size={14} />
                  <span>{savingPolicy ? "保存中…" : "保存隐私与权限策略"}</span>
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
