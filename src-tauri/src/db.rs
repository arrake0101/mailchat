//! SQLite 存储：账号、邮件、单聊与群聊聚合、群成员管理、过滤规则、多模型 Agent 配置与演示数据。

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Account {
    pub email: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

fn default_preset() -> String {
    "deepseek".into()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub enabled: bool,
    /// 预设标识：deepseek | openai | qwen | kimi | siliconflow | anthropic | gemini | ollama | custom
    #[serde(default = "default_preset")]
    pub preset: String,
    /// 协议类型：openai | anthropic | gemini
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 用户用自然语言描述的处理偏好
    pub instructions: String,
    /// 是否为需要回复的聊天邮件自动起草快捷回复建议
    #[serde(default = "default_true")]
    pub auto_draft: bool,
    /// Agent 判定为垃圾/诈骗邮件时是否自动将该发件人加入屏蔽规则
    #[serde(default)]
    pub auto_block_sender: bool,
    /// 按 preset 保存各自的连接配置，切换模型服务商时不丢失 Key 和模型名
    #[serde(default)]
    pub profiles: HashMap<String, ProviderProfile>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: "deepseek".into(),
            provider: "openai".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: String::new(),
            model: "deepseek-v4.1-flash".into(),
            instructions: "1. 屏蔽营销推广、电商促销、广告群发、钓鱼诈骗和垃圾邮件（block）。\n2. 系统通知、银行账单、登录验证码、物流动态、订阅周刊折叠进「通知」（archive）。\n3. 真人来信、同事/客户工作沟通、需要我回复的重要事项保留在「聊天」（inbox）。".into(),
            auto_draft: true,
            auto_block_sender: false,
            profiles: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: i64,
    /// allow_sender | block_sender | block_domain | block_keyword | archive_sender | archive_keyword
    pub kind: String,
    pub pattern: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GroupMember {
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    /// 形如 "group:<id>"
    pub peer: String,
    pub name: String,
    pub members: Vec<GroupMember>,
    pub muted: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MailboxStats {
    pub inbox_unread: i64,
    pub archived_unread: i64,
    pub blocked_count: i64,
    pub pending_count: i64,
    pub has_demo: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub peer: String,
    pub name: String,
    pub preview: String,
    pub last_date: i64,
    pub unread: i64,
    pub count: i64,
    pub category: String,
    pub is_group: bool,
    pub members: Vec<GroupMember>,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageDto {
    pub id: i64,
    pub peer: String,
    pub from_addr: String,
    pub from_name: String,
    pub subject: String,
    pub body: String,
    pub body_full: String,
    pub date: i64,
    pub outgoing: bool,
    pub status: String,
    pub category: String,
    pub summary: String,
    pub reason: String,
    pub extracted_code: String,
    pub suggested_reply: String,
}

/// 写入一封邮件所需的字段
pub struct NewMessage {
    pub folder: String,
    pub uid: u32,
    pub message_id: String,
    pub in_reply_to: String,
    pub references: String,
    pub from_addr: String,
    pub from_name: String,
    pub to_addrs: String,
    pub cc_addrs: String,
    pub subject: String,
    pub body: String,
    pub body_full: String,
    pub date: i64,
    pub outgoing: bool,
    pub peer: String,
    pub status: String,
    pub category: String,
    pub summary: String,
    pub reason: String,
    pub extracted_code: String,
    pub suggested_reply: String,
    pub read: bool,
    pub agent_done: bool,
}

pub struct ReplyContext {
    pub subject: String,
    pub message_id: String,
    pub references: String,
}

pub struct PendingItem {
    pub id: i64,
    pub from_addr: String,
    pub from_name: String,
    pub subject: String,
    pub body_full: String,
    pub existing_code: String,
}

pub struct HistoryItem {
    pub outgoing: bool,
    pub from_name: String,
    pub from_addr: String,
    pub subject: String,
    pub body: String,
}

pub fn normalize_members(list: &[GroupMember], exclude_email: &str) -> Vec<GroupMember> {
    let ex = exclude_email.trim().to_lowercase();
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for m in list {
        let email = m.email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') || (!ex.is_empty() && email == ex) {
            continue;
        }
        let name = m.name.trim().to_string();
        map.entry(email)
            .and_modify(|existing| {
                if existing.is_empty() && !name.is_empty() {
                    *existing = name.clone();
                }
            })
            .or_insert(name);
    }
    map.into_iter()
        .map(|(email, name)| GroupMember { email, name })
        .collect()
}

pub fn default_group_title(subject: &str, members: &[GroupMember]) -> String {
    let cleaned = subject
        .trim()
        .trim_start_matches(|c: char| c.is_whitespace())
        .to_string();
    let stripped = regex::Regex::new(r"(?i)^((re|fwd?|回复|转发)\s*[:：]\s*)+")
        .map(|re| re.replace(&cleaned, "").trim().to_string())
        .unwrap_or(cleaned);
    if !stripped.is_empty() && stripped != "(无主题)" {
        return stripped.chars().take(36).collect();
    }
    let names: Vec<String> = members
        .iter()
        .take(3)
        .map(|m| {
            if !m.name.trim().is_empty() {
                m.name.trim().to_string()
            } else {
                m.email.split('@').next().unwrap_or(&m.email).to_string()
            }
        })
        .collect();
    if names.is_empty() {
        "未命名群聊".into()
    } else if members.len() > 3 {
        format!("{} 等 {} 人", names.join("、"), members.len() + 1)
    } else {
        format!("{} 群聊", names.join("、"))
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder TEXT NOT NULL,
                uid INTEGER NOT NULL,
                message_id TEXT NOT NULL UNIQUE,
                in_reply_to TEXT NOT NULL DEFAULT '',
                references_hdr TEXT NOT NULL DEFAULT '',
                from_addr TEXT NOT NULL,
                from_name TEXT NOT NULL DEFAULT '',
                to_addrs TEXT NOT NULL DEFAULT '',
                cc_addrs TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                body_full TEXT NOT NULL DEFAULT '',
                date INTEGER NOT NULL,
                outgoing INTEGER NOT NULL DEFAULT 0,
                peer TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'inbox',
                category TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                extracted_code TEXT NOT NULL DEFAULT '',
                suggested_reply TEXT NOT NULL DEFAULT '',
                read INTEGER NOT NULL DEFAULT 0,
                agent_done INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_msg_peer ON messages(peer, status, date);
            CREATE TABLE IF NOT EXISTS sync_state (
                folder TEXT PRIMARY KEY, uidvalidity INTEGER NOT NULL, last_uid INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL, pattern TEXT NOT NULL,
                UNIQUE(kind, pattern)
            );
            CREATE TABLE IF NOT EXISTS groups (
                peer TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                members_json TEXT NOT NULL DEFAULT '[]',
                muted INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                is_demo INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;
        // 兼容旧版数据库的增量列迁移
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN extracted_code TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN suggested_reply TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN cc_addrs TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE groups ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0", []);
        Ok(Db(Mutex::new(conn)))
    }

    fn kv_get<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>> {
        let c = self.0.lock().unwrap();
        let v: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
            .optional()?;
        Ok(match v {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    fn kv_set<T: Serialize>(&self, key: &str, v: &T) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(v)?],
        )?;
        Ok(())
    }

    pub fn account(&self) -> Result<Option<Account>> {
        self.kv_get("account")
    }
    pub fn save_account(&self, a: &Account) -> Result<()> {
        self.kv_set("account", a)
    }
    pub fn clear_account(&self) -> Result<()> {
        self.0.lock().unwrap().execute("DELETE FROM kv WHERE key='account'", [])?;
        Ok(())
    }
    pub fn agent_config(&self) -> Result<AgentConfig> {
        Ok(self.kv_get("agent")?.unwrap_or_default())
    }
    pub fn save_agent_config(&self, a: &AgentConfig) -> Result<()> {
        self.kv_set("agent", a)
    }

    pub fn sync_state(&self, folder: &str) -> Result<(u32, u32)> {
        let c = self.0.lock().unwrap();
        Ok(c
            .query_row(
                "SELECT uidvalidity, last_uid FROM sync_state WHERE folder=?1",
                [folder],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0)))
    }

    pub fn save_sync_state(&self, folder: &str, validity: u32, last_uid: u32) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO sync_state(folder,uidvalidity,last_uid) VALUES(?1,?2,?3)
             ON CONFLICT(folder) DO UPDATE SET uidvalidity=excluded.uidvalidity, last_uid=excluded.last_uid",
            params![folder, validity, last_uid],
        )?;
        Ok(())
    }

    /// 根据 In-Reply-To / References 查找是否已经属于某个现有群聊线程
    pub fn find_group_by_refs(&self, ref_ids: &[String]) -> Result<Option<String>> {
        if ref_ids.is_empty() {
            return Ok(None);
        }
        let c = self.0.lock().unwrap();
        for mid in ref_ids.iter().rev() {
            let clean = mid.trim_matches(&['<', '>', ' '][..]);
            if clean.is_empty() {
                continue;
            }
            let found: Option<String> = c
                .query_row(
                    "SELECT peer FROM messages WHERE message_id=?1 AND peer LIKE 'group:%' LIMIT 1",
                    [clean],
                    |r| r.get(0),
                )
                .optional()?;
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }

    pub fn get_group(&self, peer: &str) -> Result<Option<GroupInfo>> {
        let c = self.0.lock().unwrap();
        let row: Option<(String, String, bool)> = c
            .query_row(
                "SELECT name, members_json, muted FROM groups WHERE peer=?1",
                [peer],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(match row {
            Some((name, json_str, muted)) => {
                let members: Vec<GroupMember> = serde_json::from_str(&json_str).unwrap_or_default();
                Some(GroupInfo {
                    peer: peer.to_string(),
                    name,
                    members,
                    muted,
                })
            }
            None => None,
        })
    }

    fn all_groups_map(&self) -> Result<HashMap<String, (GroupInfo, i64)>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare("SELECT peer, name, members_json, muted, created_at FROM groups")?;
        let rows = st.query_map([], |r| {
            let peer: String = r.get(0)?;
            let name: String = r.get(1)?;
            let json_str: String = r.get(2)?;
            let muted: bool = r.get(3)?;
            let created_at: i64 = r.get(4)?;
            let members: Vec<GroupMember> = serde_json::from_str(&json_str).unwrap_or_default();
            Ok((
                peer.clone(),
                (
                    GroupInfo {
                        peer,
                        name,
                        members,
                        muted,
                    },
                    created_at,
                ),
            ))
        })?;
        Ok(rows.collect::<std::result::Result<HashMap<_, _>, _>>()?)
    }

    /// 创建或合并更新群聊成员（保留用户已修改过的群名称和免打扰开关）
    pub fn upsert_group(
        &self,
        peer: &str,
        default_name: &str,
        discovered_members: &[GroupMember],
        exclude_me: &str,
        is_demo: bool,
    ) -> Result<GroupInfo> {
        if let Some(existing) = self.get_group(peer)? {
            let mut merged = existing.members;
            merged.extend_from_slice(discovered_members);
            let members = normalize_members(&merged, exclude_me);
            let c = self.0.lock().unwrap();
            c.execute(
                "UPDATE groups SET members_json=?2 WHERE peer=?1",
                params![peer, serde_json::to_string(&members)?],
            )?;
            Ok(GroupInfo {
                peer: peer.to_string(),
                name: existing.name,
                members,
                muted: existing.muted,
            })
        } else {
            let members = normalize_members(discovered_members, exclude_me);
            let name = if default_name.trim().is_empty() {
                default_group_title("", &members)
            } else {
                default_name.trim().to_string()
            };
            let now = chrono::Utc::now().timestamp();
            let c = self.0.lock().unwrap();
            c.execute(
                "INSERT INTO groups(peer, name, members_json, muted, created_at, is_demo) VALUES(?1, ?2, ?3, 0, ?4, ?5)",
                params![peer, name, serde_json::to_string(&members)?, now, is_demo as i32],
            )?;
            Ok(GroupInfo {
                peer: peer.to_string(),
                name,
                members,
                muted: false,
            })
        }
    }

    /// 用户手动发起群聊
    pub fn create_group(&self, name: &str, members: &[GroupMember], exclude_me: &str) -> Result<GroupInfo> {
        let normalized = normalize_members(members, exclude_me);
        if normalized.is_empty() {
            anyhow::bail!("请至少添加 1 位有效的群成员邮箱");
        }
        let peer = format!("group:grp-{}", uuid::Uuid::new_v4());
        let final_name = if name.trim().is_empty() {
            default_group_title("", &normalized)
        } else {
            name.trim().to_string()
        };
        let now = chrono::Utc::now().timestamp();
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO groups(peer, name, members_json, muted, created_at, is_demo) VALUES(?1, ?2, ?3, 0, ?4, 0)",
            params![peer, final_name, serde_json::to_string(&normalized)?, now],
        )?;
        Ok(GroupInfo {
            peer,
            name: final_name,
            members: normalized,
            muted: false,
        })
    }

    /// 修改群名称、群成员列表与免打扰设置
    pub fn update_group(
        &self,
        peer: &str,
        name: &str,
        members: &[GroupMember],
        muted: bool,
        exclude_me: &str,
    ) -> Result<GroupInfo> {
        let normalized = normalize_members(members, exclude_me);
        if normalized.is_empty() {
            anyhow::bail!("群成员不能为空");
        }
        let final_name = if name.trim().is_empty() {
            default_group_title("", &normalized)
        } else {
            name.trim().to_string()
        };
        let c = self.0.lock().unwrap();
        c.execute(
            "UPDATE groups SET name=?2, members_json=?3, muted=?4 WHERE peer=?1",
            params![peer, final_name, serde_json::to_string(&normalized)?, muted as i32],
        )?;
        Ok(GroupInfo {
            peer: peer.to_string(),
            name: final_name,
            members: normalized,
            muted,
        })
    }

    /// 提取历史往来联系人，方便创建群聊时一键勾选
    pub fn known_contacts(&self, exclude_me: &str) -> Result<Vec<GroupMember>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT from_addr, MAX(from_name) FROM messages
             WHERE outgoing=0 AND from_addr<>'' GROUP BY from_addr
             UNION
             SELECT peer, '' FROM messages WHERE peer NOT LIKE 'group:%' GROUP BY peer",
        )?;
        let rows = st.query_map([], |r| {
            Ok(GroupMember {
                email: r.get(0)?,
                name: r.get(1)?,
            })
        })?;
        let raw: Vec<GroupMember> = rows.collect::<std::result::Result<_, _>>()?;
        Ok(normalize_members(&raw, exclude_me))
    }

    /// 插入邮件；已存在（同 Message-ID）则忽略。返回新行 id。
    pub fn insert_message(&self, m: &NewMessage) -> Result<Option<i64>> {
        let c = self.0.lock().unwrap();
        let n = c.execute(
            "INSERT OR IGNORE INTO messages(folder,uid,message_id,in_reply_to,references_hdr,from_addr,from_name,
                to_addrs,cc_addrs,subject,body,body_full,date,outgoing,peer,status,category,summary,reason,
                extracted_code,suggested_reply,read,agent_done)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
            params![
                m.folder, m.uid, m.message_id, m.in_reply_to, m.references, m.from_addr, m.from_name,
                m.to_addrs, m.cc_addrs, m.subject, m.body, m.body_full, m.date, m.outgoing, m.peer, m.status,
                m.category, m.summary, m.reason, m.extracted_code, m.suggested_reply, m.read, m.agent_done
            ],
        )?;
        Ok(if n > 0 { Some(c.last_insert_rowid()) } else { None })
    }

    pub fn rules(&self) -> Result<Vec<Rule>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare("SELECT id, kind, pattern FROM rules ORDER BY id DESC")?;
        let rows = st.query_map([], |r| {
            Ok(Rule { id: r.get(0)?, kind: r.get(1)?, pattern: r.get(2)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn add_rule(&self, kind: &str, pattern: &str) -> Result<()> {
        let c = self.0.lock().unwrap();
        let normalized = pattern.trim().to_lowercase();
        if kind == "allow_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('block_sender','archive_sender') AND pattern=?1", [&normalized])?;
        } else if kind == "block_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('allow_sender','archive_sender') AND pattern=?1", [&normalized])?;
        } else if kind == "archive_sender" {
            c.execute("DELETE FROM rules WHERE kind IN ('allow_sender','block_sender') AND pattern=?1", [&normalized])?;
        }
        c.execute(
            "INSERT OR IGNORE INTO rules(kind, pattern) VALUES(?1, ?2)",
            params![kind, normalized],
        )?;
        Ok(())
    }

    pub fn list_groups(&self) -> Result<Vec<GroupInfo>> {
        let mut items: Vec<(GroupInfo, i64)> = self.all_groups_map()?.into_values().collect();
        items.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(items.into_iter().map(|(g, _)| g).collect())
    }

    pub fn delete_rule(&self, id: i64) -> Result<()> {
        self.0.lock().unwrap().execute("DELETE FROM rules WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn replace_rules(&self, items: &[(String, String)]) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute("DELETE FROM rules", [])?;
        for (kind, pattern) in items {
            let normalized = pattern.trim().to_lowercase();
            if !normalized.is_empty() {
                c.execute(
                    "INSERT OR IGNORE INTO rules(kind, pattern) VALUES(?1, ?2)",
                    params![kind, normalized],
                )?;
            }
        }
        Ok(())
    }

    pub fn stats(&self) -> Result<MailboxStats> {
        let c = self.0.lock().unwrap();
        let inbox_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE status='inbox' AND read=0 AND outgoing=0",
            [],
            |r| r.get(0),
        )?;
        let archived_unread: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE status='archived' AND read=0 AND outgoing=0",
            [],
            |r| r.get(0),
        )?;
        let blocked_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE status='blocked'",
            [],
            |r| r.get(0),
        )?;
        let pending_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE agent_done=0 AND outgoing=0",
            [],
            |r| r.get(0),
        )?;
        let demo_count: i64 = c.query_row(
            "SELECT COUNT(*) FROM messages WHERE folder='demo'",
            [],
            |r| r.get(0),
        )?;
        Ok(MailboxStats {
            inbox_unread,
            archived_unread,
            blocked_count,
            pending_count,
            has_demo: demo_count > 0,
        })
    }

    pub fn conversations(&self, status: &str) -> Result<Vec<Conversation>> {
        let groups_map = self.all_groups_map()?;
        let mut list: Vec<Conversation> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare(
                r#"SELECT m.peer,
                     COALESCE((SELECT from_name FROM messages WHERE peer=m.peer AND outgoing=0 AND from_name<>''
                               ORDER BY date DESC LIMIT 1), ''),
                     COALESCE((SELECT
                         CASE
                           WHEN peer LIKE 'group:%' AND outgoing=0 THEN
                             (CASE WHEN from_name<>'' THEN from_name ELSE from_addr END) || ': ' ||
                             (CASE WHEN summary<>'' THEN summary WHEN body<>'' THEN body ELSE subject END)
                           WHEN extracted_code<>'' THEN '🔑 验证码 ' || extracted_code || ' · ' || CASE WHEN summary<>'' THEN summary ELSE subject END
                           WHEN summary<>'' THEN summary
                           WHEN body<>'' THEN body
                           ELSE subject
                         END
                       FROM messages
                       WHERE peer=m.peer AND status=?1 ORDER BY date DESC LIMIT 1), ''),
                     MAX(m.date),
                     SUM(CASE WHEN m.read=0 AND m.outgoing=0 THEN 1 ELSE 0 END),
                     COUNT(*),
                     COALESCE((SELECT category FROM messages WHERE peer=m.peer AND status=?1 AND category<>''
                               ORDER BY date DESC LIMIT 1), '')
                   FROM messages m WHERE m.status=?1
                   GROUP BY m.peer ORDER BY MAX(m.date) DESC"#,
            )?;
            let rows = st.query_map([status], |r| {
                let peer: String = r.get(0)?;
                let sender_name: String = r.get(1)?;
                let preview: String = r.get(2)?;
                let is_group = peer.starts_with("group:");
                let (name, members, muted) = if let Some((g, _)) = groups_map.get(&peer) {
                    (g.name.clone(), g.members.clone(), g.muted)
                } else {
                    (
                        if sender_name.is_empty() { peer.clone() } else { sender_name },
                        Vec::new(),
                        false,
                    )
                };
                Ok(Conversation {
                    peer,
                    name,
                    preview: preview.chars().take(80).collect::<String>().replace('\n', " "),
                    last_date: r.get(3)?,
                    unread: r.get(4)?,
                    count: r.get(5)?,
                    category: r.get(6)?,
                    is_group,
                    members,
                    muted,
                })
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };

        // 把新建但尚未发第一条消息的空群展示在聊天（或免打扰时展示在通知）列表中
        let c = self.0.lock().unwrap();
        for (peer, (g, created_at)) in groups_map {
            let target_view = if g.muted { "archived" } else { "inbox" };
            if status != target_view {
                continue;
            }
            let total_msgs: i64 = c.query_row(
                "SELECT COUNT(*) FROM messages WHERE peer=?1",
                [&peer],
                |r| r.get(0),
            )?;
            if total_msgs == 0 {
                list.push(Conversation {
                    peer,
                    name: g.name,
                    preview: format!("👥 {} 位成员，发条消息开始群聊吧", g.members.len() + 1),
                    last_date: created_at,
                    unread: 0,
                    count: 0,
                    category: "群聊".into(),
                    is_group: true,
                    members: g.members,
                    muted: g.muted,
                });
            }
        }
        list.sort_by(|a, b| b.last_date.cmp(&a.last_date));
        Ok(list)
    }

    pub fn messages(&self, peer: &str, status: &str) -> Result<Vec<MessageDto>> {
        let c = self.0.lock().unwrap();
        if peer.starts_with("group:") && status != "blocked" {
            c.execute(
                "UPDATE messages SET read=1 WHERE peer=?1 AND status<>'blocked' AND read=0",
                params![peer],
            )?;
            let mut st = c.prepare(
                "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                        category,summary,reason,extracted_code,suggested_reply
                 FROM messages WHERE peer=?1 AND status<>'blocked' ORDER BY date ASC",
            )?;
            let rows = st.query_map(params![peer], row_to_dto)?;
            return Ok(rows.collect::<std::result::Result<_, _>>()?);
        }
        c.execute(
            "UPDATE messages SET read=1 WHERE peer=?1 AND status=?2 AND read=0",
            params![peer, status],
        )?;
        let mut st = c.prepare(
            "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                    category,summary,reason,extracted_code,suggested_reply
             FROM messages WHERE peer=?1 AND status=?2 ORDER BY date ASC",
        )?;
        let rows = st.query_map(params![peer, status], row_to_dto)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn message(&self, id: i64) -> Result<MessageDto> {
        let c = self.0.lock().unwrap();
        Ok(c.query_row(
            "SELECT id,peer,from_addr,from_name,subject,body,body_full,date,outgoing,status,
                    category,summary,reason,extracted_code,suggested_reply
             FROM messages WHERE id=?1",
            [id],
            row_to_dto,
        )?)
    }

    /// 回复时用的上下文：该会话最新一封邮件的主题和 Message-ID（群聊按时间取最新一封以串起完整线程）
    pub fn reply_context(&self, peer: &str) -> Result<Option<ReplyContext>> {
        let c = self.0.lock().unwrap();
        let sql = if peer.starts_with("group:") {
            "SELECT subject, message_id, references_hdr FROM messages WHERE peer=?1 ORDER BY date DESC LIMIT 1"
        } else {
            "SELECT subject, message_id, references_hdr FROM messages WHERE peer=?1 ORDER BY outgoing ASC, date DESC LIMIT 1"
        };
        Ok(c.query_row(sql, [peer], |r| {
            Ok(ReplyContext {
                subject: r.get(0)?,
                message_id: r.get(1)?,
                references: r.get(2)?,
            })
        })
        .optional()?)
    }

    pub fn set_message_status(&self, id: i64, status: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE messages SET status=?2 WHERE id=?1",
            params![id, status],
        )?;
        Ok(())
    }

    pub fn move_peer(&self, peer: &str, to_status: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE messages SET status=?2 WHERE peer=?1",
            params![peer, to_status],
        )?;
        Ok(())
    }

    /// 等待 Agent 处理的邮件
    pub fn pending(&self) -> Result<Vec<PendingItem>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT id, from_addr, from_name, subject, body_full, extracted_code FROM messages
             WHERE agent_done=0 AND outgoing=0 ORDER BY date DESC LIMIT 40",
        )?;
        let rows = st.query_map([], |r| {
            Ok(PendingItem {
                id: r.get(0)?,
                from_addr: r.get(1)?,
                from_name: r.get(2)?,
                subject: r.get(3)?,
                body_full: r.get(4)?,
                existing_code: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// 将现有来信重新标记为待 Agent 分拣
    pub fn mark_for_reclassify(&self, all_incoming: bool) -> Result<usize> {
        let c = self.0.lock().unwrap();
        let n = if all_incoming {
            c.execute("UPDATE messages SET agent_done=0 WHERE outgoing=0", [])?
        } else {
            c.execute(
                "UPDATE messages SET agent_done=0 WHERE outgoing=0 AND summary='' AND status='inbox'",
                [],
            )?
        };
        Ok(n)
    }

    /// 用当前确定性规则扫描已存在的来信，返回命中条数
    pub fn scan_existing_with_rules<F>(&self, mut matcher: F) -> Result<usize>
    where
        F: FnMut(&str, &str, &str) -> Option<(&'static str, String)>,
    {
        let items: Vec<(i64, String, String, String)> = {
            let c = self.0.lock().unwrap();
            let mut st = c.prepare("SELECT id, from_addr, subject, body_full FROM messages WHERE outgoing=0")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut changed = 0;
        let c = self.0.lock().unwrap();
        for (id, from, subject, body) in items {
            if let Some((status, reason)) = matcher(&from, &subject, &body) {
                changed += c.execute(
                    "UPDATE messages SET status=?2, reason=?3, agent_done=1 WHERE id=?1",
                    params![id, status, reason],
                )?;
            }
        }
        Ok(changed)
    }

    pub fn apply_verdict(
        &self,
        id: i64,
        status: &str,
        category: &str,
        summary: &str,
        reason: &str,
        extracted_code: &str,
        suggested_reply: &str,
    ) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "UPDATE messages
             SET status=?2,
                 category=?3,
                 summary=?4,
                 reason=?5,
                 extracted_code=CASE WHEN ?6<>'' THEN ?6 ELSE extracted_code END,
                 suggested_reply=?7,
                 agent_done=1
             WHERE id=?1",
            params![id, status, category, summary, reason, extracted_code, suggested_reply],
        )?;
        Ok(())
    }

    /// 对话最近若干条（含每位发言人身份），用于单聊/群聊 AI 起草回复或 AI 群聊总结
    pub fn recent_history(&self, peer: &str, n: i64) -> Result<Vec<HistoryItem>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT outgoing, from_name, from_addr, subject, body FROM messages WHERE peer=?1 ORDER BY date DESC LIMIT ?2",
        )?;
        let mut rows: Vec<HistoryItem> = st
            .query_map(params![peer, n], |r| {
                Ok(HistoryItem {
                    outgoing: r.get(0)?,
                    from_name: r.get(1)?,
                    from_addr: r.get(2)?,
                    subject: r.get(3)?,
                    body: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// 注入一套开箱即用的演示会话（含 4 人项目研发群聊、单聊、验证码/账单通知、被屏蔽广告/钓鱼邮件）
    pub fn seed_demo_data(&self, my_email: &str) -> Result<usize> {
        let me = if my_email.trim().is_empty() {
            "me@mailchat.local".to_string()
        } else {
            my_email.trim().to_lowercase()
        };
        let now = chrono::Utc::now().timestamp();

        // 预建一个 4 人产品研发群聊（我 + 林晓薇 + Alex + 王工）
        let grp_peer = "group:demo-product-team";
        let _ = self.upsert_group(
            grp_peer,
            "🚀 MailChat 产品研发群",
            &[
                GroupMember { email: "linxiaowei@team-work.cn".into(), name: "林晓薇 (产品)".into() },
                GroupMember { email: "alex.chen@opensource.dev".into(), name: "Alex Chen".into() },
                GroupMember { email: "wang.qa@team-work.cn".into(), name: "王工 (测试)".into() },
            ],
            &me,
            true,
        )?;

        let samples = vec![
            // 0. 4人研发群聊演示（多成员 Reply-All 邮件线程）
            NewMessage {
                folder: "demo".into(),
                uid: 201,
                message_id: "demo-grp-201@team-work.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: format!("{me},alex.chen@opensource.dev,wang.qa@team-work.cn"),
                cc_addrs: String::new(),
                subject: "MailChat v0.2 群聊方案对齐".into(),
                body: "大家下午好！我们准备在 MailChat 里支持邮件群聊，底层走标准多收件人 To/Cc + Reply-All 邮件线程，这样对方用普通网页邮箱也能直接参会讨论。".into(),
                body_full: "大家下午好！我们准备在 MailChat 里支持邮件群聊，底层走标准多收件人 To/Cc + Reply-All 邮件线程，这样对方用普通网页邮箱也能直接参会讨论。".into(),
                date: now - 3200,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "同步 MailChat v0.2 基于多收件人协议实现群聊".into(),
                reason: "项目组多人协作讨论".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 202,
                message_id: "demo-grp-202@opensource.dev".into(),
                in_reply_to: "demo-grp-201@team-work.cn".into(),
                references: "<demo-grp-201@team-work.cn>".into(),
                from_addr: "alex.chen@opensource.dev".into(),
                from_name: "Alex Chen".into(),
                to_addrs: format!("{me},linxiaowei@team-work.cn,wang.qa@team-work.cn"),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "赞成！可以同时带上 Chat-Group-ID 扩展头并结合 In-Reply-To 线程追踪，这样哪怕外部邮箱用户中途增减抄送人，也不会裂变成两个群。".into(),
                body_full: "赞成！可以同时带上 Chat-Group-ID 扩展头并结合 In-Reply-To 线程追踪，这样哪怕外部邮箱用户中途增减抄送人，也不会裂变成两个群。".into(),
                date: now - 2600,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "建议用 Chat-Group-ID 与线程头保证群会话唯一性".into(),
                reason: "技术架构补充意见".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 203,
                message_id: "demo-grp-203@mailchat.local".into(),
                in_reply_to: "demo-grp-202@opensource.dev".into(),
                references: "<demo-grp-201@team-work.cn> <demo-grp-202@opensource.dev>".into(),
                from_addr: me.clone(),
                from_name: "我".into(),
                to_addrs: "linxiaowei@team-work.cn,alex.chen@opensource.dev,wang.qa@team-work.cn".into(),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "@Alex Chen 这个方案很稳，我顺便把群免打扰（被 @ 时仍提醒）和 AI 一键总结群聊记录也加上了。".into(),
                body_full: "@Alex Chen 这个方案很稳，我顺便把群免打扰（被 @ 时仍提醒）和 AI 一键总结群聊记录也加上了。".into(),
                date: now - 1900,
                outgoing: true,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: String::new(),
                summary: String::new(),
                reason: String::new(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 204,
                message_id: "demo-grp-204@team-work.cn".into(),
                in_reply_to: "demo-grp-203@mailchat.local".into(),
                references: "<demo-grp-201@team-work.cn> <demo-grp-202@opensource.dev> <demo-grp-203@mailchat.local>".into(),
                from_addr: "wang.qa@team-work.cn".into(),
                from_name: "王工 (测试)".into(),
                to_addrs: format!("{me},linxiaowei@team-work.cn,alex.chen@opensource.dev"),
                cc_addrs: String::new(),
                subject: "Re: MailChat v0.2 群聊方案对齐".into(),
                body: "收到！今晚构建包出来后告诉我一声，我重点测一下跨 Gmail / QQ 邮箱的全员回复互通性。".into(),
                body_full: "收到！今晚构建包出来后告诉我一声，我重点测一下跨 Gmail / QQ 邮箱的全员回复互通性。".into(),
                date: now - 300,
                outgoing: false,
                peer: grp_peer.into(),
                status: "inbox".into(),
                category: "群聊".into(),
                summary: "王工准备今晚联调跨邮箱群聊互通测试".into(),
                reason: "测试排期确认".into(),
                extracted_code: String::new(),
                suggested_reply: "好的 @王工 (测试) ，桌面端刚编好，随时可以开测！".into(),
                read: false,
                agent_done: true,
            },
            // 1. 产品经理林晓薇单聊
            NewMessage {
                folder: "demo".into(),
                uid: 101,
                message_id: "demo-101@team-work.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "MailChat 桌面端交互走查".into(),
                body: "嗨！我刚看了一下把邮件做成微信/Telegram 气泡的设计稿，左边按联系人聚合真的清爽太多了。你这边 Tauri 原型进展怎么样啦？".into(),
                body_full: "嗨！我刚看了一下把邮件做成微信/Telegram 气泡的设计稿，左边按联系人聚合真的清爽太多了。你这边 Tauri 原型进展怎么样啦？\n\n-- \n林晓薇 | 高级产品经理\nTeamWork Studio · 北京市海淀区".into(),
                date: now - 7200,
                outgoing: false,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: "工作".into(),
                summary: "询问 MailChat Tauri 原型开发进展".into(),
                reason: "同事项目沟通，需要关注与回复".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 102,
                message_id: "demo-102@mailchat.local".into(),
                in_reply_to: "demo-101@team-work.cn".into(),
                references: "<demo-101@team-work.cn>".into(),
                from_addr: me.clone(),
                from_name: "我".into(),
                to_addrs: "linxiaowei@team-work.cn".into(),
                cc_addrs: String::new(),
                subject: "Re: MailChat 桌面端交互走查".into(),
                body: "IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！".into(),
                body_full: "IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！".into(),
                date: now - 5400,
                outgoing: true,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: String::new(),
                summary: String::new(),
                reason: String::new(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            NewMessage {
                folder: "demo".into(),
                uid: 103,
                message_id: "demo-103@team-work.cn".into(),
                in_reply_to: "demo-102@mailchat.local".into(),
                references: "<demo-101@team-work.cn> <demo-102@mailchat.local>".into(),
                from_addr: "linxiaowei@team-work.cn".into(),
                from_name: "林晓薇 (产品)".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "Re: MailChat 桌面端交互走查".into(),
                body: "太棒了！那我们周四下午 3:00 约个 20 分钟小会，一起过一下可运行原型可以吗？".into(),
                body_full: "太棒了！那我们周四下午 3:00 约个 20 分钟小会，一起过一下可运行原型可以吗？\n\n在 2026-11-12 21:15，我 写道：\n> IMAP/SMTP 收发和引用剥离已经跑通了，正在把多模型 Agent 自动分拣加上去！\n\n-- \n林晓薇 | 高级产品经理\nTeamWork Studio".into(),
                date: now - 900,
                outgoing: false,
                peer: "linxiaowei@team-work.cn".into(),
                status: "inbox".into(),
                category: "工作".into(),
                summary: "邀约周四下午 3:00 评审可运行原型".into(),
                reason: "真人同事来信并包含明确时间邀约".into(),
                extracted_code: String::new(),
                suggested_reply: "没问题，周四下午 3 点见，我先把演示环境准备好！".into(),
                read: false,
                agent_done: true,
            },
            // 2. 开源协作者 Alex Chen 单聊
            NewMessage {
                folder: "demo".into(),
                uid: 104,
                message_id: "demo-104@opensource.dev".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "alex.chen@opensource.dev".into(),
                from_name: "Alex Chen".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "关于邮件线程 In-Reply-To 兼容性的小建议".into(),
                body: "Hey! 测试了一下你发的回复邮件，在 Gmail 和 Apple Mail 里都能完美归进同一个会话线程。建议对只有 HTML 正文的通知邮件也加个纯文本提取兜底，体验会更稳。".into(),
                body_full: "Hey! 测试了一下你发的回复邮件，在 Gmail 和 Apple Mail 里都能完美归进同一个会话线程。建议对只有 HTML 正文的通知邮件也加个纯文本提取兜底，体验会更稳。\n\nBest,\nAlex".into(),
                date: now - 2400,
                outgoing: false,
                peer: "alex.chen@opensource.dev".into(),
                status: "inbox".into(),
                category: "个人".into(),
                summary: "反馈邮件线程兼容正常，建议补充 HTML 正文提取".into(),
                reason: "开发者技术交流来信".into(),
                extracted_code: String::new(),
                suggested_reply: "好建议，HTML 自动转纯文本兜底已经加上了，感谢测试！".into(),
                read: false,
                agent_done: true,
            },
            // 3. 通知栏：GitHub 验证码
            NewMessage {
                folder: "demo".into(),
                uid: 105,
                message_id: "demo-105@github.com".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "noreply@github.com".into(),
                from_name: "GitHub".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "[GitHub] Please verify your device".into(),
                body: "检测到新设备登录验证请求。\n您的登录验证码为：849201（10 分钟内有效）。如非本人操作请忽略本邮件。".into(),
                body_full: "检测到新设备登录验证请求。\n您的登录验证码为：849201（10 分钟内有效）。如非本人操作请忽略本邮件。".into(),
                date: now - 600,
                outgoing: false,
                peer: "noreply@github.com".into(),
                status: "archived".into(),
                category: "验证码".into(),
                summary: "GitHub 新设备登录验证码 849201".into(),
                reason: "Agent 自动折叠：系统安全验证码通知，已提取验证码方便复制".into(),
                extracted_code: "849201".into(),
                suggested_reply: String::new(),
                read: false,
                agent_done: true,
            },
            // 4. 通知栏：银行电子账单
            NewMessage {
                folder: "demo".into(),
                uid: 106,
                message_id: "demo-106@cmbchina.com".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "ccsvc@cmbchina.com".into(),
                from_name: "招商银行信用卡".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "招商银行信用卡 11 月电子账单通知".into(),
                body: "尊敬的持卡人，您本期人民币账单应还金额 ¥3,286.50，最后还款日为 11 月 25 日。已开通自动还款服务，请确保关联储蓄卡余额充足。".into(),
                body_full: "尊敬的持卡人，您本期人民币账单应还金额 ¥3,286.50，最后还款日为 11 月 25 日。已开通自动还款服务，请确保关联储蓄卡余额充足。".into(),
                date: now - 14400,
                outgoing: false,
                peer: "ccsvc@cmbchina.com".into(),
                status: "archived".into(),
                category: "账单".into(),
                summary: "11 月信用卡账单 ¥3,286.50，11/25 到期自动还款".into(),
                reason: "Agent 自动折叠：账单通知无需即时聊天打扰，归档备查".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: false,
                agent_done: true,
            },
            // 5. 已屏蔽：电商促销垃圾邮件
            NewMessage {
                folder: "demo".into(),
                uid: 107,
                message_id: "demo-107@flash-sale88.cn".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "promo@edm.flash-sale88.cn".into(),
                from_name: "云端优选商城".into(),
                to_addrs: me.clone(),
                cc_addrs: String::new(),
                subject: "【最后24小时】超级会员返场狂欢，全场数码低至 5 折！".into(),
                body: "尊贵的 VIP 用户，您的 ¥500 专属津贴即将失效！立即戳链接抢购爆款好物，买贵双倍赔！拒收请回复 TD 退订。".into(),
                body_full: "尊贵的 VIP 用户，您的 ¥500 专属津贴即将失效！立即戳链接抢购爆款好物，买贵双倍赔！拒收请回复 TD 退订。".into(),
                date: now - 3600,
                outgoing: false,
                peer: "promo@edm.flash-sale88.cn".into(),
                status: "blocked".into(),
                category: "营销".into(),
                summary: "电商促销群发广告（含退订话术）".into(),
                reason: "Agent 自动屏蔽：典型 EDM 商业促销群发邮件".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
            // 6. 已屏蔽：钓鱼诈骗邮件
            NewMessage {
                folder: "demo".into(),
                uid: 108,
                message_id: "demo-108@account-alert-login.xyz".into(),
                in_reply_to: String::new(),
                references: String::new(),
                from_addr: "security@account-alert-login.xyz".into(),
                from_name: "邮箱系统管理员".into(),
                to_addrs: me,
                cc_addrs: String::new(),
                subject: "紧急：您的企业邮箱存储已满 99.8%，即将暂停收发！".into(),
                body: "系统检测到您的账号存在异常挂起邮件，请在 2 小时内访问 http://verify-mail-quota.xyz 重新输入邮箱密码完成扩容验证，否则账号将被永久冻结。".into(),
                body_full: "系统检测到您的账号存在异常挂起邮件，请在 2 小时内访问 http://verify-mail-quota.xyz 重新输入邮箱密码完成扩容验证，否则账号将被永久冻结。".into(),
                date: now - 1800,
                outgoing: false,
                peer: "security@account-alert-login.xyz".into(),
                status: "blocked".into(),
                category: "诈骗".into(),
                summary: "伪造邮箱容量告警诱导输入密码的可疑钓鱼邮件".into(),
                reason: "Agent 自动屏蔽：陌生可疑域名 + 诱导输入凭据，高危钓鱼特征".into(),
                extracted_code: String::new(),
                suggested_reply: String::new(),
                read: true,
                agent_done: true,
            },
        ];

        let mut inserted = 0;
        for s in &samples {
            if self.insert_message(s)?.is_some() {
                inserted += 1;
            }
        }
        Ok(inserted)
    }

    pub fn clear_demo_data(&self) -> Result<usize> {
        let c = self.0.lock().unwrap();
        let _ = c.execute("DELETE FROM groups WHERE is_demo=1", []);
        Ok(c.execute("DELETE FROM messages WHERE folder='demo'", [])?)
    }
}

fn row_to_dto(r: &rusqlite::Row) -> rusqlite::Result<MessageDto> {
    Ok(MessageDto {
        id: r.get(0)?,
        peer: r.get(1)?,
        from_addr: r.get(2)?,
        from_name: r.get(3)?,
        subject: r.get(4)?,
        body: r.get(5)?,
        body_full: r.get(6)?,
        date: r.get(7)?,
        outgoing: r.get(8)?,
        status: r.get(9)?,
        category: r.get(10)?,
        summary: r.get(11)?,
        reason: r.get(12)?,
        extracted_code: r.get(13)?,
        suggested_reply: r.get(14)?,
    })
}
