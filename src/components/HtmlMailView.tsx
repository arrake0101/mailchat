import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Status } from "../types";

const QUOTE_CONTAINER_SELECTORS = [
  ".gmail_quote",
  ".gmail_attr",
  ".gmail_signature",
  "#isReplyContent",
  "#isForwardContent",
  "#divNeteaseMailCard",
  '[id^="divNetease"]',
  ".qqmail_quote",
  ".qqmail_sign",
  "#divRplyFwdMsg",
  "#appendonsend",
  "#Signature",
  '[id^="ms-outlook-mobile-signature"]',
  ".yahoo_quoted",
  ".moz-cite-prefix",
  ".AppleMailSignature",
  "blockquote",
].join(",");

const QUOTE_DIVIDER_LINE_RE =
  /^(?:-{2,}\s*(?:Original Message|Original|原始邮件|原邮件|回复的原邮件|回复邮件|Replied Message|Reply Message|Forwarded message|转发邮件|转发的邮件|转发的原邮件|已转发邮件)\s*-{2,}|Begin forwarded message:|下面是被转发的邮件[：:]|以下是转发的邮件[：:]|On\s+.+\bwrote:|在\s*.+写道[：:]|.+于\s*20\d{2}.+写道[：:]|发自我的\s*(?:iPhone|iPad|Mac|华为|小米|荣耀|OPPO|vivo|手机|Android)|Sent from my (?:iPhone|iPad|Mac|Galaxy|Android|Phone)|发自网易邮箱大师|签名由\s*网易邮箱大师\s*定制)/i;

const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "base",
  "meta",
  "link",
  "title",
  "noscript",
  "template",
  "audio",
  "video",
  "source",
  "portal",
  "basefont",
  "bgsound",
].join(",");

const RICH_HTML_CACHE = new Map<string, boolean>();

function cacheKeyForHtml(html: string): string {
  if (html.length <= 4096) return html;
  return `${html.length}:${html.slice(0, 1024)}:${html.slice(-1024)}`;
}

export function hasHtmlBody(bodyHtml?: string | null): boolean {
  return Boolean(bodyHtml && bodyHtml.trim().length > 0);
}

function isTrackingPixelImg(img: Element): boolean {
  const wAttr = (img.getAttribute("width") || "").trim();
  const hAttr = (img.getAttribute("height") || "").trim();
  const style = (img.getAttribute("style") || "").toLowerCase();
  if ((wAttr === "1" || wAttr === "0") && (hAttr === "1" || hAttr === "0")) {
    return true;
  }
  if (wAttr === "1" || hAttr === "1" || wAttr === "0" || hAttr === "0") {
    if (/(?:^|;)\s*(?:width|height)\s*:\s*[01](?:px)?\b/.test(style) || wAttr === hAttr) {
      return true;
    }
  }
  if (
    /display\s*:\s*none/.test(style) ||
    /visibility\s*:\s*hidden/.test(style) ||
    (/width\s*:\s*[01]px/.test(style) && /height\s*:\s*[01]px/.test(style))
  ) {
    return true;
  }
  return false;
}

function isQuoteHeaderTable(table: HTMLTableElement): boolean {
  const rows = Array.from(table.rows);
  if (rows.length < 2 || rows.length > 8) return false;
  const k0 = (rows[0]?.cells?.[0]?.textContent || "").replace(/[*：\s:]/g, "").toLowerCase();
  const k1 = (rows[1]?.cells?.[0]?.textContent || "").replace(/[*：\s:]/g, "").toLowerCase();
  const firstKeys = new Set(["发件人", "from", "sender"]);
  const secondKeys = new Set(["日期", "时间", "发送时间", "收件人", "date", "sent", "to"]);
  return firstKeys.has(k0) && secondKeys.has(k1);
}

function stripQuotedDomNodes(root: HTMLElement): void {
  root.querySelectorAll(QUOTE_CONTAINER_SELECTORS).forEach((el) => el.remove());

  const doc = root.ownerDocument;
  if (doc) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const dividerTextNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      const txt = (current.nodeValue || "").trim();
      if (txt && txt.length <= 200) {
        const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.some((line) => QUOTE_DIVIDER_LINE_RE.test(line))) {
          dividerTextNodes.push(current as Text);
        }
      }
      current = walker.nextNode();
    }

    for (const textNode of dividerTextNodes) {
      if (!textNode.isConnected) continue;
      const parent = textNode.parentElement;
      if (!parent) continue;
      // 如果父元素本身仅承载该分隔行（如 <p>---- 回复的原邮件 ----</p>），连同父元素后续兄弟节点一并剥离
      const parentOwnLen = (parent.textContent || "").trim().length;
      const anchor: ChildNode =
        parent !== root && parentOwnLen <= 220 ? parent : textNode;
      let next = anchor.nextSibling;
      while (next) {
        const toRemove = next;
        next = next.nextSibling;
        toRemove.remove();
      }
      anchor.remove();
    }
  }

  root.querySelectorAll("table").forEach((t) => {
    if (isQuoteHeaderTable(t)) {
      t.remove();
    }
  });
}

/**
 * 判断一封邮件是否属于“富排版/卡片/模板型 HTML 邮件”（如 Google 安全通知、电子账单、系统卡片、周刊等），
 * 排除普通人在网页/客户端回复的一两句纯聊天邮件（即便其引用块里带有表格），避免普通对话气泡退化成笨重网页框。
 */
export function isRichHtmlEmail(bodyHtml: string | undefined, outgoing: boolean): boolean {
  if (outgoing || !hasHtmlBody(bodyHtml)) return false;
  const raw = bodyHtml!;
  const key = cacheKeyForHtml(raw);
  const cached = RICH_HTML_CACHE.get(key);
  if (cached !== undefined) return cached;

  let rich = false;
  try {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    doc.querySelectorAll("script, style, head, meta, link, title, noscript").forEach((n) => n.remove());
    const body = doc.body;
    if (body) {
      stripQuotedDomNodes(body);

      // 1. 主体（剥离历史引用后）包含有效内容表格（绝大多数通知/账单/安全提醒模板均采用表格或卡片排版）
      const tables = Array.from(body.querySelectorAll("table"));
      const hasMeaningfulTable = tables.some((t) => {
        if ((t.textContent || "").trim().length > 0) return true;
        return Array.from(t.querySelectorAll("img")).some((img) => !isTrackingPixelImg(img));
      });

      // 2. 包含带背景色或按钮边框内边距的 CTA 动作按钮链接（如 Google 安全提醒的蓝色「查看活动」按钮）
      const hasStyledCta = Array.from(body.querySelectorAll("a[href], button")).some((el) => {
        const st = (el.getAttribute("style") || "").toLowerCase();
        const bgAttr = (el.getAttribute("bgcolor") || "").trim();
        if (bgAttr && bgAttr.toLowerCase() !== "transparent" && bgAttr !== "#ffffff" && bgAttr !== "white") {
          return true;
        }
        if (/background(?:-color)?\s*:\s*(?!transparent|none|inherit|initial|#fff(?:fff)?\b|white\b)[^;]+/.test(st)) {
          return true;
        }
        return /padding\s*:/.test(st) && /(?:border-radius|border)\s*:/.test(st);
      });

      // 3. 包含非 1x1 追踪像素的可见品牌 Logo / 插图（含已内联为 data:image 的 cid 图片）
      const hasVisibleImage = Array.from(body.querySelectorAll("img")).some((img) => {
        if (isTrackingPixelImg(img)) return false;
        const src = (img.getAttribute("src") || "").trim().toLowerCase();
        return src.startsWith("https://") || src.startsWith("http://") || src.startsWith("data:image/");
      });

      // 4. 包含明确的卡片容器 + 标题/分隔线排版结构
      const hasHeadingOrRule = Boolean(body.querySelector("h1, h2, h3, hr"));
      const styledContainers = Array.from(body.querySelectorAll("div, section, article")).filter((el) => {
        const st = (el.getAttribute("style") || "").toLowerCase();
        return (
          /border(?:-style|-width|-color|-radius)?\s*:/.test(st) ||
          /max-width\s*:/.test(st) ||
          /box-shadow\s*:/.test(st)
        );
      });

      rich =
        hasMeaningfulTable ||
        hasStyledCta ||
        hasVisibleImage ||
        (hasHeadingOrRule && styledContainers.length >= 1) ||
        styledContainers.length >= 2;
    }
  } catch {
    rich = false;
  }

  if (RICH_HTML_CACHE.size >= 300) {
    const oldest = RICH_HTML_CACHE.keys().next().value;
    if (oldest !== undefined) RICH_HTML_CACHE.delete(oldest);
  }
  RICH_HTML_CACHE.set(key, rich);
  return rich;
}

function sanitizeCssText(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*['"]?\s*(?:javascript|vbscript|data:text\/html):[^)]*\)/gi, "none");
}

function stripExternalCssUrls(css: string): string {
  return css.replace(/url\s*\(\s*['"]?\s*https?:\/\/[^)]*\)/gi, "none");
}

function isSafeLinkHref(rawHref: string): boolean {
  const cleaned = rawHref.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  if (!cleaned) return false;
  if (cleaned.startsWith("#")) return true;
  return (
    cleaned.startsWith("https://") ||
    cleaned.startsWith("http://") ||
    cleaned.startsWith("mailto:")
  );
}

export function sanitizeHtmlForSrcDoc(
  rawHtml: string,
  allowRemoteImages: boolean,
): { srcDoc: string; blockedImages: number } {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");

  // 提取内联 <style>，移除外部资源导入与潜在表达式后注入隔离文档头部
  const collectedStyles: string[] = [];
  doc.querySelectorAll("style").forEach((styleEl) => {
    const rawCss = styleEl.textContent || "";
    if (rawCss.trim()) {
      const cleaned = sanitizeCssText(rawCss);
      collectedStyles.push(allowRemoteImages ? cleaned : stripExternalCssUrls(cleaned));
    }
    styleEl.remove();
  });

  doc.querySelectorAll(FORBIDDEN_TAGS).forEach((el) => el.remove());

  // 将视觉型 <button> 转为无表单行为的 <span>，保留原有按钮外观样式
  doc.querySelectorAll("button").forEach((btn) => {
    const span = doc.createElement("span");
    const st = btn.getAttribute("style");
    const cls = btn.getAttribute("class");
    if (st) span.setAttribute("style", `display:inline-block;${st}`);
    if (cls) span.setAttribute("class", cls);
    while (btn.firstChild) {
      span.appendChild(btn.firstChild);
    }
    btn.replaceWith(span);
  });

  let blockedImages = 0;
  const body = doc.body;
  const allElements = body ? Array.from(body.querySelectorAll("*")) : [];

  for (const el of allElements) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "ping") {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        let nextStyle = sanitizeCssText(attr.value);
        if (!allowRemoteImages && /url\s*\(\s*['"]?\s*https?:\/\//i.test(nextStyle)) {
          blockedImages += 1;
          nextStyle = stripExternalCssUrls(nextStyle);
        }
        el.setAttribute("style", nextStyle);
      }
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      const href = el.getAttribute("href");
      if (!href || !isSafeLinkHref(href)) {
        el.removeAttribute("href");
      } else {
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("target", "_blank");
      }
    } else if (tag === "img") {
      const src = (el.getAttribute("src") || "").trim();
      const lower = src.toLowerCase();
      if (!src || lower.startsWith("cid:")) {
        // 未匹配到附件的孤立 cid 引用直接隐藏，避免出现裂图图标
        el.remove();
        continue;
      }
      if (!allowRemoteImages && isTrackingPixelImg(el)) {
        el.remove();
        continue;
      }
      if (lower.startsWith("data:image/")) {
        el.setAttribute("decoding", "async");
      } else if (lower.startsWith("https://") || lower.startsWith("http://")) {
        if (!allowRemoteImages) {
          blockedImages += 1;
          el.removeAttribute("src");
          el.removeAttribute("srcset");
          el.setAttribute("style", `${el.getAttribute("style") || ""};display:none !important;`);
        } else {
          el.setAttribute("referrerpolicy", "no-referrer");
          el.setAttribute("decoding", "async");
        }
      } else {
        el.remove();
        continue;
      }

      if (!allowRemoteImages && el.hasAttribute("srcset")) {
        el.removeAttribute("srcset");
      }
    }

    if (el.hasAttribute("background")) {
      const bg = (el.getAttribute("background") || "").trim().toLowerCase();
      if (bg.startsWith("cid:") || (!allowRemoteImages && bg.startsWith("http"))) {
        if (!allowRemoteImages && bg.startsWith("http")) blockedImages += 1;
        el.removeAttribute("background");
      }
    }
  }

  // 保留原邮件 <body> 上的背景色或内联字体排版属性到内层根容器
  let rootAttrs = "";
  if (body) {
    const bgColor = body.getAttribute("bgcolor");
    const rawBodyStyle = body.getAttribute("style") || "";
    const safeBodyStyle = allowRemoteImages
      ? sanitizeCssText(rawBodyStyle)
      : stripExternalCssUrls(sanitizeCssText(rawBodyStyle));
    const cls = body.getAttribute("class");
    if (bgColor && /^[#a-zA-Z0-9(),.\s%-]{1,32}$/.test(bgColor)) {
      rootAttrs += ` bgcolor="${bgColor.replace(/"/g, "")}"`;
    }
    if (cls) {
      rootAttrs += ` class="mc-email-root ${cls.replace(/"/g, "")}"`;
    } else {
      rootAttrs += ` class="mc-email-root"`;
    }
    if (safeBodyStyle.trim()) {
      rootAttrs += ` style="${safeBodyStyle.replace(/"/g, "'")}"`;
    }
  } else {
    rootAttrs = ` class="mc-email-root"`;
  }

  const innerHtml = body ? body.innerHTML : "";
  const baseCss = `
:root { color-scheme: light; }
html, body {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent;
  color: #18181b;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.58;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
  overflow-y: hidden;
  word-break: break-word;
}
#mc-mail-stage {
  width: 100%;
  box-sizing: border-box;
}
.mc-email-root {
  box-sizing: border-box;
  width: 100%;
}
.mc-email-root > *:first-child { margin-top: 0; }
.mc-email-root > *:last-child { margin-bottom: 0; }
img:not([width]) { max-width: 100%; height: auto; }
a[href] { cursor: pointer; }
pre { white-space: pre-wrap; word-break: break-word; }
`;

  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss}\n${collectedStyles.join(
    "\n",
  )}</style></head><body><div id="mc-mail-stage"><div${rootAttrs}>${innerHtml}</div></div></body></html>`;

  return { srcDoc, blockedImages };
}

interface HtmlMailViewProps {
  html: string;
  status: Status;
}

export function HtmlMailView({ html, status }: HtmlMailViewProps) {
  const [allowRemoteImages, setAllowRemoteImages] = useState(status !== "blocked");
  const [height, setHeight] = useState(96);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setAllowRemoteImages(status !== "blocked");
  }, [status, html]);

  const { srcDoc, blockedImages } = useMemo(
    () => sanitizeHtmlForSrcDoc(html, allowRemoteImages),
    [html, allowRemoteImages],
  );

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [srcDoc]);

  const handleLoad = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc || !doc.body || !doc.documentElement) return;

    const stage = doc.getElementById("mc-mail-stage") as HTMLElement | null;
    let rafId = 0;

    const measure = () => {
      if (!iframe.isConnected || !doc.body || !doc.documentElement) return;
      const target = stage || doc.body;
      target.style.zoom = "1";
      doc.documentElement.style.overflowX = "hidden";

      const availW = iframe.clientWidth;
      const naturalW = Math.max(target.scrollWidth, doc.documentElement.scrollWidth);

      if (availW > 0 && naturalW > availW + 6) {
        const ratio = availW / naturalW;
        if (ratio >= 0.72) {
          target.style.zoom = ratio.toFixed(4);
        } else {
          target.style.zoom = "0.72";
          doc.documentElement.style.overflowX = "auto";
        }
      }

      const rectH = target.getBoundingClientRect().height;
      const scrollH = doc.documentElement.scrollHeight;
      const nextH = Math.max(36, Math.ceil(Math.max(rectH, scrollH)));
      setHeight((prev) => (Math.abs(prev - nextH) >= 1 ? nextH : prev));
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(measure);
    };

    measure();
    const t1 = window.setTimeout(scheduleMeasure, 60);
    const t2 = window.setTimeout(scheduleMeasure, 260);

    const onClick = (e: MouseEvent) => {
      const targetEl = e.target as Element | null;
      const anchor = targetEl?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();

      const rawHref = (anchor.getAttribute("href") || "").trim();
      if (!rawHref || rawHref.startsWith("#")) return;
      if (!isSafeLinkHref(rawHref)) return;

      if (status === "blocked") {
        const ok = window.confirm(
          `该邮件位于「拦截」列表，确定要在外部浏览器中打开此链接吗？\n\n${rawHref}`,
        );
        if (!ok) return;
      }
      void api.openExternalUrl(rawHref);
    };

    doc.addEventListener("click", onClick, true);

    const imgs = Array.from(doc.images);
    for (const img of imgs) {
      img.addEventListener("load", scheduleMeasure);
      img.addEventListener("error", scheduleMeasure);
    }

    let innerRo: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      innerRo = new ResizeObserver(scheduleMeasure);
      if (stage) innerRo.observe(stage);
      innerRo.observe(doc.body);
      innerRo.observe(iframe);
    }

    cleanupRef.current = () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      doc.removeEventListener("click", onClick, true);
      for (const img of imgs) {
        img.removeEventListener("load", scheduleMeasure);
        img.removeEventListener("error", scheduleMeasure);
      }
      innerRo?.disconnect();
    };
  }, [status]);

  return (
    <div className="html-mail-surface">
      {!allowRemoteImages && blockedImages > 0 && (
        <div className="html-mail-img-guard">
          <span>已拦截 {blockedImages} 处外部图片以保护隐私</span>
          <button
            type="button"
            className="html-mail-img-btn"
            onClick={() => setAllowRemoteImages(true)}
          >
            显示图片
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        title="HTML 邮件内容"
        scrolling="no"
        className="html-mail-iframe"
        style={{ height: `${height}px` }}
        onLoad={handleLoad}
      />
    </div>
  );
}
