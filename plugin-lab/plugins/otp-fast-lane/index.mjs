export async function onBeforeTriage(mail, ctx) {
  const combined = `${mail.subject}\n${mail.bodyFull}`;
  const otpIntent = /(验证码|校验码|动态码|安全码|一次性密码|verification\s*code|security\s*code|one-time\s*passcode|\botp\b)/i;

  if (!otpIntent.test(combined)) {
    return { decision: "continue" };
  }

  // 若同时是电子发票邮件，交给下游发票插件处理，仅附带验证码参考
  if (/(电子发票|增值税.*发票)/.test(combined)) {
    return { decision: "continue" };
  }

  // 优先匹配紧跟在关键词后的 4~8 位验证码，避免误把年份或金额当验证码
  const nearMatch = combined.match(
    /(?:验证码|校验码|动态码|安全码|verification\s*code|passcode|code\s+is)[:：\s是为]*([0-9]{4,8})\b/i
  );
  const fallbackMatch = combined.match(/\b([0-9]{6})\b/);
  const code = nearMatch ? nearMatch[1] : fallbackMatch ? fallbackMatch[1] : "";

  if (!code) {
    return { decision: "continue" };
  }

  ctx.log.info("极速通道命中验证码邮件，已短路跳过大模型分拣", { codeLength: code.length });

  return {
    decision: "short_circuit",
    tags: ["验证码", "极速短路"],
    metadata: { otpExtractedBy: "otp-fast-lane" },
    verdict: {
      action: ctx.config.auto_archive !== false ? "archive" : "inbox",
      category: "验证码",
      summary: `验证码 ${code} · ${mail.fromName || mail.fromAddr}`,
      reason: "插件极速提取动态验证码并自动折叠至通知",
      extractedCode: code,
      suggestedReply: "",
    },
  };
}
