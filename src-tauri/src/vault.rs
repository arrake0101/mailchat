//! 独立隐私凭据保险箱（Vault）：
//! 将邮箱授权码、各模型 API Key 与声明式配置文件（config.toml）及大模型上下文彻底隔离。
//! 在 Windows 下使用系统级 DPAPI（CryptProtectData，绑定当前系统登录用户）加密落盘。

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretStatus {
    pub key: String,
    pub label: String,
    pub category: String, // "mail" | "llm"
    pub configured: bool,
    pub masked: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretPrompt {
    pub key: String,
    pub label: String,
    pub hint: String,
    pub configured: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    scheme: String,
    entries: BTreeMap<String, String>,
}

pub struct Vault {
    path: PathBuf,
    cache: Mutex<BTreeMap<String, String>>,
}

pub const KNOWN_SECRETS: &[(&str, &str, &str)] = &[
    ("mail_password", "邮箱 IMAP/SMTP 授权码", "mail"),
    ("llm_deepseek", "DeepSeek 官网 API Key（优先推荐）", "llm"),
    ("llm_opencode_go", "OpenCode Go 订阅 API Key（优先推荐）", "llm"),
    ("llm_ollama_cloud", "Ollama 远程订阅 API Key（优先推荐）", "llm"),
    ("llm_ollama_remote", "Ollama 自建远程算力密钥（可选）", "llm"),
    ("llm_qwen", "通义千问 (百炼) API Key", "llm"),
    ("llm_openai", "OpenAI API Key", "llm"),
    ("llm_anthropic", "Anthropic Claude API Key", "llm"),
    ("llm_gemini", "Google Gemini API Key", "llm"),
    ("llm_kimi", "Moonshot Kimi API Key", "llm"),
    ("llm_siliconflow", "硅基流动 API Key", "llm"),
    ("llm_custom", "自定义网关 API Key", "llm"),
];

pub fn llm_secret_key(preset: &str) -> Option<&'static str> {
    match preset.trim().to_lowercase().as_str() {
        "ollama" => None,
        "opencode_go" => Some("llm_opencode_go"),
        "deepseek" => Some("llm_deepseek"),
        "openai" => Some("llm_openai"),
        "qwen" => Some("llm_qwen"),
        "anthropic" => Some("llm_anthropic"),
        "gemini" => Some("llm_gemini"),
        "kimi" => Some("llm_kimi"),
        "siliconflow" => Some("llm_siliconflow"),
        "ollama_cloud" => Some("llm_ollama_cloud"),
        "ollama_remote" => Some("llm_ollama_remote"),
        _ => Some("llm_custom"),
    }
}

pub fn mail_secret_key(email: &str) -> String {
    let clean = email.trim().to_lowercase();
    if clean.is_empty() {
        "mail_password".to_string()
    } else {
        format!("mail_pwd:{clean}")
    }
}

pub fn secret_label(key: &str) -> String {
    let clean = key.trim().trim_start_matches("secret:");
    if let Some(email) = clean.strip_prefix("mail_pwd:") {
        let em = email.trim();
        if !em.is_empty() {
            return format!("邮箱授权码 ({em})");
        }
    }
    KNOWN_SECRETS
        .iter()
        .find(|(k, _, _)| *k == clean)
        .map(|(_, label, _)| (*label).to_string())
        .unwrap_or_else(|| clean.to_string())
}

fn mask_value(key: &str, val: &str) -> String {
    let chars: Vec<char> = val.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if key == "mail_password" || key.starts_with("mail_pwd:") || chars.len() < 9 {
        return format!("已加密 ({} 位)", chars.len());
    }
    let prefix: String = chars.iter().take(3).collect();
    let suffix: String = chars.iter().skip(chars.len() - 3).collect();
    format!("{prefix}••••{suffix}")
}

impl Vault {
    pub fn open(app_dir: &Path) -> Result<Self> {
        let path = app_dir.join("secrets.vault.json");
        let mut map = BTreeMap::new();
        if path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(vf) = serde_json::from_str::<VaultFile>(&raw) {
                    for (k, enc_hex) in vf.entries {
                        if let Ok(bytes) = hex_decode(&enc_hex) {
                            if let Ok(plain) = unprotect_bytes(&bytes) {
                                if let Ok(s) = String::from_utf8(plain) {
                                    if !s.is_empty() {
                                        map.insert(k, s);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(Self {
            path,
            cache: Mutex::new(map),
        })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let clean = key.trim().trim_start_matches("secret:");
        self.cache.lock().unwrap().get(clean).cloned().filter(|s| !s.is_empty())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let clean = key.trim().trim_start_matches("secret:").to_string();
        if clean.is_empty() {
            return Err(anyhow!("凭据键名不能为空"));
        }
        {
            let mut guard = self.cache.lock().unwrap();
            if value.trim().is_empty() {
                guard.remove(&clean);
            } else {
                guard.insert(clean, value.trim().to_string());
            }
        }
        self.persist()
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.set(key, "")
    }

    #[allow(dead_code)]
    pub fn statuses(&self) -> Vec<SecretStatus> {
        self.statuses_for_accounts(&[])
    }

    pub fn statuses_for_accounts(&self, account_emails: &[String]) -> Vec<SecretStatus> {
        let guard = self.cache.lock().unwrap();
        let mut out = Vec::new();

        let mut seen_emails: Vec<String> = Vec::new();
        for raw in account_emails {
            let em = raw.trim().to_lowercase();
            if !em.is_empty() && !seen_emails.contains(&em) {
                seen_emails.push(em);
            }
        }
        for k in guard.keys() {
            if let Some(em) = k.strip_prefix("mail_pwd:") {
                let clean = em.trim().to_lowercase();
                if !clean.is_empty() && !seen_emails.contains(&clean) {
                    seen_emails.push(clean);
                }
            }
        }

        if seen_emails.is_empty() {
            let val = guard.get("mail_password").map(|s| s.as_str()).unwrap_or("");
            out.push(SecretStatus {
                key: "mail_password".to_string(),
                label: "邮箱 IMAP/SMTP 授权码".to_string(),
                category: "mail".to_string(),
                configured: !val.is_empty(),
                masked: mask_value("mail_password", val),
            });
        } else {
            for em in seen_emails {
                let key = mail_secret_key(&em);
                let val = guard.get(&key).map(|s| s.as_str()).unwrap_or("");
                out.push(SecretStatus {
                    label: secret_label(&key),
                    configured: !val.is_empty(),
                    masked: mask_value(&key, val),
                    key,
                    category: "mail".to_string(),
                });
            }
        }

        for (key, label, category) in KNOWN_SECRETS {
            if *category == "mail" {
                continue;
            }
            let val = guard.get(*key).map(|s| s.as_str()).unwrap_or("");
            out.push(SecretStatus {
                key: (*key).to_string(),
                label: (*label).to_string(),
                category: (*category).to_string(),
                configured: !val.is_empty(),
                masked: mask_value(key, val),
            });
        }

        out
    }

    fn persist(&self) -> Result<()> {
        let guard = self.cache.lock().unwrap();
        let mut entries = BTreeMap::new();
        for (k, v) in guard.iter() {
            if !v.is_empty() {
                let enc = protect_bytes(v.as_bytes())?;
                entries.insert(k.clone(), hex_encode(&enc));
            }
        }
        let vf = VaultFile {
            version: 1,
            scheme: current_scheme().into(),
            entries,
        };
        std::fs::write(&self.path, serde_json::to_string_pretty(&vf)?)?;
        Ok(())
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    let clean = s.trim();
    if clean.len() % 2 != 0 {
        return Err(anyhow!("invalid hex length"));
    }
    (0..clean.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&clean[i..i + 2], 16).map_err(|e| anyhow!(e)))
        .collect()
}

#[cfg(target_os = "windows")]
fn current_scheme() -> &'static str {
    "windows-dpapi"
}

#[cfg(not(target_os = "windows"))]
fn current_scheme() -> &'static str {
    "local-obfuscated"
}

#[cfg(target_os = "windows")]
mod dpapi {
    use anyhow::{anyhow, Result};
    use core::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
        let mut input_buf = plain.to_vec();
        let in_blob = DataBlob {
            cb_data: input_buf.len() as u32,
            pb_data: input_buf.as_mut_ptr(),
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err(anyhow!("Windows DPAPI 加密凭据失败"));
        }
        let out = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec() };
        unsafe {
            LocalFree(out_blob.pb_data as *mut c_void);
        }
        Ok(out)
    }

    pub fn unprotect(enc: &[u8]) -> Result<Vec<u8>> {
        let mut input_buf = enc.to_vec();
        let in_blob = DataBlob {
            cb_data: input_buf.len() as u32,
            pb_data: input_buf.as_mut_ptr(),
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err(anyhow!("Windows DPAPI 解密凭据失败"));
        }
        let out = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec() };
        unsafe {
            LocalFree(out_blob.pb_data as *mut c_void);
        }
        Ok(out)
    }
}

#[cfg(target_os = "windows")]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>> {
    dpapi::protect(plain)
}

#[cfg(target_os = "windows")]
fn unprotect_bytes(enc: &[u8]) -> Result<Vec<u8>> {
    dpapi::unprotect(enc)
}

#[cfg(not(target_os = "windows"))]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.iter().map(|b| b ^ 0x5A).collect())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_bytes(enc: &[u8]) -> Result<Vec<u8>> {
    Ok(enc.iter().map(|b| b ^ 0x5A).collect())
}
