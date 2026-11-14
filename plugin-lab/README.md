# MailChat Plugin Lab（独立插件系统沙盒演练台）

> **状态**：独立原型与完整协议规范（**零改动**客户端现有 `src/` 与 `src-tauri/` 代码）。  
> **设计目标**：同一套免编译插件协议（`plugin.toml` + `index.mjs`），既支持直接拷入目录热加载**现成插件**，也支持客户端内置 **AI 助手**按用户一句话需求自动编写、过五道门禁自检、申请 DPAPI 加密凭据并即时热加载。

## 目录结构

- `ARCHITECTURE.md` — 完整插件架构规范与未来接入 `src-tauri` 的逐文件改造蓝图
- `config.preview.toml` — 预览引入 `[[plugins]]` 后的声明式 `config.toml` 形态
- `sdk/`
  - `plugin-types.d.ts` — 插件四级钩子与受控 `ctx` 宿主能力的完整 TypeScript 类型契约
  - `agent-system-prompt.md` — 供内置助手（默认 `deepseek-v4.1-flash`）生成插件的 System Prompt 规范
- `host/`
  - `toml-lite.mjs` — 零依赖声明式 TOML 解析器
  - `validator.mjs` — 五道安全与契约校验门禁（Manifest / 静态安全扫描 / 权限一致性 / 沙盒编译 / 冒烟干跑）
  - `sandbox.mjs` — 零信任隔离沙盒（禁用 `eval`/`Function`、域名白名单、反 SSRF、`{{secret:<slot>}}` 盲注入、KV 配额、硬超时）
  - `host-engine.mjs` — 插件热加载注册表与四级邮件流水线编排器
  - `agent-author.mjs` — 内置助手插件自编写与多轮报错自愈引擎（含 Webhook URL 本地隐私前置拦截）
- `plugins/` — 4 个开箱即用的现成插件包
  - `otp-fast-lane/` — 验证码极速提取通道（`onBeforeTriage` 短路省 Token）
  - `invoice-ledger-feishu/` — 电子发票结构化记账 + 飞书盲注入推送 + 每日汇总（`onAfterTriage` + `onSchedule`）
  - `outbound-dlp-guard/` — 发信密钥防泄漏守卫与轻量签名（`onBeforeSend`）
  - `vip-sla-patrol/` — 重点客户保送主列表与超时未回巡检（`onBeforeTriage` + `onSchedule`）
- `tests/plugin-system.test.mjs` — 完整自动化验收测试套件

## 快速运行（零安装依赖，直接使用本机 Node 运行）

```powershell
# 1. 运行自动化测试套件（验证热加载、流水线钩子、安全拦截与 Agent 多轮自愈）
node --test plugin-lab/tests/plugin-system.test.mjs

# 2. 查看当前已安装的现成插件与权限声明
node plugin-lab/cli.mjs list

# 3. 对所有插件执行五道门禁与隔离冒烟测试
node plugin-lab/cli.mjs verify

# 4. 运行端到端邮件流水线仿真（验证码短路 + 发票飞书盲注入 + 发信防泄漏 + 定时巡检）
node plugin-lab/cli.mjs simulate

# 5. 演练「内置 AI 助手按需自动写插件 + 前置拦截密钥入 Vault + 自检热加载」
node plugin-lab/cli.mjs agent-author "收到包含「告警」或「故障」的运维邮件推送到飞书 https://open.feishu.cn/open-apis/bot/v2/hook/9f8a7b6c-demo-token-2026 并每天定时汇总"

# （可选）配置真实大模型密钥让真模型实时编写插件：
$env:DEEPSEEK_API_KEY="sk-..."
node plugin-lab/cli.mjs agent-author "收到顺丰或菜鸟快递邮件时自动提取取件码归入通知"
```
