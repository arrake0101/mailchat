/**
 * 零外部依赖的轻量级声明式 TOML 解析器与序列化器
 * 专门覆盖 MailChat `plugin.toml` 与 `config.toml` (`[table]`、`[a.b]`、`[[plugins]]`、数组、内联表、多行数组/字符串)。
 * （注：真实接入客户端时，Rust 侧直接复用 Cargo.toml 已有的 `toml = "0.8"` + `serde` 强类型解析）
 */

export function parseToml(source) {
  if (typeof source !== "string") {
    throw new SyntaxError("TOML 输入必须是字符串");
  }

  const root = Object.create(null);
  let target = root;
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    let rawLine = lines[i];
    i += 1;

    const stripped = stripComment(rawLine).trim();
    if (!stripped) continue;

    // [[array_of_tables]]
    if (stripped.startsWith("[[") && stripped.endsWith("]]")) {
      const pathStr = stripped.slice(2, -2).trim();
      if (!pathStr) throw new SyntaxError(`第 ${i} 行：空的数组表头 [[]]`);
      const parts = splitKeyPath(pathStr);
      let cursor = root;
      for (let p = 0; p < parts.length - 1; p += 1) {
        const seg = parts[p];
        if (!(seg in cursor)) cursor[seg] = Object.create(null);
        cursor = Array.isArray(cursor[seg]) ? cursor[seg][cursor[seg].length - 1] : cursor[seg];
      }
      const last = parts[parts.length - 1];
      if (!(last in cursor)) {
        cursor[last] = [];
      } else if (!Array.isArray(cursor[last])) {
        throw new SyntaxError(`第 ${i} 行：键 "${pathStr}" 已定义为普通表，不能重复定义为数组表`);
      }
      const item = Object.create(null);
      cursor[last].push(item);
      target = item;
      continue;
    }

    // [table] or [table.subtable]
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const pathStr = stripped.slice(1, -1).trim();
      if (!pathStr) throw new SyntaxError(`第 ${i} 行：空的表头 []`);
      const parts = splitKeyPath(pathStr);
      let cursor = root;
      for (const seg of parts) {
        if (!(seg in cursor)) {
          cursor[seg] = Object.create(null);
        } else if (Array.isArray(cursor[seg])) {
          cursor = cursor[seg][cursor[seg].length - 1];
          continue;
        } else if (typeof cursor[seg] !== "object" || cursor[seg] === null) {
          throw new SyntaxError(`第 ${i} 行：键 "${seg}" 已被标量占用`);
        }
        cursor = cursor[seg];
      }
      target = cursor;
      continue;
    }

    // key = value (support multi-line arrays and triple-quoted strings)
    const eqIdx = findAssignmentEquals(stripped);
    if (eqIdx === -1) {
      throw new SyntaxError(`第 ${i} 行：无法识别的 TOML 语法：${stripped}`);
    }

    const rawKey = stripped.slice(0, eqIdx).trim();
    let rawVal = stripped.slice(eqIdx + 1).trim();
    const startLine = i;

    if (rawVal.startsWith('"""') && !hasClosingTriple(rawVal, '"""')) {
      let buf = rawLine.slice(rawLine.indexOf("=") + 1).trimStart();
      while (i < lines.length) {
        const nextLine = lines[i];
        i += 1;
        buf += "\n" + nextLine;
        if (hasClosingTriple(buf, '"""')) break;
      }
      rawVal = buf.trim();
    } else if (rawVal.startsWith("'''") && !hasClosingTriple(rawVal, "'''")) {
      let buf = rawLine.slice(rawLine.indexOf("=") + 1).trimStart();
      while (i < lines.length) {
        const nextLine = lines[i];
        i += 1;
        buf += "\n" + nextLine;
        if (hasClosingTriple(buf, "'''")) break;
      }
      rawVal = buf.trim();
    } else if (rawVal.startsWith("[") && !isBalancedBrackets(rawVal)) {
      let buf = rawVal;
      while (i < lines.length && !isBalancedBrackets(buf)) {
        buf += " " + stripComment(lines[i]).trim();
        i += 1;
      }
      if (!isBalancedBrackets(buf)) {
        throw new SyntaxError(`第 ${startLine} 行：数组括号未闭合`);
      }
      rawVal = buf;
    }

    const keyParts = splitKeyPath(rawKey);
    let cursor = target;
    for (let k = 0; k < keyParts.length - 1; k += 1) {
      const seg = keyParts[k];
      if (!(seg in cursor)) cursor[seg] = Object.create(null);
      cursor = cursor[seg];
    }
    const leafKey = keyParts[keyParts.length - 1];
    cursor[leafKey] = parseValue(rawVal, startLine);
  }

  return toPlainObject(root);
}

function toPlainObject(val) {
  if (Array.isArray(val)) return val.map(toPlainObject);
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = toPlainObject(v);
    }
    return out;
  }
  return val;
}

function hasClosingTriple(str, delim) {
  if (str.length < 6) return false;
  return str.indexOf(delim, 3) !== -1;
}

function stripComment(line) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === "#" && !inDouble && !inSingle) {
      return line.slice(0, i);
    }
  }
  return line;
}

function findAssignmentEquals(line) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "=" && !inDouble && !inSingle) return i;
  }
  return -1;
}

function splitKeyPath(keyStr) {
  const parts = [];
  let cur = "";
  let inQuote = null;
  for (let i = 0; i < keyStr.length; i += 1) {
    const ch = keyStr[i];
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = ch;
    } else if (ch === inQuote) {
      inQuote = null;
    } else if (ch === "." && !inQuote) {
      if (!cur.trim()) throw new SyntaxError(`非法键路径 "${keyStr}"`);
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (!cur.trim()) throw new SyntaxError(`非法键路径 "${keyStr}"`);
  parts.push(cur.trim());
  return parts;
}

function isBalancedBrackets(str) {
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '"' && !inSingle && str[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") depth -= 1;
    }
  }
  return depth === 0;
}

function parseValue(raw, lineNo) {
  const s = raw.trim();
  if (!s) throw new SyntaxError(`第 ${lineNo} 行：缺少赋值内容`);

  if (s.startsWith('"""') && s.endsWith('"""') && s.length >= 6) {
    let body = s.slice(3, -3);
    if (body.startsWith("\n")) body = body.slice(1);
    return unescapeDoubleQuoted(body);
  }
  if (s.startsWith("'''") && s.endsWith("'''") && s.length >= 6) {
    let body = s.slice(3, -3);
    if (body.startsWith("\n")) body = body.slice(1);
    return body;
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;

  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelItems(inner).map((item) => parseValue(item, lineNo));
  }

  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitTopLevelItems(inner)) {
      const idx = findAssignmentEquals(pair);
      if (idx === -1) throw new SyntaxError(`第 ${lineNo} 行：内联表项缺少 '='：${pair}`);
      const k = pair.slice(0, idx).trim().replace(/^["']|["']$/g, "");
      const v = pair.slice(idx + 1).trim();
      obj[k] = parseValue(v, lineNo);
    }
    return obj;
  }

  const normalizedNum = s.replace(/_/g, "");
  if (/^[+-]?\d+(\.\d+)?$/.test(normalizedNum)) {
    return Number(normalizedNum);
  }

  throw new SyntaxError(`第 ${lineNo} 行：无法解析的 TOML 值：${s}`);
}

function splitTopLevelItems(inner) {
  const items = [];
  let cur = "";
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '"' && !inSingle && inner[i - 1] !== "\\") {
      inDouble = !inDouble;
      cur += ch;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
    } else if (!inDouble && !inSingle) {
      if (ch === "[" || ch === "{") {
        depth += 1;
        cur += ch;
      } else if (ch === "]" || ch === "}") {
        depth -= 1;
        cur += ch;
      } else if (ch === "," && depth === 0) {
        if (cur.trim()) items.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function unescapeDoubleQuoted(str) {
  return str.replace(/\\([btnfr"\\]|u[0-9a-fA-F]{4})/g, (_, seq) => {
    switch (seq[0]) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u":
        return String.fromCharCode(parseInt(seq.slice(1), 16));
      default:
        return seq;
    }
  });
}
