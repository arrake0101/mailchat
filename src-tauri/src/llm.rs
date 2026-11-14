//! 统一多模型接入层（基于开源 Rust 多厂商推理引擎 `genai`）：
//! - 将各厂商原生与兼容协议（OpenAI Chat / Responses、Anthropic Messages、Google Gemini、
//!   DeepSeek、Ollama 本地与 Ollama Cloud、通义千问 Aliyun、Kimi Moonshot、OpenCode Go/Zen 等）
//!   统一交由社区持续维护的 `genai` 适配器处理序列化、流式/非流式解析与 `<think>` 推理块提取；
//! - API Key 仅从本地 DPAPI `Vault` 按需内存注入 `genai::resolver::AuthData`，绝不污染全局环境变量；
//! - 对 OpenCode Go / Zen 自动附加网关必需的 `x-opencode-session` 会话头与 v2 多协议端点路由。

use crate::config::model_preset_defaults;
use crate::db::AgentConfig;
use anyhow::{anyhow, bail, Result};
use genai::adapter::AdapterKind;
use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatResponse, ChatResponseFormat};
use genai::resolver::{AuthData, Endpoint, ProviderConfig};
use genai::{Client, Headers, ModelIden, ServiceTarget, WebConfig};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const CLIENT_USER_AGENT: &str = "mailchat/0.2.0";

/// 全局共享的 `genai::Client`（启用系统代理与 `<think>` 推理内容自动归一化）
fn genai_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut default_headers = reqwest::header::HeaderMap::new();
        default_headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(CLIENT_USER_AGENT),
        );
        let web_cfg = WebConfig::default()
            .with_connect_timeout(Duration::from_secs(15))
            .with_timeout(Duration::from_secs(90))
            .with_default_headers(default_headers);
        let default_chat_opts = ChatOptions::default().with_normalize_reasoning_content(true);

        Client::builder()
            .with_web_config(web_cfg)
            .with_chat_options(default_chat_opts)
            .build()
            .expect("Failed to initialize genai::Client")
    })
}

/// OpenCode Go / Zen 网关要求客户端携带稳定会话标识 `x-opencode-session`（缺失会触发 400 `MissingSessionID`）
pub fn opencode_session_id() -> &'static str {
    static SESSION_ID: OnceLock<String> = OnceLock::new();
    SESSION_ID.get_or_init(|| format!("ses_{}", uuid::Uuid::new_v4().simple()))
}

pub fn is_opencode_cfg(cfg: &AgentConfig) -> bool {
    cfg.preset.trim().eq_ignore_ascii_case("opencode_go")
        || cfg.base_url.to_lowercase().contains("opencode.ai")
}

/// 判断当前配置是否允许免 API Key 直连（本地 Ollama、局域网远程算力或内网自定义网关）
pub fn is_keyless_allowed(cfg: &AgentConfig) -> bool {
    let p = cfg.preset.trim().to_lowercase();
    let base = cfg.base_url.trim().to_lowercase();
    matches!(p.as_str(), "ollama" | "ollama_remote" | "custom")
        || base.contains("127.0.0.1")
        || base.contains("localhost")
        || base.contains(":11434")
}

/// 规范化用于声明式配置展示与通用兼容网关的 Base URL
pub fn normalize_openai_base(raw_base: &str, preset: &str) -> String {
    let mut b = raw_base.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        let (_, def_base, _) = model_preset_defaults(preset);
        b = def_base.trim_end_matches('/').to_string();
    }
    if b.is_empty() {
        return b;
    }
    let p = preset.trim().to_lowercase();
    let looks_ollama = p.starts_with("ollama")
        || b.contains(":11434")
        || b.eq_ignore_ascii_case("https://ollama.com");
    if looks_ollama {
        for suffix in ["/api/chat", "/api/generate", "/api/tags", "/api"] {
            if let Some(stripped) = b.strip_suffix(suffix) {
                b = stripped.trim_end_matches('/').to_string();
                break;
            }
        }
        if !b.ends_with("/v1") && !b.ends_with("/chat/completions") {
            b.push_str("/v1");
        }
    }
    b
}

/// 规范化 OpenCode 模型名：剥离 CLI 前缀 `opencode-go/` 或 `opencode/`，并将仅限官方 CLI 的 `-free` 映射为订阅模型名
pub fn normalize_opencode_model(raw_model: &str, _is_go: bool) -> String {
    let mut m = raw_model.trim();
    for prefix in ["opencode-go/", "opencode_go/", "opencode/"] {
        if let Some(rest) = m.strip_prefix(prefix) {
            m = rest.trim();
            break;
        }
    }
    let compact: String = m
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .collect::<String>()
        .to_lowercase();
    if compact == "deepseek4.1flash"
        || compact == "deepseekv4.1flash"
        || m.eq_ignore_ascii_case("deepseek-flash")
    {
        return "deepseek-v4.1-flash".to_string();
    }
    if m.ends_with("-free")
        && !matches!(
            m,
            "beam-free" | "longcat-2.5-free" | "iceman-contributor-free"
        )
    {
        if let Some(stripped) = m.strip_suffix("-free") {
            return stripped.to_string();
        }
    }
    m.to_string()
}

/// 适配各网关对 `deepseek-v4.1-flash` 的实际模型参数名
pub fn resolve_wire_model(base: &str, raw_model: &str) -> String {
    let base_lower = base.to_lowercase();
    if base_lower.contains("opencode.ai") {
        return normalize_opencode_model(raw_model, base_lower.contains("/go"));
    }

    let trimmed = raw_model.trim();
    let compact: String = trimmed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .collect::<String>()
        .to_lowercase();

    let canonical = if compact == "deepseek4.1flash" || compact == "deepseekv4.1flash" {
        "deepseek-v4.1-flash"
    } else {
        trimmed
    };

    if base_lower.contains("api.deepseek.com") && canonical.eq_ignore_ascii_case("deepseek-v4.1-flash") {
        "deepseek-flash".to_string()
    } else {
        canonical.to_string()
    }
}

fn ensure_trailing_slash(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    format!("{trimmed}/")
}

/// 提取 Ollama 原生根地址（例如把 `http://192.168.1.100:11434/v1` 转为 `http://192.168.1.100:11434/` 供 `genai` 原生 Ollama 适配器使用）
fn ollama_native_root(raw_base: &str, preset: &str) -> String {
    let mut b = raw_base.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        let (_, def_base, _) = model_preset_defaults(preset);
        b = def_base.trim_end_matches('/').to_string();
    }
    for suffix in ["/v1/chat/completions", "/v1", "/api/chat", "/api/generate", "/api/tags", "/api"] {
        if let Some(stripped) = b.strip_suffix(suffix) {
            b = stripped.trim_end_matches('/').to_string();
            break;
        }
    }
    ensure_trailing_slash(&b)
}

#[derive(Clone)]
struct CallPlan {
    adapter: AdapterKind,
    endpoint_url: String,
    model_name: String,
    auth: AuthData,
    extra_headers: Vec<(String, String)>,
    allow_json_mode: bool,
}

/// 将 `AgentConfig` 编译为一组按优先级排列的 `genai` 调用计划（含模型别名兜底与 OpenCode Go/Zen 层级顺延）
fn build_call_plans(cfg: &AgentConfig) -> Result<Vec<CallPlan>> {
    if cfg.model.trim().is_empty() {
        bail!("请先在「配置 → 模型接入」中填写模型名称");
    }

    let api_key = cfg.api_key.trim();

    // 1. OpenCode Go / Zen：借助 genai 的 OpenAI / Anthropic / OpenAIResp / Gemini 四大原生适配器 + 会话头路由
    if is_opencode_cfg(cfg) {
        if api_key.is_empty() {
            bail!("请先录入 OpenCode Go / Zen 的 API Key");
        }
        let base_lower = cfg.base_url.to_lowercase();
        let prefer_go = cfg.preset.trim().eq_ignore_ascii_case("opencode_go")
            || base_lower.contains("/go/")
            || base_lower.ends_with("/go")
            || base_lower.trim().is_empty();

        let tiers: [(&str, bool); 2] = if prefer_go {
            [
                ("https://opencode.ai/inference/go", true),
                ("https://opencode.ai/inference", false),
            ]
        } else {
            [
                ("https://opencode.ai/inference", false),
                ("https://opencode.ai/inference/go", true),
            ]
        };

        let sid = opencode_session_id().to_string();
        let mut plans = Vec::with_capacity(2);

        for (root, is_go) in tiers {
            let model_name = normalize_opencode_model(&cfg.model, is_go);
            let m_lower = model_name.to_lowercase();

            let (adapter, sub_path) = if m_lower.starts_with("claude-")
                || m_lower.starts_with("qwen3.5")
                || m_lower.starts_with("qwen3.6")
                || m_lower.starts_with("qwen3.7")
                || m_lower == "qwen3.8-flash"
                || (is_go && (m_lower == "qwen3.8-max" || m_lower == "minimax-m3"))
            {
                (AdapterKind::Anthropic, "anthropic/v1/")
            } else if m_lower.starts_with("gpt-") || m_lower.starts_with("grok-") || m_lower.starts_with("muse-") {
                (AdapterKind::OpenAIResp, "openai/v1/")
            } else if m_lower.starts_with("gemini-") {
                (AdapterKind::Gemini, "google/v1beta/")
            } else {
                (AdapterKind::OpenAI, "openai/v1/")
            };

            // 注意：各 genai 适配器（OpenAI / OpenAIResp / Anthropic / Gemini）已通过 AuthData 自动注入鉴权头；
            // 切勿在 extra_headers 中重复注入 lowercase "authorization"，否则会产生双 Authorization 头导致 Cloudflare 直接拦截报 400 HTML
            plans.push(CallPlan {
                adapter,
                endpoint_url: format!("{root}/{sub_path}"),
                model_name,
                auth: AuthData::from_single(api_key.to_string()),
                extra_headers: vec![("x-opencode-session".into(), sid.clone())],
                allow_json_mode: false,
            });
        }
        return Ok(plans);
    }

    let preset = cfg.preset.trim().to_lowercase();
    let provider = cfg.provider.trim().to_lowercase();

    // 2. Anthropic Claude 原生协议
    if provider == "anthropic" || preset == "anthropic" {
        if api_key.is_empty() {
            bail!("请先配置 Anthropic API Key");
        }
        let raw = if cfg.base_url.trim().is_empty() {
            "https://api.anthropic.com/v1/"
        } else {
            cfg.base_url.trim()
        };
        let trimmed = raw.trim_end_matches('/').trim_end_matches("/messages");
        let endpoint_url = if trimmed.ends_with("/v1") {
            format!("{trimmed}/")
        } else {
            format!("{trimmed}/v1/")
        };
        return Ok(vec![CallPlan {
            adapter: AdapterKind::Anthropic,
            endpoint_url,
            model_name: cfg.model.trim().to_string(),
            auth: AuthData::from_single(api_key.to_string()),
            extra_headers: vec![],
            allow_json_mode: false,
        }]);
    }

    // 3. Google Gemini 原生协议
    if provider == "gemini" || preset == "gemini" {
        if api_key.is_empty() {
            bail!("请先配置 Gemini API Key");
        }
        let raw = if cfg.base_url.trim().is_empty() {
            "https://generativelanguage.googleapis.com/v1beta/"
        } else {
            cfg.base_url.trim()
        };
        return Ok(vec![CallPlan {
            adapter: AdapterKind::Gemini,
            endpoint_url: ensure_trailing_slash(raw),
            model_name: cfg.model.trim().trim_start_matches("models/").to_string(),
            auth: AuthData::from_single(api_key.to_string()),
            extra_headers: vec![],
            allow_json_mode: true,
        }]);
    }

    // 4. Ollama 系列（支持 genai 原生 Ollama / OllamaCloud 协议与 OpenAI `/v1` 双栈自动兼容）
    let base_norm = normalize_openai_base(&cfg.base_url, &cfg.preset);
    if base_norm.is_empty() {
        bail!("未配置模型接口 Base URL");
    }
    if api_key.is_empty() && !is_keyless_allowed(cfg) {
        bail!("请先在「助手」或「配置 → 隐私保险箱」中录入 API Key（推荐优先使用 DeepSeek 官网、OpenCode Go 或 Ollama 远程订阅）");
    }

    let looks_ollama = preset.starts_with("ollama")
        || base_norm.contains(":11434")
        || base_norm.to_lowercase().contains("ollama.com");

    if looks_ollama {
        let native_root = ollama_native_root(&cfg.base_url, &cfg.preset);
        let openai_root = ensure_trailing_slash(&base_norm.trim_end_matches("/chat/completions"));
        let primary_model = resolve_wire_model(&base_norm, &cfg.model);
        let mut models = vec![primary_model.clone()];
        if base_norm.to_lowercase().contains("ollama.com")
            && primary_model.eq_ignore_ascii_case("deepseek-v4.1-flash")
        {
            models.push("deepseek-v4.1-flash:cloud".into());
            models.push("deepseek-v3.1:671b-cloud".into());
        }

        let is_cloud = preset == "ollama_cloud" || base_norm.to_lowercase().contains("ollama.com");
        let native_adapter = if is_cloud {
            AdapterKind::OllamaCloud
        } else {
            AdapterKind::Ollama
        };
        let auth_val = if api_key.is_empty() {
            "ollama".to_string()
        } else {
            api_key.to_string()
        };
        let native_extra_headers = if !api_key.is_empty() && !is_cloud {
            vec![("Authorization".into(), format!("Bearer {api_key}"))]
        } else {
            vec![]
        };

        let mut plans = Vec::new();
        for m in &models {
            plans.push(CallPlan {
                adapter: native_adapter,
                endpoint_url: native_root.clone(),
                model_name: m.clone(),
                auth: AuthData::from_single(auth_val.clone()),
                extra_headers: native_extra_headers.clone(),
                allow_json_mode: true,
            });
            plans.push(CallPlan {
                adapter: AdapterKind::OpenAI,
                endpoint_url: openai_root.clone(),
                model_name: m.clone(),
                auth: AuthData::from_single(auth_val.clone()),
                extra_headers: vec![],
                allow_json_mode: true,
            });
        }
        return Ok(plans);
    }

    // 5. DeepSeek 官网 / 通义千问 Aliyun / Kimi Moonshot / OpenAI / 硅基流动 / 自定义 OpenAI 兼容网关
    let adapter = if preset == "deepseek" || base_norm.to_lowercase().contains("api.deepseek.com") {
        AdapterKind::DeepSeek
    } else if preset == "qwen" || base_norm.to_lowercase().contains("dashscope.aliyuncs.com") {
        AdapterKind::Aliyun
    } else if preset == "kimi" || base_norm.to_lowercase().contains("api.moonshot.cn") {
        AdapterKind::Moonshot
    } else {
        AdapterKind::OpenAI
    };

    let clean_v1 = ensure_trailing_slash(base_norm.trim_end_matches("/chat/completions"));
    let primary_model = resolve_wire_model(&base_norm, &cfg.model);
    let mut candidate_models = vec![primary_model.clone()];
    if (primary_model.eq_ignore_ascii_case("deepseek-flash")
        || primary_model.eq_ignore_ascii_case("deepseek-v4.1-flash"))
        && base_norm.to_lowercase().contains("api.deepseek.com")
    {
        for fallback in ["deepseek-v4.1-flash", "deepseek-chat"] {
            if !candidate_models.iter().any(|x| x.eq_ignore_ascii_case(fallback)) {
                candidate_models.push(fallback.to_string());
            }
        }
    }

    let auth_str = if api_key.is_empty() {
        "local-keyless".to_string()
    } else {
        api_key.to_string()
    };

    let plans = candidate_models
        .into_iter()
        .map(|m| {
            let m_low = m.to_lowercase();
            let is_reasoner = m_low.contains("reasoner") || m_low.contains("r1") || m_low.contains("qwq");
            CallPlan {
                adapter,
                endpoint_url: clean_v1.clone(),
                model_name: m,
                auth: AuthData::from_single(auth_str.clone()),
                extra_headers: vec![],
                allow_json_mode: !is_reasoner,
            }
        })
        .collect();

    Ok(plans)
}

fn extract_chat_text(res: ChatResponse) -> Result<String> {
    if let Some(t) = res.first_text() {
        if !t.trim().is_empty() {
            return Ok(t.to_string());
        }
    }
    let joined = res.texts().join("");
    if !joined.trim().is_empty() {
        return Ok(joined);
    }
    if let Some(rc) = res.reasoning_content.as_deref() {
        if !rc.trim().is_empty() {
            if rc.contains('{') && rc.contains('}') {
                return Ok(rc.to_string());
            }
            if res.stop_reason.as_ref().is_some_and(|r| r.is_max_tokens()) {
                bail!("模型推理思考消耗了全部输出长度（MaxTokens），请稍后重试或切换更轻量的 Flash 模型");
            }
        }
    }
    Err(anyhow!("模型返回正文为空"))
}

/// 从 `genai::Error` 中提取干净可读的 HTTP 状态码与上游错误原因
fn unpack_genai_error(err: &genai::Error) -> (Option<u16>, String) {
    let parse_body = |body: &str| -> String {
        if let Ok(v) = serde_json::from_str::<Value>(body) {
            if let Some(msg) = v["error"]["message"]
                .as_str()
                .or_else(|| v["message"].as_str())
                .or_else(|| v["detail"].as_str())
                .or_else(|| v["error"].as_str())
            {
                return msg.to_string();
            }
        }
        body.chars().take(280).collect()
    };

    match err {
        genai::Error::WebModelCall { webc_error, .. }
        | genai::Error::WebAdapterCall { webc_error, .. } => match webc_error {
            genai::webc::Error::ResponseFailedStatus { status, body, .. } => {
                (Some(status.as_u16()), parse_body(body))
            }
            genai::webc::Error::Reqwest(re) => (re.status().map(|s| s.as_u16()), format!("网络请求失败: {re}")),
            other => (None, other.to_string()),
        },
        genai::Error::HttpError { status, body, .. } => (Some(status.as_u16()), parse_body(body)),
        other => (None, other.to_string()),
    }
}

/// 统一的异步文本/JSON 补全入口（底层由 `genai::Client` 执行）
pub async fn complete(
    cfg: &AgentConfig,
    system: &str,
    user: &str,
    want_json: bool,
    max_tokens: u32,
) -> Result<String> {
    let plans = build_call_plans(cfg)?;
    let client = genai_client();

    let mut last_code: Option<u16> = None;
    let mut last_msg = String::new();

    for (idx, plan) in plans.iter().enumerate() {
        let make_target = || ServiceTarget {
            endpoint: Endpoint::from_owned(plan.endpoint_url.clone()),
            auth: plan.auth.clone(),
            model: ModelIden::new(plan.adapter, plan.model_name.clone()),
        };

        let make_options = |json_mode: bool| {
            let mut opts = ChatOptions::default()
                .with_max_tokens(max_tokens)
                .with_normalize_reasoning_content(true);
            if json_mode {
                opts = opts.with_response_format(ChatResponseFormat::JsonMode);
            }
            if !plan.extra_headers.is_empty() {
                opts = opts.with_extra_headers(Headers::from(plan.extra_headers.clone()));
            }
            opts
        };

        let build_req = || {
            ChatRequest::from_system(system).append_message(ChatMessage::user(user))
        };

        let try_json = want_json && plan.allow_json_mode;
        let mut outcome = client
            .exec_chat(make_target(), build_req(), Some(&make_options(try_json)))
            .await;

        // 部分兼容网关不支持 response_format=json_object 会报 400/422，自动降级为普通模式重试一次
        if try_json {
            if let Err(ref e) = outcome {
                let (code, _) = unpack_genai_error(e);
                if matches!(code, Some(400 | 422)) {
                    outcome = client
                        .exec_chat(make_target(), build_req(), Some(&make_options(false)))
                        .await;
                }
            }
        }

        match outcome {
            Ok(resp) => return extract_chat_text(resp),
            Err(e) => {
                let (code, msg) = unpack_genai_error(&e);
                let msg_low = msg.to_lowercase();

                let can_try_next = idx + 1 < plans.len()
                    && (matches!(code, Some(400 | 402 | 403 | 404 | 422)) || code.is_none())
                    && (is_opencode_cfg(cfg)
                        || cfg.preset.starts_with("ollama")
                        || msg_low.contains("model")
                        || msg_low.contains("not found")
                        || msg_low.contains("not_found")
                        || msg_low.contains("does not exist")
                        || msg_low.contains("subscription")
                        || msg_low.contains("unsupported"));

                last_code = code;
                last_msg = msg;

                if can_try_next {
                    continue;
                }
                break;
            }
        }
    }

    let err_low = last_msg.to_lowercase();
    let privacy_hint = if is_opencode_cfg(cfg)
        && cfg.model.to_lowercase().contains("deepseek")
        && (last_code == Some(403)
            || err_low.contains("privacy")
            || err_low.contains("region")
            || err_low.contains("global")
            || err_low.contains("restricted"))
    {
        "（提示：OpenCode Go 在非中国区 IP/代理下调用 DeepSeek 需前往 OpenCode Console → Settings › Privacy 将 Regions 勾选为 Global；或直接在配置页切换免区域限制的 glm-5.3-flash / mimo-v2.6-flash）"
    } else {
        ""
    };

    match last_code {
        Some(code) => bail!("模型接口错误 (HTTP {code}): {last_msg}{privacy_hint}"),
        None => bail!("模型调用失败: {last_msg}{privacy_hint}"),
    }
}

/// 动态拉取远端或本地服务可用模型列表（优先通过 `genai::Client::all_model_names` 获取，并对 OpenCode 注入会话路由头）
pub async fn fetch_remote_models(cfg: &AgentConfig) -> Result<Vec<String>> {
    if is_opencode_cfg(cfg) {
        let b_low = cfg.base_url.to_lowercase();
        let url = if cfg.preset.trim().eq_ignore_ascii_case("opencode_go") || b_low.contains("/go") {
            "https://opencode.ai/inference/go/v1/models"
        } else {
            "https://opencode.ai/inference/v1/models"
        };
        let http = reqwest::Client::builder()
            .user_agent(CLIENT_USER_AGENT)
            .timeout(Duration::from_secs(12))
            .build()?;
        let mut req = http.get(url).header("x-opencode-session", opencode_session_id());
        if !cfg.api_key.trim().is_empty() {
            req = req.bearer_auth(cfg.api_key.trim());
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            bail!("拉取 OpenCode 模型列表失败 (HTTP {})", resp.status());
        }
        let v: Value = resp.json().await?;
        let mut list = Vec::new();
        if let Some(arr) = v["data"].as_array() {
            for item in arr {
                if let Some(id) = item["id"].as_str() {
                    let clean = id.trim();
                    if !clean.is_empty() && !list.iter().any(|x| x == clean) {
                        list.push(clean.to_string());
                    }
                }
            }
        }
        if list.is_empty() {
            bail!("OpenCode 网关未返回可用模型列表");
        }
        return Ok(list);
    }

    let base_norm = normalize_openai_base(&cfg.base_url, &cfg.preset);
    if base_norm.is_empty() && cfg.provider != "anthropic" && cfg.provider != "gemini" {
        bail!("请先填写接口地址 (Base URL)");
    }
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() && !is_keyless_allowed(cfg) {
        bail!("请先填写 API Key 后再拉取远端模型列表");
    }

    let client = genai_client();
    let preset = cfg.preset.trim().to_lowercase();
    let looks_ollama = preset.starts_with("ollama")
        || base_norm.contains(":11434")
        || base_norm.to_lowercase().contains("ollama.com");

    if looks_ollama {
        let root = ollama_native_root(&cfg.base_url, &cfg.preset);
        let adapter = if preset == "ollama_cloud" || base_norm.to_lowercase().contains("ollama.com") {
            AdapterKind::OllamaCloud
        } else {
            AdapterKind::Ollama
        };
        let auth = if api_key.is_empty() {
            AuthData::None
        } else {
            AuthData::from_single(api_key.to_string())
        };
        let pcfg = ProviderConfig::default()
            .with_endpoint(Endpoint::from_owned(root))
            .with_auth(auth);
        if let Ok(names) = client.all_model_names(adapter, pcfg).await {
            if !names.is_empty() {
                return Ok(names);
            }
        }
    }

    let (adapter, endpoint_url) = if cfg.provider == "anthropic" || preset == "anthropic" {
        let raw = if cfg.base_url.trim().is_empty() {
            "https://api.anthropic.com/v1/"
        } else {
            cfg.base_url.trim()
        };
        let trimmed = raw.trim_end_matches('/').trim_end_matches("/messages");
        let ep = if trimmed.ends_with("/v1") {
            format!("{trimmed}/")
        } else {
            format!("{trimmed}/v1/")
        };
        (AdapterKind::Anthropic, ep)
    } else if cfg.provider == "gemini" || preset == "gemini" {
        let raw = if cfg.base_url.trim().is_empty() {
            "https://generativelanguage.googleapis.com/v1beta/"
        } else {
            cfg.base_url.trim()
        };
        (AdapterKind::Gemini, ensure_trailing_slash(raw))
    } else {
        (
            AdapterKind::OpenAI,
            ensure_trailing_slash(base_norm.trim_end_matches("/chat/completions")),
        )
    };

    let auth = if api_key.is_empty() {
        AuthData::from_single("local-keyless")
    } else {
        AuthData::from_single(api_key.to_string())
    };
    let pcfg = ProviderConfig::default()
        .with_endpoint(Endpoint::from_owned(endpoint_url))
        .with_auth(auth);

    match client.all_model_names(adapter, pcfg).await {
        Ok(names) if !names.is_empty() => Ok(names),
        Ok(_) => bail!("远端接口未返回可用模型，请确认服务已启动且已拉取模型"),
        Err(e) => {
            let (_, msg) = unpack_genai_error(&e);
            bail!("拉取模型列表失败 ({msg})")
        }
    }
}
