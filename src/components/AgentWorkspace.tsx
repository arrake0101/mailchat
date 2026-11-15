import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import { applyThemeToDom } from "../theme";
import type {
  ConfigDiffReport,
  DeclarativeBundle,
  DeclarativeConfigSpec,
  SecretStatus,
} from "../types";
import { AgentConfigInspector, type InspectorTab } from "./AgentConfigInspector";
import {
  AgentKernelPane,
  type KernelStarterCard,
  type SnapshotSyncPayload,
} from "./AgentKernelPane";
import { IconChat } from "./Icons";
import type { SettingsTab } from "./Settings";

// 向外重导出共享内核类型与辅助组件，保持全工程导入兼容
export {
  AssistantTurnBody,
  computeActiveAgentMeta,
  computeConfiguredProviders,
  extractLatestDiff,
  HistoryDrawerModal,
  mapRecordToRichTurn,
  parseActiveAgentMeta,
  VaultDrawerModal,
  type ConfiguredProviderOption,
  type KernelStarterCard,
  type RichTurn,
  type SnapshotSyncPayload,
} from "./AgentKernelPane";

const STARTER_PROMPTS: KernelStarterCard[] = [
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
    title: "切换或加载主题模板",
    desc: "声明式切换浅色/深色/跟随系统、内置与社区主题模板，或粘贴加载外部模板 [theme]",
    text: "帮我把客户端切换成 Tokyo Night 东京暗夜主题模板",
  },
  {
    title: "定制 AI 分拣与批复策略",
    desc: "调整 [agent] 分拣指令与 [reply_policy] 隐私授权及自动秒回规则",
    text: "开启 AI 自动分拣，并查看当前的统一批复隐私授权与自动回复规则配置",
  },
];

/**
 * 左侧「助手」独立工作台：
 * - 底层挂载统一智能体内核 `AgentKernelPane` 的 **`instanceId="config"`（配置实例）**；
 * - 与右侧外挂面板的 **`instanceId="mail"`（邮件实例）** 共享同一套推理、流式、工具循环与凭据保险箱内核，
 *   但拥有完全独立的会话命名空间（`ags-*`）、与 `config.toml` `[agent]` 同步的模型状态，以及仅限声明式配置的工具权限（绝不读取邮件正文或代写发信）。
 */
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
  const [spec, setSpec] = useState<DeclarativeConfigSpec | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [savedToml, setSavedToml] = useState("");
  const [draftToml, setDraftToml] = useState("");
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("visual");
  const [activeDiff, setActiveDiff] = useState<ConfigDiffReport | null>(null);
  const [focusSignal, setFocusSignal] = useState<{ seq: number; targetKey: string } | null>(null);
  const [applyingToml, setApplyingToml] = useState(false);

  const [syncToken, setSyncToken] = useState(0);
  const [vaultReq, setVaultReq] = useState<{ seq: number; focusKey?: string | null } | null>(null);

  const tomlDirtyRef = useRef(false);
  const tomlDirty = draftToml !== savedToml;
  tomlDirtyRef.current = tomlDirty;

  const handleSnapshotSync = useCallback((payload: SnapshotSyncPayload) => {
    if (payload.path) {
      setConfigPath(payload.path);
    }
    if (payload.toml) {
      setSavedToml(payload.toml);
      if (!tomlDirtyRef.current) {
        setDraftToml(payload.toml);
      }
    }
    if (payload.spec) {
      setSpec(payload.spec);
      if (payload.spec.theme) {
        applyThemeToDom(payload.spec.theme);
      }
    }
    if (payload.secrets && payload.secrets.length > 0) {
      setSecrets(payload.secrets);
    }
    if (payload.activeDiff !== undefined) {
      setActiveDiff(payload.activeDiff);
    }
  }, []);

  const applyBundleState = useCallback(
    (bundle: DeclarativeBundle, msg?: string) => {
      setConfigPath(bundle.path);
      setSpec(bundle.spec);
      setSavedToml(bundle.toml);
      setDraftToml(bundle.toml);
      setSecrets(bundle.secrets);
      if (bundle.spec?.theme) {
        applyThemeToDom(bundle.spec.theme);
      }
      setSyncToken((n) => n + 1);
      if (msg) notify(msg);
    },
    [notify],
  );

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

  const handleLocateInForm = useCallback((targetKey: string, diff?: ConfigDiffReport | null) => {
    if (diff) {
      setActiveDiff(diff);
    }
    setInspectorTab("visual");
    setFocusSignal((prev) => ({ seq: (prev?.seq ?? 0) + 1, targetKey }));
  }, []);

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
        if (inspectorTab === "diff") {
          setInspectorTab("visual");
        }
        onDataChanged();
      } catch (e) {
        notify(`还原配置失败：${e}`, true);
        throw e;
      }
    },
    [applyBundleState, inspectorTab, notify, onDataChanged],
  );

  const openVaultDrawer = useCallback((focusKey?: string | null) => {
    setVaultReq((prev) => ({ seq: (prev?.seq ?? 0) + 1, focusKey: focusKey ?? null }));
  }, []);

  return (
    <section className="agent-workspace">
      <AgentKernelPane
        instanceId="config"
        variant="workspace"
        activeAccountEmail={activeAccountEmail}
        headerTitleOverride="配置助手"
        headerBadgeOverride="实例: config · 仅限 config.toml"
        headerSubtitleOverride="对话式编排账号、模型、主题与规则 · 独立配置实例，不读正文不代发"
        placeholderOverride="输入 config.toml 配置指令，如：切换东京暗夜主题模板 / 绑定 xxx@qq.com / 屏蔽包含退订的邮件…"
        thinkingContextLabel="配置方案"
        starterCards={STARTER_PROMPTS}
        emptyHeading="声明式配置助手"
        emptyDescription={
          <p>
            用自然语言编排邮箱账号、模型参数、过滤规则与多人邮件群聊，变更实时同步至右侧
            <strong>可视化表单</strong>与 <code>config.toml</code>（可自由切换），并清晰标明每次修改的具体字段。
          </p>
        }
        emptyScopeBanner={
          <div className="agent-scope-strip">
            <span className="agent-scope-strip-text">
              实例边界：当前为独立的 <code>config</code> 实例，<strong>仅维护配置文件</strong>
              ；写信排版、会话总结与邮件批复请使用右侧外挂邮件智能体（<code>mail</code> 实例）
            </span>
            <button
              type="button"
              className="agent-scope-link"
              onClick={onGoToInbox}
              title="前往消息工作区唤起邮件处理智能体实例"
            >
              <IconChat size={12} />
              <span>去消息会话处理邮件</span>
            </button>
          </div>
        }
        externalVaultRequest={vaultReq}
        externalSyncToken={syncToken}
        onSnapshotSync={handleSnapshotSync}
        onLocateInForm={handleLocateInForm}
        onOpenDiffTab={handleOpenDiffTab}
        onRevertBeforeToml={handleRevertBeforeToml}
        onOpenSettings={onOpenSettings}
        onDataChanged={onDataChanged}
        notify={notify}
      />

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
          setSyncToken((n) => n + 1);
          if (msg) notify(msg);
        }}
        onSwitchAccount={onSwitchAccount}
        onOpenVault={openVaultDrawer}
        onOpenFullSettings={() => onOpenSettings("visual")}
        notify={notify}
        onDataChanged={onDataChanged}
        onRevertBeforeToml={handleRevertBeforeToml}
      />
    </section>
  );
}
