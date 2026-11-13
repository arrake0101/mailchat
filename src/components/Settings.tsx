import { useEffect, useState } from "react";
import { api, MODEL_PRESETS, PRESETS } from "../api";
import type { Account, AgentConfig, ProviderPresetId, Rule, RuleKind, SecretStatus, Verdict } from "../types";
import { IconCheck, IconCode, IconKey, IconLock, IconRefresh, IconSliders, IconSparkles } from "./Icons";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

export type SettingsTab = "declarative" | "vault" | "visual";

const EMPTY_ACCOUNT: Account = {
  email: "",
  display_name: "",
  imap_host: "",
  imap_port: 993,
  smtp_host: "",
  smtp_port: 465,
  username: "",
  password: "",
};

const RULE_LABEL: Record<RuleKind, string> = {
  allow_sender: "白名单发件人（始终进消息）",
  block_sender: "屏蔽发件人",
  block_domain: "屏蔽发件域名",
  block_keyword: "屏蔽主题或正文关键词",
  archive_sender: "折叠发件人（自动进通知）",
  archive_keyword: "折叠关键词（自动进通知）",
};

export function Settings({
  initialTab = "declarative",
  hasDemo,
  notify,
  onAccountSaved,
  onDataChanged,
  onGoToAgent,
}: {
  initialTab?: SettingsTab;
  hasDemo: boolean;
  notify: (t: string, isError?: boolean) => void;
  onAccountSaved: () => void;
  onDataChanged: () => void;
  onGoToAgent: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  return (
    <section className="settings">
      <header
        className="pane-header win-safe-right"
        onMouseDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      >
        <div>
          <div className="pane-title">配置与隐私中心</div>
          <div className="pane-subtitle">所有非敏感状态由声明式 config.toml 驱动，密钥与授权码独立加密存储</div>
        </div>
        <div className="pane-header-actions">
          <div className="segmented">
            <button
              type="button"
              className={tab === "declarative" ? "active" : ""}
              onClick={() => setTab("declarative")}
            >
              <IconCode size={14} />
              <span>声明式配置</span>
            </button>
            <button
              type="button"
              className={tab === "vault" ? "active" : ""}
              onClick={() => setTab("vault")}
            >
              <IconLock size={14} />
              <span>隐私保险箱</span>
            </button>
            <button
              type="button"
              className={tab === "visual" ? "active" : ""}
              onClick={() => setTab("visual")}
            >
              <IconSliders size={14} />
              <span>可视化表单</span>
            </button>
          </div>

          <button type="button" className="primary-btn" onClick={onGoToAgent}>
            <IconSparkles size={14} />
            <span>交由 AI 助手配置</span>
          </button>
        </div>
      </header>

      <div className="settings-body">
        {tab === "declarative" && <DeclarativeTab notify={notify} onDataChanged={onDataChanged} />}
        {tab === "vault" && <VaultTab notify={notify} onDataChanged={onDataChanged} />}
        {tab === "visual" && (
          <VisualTab
            hasDemo={hasDemo}
            notify={notify}
            onAccountSaved={onAccountSaved}
            onDataChanged={onDataChanged}
          />
        )}
      </div>
    </section>
  );
}

function DeclarativeTab({
  notify,
  onDataChanged,
}: {
  notify: (t: string, e?: boolean) => void;
  onDataChanged: () => void;
}) {
  const [path, setPath] = useState("");
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api.getDeclarativeConfig().then((b) => {
      setPath(b.path);
      setSaved(b.toml);
      setDraft(b.toml);
    });
  }, []);

  const dirty = draft !== saved;

  const apply = async () => {
    setApplying(true);
    try {
      const b = await api.applyDeclarativeConfig(draft);
      setSaved(b.toml);
      setDraft(b.toml);
      onDataChanged();
      notify("声明式配置已校验并生效");
    } catch (e) {
      notify(`配置解析失败：${e}`, true);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="settings-stack wide-stack">
      <div className="surface-card toml-full-card">
        <div className="card-head-row">
          <div>
            <div className="section-title">config.toml 声明式配置清单</div>
            <div className="section-desc">
              文件位置：<code>{path}</code>（支持离线编辑，亦可在「AI 助手」中用自然语言自动编排）
            </div>
          </div>
          <div className="row">
            {dirty && (
              <button type="button" className="ghost-btn" onClick={() => setDraft(saved)}>
                放弃未保存修改
              </button>
            )}
            <button type="button" className="primary-btn" onClick={apply} disabled={!dirty || applying}>
              {applying ? "应用中…" : "校验并应用"}
            </button>
          </div>
        </div>

        <textarea
          className="toml-editor standalone-toml"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    </div>
  );
}

function VaultTab({
  notify,
  onDataChanged,
}: {
  notify: (t: string, e?: boolean) => void;
  onDataChanged: () => void;
}) {
  const [items, setItems] = useState<SecretStatus[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [inputVal, setInputVal] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listSecrets().then(setItems);
  }, []);

  const saveSecret = async (key: string, verify: boolean) => {
    if (!inputVal.trim() || saving) return;
    setSaving(true);
    try {
      const res = await api.setSecret(key, inputVal, verify);
      setItems(res.secrets);
      setEditingKey(null);
      setInputVal("");
      onDataChanged();
      notify(res.message);
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (key: string, label: string) => {
    try {
      setItems(await api.deleteSecret(key));
      onDataChanged();
      notify(`已从隐私保险箱移除 ${label}`);
    } catch (e) {
      notify(String(e), true);
    }
  };

  return (
    <div className="settings-stack">
      <div className="surface-card">
        <div className="vault-hero">
          <div className="vault-hero-icon">
            <IconLock size={18} />
          </div>
          <div>
            <div className="section-title">独立隐私凭据保险箱（Windows DPAPI 系统级加密）</div>
            <div className="section-desc">
              所有密码与 API Key 均绑定当前操作系统登录账户加密存储于 <code>secrets.vault.json</code>，绝不写入声明式配置文件 <code>config.toml</code>，也绝不进入任何大模型提示词上下文。
            </div>
          </div>
        </div>

        <div className="vault-list">
          {items.map((item) => {
            const isEditing = editingKey === item.key;
            return (
              <div key={item.key} className="vault-item">
                <div className="vault-item-main">
                  <div className="vault-item-left">
                    <IconKey size={15} />
                    <div>
                      <div className="vault-item-label">{item.label}</div>
                      <div className="vault-item-ref">
                        引用标识：<code>secret:{item.key}</code>
                      </div>
                    </div>
                  </div>

                  <div className="vault-item-right">
                    {item.configured ? (
                      <span className="status-pill ok">
                        <IconCheck size={12} />
                        {item.masked}
                      </span>
                    ) : (
                      <span className="status-pill muted">未配置</span>
                    )}

                    <button
                      type="button"
                      className="soft-btn"
                      onClick={() => {
                        setEditingKey(isEditing ? null : item.key);
                        setInputVal("");
                      }}
                    >
                      {isEditing ? "取消" : item.configured ? "更新" : "录入"}
                    </button>

                    {item.configured && (
                      <button
                        type="button"
                        className="ghost-btn danger-text"
                        onClick={() => removeSecret(item.key, item.label)}
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="vault-edit-row">
                    <input
                      autoFocus
                      type="password"
                      placeholder={`输入新的 ${item.label}`}
                      value={inputVal}
                      onChange={(e) => setInputVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveSecret(item.key, true);
                      }}
                    />
                    <button
                      type="button"
                      className="soft-btn"
                      onClick={() => saveSecret(item.key, false)}
                      disabled={saving || !inputVal.trim()}
                    >
                      仅加密保存
                    </button>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => saveSecret(item.key, true)}
                      disabled={saving || !inputVal.trim()}
                    >
                      {saving ? "验证中…" : "保存并验证连通"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VisualTab({
  hasDemo,
  notify,
  onAccountSaved,
  onDataChanged,
}: {
  hasDemo: boolean;
  notify: (t: string, e?: boolean) => void;
  onAccountSaved: () => void;
  onDataChanged: () => void;
}) {
  const [a, setA] = useState<Account>(EMPTY_ACCOUNT);
  const [c, setC] = useState<AgentConfig | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleKind, setRuleKind] = useState<RuleKind>("block_keyword");
  const [rulePattern, setRulePattern] = useState("");
  const [savingAcc, setSavingAcc] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [testVerdict, setTestVerdict] = useState<Verdict | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const reloadAll = () => {
    api.getAccount().then((acc) => acc && setA(acc));
    api.getAgentConfig().then(setC);
    api.listSecrets().then(setSecrets);
    api.listRules().then(setRules);
  };

  useEffect(() => {
    reloadAll();
  }, []);

  const hasMailPassword = secrets.some((s) => s.key === "mail_password" && s.configured);

  const applyDomainPreset = (domain: string) => {
    const preset = PRESETS[domain];
    if (!preset) return;
    setA((p) => {
      const localPart = p.email.includes("@") ? p.email.split("@")[0] : p.email || "yourname";
      const nextEmail = p.email.endsWith(`@${domain}`) ? p.email : `${localPart}@${domain}`;
      return {
        ...p,
        email: nextEmail,
        username: nextEmail,
        imap_host: preset.imap_host,
        imap_port: preset.imap_port,
        smtp_host: preset.smtp_host,
        smtp_port: preset.smtp_port,
      };
    });
  };

  const saveAccount = async () => {
    setSavingAcc(true);
    try {
      await api.saveAccount(a);
      setA((prev) => ({ ...prev, password: "" }));
      setSecrets(await api.listSecrets());
      notify("邮箱连接验证通过，已同步声明式配置！");
      onAccountSaved();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSavingAcc(false);
    }
  };

  const selectPreset = (id: ProviderPresetId) => {
    const target = MODEL_PRESETS.find((p) => p.id === id);
    if (!target || !c) return;
    setTestVerdict(null);
    setFetchedModels([]);
    const savedProfiles = {
      ...c.profiles,
      [c.preset]: { base_url: c.base_url, api_key: "", model: c.model },
    };
    const restored = savedProfiles[id];
    setC({
      ...c,
      preset: id,
      provider: target.provider,
      base_url: restored?.base_url ?? target.baseUrl,
      api_key: "",
      model: restored?.model || target.defaultModel,
      profiles: savedProfiles,
    });
  };

  const fetchModelList = async () => {
    if (!c || fetchingModels) return;
    setFetchingModels(true);
    try {
      const list = await api.fetchModels(c);
      setFetchedModels(list);
      if (list.length > 0 && (!c.model.trim() || !list.includes(c.model))) {
        setC((prev) => (prev ? { ...prev, model: list[0] } : prev));
      }
      notify(`已从接口拉取到 ${list.length} 个可用模型`);
    } catch (e) {
      notify(String(e), true);
    } finally {
      setFetchingModels(false);
    }
  };

  const saveAgent = async () => {
    if (!c) return;
    try {
      await api.saveAgentConfig(c);
      setC((prev) => (prev ? { ...prev, api_key: "" } : prev));
      setSecrets(await api.listSecrets());
      onDataChanged();
      notify("模型与分拣配置已更新至 config.toml");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const testLlm = async () => {
    if (!c) return;
    setTestingLlm(true);
    setTestVerdict(null);
    try {
      const v = await api.testAgent(c);
      setTestVerdict(v);
      notify(`模型连通正常：示例判定为 ${v.action} (${v.category})`);
    } catch (e) {
      notify(`测试失败：${e}`, true);
    } finally {
      setTestingLlm(false);
    }
  };

  const addRule = async () => {
    if (!rulePattern.trim()) return;
    try {
      await api.addRule(ruleKind, rulePattern);
      setRulePattern("");
      setRules(await api.listRules());
      await api.applyRulesNow();
      onDataChanged();
      notify("规则已写入声明式配置并扫描现有邮件");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const currentPreset = MODEL_PRESETS.find((p) => p.id === c?.preset) ?? MODEL_PRESETS[0];
  const activeLlmSecret = secrets.find((s) => s.key === `llm_${c?.preset}`);

  return (
    <div className="settings-stack">
      <div className="surface-card">
        <div className="section-title">邮箱服务器连接 (IMAP / SMTP)</div>
        <div className="preset-pills">
          {["qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "icloud.com", "aliyun.com"].map((d) => (
            <button key={d} type="button" className="pill-btn" onClick={() => applyDomainPreset(d)}>
              {PRESETS[d].label}
            </button>
          ))}
        </div>

        <div className="field-grid">
          <label>
            <span>邮箱地址</span>
            <input
              value={a.email}
              onChange={(e) => setA({ ...a, email: e.target.value.trim(), username: a.username || e.target.value.trim() })}
              placeholder="name@example.com"
            />
          </label>
          <label>
            <span>发信显示昵称</span>
            <input
              value={a.display_name}
              onChange={(e) => setA({ ...a, display_name: e.target.value })}
              placeholder="选填"
            />
          </label>
          <label>
            <span>IMAP 服务器</span>
            <input value={a.imap_host} onChange={(e) => setA({ ...a, imap_host: e.target.value.trim() })} />
          </label>
          <label>
            <span>IMAP 端口</span>
            <input type="number" value={a.imap_port} onChange={(e) => setA({ ...a, imap_port: Number(e.target.value) })} />
          </label>
          <label>
            <span>SMTP 服务器</span>
            <input value={a.smtp_host} onChange={(e) => setA({ ...a, smtp_host: e.target.value.trim() })} />
          </label>
          <label>
            <span>SMTP 端口</span>
            <input type="number" value={a.smtp_port} onChange={(e) => setA({ ...a, smtp_port: Number(e.target.value) })} />
          </label>
        </div>

        <label>
          <span>
            授权码 / 专用密码{" "}
            {hasMailPassword && <em className="inline-ok">（保险箱已加密保存，不修改可留空）</em>}
          </span>
          <input
            type="password"
            value={a.password}
            onChange={(e) => setA({ ...a, password: e.target.value })}
            placeholder={hasMailPassword ? "••••••••（已存入本地隐私保险箱）" : "输入后将自动转入本地 DPAPI 隐私保险箱"}
          />
        </label>

        <div className="row">
          <button
            type="button"
            className="primary-btn"
            onClick={saveAccount}
            disabled={savingAcc || !a.email || (!a.password && !hasMailPassword)}
          >
            {savingAcc ? "正在验证连接…" : "验证并保存账号"}
          </button>
          <button
            type="button"
            className="soft-btn"
            onClick={async () => {
              const n = await api.loadDemoData();
              onDataChanged();
              notify(n > 0 ? `已载入 ${n} 封演示邮件` : "演示数据已存在");
            }}
          >
            载入沙盒演示数据
          </button>
          {hasDemo && (
            <button
              type="button"
              className="ghost-btn danger-text"
              onClick={async () => {
                const n = await api.clearDemoData();
                onDataChanged();
                notify(`已移除 ${n} 封演示邮件`);
              }}
            >
              清空演示数据
            </button>
          )}
        </div>
      </div>

      {c && (
        <div className="surface-card">
          <div className="section-title">多模型 AI 分拣与辅助</div>
          <div className="switch-row">
            <label className="clean-switch">
              <input type="checkbox" checked={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.checked })} />
              <span>启用新来信 AI 自动分拣与摘要</span>
            </label>
            <label className="clean-switch">
              <input
                type="checkbox"
                checked={c.auto_draft}
                onChange={(e) => setC({ ...c, auto_draft: e.target.checked })}
              />
              <span>自动生成快捷回复建议</span>
            </label>
          </div>

          <div className="provider-grid">
            {MODEL_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`provider-card ${c.preset === p.id ? "selected" : ""}`}
                onClick={() => selectPreset(p.id)}
              >
                <span className="provider-name">{p.name}</span>
                <span className="provider-badge">{p.badge}</span>
              </button>
            ))}
          </div>

          {currentPreset.hint && <div className="preset-hint">{currentPreset.hint}</div>}

          <div className="field-grid">
            <label>
              <span>接口地址 (Base URL)</span>
              <input
                value={c.base_url}
                placeholder={currentPreset.baseUrl || "https://your-endpoint/v1"}
                onChange={(e) => setC({ ...c, base_url: e.target.value })}
              />
            </label>
            <label>
              <span className="label-row">
                <span>模型名称</span>
                {currentPreset.supportsModelFetch && (
                  <button
                    type="button"
                    className="text-link inline-fetch-btn"
                    onClick={fetchModelList}
                    disabled={fetchingModels}
                  >
                    <span className={fetchingModels ? "spin" : ""}>
                      <IconRefresh size={12} />
                    </span>
                    <span>{fetchingModels ? "拉取中…" : "拉取远端模型"}</span>
                  </button>
                )}
              </span>
              <input
                value={c.model}
                placeholder={currentPreset.defaultModel || "输入或点击拉取模型名称"}
                onChange={(e) => setC({ ...c, model: e.target.value })}
              />
            </label>
          </div>

          {(fetchedModels.length > 0 || currentPreset.models.length > 0) && (
            <div className="preset-pills">
              {Array.from(new Set([...fetchedModels, ...currentPreset.models]))
                .slice(0, 24)
                .map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`pill-btn ${c.model === m ? "active-pill" : ""}`}
                    onClick={() => setC({ ...c, model: m })}
                  >
                    {m}
                  </button>
                ))}
            </div>
          )}

          {(currentPreset.needsKey || currentPreset.optionalKey) && (
            <label>
              <span>
                API Key{" "}
                {currentPreset.optionalKey && !activeLlmSecret?.configured && (
                  <em className="inline-muted">（选填：无鉴权直连可留空；开启反向代理鉴权时填写）</em>
                )}
                {activeLlmSecret?.configured && (
                  <em className="inline-ok">（保险箱已存：{activeLlmSecret.masked}，不修改可留空）</em>
                )}
              </span>
              <input
                type="password"
                value={c.api_key}
                onChange={(e) => setC({ ...c, api_key: e.target.value })}
                placeholder={
                  currentPreset.optionalKey
                    ? "直连免填；如远端配置了 Bearer 密钥可在此录入（加密存入本机保险箱）"
                    : "输入后仅存入本机 DPAPI 隐私保险箱，不写入 config.toml"
                }
              />
            </label>
          )}

          <label>
            <span>自然语言分拣偏好</span>
            <textarea
              rows={3}
              value={c.instructions}
              onChange={(e) => setC({ ...c, instructions: e.target.value })}
            />
          </label>

          {testVerdict && (
            <div className="soft-banner">
              测试通过：动作 <b>{testVerdict.action}</b> · 分类 <b>{testVerdict.category}</b> · 摘要「{testVerdict.summary}」
            </div>
          )}

          <div className="row">
            <button type="button" className="primary-btn" onClick={saveAgent}>
              保存模型配置
            </button>
            <button type="button" className="soft-btn" onClick={testLlm} disabled={testingLlm}>
              {testingLlm ? "连通测试中…" : "测试模型连接"}
            </button>
          </div>
        </div>
      )}

      <div className="surface-card">
        <div className="section-title">确定性分流规则（0 延迟优先匹配）</div>
        <div className="row">
          <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKind)}>
            {(Object.keys(RULE_LABEL) as RuleKind[]).map((k) => (
              <option key={k} value={k}>
                {RULE_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className="grow"
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
            placeholder="输入邮箱、域名或关键词…"
            onKeyDown={(e) => e.key === "Enter" && addRule()}
          />
          <button type="button" className="primary-btn" onClick={addRule} disabled={!rulePattern.trim()}>
            添加规则
          </button>
        </div>

        {rules.length > 0 && (
          <div className="clean-rule-list">
            {rules.map((r) => (
              <div key={r.id} className="clean-rule-row">
                <span className="status-pill muted">{RULE_LABEL[r.kind]}</span>
                <code className="grow">{r.pattern}</code>
                <button
                  type="button"
                  className="ghost-btn danger-text"
                  onClick={async () => {
                    await api.deleteRule(r.id);
                    setRules(await api.listRules());
                    onDataChanged();
                  }}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
