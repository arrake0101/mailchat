//! 邮件协议层：IMAP 增量收取、单聊与多人邮件群聊聚合（Chat-Group-ID / 线程 / 多收件人）、
//! MIME/HTML 解析、引用剥离、验证码提取、SMTP 多收件人（Reply-All）发送。

use crate::agent::apply_rules;
use crate::db::{default_group_title, normalize_members, Account, Db, GroupMember, NewMessage, Rule};
use anyhow::{anyhow, Context, Result};
use mail_parser::{Addr, HeaderValue, MessageParser};
use regex::Regex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;

/// 首次同步时每个文件夹最多拉取的邮件数
const INITIAL_FETCH: usize = 200;

pub struct SyncOutcome {
    pub new_incoming: usize,
}

pub struct ParsedMail {
    pub msg: NewMessage,
    pub participants: Vec<GroupMember>,
    pub ref_ids: Vec<String>,
    pub group_id_hdr: Option<String>,
    pub group_name_hdr: Option<String>,
}

fn connect(acc: &Account) -> Result<Session> {
    let addr = (acc.imap_host.as_str(), acc.imap_port)
        .to_socket_addrs()
        .with_context(|| format!("无法解析 IMAP 服务器地址 {}:{}", acc.imap_host, acc.imap_port))?
        .next()
        .ok_or_else(|| anyhow!("无法解析 IMAP 服务器地址 {}", acc.imap_host))?;

    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(15))
        .with_context(|| format!("无法连接 IMAP 服务器 {}:{}", acc.imap_host, acc.imap_port))?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(45)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));

    let tls = native_tls::TlsConnector::builder().build()?;
    let tls_stream = tls
        .connect(&acc.imap_host, tcp)
        .with_context(|| format!("IMAP SSL/TLS 握手失败 ({})", acc.imap_host))?;

    let mut client = imap::Client::new(tls_stream);
    client
        .read_greeting()
        .context("读取 IMAP 服务器欢迎响应失败")?;

    let mut session = client
        .login(&acc.username, &acc.password)
        .map_err(|(e, _)| anyhow!("IMAP 登录失败（请检查邮箱授权码/应用专用密码）: {e}"))?;

    // 网易系邮箱（163/126/yeah）要求先发送 IMAP ID，否则 SELECT 报 "Unsafe Login"
    let _ = session.run_command_and_check_ok(r#"ID ("name" "MailChat" "version" "0.2.0" "vendor" "MailChat")"#);
    Ok(session)
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

fn find_sent_folder(session: &mut Session) -> Option<String> {
    let names = session.list(None, Some("*")).ok()?;
    for n in names.iter() {
        let is_sent = n.attributes().iter().any(|a| match a {
            imap::types::NameAttribute::Custom(s) => s.eq_ignore_ascii_case("\\Sent"),
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

pub fn sync(acc: &Account, db: &Db, agent_enabled: bool) -> Result<SyncOutcome> {
    let mut session = connect(acc)?;
    let rules = db.rules()?;
    let mut new_incoming = sync_folder(&mut session, "INBOX", false, acc, db, &rules, agent_enabled)?;
    if let Some(sent) = find_sent_folder(&mut session) {
        new_incoming += sync_folder(&mut session, &sent, true, acc, db, &rules, agent_enabled)?;
    }
    let _ = session.logout();
    Ok(SyncOutcome { new_incoming })
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

fn sync_folder(
    session: &mut Session,
    folder: &str,
    is_sent: bool,
    acc: &Account,
    db: &Db,
    rules: &[Rule],
    agent_enabled: bool,
) -> Result<usize> {
    let mb = session.select(folder).with_context(|| format!("打开文件夹 {folder} 失败"))?;
    let validity = mb.uid_validity.unwrap_or(0);
    let (stored_validity, stored_last) = db.sync_state(folder)?;
    let last = if stored_validity == validity { stored_last } else { 0 };

    let mut uids: Vec<u32> = if last == 0 {
        session.uid_search("ALL")?.into_iter().collect()
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

    let me = acc.email.trim().to_lowercase();
    let mut max_uid = last;
    let mut new_incoming = 0;
    for chunk in uids.chunks(50) {
        let set = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        let fetches = session.uid_fetch(&set, "(UID FLAGS BODY.PEEK[])")?;
        for f in fetches.iter() {
            let uid = f.uid.unwrap_or(0);
            max_uid = max_uid.max(uid);
            let Some(raw) = f.body() else { continue };
            let seen = f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
            let Some(parsed) = parse_full(raw, folder, uid, validity) else { continue };
            let mut nm = parsed.msg;

            nm.outgoing = is_sent || nm.from_addr == me;
            let others = normalize_members(&parsed.participants, &me);

            // 判断归属群聊还是单聊：
            // 1. 优先识别 Chat-Group-ID / X-MailChat-Group-Id 协议头
            // 2. 其次沿用 In-Reply-To / References 关联的已有群聊（中途增减抄送人也不裂变）
            // 3. 若除自己外参与人数 >= 2，则自动聚合为多人邮件群聊
            let group_peer = if let Some(gid) = &parsed.group_id_hdr {
                let clean = gid.trim_start_matches("group:");
                Some(format!("group:{clean}"))
            } else if let Some(existing_grp) = db.find_group_by_refs(&parsed.ref_ids)? {
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
                let grp = db.upsert_group(&gp, &title, &others, &me, false)?;
                group_muted = grp.muted;
                nm.peer = gp;
                if nm.category.is_empty() {
                    nm.category = "群聊".into();
                }
            } else if nm.outgoing {
                match nm.to_addrs.split(',').next().filter(|s| !s.is_empty()) {
                    Some(p) => nm.peer = p.to_string(),
                    None => continue,
                }
            } else {
                nm.peer = nm.from_addr.clone();
            }

            nm.read = seen || nm.outgoing;

            // 分流逻辑：发出的邮件 / 群免打扰（支持 @我 穿透提醒）/ 规则引擎 / AI Agent
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
            } else if let Some(hit) = apply_rules(rules, &nm.from_addr, &nm.subject, &nm.body_full) {
                nm.status = hit.status.into();
                nm.reason = hit.reason;
                nm.agent_done = true;
            } else if agent_enabled && !(last == 0 && seen) {
                nm.status = "pending".into();
            } else {
                nm.agent_done = true;
            }

            if db.insert_message(&nm)?.is_some() && !nm.outgoing {
                new_incoming += 1;
            }
        }
    }
    db.save_sync_state(folder, validity, max_uid)?;
    Ok(new_incoming)
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

    let plain = msg.body_text(0).map(|s| s.into_owned()).unwrap_or_default();
    let raw_body = if !plain.trim().is_empty() {
        plain
    } else if let Some(html) = msg.body_html(0) {
        html_to_text(&html)
    } else {
        String::new()
    };

    let body_full = raw_body.replace("\r\n", "\n").trim().to_string();
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
        },
        participants,
        ref_ids,
        group_id_hdr,
        group_name_hdr,
    })
}

/// 将仅含 HTML 的通知/业务邮件转换为整洁可读的纯文本
pub fn html_to_text(html: &str) -> String {
    static DROP_BLOCKS: OnceLock<Regex> = OnceLock::new();
    static LINE_BREAKS: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static NUM_ENTITY: OnceLock<Regex> = OnceLock::new();

    let drop_blocks = DROP_BLOCKS.get_or_init(|| {
        Regex::new(r"(?is)<(script|style|head|noscript|svg)[^>]*>.*?</(script|style|head|noscript|svg)>").unwrap()
    });
    let line_breaks = LINE_BREAKS.get_or_init(|| {
        Regex::new(r"(?i)<(br|hr)\s*/?>|</(p|div|tr|li|h[1-6]|blockquote|section|article|table|header|footer)>").unwrap()
    });
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let num_entity = NUM_ENTITY.get_or_init(|| Regex::new(r"&#(\d{2,6});").unwrap());

    let s = drop_blocks.replace_all(html, "");
    let s = line_breaks.replace_all(&s, "\n");
    let s = tags.replace_all(&s, "");

    let decoded = s
        .replace("&nbsp;", " ")
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
        .replace("&copy;", "©");

    let decoded = num_entity.replace_all(&decoded, |caps: &regex::Captures| {
        caps[1]
            .parse::<u32>()
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
    out.trim().to_string()
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

/// 把邮件正文变成“聊天气泡”：去掉引用的历史邮件、签名和多余空行。
pub fn clean_body(text: &str) -> String {
    static CUT: OnceLock<Regex> = OnceLock::new();
    let cut = CUT.get_or_init(|| {
        Regex::new(
            r"(?mi)^(On .{4,200}wrote:\s*$|在 .{4,200}写道[：:]\s*$|-{2,}\s*(Original Message|原始邮件|Forwarded message|转发邮件)\s*-{2,}|_{5,}\s*$|From: .+\nSent: |发件人[:：].+\n(发送时间|时间|日期)[:：])",
        )
        .unwrap()
    });
    let mut s = text;
    if let Some(m) = cut.find(s) {
        s = &s[..m.start()];
    }
    if let Some(i) = s.find("\n-- \n") {
        s = &s[..i];
    }
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim_start().starts_with('>')).collect();
    let mut out = String::new();
    let mut blank = 0;
    for l in lines {
        if l.trim().is_empty() {
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
    if out.is_empty() { text.trim().to_string() } else { out }
}

fn smtp_transport(acc: &Account) -> Result<lettre::SmtpTransport> {
    use lettre::transport::smtp::authentication::Credentials;
    let builder = if acc.smtp_port == 465 {
        lettre::SmtpTransport::relay(&acc.smtp_host)?
    } else {
        lettre::SmtpTransport::starttls_relay(&acc.smtp_host)?
    };
    Ok(builder
        .port(acc.smtp_port)
        .timeout(Some(Duration::from_secs(20)))
        .credentials(Credentials::new(acc.username.clone(), acc.password.clone()))
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

pub struct Outgoing<'a> {
    pub recipients: Vec<String>,
    pub subject: String,
    pub body: &'a str,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
}

/// 发送单聊或群聊（多收件人全员回复）邮件，返回不带尖括号的 Message-ID
pub fn send(acc: &Account, out: &Outgoing) -> Result<String> {
    use lettre::message::{header::ContentType, Mailbox};
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
    let from = Mailbox::new(name, acc.email.parse().context("发件人邮箱格式无效")?);

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

    let email = b.header(ContentType::TEXT_PLAIN).body(out.body.to_string())?;
    smtp_transport(acc)?.send(&email).context("SMTP 发送失败")?;
    Ok(mid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multi_recipient_group_mail() {
        let raw = b"From: Alice <alice@team.cn>\r\nTo: Me <me@team.cn>, Bob <bob@team.cn>\r\nCc: Carol <carol@team.cn>\r\nChat-Group-ID: grp-123\r\nChat-Group-Name: Team Sync\r\nSubject: Sprint Plan\r\nMessage-ID: <m1@team.cn>\r\n\r\nHi all!\r\n";
        let p = parse_full(raw, "INBOX", 1, 1).unwrap();
        let others = normalize_members(&p.participants, "me@team.cn");
        assert_eq!(others.len(), 3);
        assert_eq!(p.group_id_hdr.as_deref(), Some("grp-123"));
        assert_eq!(p.group_name_hdr.as_deref(), Some("Team Sync"));
    }
}
