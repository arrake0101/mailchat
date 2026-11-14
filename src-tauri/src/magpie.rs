//! Magpie (`yetone/magpie`) 本地模型路由网关自动发现、配置沿用与生命周期协同模块：
//! - 自动识别本机 `~/.config/magpie/settings.json`（及 `$XDG_CONFIG_HOME/magpie`）中的网关监听端口；
//! - 通过标准公开接口 `GET /v1/models`（本机回环默认携带 `Bearer magpie`，局域网/远程网关支持 Vault 加密的 Gateway Key）拉取实时路由组（`group/*`、`auto/*`）与供应商模型目录；
//! - 结合 `magpie ls --json` / `magpie status --json` 识别用户已在其他 Agent（Claude Code、Codex、OpenCode 等）绑定的模型，实现一键免配置直接沿用；
//! - 严守隐私边界：仅读取端口、路由组名与模型标识，绝不读取或复制 `providers.json` 中的任何上游明文 API Key。

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAGPIE_PORT: u16 = 3425;
pub const DEFAULT_MAGPIE_BASE_URL: &str = "http://127.0.0.1:3425/v1";
pub const MAGPIE_LOOPBACK_TOKEN: &str = "magpie";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MagpieAgentBinding {
    pub agent: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MagpieProbeReport {
    pub cli_installed: bool,
    pub config_found: bool,
    pub gateway_online: bool,
    pub base_url: String,
    pub port: u16,
    pub version: String,
    pub recommended_model: String,
    pub groups: Vec<String>,
    pub models: Vec<String>,
    pub agent_bindings: Vec<MagpieAgentBinding>,
    pub message: String,
}

struct RuntimeCacheEntry {
    at: Instant,
    base_url: String,
    report: MagpieProbeReport,
}

fn runtime_cache() -> &'static Mutex<Option<RuntimeCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<RuntimeCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

static LAST_AUTO_WAKE_SECS: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 判断地址是否为本机回环地址（本机回环调用 Magpie 免填 Gateway Key，直接使用 `Bearer magpie`）
pub fn is_loopback_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.contains("://127.0.0.1")
        || lower.contains("://localhost")
        || lower.contains("://[::1]")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("localhost")
}

/// 规范化 Magpie OpenAI 兼容网关地址（确保以 `/v1` 结尾，无尾随斜杠）
pub fn normalize_magpie_base_url(raw: &str) -> String {
    let mut b = raw.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        return configured_local_base_url();
    }
    if !b.starts_with("http://") && !b.starts_with("https://") {
        b = format!("http://{b}");
    }
    for suffix in ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/v1/messages"] {
        if let Some(stripped) = b.strip_suffix(suffix) {
            b = stripped.trim_end_matches('/').to_string();
            break;
        }
    }
    if !b.ends_with("/v1") {
        b.push_str("/v1");
    }
    b
}

/// 提取 URL 中的端口号（未显式写出时返回默认 3425）
fn extract_port_from_url(url: &str) -> Option<u16> {
    let after_scheme = url
        .trim()
        .strip_prefix("http://")
        .or_else(|| url.trim().strip_prefix("https://"))
        .unwrap_or(url.trim());
    let host_port = after_scheme.split('/').next()?;
    let port_str = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split("]:").nth(1)?
    } else {
        host_port.rsplit_once(':')?.1
    };
    port_str.parse::<u16>().ok().filter(|p| *p > 0)
}

/// 枚举本机可能存在的 Magpie 配置目录（遵循 `$XDG_CONFIG_HOME/magpie` 与 `~/.config/magpie`）
pub fn magpie_config_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_dir = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };

    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            push_dir(PathBuf::from(trimmed).join("magpie"));
        }
    }

    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok().filter(|s| !s.trim().is_empty()));

    if let Some(h) = home {
        let hp = PathBuf::from(h);
        push_dir(hp.join(".config").join("magpie"));
        push_dir(hp.join(".magpie"));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let trimmed = appdata.trim();
        if !trimmed.is_empty() {
            push_dir(PathBuf::from(trimmed).join("magpie"));
        }
    }

    dirs
}

/// 解析 `settings.json` 中的非敏感监听主机与端口（将 `0.0.0.0` 转为客户端可直连的 `127.0.0.1`）
pub fn parse_settings_host_and_port(raw_json: &str) -> Option<(String, u16)> {
    let v: Value = serde_json::from_str(raw_json).ok()?;
    let port = v
        .get("port")
        .and_then(Value::as_u64)
        .or_else(|| v.pointer("/gateway/port").and_then(Value::as_u64))
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_MAGPIE_PORT);

    let raw_host = v
        .get("host")
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/gateway/host").and_then(Value::as_str))
        .unwrap_or("127.0.0.1")
        .trim();

    let host = match raw_host {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        other => other.to_string(),
    };

    Some((host, port))
}

/// 读取本机已配置的 Magpie 本地网关 Base URL（若无配置文件则默认 `http://127.0.0.1:3425/v1`）
pub fn configured_local_base_url() -> String {
    for dir in magpie_config_dirs() {
        let settings_path = dir.join("settings.json");
        if let Ok(raw) = std::fs::read_to_string(&settings_path) {
            if let Some((host, port)) = parse_settings_host_and_port(&raw) {
                return format!("http://{host}:{port}/v1");
            }
        }
    }
    DEFAULT_MAGPIE_BASE_URL.to_string()
}

fn slugify_group_name(name: &str) -> String {
    let trimmed = name.trim();
    if let Some(rest) = trimmed.strip_prefix("group/") {
        return rest.trim().to_lowercase();
    }
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in trimmed.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_dash = false;
        } else if (ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/')) && !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// 仅从 `providers.json` 提取非敏感的路由组标识（`group/*`）与已启用模型 ID（`provider/model`），绝不读取任何密钥字段
pub fn parse_providers_catalog_metadata(raw_json: &str) -> (Vec<String>, Vec<String>) {
    let Ok(v) = serde_json::from_str::<Value>(raw_json) else {
        return (Vec::new(), Vec::new());
    };

    let mut groups = Vec::new();
    let mut models = Vec::new();
    let push_uniq = |vec: &mut Vec<String>, s: String| {
        let clean = s.trim().to_string();
        if !clean.is_empty() && !vec.iter().any(|x| x == &clean) {
            vec.push(clean);
        }
    };

    // 1. 提取路由组 groups（支持数组或对象映射两种结构）
    if let Some(grp_arr) = v.get("groups").and_then(Value::as_array) {
        for g in grp_arr {
            if g.get("disabled").and_then(Value::as_bool) == Some(true)
                || g.get("on").and_then(Value::as_bool) == Some(false)
            {
                continue;
            }
            let raw_id = g
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .or_else(|| g.get("name").and_then(Value::as_str));
            if let Some(name) = raw_id {
                let slug = slugify_group_name(name);
                if !slug.is_empty() {
                    let full = format!("group/{slug}");
                    push_uniq(&mut groups, full.clone());
                    push_uniq(&mut models, full);
                }
            }
        }
    } else if let Some(grp_map) = v.get("groups").and_then(Value::as_object) {
        for (k, g) in grp_map {
            if g.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let slug = slugify_group_name(k);
            if !slug.is_empty() {
                let full = format!("group/{slug}");
                push_uniq(&mut groups, full.clone());
                push_uniq(&mut models, full);
            }
        }
    }

    let collect_provider_models = |prov_id: &str, pval: &Value, out: &mut Vec<String>| {
        let pid = prov_id.trim();
        if pid.is_empty()
            || pval.get("disabled").and_then(Value::as_bool) == Some(true)
            || pval.get("enabled").and_then(Value::as_bool) == Some(false)
        {
            return;
        }
        if let Some(m_arr) = pval.get("models").and_then(Value::as_array) {
            for m in m_arr {
                if let Some(s) = m.as_str() {
                    let mid = s.trim();
                    if !mid.is_empty() {
                        let full = if mid.contains('/') {
                            mid.to_string()
                        } else {
                            format!("{pid}/{mid}")
                        };
                        push_uniq(out, full);
                    }
                } else if m.is_object() {
                    if m.get("on").and_then(Value::as_bool) == Some(false)
                        || m.get("disabled").and_then(Value::as_bool) == Some(true)
                    {
                        continue;
                    }
                    if let Some(mid) = m
                        .get("id")
                        .and_then(Value::as_str)
                        .or_else(|| m.get("name").and_then(Value::as_str))
                    {
                        let mid = mid.trim();
                        if !mid.is_empty() {
                            let full = if mid.contains('/') {
                                mid.to_string()
                            } else {
                                format!("{pid}/{mid}")
                            };
                            push_uniq(out, full);
                        }
                    }
                }
            }
        }
    };

    // 2. 提取已配置供应商下的模型 ID（忽略 apiKey / headers 等敏感凭据字段）
    if let Some(p_arr) = v.get("providers").and_then(Value::as_array) {
        for p in p_arr {
            if let Some(pid) = p
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| p.get("name").and_then(Value::as_str))
            {
                collect_provider_models(pid, p, &mut models);
            }
        }
    } else if let Some(p_map) = v.get("providers").and_then(Value::as_object) {
        for (pid, p) in p_map {
            collect_provider_models(pid, p, &mut models);
        }
    }

    (groups, models)
}

/// 判断模型标识是否为适合对话与邮件分拣的文本生成模型（过滤嵌入、语音转写、重排、文生图模型）
pub fn is_chat_capable_model(model_id: &str) -> bool {
    let m = model_id.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    let non_chat_markers = [
        "embedding",
        "text-embedding",
        "rerank",
        "bge-",
        "whisper",
        "tts-",
        "tts/",
        "dall-e",
        "moderation",
        "omni-moderation",
        "jina-embeddings",
        "voyage-",
    ];
    !non_chat_markers.iter().any(|kw| m.contains(kw))
}

fn chat_model_preference_score(model_id: &str) -> i32 {
    if !is_chat_capable_model(model_id) {
        return -1000;
    }
    let m = model_id.trim().to_lowercase();
    if m.starts_with("group/") {
        return 500;
    }
    if m.starts_with("auto/") {
        let mut bonus = 400;
        if m.contains("flash") || m.contains("haiku") || m.contains("mini") {
            bonus += 30;
        }
        return bonus;
    }
    let mut score = 100;
    if m.contains("deepseek") && m.contains("flash") {
        score += 95;
    } else if m.contains("glm") && m.contains("flash") {
        score += 90;
    } else if m.contains("gemini") && m.contains("flash") {
        score += 88;
    } else if m.contains("qwen") && (m.contains("flash") || m.contains("plus") || m.contains("turbo")) {
        score += 85;
    } else if m.contains("claude") && (m.contains("haiku") || m.contains("sonnet")) {
        score += 84;
    } else if m.contains("gpt-4.1-mini") || m.contains("gpt-4o-mini") || m.contains("gpt-5-mini") {
        score += 82;
    } else if m.contains("deepseek-chat") || m.contains("deepseek-v3") || m.contains("deepseek-v4") {
        score += 80;
    } else if m.contains("kimi") || m.contains("minimax") || m.contains("mimo") {
        score += 75;
    } else if m.contains("sonnet") || m.contains("gpt-4.1") || m.contains("gpt-4o") || m.contains("opus") {
        score += 70;
    }
    if m.contains("reasoner") || m.contains("-r1") || m.contains("qwq") {
        score -= 15;
    }
    score
}

/// 解析 `/v1/models` 响应体或 `magpie models --json` 输出，返回去重模型 ID 列表
pub fn parse_models_json(raw_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(raw_json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut push_id = |s: &str| {
        let clean = s.trim();
        if !clean.is_empty() && !out.iter().any(|x| x == clean) {
            out.push(clean.to_string());
        }
    };

    let extract_from_arr = |arr: &[Value], push: &mut dyn FnMut(&str)| {
        for item in arr {
            if let Some(s) = item.as_str() {
                push(s);
            } else if let Some(id) = item
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| item.get("model").and_then(Value::as_str))
                .or_else(|| item.get("name").and_then(Value::as_str))
            {
                push(id);
            }
        }
    };

    if let Some(arr) = v.as_array() {
        extract_from_arr(arr, &mut push_id);
    } else if let Some(arr) = v.get("data").and_then(Value::as_array) {
        extract_from_arr(arr, &mut push_id);
    } else if let Some(arr) = v.get("models").and_then(Value::as_array) {
        extract_from_arr(arr, &mut push_id);
    }

    out
}

/// 解析 `magpie ls --json` 输出，提取本机其他 Coding Agent（Claude Code / Codex / OpenCode 等）已绑定的路由模型
pub fn parse_agent_bindings_json(raw_json: &str) -> Vec<MagpieAgentBinding> {
    let Ok(v) = serde_json::from_str::<Value>(raw_json) else {
        return Vec::new();
    };
    let arr_opt = v
        .as_array()
        .or_else(|| v.get("agents").and_then(Value::as_array))
        .or_else(|| v.get("items").and_then(Value::as_array))
        .or_else(|| v.get("data").and_then(Value::as_array));

    let Some(arr) = arr_opt else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for item in arr {
        let agent = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| item.get("agent").and_then(Value::as_str))
            .or_else(|| item.get("title").and_then(Value::as_str))
            .or_else(|| item.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .trim();

        let model = item
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| item.get("activeModel").and_then(Value::as_str))
            .or_else(|| item.get("active_model").and_then(Value::as_str))
            .or_else(|| item.get("currentModel").and_then(Value::as_str))
            .or_else(|| item.get("target").and_then(Value::as_str))
            .or_else(|| item.get("boundModel").and_then(Value::as_str))
            .unwrap_or("")
            .trim();

        if agent.is_empty() || model.is_empty() {
            continue;
        }
        let m_low = model.to_lowercase();
        if matches!(
            m_low.as_str(),
            "-" | "none" | "unmanaged" | "native" | "off" | "disabled" | "null"
        ) {
            continue;
        }
        // 去除部分 Agent（如 OpenCode）本地配置可能包裹的前缀 `magpie/`
        let normalized_model = model.strip_prefix("magpie/").unwrap_or(model).trim();
        if normalized_model.is_empty() {
            continue;
        }
        if !out
            .iter()
            .any(|b: &MagpieAgentBinding| b.agent == agent && b.model == normalized_model)
        {
            out.push(MagpieAgentBinding {
                agent: agent.to_string(),
                model: normalized_model.to_string(),
            });
        }
    }
    out
}

/// 对发现的模型列表做优先级重排（已绑定模型 > 路由组 `group/*` > 自动故障转移池 `auto/*` > 常用对话模型），并选出最佳默认沿用模型
pub fn rank_and_recommend_models(
    raw_models: &[String],
    extra_groups: &[String],
    bindings: &[MagpieAgentBinding],
    strict_to_raw: bool,
) -> (Vec<String>, Vec<String>, String) {
    let mut all_candidates: Vec<String> = Vec::new();
    let mut push_cand = |s: &str| {
        let clean = s.trim();
        if !clean.is_empty() && !all_candidates.iter().any(|x| x == clean) {
            all_candidates.push(clean.to_string());
        }
    };

    // 若非严格受限于网关在线返回列表，则把绑定模型与组也并入总表；若网关在线则优先置顶其中已生效的模型
    for b in bindings {
        if !strict_to_raw || raw_models.iter().any(|m| m == &b.model) {
            push_cand(&b.model);
        }
    }
    for g in extra_groups {
        if !strict_to_raw || raw_models.iter().any(|m| m == g) {
            push_cand(g);
        }
    }
    for m in raw_models {
        push_cand(m);
    }

    let mut groups: Vec<String> = all_candidates
        .iter()
        .filter(|m| m.starts_with("group/") || m.starts_with("auto/"))
        .cloned()
        .collect();
    groups.sort_by(|a, b| {
        let a_is_grp = a.starts_with("group/");
        let b_is_grp = b.starts_with("group/");
        b_is_grp.cmp(&a_is_grp)
    });

    let bound_set: Vec<String> = bindings.iter().map(|b| b.model.clone()).collect();
    let mut sorted = all_candidates;
    sorted.sort_by(|a, b| {
        let a_bound = bound_set.contains(a);
        let b_bound = bound_set.contains(b);
        if a_bound != b_bound {
            return b_bound.cmp(&a_bound);
        }
        let sa = chat_model_preference_score(a);
        let sb = chat_model_preference_score(b);
        sb.cmp(&sa)
    });

    // 过滤掉明显的非对话模型后再选推荐默认模型
    let recommended = bindings
        .iter()
        .map(|b| b.model.as_str())
        .find(|m| {
            is_chat_capable_model(m) && (!strict_to_raw || sorted.iter().any(|x| x == m))
        })
        .map(String::from)
        .or_else(|| {
            groups
                .iter()
                .find(|g| g.starts_with("group/") && is_chat_capable_model(g))
                .cloned()
        })
        .or_else(|| {
            groups
                .iter()
                .find(|g| is_chat_capable_model(g))
                .cloned()
        })
        .or_else(|| sorted.iter().find(|m| is_chat_capable_model(m)).cloned())
        .unwrap_or_default();

    // 排序输出中也剔除纯 embedding/rerank/whisper 等无法用于对话的模型，保持选择器干净
    let chat_models: Vec<String> = sorted
        .into_iter()
        .filter(|m| is_chat_capable_model(m))
        .collect();

    (groups, chat_models, recommended)
}

fn locate_magpie_binary() -> Option<PathBuf> {
    let bin_name = if cfg!(target_os = "windows") {
        "magpie.exe"
    } else {
        "magpie"
    };

    // 1. 先检查系统 PATH
    let mut check_cmd = Command::new(bin_name);
    check_cmd
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        check_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if check_cmd.status().is_ok() {
        return Some(PathBuf::from(bin_name));
    }

    // 2. 检查常见用户级安装目录（无需重启终端刷新 PATH 也能定位）
    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let hp = PathBuf::from(home);
        candidates.push(hp.join(".magpie").join("bin").join(bin_name));
        candidates.push(hp.join(".local").join("bin").join(bin_name));
        candidates.push(hp.join("go").join("bin").join(bin_name));
        candidates.push(hp.join(".cargo").join("bin").join(bin_name));
    }
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let lp = PathBuf::from(local_app);
        candidates.push(lp.join("Programs").join("magpie").join(bin_name));
        candidates.push(lp.join("Programs").join("Magpie").join(bin_name));
        candidates.push(lp.join("magpie").join(bin_name));
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/magpie"));
        candidates.push(PathBuf::from("/usr/local/bin/magpie"));
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn run_magpie_cli_capture(bin: &PathBuf, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let out = child.wait_with_output().ok()?;
                return String::from_utf8(out.stdout).ok();
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(35));
            }
            Err(_) => return None,
        }
    }
}

fn parse_status_json(raw_json: &str) -> (String, Option<u16>) {
    let Ok(v) = serde_json::from_str::<Value>(raw_json) else {
        return (String::new(), None);
    };
    let version = v
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let port = v
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .or_else(|| {
            v.get("addr")
                .or_else(|| v.get("address"))
                .or_else(|| v.get("listen"))
                .and_then(Value::as_str)
                .and_then(extract_port_from_url)
        });
    (version, port)
}

async fn fetch_gateway_models_http(base_url: &str, token: &str, timeout: Duration) -> Result<Vec<String>> {
    let clean_base = normalize_magpie_base_url(base_url);
    let url = format!("{clean_base}/models");
    let auth_token = if token.trim().is_empty() {
        MAGPIE_LOOPBACK_TOKEN
    } else {
        token.trim()
    };

    let http = reqwest::Client::builder()
        .user_agent("mailchat/0.2.0")
        .connect_timeout(timeout)
        .timeout(timeout)
        .build()?;

    let resp = http.get(&url).bearer_auth(auth_token).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(160).collect();
        bail!("HTTP {}: {}", status.as_u16(), snippet.trim());
    }
    let text = resp.text().await?;
    Ok(parse_models_json(&text))
}

/// 全面探测本机或指定地址的 Magpie 模型路由网关与已沿用配置
pub async fn probe_magpie(
    custom_base_url: Option<&str>,
    gateway_key: Option<&str>,
) -> MagpieProbeReport {
    let explicit_url = custom_base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(normalize_magpie_base_url);
    let is_custom_remote = explicit_url
        .as_deref()
        .map(|u| !is_loopback_url(u))
        .unwrap_or(false);

    // 1. 在阻塞线程收集本地配置文件元数据与 CLI 状态（仅当非纯远程地址或用于兜底时）
    let local_meta = tauri::async_runtime::spawn_blocking(move || {
        let mut cfg_found = false;
        let mut settings_base: Option<String> = None;
        let mut file_groups: Vec<String> = Vec::new();
        let mut file_models: Vec<String> = Vec::new();

        for dir in magpie_config_dirs() {
            let sp = dir.join("settings.json");
            if sp.is_file() {
                cfg_found = true;
                if settings_base.is_none() {
                    if let Ok(raw) = std::fs::read_to_string(&sp) {
                        if let Some((host, port)) = parse_settings_host_and_port(&raw) {
                            settings_base = Some(format!("http://{host}:{port}/v1"));
                        }
                    }
                }
            }
            let pp = dir.join("providers.json");
            if pp.is_file() {
                cfg_found = true;
                if let Ok(raw) = std::fs::read_to_string(&pp) {
                    let (gs, ms) = parse_providers_catalog_metadata(&raw);
                    for g in gs {
                        if !file_groups.contains(&g) {
                            file_groups.push(g);
                        }
                    }
                    for m in ms {
                        if !file_models.contains(&m) {
                            file_models.push(m);
                        }
                    }
                }
            }
        }

        let bin = if is_custom_remote {
            None
        } else {
            locate_magpie_binary()
        };
        let mut version = String::new();
        let mut cli_port: Option<u16> = None;
        let mut bindings: Vec<MagpieAgentBinding> = Vec::new();
        let mut cli_models: Vec<String> = Vec::new();

        if let Some(ref b) = bin {
            if let Some(st_out) =
                run_magpie_cli_capture(b, &["status", "--json"], Duration::from_millis(1800))
            {
                let (ver, p) = parse_status_json(&st_out);
                version = ver;
                cli_port = p;
            }
            if let Some(ls_out) =
                run_magpie_cli_capture(b, &["ls", "--json"], Duration::from_millis(2000))
            {
                bindings = parse_agent_bindings_json(&ls_out);
            }
            if let Some(m_out) =
                run_magpie_cli_capture(b, &["models", "--json"], Duration::from_millis(2200))
            {
                cli_models = parse_models_json(&m_out);
            }
        }

        (
            bin.is_some(),
            cfg_found,
            settings_base,
            cli_port,
            version,
            bindings,
            cli_models,
            file_groups,
            file_models,
        )
    })
    .await
    .unwrap_or_default();

    let (
        cli_installed,
        config_found,
        settings_base,
        cli_port,
        version,
        agent_bindings,
        cli_models,
        file_groups,
        file_models,
    ) = local_meta;

    let resolved_base = if let Some(u) = explicit_url {
        u
    } else if let Some(p) = cli_port {
        format!("http://127.0.0.1:{p}/v1")
    } else if let Some(sb) = settings_base {
        sb
    } else {
        DEFAULT_MAGPIE_BASE_URL.to_string()
    };

    let port = extract_port_from_url(&resolved_base).unwrap_or(DEFAULT_MAGPIE_PORT);
    let token = gateway_key.unwrap_or("");
    let timeout = if is_loopback_url(&resolved_base) {
        Duration::from_millis(2200)
    } else {
        Duration::from_secs(6)
    };

    // 2. 探测在线网关 `/v1/models`
    let (gateway_online, live_models, gateway_err) =
        match fetch_gateway_models_http(&resolved_base, token, timeout).await {
            Ok(list) => (true, list, None),
            Err(e) => (false, Vec::new(), Some(e.to_string())),
        };

    let (groups, models, recommended_model) = if gateway_online && !live_models.is_empty() {
        rank_and_recommend_models(&live_models, &file_groups, &agent_bindings, true)
    } else {
        let mut combined_offline = cli_models;
        for m in file_models {
            if !combined_offline.contains(&m) {
                combined_offline.push(m);
            }
        }
        rank_and_recommend_models(&combined_offline, &file_groups, &agent_bindings, false)
    };

    let message = if gateway_online {
        if models.is_empty() {
            format!(
                "Magpie 本地路由网关已在线（{resolved_base}），但尚未在 Magpie 中添加任何上游模型或订阅账号。"
            )
        } else {
            let grp_note = if !groups.is_empty() {
                format!("，含 {} 个故障转移路由组", groups.len())
            } else {
                String::new()
            };
            let bind_note = if let Some(first_bind) = agent_bindings.first() {
                format!("，已自动沿用 {} 绑定的 `{}`", first_bind.agent, first_bind.model)
            } else {
                String::new()
            };
            format!(
                "已连接 Magpie 模型路由网关（{} 个可用模型{}{}）",
                models.len(),
                grp_note,
                bind_note
            )
        }
    } else if cli_installed || config_found {
        format!(
            "检测到本机已安装/配置 Magpie，但本地网关（127.0.0.1:{port}）当前未运行，可点击「启动本机 Magpie 网关」一键唤醒。"
        )
    } else if is_custom_remote {
        format!(
            "未能连接远程 Magpie 网关 {resolved_base}（{}）。若开启了局域网共享鉴权，请在下方填入 Gateway Key。",
            gateway_err.unwrap_or_else(|| "连接超时".into())
        )
    } else {
        "本机暂未检测到运行中的 Magpie 路由网关（默认监听 127.0.0.1:3425）。安装并登录 Magpie 后即可免配 Key 直接沿用全部模型与订阅。".to_string()
    };

    let report = MagpieProbeReport {
        cli_installed,
        config_found,
        gateway_online,
        base_url: resolved_base.clone(),
        port,
        version,
        recommended_model,
        groups,
        models,
        agent_bindings,
        message,
    };

    if gateway_online {
        if let Ok(mut guard) = runtime_cache().lock() {
            *guard = Some(RuntimeCacheEntry {
                at: Instant::now(),
                base_url: resolved_base,
                report: report.clone(),
            });
        }
    }

    report
}

/// 一键启动本机 Magpie 路由网关（优先尝试 `magpie daemon start`，若未生效则后台静默拉起 `magpie serve`）
pub async fn start_local_magpie_gateway(
    custom_base_url: Option<&str>,
    gateway_key: Option<&str>,
) -> Result<MagpieProbeReport> {
    let initial = probe_magpie(custom_base_url, gateway_key).await;
    if initial.gateway_online {
        return Ok(initial);
    }
    if !is_loopback_url(&initial.base_url) {
        bail!("当前填写的是局域网/远程网关地址（{}），请在对应主机上启动 Magpie 服务", initial.base_url);
    }

    let bin = tauri::async_runtime::spawn_blocking(locate_magpie_binary)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "未在本机找到 `magpie` 可执行程序。请先打开 Magpie 桌面客户端，或前往 https://usemagpie.ai 安装后再试"
            )
        })?;

    // 1. 优先尝试 `magpie daemon start`
    let bin_for_daemon = bin.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        run_magpie_cli_capture(&bin_for_daemon, &["daemon", "start"], Duration::from_millis(3000))
    })
    .await;

    tokio::time::sleep(Duration::from_millis(450)).await;
    let after_daemon = probe_magpie(Some(&initial.base_url), gateway_key).await;
    if after_daemon.gateway_online {
        return Ok(after_daemon);
    }

    // 2. 回退后台无窗口常驻启动 `magpie serve`
    let mut serve_cmd = Command::new(&bin);
    serve_cmd
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        serve_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    serve_cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("拉起 `magpie serve` 失败: {e}"))?;

    for _ in 0..9 {
        tokio::time::sleep(Duration::from_millis(380)).await;
        let check = probe_magpie(Some(&initial.base_url), gateway_key).await;
        if check.gateway_online {
            return Ok(check);
        }
    }

    bail!(
        "已尝试启动本机 Magpie 服务，但端口 127.0.0.1:{} 仍未就绪，请打开 Magpie 桌面应用确认状态",
        initial.port
    )
}

/// 供 `llm.rs` 在推理请求阶段快速解析 `auto` 模型与热备候选模型（带 20 秒内存 TTL 缓存，避免高频并发重复探测）
pub async fn resolve_runtime_models(base_url: &str, gateway_key: &str) -> Vec<String> {
    let norm_base = normalize_magpie_base_url(base_url);
    if let Ok(guard) = runtime_cache().lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.base_url == norm_base
                && entry.at.elapsed() < Duration::from_secs(20)
                && !entry.report.models.is_empty()
            {
                let mut out = Vec::new();
                if !entry.report.recommended_model.is_empty() {
                    out.push(entry.report.recommended_model.clone());
                }
                for m in &entry.report.models {
                    if !out.contains(m) {
                        out.push(m.clone());
                    }
                    if out.len() >= 3 {
                        break;
                    }
                }
                return out;
            }
        }
    }

    let report = probe_magpie(Some(&norm_base), Some(gateway_key)).await;
    let mut out = Vec::new();
    if !report.recommended_model.is_empty() {
        out.push(report.recommended_model);
    }
    for m in report.models {
        if !out.contains(&m) {
            out.push(m);
        }
        if out.len() >= 3 {
            break;
        }
    }
    out
}

/// 当本机回环调用遇到连接拒绝时，按 60 秒冷却窗口尝试静默唤醒一次本机已安装的 Magpie 网关
pub async fn try_auto_wake_once(base_url: &str, gateway_key: &str) -> bool {
    if !is_loopback_url(base_url) {
        return false;
    }
    let now = now_secs();
    let prev = LAST_AUTO_WAKE_SECS.load(Ordering::Relaxed);
    if prev > 0 && now.saturating_sub(prev) < 60 {
        return false;
    }
    LAST_AUTO_WAKE_SECS.store(now, Ordering::Relaxed);

    start_local_magpie_gateway(Some(base_url), Some(gateway_key))
        .await
        .map(|r| r.gateway_online)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_magpie_settings_and_normalizes_urls() {
        let (host, port) = parse_settings_host_and_port(r#"{"$version":4,"port":3425,"host":"0.0.0.0"}"#).unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 3425);

        assert_eq!(
            normalize_magpie_base_url("http://127.0.0.1:3425"),
            "http://127.0.0.1:3425/v1"
        );
        assert_eq!(
            normalize_magpie_base_url("192.168.1.20:3425/v1/chat/completions"),
            "http://192.168.1.20:3425/v1"
        );
        assert!(is_loopback_url("http://127.0.0.1:3425/v1"));
        assert!(!is_loopback_url("http://192.168.1.20:3425/v1"));
    }

    #[test]
    fn extracts_non_sensitive_catalog_and_ranks_routing_groups_first() {
        let providers_json = r#"{
            "providers": [
                {
                    "id": "deepseek",
                    "apiKey": "sk-should-never-be-read",
                    "models": [
                        {"id": "deepseek-chat", "on": true},
                        {"id": "deepseek-disabled", "on": false}
                    ]
                },
                {
                    "id": "openai",
                    "models": [
                        {"id": "text-embedding-3-small", "on": true},
                        {"id": "gpt-4.1-mini", "on": true}
                    ]
                }
            ],
            "groups": [
                {
                    "name": "Opus anywhere",
                    "models": ["claude/claude-opus-5-5", "copilot/claude-opus-5.5"],
                    "routing": "smart"
                }
            ]
        }"#;

        let (groups, models) = parse_providers_catalog_metadata(providers_json);
        assert_eq!(groups, vec!["group/opus-anywhere"]);
        assert!(models.contains(&"deepseek/deepseek-chat".to_string()));
        assert!(!models.contains(&"deepseek/deepseek-disabled".to_string()));

        let ls_json = r#"[{"name":"Claude Code","model":"magpie/deepseek/deepseek-chat"},{"name":"Codex","model":"unmanaged"}]"#;
        let bindings = parse_agent_bindings_json(ls_json);
        assert_eq!(
            bindings,
            vec![MagpieAgentBinding {
                agent: "Claude Code".into(),
                model: "deepseek/deepseek-chat".into()
            }]
        );

        let (ranked_groups, ranked_models, rec) =
            rank_and_recommend_models(&models, &groups, &bindings, true);
        assert_eq!(ranked_groups, vec!["group/opus-anywhere"]);
        // 已在其他 Agent 绑定的模型拥有最高沿用优先级
        assert_eq!(rec, "deepseek/deepseek-chat");
        // embedding 模型被自动过滤出对话候选列表
        assert!(!ranked_models.iter().any(|m| m.contains("embedding")));
    }
}
