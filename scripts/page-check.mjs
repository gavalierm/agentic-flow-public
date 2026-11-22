// Readability of a page shown to the operator (P-077; operator 2026-11-22: "diagramy musia byť WCAG, toto neviem
// prečítať": a network diagram with 11.5 px labels in a 960 wide drawing, a grey label at 2.5 : 1 and an orange one at
// 3.9 : 1). The skill said "contrast at least WCAG AA"; nothing measured it. This reads the page as a browser would
// (the cascade of its own CSS, light and dark) and measures:
//   - text against the background it lies on: 4.5 : 1, large text 3 : 1 (WCAG 1.4.3),
//   - a line of a diagram (1.5 px or wider, or with an arrow; a hairline of a grid is decoration) against its
//     background: 3 : 1 (WCAG 1.4.11),
//   - the size of text: 12 px in the page, 11 px in a drawing at the width of a page column.
// What it cannot resolve (an image behind text, a colour function it does not know, a rotated group) is not judged:
// a problem it reports is one it measured.
const TEXT_AA = 4.5;
const LARGE_AA = 3;
const LINE_AA = 3;
const MIN_PX = 12;
const MIN_SVG_PX = 11;
// The width a drawing gets in a page column (the thread pane, a phone in landscape): text in a wider viewBox shrinks.
const COLUMN_PX = 720;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const AUTO_CLOSE = new Set(['li', 'p', 'td', 'th', 'tr', 'option', 'dt', 'dd']);
const HIDDEN_TAGS = new Set(['head', 'script', 'style', 'template', 'title', 'defs', 'marker', 'clippath', 'mask', 'symbol', 'pattern', 'lineargradient', 'radialgradient', 'noscript', 'foreignobject']);
const HEADING_EM = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67, small: 0.83, sub: 0.83, sup: 0.83 };
const BOLD_TAGS = new Set(['b', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th']);
const INHERITED = ['color', 'fill', 'stroke', 'font-size', 'font-weight', 'visibility'];
const NAMED = { black: '#000', white: '#fff', red: '#f00', green: '#008000', blue: '#00f', gray: '#808080', grey: '#808080', silver: '#c0c0c0', yellow: '#ff0', orange: '#ffa500', purple: '#800080', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', lime: '#0f0', aqua: '#0ff', cyan: '#0ff', fuchsia: '#f0f', magenta: '#f0f', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', crimson: '#dc143c', gold: '#ffd700', tomato: '#ff6347', pink: '#ffc0cb', brown: '#a52a2a', indigo: '#4b0082', violet: '#ee82ee', steelblue: '#4682b4', slategray: '#708090', slategrey: '#708090' };

// ---------- colours

/** A CSS colour as { r, g, b, a } (0-255, alpha 0-1), 'none' for no paint, or null when the form is not known here. */
export function parseColor(text) {
  const v = String(text || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'transparent' || v === 'none') return 'none';
  const hex = /^#([0-9a-f]{3,8})$/.exec(NAMED[v] || v)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length < 6 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.some((p) => !/^-?[\d.]+(%|deg)?$/.test(p))) return null;
  const num = (p, scale) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const a = parts[3] === undefined ? 1 : Math.max(0, Math.min(1, num(parts[3], 1)));
  if (fn[1].startsWith('rgb')) return { r: num(parts[0], 255), g: num(parts[1], 255), b: num(parts[2], 255), a };
  const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => { const x = ((t % 1) + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a };
}

const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
const luminance = (c) => [c.r, c.g, c.b].map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
/** WCAG contrast ratio of two opaque colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexOf = (c) => `#${[c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;

// ---------- the page

function parseHtml(html) {
  const root = { tag: 'html', attrs: {}, classes: new Set(), children: [], parent: null };
  let body = null;
  let cur = root;
  const styles = [];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;
  let m;
  while ((m = token.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let el = cur; el; el = el.parent) if (el.tag === tag && el !== root) { cur = el.parent; break; }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
      if (tag === 'html') { Object.assign(root.attrs, attrs); continue; }
      if (AUTO_CLOSE.has(tag) && cur.tag === tag) cur = cur.parent;
      if (tag === 'body' && body) { Object.assign(body.attrs, attrs); cur = body; continue; }
      const el = { tag, attrs, classes: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)), children: [], parent: cur };
      if (tag === 'body') body = el;
      cur.children.push(el);
      if (RAW.has(tag)) {
        const end = new RegExp(`</${tag}\\s*>`, 'i').exec(html.slice(token.lastIndex));
        const text = end ? html.slice(token.lastIndex, token.lastIndex + end.index) : html.slice(token.lastIndex);
        if (tag === 'style') styles.push(text);
        token.lastIndex += end ? end.index + end[0].length : text.length;
      } else if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) cur = el;
    } else if (m[0][0] !== '<' && m[0].trim()) cur.children.push(m[0]);
  }
  return { root, styles };
}

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === sep && !depth) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseDecls(text) {
  const out = [];
  for (const part of splitTop(text, ';')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const important = /!\s*important\s*$/i.test(part);
    out.push({ name: part.slice(0, i).trim().toLowerCase(), value: part.slice(i + 1).replace(/!\s*important\s*$/i, '').trim(), important });
  }
  return out;
}

function parseCss(text, rules, media = 'all') {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    for (; close < text.length && depth; close++) { if (text[close] === '{') depth += 1; else if (text[close] === '}') depth -= 1; }
    const prelude = text.slice(i, open).replace(/@[^;{]*;/g, '').trim();
    const body = text.slice(open + 1, close - 1);
    if (prelude.startsWith('@')) {
      const scheme = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(prelude)?.[1]?.toLowerCase();
      if (/^@media/i.test(prelude)) parseCss(body, rules, /\bprint\b/i.test(prelude) ? 'none' : scheme || media);
      else if (/^@(supports|layer|container)/i.test(prelude)) parseCss(body, rules, media);
    } else {
      const decls = parseDecls(body);
      for (const sel of splitTop(prelude, ',')) { const compiled = compileSelector(sel); if (compiled) rules.push({ ...compiled, decls, media, order: rules.length }); }
    }
    i = close;
  }
}

/** A selector as compounds from left to right, or null when it uses a form that is not followed here (the rule is left out). */
function compileSelector(text) {
  const parts = [];
  let pseudoEl = null;
  let spec = 0;
  let comb = ' ';
  let i = 0;
  const sel = text.trim();
  const compound = () => ({ comb, tag: null, id: null, classes: [], attrs: [], nots: [], root: false });
  let cur = compound();
  let empty = true;
  const push = () => { if (!empty) { parts.push(cur); comb = ' '; cur = compound(); cur.comb = ' '; empty = true; } };
  while (i < sel.length) {
    const c = sel[i];
    if (/\s/.test(c)) { push(); i += 1; continue; }
    if (c === '>') { push(); comb = '>'; cur.comb = '>'; i += 1; continue; }
    if (c === '+' || c === '~' || c === '&') return null;
    cur.comb = comb;
    const word = /^[\w-]+/.exec(sel.slice(i + 1))?.[0] || '';
    if (c === '*') { empty = false; i += 1; }
    else if (c === '.') { cur.classes.push(word); spec += 10; empty = false; i += 1 + word.length; }
    else if (c === '#') { cur.id = word; spec += 100; empty = false; i += 1 + word.length; }
    else if (c === '[') {
      const end = sel.indexOf(']', i);
      const a = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?/.exec(sel.slice(i + 1, end));
      if (end < 0 || !a) return null;
      cur.attrs.push({ name: a[1].toLowerCase(), op: a[2] || null, value: a[3] ?? a[4] ?? a[5] ?? '' });
      spec += 10; empty = false; i = end + 1;
    } else if (c === ':') {
      const double = sel[i + 1] === ':';
      const name = /^[\w-]+/.exec(sel.slice(i + (double ? 2 : 1)))?.[0]?.toLowerCase() || '';
      let j = i + (double ? 2 : 1) + name.length;
      let arg = null;
      if (sel[j] === '(') {
        let depth = 1;
        const from = j + 1;
        for (j += 1; j < sel.length && depth; j++) { if (sel[j] === '(') depth += 1; else if (sel[j] === ')') depth -= 1; }
        arg = sel.slice(from, j - 1);
      }
      if (double || name === 'before' || name === 'after') { if (name !== 'before' && name !== 'after') return null; pseudoEl = name; spec += 1; }
      else if (name === 'root') { cur.root = true; spec += 10; }
      else if (name === 'not') { const inner = compileSelector(arg || ''); if (!inner || inner.parts.length !== 1 || inner.pseudoEl) return null; cur.nots.push(inner.parts[0]); spec += inner.spec; }
      // What a row holds is not followed: for the text a rule adds (::after) it counts as holding.
      else if (name === 'has') { cur.has = true; spec += 10; }
      else return null;
      empty = false; i = j;
    } else if (/[a-zA-Z]/.test(c)) { const tag = /^[\w-]+/.exec(sel.slice(i))[0]; cur.tag = tag.toLowerCase(); spec += 1; empty = false; i += tag.length; }
    else return null;
  }
  push();
  if (!parts.length) return null;
  if (!pseudoEl && parts.some((p) => p.has)) return null;
  return { parts, pseudoEl, spec };
}

const matchCompound = (el, c, root) => {
  if (!el || typeof el === 'string') return false;
  if (c.root && el !== root) return false;
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.some((k) => !el.classes.has(k))) return false;
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '|=' && v !== a.value && !v.startsWith(`${a.value}-`)) return false;
  }
  return !c.nots.some((n) => matchCompound(el, n, root));
};

function matches(el, parts, root, at = parts.length - 1) {
  if (!matchCompound(el, parts[at], root)) return false;
  if (!at) return true;
  if (parts[at].comb === '>') return matches(el.parent, parts, root, at - 1);
  for (let up = el.parent; up; up = up.parent) if (matches(up, parts, root, at - 1)) return true;
  return false;
}

// ---------- the cascade

function resolveVars(value, vars, depth = 0) {
  if (!value.includes('var(') || depth > 8) return value;
  let out = '';
  let i = 0;
  for (;;) {
    const at = value.indexOf('var(', i);
    if (at < 0) return out + value.slice(i);
    let d = 1;
    let j = at + 4;
    for (; j < value.length && d; j++) { if (value[j] === '(') d += 1; else if (value[j] === ')') d -= 1; }
    const [name, ...rest] = splitTop(value.slice(at + 4, j - 1), ',');
    const got = vars[name] ?? (rest.length ? rest.join(',') : '');
    out += value.slice(i, at) + resolveVars(got, vars, depth + 1);
    i = j;
  }
}

/** Colours of a background value: [] none, null not known (an image, an unknown function), else the list (a gradient has several). */
function backgroundColors(value) {
  const v = value.trim();
  if (!v || /^(none|transparent|initial|unset)$/i.test(v)) return [];
  if (/url\(|image\(|element\(/i.test(v)) return null;
  const found = v.match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|\b[a-z]+\b/gi) || [];
  const colors = [];
  for (const word of found) {
    const c = parseColor(word);
    if (c && c !== 'none') colors.push(c);
    else if (c === null && /^(color-mix|oklch|oklab|lab|lch|light-dark|color)$/i.test(word)) return null;
  }
  return colors;
}

function fontSize(value, parent, rootSize) {
  const v = value.trim().toLowerCase();
  const clamp = /^(?:clamp|min|max)\(([^,]+)/.exec(v);
  if (clamp) return fontSize(clamp[1], parent, rootSize);
  const n = /^([\d.]+)(px|rem|em|%|pt)?$/.exec(v);
  if (n) return { px: parseFloat(n[1]), rem: parseFloat(n[1]) * rootSize, em: parseFloat(n[1]) * parent, '%': (parseFloat(n[1]) / 100) * parent, pt: parseFloat(n[1]) * 4 / 3 }[n[2] || 'px'];
  return { small: 13, 'x-small': 10, 'xx-small': 9, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, smaller: parent * 0.83, larger: parent * 1.2 }[v] ?? null;
}

function styleTree(root, rules, theme, dark, metaScheme) {
  const active = rules.filter((r) => r.media === 'all' || r.media === theme);
  const walk = (el, parent) => {
    const own = new Map();
    const set = (name, value, prio) => { if (!own.has(name) || own.get(name).prio <= prio) own.set(name, { value, prio }); };
    // Presentation attributes of SVG are under every rule.
    for (const name of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-weight', 'color', 'display', 'visibility']) if (el.attrs[name] !== undefined) set(name, el.attrs[name], -1);
    const pseudo = [];
    for (const rule of active) {
      if (!matches(el, rule.parts, root)) continue;
      if (rule.pseudoEl) { pseudo.push(rule); continue; }
      for (const d of rule.decls) set(d.name, d.value, (d.important ? 1e9 : 0) + rule.spec * 1e5 + rule.order);
    }
    for (const d of parseDecls(el.attrs.style || '')) set(d.name, d.value, (d.important ? 1e9 : 0) + 5e8);
    const vars = { ...(parent?.vars || {}) };
    for (const [name, d] of own) if (name.startsWith('--')) vars[name] = d.value;
    const get = (name) => (own.has(name) ? resolveVars(own.get(name).value, vars).trim() : undefined);
    const st = { vars, el, parent };
    for (const name of INHERITED) st[name] = parent?.[name];
    const colorOf = (value, fallback) => {
      if (value === undefined || /^(inherit|unset)$/i.test(value)) return fallback;
      if (/^currentcolor$/i.test(value)) return st.color;
      return parseColor(value);
    };
    // The browser paints a dark canvas and light default text only for a page that declares the dark scheme
    // (color-scheme); without it a page with no background of its own stays on white in the dark form too.
    st.darkCanvas = parent ? parent.darkCanvas : dark && /\bdark\b/.test(`${get('color-scheme') || ''} ${metaScheme}`);
    st.color = colorOf(get('color'), parent ? parent.color : parseColor(st.darkCanvas ? '#fff' : '#000'));
    st.fill = colorOf(get('fill'), parent?.fill);
    st.stroke = colorOf(get('stroke'), parent?.stroke);
    const base = parent ? parent['font-size'] : 16;
    const font = get('font');
    const declared = get('font-size') ?? (font ? /(?:^|\s)((?:[\d.]+(?:px|rem|em|%|pt))|clamp\([^)]*\))(?:\s*\/|\s)/.exec(`${font} `)?.[1] : undefined);
    st['font-size'] = declared !== undefined ? fontSize(declared, base, 16) ?? base : HEADING_EM[el.tag] ? base * HEADING_EM[el.tag] : base;
    const weight = get('font-weight') ?? (font && /\b(bold|[6-9]00)\b/.test(font) ? 'bold' : undefined);
    st['font-weight'] = weight !== undefined ? /^(bold|bolder|[6-9]00)$/.test(weight) : BOLD_TAGS.has(el.tag) ? true : parent?.['font-weight'] || false;
    st.hidden = parent?.hidden || HIDDEN_TAGS.has(el.tag) || el.attrs.hidden !== undefined || get('display') === 'none' || /^(hidden|collapse)$/.test(get('visibility') || '');
    const bg = get('background-color') !== undefined && (own.get('background-color').prio >= (own.get('background')?.prio ?? -2)) ? get('background-color') : get('background');
    st.background = bg === undefined ? [] : backgroundColors(bg);
    st.opacity = Number.isFinite(parseFloat(get('opacity'))) ? parseFloat(get('opacity')) : 1;
    st.fillOpacity = Number.isFinite(parseFloat(get('fill-opacity'))) ? parseFloat(get('fill-opacity')) : 1;
    st.strokeWidth = Number.isFinite(parseFloat(get('stroke-width'))) ? parseFloat(get('stroke-width')) : parent?.strokeWidth ?? 1;
    // Text a rule adds after or before the element (content: "…"): judged with the colour and size of that rule.
    if (pseudo.length) {
      const p = new Map();
      for (const rule of pseudo) for (const d of rule.decls) if (!p.has(d.name) || p.get(d.name).prio <= rule.spec * 1e5 + rule.order) p.set(d.name, { value: d.value, prio: rule.spec * 1e5 + rule.order });
      const content = p.has('content') ? resolveVars(p.get('content').value, vars) : '';
      const shown = p.get('display')?.value !== 'none' && p.get('visibility')?.value !== 'hidden' && parseFloat(p.get('opacity')?.value ?? '1') > 0;
      const literal = /^\s*(?:"([^"]*\S[^"]*)"|'([^']*\S[^']*)')\s*$/.exec(content);
      if (literal && shown) {
        const size = p.has('font-size') ? fontSize(resolveVars(p.get('font-size').value, vars), st['font-size'], 16) ?? st['font-size'] : st['font-size'];
        st.added = { text: literal[1] ?? literal[2], color: p.has('color') ? colorOf(resolveVars(p.get('color').value, vars).trim(), st.color) : st.color, size, bold: st['font-weight'] };
      }
    }
    el.st = st;
    for (const child of el.children) if (typeof child !== 'string') walk(child, st);
  };
  walk(root, null);
}

/** The opaque colours behind an element of the page: the nearest background up the tree, or null when it is not known. */
function backdrop(st, canvas) {
  const chain = [];
  for (let s = st; s; s = s.parent) { if (s.background === null) return null; if (s.background.length) chain.push(s.background); }
  let under = [canvas];
  for (const layer of chain.reverse()) under = layer.flatMap((c) => under.map((u) => over(c, u)));
  return under;
}

// ---------- drawings

const num = (v) => (v === undefined || v === '' ? null : /%$/.test(v) ? null : parseFloat(v));
function translateOf(el, svg) {
  let x = 0;
  let y = 0;
  for (let e = el; e && e !== svg; e = e.parent) {
    const t = e.attrs.transform;
    if (!t) continue;
    const m = /^\s*translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)\s*$/.exec(t);
    if (!m) return null;
    x += parseFloat(m[1]); y += parseFloat(m[2] || 0);
  }
  return { x, y };
}

function shapeBox(el, svg, view) {
  const t = translateOf(el, svg);
  if (!t) return null;
  const size = (v, whole) => (/%$/.test(v || '') ? (parseFloat(v) / 100) * whole : num(v));
  if (el.tag === 'rect') {
    const w = size(el.attrs.width, view.w);
    const h = size(el.attrs.height, view.h);
    if (w === null || h === null) return null;
    const x = (num(el.attrs.x) ?? 0) + t.x;
    const y = (num(el.attrs.y) ?? 0) + t.y;
    return (px, py) => px >= x && px <= x + w && py >= y && py <= y + h;
  }
  if (el.tag === 'circle' || el.tag === 'ellipse') {
    const rx = num(el.attrs.r ?? el.attrs.rx);
    const ry = num(el.attrs.r ?? el.attrs.ry);
    if (!rx || !ry) return null;
    const cx = (num(el.attrs.cx) ?? 0) + t.x;
    const cy = (num(el.attrs.cy) ?? 0) + t.y;
    return (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
  }
  return null;
}

const selectorOf = (el) => `${el.tag}${[...el.classes].map((c) => `.${c}`).join('')}`;
const textOf = (el) => el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join(' ').replace(/\s+/g, ' ').trim();

function checkTheme(root, rules, theme, dark, metaScheme, problems, counts) {
  styleTree(root, rules, theme, dark, metaScheme);
  const canvas = parseColor(root.st.darkCanvas ? '#121212' : '#fff');
  const add = (kind, key, line) => { if (!problems.has(`${theme}|${kind}|${key}`)) problems.set(`${theme}|${kind}|${key}`, { theme, kind, line, count: 0 }); problems.get(`${theme}|${kind}|${key}`).count += 1; };
  const judge = (what, fg, alpha, backs, need, where, label) => {
    if (!fg || fg === 'none') return;
    if (!backs) { counts.skipped += 1; return; }
    counts.judged += 1;
    const worst = backs.map((b) => ({ b, ratio: contrast(over({ ...fg, a: fg.a * alpha }, b), b) })).sort((x, y) => x.ratio - y.ratio)[0];
    if (worst.ratio + 0.005 >= need) return;
    add('contrast', `${hexOf(fg)}|${hexOf(worst.b)}|${need}`, `${theme}: ${label} "${what.slice(0, 40)}" ${hexOf(fg)} on ${hexOf(worst.b)} is ${Math.floor(worst.ratio * 10) / 10} : 1, needs ${need} : 1 (${where})`);
  };
  const needOf = (size, bold) => (size >= 24 || (size >= 18.66 && bold) ? LARGE_AA : TEXT_AA);
  const visit = (el, svg) => {
    const st = el.st;
    if (st.hidden) return;
    if (el.tag === 'svg' && !svg) {
      const vb = String(el.attrs.viewbox || '').split(/[\s,]+/).map(parseFloat);
      const width = num(el.attrs.width);
      const view = { w: vb[2] || width || 300, h: vb[3] || num(el.attrs.height) || 150 };
      // A drawing with a fixed width keeps it; one that fills its column gets the column.
      svg = { el, view, scale: Math.min(1, (width && !/%/.test(el.attrs.width) ? width : COLUMN_PX) / view.w), shapes: [], back: backdrop(st, canvas) };
    }
    if (svg && el !== svg.el) {
      const behind = (x, y) => { for (let i = svg.shapes.length - 1; i >= 0; i--) if (svg.shapes[i].has(x, y)) return svg.shapes[i].back; return svg.back; };
      const fill = st.fill === undefined ? parseColor('#000') : st.fill;
      if (['rect', 'circle', 'ellipse'].includes(el.tag)) {
        const has = shapeBox(el, svg.el, svg.view);
        if (has && fill && fill !== 'none' && fill.a * st.fillOpacity * st.opacity > 0.05) {
          const under = behind(num(el.attrs.x ?? el.attrs.cx) ?? 0, num(el.attrs.y ?? el.attrs.cy) ?? 0);
          svg.shapes.push({ has, back: fill === null || !under ? null : under.map((u) => over({ ...fill, a: fill.a * st.fillOpacity * st.opacity }, u)) });
        } else if (!has) svg.shapes.push({ has: () => false, back: null });
      }
      if (el.tag === 'text' || el.tag === 'tspan') {
        const own = el.children.filter((c) => typeof c === 'string').join(' ').trim();
        const t = translateOf(el, svg.el);
        const anchor = el.attrs.x !== undefined ? el : el.parent;
        if (own && t) {
          const size = st['font-size'];
          const x = (num(String(anchor.attrs.x || '').split(/[\s,]+/)[0]) ?? 0) + t.x;
          const y = (num(String(anchor.attrs.y || '').split(/[\s,]+/)[0]) ?? 0) + t.y - size * 0.3;
          judge(own, fill, st.opacity * st.fillOpacity, fill === null ? null : behind(x, y), needOf(size * svg.scale, st['font-weight']), `drawing, ${selectorOf(el)}`, 'text');
          const shown = size * svg.scale;
          if (shown + 0.05 < MIN_SVG_PX) add('size', `svg|${size}|${svg.view.w}`, `text "${own.slice(0, 40)}" in the drawing is ${shown.toFixed(1)} px at a page column of ${COLUMN_PX} px (font-size ${size} in a viewBox ${svg.view.w} wide), needs ${MIN_SVG_PX} px: make the viewBox at most ${COLUMN_PX} wide or the text larger (${selectorOf(el)})`);
        } else if (own) counts.skipped += 1;
      }
      const drawn = st.strokeWidth >= 1.5 || el.attrs['marker-end'] !== undefined || el.attrs['marker-start'] !== undefined;
      if (['path', 'line', 'polyline'].includes(el.tag) && st.stroke && st.stroke !== 'none' && drawn && (el.tag !== 'path' || fill === 'none')) {
        const t = translateOf(el, svg.el);
        const first = el.tag === 'line' ? [num(el.attrs.x1) ?? 0, num(el.attrs.y1) ?? 0] : (/(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(el.attrs.d || el.attrs.points || '') || []).slice(1).map(parseFloat);
        if (t && first.length === 2) judge(selectorOf(el), st.stroke, st.opacity, behind(first[0] + t.x, first[1] + t.y), LINE_AA, `drawing, ${selectorOf(el)}`, 'line');
        else counts.skipped += 1;
      }
    } else if (!svg) {
      const own = el.children.filter((c) => typeof c === 'string').join(' ').replace(/\s+/g, ' ').trim();
      let alpha = 1;
      for (let s = st; s; s = s.parent) { alpha *= s.opacity; if (s.background === null || s.background.length) break; }
      const size = st['font-size'];
      if (own) {
        if (st.color === null) counts.skipped += 1;
        else judge(own, st.color, alpha, backdrop(st, canvas), needOf(size, st['font-weight']), selectorOf(el), 'text');
        if (size + 0.05 < MIN_PX) add('size', `html|${size}|${selectorOf(el)}`, `text "${own.slice(0, 40)}" is ${size.toFixed(1)} px, needs ${MIN_PX} px (${selectorOf(el)})`);
      }
      if (st.added) {
        if (st.added.color === null) counts.skipped += 1;
        else judge(st.added.text, st.added.color, alpha, backdrop(st, canvas), needOf(st.added.size, st.added.bold), `${selectorOf(el)}::after`, 'text');
        if (st.added.size + 0.05 < MIN_PX) add('size', `html|${st.added.size}|${selectorOf(el)}::after`, `text "${st.added.text.slice(0, 40)}" is ${st.added.size.toFixed(1)} px, needs ${MIN_PX} px (${selectorOf(el)}::after)`);
      }
    }
    for (const child of el.children) if (typeof child !== 'string') visit(child, svg);
  };
  visit(root, null);
}

/**
 * The readability problems of a page: { problems: [{ theme, kind: 'contrast' | 'size', line, count }], judged, skipped }.
 * Light always; dark when the page has a dark form (a prefers-color-scheme rule or a data-theme="dark" selector).
 */
export function checkPage(html) {
  const { root, styles } = parseHtml(String(html || ''));
  const rules = [];
  for (const css of styles) parseCss(css.replace(/\/\*[\s\S]*?\*\//g, ''), rules);
  const problems = new Map();
  const counts = { judged: 0, skipped: 0 };
  const themed = /data-theme\s*=\s*["']?dark/.test(styles.join('\n'));
  const given = root.attrs['data-theme'];
  const metaScheme = /<meta[^>]+name\s*=\s*["']?color-scheme["']?[^>]*content\s*=\s*["']([^"']+)/i.exec(String(html || ''))?.[1] || '';
  checkTheme(root, rules, 'light', false, metaScheme, problems, counts);
  if (themed || rules.some((r) => r.media === 'dark')) {
    root.attrs['data-theme'] = 'dark';
    checkTheme(root, rules, 'dark', true, metaScheme, problems, counts);
    if (given === undefined) delete root.attrs['data-theme']; else root.attrs['data-theme'] = given;
  }
  // A size problem is the same in both forms: once.
  const list = [...problems.values()].filter((p, i, all) => p.kind !== 'size' || all.findIndex((q) => q.kind === 'size' && q.line === p.line) === i);
  return { problems: list, ...counts };
}

/** The problems as lines for a refusal or a report (at most `max`, then the count of the rest); '' when the page is readable. */
export function pageProblemLines(html, max = 10) {
  const { problems } = checkPage(html);
  if (!problems.length) return '';
  const lines = problems.slice(0, max).map((p) => `- ${p.line}${p.count > 1 ? ` (${p.count}×)` : ''}`);
  if (problems.length > max) lines.push(`- and ${problems.length - max} more`);
  return lines.join('\n');
}

// A page over this size is not measured in a hook (the cascade is elements times rules).
const MAX_BYTES = 1500000;

/**
 * PreToolUse: the refusal for a page the call shows to the operator (an Artifact publish of an .html file, html_preview
 * of a file or of inline HTML), or null. `read` gives the text of a file. A fault of the check never refuses.
 */
export function unreadablePage(input, file, read, command) {
  try {
    const inline = typeof input?.tool_input?.html === 'string' && /<[a-z]/i.test(input.tool_input.html) ? input.tool_input.html : null;
    if (!inline && !(file && /\.html?$/i.test(file))) return null;
    const html = inline ?? read(file);
    if (typeof html !== 'string' || html.length > MAX_BYTES) return null;
    const lines = pageProblemLines(html);
    if (!lines) return null;
    return `the page ${inline ? '' : `${file} `}is not readable for the operator (P-077: WCAG AA contrast and text size, measured in the light and the dark form):\n${lines}\nChange the colours and sizes the lines name (a darker text or line colour, a lighter one in the dark form; a narrower viewBox or larger text in a drawing), then show the page again.${inline ? '' : ` Check before: ${command} ${file}`}`;
  } catch { return null; }
}
