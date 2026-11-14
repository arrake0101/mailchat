import type { MouseEvent, ReactNode } from "react";
import { api } from "../api";
import type { Status } from "../types";

function IconLink({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
    >
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 7.5 14 4.5H19.5V10L16.5 13" />
      <path d="M13 16.5 10 19.5H4.5V14L7.5 11" />
    </svg>
  );
}

function IconExternalLink({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
    >
      <path d="M13.5 5H19V10.5" />
      <path d="M18.5 5.5 10 14" />
      <path d="M10 6.5H5V19H17.5V14" />
    </svg>
  );
}

export interface QuoteMeta {
  from?: string;
  date?: string;
  to?: string;
  cc?: string;
  subject?: string;
  attribution?: string;
}

export interface ParsedQuote {
  kind: "reply" | "forward";
  meta: QuoteMeta;
  body: string;
  nested: ParsedQuote | null;
}

export interface AnalyzedMailBody {
  main: string;
  quote: ParsedQuote | null;
  extraRaw: string;
  replaceMainOnExpand?: boolean;
  isPureQuote: boolean;
  hasExpandable: boolean;
  expandLabel: string;
  collapseLabel: string;
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u034F\u2060]/g;
const WRAPPED_ANGLE_URL_RE = /<(https?:\/\/[^\s<>]+(?:\n[ \t]*[^\s<>]+)+)>/g;
const CID_RE = /\[cid:[^\]\n]+\]/gi;
const MAILTO_ECHO_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?[ \t]*<mailto:([^>\s]+)>/gi;
const DUP_URL_ECHO_RE = /(https?:\/\/[^\s<>]+)[ \t]+<\1>/gi;
const IMG_PLACEHOLDER_LINE_RE = /^\[image:\s*[^\]]*\]$/i;

const QUOTE_CUT_PATTERNS: RegExp[] = [
  /^[ \t]*-{2,}[ \t]*(?:Original Message|Original|原始邮件|原邮件|回复的原邮件|回复邮件|Replied Message|Reply Message|Forwarded message|转发邮件|转发的邮件|转发的原邮件|已转发邮件)[ \t]*-{2,}[ \t]*$/im,
  /^[ \t]*(?:Begin forwarded message:|下面是被转发的邮件[：:]|以下是转发的邮件[：:])[ \t]*$/im,
  /^[ \t]*On [^\n]{4,180}(?:\n[^\n]{1,120})?\bwrote:[ \t]*$/im,
  /^[ \t]*在[ \t]*[^\n]{4,180}(?:\n[^\n]{1,120})?写道[：:][ \t]*$/m,
  /^[ \t]*[^\n]{2,140}于[ \t]*20\d{2}[^\n]{2,80}(?:\n[^\n]{1,80})?写道[：:][ \t]*$/m,
  /^[ \t]*_{5,}[ \t]*$/m,
  /^[ \t]*-{20,}[ \t]*\n+[ \t]*(?:\|[ \t]*)?(?:From|发件人)[ \t]*(?:\||[:：])/im,
  /^[ \t]*\*?\*?From\*?\*?[ \t]*:[ \t]+.+\n[ \t]*\*?\*?(?:Sent|Date|To)\*?\*?[ \t]*:/im,
  /^[ \t]*\*?\*?发件人\*?\*?[ \t]*[:：].+\n[ \t]*\*?\*?(?:发送时间|时间|日期|收件人)\*?\*?[ \t]*[:：]/m,
  /^[ \t]*\|[ \t]*发件人[ \t]*\|.+\|[ \t]*\n[ \t]*\|[ \t]*(?:日期|时间|发送时间|收件人)[ \t]*\|/m,
  /^[ \t]*\|[ \t]*From[ \t]*\|.+\|[ \t]*\n[ \t]*\|[ \t]*(?:Date|Sent|To)[ \t]*\|/im,
];

const MOBILE_SIG_RE =
  /^[ \t]*(?:发自我的[ \t]*(?:iPhone|iPad|Mac|华为[^\n]{0,12}|小米[^\n]{0,12}|荣耀[^\n]{0,12}|OPPO[^\n]{0,12}|vivo[^\n]{0,12}|手机|Android)|Sent from my (?:iPhone|iPad|Mac|Galaxy|Android|Phone)|Get Outlook for (?:iOS|Android)|获取[ \t]*Outlook for (?:iOS|Android)|发自网易邮箱大师|签名由[ \t]*网易邮箱大师[ \t]*定制)[ \t]*$/im;

const DIVIDER_HEADER_LINE_RE =
  /^[ \t]*(?:-{2,}[ \t]*(?:Original Message|Original|原始邮件|原邮件|回复的原邮件|回复邮件|Replied Message|Reply Message|Forwarded message|转发邮件|转发的邮件|转发的原邮件|已转发邮件)[ \t]*-{2,}|Begin forwarded message:|下面是被转发的邮件[：:]|以下是转发的邮件[：:]|_{5,}|-{20,})[ \t]*$/i;

const FORWARD_HINT_RE = /Forwarded|转发/i;

const IGNORED_HEADER_KEYS = new Set(["密送", "bcc", "回复", "reply-to", "replyto", "重要性", "优先级", "importance"]);

const HEADER_KEY_MAP: Record<string, keyof QuoteMeta> = {
  发件人: "from",
  from: "from",
  sender: "from",
  日期: "date",
  时间: "date",
  发送时间: "date",
  date: "date",
  sent: "date",
  收件人: "to",
  to: "to",
  抄送: "cc",
  抄送至: "cc",
  抄送人: "cc",
  cc: "cc",
  主题: "subject",
  subject: "subject",
};

export function normalizeMessageText(raw: string): string {
  if (!raw) return "";
  let s = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ZERO_WIDTH_RE, "");

  s = s.replace(WRAPPED_ANGLE_URL_RE, (_m, inner: string) => `<${inner.replace(/\s+/g, "")}>`);
  s = s.replace(CID_RE, "");
  s = s.replace(MAILTO_ECHO_RE, (_m, prev: string | undefined, addr: string) => {
    if (prev) {
      return prev.toLowerCase() === addr.toLowerCase() ? prev : `${prev} <${addr}>`;
    }
    return addr;
  });
  s = s.replace(DUP_URL_ECHO_RE, "<$1>");
  return s.trim();
}

function cleanMainLines(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    const t = l.trim();
    if (IMG_PLACEHOLDER_LINE_RE.test(t)) continue;
    if (!t) {
      blank += 1;
      if (blank > 1) continue;
      if (out.length > 0) out.push("");
    } else {
      blank = 0;
      out.push(l.trimEnd());
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n").trim();
}

function formatContactValue(v: string): string {
  return v
    .trim()
    .replace(/;+$/, "")
    .replace(/([^\s<])<([^>\s]+@[^>\s]+)>/g, "$1 <$2>")
    .trim();
}

function splitPipeCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 3) return null;
  const inner = trimmed.slice(1, -1);
  return inner.split("|").map((c) => c.trim());
}

function isMarkdownTableSep(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function stripMainSignatures(s: string): { clean: string; sig: string } {
  let cutAt = -1;
  const rfcIdx = s.indexOf("\n-- \n");
  if (rfcIdx !== -1) cutAt = rfcIdx;
  else if (s.endsWith("\n-- ")) cutAt = s.length - 4;

  const mobMatch = MOBILE_SIG_RE.exec(s);
  if (mobMatch && (cutAt === -1 || mobMatch.index < cutAt)) {
    cutAt = mobMatch.index;
  }

  if (cutAt === -1) return { clean: s, sig: "" };
  return {
    clean: s.slice(0, cutAt).trimEnd(),
    sig: s.slice(cutAt).replace(/^\n*--\s*\n?/, "").trim(),
  };
}

function findEarliestQuoteIndex(text: string): number {
  let earliest = -1;
  for (const re of QUOTE_CUT_PATTERNS) {
    const m = re.exec(text);
    if (m && (earliest === -1 || m.index < earliest)) {
      earliest = m.index;
    }
  }
  return earliest;
}

function splitTrailingBracketQuotes(text: string): { head: string; quoted: string } {
  const lines = text.split("\n");
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end -= 1;
  if (end < 0 || !lines[end].trimStart().startsWith(">")) {
    return { head: text, quoted: "" };
  }
  let quoteStart = end;
  while (quoteStart > 0) {
    const prev = lines[quoteStart - 1].trim();
    if (prev.startsWith(">") || prev === "") {
      quoteStart -= 1;
    } else {
      break;
    }
  }
  while (quoteStart <= end && !lines[quoteStart].trimStart().startsWith(">")) {
    quoteStart += 1;
  }
  const head = lines.slice(0, quoteStart).join("\n").trim();
  const quoted = lines.slice(quoteStart, end + 1).join("\n").trim();
  return { head, quoted };
}

function parseQuoteBlock(rawQuote: string, depth: number): ParsedQuote | null {
  const trimmed = rawQuote.trim();
  if (!trimmed) return null;

  let lines = trimmed.split("\n");
  let kind: "reply" | "forward" = "reply";
  const meta: QuoteMeta = {};

  // 如果整段都是 `>` 引用前缀，先统一剥掉一层 `>`
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length > 0 && nonEmpty.every((l) => l.trimStart().startsWith(">"))) {
    lines = lines.map((l) => l.replace(/^[ \t]*>[ \t]?/, ""));
  }

  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx += 1;

  // 1. 识别分隔横线头（如 ---- 回复的原邮件 ---- / ---------- Forwarded message ---------）
  if (idx < lines.length && DIVIDER_HEADER_LINE_RE.test(lines[idx])) {
    if (FORWARD_HINT_RE.test(lines[idx])) kind = "forward";
    idx += 1;
    while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  }

  // 2. 识别单行或跨两行的 `On ... wrote:` / `在 ... 写道：` / `... 于 ... 写道：`
  if (idx < lines.length) {
    const oneLine = lines[idx].trim();
    const twoLine = idx + 1 < lines.length ? `${oneLine} ${lines[idx + 1].trim()}` : "";
    const attrRe = /^(?:On\s+(.+?)\s+wrote:|在\s*(.+?)\s*写道[：:]|(.+?于\s*20\d{2}.+?)\s*写道[：:])$/i;
    const m1 = attrRe.exec(oneLine);
    const m2 = !m1 && twoLine ? attrRe.exec(twoLine) : null;
    if (m1) {
      meta.attribution = formatContactValue(m1[1] || m1[2] || m1[3] || "");
      idx += 1;
    } else if (m2) {
      meta.attribution = formatContactValue(m2[1] || m2[2] || m2[3] || "");
      idx += 2;
    }
    while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  }

  // 3. 解析网易竖线表格头 `| 发件人 | ... |` 或标准冒号头 `发件人: ...` / `From: ...`
  let parsedHeaderCount = 0;
  while (idx < lines.length) {
    const cur = lines[idx].trim();
    if (!cur) {
      if (parsedHeaderCount > 0) {
        idx += 1;
        break;
      }
      idx += 1;
      continue;
    }

    const pipeCells = splitPipeCells(cur);
    if (pipeCells) {
      if (isMarkdownTableSep(pipeCells)) {
        idx += 1;
        continue;
      }
      if (pipeCells.length === 2) {
        const keyNorm = pipeCells[0].replace(/[*：\s:]/g, "").toLowerCase();
        const mapped = HEADER_KEY_MAP[keyNorm];
        if (mapped || IGNORED_HEADER_KEYS.has(keyNorm)) {
          const val = formatContactValue(pipeCells[1]);
          if (mapped && val && val !== "-") {
            meta[mapped] = mapped === "subject" ? pipeCells[1].trim() : val;
          }
          parsedHeaderCount += 1;
          idx += 1;
          continue;
        }
      }
      break;
    }

    const colonMatch =
      /^\*?\*?(发件人|收件人|抄送至|抄送人|抄送|密送|回复|发送时间|时间|日期|主题|重要性|优先级|From|To|Cc|Bcc|Reply-To|Sent|Date|Subject|Importance)\*?\*?[ \t]*[:：][ \t]*(.*)$/i.exec(
        cur,
      );
    if (colonMatch) {
      const keyNorm = colonMatch[1].toLowerCase();
      const mapped = HEADER_KEY_MAP[keyNorm];
      const rawVal = colonMatch[2].trim();
      if (mapped && rawVal && rawVal !== "-") {
        meta[mapped] = mapped === "subject" ? rawVal : formatContactValue(rawVal);
      }
      parsedHeaderCount += 1;
      idx += 1;
      continue;
    }

    break;
  }

  // 4. 提取引用正文，并剥掉前导 `>` 引用符号
  let restLines = lines.slice(idx);
  while (restLines.length > 0 && restLines[0].trim() === "") restLines.shift();
  const restNonEmpty = restLines.filter((l) => l.trim() !== "");
  if (restNonEmpty.length > 0 && restNonEmpty.every((l) => l.trimStart().startsWith(">"))) {
    restLines = restLines.map((l) => l.replace(/^[ \t]*>[ \t]?/, ""));
  } else {
    restLines = restLines.map((l) => (l.trimStart().startsWith(">") ? l.replace(/^[ \t]*>[ \t]?/, "") : l));
  }

  const restJoined = restLines.join("\n").trim();
  if (!restJoined && !meta.from && !meta.subject && !meta.attribution) {
    return null;
  }

  let body = restJoined;
  let nested: ParsedQuote | null = null;
  if (depth < 2 && restJoined) {
    const subCut = findEarliestQuoteIndex(restJoined);
    if (subCut > 0) {
      body = cleanMainLines(restJoined.slice(0, subCut));
      nested = parseQuoteBlock(restJoined.slice(subCut), depth + 1);
    } else {
      body = cleanMainLines(restJoined);
    }
  } else {
    body = cleanMainLines(restJoined);
  }

  return { kind, meta, body, nested };
}

export function analyzeMessageBody(body: string, bodyFull: string): AnalyzedMailBody {
  const normBody = normalizeMessageText(body);
  const normFull = normalizeMessageText(bodyFull || body);

  let workingMain = normFull;
  let quoteRaw = "";

  const cutIdx = findEarliestQuoteIndex(normFull);
  if (cutIdx !== -1) {
    workingMain = normFull.slice(0, cutIdx);
    quoteRaw = normFull.slice(cutIdx);
  } else {
    const bracketSplit = splitTrailingBracketQuotes(normFull);
    if (bracketSplit.quoted && bracketSplit.head) {
      workingMain = bracketSplit.head;
      quoteRaw = bracketSplit.quoted;
    }
  }

  const { clean: mainWithoutSig, sig } = stripMainSignatures(workingMain);
  let main = cleanMainLines(mainWithoutSig);

  // 如果后端已提前裁剪出更干净的 body，则对齐使用干净版本作为主文本
  if (normBody && normBody.length < main.length && findEarliestQuoteIndex(normBody) === -1) {
    const { clean: cleanB } = stripMainSignatures(normBody);
    const candidate = cleanMainLines(cleanB);
    if (candidate) main = candidate;
  }

  const quote = quoteRaw ? parseQuoteBlock(quoteRaw, 0) : null;
  const isPureQuote = !main && Boolean(quote);

  if (isPureQuote) {
    return {
      main: "",
      quote,
      extraRaw: sig,
      isPureQuote: true,
      hasExpandable: false,
      expandLabel: "查看引用",
      collapseLabel: "收起引用",
    };
  }

  if (!main && !quote) {
    main = cleanMainLines(normBody || normFull);
  }

  const fallbackRemainder =
    !quote && !sig && normFull && normFull !== main && normFull.startsWith(main)
      ? normFull.slice(main.length).trim()
      : "";
  const replaceFullOnExpand = !quote && !sig && Boolean(normFull) && normFull !== main && !normFull.startsWith(main);
  const extraRaw = !quote ? sig || fallbackRemainder || (replaceFullOnExpand ? normFull : "") : "";
  const hasExpandable = Boolean(quote) || Boolean(extraRaw);
  const hasOnlySig = !quote && Boolean(sig);

  return {
    main,
    quote,
    extraRaw,
    replaceMainOnExpand: replaceFullOnExpand,
    isPureQuote: false,
    hasExpandable,
    expandLabel: quote ? "查看引用" : hasOnlySig ? "展开签名" : "展开原文",
    collapseLabel: quote ? "收起引用" : hasOnlySig ? "收起签名" : "收起原文",
  };
}

function formatUrlParts(rawUrl: string): { host: string; compact: string } {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./i, "") || rawUrl;
    let cleanPath = "";
    try {
      cleanPath = decodeURIComponent(u.pathname || "").replace(/\/+$/, "");
    } catch {
      cleanPath = (u.pathname || "").replace(/\/+$/, "");
    }
    const hasExtra = Boolean(u.search || u.hash);
    if (!cleanPath) {
      return { host, compact: hasExtra ? `${host}/…` : host };
    }
    const maxPath = 22;
    const shortPath =
      cleanPath.length > maxPath ? `${cleanPath.slice(0, maxPath)}…` : hasExtra ? `${cleanPath}…` : cleanPath;
    return { host, compact: `${host}${shortPath}` };
  } catch {
    const stripped = rawUrl.replace(/^https?:\/\//i, "");
    const host = stripped.split("/")[0] || rawUrl;
    const compact = stripped.length > 38 ? `${stripped.slice(0, 38)}…` : stripped;
    return { host, compact };
  }
}

function trimBareUrl(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = "";
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (/[.,;:!?，。；：！？"'’”》】\]]/.test(last)) {
      trailing = last + trailing;
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) {
        trailing = last + trailing;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return { url, trailing };
}

function isCtaLabel(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 34) return false;
  if (/^https?:\/\//i.test(t) || t.includes("http://") || t.includes("https://")) return false;
  if (t.startsWith("|") || t.startsWith(">")) return false;
  // 完整陈述句末尾通常带句号/感叹号/问号/冒号/分号/逗号，不应误判为按钮文案
  if (/[。！？.!?;；，,：:]$/.test(t)) return false;
  return true;
}

function cleanCtaLabel(text: string): string {
  return text.trim().replace(/^[\[【「]+|[\]】」:：]+$/g, "").trim();
}

export function highlightText(text: string, query?: string): ReactNode {
  const q = query?.trim();
  if (!q || !text) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  if (parts.length <= 1) return text;
  const qLower = q.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === qLower ? (
      <mark key={idx} className="chat-search-mark">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function renderInlineTokens(
  text: string,
  onOpenUrl: (e: MouseEvent, url: string) => void,
  highlightQuery?: string,
): ReactNode[] {
  const tokenRe =
    /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>[\]"]+)/gi;
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  const pushPlainChunk = (chunk: string) => {
    if (!chunk) return;
    out.push(<span key={`t-${key++}`}>{highlightText(chunk, highlightQuery)}</span>);
  };

  const pushPlainWithMentions = (segment: string) => {
    if (!segment) return;
    // 先匹配完整邮箱地址并原样保留，防止 arrake@163.com 中的 @163 被误高亮为 @提及
    const subRe =
      /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|((?:^|[^A-Za-z0-9._%+/-])@[^\s@，。！？,.!?:：;；()（）<>]{1,24})/g;
    let sLast = 0;
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(segment)) !== null) {
      if (sm.index > sLast) {
        pushPlainChunk(segment.slice(sLast, sm.index));
      }
      if (sm[1]) {
        pushPlainChunk(sm[1]);
      } else if (sm[2]) {
        const full = sm[2];
        const atPos = full.indexOf("@");
        if (atPos > 0) {
          pushPlainChunk(full.slice(0, atPos));
        }
        out.push(
          <span key={`m-${key++}`} className="mention-token">
            {highlightText(full.slice(atPos), highlightQuery)}
          </span>,
        );
      }
      sLast = subRe.lastIndex;
    }
    if (sLast < segment.length) {
      pushPlainChunk(segment.slice(sLast));
    }
  };

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      pushPlainWithMentions(text.slice(lastIdx, match.index));
    }

    if (match[1] && match[2]) {
      const label = match[1].trim();
      const url = match[2].trim();
      out.push(
        <a
          key={`l-${key++}`}
          href={url}
          title={url}
          className="mail-inline-link"
          onClick={(e) => onOpenUrl(e, url)}
        >
          <span>{label}</span>
          <IconExternalLink size={11} />
        </a>,
      );
    } else if (match[3]) {
      const url = match[3].trim();
      const { compact } = formatUrlParts(url);
      out.push(
        <a
          key={`l-${key++}`}
          href={url}
          title={url}
          className="mail-inline-link"
          onClick={(e) => onOpenUrl(e, url)}
        >
          <span>{compact}</span>
          <IconExternalLink size={11} />
        </a>,
      );
    } else if (match[4]) {
      const { url, trailing } = trimBareUrl(match[4]);
      const { compact } = formatUrlParts(url);
      out.push(
        <a
          key={`l-${key++}`}
          href={url}
          title={url}
          className="mail-inline-link"
          onClick={(e) => onOpenUrl(e, url)}
        >
          <span>{compact}</span>
          <IconExternalLink size={11} />
        </a>,
      );
      if (trailing) pushPlainWithMentions(trailing);
    }

    lastIdx = tokenRe.lastIndex;
  }

  if (lastIdx < text.length) {
    pushPlainWithMentions(text.slice(lastIdx));
  }

  return out;
}

function ActionLinkCard({
  label,
  url,
  onOpenUrl,
}: {
  label: string;
  url: string;
  onOpenUrl: (e: MouseEvent, url: string) => void;
}) {
  const { host } = formatUrlParts(url);
  return (
    <div className="mail-cta-row">
      <a href={url} title={url} className="mail-cta-link" onClick={(e) => onOpenUrl(e, url)}>
        <span className="mail-cta-icon">
          <IconLink size={13} />
        </span>
        <span className="mail-cta-label">{label}</span>
        {host && <span className="mail-cta-domain">{host}</span>}
        <IconExternalLink size={12} className="mail-cta-arrow" />
      </a>
    </div>
  );
}

function StandaloneUrlChip({
  url,
  onOpenUrl,
}: {
  url: string;
  onOpenUrl: (e: MouseEvent, url: string) => void;
}) {
  const { compact } = formatUrlParts(url);
  return (
    <div className="mail-cta-row">
      <a href={url} title={url} className="mail-url-chip" onClick={(e) => onOpenUrl(e, url)}>
        <IconLink size={12} className="mail-url-chip-icon" />
        <span className="mail-url-chip-text">{compact}</span>
        <IconExternalLink size={11} className="mail-cta-arrow" />
      </a>
    </div>
  );
}

function RichBlocks({
  text,
  onOpenUrl,
  highlightQuery,
}: {
  text: string;
  onOpenUrl: (e: MouseEvent, url: string) => void;
  highlightQuery?: string;
}) {
  if (!text) return null;
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let bKey = 0;

  const extractBracketedUrlLine = (s: string): string | null => {
    const m = /^(?:<(https?:\/\/[^>\s]+)>|\[(https?:\/\/[^\]\s]+)\])$/i.exec(s.trim());
    return m ? (m[1] || m[2]).trim() : null;
  };

  const extractSingleLineCta = (s: string): { label: string; url: string } | null => {
    const t = s.trim();
    const md = /^\[([^\]\n]{2,42})\]\((https?:\/\/[^\s)]+)\)$/i.exec(t);
    if (md) {
      return { label: cleanCtaLabel(md[1]), url: md[2].trim() };
    }
    const inlineAngle = /^([^<>[\]\n]{2,34}?)[ \t]*<(https?:\/\/[^>\s]+)>$/i.exec(t);
    if (inlineAngle) {
      const candidate = inlineAngle[1].replace(/[：:\s]+$/, "").trim();
      if (isCtaLabel(candidate)) {
        return { label: cleanCtaLabel(candidate), url: inlineAngle[2].trim() };
      }
    }
    return null;
  };

  const extractStandaloneBareUrl = (s: string): string | null => {
    const t = s.trim();
    const m = /^<?(https?:\/\/[^\s<>]+)>?$/i.exec(t);
    if (!m) return null;
    const { url, trailing } = trimBareUrl(m[1]);
    return trailing ? null : url;
  };

  const isSpecialLineAt = (idx: number): boolean => {
    if (idx >= lines.length) return false;
    const cur = lines[idx].trim();
    if (!cur) return true;
    if (/^[-=*_─━]{6,}$/.test(cur)) return true;
    if (extractSingleLineCta(cur) !== null) return true;
    if (extractStandaloneBareUrl(cur) !== null) return true;
    if (splitPipeCells(cur) !== null && idx + 1 < lines.length && splitPipeCells(lines[idx + 1]) !== null) {
      return true;
    }
    if (isCtaLabel(cur)) {
      if (idx + 1 < lines.length && extractBracketedUrlLine(lines[idx + 1]) !== null) return true;
      if (
        cur.length <= 16 &&
        idx + 2 < lines.length &&
        lines[idx + 1].trim() === "" &&
        extractBracketedUrlLine(lines[idx + 2]) !== null
      ) {
        return true;
      }
    }
    return false;
  };

  while (i < lines.length) {
    const cur = lines[i].trim();
    if (!cur) {
      i += 1;
      continue;
    }

    // 1. 水平分隔线（避免长串 ----- 在气泡中丑陋折行）
    if (/^[-=*_─━]{6,}$/.test(cur)) {
      blocks.push(<hr key={bKey++} className="mail-hr" />);
      i += 1;
      continue;
    }

    // 2. 双行按钮动作链接（如：`查看活动` + `\n<https://accounts.google.com/...>`）
    if (isCtaLabel(cur)) {
      const nextUrl = i + 1 < lines.length ? extractBracketedUrlLine(lines[i + 1]) : null;
      if (nextUrl) {
        blocks.push(
          <ActionLinkCard key={bKey++} label={cleanCtaLabel(cur)} url={nextUrl} onOpenUrl={onOpenUrl} />,
        );
        i += 2;
        continue;
      }
      const skipBlankUrl =
        cur.length <= 16 && i + 2 < lines.length && lines[i + 1].trim() === ""
          ? extractBracketedUrlLine(lines[i + 2])
          : null;
      if (skipBlankUrl) {
        blocks.push(
          <ActionLinkCard key={bKey++} label={cleanCtaLabel(cur)} url={skipBlankUrl} onOpenUrl={onOpenUrl} />,
        );
        i += 3;
        continue;
      }
    }

    // 3. 单行按钮动作链接（如 `[查看活动](https://...)` 或 `查看活动 <https://...>`）
    const singleCta = extractSingleLineCta(cur);
    if (singleCta) {
      blocks.push(
        <ActionLinkCard
          key={bKey++}
          label={singleCta.label}
          url={singleCta.url}
          onOpenUrl={onOpenUrl}
        />,
      );
      i += 1;
      continue;
    }

    // 4. 独立成行的裸链接或尖括号长链接
    const standaloneUrl = extractStandaloneBareUrl(cur);
    if (standaloneUrl) {
      blocks.push(<StandaloneUrlChip key={bKey++} url={standaloneUrl} onOpenUrl={onOpenUrl} />);
      i += 1;
      continue;
    }

    // 5. 连续竖线表格（如账单明细或通知属性表）
    if (splitPipeCells(cur) !== null && i + 1 < lines.length && splitPipeCells(lines[i + 1]) !== null) {
      const rawRows: string[][] = [];
      while (i < lines.length) {
        const cells = splitPipeCells(lines[i]);
        if (!cells) break;
        if (!isMarkdownTableSep(cells)) {
          rawRows.push(cells);
        }
        i += 1;
      }
      const filteredRows = rawRows.filter((cells) => cells.some((c) => c !== "") && !(cells.length === 2 && cells[1] === ""));
      if (filteredRows.length > 0) {
        blocks.push(
          <div key={bKey++} className="mail-table-wrap">
            <table className="mail-table">
              <tbody>
                {filteredRows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className={row.length === 2 && cIdx === 0 ? "mail-table-key" : undefined}>
                        {renderInlineTokens(cell, onOpenUrl, highlightQuery)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      continue;
    }

    // 6. 常规文本段落（保留段内自然换行）
    const paraLines: string[] = [lines[i].trimEnd()];
    i += 1;
    while (i < lines.length && !isSpecialLineAt(i)) {
      paraLines.push(lines[i].trimEnd());
      i += 1;
    }
    blocks.push(
      <p key={bKey++} className="mail-p">
        {paraLines.map((pl, idx) => (
          <span key={idx}>
            {idx > 0 && <br />}
            {renderInlineTokens(pl, onOpenUrl, highlightQuery)}
          </span>
        ))}
      </p>,
    );
  }

  return <>{blocks}</>;
}

function QuotedMailCard({
  quote,
  onOpenUrl,
  highlightQuery,
}: {
  quote: ParsedQuote;
  onOpenUrl: (e: MouseEvent, url: string) => void;
  highlightQuery?: string;
}) {
  const { meta, kind, body, nested } = quote;
  const senderLabel = meta.from || meta.attribution || (kind === "forward" ? "转发邮件" : "引用原邮件");
  const subParts: string[] = [];
  if (meta.subject) subParts.push(`主题：${meta.subject}`);
  if (meta.to) subParts.push(`收件人：${meta.to}`);
  if (meta.cc) subParts.push(`抄送：${meta.cc}`);

  return (
    <div className="mail-quote-card">
      <div className="mail-quote-head">
        <span className="mail-quote-badge">{kind === "forward" ? "转发" : "原邮件"}</span>
        <span className="mail-quote-sender">{senderLabel}</span>
        {meta.date && <span className="mail-quote-date">{meta.date}</span>}
      </div>
      {subParts.length > 0 && <div className="mail-quote-sub">{subParts.join(" · ")}</div>}
      {body && (
        <div className="mail-quote-body">
          <RichBlocks text={body} onOpenUrl={onOpenUrl} highlightQuery={highlightQuery} />
        </div>
      )}
      {nested && <QuotedMailCard quote={nested} onOpenUrl={onOpenUrl} highlightQuery={highlightQuery} />}
    </div>
  );
}

export function MessageContent({
  analyzed,
  expanded,
  status,
  highlightQuery,
}: {
  analyzed: AnalyzedMailBody;
  expanded: boolean;
  status: Status;
  highlightQuery?: string;
}) {
  const handleOpenUrl = (e: MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === "blocked") {
      const ok = window.confirm(
        `该邮件已被归入「拦截」列表，可能包含推广或可疑钓鱼链接。\n确定要在外部浏览器打开吗？\n\n${url}`,
      );
      if (!ok) return;
    }
    void api.openExternalUrl(url);
  };

  return (
    <div className="mail-rich">
      {analyzed.isPureQuote && analyzed.quote ? (
        <QuotedMailCard quote={analyzed.quote} onOpenUrl={handleOpenUrl} highlightQuery={highlightQuery} />
      ) : expanded && analyzed.replaceMainOnExpand && analyzed.extraRaw ? (
        <RichBlocks text={analyzed.extraRaw} onOpenUrl={handleOpenUrl} highlightQuery={highlightQuery} />
      ) : (
        <>
          <RichBlocks text={analyzed.main} onOpenUrl={handleOpenUrl} highlightQuery={highlightQuery} />
          {expanded && analyzed.quote && (
            <QuotedMailCard quote={analyzed.quote} onOpenUrl={handleOpenUrl} highlightQuery={highlightQuery} />
          )}
          {expanded && !analyzed.quote && analyzed.extraRaw && (
            <div className="mail-sig-block">
              <RichBlocks text={analyzed.extraRaw} onOpenUrl={handleOpenUrl} highlightQuery={highlightQuery} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
