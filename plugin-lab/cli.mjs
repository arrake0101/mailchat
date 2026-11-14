#!/usr/bin/env node
/**
 * MailChat Plugin Lab CLI 演练台（零改动现有客户端代码）
 *
 * 用法：
 *   node plugin-lab/cli.mjs list                       # 查看现成插件清单与声明权限
 *   node plugin-lab/cli.mjs verify                     # 对全部插件执行五道安全与冒烟门禁
 *   node plugin-lab/cli.mjs simulate                   # 端到端仿真：收信分拣 + 飞书盲注入 + 发信防泄漏 + 定时巡检
 *   node plugin-lab/cli.mjs agent-author "<需求描述>"   # 仿真内置 AI 助手按需自动写插件、自检热加载并跑通测试样本（加 --save 落盘至 plugins/）
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorPluginFromPrompt } from "./host/agent-author.mjs";
import { MockVault, PluginHostEngine } from "./host/host-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, "plugins");

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "simulate";

  if (cmd === "list") {
    await cmdList();
  } else if (cmd === "verify") {
    await cmdVerify();
  } else if (cmd === "simulate") {
    await cmdSimulate();
  } else if (cmd === "agent-author") {
    const saveToPlugins = args.includes("--save");
    const promptParts = args.slice(1).filter((a) => a !== "--save");
    const prompt =
      promptParts.join(" ").trim() ||
      "收到包含「告警」或「故障」的运维邮件时直通消息列表，推送到飞书机器人 https://open.feishu.cn/open-apis/bot/v2/hook/9f8a7b6c-demo-token-2026，并每天定时汇总";
    await cmdAgentAuthor(prompt, saveToPlugins);
  } else {
    console.log("未知子命令，支持：list | verify | simulate | agent-author");
    process.exitCode = 1;
  }
}

async function cmdList() {
  const engine = new PluginHostEngine({ pluginsDir: PLUGINS_DIR });
  const { loaded, rejected } = await engine.loadAllFromDisk();

  console.log(`\n📦 MailChat 现成插件目录扫描 (${PLUGINS_DIR})\n`);
  for (const p of engine.getOrderedActivePlugins()) {
    const perms = p.manifest.permissions ?? {};
    const secrets = Object.keys(p.manifest.secrets ?? {});
    console.log(`  ● ${p.name} (${p.id}@${p.version}) [priority=${p.priority}, source=${p.source}]`);
    console.log(`    描述: ${p.description}`);
    console.log(`    钩子: ${(perms.hooks ?? []).join(", ")}`);
    console.log(
      `    权限: mail=${perms.mail_access ?? "current"} | kv=${Boolean(perms.kv_storage)} | net=${JSON.stringify(perms.network ?? [])}`
    );
    if (secrets.length > 0) {
      console.log(`    凭据: ${secrets.map((s) => `secret:plugin:${p.id}:${s}`).join(", ")}`);
    }
    console.log("");
  }

  if (rejected.length > 0) {
    console.log(`⚠️ 被门禁拦截的插件 (${rejected.length})：`, JSON.stringify(rejected, null, 2));
  } else {
    console.log(`✅ 共加载 ${loaded.length} 个插件，全部通过五道安全门禁。\n`);
  }
}

async function cmdVerify() {
  const engine = new PluginHostEngine({ pluginsDir: PLUGINS_DIR });
  const { loaded, rejected } = await engine.loadAllFromDisk();

  console.log("\n🛡️ 执行五道安全与契约校验门禁 (Gate 1 ~ Gate 5)...\n");
  for (const p of loaded) {
    console.log(`  [PASS] ${p.id} (${p.name})`);
    for (const [hook, res] of Object.entries(p.smokeResults)) {
      console.log(`         └─ SmokeTest ${hook}: OK | output=${JSON.stringify(res.output)}`);
    }
  }
  for (const r of rejected) {
    console.log(`  [FAIL] ${r.id}`);
    for (const d of r.diagnostics) {
      console.log(`         └─ [${d.gate}/${d.code}] ${d.message}`);
    }
  }

  if (rejected.length > 0) process.exitCode = 1;
}

async function cmdSimulate() {
  const vault = new MockVault({
    "plugin:invoice-ledger-feishu:feishu_token": "feishu-real-secret-dpapi-token-8899",
  });

  const capturedWireRequests = [];
  const engine = new PluginHostEngine({
    pluginsDir: PLUGINS_DIR,
    vault,
    httpTransport: async (req) => {
      capturedWireRequests.push(req);
      return {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        text: '{"StatusCode":0,"StatusMessage":"success"}',
        json: { StatusCode: 0, StatusMessage: "success" },
      };
    },
  });

  await engine.loadAllFromDisk();
  console.log("\n======================================================================");
  console.log("🚀 MailChat 插件流水线全链路沙盒仿真（零改动客户端代码）");
  console.log("======================================================================\n");

  // 场景 1：验证码邮件（验证 onBeforeTriage 极速短路，省掉大模型调用）
  const otpRes = await engine.runIncomingPipeline({
    fromAddr: "noreply@github.com",
    fromName: "GitHub",
    subject: "[GitHub] Your verification code is 492817",
    body: "Enter verification code: 492817 to complete sign-in.",
    date: Math.floor(Date.now() / 1000) - 300,
  });
  console.log("① [收信 · 验证码极速短路]");
  console.log(`   短路插件: ${otpRes.shortCircuitedBy}（跳过大模型 API 调用）`);
  console.log(`   最终裁决: action=${otpRes.finalVerdict.action} | 分类=${otpRes.finalVerdict.category} | 提取码=${otpRes.finalVerdict.extractedCode}`);
  console.log(`   展示摘要: ${otpRes.finalVerdict.summary}\n`);

  // 场景 2：电子发票邮件（验证 onAfterTriage 结构化入账 + DPAPI 盲注入推送飞书）
  const invRes = await engine.runIncomingPipeline({
    messageId: "<inv-20261113@aliyun.com>",
    fromAddr: "invoice@service.aliyun.com",
    fromName: "阿里云电子发票",
    subject: "您收到一张增值税电子普通发票（价税合计 ¥2,460.50）",
    bodyFull: "尊敬的客户，发票号码：263120000001928374，价税合计：¥2,460.50，请查收附件。",
  });
  console.log("② [收信 · 电子发票提取记账 + 飞书 Webhook 盲注入]");
  console.log(`   最终裁决: action=${invRes.finalVerdict.action} | 分类=${invRes.finalVerdict.category} | 标签=${invRes.finalMail.tags.join(",")}`);
  console.log(`   展示摘要: ${invRes.finalVerdict.summary}`);
  const traceHttp = invRes.trace.find((t) => t.pluginId === "invoice-ledger-feishu")?.outboundHttpCalls?.[0];
  console.log(`   审计日志(已脱敏): ${traceHttp?.method} ${traceHttp?.url}`);
  console.log(`   底层真实发包URL : ${capturedWireRequests[0]?.url} (由宿主注入 DPAPI 凭据)\n`);

  // 场景 3：重点客户来信（3 小时前到达且未读，用于稍后触发超时巡检）
  await engine.runIncomingPipeline({
    fromAddr: "cto@vip-client.com",
    fromName: "张总 (VIP)",
    subject: "关于 Q4 私有化部署合同终稿确认",
    body: "请今天内确认附件合同条款。",
    date: Math.floor(Date.now() / 1000) - 3 * 3600,
  });

  // 场景 4：发信前 DLP 防泄漏守卫拦截误贴的 API Key
  const leakSend = await engine.runOutboundPipeline({
    to: ["external@partner.org"],
    subject: "测试环境配置参数",
    body: "你好，这是我们的测试接口密钥 sk-live-9876543210abcdefghijklmnop，请查收。",
  });
  console.log("③ [发信 · DLP 敏感凭据防泄漏守卫]");
  console.log(`   允许发送: ${leakSend.allowed} | 拦截插件: ${leakSend.blockedBy}`);
  console.log(`   拦截提示: ${leakSend.reason}\n`);

  // 场景 5：后台定时巡检（汇总今日发票台账 + 扫描 VIP 超时未回会话）
  const cronRes = await engine.runScheduledTick({ trigger: "daily_at" });
  console.log("④ [后台定时巡检 · onSchedule]");
  for (const r of cronRes.reports) {
    console.log(`   ● ${r.pluginName}: ${r.summary}`);
    for (const n of r.notifications) {
      console.log(`     🔔 [${n.level}] ${n.title} -> ${n.body}`);
    }
  }

  console.log("\n⑤ [对应的 config.toml 声明式配置片段预览]");
  console.log(engine.exportDeclarativeTomlSnippet());
}

async function cmdAgentAuthor(prompt, saveToPlugins) {
  const workDir = saveToPlugins
    ? PLUGINS_DIR
    : await fs.mkdtemp(path.join(os.tmpdir(), "mailchat-plugin-lab-"));

  try {
    const engine = new PluginHostEngine({
      pluginsDir: workDir,
      httpTransport: async () => ({
        status: 200,
        ok: true,
        headers: {},
        text: '{"ok":true}',
        json: { ok: true },
      }),
    });

    if (saveToPlugins) {
      await engine.loadAllFromDisk();
    }

    console.log("\n======================================================================");
    console.log("🤖 内置 AI 助手按需自编写插件全链路演练");
    console.log("======================================================================");
    console.log(`\n🗣️ 用户输入需求:\n   "${prompt}"\n`);

    const outcome = await authorPluginFromPrompt({
      userPrompt: prompt,
      hostEngine: engine,
    });

    if (!outcome.ok) {
      console.error("❌ 生成未通过门禁：", outcome);
      process.exitCode = 1;
      return;
    }

    console.log(`✅ 自检通过（共尝试 ${outcome.attempts} 轮，5 道安全门禁全部绿灯）`);
    console.log(`\n💬 助手回复:\n${outcome.reply}\n`);
    console.log("📌 变更记录:");
    for (const ch of outcome.changes) {
      console.log(`   ✓ ${ch}`);
    }

    if (outcome.secretPrompts.length > 0) {
      console.log("\n🔐 自动唤起 InlineSecretVaultCard 加密录入卡:");
      for (const sp of outcome.secretPrompts) {
        console.log(`   [${sp.key}] ${sp.label} — ${sp.hint}`);
      }
    } else {
      console.log("\n🔐 凭据状态: 所需凭据已就绪（或无需外部凭据）");
    }

    console.log("\n📄 生成的 plugin.toml 预览:");
    console.log("----------------------------------------------------------------------");
    const pkgDir = outcome.plugin.pkgDir;
    console.log((await fs.readFile(path.join(pkgDir, "plugin.toml"), "utf8")).trim());
    console.log("----------------------------------------------------------------------");

    // 立即用刚热加载的插件跑一封匹配的仿真邮件验证闭环
    const sampleMail = outcome.sampleTest?.mail ?? {
      fromAddr: "alert@prod-monitor.example.com",
      fromName: "生产监控",
      subject: "【P0 告警】数据库连接池耗尽，请立即排查",
      bodyFull: "核心集群触发告警故障阈值，请值班研发立即处理。",
    };
    const liveCheck = await engine.runIncomingPipeline(sampleMail);
    console.log("\n⚡ 热加载后即时收信验证结果:");
    console.log(`   路由去向: ${liveCheck.finalVerdict.action} | 分类: ${liveCheck.finalVerdict.category} | 摘要: ${liveCheck.finalVerdict.summary}`);
    console.log(`   插件轨迹: ${liveCheck.trace.map((t) => `${t.pluginId}:${t.hook}(ok=${t.ok},http=${t.outboundHttpCalls.length})`).join(" -> ")}\n`);
  } finally {
    if (!saveToPlugins) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
