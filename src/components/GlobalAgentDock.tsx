import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ComposeAgentBridge,
  ComposeLaunchIntent,
  KernelClientEffect,
  KernelWorkspaceContext,
  ReplyAgentBridge,
} from "../types";
import { AgentKernelPane, type KernelStarterCard } from "./AgentKernelPane";
import {
  IconCompose,
  IconReplyHub,
  IconShield,
  IconSliders,
} from "./Icons";
import type { SettingsTab } from "./Settings";

export type DockActiveView =
  | "inbox"
  | "archived"
  | "blocked"
  | "compose"
  | "reply_hub"
  | "assistant"
  | "settings";

export interface GlobalAgentDockProps {
  expanded: boolean;
  onToggle: (next: boolean) => void;
  activeView: DockActiveView;
  activeAccountEmail?: string;
  /** 当前选中的会话 peer（单聊邮箱或 `group:*` 群聊标识） */
  focusedPeer?: string | null;
  focusedPeerName?: string | null;
  composeBridge: ComposeAgentBridge | null;
  replyBridge: ReplyAgentBridge | null;
  externalPromptRequest: { seq: number; prompt: string; autoSend?: boolean } | null;
  notify: (text: string, isError?: boolean) => void;
  onDataChanged: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onSwitchView: (view: DockActiveView) => void;
  onOpenComposeWithPeer?: (peerEmail: string, peerName?: string | null) => void;
  /** 当邮件实例在非写信页调用 `write_compose_email` 时，自动跳转至写信画布并填入生成的主题/正文/HTML */
  onOpenComposeFromAgent?: (intent: Omit<ComposeLaunchIntent, "id">) => void;
  /** 当邮件实例调用 `draft_quick_chat_reply` 时，将起草的回复直接填入会话底部输入框 */
  onApplyChatDraft?: (peer: string, text: string) => void;
}

const COMPOSE_STARTERS: KernelStarterCard[] = [
  {
    title: "商务卡片 HTML 排版",
    desc: "将当前信件排版为现代清爽的内联样式商务卡片 HTML 邮件",
    text: "把当前信件排版成清爽现代的商务卡片 HTML 邮件",
  },
  {
    title: "项目周报与指标表",
    desc: "生成包含关键进展与结构化数据表格的 HTML 周报邮件",
    text: "帮我写一封带关键指标表格与下周计划的项目周报 HTML 邮件",
  },
  {
    title: "会议邀请函卡片",
    desc: "生成带时间地点、议程表与回复确认提示的 HTML 邀请函",
    text: "生成一封带时间地点、议程表与参会确认提示的会议邀请 HTML 邮件",
  },
  {
    title: "得体纯文本润色",
    desc: "保持纯文本格式，把语气润色得自然、简洁、专业",
    text: "保持纯文本格式，帮我把当前邮件草稿润色得更自然、简洁、得体",
  },
  {
    title: "中英双语商务沟通",
    desc: "整理为上中下英对照的正式跨国合作邮件",
    text: "帮我把这封邮件整理为上中下英双语对照的正式商务邮件",
  },
  {
    title: "委婉跟进催办",
    desc: "礼貌询问合作推进或审批进度，清晰推进节奏而不显生硬",
    text: "帮我写一封礼貌跟进合作进展的邮件，语气真诚专业",
  },
];

/**
 * 全局右侧可伸缩智能体外挂坞（`GlobalAgentDock`）：
 * - 底层挂载统一智能体内核 `AgentKernelPane` 的 **`instanceId="mail"`（邮件处理实例）**；
 * - 与左侧「助手」页的 **`instanceId="config"`（配置实例）** 共享同一套推理、流式、工具循环与凭据保险箱内核，
 *   但拥有完全独立的会话命名空间（`agm-*`）、可独立切换且不污染 `config.toml` 的激活模型（`kv["mail_agent_config"]`），
 *   以及专用于邮件创作、脱敏会话阅读、快捷回复、统一批复草稿精修与自动回复规则编排的工具能力集。
 */
export function GlobalAgentDock({
  expanded,
  onToggle,
  activeView,
  activeAccountEmail,
  focusedPeer,
  focusedPeerName,
  composeBridge,
  replyBridge,
  externalPromptRequest,
  notify,
  onDataChanged,
  onOpenSettings,
  onSwitchView,
  onOpenComposeWithPeer,
  onOpenComposeFromAgent,
  onApplyChatDraft,
}: GlobalAgentDockProps) {
  const [localPromptReq, setLocalPromptReq] = useState<{
    seq: number;
    prompt: string;
    autoSend?: boolean;
  } | null>(null);

  const composeBridgeRef = useRef(composeBridge);
  composeBridgeRef.current = composeBridge;
  const replyBridgeRef = useRef(replyBridge);
  replyBridgeRef.current = replyBridge;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  const triggerLocalPrompt = useCallback((prompt: string, autoSend = true) => {
    setLocalPromptReq((prev) => ({
      seq: (prev?.seq ?? 100000) + 1,
      prompt,
      autoSend,
    }));
  }, []);

  // 合并来自外部工作区按钮（如写信页「AI 润色」）与外挂面板内快捷按钮的请求
  const mergedPromptRequest = useMemo(() => {
    if (!externalPromptRequest) return localPromptReq;
    if (!localPromptReq) return externalPromptRequest;
    return externalPromptRequest.seq >= localPromptReq.seq - 100000
      ? externalPromptRequest
      : localPromptReq;
  }, [externalPromptRequest, localPromptReq]);

  // 实时注入当前宿主页面上下文至后端 `mail` 实例内核（零前端关键词猜测路由，完全由内核工具按上下文精确执行）
  const workspaceContext = useMemo<KernelWorkspaceContext>(
    () => ({
      view: activeView,
      active_account_email: activeAccountEmail ?? "",
      focused_peer: focusedPeer ?? null,
      compose_draft: composeBridge
        ? {
            sender_identity: composeBridge.senderIdentity,
            to: composeBridge.to,
            cc: composeBridge.cc,
            subject: composeBridge.subject,
            body_plain: composeBridge.bodyPlain,
            body_html: composeBridge.bodyHtml,
            reply_context: composeBridge.replyContext,
          }
        : null,
      selected_reply_id: replyBridge?.selectedItem?.id ?? null,
    }),
    [activeView, activeAccountEmail, composeBridge, focusedPeer, replyBridge?.selectedItem?.id],
  );

  const handleStreamPreviewHtml = useCallback((html: string) => {
    if (activeViewRef.current === "compose") {
      composeBridgeRef.current?.onStreamHtml(html);
    } else if (activeViewRef.current === "reply_hub") {
      replyBridgeRef.current?.onStreamHtml(html);
    }
  }, []);

  const handleKernelEffects = useCallback(
    (effects: KernelClientEffect[]) => {
      for (const eff of effects) {
        switch (eff.type) {
          case "compose_draft_updated": {
            const bridge = composeBridgeRef.current;
            if (activeViewRef.current === "compose" && bridge) {
              bridge.onApplyResult({
                reply: "",
                thinking: "",
                thinking_ms: 0,
                suggested_subject: eff.subject ?? null,
                suggested_html: eff.html ?? null,
                suggested_plain: eff.plain ?? null,
                redaction_count: eff.redaction_count,
                redactions: [],
                used_offline_fallback: false,
              });
            } else if (eff.open_compose && onOpenComposeFromAgent) {
              onOpenComposeFromAgent({
                to: eff.to && eff.to.length > 0 ? eff.to : undefined,
                subject: eff.subject ?? "",
                bodyPlain: eff.plain ?? "",
                bodyHtml: eff.html ?? undefined,
              });
            }
            break;
          }
          case "reply_queue_item_updated": {
            replyBridgeRef.current?.onItemUpdated(eff.item);
            replyBridgeRef.current?.onPolicyOrQueueChanged();
            break;
          }
          case "reply_scan_completed": {
            replyBridgeRef.current?.onPolicyOrQueueChanged();
            onDataChanged();
            break;
          }
          case "chat_draft_suggested":
          case "chat_draft_updated": {
            onApplyChatDraft?.(eff.peer, eff.text);
            notify("已将 AI 拟好的回复填入当前会话输入框，确认后即可发送");
            break;
          }
          default:
            break;
        }
      }
    },
    [notify, onApplyChatDraft, onDataChanged, onOpenComposeFromAgent],
  );

  // 根据当前所在宿主页面动态展示专属邮件上下文徽章、引导卡片与状态条（共享同一个持久化 `mail` 实例会话）
  const contextViewMeta = useMemo(() => {
    if (activeView === "compose") {
      return {
        title: "邮件智能体",
        badge: "实例: mail · 写信联动",
        subtitle: "统一内核 · 独立邮件实例 · 撰写纯文本与内联 HTML 邮件（入模盲脱敏）",
        placeholder:
          "输入写信或排版需求，如：把草稿排版成商务卡片 HTML / 写一封带表格的项目周报…",
        emptyHeading: "写信与 HTML 排版助手",
        thinkingLabel: "信件撰写与排版",
        starters: COMPOSE_STARTERS,
        emptyDescription: (
          <p>
            运行于独立的 <code>mail</code> 智能体实例，与左侧信纸实时联动：可起草<strong>纯文本信函</strong>
            或流式生成内联样式 <code>HTML</code> 邮件，本地 PII 占位符出模后自动在本地安全还原。
          </p>
        ),
        emptyScopeBanner: composeBridge ? (
          <div className="agent-scope-strip">
            <span className="agent-scope-strip-text">
              隐私护栏：信件草稿与引用原文入模前
              <strong>{composeBridge.redactPii ? "自动执行本地 PII 盲脱敏" : "当前未开启脱敏"}</strong>
            </span>
            <button
              type="button"
              className="agent-scope-link"
              onClick={() => composeBridge.onToggleRedactPii(!composeBridge.redactPii)}
              title="切换入模前手机号/身份证/卡号/密钥本地盲脱敏开关"
            >
              <IconShield size={12} />
              <span>{composeBridge.redactPii ? "入模脱敏：已开启" : "开启入模脱敏"}</span>
            </button>
          </div>
        ) : null,
      };
    }

    if (activeView === "reply_hub") {
      const sel = replyBridge?.selectedItem;
      const starters: KernelStarterCard[] = sel
        ? [
            {
              title: "精简当前待审回复",
              desc: `基于脱敏摘要把对 ${sel.sender_addr} 的回复改得更简练得体`,
              text: "把当前选中的待审回复草稿改得更简短礼貌一些",
            },
            {
              title: "转为商务 HTML 回复",
              desc: "将当前选中的回复草稿排版为现代清爽的内联样式 HTML 卡片",
              text: "把当前选中的待审回复草稿排版成清爽的商务卡片 HTML 邮件",
            },
            {
              title: "为此发件人建自动回复",
              desc: `收到 ${sel.sender_addr} 来信时自动礼貌回复并带冷却防循环`,
              text: `新增一条自动化回复规则：收到来自 ${sel.sender_addr} 的邮件时，由 AI 自动礼貌回复已收到并尽快跟进`,
            },
            {
              title: "查看待审队列概览",
              desc: "读取当前已脱敏的待回复队列与外发 DLP 检查状态",
              text: "列出当前待审核的邮件回复队列概览",
            },
            {
              title: "开启休假模板秒回",
              desc: "创建固定模板自动回复规则，告知外出状态与后续处理时间",
              text: "新增一条休假外出固定模板自动回复规则，告知来信人我目前外出中，归来后第一时间回复",
            },
            {
              title: "立即扫描授权邮箱",
              desc: "按隐私授权范围扫描待回邮件并执行已启用的自动化规则",
              text: "立即扫描已授权邮箱里的待回复邮件并执行自动化规则",
            },
          ]
        : [
            {
              title: "查看待审队列概览",
              desc: "按脱敏视图列出当前待人工确认的统一批复草稿",
              text: "列出当前待审核的邮件回复队列概览",
            },
            {
              title: "询价合作自动接待",
              desc: "当来信含「报价 / 合作 / 咨询」时由 AI 自动起草或礼貌回复",
              text: "新增一条自动化回复规则：当邮件包含「报价」「合作」「咨询」时，自动用 AI 礼貌回复已收到需求并安排对接",
            },
            {
              title: "开启休假自动回复",
              desc: "新增固定模板自动秒回规则，自动附带冷却与防死循环保护",
              text: "新增一条休假外出固定模板自动回复规则，告知对方我目前休假中，归来后第一时间处理",
            },
            {
              title: "立即扫描待回邮件",
              desc: "在已授权邮箱范围内执行隐私脱敏扫描并生成待审草稿",
              text: "立即扫描已授权邮箱里的待回复邮件并执行自动化规则",
            },
            {
              title: "查看当前自动化规则",
              desc: "列出所有已配置的 [[reply_policy.auto_rules]] 自动回复规则",
              text: "查看我当前所有的邮件自动化回复规则状态",
            },
            {
              title: "为指定域名设自动跟进",
              desc: "针对特定合作域名配置专属自动回复指令",
              text: "帮我新增一条针对特定发件人或域名的自动化回复规则：",
            },
          ];

      return {
        title: "邮件智能体",
        badge: sel ? `实例: mail · 草稿 #${sel.id}` : "实例: mail · 统一批复",
        subtitle: sel
          ? `聚焦 ${sel.sender_addr} 脱敏草稿 · 独立邮件实例 · 零明文入模`
          : "统一内核 · 独立邮件实例 · 脱敏草稿精修与自动化回复规则",
        placeholder: sel
          ? `改写对 ${sel.sender_addr} 的回复草稿，或管理自动化回复规则…`
          : "输入批复草稿指令或自动化回复规则需求…",
        emptyHeading: "统一批复与自动化回复智能体",
        thinkingLabel: "邮件批复与自动化",
        starters,
        emptyDescription: sel ? (
          <p>
            当前已绑定来自 <code>{sel.sender_addr}</code> 的待审草稿（全程仅向大模型暴露本地盲脱敏后的安全文本），
            可直接对话精修语气、转为 <code>HTML</code> 或编排自动化规则。
          </p>
        ) : (
          <p>
            运行于独立的 <code>mail</code> 智能体实例：选中左侧待审草稿即可对话精修，或直接用自然语言创建、启停与扫描
            <strong>邮件自动化回复规则</strong>。
          </p>
        ),
        emptyScopeBanner: (
          <div className="agent-scope-strip">
            <span className="agent-scope-strip-text">
              {sel ? (
                <>
                  当前聚焦草稿：<strong>{sel.sender_addr}</strong>（原文敏感信息已在本地剥离）
                </>
              ) : (
                <>
                  隐私边界：仅访问<strong>已授权邮箱范围</strong>且全程执行入模盲脱敏与外发 DLP 检查
                </>
              )}
            </span>
            <button
              type="button"
              className="agent-scope-link"
              onClick={() =>
                triggerLocalPrompt("立即扫描已授权邮箱里的待回复邮件并执行自动化规则", true)
              }
            >
              <IconReplyHub size={12} />
              <span>立即扫描待回</span>
            </button>
          </div>
        ),
      };
    }

    const isDirectPeer = Boolean(focusedPeer && !focusedPeer.startsWith("group:"));
    const displayPeer = focusedPeerName || focusedPeer || "";
    const isBlockedView = activeView === "blocked";

    const starters: KernelStarterCard[] = focusedPeer
      ? [
          {
            title: "脱敏总结当前会话",
            desc: isBlockedView
              ? "拦截箱邮件默认禁止读取正文以防恶意 Prompt 注入"
              : `在本地剥离敏感信息后提炼与 ${displayPeer} 的核心结论与待办`,
            text: "帮我总结当前打开的邮件会话重点与待办事项",
          },
          {
            title: "起草快捷聊天回复",
            desc: "生成自然得体的简短回复并直接填入会话底部输入框",
            text: "结合当前会话上下文，帮我起草一段简短礼貌的确认回复填入输入框",
          },
          {
            title: "撰写正式 HTML 邮件",
            desc: "切换至写信画布并生成结构化内联样式 HTML 商务信函",
            text: isDirectPeer
              ? `给 ${focusedPeer} 写一封排版清爽的商务跟进 HTML 邮件`
              : "帮我写一封带结构化要点的项目进展 HTML 邮件并打开写信页",
          },
          {
            title: "为此联系人设自动回复",
            desc: "当收到该发件人来信时自动起草或按冷却规则礼貌回复",
            text: isDirectPeer
              ? `新增一条自动化回复规则：收到来自 ${focusedPeer} 的邮件时，由 AI 自动礼貌回复已收到并尽快跟进`
              : "新增一条针对合作咨询关键词的邮件自动化回复规则",
          },
          {
            title: "查看待审批复队列",
            desc: "列出当前统一批复中心里待人工确认的脱敏回复草稿",
            text: "列出当前待审核的邮件回复队列概览",
          },
          {
            title: "立即扫描待回邮件",
            desc: "按隐私授权范围扫描新来信并执行自动化回复规则",
            text: "立即扫描已授权邮箱里的待回复邮件并执行自动化规则",
          },
        ]
      : [
          {
            title: "起草 HTML 周报邮件",
            desc: "直接生成带指标表格的 HTML 邮件并自动打开写信画布",
            text: "帮我写一封带关键指标表格与下周计划的项目周报 HTML 邮件",
          },
          {
            title: "起草商务合作信函",
            desc: "生成得体专业的合作沟通邮件并填入写信页预览",
            text: "帮我起草一封礼貌跟进合作进展的商务邮件",
          },
          {
            title: "查看待审批复队列",
            desc: "列出统一批复中心内已脱敏的待回复邮件草稿",
            text: "列出当前待审核的邮件回复队列概览",
          },
          {
            title: "创建询价自动回复",
            desc: "当来信含「报价 / 合作 / 咨询」时自动触发 AI 礼貌接待",
            text: "新增一条自动化回复规则：包含「报价」「咨询」的邮件由 AI 自动礼貌回复已收到",
          },
          {
            title: "开启休假模板秒回",
            desc: "创建带冷却防循环保护的固定模板自动回复规则",
            text: "新增一条休假外出固定模板自动回复规则，告知对方归来后第一时间处理",
          },
          {
            title: "立即扫描待回邮件",
            desc: "在已授权邮箱范围内执行脱敏扫描与自动回复",
            text: "立即扫描已授权邮箱里的待回复邮件并执行自动化规则",
          },
        ];

    const badgeText = displayPeer
      ? `实例: mail · ${displayPeer}`
      : activeView === "archived"
        ? "实例: mail · 通知栏"
        : activeView === "blocked"
          ? "实例: mail · 拦截隔离"
          : "实例: mail · 邮件实例";

    return {
      title: "邮件智能体",
      badge: badgeText,
      subtitle: displayPeer
        ? `聚焦会话 ${displayPeer} · 独立邮件实例 · 脱敏阅读与起草`
        : "统一内核 · 独立邮件实例 · 写信排版 / 会话总结 / 统一批复 / 自动规则",
      placeholder: displayPeer
        ? `针对 ${displayPeer} 总结会话、起草回复、写 HTML 邮件或设自动回复…`
        : "输入邮件处理需求，如：写周报 HTML 邮件 / 查看待审回复 / 新增自动回复规则…",
      emptyHeading: displayPeer ? `邮件智能体 · ${displayPeer}` : "邮件处理智能体",
      thinkingLabel: "邮件处理与起草",
      starters,
      emptyDescription: displayPeer ? (
        <p>
          已感知当前会话 <code>{displayPeer}</code>：可在本地脱敏前提下总结上下文、起草快捷回复填入底部输入框，
          或一键跳转写信画布排版 <code>HTML</code> 邮件。
        </p>
      ) : (
        <p>
          与左侧「配置助手」同属一个智能体内核，但作为<strong>独立的邮件实例（<code>mail</code>）</strong>运行：
          拥有独立的会话历史、可单独切换的模型配置，以及受隐私脱敏护栏保护的邮件工具集。
        </p>
      ),
      emptyScopeBanner:
        isDirectPeer && focusedPeer && onOpenComposeWithPeer ? (
          <div className="agent-scope-strip">
            <span className="agent-scope-strip-text">
              当前会话对象：<strong>{focusedPeer}</strong>（入模自动盲脱敏）
            </span>
            <button
              type="button"
              className="agent-scope-link"
              onClick={() => onOpenComposeWithPeer(focusedPeer, focusedPeerName)}
            >
              <IconCompose size={12} />
              <span>去写信页写 HTML 邮件</span>
            </button>
          </div>
        ) : (
          <div className="agent-scope-strip">
            <span className="agent-scope-strip-text">
              实例职责：本面板仅运行 <code>mail</code> 实例处理邮件；修改账号、主题或 <code>config.toml</code> 请前往配置实例
            </span>
            <button
              type="button"
              className="agent-scope-link"
              onClick={() => onSwitchView("assistant")}
            >
              <IconSliders size={12} />
              <span>打开配置助手实例</span>
            </button>
          </div>
        ),
    };
  }, [
    activeView,
    composeBridge,
    focusedPeer,
    focusedPeerName,
    onOpenComposeWithPeer,
    onSwitchView,
    replyBridge?.selectedItem,
    triggerLocalPrompt,
  ]);

  // 在收起态或左侧「助手」独立工作台激活时，不在 .app-body 右侧渲染任何占位节点，保持主工作区卡片边缘 100% 对称贴齐
  if (activeView === "assistant" || !expanded) {
    return null;
  }

  return (
    <AgentKernelPane
      instanceId="mail"
      variant="outrigger"
      activeAccountEmail={activeAccountEmail}
      workspaceContext={workspaceContext}
      headerTitleOverride={contextViewMeta.title}
      headerBadgeOverride={contextViewMeta.badge}
      headerSubtitleOverride={contextViewMeta.subtitle}
      placeholderOverride={contextViewMeta.placeholder}
      thinkingContextLabel={contextViewMeta.thinkingLabel}
      starterCards={contextViewMeta.starters}
      emptyHeading={contextViewMeta.emptyHeading}
      emptyDescription={contextViewMeta.emptyDescription}
      emptyScopeBanner={contextViewMeta.emptyScopeBanner}
      externalPromptRequest={mergedPromptRequest}
      onCollapse={() => onToggle(false)}
      onStreamPreviewHtml={handleStreamPreviewHtml}
      onKernelEffects={handleKernelEffects}
      onOpenSettings={(tab) => onOpenSettings(tab)}
      onDataChanged={onDataChanged}
      notify={notify}
    />
  );
}
