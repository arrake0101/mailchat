//! 邮件协议层：IMAP 增量收取、单聊与多人邮件群聊聚合（Chat-Group-ID / 线程 / 多收件人）、
//! MIME/HTML 解析、引用剥离、验证码提取、SMTP 多收件人（Reply-All）发送。

use crate::agent::apply_rules;
use crate::db::{
    default_group_title, normalize_members, Account, AttachmentMeta, Db, GroupMember, NewMessage,
    Rule,
};
use anyhow::{anyhow, Context, Result};
use imap_proto::types::{
    BodyContentCommon, BodyStructure, ContentEncoding, MessageSection, SectionPath,
};
use mail_parser::{Addr, HeaderValue, MessageParser, MimeHeaders, PartType};
use regex::Regex;
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 包装 TLS 流并实现 `SetReadTimeout`，支持安全进入与退出 RFC 2177 IMAP IDLE 推送模式。
pub struct ImapStream(native_tls::TlsStream<TcpStream>);

impl Read for ImapStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for ImapStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl imap::extensions::idle::SetReadTimeout for ImapStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> imap::error::Result<()> {
        // 当 IDLE Handle 退出传入 None 时恢复 30s 默认超时而非无限阻塞，防止 NAT 半开死连接卡住线程
        let effective = timeout.or(Some(Duration::from_secs(30)));
        self.0
            .get_ref()
            .set_read_timeout(effective)
            .map_err(imap::error::Error::Io)
    }
}

type Session = imap::Session<ImapStream>;

/// 首次同步时每个文件夹最多拉取的邮件数
const INITIAL_FETCH: usize = 200;

pub struct SyncOutcome {
    pub new_incoming: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEvent {
    /// 收到服务端实时推送的邮箱变更（如 `* N EXISTS` / `* N RECENT`）
    Changed,
    /// IDLE 保活周期正常届满，连接健康存活
    IdleKeepalive,
    /// 服务端在运行期拒绝了 IDLE（外层应重建连接并降级为热会话快速轮询）
    IdleRejected,
}

pub struct RealtimeSession {
    session: Session,
    host_key: String,
    supports_idle: bool,
    sent_folder: Option<Option<String>>,
}

fn idle_disabled_hosts() -> &'static Mutex<HashSet<String>> {
    static HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_idle_disabled(host_key: &str) -> bool {
    idle_disabled_hosts()
        .lock()
        .map(|s| s.contains(host_key))
        .unwrap_or(false)
}

fn mark_idle_disabled(host_key: &str) {
    if let Ok(mut s) = idle_disabled_hosts().lock() {
        s.insert(host_key.to_string());
    }
}

pub struct RawAttachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub struct ParsedMail {
    pub msg: NewMessage,
    pub participants: Vec<GroupMember>,
    pub ref_ids: Vec<String>,
    pub group_id_hdr: Option<String>,
    pub group_name_hdr: Option<String>,
    pub quote_mid_hdr: Option<String>,
    #[allow(dead_code)]
    pub raw_attachments: Vec<RawAttachment>,
}

fn needs_imap_id(host: &str) -> bool {
    let h = host.trim().to_lowercase();
    h.contains("163.com")
        || h.contains("126.com")
        || h.contains("yeah.net")
        || h.contains("188.com")
        || h.contains("netease.com")
}

fn connect_login_once(acc: &Account) -> Result<(Session, TcpStream)> {
    let host = acc.imap_host.trim();
    let addr = (host, acc.imap_port)
        .to_socket_addrs()
        .with_context(|| format!("无法解析 IMAP 服务器地址 {host}:{}", acc.imap_port))?
        .next()
        .ok_or_else(|| anyhow!("无法解析 IMAP 服务器地址 {host}"))?;

    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(12))
        .with_context(|| format!("无法连接 IMAP 服务器 {host}:{}", acc.imap_port))?;
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(20)));
    let tcp_ctl = tcp.try_clone().context("复制 IMAP 套接字控制句柄失败")?;

    let tls = native_tls::TlsConnector::builder().build()?;
    let tls_stream = tls
        .connect(host, tcp)
        .with_context(|| format!("IMAP SSL/TLS 握手失败 ({host})"))?;

    let mut client = imap::Client::new(ImapStream(tls_stream));
    client
        .read_greeting()
        .context("读取 IMAP 服务器欢迎响应失败")?;

    let session = client
        .login(acc.username.trim(), acc.password.trim())
        .map_err(|(e, _)| anyhow!("IMAP 登录失败（请检查邮箱授权码/应用专用密码）: {e}"))?;

    Ok((session, tcp_ctl))
}

fn connect_with_control(acc: &Account) -> Result<(Session, TcpStream)> {
    let (mut session, mut tcp_ctl) = connect_login_once(acc)?;

    // 仅对网易系邮箱发送 RFC 2971 IMAP ID（imap-proto 0.16 原生解析 `* ID (...)` 响应；
    // 若非标服务端返回异常帧导致 ID 命令报错，立即重建干净连接，确保命令序号 tag 绝不错位）
    if needs_imap_id(&acc.imap_host) {
        if session
            .run_command_and_check_ok(r#"ID ("name" "MailChat" "version" "0.2.0" "vendor" "MailChat")"#)
            .is_err()
        {
            (session, tcp_ctl) = connect_login_once(acc)?;
        }
    }
    Ok((session, tcp_ctl))
}

fn connect(acc: &Account) -> Result<Session> {
    connect_with_control(acc).map(|(s, _)| s)
}

pub(crate) fn session_supports_idle_on<S: Read + Write>(session: &mut imap::Session<S>) -> bool {
    let Ok(caps) = session.capabilities() else {
        return false;
    };
    caps.has_str("IDLE")
        || caps.iter().any(|c| match c {
            imap_proto::Capability::Atom(a) => a.eq_ignore_ascii_case("IDLE"),
            _ => false,
        })
}

fn drain_change_signals<S: Read + Write>(session: &mut imap::Session<S>) -> (bool, bool) {
    let mut changed = false;
    let mut bye = false;
    for resp in session.take_all_unsolicited() {
        match resp {
            imap::types::UnsolicitedResponse::Exists(_)
            | imap::types::UnsolicitedResponse::Recent(_)
            | imap::types::UnsolicitedResponse::Expunge(_)
            | imap::types::UnsolicitedResponse::Vanished { .. }
            | imap::types::UnsolicitedResponse::Fetch { .. }
            | imap::types::UnsolicitedResponse::Status { .. } => changed = true,
            imap::types::UnsolicitedResponse::Bye { .. } => bye = true,
            _ => {}
        }
    }
    (changed, bye)
}

pub(crate) fn wait_for_inbox_event_on<S>(
    session: &mut imap::Session<S>,
    idle_timeout: Duration,
) -> Result<WatchEvent>
where
    S: Read + Write + imap::extensions::idle::SetReadTimeout,
{
    let (queued_change, queued_bye) = drain_change_signals(session);
    if queued_bye {
        return Err(anyhow!("IMAP 服务端已主动断开连接 (BYE)"));
    }
    if queued_change {
        return Ok(WatchEvent::Changed);
    }

    let mut got_bye = false;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut handle = session.idle();
        handle.timeout(idle_timeout);
        handle.keepalive(false);
        handle.wait_while(|resp| match resp {
            imap::types::UnsolicitedResponse::Bye { .. } => {
                got_bye = true;
                false
            }
            imap::types::UnsolicitedResponse::Ok { .. }
            | imap::types::UnsolicitedResponse::Flags(_)
            | imap::types::UnsolicitedResponse::Metadata { .. } => true,
            _ => false,
        })
    }));

    if got_bye {
        return Err(anyhow!("IMAP IDLE 监听期间服务端关闭了连接 (BYE)"));
    }

    match outcome {
        Ok(Ok(imap::extensions::idle::WaitOutcome::MailboxChanged)) => Ok(WatchEvent::Changed),
        Ok(Ok(imap::extensions::idle::WaitOutcome::TimedOut)) => {
            let (changed, bye) = drain_change_signals(session);
            if bye {
                Err(anyhow!("IMAP 保活结束时服务端关闭了连接 (BYE)"))
            } else if changed {
                Ok(WatchEvent::Changed)
            } else {
                Ok(WatchEvent::IdleKeepalive)
            }
        }
        Ok(Err(imap::error::Error::Bad(_))) | Ok(Err(imap::error::Error::No(_))) | Err(_) => {
            Ok(WatchEvent::IdleRejected)
        }
        Ok(Err(e)) => Err(anyhow!("IMAP IDLE 连接中断: {e}")),
    }
}

impl RealtimeSession {
    pub fn connect(acc: &Account) -> Result<(Self, TcpStream)> {
        let (mut session, tcp_ctl) = connect_with_control(acc)?;
        let host_key = acc.imap_host.trim().to_ascii_lowercase();
        let supports_idle = !is_idle_disabled(&host_key) && session_supports_idle_on(&mut session);
        session.select("INBOX").context("打开 INBOX 失败")?;
        Ok((
            Self {
                session,
                host_key,
                supports_idle,
                sent_folder: None,
            },
            tcp_ctl,
        ))
    }

    pub fn supports_idle(&self) -> bool {
        self.supports_idle
    }

    pub fn sync_inbox(&mut self, acc: &Account, db: &Db, agent_enabled: bool) -> Result<usize> {
        let rules = db.rules()?;
        sync_folder_on(&mut self.session, "INBOX", false, acc, db, &rules, agent_enabled)
    }

    pub fn sync_sent(&mut self, acc: &Account, db: &Db, agent_enabled: bool) -> Result<usize> {
        let folder = match &self.sent_folder {
            Some(cached) => cached.clone(),
            None => {
                let found = find_sent_folder(&mut self.session);
                self.sent_folder = Some(found.clone());
                found
            }
        };
        let mut added = 0;
        if let Some(sent) = folder {
            let rules = db.rules()?;
            added = sync_folder_on(&mut self.session, &sent, true, acc, db, &rules, agent_enabled)?;
            // 同步完“已发送”后重新切回 INBOX，确保后续 IDLE / NOOP 始终驻留在收件箱上
            self.session.select("INBOX").context("重新选中 INBOX 失败")?;
        }
        Ok(added)
    }

    /// 增量回填当前账号下旧版入库但未保存 `body_html` 的历史邮件，完成后确保会话仍停留在 INBOX
    pub fn backfill_missing_html(
        &mut self,
        acc: &Account,
        db: &Db,
        batch_size: usize,
    ) -> Result<(usize, usize)> {
        let (checked, enriched, touched_non_inbox) =
            backfill_html_on(&mut self.session, &acc.email, db, batch_size)?;
        if touched_non_inbox {
            self.session.select("INBOX").context("重新选中 INBOX 失败")?;
        }
        Ok((checked, enriched))
    }

    pub fn wait_idle(&mut self, timeout: Duration) -> Result<WatchEvent> {
        let ev = wait_for_inbox_event_on(&mut self.session, timeout)?;
        if ev == WatchEvent::IdleRejected {
            mark_idle_disabled(&self.host_key);
            self.supports_idle = false;
        }
        Ok(ev)
    }

    pub fn noop_check(&mut self) -> Result<bool> {
        self.session.noop().context("IMAP NOOP 检查失败")?;
        let (changed, bye) = drain_change_signals(&mut self.session);
        if bye {
            return Err(anyhow!("IMAP NOOP 收到服务端 BYE"));
        }
        Ok(changed)
    }

    pub fn logout(mut self) {
        let _ = self.session.logout();
    }
}

/// 测试账号配置：IMAP 登录 + SMTP 认证
pub fn test_account(acc: &Account) -> Result<()> {
    let mut s = connect(acc)?;
    s.select("INBOX").context("打开 INBOX 失败")?;
    let _ = s.logout();
    smtp_transport(acc)?
        .test_connection()
        .context("SMTP 连接或认证失败")?;
    Ok(())
}

fn find_sent_folder<S: Read + Write>(session: &mut imap::Session<S>) -> Option<String> {
    let names = session.list(None, Some("*")).ok()?;
    for n in names.iter() {
        let is_sent = n.attributes().iter().any(|a| match a {
            imap_proto::NameAttribute::Sent => true,
            imap_proto::NameAttribute::Extension(s) => s.eq_ignore_ascii_case("\\Sent"),
            _ => false,
        });
        if is_sent {
            return Some(n.name().to_string());
        }
    }
    // 没有 SPECIAL-USE 时按常见名字匹配（&XfJT0ZAB- 是“已发送”的 modified UTF-7 编码）
    let candidates = ["Sent", "Sent Messages", "Sent Items", "INBOX.Sent", "&XfJT0ZAB-"];
    names
        .iter()
        .map(|n| n.name().to_string())
        .find(|name| candidates.iter().any(|c| c.eq_ignore_ascii_case(name)))
}

pub fn sync_with_hook<F>(acc: &Account, db: &Db, agent_enabled: bool, mut on_inbox_new: F) -> Result<SyncOutcome>
where
    F: FnMut(usize),
{
    let mut session = connect(acc)?;
    let rules = db.rules()?;
    let mut new_incoming = sync_folder_on(&mut session, "INBOX", false, acc, db, &rules, agent_enabled)?;
    if new_incoming > 0 {
        on_inbox_new(new_incoming);
    }
    if let Some(sent) = find_sent_folder(&mut session) {
        new_incoming += sync_folder_on(&mut session, &sent, true, acc, db, &rules, agent_enabled)?;
    }
    if let Ok((_, enriched, _)) = backfill_html_on(&mut session, &acc.email, db, 40) {
        if enriched > 0 && new_incoming == 0 {
            on_inbox_new(0);
        }
    }
    let _ = session.logout();
    Ok(SyncOutcome { new_incoming })
}

#[allow(dead_code)]
pub fn sync(acc: &Account, db: &Db, agent_enabled: bool) -> Result<SyncOutcome> {
    sync_with_hook(acc, db, agent_enabled, |_| {})
}

fn participant_group_key(others: &[GroupMember]) -> String {
    let mut emails: Vec<&str> = others.iter().map(|m| m.email.as_str()).collect();
    emails.sort_unstable();
    let mut hasher = DefaultHasher::new();
    emails.join(",").hash(&mut hasher);
    format!("group:auto-{:016x}", hasher.finish())
}

fn mentions_me(body: &str, acc: &Account) -> bool {
    let lower = body.to_lowercase();
    let email = acc.email.trim().to_lowercase();
    if !email.is_empty() && lower.contains(&format!("@{email}")) {
        return true;
    }
    if let Some(local) = email.split('@').next().filter(|s| !s.is_empty()) {
        if lower.contains(&format!("@{local}")) {
            return true;
        }
    }
    let disp = acc.display_name.trim().to_lowercase();
    !disp.is_empty() && lower.contains(&format!("@{disp}"))
}

#[derive(Debug, Clone)]
struct LeafPartInfo {
    section_nums: Vec<u32>,
    part_id: String,
    is_single_root: bool,
    ty: String,
    subtype: String,
    declared_mime: String,
    is_explicit_attachment: bool,
    param_filename: Option<String>,
    content_id: Option<String>,
    encoding: String,
    octets: usize,
}

#[derive(Debug, Default)]
struct StructurePlan {
    body_parts: Vec<LeafPartInfo>,
    cid_parts: Vec<LeafPartInfo>,
    att_parts: Vec<LeafPartInfo>,
}

fn content_encoding_label(enc: &ContentEncoding<'_>) -> String {
    match enc {
        ContentEncoding::SevenBit => "7bit".to_string(),
        ContentEncoding::EightBit => "8bit".to_string(),
        ContentEncoding::Binary => "binary".to_string(),
        ContentEncoding::Base64 => "base64".to_string(),
        ContentEncoding::QuotedPrintable => "quoted-printable".to_string(),
        ContentEncoding::Other(s) => s.trim().to_ascii_lowercase(),
    }
}

fn estimate_decoded_bytes(octets: usize, encoding: &str) -> usize {
    if octets == 0 {
        return 0;
    }
    if encoding.eq_ignore_ascii_case("base64") {
        // 标准 MIME Base64 每行 76 字符 + CRLF（78 octets 对应 57 原始字节）
        if octets >= 78 {
            (octets * 57) / 78
        } else {
            (octets * 3) / 4
        }
    } else {
        octets
    }
}

fn find_body_param(
    params: &Option<Vec<(std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)>>,
    keys: &[&str],
) -> Option<String> {
    let list = params.as_ref()?;
    for target in keys {
        for (k, v) in list {
            if k.eq_ignore_ascii_case(target) && !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    // 兼容 RFC 2231 分片参数（如 filename*0 / filename*0* / name*0）
    let mut chunks: Vec<(usize, String)> = Vec::new();
    for (k, v) in list {
        let lower = k.to_ascii_lowercase();
        for base in ["filename*", "name*"] {
            if let Some(rest) = lower.strip_prefix(base) {
                let digits = rest.trim_end_matches('*');
                if let Ok(idx) = digits.parse::<usize>() {
                    chunks.push((idx, v.to_string()));
                }
            }
        }
    }
    if !chunks.is_empty() {
        chunks.sort_by_key(|(i, _)| *i);
        let joined: String = chunks.into_iter().map(|(_, s)| s).collect();
        if !joined.trim().is_empty() {
            return Some(joined);
        }
    }
    None
}

fn extract_bs_raw_filename(common: &BodyContentCommon<'_>) -> Option<String> {
    if let Some(disp) = &common.disposition {
        if let Some(name) = find_body_param(&disp.params, &["filename*", "filename"]) {
            return Some(name);
        }
    }
    find_body_param(&common.ty.params, &["name*", "name", "filename*", "filename"])
}

fn decode_mime_param_filename(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // 处理 RFC 2231 形如 UTF-8''%E6%B4%BE%E5%8F%91.docx
    if let Some(idx) = trimmed.find("''") {
        let charset = trimmed[..idx].to_ascii_lowercase();
        let pct_part = &trimmed[idx + 2..];
        if charset.contains("utf-8") || charset.contains("utf8") {
            let decoded = percent_decode_bytes(pct_part);
            if let Ok(s) = String::from_utf8(decoded) {
                if !s.trim().is_empty() {
                    return s;
                }
            }
        }
    }
    // 借助 mail-parser 解码 RFC 2047（=?UTF-8?B?...?= / =?GB18030?B?...?= 等）
    if trimmed.contains("=?") {
        let safe_val = trimmed.replace('"', "");
        let syn = format!(
            "Content-Disposition: attachment; filename=\"{safe_val}\"\r\n\r\nx"
        );
        if let Some(m) = MessageParser::default().parse(syn.as_bytes()) {
            if let Some(p) = m.parts.first() {
                if let Some(decoded) = p.attachment_name() {
                    if !decoded.trim().is_empty() {
                        return decoded.to_string();
                    }
                }
            }
        }
    }
    trimmed.to_string()
}

fn percent_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn collect_leaf_parts(
    bs: &BodyStructure<'_>,
    prefix: &[u32],
    is_root: bool,
    out: &mut Vec<LeafPartInfo>,
) {
    match bs {
        BodyStructure::Multipart { bodies, .. } => {
            for (idx, child) in bodies.iter().enumerate() {
                let mut next = Vec::with_capacity(prefix.len() + 1);
                next.extend_from_slice(prefix);
                next.push((idx + 1) as u32);
                collect_leaf_parts(child, &next, false, out);
            }
        }
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        | BodyStructure::Message { common, other, .. } => {
            let section_nums = if is_root { vec![1] } else { prefix.to_vec() };
            let part_id = section_nums
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(".");
            let ty = common.ty.ty.trim().to_ascii_lowercase();
            let subtype = common.ty.subtype.trim().to_ascii_lowercase();
            let declared_mime = if subtype.is_empty() {
                ty.clone()
            } else {
                format!("{ty}/{subtype}")
            };
            let is_explicit_attachment = common
                .disposition
                .as_ref()
                .map(|d| d.ty.eq_ignore_ascii_case("attachment"))
                .unwrap_or(false);
            let param_filename = extract_bs_raw_filename(common);
            let content_id = other
                .id
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let encoding = content_encoding_label(&other.transfer_encoding);
            let octets = other.octets as usize;

            out.push(LeafPartInfo {
                section_nums,
                part_id,
                is_single_root: is_root,
                ty,
                subtype,
                declared_mime,
                is_explicit_attachment,
                param_filename,
                content_id,
                encoding,
                octets,
            });
        }
    }
}

fn plan_bodystructure(bs: &BodyStructure<'_>) -> StructurePlan {
    let mut leaves = Vec::new();
    collect_leaf_parts(bs, &[], true, &mut leaves);

    let has_html_body = leaves.iter().any(|p| {
        p.ty == "text"
            && p.subtype == "html"
            && !p.is_explicit_attachment
            && p.param_filename.is_none()
    });

    let mut plan = StructurePlan::default();
    for p in leaves {
        let is_body_text = p.ty == "text"
            && (p.subtype == "plain" || p.subtype == "html")
            && !p.is_explicit_attachment
            && p.param_filename.is_none();
        if is_body_text {
            if p.octets <= 2_000_000 {
                plan.body_parts.push(p);
            }
            continue;
        }

        // 富 HTML 中的小尺寸内联 cid: 装饰图标（非 attachment 处置），仅内联进内存 HTML，不列为文件附件
        let is_inline_cid_decor = has_html_body
            && p.ty == "image"
            && p.content_id.is_some()
            && !p.is_explicit_attachment
            && p.octets <= 700_000;
        if is_inline_cid_decor {
            plan.cid_parts.push(p);
            continue;
        }

        if p.octets > 0 {
            plan.att_parts.push(p);
        }
    }
    plan
}

fn combine_mime_header_and_body(mime_hdr: &[u8], body_bytes: &[u8], fallback_mime: &str, fallback_enc: &str) -> Vec<u8> {
    if mime_hdr.is_empty() {
        let mut syn = format!(
            "Content-Type: {}\r\nContent-Transfer-Encoding: {}\r\n\r\n",
            if fallback_mime.is_empty() { "application/octet-stream" } else { fallback_mime },
            if fallback_enc.is_empty() { "binary" } else { fallback_enc }
        )
        .into_bytes();
        syn.extend_from_slice(body_bytes);
        return syn;
    }
    let mut buf = Vec::with_capacity(mime_hdr.len() + 4 + body_bytes.len());
    buf.extend_from_slice(mime_hdr);
    if buf.ends_with(b"\r\n\r\n") || buf.ends_with(b"\n\n") {
        // 已包含标准空行分隔
    } else if buf.ends_with(b"\r\n") {
        buf.extend_from_slice(b"\r\n");
    } else if buf.ends_with(b"\n") {
        buf.extend_from_slice(b"\n");
    } else {
        buf.extend_from_slice(b"\r\n\r\n");
    }
    buf.extend_from_slice(body_bytes);
    buf
}

fn decode_transfer_fallback(raw: &[u8], encoding: &str) -> Vec<u8> {
    if encoding.eq_ignore_ascii_case("base64") {
        if let Ok(s) = std::str::from_utf8(raw) {
            if let Ok(decoded) = base64_decode(s) {
                return decoded;
            }
        }
        // 容错逐字节过滤非 Base64 字符
        let filtered: String = raw
            .iter()
            .copied()
            .filter(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'-' | b'_' | b'='))
            .map(|b| b as char)
            .collect();
        if let Ok(decoded) = base64_decode(&filtered) {
            return decoded;
        }
    } else if encoding.eq_ignore_ascii_case("quoted-printable") {
        return quoted_printable_decode(raw);
    }
    raw.to_vec()
}

fn quoted_printable_decode(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'=' {
            if i + 2 < raw.len() && raw[i + 1] == b'\r' && raw[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if i + 1 < raw.len() && raw[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if i + 2 < raw.len() {
                let hi = (raw[i + 1] as char).to_digit(16);
                let lo = (raw[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push(((h << 4) | l) as u8);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

fn decode_binary_section(mime_hdr: &[u8], raw_body: &[u8], fallback_mime: &str, fallback_enc: &str) -> Vec<u8> {
    let combined = combine_mime_header_and_body(mime_hdr, raw_body, fallback_mime, fallback_enc);
    if let Some(msg) = MessageParser::default().parse(&combined) {
        for p in &msg.parts {
            match &p.body {
                PartType::Binary(b) | PartType::InlineBinary(b) if !b.is_empty() => {
                    return b.to_vec();
                }
                PartType::Text(t) | PartType::Html(t) if !t.is_empty() => {
                    return t.as_bytes().to_vec();
                }
                _ => {}
            }
        }
    }
    decode_transfer_fallback(raw_body, fallback_enc)
}

fn decode_text_section(mime_hdr: &[u8], raw_body: &[u8], subtype: &str, encoding: &str) -> String {
    let fallback_mime = format!("text/{subtype}; charset=utf-8");
    let combined = combine_mime_header_and_body(mime_hdr, raw_body, &fallback_mime, encoding);
    if let Some(msg) = MessageParser::default().parse(&combined) {
        if subtype == "html" {
            if let Some(h) = msg.body_html(0) {
                return h.into_owned();
            }
        }
        if let Some(t) = msg.body_text(0) {
            return t.into_owned();
        }
        for p in &msg.parts {
            match &p.body {
                PartType::Html(h) if subtype == "html" => return h.to_string(),
                PartType::Text(t) => return t.to_string(),
                _ => {}
            }
        }
    }
    let bytes = decode_transfer_fallback(raw_body, encoding);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// 仅拉取邮件头、正文文本分段与附件的 ~150B MIME 头（绝不拉取附件二进制内容，绝不写入本地磁盘）
fn fetch_partial_mail_without_attachments<S: Read + Write>(
    session: &mut imap::Session<S>,
    uid: u32,
    cached_header: Option<&[u8]>,
    plan: &StructurePlan,
    folder: &str,
    validity: u32,
) -> Result<Option<ParsedMail>> {
    const MAX_ATT_COUNT: usize = 12;

    let mut items: Vec<String> = vec!["UID".to_string()];
    if cached_header.is_none() {
        items.push("BODY.PEEK[HEADER]".to_string());
    }
    for bp in &plan.body_parts {
        if !bp.is_single_root {
            items.push(format!("BODY.PEEK[{}.MIME]", bp.part_id));
        }
        items.push(format!("BODY.PEEK[{}]", bp.part_id));
    }
    for cp in &plan.cid_parts {
        if !cp.is_single_root {
            items.push(format!("BODY.PEEK[{}.MIME]", cp.part_id));
        }
        items.push(format!("BODY.PEEK[{}]", cp.part_id));
    }
    for ap in plan.att_parts.iter().take(MAX_ATT_COUNT) {
        if !ap.is_single_root {
            items.push(format!("BODY.PEEK[{}.MIME]", ap.part_id));
        }
    }

    let need_fetch = items.len() > 1;
    let fetches_opt = if need_fetch {
        let query = format!("({})", items.join(" "));
        Some(session.uid_fetch(uid.to_string(), &query)?)
    } else {
        None
    };
    let fetch_ref = fetches_opt.as_ref().and_then(|fs| fs.iter().next());

    let hdr_bytes: &[u8] = match cached_header.or_else(|| fetch_ref.and_then(|f| f.header())) {
        Some(h) if !h.is_empty() => h,
        _ => return Ok(None),
    };

    // 确保顶层邮件头末尾带空行以便 mail-parser 解析信封字段
    let hdr_block = combine_mime_header_and_body(hdr_bytes, b"", "text/plain", "7bit");
    let Some(hdr_msg) = MessageParser::default().parse(&hdr_block) else {
        return Ok(None);
    };

    let from = hdr_msg.from().and_then(|a| a.first());
    let from_addr = from
        .and_then(|a| a.address())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if from_addr.is_empty() {
        return Ok(None);
    }
    let from_name = from.and_then(|a| a.name()).unwrap_or("").trim().to_string();
    let (to_addrs, to_members) = collect_addrs(hdr_msg.to());
    let (cc_addrs, cc_members) = collect_addrs(hdr_msg.cc());

    let mut participants = Vec::with_capacity(1 + to_members.len() + cc_members.len());
    participants.push(GroupMember {
        email: from_addr.clone(),
        name: from_name.clone(),
    });
    participants.extend(to_members);
    participants.extend(cc_members);

    let message_id = hdr_msg
        .message_id()
        .map(|s| s.trim_matches(&['<', '>', ' '][..]).to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("local-{validity}-{uid}@{folder}"));

    let in_reply_ids = header_ids(hdr_msg.in_reply_to());
    let reference_ids = header_ids(hdr_msg.references());
    let mut ref_ids = reference_ids.clone();
    for id in &in_reply_ids {
        if !ref_ids.contains(id) {
            ref_ids.push(id.clone());
        }
    }

    let group_id_hdr = header_text(&hdr_msg, "Chat-Group-ID")
        .or_else(|| header_text(&hdr_msg, "X-MailChat-Group-Id"));
    let group_name_hdr = header_text(&hdr_msg, "Chat-Group-Name")
        .or_else(|| header_text(&hdr_msg, "X-MailChat-Group-Name"));
    let quote_mid_hdr = header_text(&hdr_msg, "X-MailChat-Quote-Id");

    let mut plain_chunks: Vec<String> = Vec::new();
    let mut html_chunks: Vec<String> = Vec::new();
    if let Some(f) = fetch_ref {
        for bp in &plan.body_parts {
            let body_sp = SectionPath::Part(bp.section_nums.clone(), None);
            let Some(raw_part) = f.section(&body_sp) else {
                continue;
            };
            let mime_hdr = if bp.is_single_root {
                hdr_bytes
            } else {
                let mime_sp = SectionPath::Part(bp.section_nums.clone(), Some(MessageSection::Mime));
                f.section(&mime_sp).unwrap_or(b"")
            };
            let text = decode_text_section(mime_hdr, raw_part, &bp.subtype, &bp.encoding);
            if !text.trim().is_empty() {
                if bp.subtype == "html" {
                    html_chunks.push(text);
                } else {
                    plain_chunks.push(text);
                }
            }
        }
    }

    let mut body_html = html_chunks.join("\n").trim().to_string();
    if body_html.len() > 1_500_000 {
        body_html.clear();
    } else if !body_html.is_empty() && !plan.cid_parts.is_empty() {
        let has_cid_ref = body_html
            .as_bytes()
            .windows(4)
            .any(|w| w.eq_ignore_ascii_case(b"cid:"));
        if has_cid_ref {
            if let Some(f) = fetch_ref {
                let mut cid_assets: Vec<(String, String, Vec<u8>)> = Vec::new();
                for cp in &plan.cid_parts {
                    let Some(raw_cid) = &cp.content_id else { continue };
                    let body_sp = SectionPath::Part(cp.section_nums.clone(), None);
                    let Some(raw_part) = f.section(&body_sp) else { continue };
                    let mime_hdr = if cp.is_single_root {
                        hdr_bytes
                    } else {
                        let mime_sp = SectionPath::Part(cp.section_nums.clone(), Some(MessageSection::Mime));
                        f.section(&mime_sp).unwrap_or(b"")
                    };
                    let decoded = decode_binary_section(mime_hdr, raw_part, &cp.declared_mime, &cp.encoding);
                    if !decoded.is_empty() {
                        cid_assets.push((raw_cid.clone(), cp.declared_mime.clone(), decoded));
                    }
                }
                body_html = inline_cid_assets_into_html(body_html, &cid_assets);
            }
        }
    }

    // 仅从附件的 ~150B MIME 头或 BODYSTRUCTURE 元数据构建附件清单（零磁盘写入、零附件载荷传输）
    let mut attachments: Vec<AttachmentMeta> = Vec::new();
    for (idx, ap) in plan.att_parts.iter().take(MAX_ATT_COUNT).enumerate() {
        let mut resolved_name = String::new();
        let mut resolved_mime = ap.declared_mime.clone();

        let att_mime_hdr: Option<&[u8]> = if ap.is_single_root {
            Some(hdr_bytes)
        } else {
            fetch_ref.and_then(|f| {
                let sp = SectionPath::Part(ap.section_nums.clone(), Some(MessageSection::Mime));
                f.section(&sp)
            })
        };

        if let Some(mh) = att_mime_hdr.filter(|b| !b.is_empty()) {
            let syn = combine_mime_header_and_body(mh, b"x", &ap.declared_mime, "7bit");
            if let Some(pm) = MessageParser::default().parse(&syn) {
                if let Some(p0) = pm.parts.first() {
                    if let Some(n) = p0.attachment_name() {
                        if !n.trim().is_empty() {
                            resolved_name = n.trim().to_string();
                        }
                    }
                    if let Some(ct) = p0.content_type() {
                        resolved_mime = match &ct.c_subtype {
                            Some(sub) => format!("{}/{}", ct.c_type, sub),
                            None => ct.c_type.to_string(),
                        };
                    }
                }
            }
        }

        if resolved_name.is_empty() {
            if let Some(raw_fn) = &ap.param_filename {
                resolved_name = decode_mime_param_filename(raw_fn);
            }
        }

        let est_size = estimate_decoded_bytes(ap.octets, &ap.encoding);
        attachments.push(build_attachment_meta(
            &resolved_name,
            &resolved_mime,
            est_size,
            &ap.part_id,
            &ap.encoding,
            idx,
            &[],
        ));
    }

    let plain = plain_chunks.join("\n");
    let raw_body = if !plain.trim().is_empty() {
        plain
    } else if !body_html.is_empty() {
        html_to_text(&body_html)
    } else {
        String::new()
    };

    let body_full = normalize_raw_body(&raw_body);
    let body = clean_body(&body_full);
    let subject = hdr_msg.subject().unwrap_or("").to_string();
    let extracted_code = extract_verification_code(&subject, &body_full).unwrap_or_default();
    let date = hdr_msg
        .date()
        .map(|d| d.to_timestamp())
        .unwrap_or_else(|| chrono::Utc::now().timestamp());

    Ok(Some(ParsedMail {
        msg: NewMessage {
            folder: folder.to_string(),
            uid,
            message_id,
            in_reply_to: in_reply_ids.join(" "),
            references: reference_ids
                .into_iter()
                .map(|r| format!("<{r}>"))
                .collect::<Vec<_>>()
                .join(" "),
            from_addr,
            from_name,
            to_addrs,
            cc_addrs,
            subject,
            body,
            body_full,
            body_html,
            date,
            outgoing: false,
            peer: String::new(),
            status: "inbox".into(),
            category: String::new(),
            summary: String::new(),
            reason: String::new(),
            extracted_code,
            suggested_reply: String::new(),
            read: false,
            agent_done: false,
            attachments,
            reply_to: None,
        },
        participants,
        ref_ids,
        group_id_hdr,
        group_name_hdr,
        quote_mid_hdr,
        raw_attachments: Vec::new(),
    }))
}

#[allow(clippy::too_many_arguments)]
fn ingest_parsed_mail(
    parsed: ParsedMail,
    seen: bool,
    is_sent: bool,
    last: u32,
    me: &str,
    acc: &Account,
    db: &Db,
    rules: &[Rule],
    agent_enabled: bool,
) -> Result<bool> {
    let mut nm = parsed.msg;
    nm.outgoing = is_sent || nm.from_addr == me;
    let others = normalize_members(&parsed.participants, me);

    // 判断归属群聊还是单聊：
    // 1. 优先识别 Chat-Group-ID / X-MailChat-Group-Id 协议头
    // 2. 其次沿用 In-Reply-To / References 关联的已有群聊（中途增减抄送人也不裂变）
    // 3. 若除自己外参与人数 >= 2，则自动聚合为多人邮件群聊
    let group_peer = if let Some(gid) = &parsed.group_id_hdr {
        let clean = gid.trim_start_matches("group:");
        Some(format!("group:{clean}"))
    } else if let Some(existing_grp) = db.find_group_by_refs_for(me, &parsed.ref_ids)? {
        Some(existing_grp)
    } else if others.len() >= 2 {
        Some(participant_group_key(&others))
    } else {
        None
    };

    let mut group_muted = false;
    if let Some(gp) = group_peer {
        let title = parsed
            .group_name_hdr
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| default_group_title(&nm.subject, &others));
        let grp = db.upsert_group_for(me, &gp, &title, &others, me, false)?;
        group_muted = grp.muted;
        nm.peer = gp;
        if nm.category.is_empty() {
            nm.category = "群聊".into();
        }
    } else if nm.outgoing {
        match nm.to_addrs.split(',').next().filter(|s| !s.is_empty()) {
            Some(p) => nm.peer = p.to_string(),
            None => return Ok(false),
        }
    } else {
        nm.peer = nm.from_addr.clone();
    }

    nm.read = seen || nm.outgoing;
    // 严禁在同步阶段将任何邮件附件自动写入本地磁盘！仅保留轻量元数据，供用户手动点击“另存为”时按需拉取
    nm.reply_to = db
        .find_reply_quote_for(me, &nm.peer, parsed.quote_mid_hdr.as_deref(), &nm.in_reply_to)
        .unwrap_or(None);

    let contact_muted = !nm.outgoing
        && !nm.peer.starts_with("group:")
        && db.is_contact_muted_for(me, &nm.peer).unwrap_or(false);

    // 分流逻辑：发出的邮件 / 群免打扰（支持 @我 穿透提醒）/ 单聊联系人免打扰 / 规则引擎 / 已建立聊天跳过逐条 AI 分析 / 陌生新来信异步分拣
    if nm.outgoing {
        nm.agent_done = true;
    } else if group_muted {
        if mentions_me(&nm.body, acc) {
            nm.status = "inbox".into();
            nm.reason = "群聊开启免打扰，但此消息 @提及了你".into();
            nm.agent_done = true;
        } else {
            nm.status = "archived".into();
            nm.reason = "群聊已开启免打扰，自动折叠至通知".into();
            nm.agent_done = true;
        }
    } else if contact_muted {
        nm.status = "archived".into();
        nm.reason = "已对该联系人开启免打扰，自动折叠至通知".into();
        nm.agent_done = true;
    } else if let Some(hit) = apply_rules(rules, &nm.from_addr, &nm.subject, &nm.body_full) {
        nm.status = hit.status.into();
        nm.reason = hit.reason;
        nm.agent_done = true;
    } else if nm.extracted_code.is_empty()
        && db.is_established_chat_for(me, &nm.peer, &parsed.ref_ids).unwrap_or(false)
    {
        // 已建立双向沟通的熟人聊天：直接留在收件箱，不再每条消息调用大模型生成冗余复读摘要
        nm.status = "inbox".into();
        nm.agent_done = true;
    } else if agent_enabled && !(last == 0 && seen) {
        // 新邮件立即在收件箱可见，避免因等待远程大模型响应导致收信延迟；后台异步完成智能分拣与摘要补充
        nm.status = "inbox".into();
        nm.agent_done = false;
    } else {
        nm.agent_done = true;
    }

    Ok(db.insert_message_for(me, &nm)?.is_some() && !nm.outgoing)
}

pub(crate) fn sync_folder_on<S: Read + Write>(
    session: &mut imap::Session<S>,
    folder: &str,
    is_sent: bool,
    acc: &Account,
    db: &Db,
    rules: &[Rule],
    agent_enabled: bool,
) -> Result<usize> {
    let me = acc.email.trim().to_lowercase();
    let mb = session.select(folder).with_context(|| format!("打开文件夹 {folder} 失败"))?;
    let validity = mb.uid_validity.unwrap_or(0);
    let (stored_validity, stored_last) = db.sync_state_for(&me, folder)?;
    let last = if stored_validity == validity { stored_last } else { 0 };

    // 快速短路：当 UIDVALIDITY 未变且邮箱为空或 UIDNEXT 未超过已同步最大 UID 时，直接跳过 UID SEARCH 往返
    if last > 0 {
        if mb.exists == 0 {
            return Ok(0);
        }
        if let Some(uid_next) = mb.uid_next {
            if uid_next <= last + 1 {
                return Ok(0);
            }
        }
    }

    let mut uids: Vec<u32> = if last == 0 {
        if mb.exists == 0 {
            Vec::new()
        } else {
            session.uid_search("ALL")?.into_iter().collect()
        }
    } else {
        session
            .uid_search(format!("UID {}:*", last + 1))?
            .into_iter()
            .filter(|u| *u > last)
            .collect()
    };
    uids.sort_unstable();
    if last == 0 && uids.len() > INITIAL_FETCH {
        uids = uids.split_off(uids.len() - INITIAL_FETCH);
    }

    let mut max_uid = last;
    let mut new_incoming = 0;
    for chunk in uids.chunks(50) {
        let set = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        // 第一步：仅查询轻量结构元数据与信封头，识别含附件邮件以彻底跳过附件内容下载
        match session.uid_fetch(&set, "(UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER])") {
            Ok(meta_fetches) => {
                let mut full_fetch_uids: Vec<(u32, bool)> = Vec::new();
                for f in meta_fetches.iter() {
                    let uid = f.uid.unwrap_or(0);
                    if uid == 0 {
                        continue;
                    }
                    max_uid = max_uid.max(uid);
                    let seen = f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));

                    // 兼容直接返回 BODY[] 的极简测试桩或代理服务端
                    if let Some(raw) = f.body() {
                        if let Some(parsed) = parse_full(raw, folder, uid, validity) {
                            if ingest_parsed_mail(parsed, seen, is_sent, last, &me, acc, db, rules, agent_enabled)? {
                                new_incoming += 1;
                            }
                        }
                        continue;
                    }

                    if let Some(bs) = f.bodystructure() {
                        let plan = plan_bodystructure(bs);
                        let msg_size = f.size.unwrap_or(0) as usize;
                        if plan.att_parts.is_empty() && msg_size <= 2_000_000 {
                            full_fetch_uids.push((uid, seen));
                        } else if let Some(parsed) = fetch_partial_mail_without_attachments(
                            session,
                            uid,
                            f.header(),
                            &plan,
                            folder,
                            validity,
                        )? {
                            if ingest_parsed_mail(parsed, seen, is_sent, last, &me, acc, db, rules, agent_enabled)? {
                                new_incoming += 1;
                            }
                        }
                    } else {
                        full_fetch_uids.push((uid, seen));
                    }
                }

                if !full_fetch_uids.is_empty() {
                    let seen_map: HashMap<u32, bool> = full_fetch_uids.iter().copied().collect();
                    let full_set = full_fetch_uids
                        .iter()
                        .map(|(u, _)| u.to_string())
                        .collect::<Vec<_>>()
                        .join(",");
                    let fetches = session.uid_fetch(&full_set, "(UID FLAGS BODY.PEEK[])")?;
                    for f in fetches.iter() {
                        let uid = f.uid.unwrap_or(0);
                        max_uid = max_uid.max(uid);
                        let Some(raw) = f.body() else { continue };
                        let seen = seen_map.get(&uid).copied().unwrap_or_else(|| {
                            f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen))
                        });
                        let Some(parsed) = parse_full(raw, folder, uid, validity) else { continue };
                        if ingest_parsed_mail(parsed, seen, is_sent, last, &me, acc, db, rules, agent_enabled)? {
                            new_incoming += 1;
                        }
                    }
                }
            }
            Err(_) => {
                // 当少数旧式邮件在 BODYSTRUCTURE 中混入非 UTF-8 原始字节触发解析异常时平滑降级（仍严禁任何磁盘落盘）
                let fetches = session.uid_fetch(&set, "(UID FLAGS BODY.PEEK[])")?;
                for f in fetches.iter() {
                    let uid = f.uid.unwrap_or(0);
                    max_uid = max_uid.max(uid);
                    let Some(raw) = f.body() else { continue };
                    let seen = f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
                    let Some(parsed) = parse_full(raw, folder, uid, validity) else { continue };
                    if ingest_parsed_mail(parsed, seen, is_sent, last, &me, acc, db, rules, agent_enabled)? {
                        new_incoming += 1;
                    }
                }
            }
        }
    }
    if max_uid > last || stored_validity != validity {
        db.save_sync_state_for(&me, folder, validity, max_uid)?;
    }
    Ok(new_incoming)
}

pub(crate) fn backfill_html_on<S: Read + Write>(
    session: &mut imap::Session<S>,
    account_email: &str,
    db: &Db,
    batch_size: usize,
) -> Result<(usize, usize, bool)> {
    let items = db.messages_needing_html_backfill_for(account_email, batch_size)?;
    if items.is_empty() {
        return Ok((0, 0, false));
    }

    let mut by_folder: BTreeMap<String, Vec<(i64, u32)>> = BTreeMap::new();
    for item in items {
        by_folder
            .entry(item.folder)
            .or_default()
            .push((item.id, item.uid));
    }

    let mut checked_total = 0usize;
    let mut enriched_total = 0usize;
    let mut touched_non_inbox = false;

    for (folder, pairs) in by_folder {
        if !folder.eq_ignore_ascii_case("INBOX") {
            touched_non_inbox = true;
        }
        let ids: Vec<i64> = pairs.iter().map(|(id, _)| *id).collect();
        if session.select(&folder).is_err() {
            // 若服务端该历史文件夹已不存在或重命名，标记为已检查避免重复尝试
            let empty_map = HashMap::new();
            let _ = db.save_html_backfill_batch(&ids, &empty_map);
            checked_total += ids.len();
            continue;
        }

        for chunk in pairs.chunks(30) {
            let chunk_ids: Vec<i64> = chunk.iter().map(|(id, _)| *id).collect();
            let mut uid_to_ids: HashMap<u32, Vec<i64>> = HashMap::new();
            let mut uids: Vec<u32> = Vec::with_capacity(chunk.len());
            for &(id, uid) in chunk {
                uid_to_ids.entry(uid).or_default().push(id);
                uids.push(uid);
            }
            uids.sort_unstable();
            uids.dedup();
            let set = uids
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");

            let mut html_by_id: HashMap<i64, String> = HashMap::new();
            match session.uid_fetch(&set, "(UID RFC822.SIZE BODYSTRUCTURE)") {
                Ok(meta_fetches) => {
                    let mut full_uids: Vec<u32> = Vec::new();
                    for f in meta_fetches.iter() {
                        let Some(uid) = f.uid else { continue };
                        if let Some(bs) = f.bodystructure() {
                            let plan = plan_bodystructure(bs);
                            let has_html = plan.body_parts.iter().any(|p| p.subtype == "html");
                            if !has_html {
                                continue;
                            }
                            if plan.att_parts.is_empty() && f.size.unwrap_or(0) <= 2_000_000 {
                                full_uids.push(uid);
                            } else if let Ok(Some(pm)) = fetch_partial_mail_without_attachments(
                                session,
                                uid,
                                None,
                                &plan,
                                &folder,
                                0,
                            ) {
                                if !pm.msg.body_html.is_empty() {
                                    if let Some(target_ids) = uid_to_ids.get(&uid) {
                                        for &id in target_ids {
                                            html_by_id.insert(id, pm.msg.body_html.clone());
                                        }
                                    }
                                }
                            }
                        } else {
                            full_uids.push(uid);
                        }
                    }
                    if !full_uids.is_empty() {
                        let full_set = full_uids
                            .iter()
                            .map(|u| u.to_string())
                            .collect::<Vec<_>>()
                            .join(",");
                        if let Ok(fetches) = session.uid_fetch(&full_set, "(UID BODY.PEEK[])") {
                            for f in fetches.iter() {
                                let Some(uid) = f.uid else { continue };
                                let Some(raw) = f.body() else { continue };
                                let Some(msg) = MessageParser::default().parse(raw) else { continue };
                                let html = extract_html_with_cid(&msg);
                                if !html.is_empty() {
                                    if let Some(target_ids) = uid_to_ids.get(&uid) {
                                        for &id in target_ids {
                                            html_by_id.insert(id, html.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(_) => {
                    if let Ok(fetches) = session.uid_fetch(&set, "(UID BODY.PEEK[])") {
                        for f in fetches.iter() {
                            let Some(uid) = f.uid else { continue };
                            let Some(raw) = f.body() else { continue };
                            let Some(msg) = MessageParser::default().parse(raw) else { continue };
                            let html = extract_html_with_cid(&msg);
                            if !html.is_empty() {
                                if let Some(target_ids) = uid_to_ids.get(&uid) {
                                    for &id in target_ids {
                                        html_by_id.insert(id, html.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }

            enriched_total += db.save_html_backfill_batch(&chunk_ids, &html_by_id)?;
            checked_total += chunk_ids.len();
        }
    }

    Ok((checked_total, enriched_total, touched_non_inbox))
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>> {
    let payload = match input.find(";base64,") {
        Some(idx) => &input[idx + 8..],
        None => input,
    };
    let mut out = Vec::with_capacity(payload.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in payload.bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\r' | b'\n' | b'\t' => continue,
            _ => anyhow::bail!("非法的 Base64 字符"),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

pub fn infer_mime_type(filename: &str, declared_mime: &str, bytes: &[u8]) -> String {
    let decl = declared_mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !decl.is_empty() && decl != "application/octet-stream" && decl.contains('/') {
        return decl;
    }
    if let Some(img) = sniff_image_mime(None, bytes) {
        return img.to_string();
    }
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "exe" | "msi" | "dll" | "scr" | "com" => "application/x-msdownload",
        _ => "application/octet-stream",
    }
    .to_string()
}

pub fn sanitize_attachment_filename(raw: &str, fallback_mime: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let trimmed = base.trim().trim_matches('.').trim();
    if !trimmed.is_empty() {
        let chars: Vec<char> = trimmed.chars().collect();
        if chars.len() <= 96 {
            return trimmed.to_string();
        }
        let tail: String = chars[chars.len() - 48..].iter().collect();
        let head: String = chars[..36].iter().collect();
        return format!("{head}_{tail}");
    }
    let ext = match fallback_mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        _ => "bin",
    };
    if fallback_mime.starts_with("image/") {
        format!("image.{ext}")
    } else {
        format!("attachment.{ext}")
    }
}

/// 仅构造纯内存附件元数据（严禁自动落盘写入本地文件系统）
pub fn build_attachment_meta(
    filename: &str,
    declared_mime: &str,
    size: usize,
    part_id: &str,
    encoding: &str,
    att_index: usize,
    sample_bytes: &[u8],
) -> AttachmentMeta {
    let mime_full = infer_mime_type(filename, declared_mime, sample_bytes);
    let mime_base = mime_full
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();
    let safe_name = sanitize_attachment_filename(filename, &mime_base);
    let is_image = mime_base.starts_with("image/");
    let uuid_hex = uuid::Uuid::new_v4().simple().to_string();
    let id = format!("att-{}", &uuid_hex[..16]);

    AttachmentMeta {
        id,
        filename: safe_name,
        mime: mime_base,
        size,
        rel_path: String::new(),
        is_image,
        part_id: part_id.trim().to_string(),
        encoding: encoding.trim().to_ascii_lowercase(),
        att_index,
        saved_path: String::new(),
    }
}

fn parse_section_nums(part_id: &str) -> Option<Vec<u32>> {
    let trimmed = part_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut nums = Vec::new();
    for seg in trimmed.split('.') {
        let n = seg.parse::<u32>().ok()?;
        if n == 0 {
            return None;
        }
        nums.push(n);
    }
    if nums.is_empty() {
        None
    } else {
        Some(nums)
    }
}

fn fetch_single_section_attachment_on<S: Read + Write>(
    session: &mut imap::Session<S>,
    uid: u32,
    part_id: &str,
    declared_mime: &str,
    encoding: &str,
    filename: &str,
) -> Result<Option<(Vec<u8>, String)>> {
    const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
    let Some(section_nums) = parse_section_nums(part_id) else {
        return Ok(None);
    };

    let fetches = if section_nums == [1] {
        match session.uid_fetch(
            uid.to_string(),
            "(UID BODY.PEEK[HEADER] BODY.PEEK[1.MIME] BODY.PEEK[1])",
        ) {
            Ok(fs) => fs,
            Err(_) => session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[HEADER] BODY.PEEK[1])")?,
        }
    } else {
        let query = format!("(UID BODY.PEEK[{part_id}.MIME] BODY.PEEK[{part_id}])");
        session.uid_fetch(uid.to_string(), &query)?
    };

    let Some(f) = fetches.iter().next() else {
        return Ok(None);
    };
    let body_sp = SectionPath::Part(section_nums.clone(), None);
    let Some(raw_part) = f.section(&body_sp) else {
        return Ok(None);
    };
    if raw_part.len() > (MAX_DOWNLOAD_BYTES / 3) * 4 + 4096 {
        anyhow::bail!("附件体积超过 50 MB 安全限制");
    }

    let mime_sp = SectionPath::Part(section_nums.clone(), Some(MessageSection::Mime));
    let mime_hdr = f
        .section(&mime_sp)
        .filter(|b| !b.is_empty())
        .or_else(|| if section_nums == [1] { f.header() } else { None })
        .unwrap_or(b"");

    let bytes = decode_binary_section(mime_hdr, raw_part, declared_mime, encoding);
    if bytes.is_empty() {
        anyhow::bail!("远程邮件附件内容为空");
    }
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        anyhow::bail!("附件体积超过 50 MB 安全限制");
    }

    let mime_full = infer_mime_type(filename, declared_mime, &bytes);
    let mime_base = mime_full
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();
    Ok(Some((bytes, mime_base)))
}

fn fetch_uid_attachment_on<S: Read + Write>(
    session: &mut imap::Session<S>,
    uid: u32,
    meta: &AttachmentMeta,
) -> Result<Option<(Vec<u8>, String)>> {
    const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

    if !meta.part_id.trim().is_empty() {
        if let Some(found) = fetch_single_section_attachment_on(
            session,
            uid,
            meta.part_id.trim(),
            &meta.mime,
            &meta.encoding,
            &meta.filename,
        )? {
            return Ok(Some(found));
        }
    }

    // 对无 part_id 的历史记录或本地刚发出的已归档邮件，优先通过 BODYSTRUCTURE 定位单个 MIME 分段按需拉取
    if let Ok(meta_fetches) = session.uid_fetch(uid.to_string(), "(UID BODYSTRUCTURE)") {
        if let Some(f) = meta_fetches.iter().next() {
            if let Some(bs) = f.bodystructure() {
                let plan = plan_bodystructure(bs);
                let matched = plan
                    .att_parts
                    .get(meta.att_index)
                    .filter(|ap| {
                        ap.param_filename
                            .as_deref()
                            .map(decode_mime_param_filename)
                            .map(|n| sanitize_attachment_filename(&n, &ap.declared_mime) == meta.filename)
                            .unwrap_or(true)
                    })
                    .or_else(|| {
                        plan.att_parts.iter().find(|ap| {
                            ap.param_filename
                                .as_deref()
                                .map(decode_mime_param_filename)
                                .map(|n| sanitize_attachment_filename(&n, &ap.declared_mime) == meta.filename)
                                .unwrap_or(false)
                        })
                    })
                    .or_else(|| plan.att_parts.get(meta.att_index));

                if let Some(ap) = matched {
                    let decl = if meta.mime.trim().is_empty() {
                        &ap.declared_mime
                    } else {
                        &meta.mime
                    };
                    if let Some(found) = fetch_single_section_attachment_on(
                        session,
                        uid,
                        &ap.part_id,
                        decl,
                        &ap.encoding,
                        &meta.filename,
                    )? {
                        return Ok(Some(found));
                    }
                }
            }
        }
    }

    // 兜底：若极少数旧式邮件服务器 BODYSTRUCTURE 无法解析，仅在内存中解析整封邮件提取目标附件（严禁落盘）
    let fetches = session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")?;
    let Some(f) = fetches.iter().next() else {
        return Ok(None);
    };
    let Some(raw) = f.body() else {
        return Ok(None);
    };
    let Some(msg) = MessageParser::default().parse(raw) else {
        return Ok(None);
    };
    let has_rich_html = !extract_html_with_cid(&msg).is_empty();
    let raw_atts = extract_incoming_attachments(&msg, has_rich_html);
    let chosen = raw_atts
        .get(meta.att_index)
        .filter(|a| a.filename == meta.filename)
        .or_else(|| raw_atts.iter().find(|a| a.filename == meta.filename))
        .or_else(|| raw_atts.get(meta.att_index));

    let Some(att) = chosen else {
        return Ok(None);
    };
    if att.bytes.len() > MAX_DOWNLOAD_BYTES {
        anyhow::bail!("附件体积超过 50 MB 安全限制");
    }
    let mime_base = att
        .mime
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();
    Ok(Some((att.bytes.clone(), mime_base)))
}

pub(crate) fn fetch_attachment_bytes_on<S: Read + Write>(
    session: &mut imap::Session<S>,
    folder: &str,
    uid: u32,
    rfc_message_id: &str,
    meta: &AttachmentMeta,
) -> Result<(Vec<u8>, String)> {
    if folder.eq_ignore_ascii_case("demo") {
        anyhow::bail!("演示示例邮件不包含远程附件数据");
    }

    if uid > 0 && !folder.is_empty() && !folder.eq_ignore_ascii_case("local") {
        if session.select(folder).is_ok() {
            if let Some(found) = fetch_uid_attachment_on(session, uid, meta)? {
                return Ok(found);
            }
        }
    }

    let clean_mid = rfc_message_id
        .trim()
        .trim_matches(&['<', '>', ' ', '"'][..]);
    if !clean_mid.is_empty()
        && !clean_mid.starts_with("local-")
        && !clean_mid.chars().any(|c| c.is_control() || c == '"' || c == '\\')
    {
        let mut candidate_folders: Vec<String> = Vec::new();
        if let Some(sent) = find_sent_folder(session) {
            candidate_folders.push(sent);
        }
        if !folder.is_empty()
            && !folder.eq_ignore_ascii_case("local")
            && !candidate_folders.iter().any(|f| f.eq_ignore_ascii_case(folder))
        {
            candidate_folders.push(folder.to_string());
        }
        if !candidate_folders.iter().any(|f| f.eq_ignore_ascii_case("INBOX")) {
            candidate_folders.push("INBOX".to_string());
        }

        for cand in candidate_folders {
            if session.select(&cand).is_err() {
                continue;
            }
            let found_uid = session
                .uid_search(format!("HEADER Message-ID \"<{clean_mid}>\""))
                .ok()
                .and_then(|s| s.into_iter().max())
                .or_else(|| {
                    session
                        .uid_search(format!("HEADER Message-ID \"{clean_mid}\""))
                        .ok()
                        .and_then(|s| s.into_iter().max())
                });
            if let Some(u) = found_uid {
                if let Some(found) = fetch_uid_attachment_on(session, u, meta)? {
                    return Ok(found);
                }
            }
        }
    }

    if folder.eq_ignore_ascii_case("local") {
        anyhow::bail!("该邮件刚发送不久，服务端“已发送”文件夹尚未完成归档，请稍后再试");
    }
    anyhow::bail!("在邮件服务器上未找到该附件所属的原邮件（可能已被删除或移动）")
}

/// 仅在用户主动触发“另存为”或点击查看图片预览时，按需从 IMAP 服务端拉取单个附件至内存
pub fn fetch_attachment_bytes(
    acc: &Account,
    folder: &str,
    uid: u32,
    rfc_message_id: &str,
    meta: &AttachmentMeta,
) -> Result<(Vec<u8>, String)> {
    let mut session = connect(acc)?;
    let res = fetch_attachment_bytes_on(&mut session, folder, uid, rfc_message_id, meta);
    let _ = session.logout();
    res
}

fn sniff_image_mime(declared: Option<(&str, &str)>, bytes: &[u8]) -> Option<&'static str> {
    if let Some((t, sub)) = declared {
        if t.eq_ignore_ascii_case("image") {
            let s = sub.to_ascii_lowercase();
            match s.as_str() {
                "png" => return Some("image/png"),
                "jpeg" | "jpg" => return Some("image/jpeg"),
                "gif" => return Some("image/gif"),
                "webp" => return Some("image/webp"),
                "bmp" => return Some("image/bmp"),
                "x-icon" | "vnd.microsoft.icon" | "ico" => return Some("image/x-icon"),
                _ => {}
            }
        }
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn inline_cid_assets_into_html(mut html: String, assets: &[(String, String, Vec<u8>)]) -> String {
    const MAX_HTML_BYTES: usize = 1_500_000;
    const MAX_SINGLE_CID_IMAGE: usize = 512 * 1024;
    const MAX_TOTAL_CID_BYTES: usize = 1024 * 1024;

    let mut used_bytes = 0usize;
    for (raw_cid, declared_mime, bytes) in assets {
        let cid = raw_cid
            .trim()
            .trim_matches(&['<', '>', '"', '\''][..])
            .trim();
        if cid.is_empty() {
            continue;
        }
        if bytes.is_empty()
            || bytes.len() > MAX_SINGLE_CID_IMAGE
            || used_bytes + bytes.len() > MAX_TOTAL_CID_BYTES
        {
            continue;
        }
        let declared = declared_mime
            .split_once('/')
            .map(|(t, s)| (t.trim(), s.split(';').next().unwrap_or("").trim()));
        let Some(mime) = sniff_image_mime(declared, bytes) else {
            continue;
        };

        let data_uri = format!("data:{mime};base64,{}", base64_encode(bytes));
        let pattern = if cid.contains('@') {
            format!(
                r#"(?i)cid:(?:{}|{})(["'\s>)])"#,
                regex::escape(cid),
                regex::escape(&cid.replace('@', "%40"))
            )
        } else {
            format!(r#"(?i)cid:{}(["'\s>)])"#, regex::escape(cid))
        };
        if let Ok(re) = Regex::new(&pattern) {
            let replaced = re.replace_all(&html, |caps: &regex::Captures| {
                format!("{data_uri}{}", &caps[1])
            });
            if let std::borrow::Cow::Owned(next) = replaced {
                used_bytes += bytes.len();
                html = next;
            }
        }
    }

    if html.len() > MAX_HTML_BYTES {
        String::new()
    } else {
        html
    }
}

/// 提取真实存在的 `text/html` MIME 正文（排除 `mail-parser` 为纯文本邮件合成的伪 HTML），并将小尺寸内联 `cid:` 图片解析为 `data:` URI。
pub fn extract_html_with_cid(msg: &mail_parser::Message) -> String {
    const MAX_HTML_BYTES: usize = 1_500_000;
    const MAX_SINGLE_CID_IMAGE: usize = 512 * 1024;

    let mut html_chunks: Vec<&str> = msg
        .html_bodies()
        .filter_map(|p| match &p.body {
            PartType::Html(h) if !h.trim().is_empty() => Some(h.as_ref()),
            _ => None,
        })
        .collect();

    if html_chunks.is_empty() {
        html_chunks = msg
            .parts
            .iter()
            .filter_map(|p| match &p.body {
                PartType::Html(h) if !h.trim().is_empty() => Some(h.as_ref()),
                _ => None,
            })
            .collect();
    }

    if html_chunks.is_empty() {
        return String::new();
    }

    let html = html_chunks.join("\n").trim().to_string();
    if html.is_empty() || html.len() > MAX_HTML_BYTES {
        return String::new();
    }

    let has_cid_ref = html
        .as_bytes()
        .windows(4)
        .any(|w| w.eq_ignore_ascii_case(b"cid:"));
    if !has_cid_ref {
        return html;
    }

    let mut assets: Vec<(String, String, Vec<u8>)> = Vec::new();
    for part in &msg.parts {
        let Some(raw_cid) = part.content_id() else {
            continue;
        };
        let (PartType::Binary(bytes) | PartType::InlineBinary(bytes)) = &part.body else {
            continue;
        };
        if bytes.is_empty() || bytes.len() > MAX_SINGLE_CID_IMAGE {
            continue;
        }
        let declared_mime = part
            .content_type()
            .and_then(|ct| Some(format!("{}/{}", ct.c_type, ct.c_subtype.as_deref()?)))
            .unwrap_or_default();
        assets.push((raw_cid.to_string(), declared_mime, bytes.to_vec()));
    }

    inline_cid_assets_into_html(html, &assets)
}

fn header_ids(v: &HeaderValue) -> Vec<String> {
    match v {
        HeaderValue::Text(t) => t
            .split_whitespace()
            .map(|s| s.trim_matches(&['<', '>', ' '][..]).to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        HeaderValue::TextList(l) => l
            .iter()
            .map(|s| s.trim_matches(&['<', '>', ' '][..]).to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => vec![],
    }
}

fn header_text(msg: &mail_parser::Message, name: &str) -> Option<String> {
    match msg.header(name)? {
        HeaderValue::Text(t) => Some(t.trim().to_string()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn collect_addrs(list: Option<&mail_parser::Address>) -> (String, Vec<GroupMember>) {
    let Some(addr_list) = list else {
        return (String::new(), Vec::new());
    };
    let mut emails = Vec::new();
    let mut members = Vec::new();
    let push_one = |a: &Addr, emails: &mut Vec<String>, members: &mut Vec<GroupMember>| {
        if let Some(em) = a.address() {
            let lower = em.trim().to_lowercase();
            if !lower.is_empty() {
                emails.push(lower.clone());
                members.push(GroupMember {
                    email: lower,
                    name: a.name().unwrap_or("").trim().to_string(),
                });
            }
        }
    };
    for item in addr_list.iter() {
        push_one(item, &mut emails, &mut members);
    }
    (emails.join(","), members)
}

pub fn parse_full(raw: &[u8], folder: &str, uid: u32, validity: u32) -> Option<ParsedMail> {
    let msg = MessageParser::default().parse(raw)?;
    let from = msg.from().and_then(|a| a.first());
    let from_addr = from.and_then(|a| a.address()).unwrap_or("").trim().to_lowercase();
    if from_addr.is_empty() {
        return None;
    }
    let from_name = from.and_then(|a| a.name()).unwrap_or("").trim().to_string();
    let (to_addrs, to_members) = collect_addrs(msg.to());
    let (cc_addrs, cc_members) = collect_addrs(msg.cc());

    let mut participants = Vec::with_capacity(1 + to_members.len() + cc_members.len());
    participants.push(GroupMember {
        email: from_addr.clone(),
        name: from_name.clone(),
    });
    participants.extend(to_members);
    participants.extend(cc_members);

    let message_id = msg
        .message_id()
        .map(|s| s.trim_matches(&['<', '>', ' '][..]).to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("local-{validity}-{uid}@{folder}"));

    let in_reply_ids = header_ids(msg.in_reply_to());
    let reference_ids = header_ids(msg.references());
    let mut ref_ids = reference_ids.clone();
    for id in &in_reply_ids {
        if !ref_ids.contains(id) {
            ref_ids.push(id.clone());
        }
    }

    let group_id_hdr = header_text(&msg, "Chat-Group-ID")
        .or_else(|| header_text(&msg, "X-MailChat-Group-Id"));
    let group_name_hdr = header_text(&msg, "Chat-Group-Name")
        .or_else(|| header_text(&msg, "X-MailChat-Group-Name"));
    let quote_mid_hdr = header_text(&msg, "X-MailChat-Quote-Id");

    let body_html = extract_html_with_cid(&msg);
    let raw_attachments = extract_incoming_attachments(&msg, !body_html.is_empty());
    let attachments: Vec<AttachmentMeta> = raw_attachments
        .iter()
        .enumerate()
        .map(|(idx, raw_att)| {
            build_attachment_meta(
                &raw_att.filename,
                &raw_att.mime,
                raw_att.bytes.len(),
                "",
                "",
                idx,
                &raw_att.bytes,
            )
        })
        .collect();
    let plain = msg.body_text(0).map(|s| s.into_owned()).unwrap_or_default();
    let raw_body = if !plain.trim().is_empty() {
        plain
    } else if !body_html.is_empty() {
        html_to_text(&body_html)
    } else if let Some(html) = msg.body_html(0) {
        html_to_text(&html)
    } else {
        String::new()
    };

    let body_full = normalize_raw_body(&raw_body);
    let body = clean_body(&body_full);
    let subject = msg.subject().unwrap_or("").to_string();
    let extracted_code = extract_verification_code(&subject, &body_full).unwrap_or_default();
    let date = msg
        .date()
        .map(|d| d.to_timestamp())
        .unwrap_or_else(|| chrono::Utc::now().timestamp());

    Some(ParsedMail {
        msg: NewMessage {
            folder: folder.to_string(),
            uid,
            message_id,
            in_reply_to: in_reply_ids.join(" "),
            references: reference_ids
                .into_iter()
                .map(|r| format!("<{r}>"))
                .collect::<Vec<_>>()
                .join(" "),
            from_addr,
            from_name,
            to_addrs,
            cc_addrs,
            subject,
            body,
            body_full,
            body_html,
            date,
            outgoing: false,
            peer: String::new(),
            status: "inbox".into(),
            category: String::new(),
            summary: String::new(),
            reason: String::new(),
            extracted_code,
            suggested_reply: String::new(),
            read: false,
            agent_done: false,
            attachments,
            reply_to: None,
        },
        participants,
        ref_ids,
        group_id_hdr,
        group_name_hdr,
        quote_mid_hdr,
        raw_attachments,
    })
}

fn extract_incoming_attachments(
    msg: &mail_parser::Message,
    has_rich_html: bool,
) -> Vec<RawAttachment> {
    const MAX_ATT_BYTES: usize = 25 * 1024 * 1024;
    const MAX_ATT_COUNT: usize = 12;

    let mut list = Vec::new();
    for part in msg.attachments() {
        if list.len() >= MAX_ATT_COUNT {
            break;
        }
        let is_explicit_attachment = part
            .content_disposition()
            .map(|d| d.c_type.eq_ignore_ascii_case("attachment"))
            .unwrap_or(false);
        // 若富 HTML 邮件包含内联装饰图标（带 Content-ID 且非 attachment 处置），已由 extract_html_with_cid 内联渲染，不再重复列为文件附件
        if has_rich_html && part.content_id().is_some() && !is_explicit_attachment {
            continue;
        }

        let raw_bytes: &[u8] = match &part.body {
            PartType::Binary(b) | PartType::InlineBinary(b) => b.as_ref(),
            PartType::Text(t) | PartType::Html(t) if part.attachment_name().is_some() || is_explicit_attachment => {
                t.as_bytes()
            }
            _ => continue,
        };
        if raw_bytes.is_empty() || raw_bytes.len() > MAX_ATT_BYTES {
            continue;
        }

        let declared_mime = part
            .content_type()
            .map(|ct| match &ct.c_subtype {
                Some(sub) => format!("{}/{}", ct.c_type, sub),
                None => ct.c_type.to_string(),
            })
            .unwrap_or_default();
        let raw_name = part.attachment_name().unwrap_or("");
        let mime = infer_mime_type(raw_name, &declared_mime, raw_bytes);
        let filename = sanitize_attachment_filename(raw_name, &mime);

        list.push(RawAttachment {
            filename,
            mime,
            bytes: raw_bytes.to_vec(),
        });
    }
    list
}

/// 将仅含 HTML 的通知/业务邮件转换为整洁可读的纯文本，并保留可点击的动作链接
pub fn html_to_text(html: &str) -> String {
    static COMMENTS: OnceLock<Regex> = OnceLock::new();
    static DROP_BLOCKS: OnceLock<Regex> = OnceLock::new();
    static ANCHORS: OnceLock<Regex> = OnceLock::new();
    static TABLE_CELLS: OnceLock<Regex> = OnceLock::new();
    static LINE_BREAKS: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static NUM_ENTITY: OnceLock<Regex> = OnceLock::new();
    static HEX_ENTITY: OnceLock<Regex> = OnceLock::new();

    let comments = COMMENTS.get_or_init(|| Regex::new(r"(?is)<!--.*?-->").unwrap());
    let drop_blocks = DROP_BLOCKS.get_or_init(|| {
        Regex::new(r"(?is)<(script|style|head|noscript|svg)[^>]*>.*?</(script|style|head|noscript|svg)>").unwrap()
    });
    let anchors = ANCHORS.get_or_init(|| {
        Regex::new(r#"(?is)<a\b[^>]*\bhref\s*=\s*["']?(https?://[^"'\s>]+)["']?[^>]*>(.*?)</a>"#).unwrap()
    });
    let table_cells = TABLE_CELLS.get_or_init(|| Regex::new(r"(?i)</t[dh]>").unwrap());
    let line_breaks = LINE_BREAKS.get_or_init(|| {
        Regex::new(r"(?i)<(br|hr)\s*/?>|</(p|div|tr|li|h[1-6]|blockquote|section|article|table|header|footer)>").unwrap()
    });
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let num_entity = NUM_ENTITY.get_or_init(|| Regex::new(r"&#(\d{2,6});").unwrap());
    let hex_entity = HEX_ENTITY.get_or_init(|| Regex::new(r"(?i)&#x([0-9a-f]{2,6});").unwrap());

    let s = comments.replace_all(html, "");
    let s = drop_blocks.replace_all(&s, "");
    let s = anchors.replace_all(&s, |caps: &regex::Captures| {
        let href = caps[1].trim().replace("&amp;", "&");
        let inner_raw = tags.replace_all(&caps[2], "");
        let label = inner_raw
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if label.is_empty() {
            String::new()
        } else if label == href
            || label.trim_end_matches('/') == href.trim_end_matches('/')
            || label.starts_with("http://")
            || label.starts_with("https://")
        {
            href
        } else if label.chars().count() <= 48 {
            format!("[{label}]({href})")
        } else {
            format!("{label}\n<{href}>")
        }
    });
    let s = table_cells.replace_all(&s, " ");
    let s = line_breaks.replace_all(&s, "\n");
    let s = tags.replace_all(&s, "");

    let decoded = s
        .replace("&nbsp;", " ")
        .replace("&zwnj;", "")
        .replace("&zwj;", "")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”")
        .replace("&mdash;", "—")
        .replace("&ndash;", "-")
        .replace("&bull;", "•")
        .replace("&middot;", "·")
        .replace("&hellip;", "…")
        .replace("&copy;", "©");

    let decoded = num_entity.replace_all(&decoded, |caps: &regex::Captures| {
        caps[1]
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_default()
    });
    let decoded = hex_entity.replace_all(&decoded, |caps: &regex::Captures| {
        u32::from_str_radix(&caps[1], 16)
            .ok()
            .and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_default()
    });

    let mut out = String::new();
    let mut blank = 0;
    for line in decoded.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank += 1;
            if blank <= 1 && !out.is_empty() {
                out.push('\n');
            }
        } else {
            blank = 0;
            out.push_str(&trimmed);
            out.push('\n');
        }
    }
    normalize_raw_body(&out)
}

/// 规范化邮件原始纯文本：清理零宽填充符、拼接被折行的 `<https://...>` 链接、消除冗余 `<mailto:...>` 与内联 CID 占位符
pub fn normalize_raw_body(raw: &str) -> String {
    static WRAPPED_ANGLE_URL: OnceLock<Regex> = OnceLock::new();
    static CID_NOISE: OnceLock<Regex> = OnceLock::new();
    static MAILTO_ECHO: OnceLock<Regex> = OnceLock::new();

    let mut s = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}', '\u{034F}', '\u{2060}'], "");

    let wrapped_url = WRAPPED_ANGLE_URL
        .get_or_init(|| Regex::new(r"<(https?://[^\s<>]+(?:\n[ \t]*[^\s<>]+)+)>").unwrap());
    s = wrapped_url
        .replace_all(&s, |caps: &regex::Captures| {
            let joined: String = caps[1]
                .chars()
                .filter(|c| !matches!(c, '\n' | '\r' | ' ' | '\t'))
                .collect();
            format!("<{joined}>")
        })
        .into_owned();

    let cid_noise = CID_NOISE.get_or_init(|| Regex::new(r"(?i)\[cid:[^\]\n]+\]").unwrap());
    s = cid_noise.replace_all(&s, "").into_owned();

    let mailto_echo = MAILTO_ECHO.get_or_init(|| {
        Regex::new(r"(?i)([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?[ \t]*<mailto:([^>\s]+)>").unwrap()
    });
    s = mailto_echo
        .replace_all(&s, |caps: &regex::Captures| {
            if let Some(prev) = caps.get(1) {
                if prev.as_str().eq_ignore_ascii_case(&caps[2]) {
                    return prev.as_str().to_string();
                }
                return format!("{} <{}>", prev.as_str(), &caps[2]);
            }
            caps[2].to_string()
        })
        .into_owned();

    s.trim().to_string()
}

/// 快速本地提取常见 4-8 位数字验证码
pub fn extract_verification_code(subject: &str, body: &str) -> Option<String> {
    static KW: OnceLock<Regex> = OnceLock::new();
    static CODE_NEAR: OnceLock<Regex> = OnceLock::new();

    let kw = KW.get_or_init(|| {
        Regex::new(r"(?i)(验证码|校验码|动态码|确认码|verification\s*code|security\s*code|login\s*code|passcode|one-time\s*code)").unwrap()
    });
    let hay = format!("{subject}\n{body}");
    if !kw.is_match(&hay) {
        return None;
    }
    let near = CODE_NEAR.get_or_init(|| {
        Regex::new(r"(?i)(?:验证码|校验码|动态码|确认码|code)\s*(?:为|是|:|：|is)?\s*[\[【\s]*([0-9]{4,8})[\]】\s.,，。!！]?").unwrap()
    });
    if let Some(c) = near.captures(&hay) {
        return Some(c[1].to_string());
    }
    static SIX_DIGIT: OnceLock<Regex> = OnceLock::new();
    let six = SIX_DIGIT.get_or_init(|| Regex::new(r"(?:^|[^0-9])([0-9]{6})(?:$|[^0-9])").unwrap());
    six.captures(&hay).map(|c| c[1].to_string())
}

/// 把邮件正文变成“聊天气泡”：去掉各家客户端引用的历史邮件、竖线表头、签名尾巴和多余空行。
pub fn clean_body(text: &str) -> String {
    static CUT_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    static MOBILE_SIG: OnceLock<Regex> = OnceLock::new();
    static IMG_PLACEHOLDER: OnceLock<Regex> = OnceLock::new();

    let normalized = normalize_raw_body(text);
    if normalized.is_empty() {
        return String::new();
    }

    let patterns = CUT_PATTERNS.get_or_init(|| {
        vec![
            // 网易 163/126/邮箱大师、QQ 邮箱、Foxmail、Gmail、阿里云等分隔线式引用/转发头
            Regex::new(r"(?mi)^[ \t]*-{2,}[ \t]*(?:Original Message|Original|原始邮件|原邮件|回复的原邮件|回复邮件|Replied Message|Reply Message|Forwarded message|转发邮件|转发的邮件|转发的原邮件|已转发邮件)[ \t]*-{2,}[ \t]*$").unwrap(),
            // 转发引导行
            Regex::new(r"(?mi)^[ \t]*(?:Begin forwarded message:|下面是被转发的邮件[：:]|以下是转发的邮件[：:])[ \t]*$").unwrap(),
            // 英文客户端 On ... wrote:（兼容 72 列自动折成两行的情况，不跨空行）
            Regex::new(r"(?mi)^[ \t]*On [^\n]{4,180}(?:\n[^\n]{1,120})?\bwrote:[ \t]*$").unwrap(),
            // 中文客户端 在 ... 写道：（兼容折成两行）
            Regex::new(r"(?m)^[ \t]*在[ \t]*[^\n]{4,180}(?:\n[^\n]{1,120})?写道[：:][ \t]*$").unwrap(),
            // Gmail 中文版：xxx <xxx@...> 于2026年11月14日周六 13:20写道：（兼容折成两行）
            Regex::new(r"(?m)^[ \t]*[^\n]{2,140}于[ \t]*20\d{2}[^\n]{2,80}(?:\n[^\n]{1,80})?写道[：:][ \t]*$").unwrap(),
            // Outlook / Exchange 下划线分隔或长横线 + 发件人头
            Regex::new(r"(?mi)^[ \t]*_{5,}[ \t]*$").unwrap(),
            Regex::new(r"(?mi)^[ \t]*-{20,}[ \t]*\n+[ \t]*(?:\|[ \t]*)?(?:From|发件人)[ \t]*(?:\||[:：])").unwrap(),
            // 标准冒号式引用头（From / 发件人）
            Regex::new(r"(?mi)^[ \t]*\*?\*?From\*?\*?[ \t]*:[ \t]+.+\n[ \t]*\*?\*?(?:Sent|Date|To)\*?\*?[ \t]*:").unwrap(),
            Regex::new(r"(?m)^[ \t]*\*?\*?发件人\*?\*?[ \t]*[:：].+\n[ \t]*\*?\*?(?:发送时间|时间|日期|收件人)\*?\*?[ \t]*[:：]").unwrap(),
            // 网易系纯文本竖线表格引用头（| 发件人 | ... |）
            Regex::new(r"(?m)^[ \t]*\|[ \t]*发件人[ \t]*\|.+\|[ \t]*\n[ \t]*\|[ \t]*(?:日期|时间|发送时间|收件人)[ \t]*\|").unwrap(),
            Regex::new(r"(?mi)^[ \t]*\|[ \t]*From[ \t]*\|.+\|[ \t]*\n[ \t]*\|[ \t]*(?:Date|Sent|To)[ \t]*\|").unwrap(),
        ]
    });

    let mut cut_idx = normalized.len();
    for re in patterns {
        if let Some(m) = re.find(&normalized) {
            if m.start() < cut_idx {
                cut_idx = m.start();
            }
        }
    }
    let mut s = &normalized[..cut_idx];

    if let Some(i) = s.find("\n-- \n").or_else(|| s.find("\n-- \r\n")) {
        s = &s[..i];
    } else if s.ends_with("\n-- ") {
        s = &s[..s.len() - 4];
    }

    let mobile_sig = MOBILE_SIG.get_or_init(|| {
        Regex::new(
            r"(?mi)^[ \t]*(?:发自我的[ \t]*(?:iPhone|iPad|Mac|华为[^\n]{0,12}|小米[^\n]{0,12}|荣耀[^\n]{0,12}|OPPO[^\n]{0,12}|vivo[^\n]{0,12}|手机|Android)|Sent from my (?:iPhone|iPad|Mac|Galaxy|Android|Phone)|Get Outlook for (?:iOS|Android)|获取[ \t]*Outlook for (?:iOS|Android)|发自网易邮箱大师|签名由[ \t]*网易邮箱大师[ \t]*定制)[ \t]*$",
        )
        .unwrap()
    });
    if let Some(m) = mobile_sig.find(s) {
        s = &s[..m.start()];
    }

    let img_placeholder =
        IMG_PLACEHOLDER.get_or_init(|| Regex::new(r"(?i)^\[image:\s*[^\]]*\]$").unwrap());

    let mut out = String::new();
    let mut blank = 0;
    for l in s.lines() {
        let trimmed_start = l.trim_start();
        if trimmed_start.starts_with('>') {
            continue;
        }
        let trimmed = l.trim();
        if img_placeholder.is_match(trimmed) {
            continue;
        }
        if trimmed.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(l.trim_end());
        out.push('\n');
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        normalized
    } else {
        out
    }
}

fn smtp_transport(acc: &Account) -> Result<lettre::SmtpTransport> {
    use lettre::transport::smtp::authentication::Credentials;
    let host = acc.smtp_host.trim();
    let builder = if acc.smtp_port == 465 {
        lettre::SmtpTransport::relay(host)?
    } else {
        lettre::SmtpTransport::starttls_relay(host)?
    };
    Ok(builder
        .port(acc.smtp_port)
        .timeout(Some(Duration::from_secs(20)))
        .credentials(Credentials::new(
            acc.username.trim().to_string(),
            acc.password.trim().to_string(),
        ))
        .build())
}

/// 自定义群聊协议头（兼容 Delta Chat 风格的 Chat-Group-ID / Chat-Group-Name，且自动对中文群名做 RFC2047 编码）
#[derive(Clone)]
struct ChatGroupIdHeader(String);

impl lettre::message::header::Header for ChatGroupIdHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Chat-Group-ID")
    }
    fn parse(s: &str) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

#[derive(Clone)]
struct ChatGroupNameHeader(String);

impl lettre::message::header::Header for ChatGroupNameHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Chat-Group-Name")
    }
    fn parse(s: &str) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

#[derive(Clone)]
struct MailChatQuoteIdHeader(String);

impl lettre::message::header::Header for MailChatQuoteIdHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("X-MailChat-Quote-Id")
    }
    fn parse(s: &str) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

#[derive(Clone)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub struct Outgoing<'a> {
    pub recipients: Vec<String>,
    pub subject: String,
    pub body: &'a str,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub quote_mid: Option<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

/// 发送单聊或群聊（多收件人全员回复，支持图片与文件附件及消息引用头）邮件，返回不带尖括号的 Message-ID
pub fn send(acc: &Account, out: &Outgoing) -> Result<String> {
    use lettre::message::{header::ContentType, Attachment, Body, Mailbox, MultiPart, SinglePart};
    use lettre::Transport;

    if out.recipients.is_empty() {
        anyhow::bail!("收件人列表不能为空");
    }

    let domain = acc.email.split('@').nth(1).unwrap_or("localhost");
    let mid = format!("{}@{}", uuid::Uuid::new_v4(), domain);
    let name = if acc.display_name.is_empty() {
        None
    } else {
        Some(acc.display_name.clone())
    };
    let from = Mailbox::new(name, acc.email.trim().parse().context("发件人邮箱格式无效")?);

    let mut b = lettre::Message::builder()
        .from(from)
        .subject(out.subject.clone())
        .message_id(Some(format!("<{mid}>")));

    for rcpt in &out.recipients {
        let mbox: Mailbox = rcpt
            .parse()
            .with_context(|| format!("收件人邮箱格式无效: {rcpt}"))?;
        b = b.to(mbox);
    }

    if let Some(r) = &out.in_reply_to {
        let clean = r.trim_matches(&['<', '>', ' '][..]);
        if !clean.is_empty() {
            b = b.in_reply_to(format!("<{clean}>"));
        }
    }
    if let Some(r) = &out.references {
        if !r.trim().is_empty() {
            b = b.references(r.clone());
        }
    }
    if let Some(gid) = &out.group_id {
        if !gid.trim().is_empty() {
            b = b.header(ChatGroupIdHeader(gid.trim().to_string()));
        }
    }
    if let Some(gname) = &out.group_name {
        if !gname.trim().is_empty() {
            b = b.header(ChatGroupNameHeader(gname.trim().to_string()));
        }
    }
    if let Some(qmid) = &out.quote_mid {
        let clean = qmid.trim_matches(&['<', '>', ' '][..]);
        if !clean.is_empty() {
            b = b.header(MailChatQuoteIdHeader(format!("<{clean}>")));
        }
    }

    let email = if out.attachments.is_empty() {
        b.header(ContentType::TEXT_PLAIN).body(out.body.to_string())?
    } else {
        let mut mp = MultiPart::mixed().singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(out.body.to_string()),
        );
        for att in &out.attachments {
            let ct = ContentType::parse(&att.mime)
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            mp = mp.singlepart(
                Attachment::new(att.filename.clone()).body(Body::new(att.bytes.clone()), ct),
            );
        }
        b.multipart(mp)?
    };
    smtp_transport(acc)?.send(&email).context("SMTP 发送失败")?;
    Ok(mid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_multi_recipient_group_mail() {
        let raw = b"From: Alice <alice@team.cn>\r\nTo: Me <me@team.cn>, Bob <bob@team.cn>\r\nCc: Carol <carol@team.cn>\r\nChat-Group-ID: grp-123\r\nChat-Group-Name: Team Sync\r\nSubject: Sprint Plan\r\nMessage-ID: <m1@team.cn>\r\n\r\nHi all!\r\n";
        let p = parse_full(raw, "INBOX", 1, 1).unwrap();
        let others = normalize_members(&p.participants, "me@team.cn");
        assert_eq!(others.len(), 3);
        assert_eq!(p.group_id_hdr.as_deref(), Some("grp-123"));
        assert_eq!(p.group_name_hdr.as_deref(), Some("Team Sync"));
    }

    #[test]
    fn imap_id_host_detection() {
        assert!(needs_imap_id("imap.163.com"));
        assert!(needs_imap_id("imap.126.com"));
        assert!(needs_imap_id("imap.yeah.net"));
        assert!(!needs_imap_id("imap.qq.com"));
        assert!(!needs_imap_id("imap.exmail.qq.com"));
        assert!(!needs_imap_id("imap.gmail.com"));
    }

    #[test]
    fn imap_id_untagged_response_does_not_desync_select_tag() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"* OK [CAPABILITY IMAP4rev1 ID] Mock IMAP Ready\r\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut line = String::new();
            // a1 LOGIN ...
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a1 LOGIN"));
            stream.write_all(b"a1 OK LOGIN completed\r\n").unwrap();

            // a2 ID (...)
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a2 ID"));
            stream
                .write_all(b"* ID (\"name\" \"Coremail\" \"version\" \"2.0\")\r\na2 OK ID completed\r\n")
                .unwrap();

            // a3 SELECT INBOX
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a3 SELECT"));
            stream
                .write_all(
                    b"* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 100] UIDs valid\r\na3 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a4 LOGOUT
            line.clear();
            reader.read_line(&mut line).unwrap();
            stream.write_all(b"* BYE Logging out\r\na4 OK LOGOUT completed\r\n").unwrap();
        });

        let tcp = TcpStream::connect(addr).unwrap();
        let mut client = imap::Client::new(tcp);
        client.read_greeting().unwrap();
        let mut session = client.login("user@163.com", "authcode").map_err(|(e, _)| e).unwrap();
        session
            .run_command_and_check_ok(r#"ID ("name" "MailChat" "version" "0.2.0" "vendor" "MailChat")"#)
            .unwrap();
        let mb = session.select("INBOX").unwrap();
        assert_eq!(mb.exists, 3);
        assert_eq!(mb.uid_validity, Some(100));
        session.logout().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn cleans_netease_reply_pipe_table_and_mobile_signatures() {
        let sample = "已收到，谢谢\r\n\r\n---- 回复的原邮件 ----\r\n| 发件人 | arrake<arrake@163.com> |\r\n| 日期 | 2026年11月14日 13:20 |\r\n| 收件人 | arrake@126.com |\r\n| 抄送至 | |\r\n| 主题 | 来自 arrake 的消息 |\r\nhi";
        assert_eq!(clean_body(sample), "已收到，谢谢");

        let with_sig = "好的，马上处理\n\n发自网易邮箱大师\n---- 回复的原邮件 ----\n| 发件人 | a@163.com |\n| 日期 | 2026-11-14 |";
        assert_eq!(clean_body(with_sig), "好的，马上处理");
    }

    #[test]
    fn cleans_multiline_gmail_and_qq_quotes() {
        let gmail_en = "Sounds good to me!\n\nOn Sat, Nov 14, 2026 at 1:20 PM Arrake <arrake@gmail.com>\nwrote:\n> Hello there";
        assert_eq!(clean_body(gmail_en), "Sounds good to me!");

        let gmail_zh = "没问题，下午见\n\narrake <arrake@163.com> 于2026年11月14日周六\n13:20写道：\n> hi";
        assert_eq!(clean_body(gmail_zh), "没问题，下午见");

        let qq_mail = "收到附件了\n\n------------------ 原始邮件 ------------------\n发件人: \"Alice\" <alice@qq.com>;\n发送时间: 2026年11月14日 13:20";
        assert_eq!(clean_body(qq_mail), "收到附件了");
    }

    #[test]
    fn normalizes_wrapped_angle_urls_and_preserves_html_cta_links() {
        let google_alert = "[image: Google]\r\n如果您并未授予访问权限，则应检查此活动，并确保您的账号安全。\r\n查看活动\r\n<https://accounts.google.com/AccountChooser?Email=yita0v0@gmail.com&continue=\r\nhttps://myaccount.google.com/alert/nt/1793841841000?rfn%3D127%26rfnc%3D1>";
        let cleaned = clean_body(google_alert);
        assert_eq!(
            cleaned,
            "如果您并未授予访问权限，则应检查此活动，并确保您的账号安全。\n查看活动\n<https://accounts.google.com/AccountChooser?Email=yita0v0@gmail.com&continue=https://myaccount.google.com/alert/nt/1793841841000?rfn%3D127%26rfnc%3D1>"
        );

        let html = r#"<div><p>安全提醒</p><a href="https://accounts.google.com/AccountChooser?Email=a@b.com&amp;continue=x">查看活动</a></div>"#;
        assert_eq!(
            html_to_text(html),
            "安全提醒\n[查看活动](https://accounts.google.com/AccountChooser?Email=a@b.com&continue=x)"
        );
    }

    #[test]
    fn realtime_idle_push_wakes_immediately_and_inserts_into_inbox_without_llm_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"* OK IMAP4rev1 Ready\r\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            // a1 LOGIN
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a1 LOGIN"));
            stream.write_all(b"a1 OK LOGIN completed\r\n").unwrap();

            // a2 CAPABILITY
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a2 CAPABILITY"));
            stream
                .write_all(b"* CAPABILITY IMAP4rev1 IDLE UIDPLUS\r\na2 OK CAPABILITY completed\r\n")
                .unwrap();

            // a3 SELECT "INBOX"
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a3 SELECT"));
            stream
                .write_all(
                    b"* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 77] ok\r\n* OK [UIDNEXT 11] next\r\na3 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a4 IDLE -> 立即推送新邮件 * 2 EXISTS
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a4 IDLE"));
            stream.write_all(b"+ idling\r\n* 2 EXISTS\r\n").unwrap();

            // 客户端收到推送后应立即发送 DONE
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, "DONE\r\n");
            stream.write_all(b"a4 OK IDLE terminated\r\n").unwrap();

            // a5 SELECT "INBOX"（UIDNEXT 推进至 12）
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a5 SELECT"));
            stream
                .write_all(
                    b"* 2 EXISTS\r\n* 1 RECENT\r\n* OK [UIDVALIDITY 77] ok\r\n* OK [UIDNEXT 12] next\r\na5 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a6 UID SEARCH UID 11:*
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a6 UID SEARCH UID 11:*"));
            stream.write_all(b"* SEARCH 11\r\na6 OK SEARCH completed\r\n").unwrap();

            // a7 UID FETCH 11 (UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER])
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a7 UID FETCH 11"));
            assert!(!line.contains("BODY.PEEK[]"));
            let top_hdr = concat!(
                "From: Alice <alice@example.com>\r\n",
                "To: me@example.com\r\n",
                "Subject: 实时推送测试\r\n",
                "Message-ID: <push-11@example.com>\r\n",
                "Content-Type: text/plain; charset=utf-8\r\n\r\n"
            );
            let body_part = "您的登录验证码是 839201\r\n";
            let bs = format!(
                r#"("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" {} 1 NIL NIL NIL NIL)"#,
                body_part.len()
            );
            let resp_a7 = format!(
                "* 2 FETCH (UID 11 FLAGS () RFC822.SIZE {} BODYSTRUCTURE {} BODY[HEADER] {{{}}}\r\n",
                top_hdr.len() + body_part.len(),
                bs,
                top_hdr.len()
            );
            stream.write_all(resp_a7.as_bytes()).unwrap();
            stream.write_all(top_hdr.as_bytes()).unwrap();
            stream.write_all(b")\r\na7 OK FETCH completed\r\n").unwrap();

            // a8 UID FETCH 11 (UID FLAGS BODY.PEEK[])（纯文本无附件小邮件批量拉取正文）
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a8 UID FETCH 11"));
            let raw_mail = format!("{top_hdr}{body_part}");
            let resp_a8 = format!(
                "* 2 FETCH (UID 11 FLAGS () BODY[] {{{}}}\r\n",
                raw_mail.len()
            );
            stream.write_all(resp_a8.as_bytes()).unwrap();
            stream.write_all(raw_mail.as_bytes()).unwrap();
            stream.write_all(b")\r\na8 OK FETCH completed\r\n").unwrap();

            // a9 SELECT "INBOX"（再次检查时 UIDNEXT 仍为 12，客户端应直接短路跳过 UID SEARCH！）
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a9 SELECT"));
            stream
                .write_all(
                    b"* 2 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 77] ok\r\n* OK [UIDNEXT 12] next\r\na9 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a10 LOGOUT
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a10 LOGOUT"));
            stream.write_all(b"* BYE bye\r\na10 OK LOGOUT\r\n").unwrap();
        });

        let tmp = std::env::temp_dir().join(format!("mailchat_idle_test_{}.db", uuid::Uuid::new_v4()));
        let db = Db::open(&tmp).unwrap();
        let acc = Account {
            email: "me@example.com".into(),
            ..Default::default()
        };
        db.save_account(&acc).unwrap();
        db.save_sync_state("INBOX", 77, 10).unwrap();

        let tcp = TcpStream::connect(addr).unwrap();
        let mut client = imap::Client::new(tcp);
        client.read_greeting().unwrap();
        let mut session = client.login("me@example.com", "secret").map_err(|(e, _)| e).unwrap();

        assert!(session_supports_idle_on(&mut session));
        session.select("INBOX").unwrap();

        let ev = wait_for_inbox_event_on(&mut session, Duration::from_secs(5)).unwrap();
        assert_eq!(ev, WatchEvent::Changed);

        let added = sync_folder_on(&mut session, "INBOX", false, &acc, &db, &[], true).unwrap();
        assert_eq!(added, 1);

        // 即使启用了 AI Agent，新到达邮件也必须立刻出现在 inbox 会话列表，且附带确定性提取出的验证码
        let convs = db.conversations("inbox").unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].peer, "alice@example.com");
        assert!(convs[0].preview.contains("839201"));
        // 同时仍在 pending 队列中等待后台 AI 补充分类与摘要
        assert_eq!(db.pending().unwrap().len(), 1);

        // 无新邮件时依赖 UIDNEXT=12 短路，不再发送多余的 UID SEARCH
        let added_again = sync_folder_on(&mut session, "INBOX", false, &acc, &db, &[], true).unwrap();
        assert_eq!(added_again, 0);

        session.logout().unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn graceful_fallback_when_server_rejects_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"* OK Ready\r\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            reader.read_line(&mut line).unwrap();
            stream.write_all(b"a1 OK LOGIN\r\n").unwrap();

            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a2 IDLE"));
            stream.write_all(b"a2 BAD IDLE not permitted\r\n").unwrap();
            // Drop 时若底层写出 DONE 也平静消费，不崩溃
            let _ = reader.read_line(&mut line);
        });

        let tcp = TcpStream::connect(addr).unwrap();
        let mut client = imap::Client::new(tcp);
        client.read_greeting().unwrap();
        let mut session = client.login("u", "p").map_err(|(e, _)| e).unwrap();

        let ev = wait_for_inbox_event_on(&mut session, Duration::from_secs(2)).unwrap();
        assert_eq!(ev, WatchEvent::IdleRejected);
        server.join().unwrap();
    }

    #[test]
    fn extracts_genuine_html_and_resolves_cid_while_keeping_plain_text_clean() {
        // 1. 纯文本邮件：不得将 mail-parser 自动合成的 HTML 存入 body_html
        let plain_only = concat!(
            "From: Bob <bob@example.com>\r\n",
            "To: me@example.com\r\n",
            "Subject: Lunch\r\n",
            "Message-ID: <plain-1@example.com>\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n\r\n",
            "已收到，谢谢\r\n"
        );
        let parsed_plain = parse_full(plain_only.as_bytes(), "INBOX", 1, 1).unwrap();
        assert_eq!(parsed_plain.msg.body, "已收到，谢谢");
        assert!(parsed_plain.msg.body_html.is_empty());

        // 2. 富 HTML 安全通知邮件（含 multipart/alternative + cid 内联 PNG 图标）
        let google_like = concat!(
            "From: Google <no-reply@accounts.google.com>\r\n",
            "To: arrake@126.com\r\n",
            "Subject: 有人已将您的电子邮件地址添加为其辅助邮箱\r\n",
            "Message-ID: <google-recovery-1@accounts.google.com>\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/related; boundary=\"rel_bound\"\r\n\r\n",
            "--rel_bound\r\n",
            "Content-Type: multipart/alternative; boundary=\"alt_bound\"\r\n\r\n",
            "--alt_bound\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n\r\n",
            "[image: Google]\r\n有人已将 arrake@126.com 添加为其辅助邮箱。\r\n查看活动\r\n<https://accounts.google.com/AccountChooser?Email=yita0v0@gmail.com>\r\n",
            "--alt_bound\r\n",
            "Content-Type: text/html; charset=utf-8\r\n\r\n",
            "<html><body><div style=\"border:1px solid #dadce0;border-radius:8px;padding:24px\"><img src=\"cid:google_logo@gstatic\" width=\"74\" height=\"24\" alt=\"Google\"><h2>有人已将您的电子邮件地址添加为其辅助邮箱</h2><a href=\"https://accounts.google.com/AccountChooser?Email=yita0v0@gmail.com\" style=\"background:#4184f3;color:#fff;padding:10px 24px;border-radius:4px\">查看活动</a></div></body></html>\r\n",
            "--alt_bound--\r\n",
            "--rel_bound\r\n",
            "Content-Type: image/png\r\n",
            "Content-ID: <google_logo@gstatic>\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\n",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\r\n",
            "--rel_bound--\r\n"
        );
        let parsed_html = parse_full(google_like.as_bytes(), "INBOX", 2, 1).unwrap();
        assert!(parsed_html.msg.body.contains("有人已将 arrake@126.com 添加为其辅助邮箱"));
        assert!(parsed_html.msg.body_html.contains("data:image/png;base64,"));
        assert!(!parsed_html.msg.body_html.contains("cid:google_logo@gstatic"));
        assert!(parsed_html.msg.body_html.contains("查看活动"));
        assert!(parsed_html.raw_attachments.is_empty());
    }

    #[test]
    fn parses_attachments_and_quote_header_and_roundtrips_base64() {
        let sample_bytes = b"\x89PNG\r\n\x1a\nmock_png_payload_12345";
        let encoded = base64_encode(sample_bytes);
        let decoded = base64_decode(&format!("data:image/png;base64,{encoded}")).unwrap();
        assert_eq!(decoded, sample_bytes);

        let raw_with_att = concat!(
            "From: Arrake <arrake@126.com>\r\n",
            "To: arrake@163.com\r\n",
            "Subject: Re: 来自 arrake 的消息\r\n",
            "Message-ID: <reply-99@126.com>\r\n",
            "In-Reply-To: <orig-1@163.com>\r\n",
            "X-MailChat-Quote-Id: <orig-1@163.com>\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=\"mix_b\"\r\n\r\n",
            "--mix_b\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n\r\n",
            "具体什么情况\r\n",
            "--mix_b\r\n",
            "Content-Type: image/png; name=\"screenshot.png\"\r\n",
            "Content-Disposition: attachment; filename=\"screenshot.png\"\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\n",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\r\n",
            "--mix_b\r\n",
            "Content-Type: text/plain; charset=utf-8; name=\"notes.txt\"\r\n",
            "Content-Disposition: attachment; filename=\"notes.txt\"\r\n\r\n",
            "Hello attachment!\r\n",
            "--mix_b--\r\n"
        );

        let parsed = parse_full(raw_with_att.as_bytes(), "INBOX", 9, 1).unwrap();
        assert_eq!(parsed.msg.body, "具体什么情况");
        assert_eq!(parsed.quote_mid_hdr.as_deref(), Some("<orig-1@163.com>"));
        assert_eq!(parsed.raw_attachments.len(), 2);
        assert_eq!(parsed.raw_attachments[0].filename, "screenshot.png");
        assert_eq!(parsed.raw_attachments[0].mime, "image/png");
        assert_eq!(parsed.raw_attachments[1].filename, "notes.txt");
        assert_eq!(parsed.raw_attachments[1].bytes, b"Hello attachment!");
        assert_eq!(parsed.msg.attachments.len(), 2);
        assert!(parsed.msg.attachments[0].rel_path.is_empty());
        assert!(parsed.msg.attachments[0].saved_path.is_empty());
    }

    #[test]
    fn sync_never_downloads_or_saves_attachments_and_fetches_only_requested_part_on_demand() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let docx_payload = b"PK\x03\x04mock_docx_binary_payload";
        let docx_b64 = base64_encode(docx_payload);

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"* OK IMAP4rev1 Ready\r\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            // a1 LOGIN
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a1 LOGIN"));
            stream.write_all(b"a1 OK LOGIN completed\r\n").unwrap();

            // a2 SELECT "INBOX"
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a2 SELECT"));
            stream
                .write_all(
                    b"* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 88] ok\r\na2 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a3 UID SEARCH ALL
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a3 UID SEARCH"));
            stream.write_all(b"* SEARCH 5\r\na3 OK SEARCH completed\r\n").unwrap();

            // a4 UID FETCH 5 (UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER])
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a4 UID FETCH 5"));
            assert!(line.contains("BODYSTRUCTURE"));
            assert!(!line.contains("BODY.PEEK[]"));

            let top_hdr = concat!(
                "From: Sender <sender@example.com>\r\n",
                "To: me@example.com\r\n",
                "Subject: 文件通知\r\n",
                "Message-ID: <sec-5@example.com>\r\n",
                "MIME-Version: 1.0\r\n",
                "Content-Type: multipart/mixed; boundary=\"mix_b\"\r\n\r\n"
            );
            let bs = concat!(
                "(",
                "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"8BIT\" 18 1 NIL NIL NIL NIL)",
                "(\"APPLICATION\" \"OCTET-STREAM\" (\"NAME\" \"JiJiDown_setup.exe\") NIL NIL \"BASE64\" 2088960 NIL (\"ATTACHMENT\" (\"FILENAME\" \"JiJiDown_setup.exe\")) NIL NIL)",
                "(\"APPLICATION\" \"VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT\" NIL NIL NIL \"BASE64\" 40 NIL (\"ATTACHMENT\" (\"FILENAME*\" \"UTF-8''%E6%B4%BE%E5%8F%91%E9%80%9A%E7%9F%A5.docx\")) NIL NIL)",
                " \"MIXED\" (\"BOUNDARY\" \"mix_b\") NIL NIL NIL)"
            );
            let resp_a4 = format!(
                "* 1 FETCH (UID 5 FLAGS () RFC822.SIZE 2095000 BODYSTRUCTURE {bs} BODY[HEADER] {{{}}})\r\n",
                top_hdr.len()
            );
            // 注意 IMAP literal 后还有闭合括号
            let resp_a4_open = format!(
                "* 1 FETCH (UID 5 FLAGS () RFC822.SIZE 2095000 BODYSTRUCTURE {bs} BODY[HEADER] {{{}}}\r\n",
                top_hdr.len()
            );
            let _ = resp_a4;
            stream.write_all(resp_a4_open.as_bytes()).unwrap();
            stream.write_all(top_hdr.as_bytes()).unwrap();
            stream.write_all(b")\r\na4 OK FETCH completed\r\n").unwrap();

            // a5 部分分段拉取：仅拉取正文 1 与附件 2.MIME / 3.MIME，严禁请求 BODY.PEEK[2] 或 BODY.PEEK[3]！
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a5 UID FETCH 5"));
            assert!(line.contains("BODY.PEEK[1]"));
            assert!(line.contains("BODY.PEEK[2.MIME]"));
            assert!(line.contains("BODY.PEEK[3.MIME]"));
            assert!(
                !line.contains("BODY.PEEK[2]"),
                "严禁在同步阶段拉取 .exe 附件内容: {line}"
            );
            assert!(
                !line.contains("BODY.PEEK[3]"),
                "严禁在同步阶段拉取 .docx 附件内容: {line}"
            );
            assert!(!line.contains("BODY.PEEK[]"));

            let m1 = b"Content-Type: text/plain; charset=utf-8\r\n\r\n";
            let b1 = "请查收通知文档\r\n".as_bytes();
            let m2 = b"Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"JiJiDown_setup.exe\"\r\nContent-Transfer-Encoding: base64\r\n\r\n";
            let m3 = b"Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\nContent-Disposition: attachment; filename*=UTF-8''%E6%B4%BE%E5%8F%91%E9%80%9A%E7%9F%A5.docx\r\nContent-Transfer-Encoding: base64\r\n\r\n";

            stream.write_all(b"* 1 FETCH (UID 5 ").unwrap();
            stream
                .write_all(format!("BODY[1.MIME] {{{}}}\r\n", m1.len()).as_bytes())
                .unwrap();
            stream.write_all(m1).unwrap();
            stream
                .write_all(format!(" BODY[1] {{{}}}\r\n", b1.len()).as_bytes())
                .unwrap();
            stream.write_all(b1).unwrap();
            stream
                .write_all(format!(" BODY[2.MIME] {{{}}}\r\n", m2.len()).as_bytes())
                .unwrap();
            stream.write_all(m2).unwrap();
            stream
                .write_all(format!(" BODY[3.MIME] {{{}}}\r\n", m3.len()).as_bytes())
                .unwrap();
            stream.write_all(m3).unwrap();
            stream.write_all(b")\r\na5 OK FETCH completed\r\n").unwrap();

            // 用户稍后主动在 UI 上仅对“派发通知.docx”（part 3）确认另存为：
            // a6 SELECT "INBOX"
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a6 SELECT"));
            stream
                .write_all(
                    b"* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 88] ok\r\na6 OK [READ-WRITE] SELECT completed\r\n",
                )
                .unwrap();

            // a7 UID FETCH 5 (UID BODY.PEEK[3.MIME] BODY.PEEK[3]) —— 绝不触碰第 2 段 .exe！
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("a7 UID FETCH 5"));
            assert!(line.contains("BODY.PEEK[3.MIME]"));
            assert!(line.contains("BODY.PEEK[3]"));
            assert!(!line.contains("BODY.PEEK[2]"));

            let b3 = format!("{docx_b64}\r\n");
            stream.write_all(b"* 1 FETCH (UID 5 ").unwrap();
            stream
                .write_all(format!("BODY[3.MIME] {{{}}}\r\n", m3.len()).as_bytes())
                .unwrap();
            stream.write_all(m3).unwrap();
            stream
                .write_all(format!(" BODY[3] {{{}}}\r\n", b3.len()).as_bytes())
                .unwrap();
            stream.write_all(b3.as_bytes()).unwrap();
            stream.write_all(b")\r\na7 OK FETCH completed\r\n").unwrap();

            // a8 LOGOUT
            line.clear();
            reader.read_line(&mut line).unwrap();
            stream.write_all(b"* BYE bye\r\na8 OK LOGOUT\r\n").unwrap();
        });

        let tmp_dir = std::env::temp_dir().join(format!("mailchat_no_autodl_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).unwrap();
        // 模拟遗留的旧版自动下载目录与高危文件：Db::open 启动时必须立即清除！
        let legacy_att_dir = tmp_dir.join("attachments");
        std::fs::create_dir_all(&legacy_att_dir).unwrap();
        std::fs::write(legacy_att_dir.join("0ab39625c7d8_JiJiDown_setup.exe"), b"legacy_exe").unwrap();
        assert!(legacy_att_dir.exists());

        let db_path = tmp_dir.join("mailchat.db");
        let db = Db::open(&db_path).unwrap();
        assert!(
            !db.attachments_dir().exists(),
            "启动 Db::open 时必须自动清理遗留的自动下载附件目录"
        );

        let acc = Account {
            email: "me@example.com".into(),
            ..Default::default()
        };
        db.save_account(&acc).unwrap();

        let tcp = TcpStream::connect(addr).unwrap();
        let mut client = imap::Client::new(tcp);
        client.read_greeting().unwrap();
        let mut session = client.login("me@example.com", "secret").map_err(|(e, _)| e).unwrap();

        let added = sync_folder_on(&mut session, "INBOX", false, &acc, &db, &[], false).unwrap();
        assert_eq!(added, 1);
        assert!(
            !db.attachments_dir().exists(),
            "同步邮件后严禁在磁盘上创建 attachments 目录或写入任何文件"
        );

        let msgs = db.messages("sender@example.com", "inbox").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].body, "请查收通知文档");
        assert_eq!(msgs[0].attachments.len(), 2);
        assert_eq!(msgs[0].attachments[0].filename, "JiJiDown_setup.exe");
        assert_eq!(msgs[0].attachments[0].part_id, "2");
        assert!(msgs[0].attachments[0].saved_path.is_empty());
        assert!(msgs[0].attachments[0].rel_path.is_empty());

        assert_eq!(msgs[0].attachments[1].filename, "派发通知.docx");
        assert_eq!(msgs[0].attachments[1].part_id, "3");
        assert!(msgs[0].attachments[1].saved_path.is_empty());

        // 用户主动下载第 2 个附件（派发通知.docx）
        let loc = db
            .locate_attachment(msgs[0].id, &msgs[0].attachments[1].id)
            .unwrap()
            .unwrap();
        let (downloaded, mime) = fetch_attachment_bytes_on(
            &mut session,
            &loc.folder,
            loc.uid,
            &loc.rfc_message_id,
            &loc.meta,
        )
        .unwrap();
        assert_eq!(downloaded, docx_payload);
        assert_eq!(
            mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert!(
            !db.attachments_dir().exists(),
            "按需拉取到内存后仍不得在应用数据目录自动落盘"
        );

        session.logout().unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
