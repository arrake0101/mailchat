export async function onBeforeTriage(mail, ctx) {
  const domains = String(ctx.config.vip_domains || "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

  const senderDomain = (mail.fromAddr.split("@")[1] || "").toLowerCase();
  const isVip = domains.some((d) => senderDomain === d || senderDomain.endsWith(`.${d}`));

  if (!isVip) {
    return { decision: "continue" };
  }

  ctx.log.info("识别到重点客户域名来信，已保送消息主列表", { senderDomain });

  return {
    decision: "short_circuit",
    tags: ["VIP客户", `域名:${senderDomain}`],
    metadata: { vip: true, vipDomain: senderDomain },
    verdict: {
      action: "inbox",
      category: "重点客户",
      summary: `⭐ ${mail.fromName || mail.fromAddr}: ${mail.subject}`.slice(0, 36),
      reason: `命中重点客户域名 (${senderDomain})，免拦截直通聊天`,
      extractedCode: "",
      suggestedReply: "您好，您的来信已收到，我这边马上为您确认。",
    },
  };
}

export async function onSchedule(tick, ctx) {
  const slaSecs = Math.max(Number(ctx.config.sla_minutes || 120), 5) * 60;
  const recentInbox = await ctx.mail.queryRecent({
    status: "inbox",
    unreadOnly: true,
    limit: 30,
  });

  const overdue = recentInbox.filter(
    (m) => m.metadata?.vip === true && tick.now - m.date >= slaSecs
  );

  ctx.log.info("VIP 超时未回巡检完成", {
    scanned: recentInbox.length,
    overdueCount: overdue.length,
  });

  return {
    summary:
      overdue.length > 0
        ? `发现 ${overdue.length} 封重点客户来信超过 ${ctx.config.sla_minutes} 分钟未读`
        : "所有重点客户来信均在响应时效内",
    notifications: overdue.map((m) => ({
      title: `⏰ 重点客户待响应：${m.fromName || m.fromAddr}`,
      body: `主题「${m.subject}」已等待超过 ${Math.floor((tick.now - m.date) / 60)} 分钟`,
      peer: m.peer,
      level: "warn",
    })),
  };
}
