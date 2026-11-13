import type { ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  const parts = text.split(tokenRe);
  const out: ReactNode[] = [];

  parts.forEach((part, idx) => {
    if (!part) return;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push(
        <code key={idx} className="md-code">
          {part.slice(1, -1)}
        </code>
      );
    } else if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      out.push(
        <strong key={idx} className="md-strong">
          {renderInline(part.slice(2, -2))}
        </strong>
      );
    } else {
      out.push(part);
    }
  });

  return out;
}

export function MarkdownText({ content, className = "" }: { content: string; className?: string }) {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;

  const lines = normalized.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let keySeq = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      i += 1;
      continue;
    }

    // 1. 围栏代码块 ```lang ... ```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <div key={keySeq++} className="md-codeblock">
          {lang && <div className="md-codeblock-lang">{lang}</div>}
          <pre className="md-pre">
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    // 2. 标题 # / ## / ###
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        <div key={keySeq++} className={`md-heading md-h${level}`}>
          {renderInline(headingMatch[2])}
        </div>
      );
      i += 1;
      continue;
    }

    // 3. 引用提示块 > ...
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={keySeq++} className="md-quote">
          {quoteLines.map((ql, idx) => (
            <div key={idx}>{renderInline(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // 4. 无序列表 - / * / •
    if (/^[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={keySeq++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx} className="md-li">
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 5. 有序列表 1. / 2.
    if (/^\d+[.)、]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)、]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)、]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={keySeq++} className="md-list md-ol">
          {items.map((item, idx) => (
            <li key={idx} className="md-li">
              {renderInline(item)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 6. 普通段落（合并连续普通文本行）
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith(">") &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^[-*•]\s+/.test(lines[i].trim()) &&
      !/^\d+[.)、]\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push(
      <p key={keySeq++} className="md-p">
        {paraLines.map((pl, idx) => (
          <span key={idx}>
            {idx > 0 && <br />}
            {renderInline(pl)}
          </span>
        ))}
      </p>
    );
  }

  return <div className={`md-body ${className}`.trim()}>{blocks}</div>;
}
