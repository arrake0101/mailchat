export async function onBeforeSend(draft, ctx) {
  const content = `${draft.subject}\n${draft.body}`;

  if (ctx.config.block_secrets !== false) {
    const detectors = [
      {
        label: "大模型或云平台 API Key (sk-* / AIza* / AKIA*)",
        regex: /\b(?:sk-[A-Za-z0-9_-]{18,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/,
      },
      {
        label: "PEM 私钥证书块 (PRIVATE KEY)",
        regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      },
      {
        label: "带明文密码的数据库连接串",
        regex: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]{4,}@/i,
      },
    ];

    for (const d of detectors) {
      if (d.regex.test(content)) {
        ctx.log.warn("发信防泄漏守卫触发阻断", { rule: d.label, to: draft.to });
        return {
          cancel: true,
          reason: `发信守卫已拦截：检测到正文中包含敏感凭据【${d.label}】，请脱敏后再发送。`,
        };
      }
    }
  }

  let nextBody = draft.body;
  const sig = String(ctx.config.append_signature || "").trim();
  if (sig && !nextBody.includes(sig)) {
    nextBody = `${nextBody.trimEnd()}\n\n— ${sig}`;
  }

  return {
    body: nextBody,
    headers: {
      "X-MailChat-DLP-Checked": "pass",
    },
  };
}
