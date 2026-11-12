// Minimal YAML-like frontmatter: scalars, inline lists [a, b], block lists (- a). Enough for brain records (P-031).

export function parseFrontmatter(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src, hasFrontmatter: false };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: src, hasFrontmatter: false };
  const block = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n/, '');
  const data = {};
  let currentList = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem && currentList) {
      data[currentList].push(unquote(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-À-ɏ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === '') {
      data[key] = [];
      currentList = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter((v) => v !== '');
      currentList = null;
    } else {
      data[key] = coerce(unquote(value));
      currentList = null;
    }
  }
  return { data, body, hasFrontmatter: true };
}

function unquote(v) {
  // A double-quoted value is what quoteIfNeeded wrote (JSON.stringify): parse it back, else every save escaped its quotes
  // and backslashes once more (a skill description grew to 30 backslashes and over the length limit, 2026-11-12).
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function quoteIfNeeded(v) {
  const s = String(v);
  if (s === '' || /[:#\[\]{}",'\n]|^\s|\s$|^-/.test(s) || s === 'true' || s === 'false') {
    return JSON.stringify(s);
  }
  return s;
}

export function serializeFrontmatter(data, body = '') {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(quoteIfNeeded).join(', ')}]`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n' + (body ? body.replace(/\s*$/, '') + '\n' : '');
}

export function asList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
