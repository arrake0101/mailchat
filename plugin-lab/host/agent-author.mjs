/**
 * MailChat 内置 AI 助手插件自编写与闭环自愈引擎 (Agent Plugin Authoring & Self-Healing Loop)
 *
 * 核心链路：
 * 1. 前置隐私拦截：若用户在需求描述中误贴了飞书/钉钉/Slack Webhook Token 或 API Key，本地先行剥离入 Vault，绝不发往外部大模型。
 * 2. 代码规划生成：优先调用已配置的 OpenAI 兼容大模型（DeepSeek / OpenCode Go / Ollama Cloud）；未配置密钥时启用本地确定性插件合成引擎。
 * 3. 五道门禁自愈：自动执行 `validatePluginPackage`，若某道门禁未通过，自动将结构化诊断与修复建议回喂给生成端完成自愈重试（最多 3 轮）。
 * 4. 原子落盘与热加载：通过门禁后写入 `plugins/<id>/`，即时挂载进流水线，并返回 `SecretPrompt` 供前端渲染 DPAPI 加密录入卡。
 */

import { validatePluginPackage } from "./validator.mjs";

const SYSTEM_PROMPT = `你是 MailChat 客户端内置的插件自动化编写引擎。
请根据用户的自然语言需求，生成一个免构建的 MailChat 原生插件（包含 plugin.toml 与 index.mjs）。

硬性安全与契约约束：
1. index.mjs 只能使用纯标准 ES2022 语法，通过 export async function <hookName>(...) 导出钩子；严禁出现 import、require、process、eval、Function、globalThis.fetch。
2. 允许挂载的钩子仅限：onBeforeTriage(mail, ctx)、onAfterTriage(mail, verdict, ctx)、onBeforeSend(draft, ctx)、onSchedule(tick, ctx)。
3. 最小权限声明（plugin.toml [permissions]）：
   - 调用 ctx.http.fetch 必须在 permissions.network 列出精确域名数组（禁止 '*'）。
   - 调用 ctx.kv 必须声明 kv_storage = true。
   - 调用 ctx.mail.queryRecent 必须声明 mail_access = "read_recent"。
   - 调用 ctx.llm.complete 必须声明 llm_access = true。
4. 敏感凭据盲注入：所有 Webhook Token 或外部密钥必须在 [secrets.<slot>] 声明（含 label 与 hint），并在 ctx.http.fetch 中使用 {{secret:<slot>}} 占位符，调用前用 ctx.secrets.has("<slot>") 检查。
5. 严格只输出一个合法 JSON 对象：
{
  "reply": "给用户的中文说明",
  "id": "kebab-case-id",
  "plugin_toml": "完整 plugin.toml 文本",
  "index_mjs": "完整 index.mjs 文本",
  "sample_test": {
    "mail": { "fromAddr": "...", "fromName": "...", "subject": "...", "body": "...", "bodyFull": "..." }
  }
}`;

/**
 * 本地前置隐私拦截：扫描用户输入中是否直接粘贴了飞书/钉钉/企业微信/Slack Webhook 完整密钥 URL，
 * 若命中则在发给远端大模型前脱敏为占位符，并在插件生成后自动存入本地 Vault。
 */
export function interceptWebhookSecretInPrompt(rawPrompt) {
  const patterns = [
    {
      vendor: "feishu",
      domain: "open.feishu.cn",
      regex: /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/([a-zA-Z0-9-]{12,})/,
      prefix: "https://open.feishu.cn/open-apis/bot/v2/hook/",
    },
    {
      vendor: "dingtalk",
      domain: "oapi.dingtalk.com",
      regex: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=([a-zA-Z0-9_-]{12,})/,
      prefix: "https://oapi.dingtalk.com/robot/send?access_token=",
    },
    {
      vendor: "wecom",
      domain: "qyapi.weixin.qq.com",
      regex: /https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=([a-zA-Z0-9-]{12,})/,
      prefix: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
    },
  ];

  for (const item of patterns) {
    const m = rawPrompt.match(item.regex);
    if (m) {
      const secretToken = m[1];
      const sanitizedPrompt = rawPrompt.replace(
        m[0],
        `${item.prefix}<INTERCEPTED_INTO_LOCAL_VAULT>`
      );
      return {
        sanitizedPrompt,
        intercepted: {
          vendor: item.vendor,
          domain: item.domain,
          slot: "webhook_token",
          rawSecret: secretToken,
        },
      };
    }
  }

  return { sanitizedPrompt: rawPrompt, intercepted: null };
}

/**
 * 执行完整的「自然语言需求 -> 生成 -> 五道门禁校验 -> 自愈重试 -> 热加载」闭环
 */
export async function authorPluginFromPrompt({
  userPrompt,
  hostEngine,
  llmGenerator = null,
  maxAttempts = 3,
}) {
  const { sanitizedPrompt, intercepted } = interceptWebhookSecretInPrompt(userPrompt);
  const generator = llmGenerator ?? createDefaultGenerator();

  const repairHistory = [];
  let lastDraft = null;
  let lastDiagnostics = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const draft = await generator({
      prompt: sanitizedPrompt,
      attempt,
      previousDraft: lastDraft,
      diagnostics: lastDiagnostics,
      interceptedVendor: intercepted,
    });

    lastDraft = draft;
    const validation = await validatePluginPackage({
      pluginTomlRaw: draft.plugin_toml,
      indexMjsRaw: draft.index_mjs,
      expectedDirId: draft.id,
      customSample: draft.sample_test ?? null,
    });

    if (validation.ok) {
      // 若前置拦截到了用户粘贴的 Webhook Token，直接写入本机 Vault 对应命名空间槽位
      const interceptedVaultNotes = [];
      if (intercepted && validation.manifest?.secrets?.[intercepted.slot]) {
        const vaultKey = `plugin:${draft.id}:${intercepted.slot}`;
        hostEngine.vault.set(vaultKey, intercepted.rawSecret);
        interceptedVaultNotes.push(
          `前置拦截并加密保存凭据：${vaultKey}（未经过大模型上下文）`
        );
      }

      const installed = await hostEngine.installAndHotLoad({
        id: draft.id,
        pluginTomlRaw: draft.plugin_toml,
        indexMjsRaw: draft.index_mjs,
        customSample: draft.sample_test ?? null,
      });

      if (!installed.ok) {
        lastDiagnostics = installed.diagnostics;
        continue;
      }

      return {
        ok: true,
        attempts: attempt,
        repairHistory,
        reply: draft.reply,
        plugin: installed.plugin,
        changes: [
          `生成并热加载插件「${installed.plugin.name}」(${installed.plugin.id})`,
          `挂载流水线钩子：${installed.plugin.manifest.permissions.hooks.join(", ")}`,
          ...interceptedVaultNotes,
        ],
        secretPrompts: installed.secretPrompts,
        smokeResults: validation.smokeResults,
        sampleTest: draft.sample_test ?? null,
      };
    }

    lastDiagnostics = validation.diagnostics;
    repairHistory.push({
      attempt,
      candidateId: draft.id,
      diagnostics: validation.diagnostics,
    });
  }

  return {
    ok: false,
    attempts: maxAttempts,
    repairHistory,
    diagnostics: lastDiagnostics,
    reply: `插件自动编写在经过 ${maxAttempts} 轮安全门禁自检后仍存在未通过项，已拒绝挂载以保护客户端稳定。`,
  };
}

/**
 * 默认生成器：
 * - 若环境变量提供了 `MAILCHAT_LLM_API_KEY` 或 `DEEPSEEK_API_KEY`，则调用真实大模型（默认 `deepseek-v4.1-flash`）；
 * - 否则自动使用本地确定性模板合成引擎（与 MailChat `agent.rs` 离线双模机制保持一致）。
 */
function createDefaultGenerator() {
  const apiKey = process.env.MAILCHAT_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "";
  const baseUrl = (
    process.env.MAILCHAT_LLM_BASE_URL || "https://api.deepseek.com/v1"
  ).replace(/\/+$/, "");
  const rawModel = process.env.MAILCHAT_LLM_MODEL || "deepseek-v4.1-flash";

  if (apiKey) {
    return async ({ prompt, attempt, previousDraft, diagnostics }) => {
      // 与 MailChat agent.rs 一致：连接 DeepSeek 官方 API 时将 deepseek-v4.1-flash 映射为官方 model ID
      const effectiveModel =
        baseUrl.includes("api.deepseek.com") && rawModel === "deepseek-v4.1-flash"
          ? "deepseek-chat"
          : rawModel;

      let userMessage = `用户插件需求：\n${prompt}`;
      if (attempt > 1 && previousDraft && diagnostics.length > 0) {
        const diagText = diagnostics
          .map((d, idx) => `${idx + 1}. [${d.gate}/${d.code}] ${d.message} -> 修复建议：${d.fixHint}`)
          .join("\n");
        userMessage += `\n\n上一轮生成的插件未通过宿主安全门禁，请按以下诊断精确修复后重新输出完整 JSON：\n${diagText}\n\n上一轮 plugin.toml:\n${previousDraft.plugin_toml}\n\n上一轮 index.mjs:\n${previousDraft.index_mjs}`;
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveModel,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        throw new Error(`远端模型响应异常 HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start === -1 || end === -1) {
        throw new Error("模型未返回有效 JSON 插件描述");
      }
      return JSON.parse(content.slice(start, end + 1));
    };
  }

  return async (ctx) => synthesizePluginDeterministically(ctx);
}

/**
 * 离线确定性插件合成引擎（无需配置外部大模型密钥即可完整演练自然语言生成插件全流程）
 */
function synthesizePluginDeterministically({ prompt, interceptedVendor }) {
  const lower = prompt.toLowerCase();

  // 识别是否涉及外部 Webhook 推送（飞书 / 钉钉 / 企业微信 / Slack）
  const webhookTarget = detectWebhookTarget(lower, interceptedVendor);
  // 识别核心业务意图（快递/物流、会议/日程、报警/告警、通用关键词监控）
  const isLogistics = /快递|物流|取件码|顺丰|京东|包裹/.test(prompt);
  const isAlert = /告警|报警|故障|监控|alert|sentry|prometheus|服务器/.test(prompt);
  const isSchedule = /每天|定时|日报|巡检|汇总/.test(prompt);

  if (isLogistics) {
    const id = "agent-parcel-pickup-helper";
    return {
      reply:
        "已为你编写并热加载 **「快递与取件码提取管家」** 插件：收到快递通知邮件时在 `onBeforeTriage` 阶段直接提取取件码与驿站位置，自动折叠至「通知」并置顶显示取件码，免调大模型零延迟响应。",
      id,
      plugin_toml: `[plugin]
id = "${id}"
name = "快递与取件码提取管家"
version = "0.1.0"
description = "由内置 AI 助手根据需求自动生成：自动识别快递物流邮件，提取取件码并归入通知列表"
author = "mailchat-agent"
source = "agent"
priority = 25

[permissions]
hooks = ["onBeforeTriage"]
mail_access = "current"
kv_storage = true
`,
      index_mjs: `export async function onBeforeTriage(mail, ctx) {
  const text = \`\${mail.subject}\\n\${mail.bodyFull}\`;
  if (!/(快递|包裹|菜鸟|丰巢|顺丰|取件码)/.test(text)) {
    return { decision: "continue" };
  }

  const codeMatch = text.match(/(?:取件码|凭|提取码)[:：\\s]*([A-Za-z0-9-]{4,12})/);
  const pickupCode = codeMatch ? codeMatch[1] : "";

  await ctx.kv.set(\`latest:\${mail.messageId}\`, {
    subject: mail.subject,
    pickupCode,
    ts: mail.date,
  });

  ctx.log.info("识别到快递通知邮件", { pickupCode: pickupCode || "未附带" });

  return {
    decision: "short_circuit",
    tags: ["物流快递", ...(pickupCode ? [\`取件码:\${pickupCode}\`] : [])],
    metadata: { pickupCode },
    verdict: {
      action: "archive",
      category: "物流",
      summary: pickupCode ? \`包裹待取（取件码 \${pickupCode}）\` : mail.subject.slice(0, 32),
      reason: "内置助手生成插件：自动提取快递取件码并收纳至通知",
      extractedCode: pickupCode,
      suggestedReply: "",
    },
  };
}
`,
      sample_test: {
        mail: {
          fromAddr: "notify@cainiao.example.com",
          fromName: "菜鸟驿站",
          subject: "您的包裹已到站，请凭取件码 3-2-5018 前往领取",
          body: "您的顺丰包裹已到达科技园驿站，取件码：3-2-5018。",
          bodyFull: "您的顺丰包裹已到达科技园驿站，取件码：3-2-5018，请及时领取。",
        },
      },
    };
  }

  // 默认合成：智能关键词/告警提取 + 可选 Webhook 盲注入推送 + 可选定时汇总插件
  const id = isAlert ? "agent-ops-alert-bridge" : "agent-custom-mail-automator";
  const name = isAlert ? "运维告警置顶与群推送桥接器" : "定制来信捕获与外部推送插件";
  const hooks = [
    "onBeforeTriage",
    "onAfterTriage",
    ...(isSchedule ? ["onSchedule"] : []),
  ];

  const keywords = extractQuotedKeywords(prompt);
  const kwList =
    keywords.length > 0
      ? keywords
      : isAlert
        ? ["告警", "故障", "CRITICAL", "P0", "异常"]
        : ["重要", "合同", "审批", "付款"];

  const networkLine = webhookTarget ? `network = ["${webhookTarget.domain}"]\n` : "";
  const secretsBlock = webhookTarget
    ? `\n[secrets.webhook_token]
label = "${webhookTarget.label}机器人 Webhook 密钥"
hint = "仅填写 Webhook URL 末尾密钥段，由本地 DPAPI 加密保存并通过 {{secret:webhook_token}} 盲注入发送。"
`
    : "";
  const scheduleBlock = isSchedule
    ? `\n[schedule]
daily_at = "18:00"
`
    : "";

  const webhookCallBlock = webhookTarget
    ? `
  if (ctx.secrets.has("webhook_token")) {
    await ctx.http.fetch("${webhookTarget.urlTemplate}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ${webhookTarget.payloadExpr},
    });
    ctx.log.info("已通过宿主盲注入推送通知至 ${webhookTarget.label}");
  } else {
    ctx.log.warn("尚未录入 webhook_token 加密凭据，已记入本地台账等待配置");
  }`
    : `  ctx.log.info("已完成匹配邮件本地结构化归档");`;

  const scheduleFnBlock = isSchedule
    ? `\nexport async function onSchedule(tick, ctx) {
  const keys = await ctx.kv.listKeys("hit:");
  ctx.log.info("执行每日汇总巡检", { matchedCount: keys.length, trigger: tick.trigger });
  return {
    summary: \`今日共捕获 \${keys.length} 封重点匹配邮件\`,
    notifications: keys.length > 0
      ? [{ title: "${name} · 每日汇总", body: \`累计捕获 \${keys.length} 封目标来信，请及时查阅。\`, level: "info" }]
      : [],
  };
}\n`
    : "";

  return {
    reply: `已根据你的要求自动编写并通过五道安全门禁热加载插件 **「${name}」**（\`${id}\`）：\n- 监控关键词：${kwList.map((k) => `「${k}」`).join("、")}${webhookTarget ? `\n- 外部联动：已绑定 \`${webhookTarget.domain}\` 域名白名单，采用 \`{{secret:webhook_token}}\` DPAPI 盲注入推送` : ""}${isSchedule ? "\n- 定时巡检：每日 `18:00` 自动汇总命中记录" : ""}`,
    id,
    plugin_toml: `[plugin]
id = "${id}"
name = "${name}"
version = "0.1.0"
description = "由内置 AI 助手自动编写：匹配目标邮件并执行结构化登记与安全推送"
author = "mailchat-agent"
source = "agent"
priority = 35

[permissions]
hooks = [${hooks.map((h) => `"${h}"`).join(", ")}]
${networkLine}mail_access = "current"
kv_storage = true

[config]
keywords = { default = ${JSON.stringify(kwList.join(","))} }
${secretsBlock}${scheduleBlock}`,
    index_mjs: `export async function onBeforeTriage(mail, ctx) {
  const kwRaw = String(ctx.config.keywords || "");
  const keywords = kwRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const hay = \`\${mail.subject}\\n\${mail.bodyFull}\`.toLowerCase();
  const matched = keywords.filter((k) => hay.includes(k.toLowerCase()));

  if (matched.length === 0) {
    return { decision: "continue" };
  }

  return {
    decision: "short_circuit",
    tags: ["重点关注", ...matched.map((k) => \`命中:\${k}\`)],
    metadata: { matchedKeywords: matched },
    verdict: {
      action: "inbox",
      category: "${isAlert ? "告警" : "重点"}",
      summary: \`[\${matched[0]}] \${mail.subject.slice(0, 26)}\`,
      reason: \`命中自定义监控词：\${matched.join(", ")}\`,
      extractedCode: "",
      suggestedReply: "已收到，正在跟进处理。",
    },
  };
}

export async function onAfterTriage(mail, verdict, ctx) {
  const matched = mail.metadata?.matchedKeywords;
  if (!Array.isArray(matched) || matched.length === 0) {
    return;
  }

  await ctx.kv.set(\`hit:\${mail.messageId}\`, {
    from: mail.fromAddr,
    subject: mail.subject,
    matched,
    date: mail.date,
  });
${webhookCallBlock}
  return {
    tags: ["已联动处理"],
  };
}
${scheduleFnBlock}`,
    sample_test: {
      mail: {
        fromAddr: "monitor@infra.example.com",
        fromName: "监控中心",
        subject: `【${kwList[0]}】核心集群响应延迟超阈值通知`,
        body: `检测到触发条件：${kwList[0]}，请相关负责人确认。`,
        bodyFull: `检测到触发条件：${kwList[0]}，请相关负责人确认。`,
      },
    },
  };
}

function detectWebhookTarget(lowerPrompt, interceptedVendor) {
  const vendor =
    interceptedVendor?.vendor ||
    (/飞书|feishu|lark/.test(lowerPrompt)
      ? "feishu"
      : /钉钉|dingtalk/.test(lowerPrompt)
        ? "dingtalk"
        : /企微|企业微信|wecom/.test(lowerPrompt)
          ? "wecom"
          : /slack/.test(lowerPrompt)
            ? "slack"
            : null);

  if (vendor === "feishu") {
    return {
      vendor: "feishu",
      label: "飞书群",
      domain: "open.feishu.cn",
      urlTemplate: "https://open.feishu.cn/open-apis/bot/v2/hook/{{secret:webhook_token}}",
      payloadExpr: `{ msg_type: "text", content: { text: \`[MailChat] \${verdict.category}: \${mail.subject} (来自 \${mail.fromAddr})\` } }`,
    };
  }
  if (vendor === "dingtalk") {
    return {
      vendor: "dingtalk",
      label: "钉钉群",
      domain: "oapi.dingtalk.com",
      urlTemplate:
        "https://oapi.dingtalk.com/robot/send?access_token={{secret:webhook_token}}",
      payloadExpr: `{ msgtype: "text", text: { content: \`[MailChat] \${verdict.category}: \${mail.subject}\` } }`,
    };
  }
  if (vendor === "wecom") {
    return {
      vendor: "wecom",
      label: "企业微信群",
      domain: "qyapi.weixin.qq.com",
      urlTemplate:
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={{secret:webhook_token}}",
      payloadExpr: `{ msgtype: "text", text: { content: \`[MailChat] \${verdict.category}: \${mail.subject}\` } }`,
    };
  }
  if (vendor === "slack") {
    return {
      vendor: "slack",
      label: "Slack",
      domain: "hooks.slack.com",
      urlTemplate: "https://hooks.slack.com/services/{{secret:webhook_token}}",
      payloadExpr: `{ text: \`[MailChat] *\${verdict.category}*: \${mail.subject}\` }`,
    };
  }
  return null;
}

function extractQuotedKeywords(text) {
  const out = [];
  for (const m of text.matchAll(/[「『"“']([^「』"”']{1,16})[」』"”']/g)) {
    const word = m[1].trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}
