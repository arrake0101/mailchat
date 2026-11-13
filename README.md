# MailChat

把标准邮箱做成现代即时通讯桌面客户端：底层 100% 兼容标准 **IMAP / SMTP** 单聊与多人全员群聊，核心配置采用 **Agent 对话驱动 + 声明式 `config.toml` + 系统级 DPAPI 隐私凭据隔离**。

## 核心架构与特性

- **Agent 优先的声明式配置 (`config.toml`)**：
  - 点击左侧导航 **「助手」**，用自然语言即可完成账号绑定、模型切换、过滤与归档规则编排、群聊创建与免打扰设置
  - 所有非隐私业务配置实时生成人类可读的 `config.toml`，右侧分栏实时预览，亦支持手动编辑校验；同时保留辅助可视化配置页
  - 未配置大模型 Key 时自动启用**本地确定性解析引擎**，零依赖即可对话式管理配置
- **隐私凭据独立加密隔离 (`Vault`)**：
  - 邮箱 IMAP/SMTP 授权码与各家模型 API Key **绝不写入 `config.toml`**（仅保留 `secret:mail_password` / `secret:llm_*` 引用），也**绝不进入大模型提示词上下文**
  - 在 Windows 下通过系统级 **DPAPI (`CryptProtectData`)** 绑定当前登录账户独立加密存储于 `secrets.vault.json`
  - 若用户在助手输入框误粘贴原始 API Key，客户端会在本地前置拦截并加密入库，不会发送给任何外部服务器
- **标准邮件协议单聊与多人全员群聊**：
  - 全员发信走标准多收件人 SMTP + `In-Reply-To` / `References` 线程头 + `Chat-Group-ID` / `Chat-Group-Name`（RFC2047 编码），外部 Gmail / QQ / 163 / Outlook 用户点「全部回复」即可直接参会
  - 收信按 `Chat-Group-ID` → 历史线程引用追踪 → 多收件人自动聚合三级路由，支持 `@提及`、群免打扰（`@我` 自动穿透提醒）与一键纪要总结
- **多模型与远端算力开箱即用**：
  - 默认内置 **OpenCode Go**（`https://opencode.ai/zen/go/v1`）、**Ollama 远程算力服务**（自动兼容局域网/云服务器 `:11434` 免密或网关鉴权）、**Ollama Cloud**（`https://ollama.com/v1`）、**Ollama 本地**，以及 DeepSeek、OpenAI、通义千问、Claude、Gemini、Kimi、硅基流动与任意兼容网关
  - 支持一键实时探测并拉取远端 `/v1/models` 或 Ollama `/api/tags` 可用模型列表
- **沉浸式无边框桌面视觉设计**：
  - 移除传统系统生硬标题横条，结合 Windows 11 DWM 原生圆角与阴影，将轻量窗口控制键与拖拽区自然融入卡片顶栏，统一细线条矢量图标与悬浮圆角分层画布

## 快速启动

方式一（推荐，零终端依赖直接打开独立桌面程序）：
- 直接双击项目根目录下的 **`启动MailChat.cmd`**（或运行 `src-tauri\target\release\mailchat.exe`）

方式二（开发热重载模式）：
```bash
npm start
# 或 npm run desktop
```

重新构建独立可执行文件：
```bash
npm run desktop:build
```
