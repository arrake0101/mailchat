import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, MODEL_PRESETS } from "../api";
import type { ChatTurn, SecretPrompt, SecretStatus } from "../types";
import { IconCheck, IconCode, IconKey, IconLock, IconSend, IconSliders, IconSparkles } from "./Icons";
import { MarkdownText } from "./MarkdownText";
import { startWindowDrag, toggleWindowMaximize } from "./WindowControls";

interface RichTurn {
  id: number;
  role: "user" | "assistant";
  content: string;
  changes?: string[];
  secretPrompts?: SecretPrompt[];
  suggestions?: string[];
}

const STARTER_PROMPTS = [
  { title: "DeepSeek 官网配置", desc: "官方首选 · 默认搭载 deepseek-v4.1-flash", text: "使用 DeepSeek 官网配置并开启自动分拣" },
  { title: "接入 OpenCode Go", desc: "订阅优先 · 默认使用 deepseek-v4.1-flash", text: "切换为 OpenCode Go 订阅并开启自动分拣" },
  { title: "接入 Ollama 远程订阅", desc: "云端订阅 · 免本地显卡运行 deepseek-v4.1-flash", text: "切换为 Ollama 远程订阅并开启自动分拣" },
  { title: "连接邮箱账号", desc: "自动匹配 IMAP / SMTP 并唤起本地加密授权码卡片", text: "帮我绑定邮箱 " },
  { title: "拦截促销广告", desc: "声明式写入屏蔽词并立即扫描收件箱", text: "屏蔽所有包含「退订」「限时优惠」的邮件" },
  { title: "载入沙盒演示数据", desc: "免绑邮箱体验 4 人群聊与智能分流", text: "载入演示会话体验" },
];

function parseActiveAgentMeta(tomlText: string) {
  const agentBlockMatch = tomlText.match(/\[agent\]([\s\S]*?)(?:\n\[|$)/);
  const section = agentBlockMatch ? agentBlockMatch[1] : tomlText;
  const presetMatch = section.match(/^\s*preset\s*=\s*"([^"]+)"/m);
  const modelMatch = section.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return {
    presetId: presetMatch?.[1]?.trim() || "deepseek",
    modelName: modelMatch?.[1]?.trim() || "deepseek-v4.1-flash",
  };
}

export function AgentWorkspace({
  notify,
  onDataChanged,
  onOpenManualSettings,
}: {
  notify: (text: string, isError?: boolean) => void;
  onDataChanged: () => void;
  onOpenManualSettings: () => void;
}) {
  const [turns, setTurns] = useState<RichTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [configPath, setConfigPath] = useState("");
  const [savedToml, setSavedToml] = useState("");
  const [draftToml, setDraftToml] = useState("");
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [showToml, setShowToml] = useState(true);
  const [applyingToml, setApplyingToml] = useState(false);
  const [showModelQuickMenu, setShowModelQuickMenu] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const quickMenuRef = useRef<HTMLDivElement>(null);

  const loadBundle = async () => {
    try {
      const b = await api.getDeclarativeConfig();
      setConfigPath(b.path);
      setSavedToml(b.toml);
      setDraftToml(b.toml);
      setSecrets(b.secrets);
    } catch (e) {
      notify(String(e), true);
    }
  };

  useEffect(() => {
    loadBundle();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, busy]);

  // 根据输入内容真实高度自适应伸缩，单行时彻底隐藏滚动条杜绝系统上下箭头与裁切
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const maxPx = 152;
    const contentH = el.scrollHeight;
    const nextH = Math.min(Math.max(24, contentH), maxPx);
    el.style.height = `${nextH}px`;
    el.style.overflowY = contentH > maxPx ? "auto" : "hidden";
  }, [input]);

  // 点击外部关闭模型快捷菜单
  useEffect(() => {
    if (!showModelQuickMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowModelQuickMenu(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showModelQuickMenu]);

  const sendPrompt = async (rawText?: string) => {
    const msg = (rawText ?? input).trim();
    if (!msg || busy) return;
    if (rawText === undefined) setInput("");
    setShowModelQuickMenu(false);

    const userTurn: RichTurn = { id: Date.now(), role: "user", content: msg };
    const historyPayload: ChatTurn[] = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, userTurn]);
    setBusy(true);

    try {
      const res = await api.chatWithAgent(msg, historyPayload);
      setSavedToml(res.toml);
      setDraftToml(res.toml);
      setSecrets(res.secrets);
      setTurns((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: res.reply,
          changes: res.changes,
          secretPrompts: res.secret_prompts,
          suggestions: res.suggestions,
        },
      ]);
      onDataChanged();
    } catch (e) {
      notify(`助手响应失败：${e}`, true);
    } finally {
      setBusy(false);
    }
  };

  const applyManualToml = async () => {
    setApplyingToml(true);
    try {
      const b = await api.applyDeclarativeConfig(draftToml);
      setSavedToml(b.toml);
      setDraftToml(b.toml);
      setSecrets(b.secrets);
      onDataChanged();
      notify("声明式配置已校验并生效");
    } catch (e) {
      notify(`TOML 校验失败：${e}`, true);
    } finally {
      setApplyingToml(false);
    }
  };

  const activeMeta = useMemo(() => {
    const { presetId, modelName } = parseActiveAgentMeta(savedToml);
    const presetObj = MODEL_PRESETS.find((p) => p.id === presetId);
    const presetLabel = presetObj?.name ?? presetId;
    const secretSlot = presetId === "ollama" ? null : `llm_${presetId}`;
    const keylessOk = presetId === "ollama" || presetId === "ollama_remote" || presetId === "custom";
    const hasSecret = secretSlot ? secrets.some((s) => s.key === secretSlot && s.configured) : true;
    const ready = keylessOk || hasSecret;
    return { presetId, presetLabel, modelName, ready, secretSlot };
  }, [savedToml, secrets]);

  const featuredPresets = useMemo(() => MODEL_PRESETS.filter((p) => p.featured), []);
  const configuredSecretCount = secrets.filter((s) => s.configured).length;
  const tomlDirty = draftToml !== savedToml;
  const canSend = !busy && input.trim().length > 0;

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
            <div>
              <div className="pane-title">智能配置与管家</div>
              <div className="pane-subtitle">对话式编排声明式配置 · 隐私密钥本地加密隔离</div>
            </div>
          </div>

          <div className="pane-header-actions">
            <button
              type="button"
              className="soft-btn"
              onClick={() => sendPrompt("配置 API Key")}
              title="唤起本地加密凭据输入卡片"
            >
              <IconLock size={14} />
              <span>凭据保险箱 ({configuredSecretCount})</span>
            </button>
            <button
              type="button"
              className={`soft-btn ${showToml ? "active-soft" : ""}`}
              onClick={() => setShowToml((v) => !v)}
              title="展开或收起右侧实时 config.toml 声明式配置"
            >
              <IconCode size={14} />
              <span>config.toml</span>
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={onOpenManualSettings}
              title="打开传统表单与凭据管理页"
            >
              <IconSliders size={14} />
              <span>配置页</span>
            </button>
          </div>
        </header>

        <div className="agent-feed">
          {turns.length === 0 ? (
            <div className="agent-empty">
              <div className="agent-empty-badge">
                <IconSparkles size={20} />
              </div>
              <h2>想怎么打理你的邮箱？直接说即可</h2>
              <p>
                账号绑定、模型切换、过滤规则与群聊管理都会自动编译为右侧透明的 <code>config.toml</code> 声明式配置。
                涉及 <b>密码与 API Key</b> 时将自动走本机系统级加密通道，绝不经过模型上下文。
              </p>

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
              {turns.map((t, idx) => {
                const isLast = idx === turns.length - 1;
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
                          <MarkdownText content={t.content} />
                        ) : (
                          <div className="agent-user-text">{t.content}</div>
                        )}

                        {t.changes && t.changes.length > 0 && (
                          <div className="applied-changes">
                            {t.changes.map((ch, i) => (
                              <span key={i} className="change-pill">
                                <IconCheck size={12} />
                                <span>{ch}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {t.secretPrompts && t.secretPrompts.length > 0 && (
                          <div className="secret-cards-stack">
                            {t.secretPrompts.map((sp) => (
                              <InlineSecretVaultCard
                                key={sp.key}
                                prompt={sp}
                                onSaved={(nextSecrets, msg) => {
                                  setSecrets(nextSecrets);
                                  loadBundle();
                                  notify(msg);
                                  onDataChanged();
                                }}
                                onError={(err) => notify(err, true)}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {isLast && t.suggestions && t.suggestions.length > 0 && (
                        <div className="followup-pills">
                          {t.suggestions.map((sug) => (
                            <button key={sug} type="button" className="followup-btn" onClick={() => sendPrompt(sug)}>
                              {sug}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {busy && (
                <div className="agent-turn assistant">
                  <div className="agent-turn-avatar" aria-hidden="true">
                    <IconSparkles size={14} />
                  </div>
                  <div className="agent-turn-col">
                    <div className="agent-bubble thinking-bubble">
                      <span className="thinking-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>正在思考与编排配置…</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <footer className="agent-composer-wrap">
          <div
            className={`agent-composer-card ${busy ? "is-busy" : ""}`}
            onMouseDown={(e) => {
              const tag = (e.target as HTMLElement).tagName;
              if (tag !== "BUTTON" && tag !== "TEXTAREA" && !(e.target as HTMLElement).closest("button")) {
                requestAnimationFrame(() => inputRef.current?.focus());
              }
            }}
          >
            <div className="agent-composer-input-row">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="输入对话或配置指令，如：你好 / 切换 OpenCode Go / 绑定 xxx@qq.com…"
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
                    title="点击快速切换首选模型服务或录入 API Key"
                  >
                    <span className={`status-dot ${activeMeta.ready ? "ok" : "warn"}`} />
                    <span className="composer-model-name">{activeMeta.presetLabel}</span>
                    <span className="composer-model-sep">·</span>
                    <span className="composer-model-id">{activeMeta.modelName}</span>
                    {!activeMeta.ready && <span className="composer-model-tag">未配密钥</span>}
                  </button>

                  {showModelQuickMenu && (
                    <div className="composer-model-menu">
                      <div className="composer-menu-header">首选推荐接入（默认 deepseek-v4.1-flash）</div>
                      {featuredPresets.map((fp) => {
                        const slot = `llm_${fp.id}`;
                        const configured = secrets.some((s) => s.key === slot && s.configured);
                        const isActive = activeMeta.presetId === fp.id;
                        return (
                          <button
                            key={fp.id}
                            type="button"
                            className={`composer-menu-item ${isActive ? "active" : ""}`}
                            onClick={() => {
                              setShowModelQuickMenu(false);
                              if (fp.id === "deepseek") {
                                sendPrompt("使用 DeepSeek 官网配置");
                              } else if (fp.id === "opencode_go") {
                                sendPrompt("切换为 OpenCode Go 订阅");
                              } else if (fp.id === "ollama_cloud") {
                                sendPrompt("切换为 Ollama 远程订阅");
                              }
                            }}
                          >
                            <div className="composer-menu-item-main">
                              <span className="composer-menu-item-title">{fp.name}</span>
                              <span className="composer-menu-badge">{fp.badge}</span>
                            </div>
                            <span className={`composer-menu-state ${configured ? "ok" : ""}`}>
                              {configured ? "密钥已就绪" : "待录入 Key"}
                            </span>
                          </button>
                        );
                      })}
                      <div className="composer-menu-divider" />
                      <button
                        type="button"
                        className="composer-menu-action"
                        onClick={() => {
                          setShowModelQuickMenu(false);
                          sendPrompt("配置 API Key");
                        }}
                      >
                        <IconKey size={13} />
                        <span>录入 / 更新当前服务 API Key</span>
                      </button>
                    </div>
                  )}
                </div>

                {!activeMeta.ready && (
                  <button
                    type="button"
                    className="composer-quick-chip accent"
                    onClick={() => sendPrompt("配置 API Key")}
                  >
                    <IconKey size={12} />
                    <span>录入密钥</span>
                  </button>
                )}

                {turns.length > 0 && (
                  <button
                    type="button"
                    className="composer-quick-chip"
                    onClick={() => setTurns([])}
                    disabled={busy}
                  >
                    <span>清空对话</span>
                  </button>
                )}
              </div>

              <div className="agent-composer-right">
                <span className="composer-shortcut-hint">Enter 发送 · Shift+Enter 换行</span>
                <button
                  type="button"
                  className={`composer-send-btn ${canSend ? "ready" : ""}`}
                  onClick={() => sendPrompt()}
                  disabled={!canSend}
                  title="发送 (Enter)"
                >
                  <IconSend size={15} />
                </button>
              </div>
            </div>
          </div>
        </footer>
      </div>

      {showToml && (
        <aside className="toml-pane">
          <div
            className="toml-head"
            onMouseDown={startWindowDrag}
            onDoubleClick={toggleWindowMaximize}
          >
            <div>
              <div className="toml-title-row">
                <span className="toml-filename">config.toml</span>
                <span className="privacy-pill">
                  <IconLock size={11} />
                  已脱敏
                </span>
              </div>
              {configPath && (
                <div className="toml-path" title={configPath}>
                  {configPath}
                </div>
              )}
            </div>
            <div className="toml-actions">
              {tomlDirty && (
                <button type="button" className="ghost-btn" onClick={() => setDraftToml(savedToml)}>
                  还原
                </button>
              )}
              <button
                type="button"
                className={tomlDirty ? "primary-btn" : "soft-btn"}
                onClick={applyManualToml}
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
            onChange={(e) => setDraftToml(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (tomlDirty) applyManualToml();
              }
            }}
          />
        </aside>
      )}
    </section>
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
          placeholder={prompt.configured ? "已配置加密凭据，输入新值可覆盖更新" : `输入 ${prompt.label}`}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(true);
            }
          }}
        />
        <button type="button" className="soft-btn" onClick={() => submit(false)} disabled={saving || !val.trim()}>
          仅保存
        </button>
        <button type="button" className="primary-btn" onClick={() => submit(true)} disabled={saving || !val.trim()}>
          {saving ? "验证中…" : "加密保存并验证"}
        </button>
      </div>
    </div>
  );
}
