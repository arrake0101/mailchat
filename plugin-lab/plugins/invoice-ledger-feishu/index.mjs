export async function onAfterTriage(mail, verdict, ctx) {
  const fullText = `${mail.subject}\n${mail.bodyFull}`;
  if (!/(发票|电子票据|invoice|账单|价税合计)/i.test(fullText)) {
    return;
  }

  // 提取金额（支持 ¥1,280.00 / RMB 399.50 / 价税合计：560.00元）
  const amountMatch =
    fullText.match(/(?:¥|￥|RMB\s*|价税合计[:：\s]*)([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i) ||
    fullText.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*元/);

  const rawAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : 0;
  const invNoMatch = fullText.match(/(?:发票号码|发票代码|票号)[:：\s]*([0-9]{8,20})/);
  const invoiceNo = invNoMatch ? invNoMatch[1] : "待核验";

  const entry = {
    messageId: mail.messageId,
    from: mail.fromName || mail.fromAddr,
    fromAddr: mail.fromAddr,
    subject: mail.subject,
    amount: rawAmount,
    invoiceNo,
    date: mail.date,
  };

  await ctx.kv.set(`inv:${mail.messageId}`, entry);
  ctx.log.info("已登记电子发票台账", { amount: rawAmount, invoiceNo });

  const minNotify = Number(ctx.config.min_notify_amount || 0);
  if (rawAmount >= minNotify && ctx.secrets.has("feishu_token")) {
    await ctx.http.fetch(
      "https://open.feishu.cn/open-apis/bot/v2/hook/{{secret:feishu_token}}",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          msg_type: "interactive",
          card: {
            header: {
              title: {
                tag: "plain_text",
                content: `🧾 收到电子发票 ¥${rawAmount.toFixed(2)}`,
              },
            },
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: `**开票方**：${entry.from}\n**票据号**：${invoiceNo}\n**邮件主题**：${mail.subject}`,
                },
              },
            ],
          },
        },
      }
    );
    ctx.log.info("已通过 DPAPI 盲注入同步至飞书财务群");
  } else if (!ctx.secrets.has("feishu_token")) {
    ctx.log.warn("尚未配置 feishu_token，发票已存入本地台账，待配置后自动开启群推送");
  }

  const amountBadge = rawAmount > 0 ? `¥${rawAmount.toFixed(2)} · ` : "";
  return {
    tags: ["电子发票", ...(rawAmount > 0 ? [`金额:¥${rawAmount.toFixed(2)}`] : [])],
    metadata: { invoice: entry },
    overrideVerdict: {
      category: "发票",
      summary: `${amountBadge}${verdict.summary}`.slice(0, 36),
    },
  };
}

export async function onSchedule(tick, ctx) {
  const keys = await ctx.kv.listKeys("inv:");
  let totalAmount = 0;
  for (const key of keys) {
    const item = await ctx.kv.get(key);
    if (item && typeof item.amount === "number") {
      totalAmount += item.amount;
    }
  }

  const summary = `台账累计归集 ${keys.length} 张电子发票，合计 ¥${totalAmount.toFixed(2)}`;
  ctx.log.info("发票每日巡检完成", { count: keys.length, totalAmount, trigger: tick.trigger });

  return {
    summary,
    notifications:
      keys.length > 0
        ? [
            {
              title: "电子发票台账汇总",
              body: summary,
              level: "info",
            },
          ]
        : [],
  };
}
