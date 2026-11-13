// Read-only vault of the knowledge of the machine for a reader (Obsidian): one folder with a subfolder per knowledge
// store (scripts/stores.mjs), the markdown records copied in, references rewritten to wikilinks. The sources are never
// changed; a rebuild of the same input gives the same files (no timestamps), and files whose source is gone are deleted.
// Only what the manifest lists is ever deleted, so .git, .obsidian, .gitignore and foreign files are safe.
import fs from 'node:fs';
import path from 'node:path';
import { readText, toPosix, realPathLoose, git, gitRemote } from './util.mjs';
import { parseFrontmatter, asList } from './frontmatter.mjs';
import { machineStores, storeRecords, recordType, lc } from './stores.mjs';

export const MANIFEST = '.vault-manifest.json';
const SKIP_SEGMENTS = new Set(['logs', 'local', 'scratch', '.claude', '.git', '.obsidian', 'node_modules']);
const DECISION_ID = /^D-\d{4}$/;
const PRINCIPLE_ID = /^P-\d{3}$/i;
const DECISION_VALUE = /^(?:([A-Za-z0-9][\w.-]*)\/)?(D-\d{4})$/i;
const LINK_LISTS = ['relates_to', 'supersedes'];

/** A path segment safe inside a wikilink target. */
const seg = (s) => String(s).replace(/[#^|[\]\\:*?"<>]/g, '_').replace(/\s+/g, ' ').trim() || '_';
const wiki = (target, text) => `[[${target.replace(/\.md$/, '')}${text ? `|${String(text).replace(/[|\]]/g, ' ')}` : ''}]]`;
const oneLine = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, n);

/** Vault names of the stores: the store name, `<domain>-<name>` when two stores share a name. */
export function vaultNames(stores) {
  const byName = new Map();
  for (const s of stores) {
    const k = lc(s.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }
  const names = new Map();
  const used = new Set();
  for (const group of byName.values()) {
    const sorted = [...group].sort((a, b) => a.dir.localeCompare(b.dir));
    for (const s of sorted) {
      let name = seg(group.length > 1 ? `${path.basename(s.domainRoot || '') || 'x'}-${s.name}` : s.name);
      for (let i = 2; used.has(lc(name)); i++) name = `${seg(group.length > 1 ? `${path.basename(s.domainRoot || '') || 'x'}-${s.name}` : s.name)}-${i}`;
      used.add(lc(name));
      names.set(s, name);
    }
  }
  return names;
}

/** Entries of one store: { kind, rec, key, src, dest } with dest relative to the vault root (posix). */
function storeEntries(store, vname) {
  const out = [];
  const taken = new Set();
  const add = (e) => {
    let dest = `${vname}/${e.rel}`;
    for (let i = 2; taken.has(lc(dest)); i++) dest = `${vname}/${e.rel.replace(/\.md$/, '')}-${i}.md`;
    taken.add(lc(dest));
    out.push({ ...e, dest });
  };
  const clean = (rel) => rel.split('/').map(seg).join('/');
  const records = storeRecords(store, store.dir).filter((r) => !r.topic);
  for (const r of records.sort((a, b) => a.abs.localeCompare(b.abs))) {
    const rel = toPosix(path.relative(store.knowledge, r.abs));
    if (rel.startsWith('..') || rel.split('/').some((p) => SKIP_SEGMENTS.has(p)) || !rel.endsWith('.md')) continue;
    if (r.kind === 'handover') { add({ kind: 'handover', rec: r, src: r.abs, rel: `handovers/${seg(store.name)}.md` }); continue; }
    if (r.kind === 'skill') {
      if (path.basename(r.abs) === 'SKILL.md') add({ kind: 'skill', rec: r, src: r.abs, rel: `skills/${seg(r.skillName || r.key)}.md` });
      else add({ kind: 'doc', rec: r, src: r.abs, rel: clean(`docs/${rel}`) });
      continue;
    }
    if (['memory', 'decision', 'rule'].includes(r.kind) && /^(memory|decisions|rules)\//.test(rel)) { add({ kind: r.kind, rec: r, src: r.abs, rel: clean(rel) }); continue; }
    add({ kind: 'doc', rec: r, src: r.abs, rel: clean(`docs/${rel}`) });
  }
  if (store.kind === 'brain') {
    const topics = path.join(store.knowledge, 'topics');
    let dirs = [];
    try { dirs = fs.readdirSync(topics, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { /* no topics */ }
    for (const t of dirs) {
      const src = path.join(topics, t, 'handover.md');
      if (fs.existsSync(src)) add({ kind: 'handover', rec: { key: `handover-${t}`, abs: src, data: {}, name: t, aliases: [], relates_to: [] }, src, rel: `handovers/${seg(t)}.md` });
    }
  }
  return out;
}

/** Indexes the rewriting resolves against: decisions per store, memory keys in search order, principle files. */
function buildIndex(stores, names, entriesOf) {
  const decisions = new Map(); // store -> Map(id -> dest)
  const keys = new Map(); // key -> [{ store, dest }] in machineStores order
  const principles = new Map();
  for (const s of stores) {
    const dm = new Map();
    for (const e of entriesOf.get(s)) {
      const r = e.rec;
      if (e.kind === 'decision') {
        const id = String(r.id || r.key).toUpperCase();
        if (DECISION_ID.test(id) && !dm.has(id)) dm.set(id, e.dest);
      } else if (e.kind === 'memory') {
        const k = String(r.key);
        if (!keys.has(k)) keys.set(k, []);
        keys.get(k).push({ store: s, dest: e.dest });
      }
      if (PRINCIPLE_ID.test(String(r.key))) principles.set(String(r.key).toUpperCase(), e.dest);
    }
    decisions.set(s, dm);
  }
  return { decisions, keys, principles, stores, names };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The rewriter of one index: text -> { text, links, unresolved }, valueLink(value, store) for frontmatter lists. */
function makeRewriter(idx) {
  const keyList = [...idx.keys.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const keyAlt = keyList.length ? keyList.map(escapeRe).join('|') : null;
  const parts = [
    String.raw`(?<![\w/.-])([A-Za-z0-9][\w.-]*)\/(D-\d{4})\b`, // 1,2 qualified
    String.raw`(?<![\w/-])(D-\d{4})\b`, // 3 bare
    String.raw`(?<![\w/-])(P-\d{3})\b`, // 4 principle
  ];
  if (keyAlt) parts.push(String.raw`(?<![\w/\-.[|])(${keyAlt})(?![\w/-]|\.\w)`); // 5 key
  const REF = new RegExp(parts.join('|'), 'g');
  const SKIP = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[\[[^\]\n]*\]\]|\]\([^)\n]*\)|https?:\/\/\S+/g;

  const decisionTarget = (store, qstore, id) => {
    id = id.toUpperCase();
    if (!qstore) return idx.decisions.get(store)?.get(id) || null;
    for (const s of idx.stores) {
      if ((idx.names.get(s) === qstore || s.name === qstore) && idx.decisions.get(s)?.has(id)) return idx.decisions.get(s).get(id);
    }
    return null;
  };
  const keyTarget = (store, key) => {
    const hits = idx.keys.get(key);
    if (!hits) return null;
    return (hits.find((h) => h.store === store) || hits[0]).dest;
  };
  /** Target of one frontmatter list value, or { target: null, count: bool } when it stays text. */
  const valueTarget = (value, store) => {
    const v = String(value).trim();
    const d = DECISION_VALUE.exec(v);
    if (d) return { target: decisionTarget(store, d[1] || null, d[2]), counts: true };
    if (PRINCIPLE_ID.test(v)) return { target: idx.principles.get(v.toUpperCase()) || null, counts: false };
    const k = keyTarget(store, v);
    if (k) return { target: k, counts: true };
    return { target: null, counts: /^[a-z][a-z0-9]*-[\w-]+$/.test(v) && !/[/.]/.test(v) };
  };

  function rewriteText(text, store, self) {
    let links = 0;
    let unresolved = 0;
    const chunk = (t) => t.replace(REF, (all, qs, qid, bid, pid, key) => {
      let target = null;
      let counts = true;
      if (qid) target = decisionTarget(store, qs, qid);
      else if (bid) target = decisionTarget(store, null, bid);
      else if (pid) { target = idx.principles.get(pid.toUpperCase()) || null; counts = false; }
      else if (key) { target = keyTarget(store, key); counts = false; }
      if (target && target !== self) { links++; return wiki(target, all); }
      if (target === self) return all;
      if (counts) unresolved++;
      return all;
    });
    let out = '';
    let last = 0;
    for (const m of text.matchAll(SKIP)) {
      out += chunk(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    out += chunk(text.slice(last));
    return { text: out, links, unresolved };
  }

  /** The frontmatter block with relates_to and supersedes as lists of wikilinks; the other lines unchanged. */
  function rewriteFrontmatter(block, store, self) {
    const lines = block.split('\n');
    const out = [];
    let links = 0;
    let unresolved = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(relates_to|supersedes):\s*(.*)$/.exec(lines[i].replace(/\s+$/, ''));
      if (!m || !LINK_LISTS.includes(m[1])) { out.push(lines[i]); continue; }
      let j = i + 1;
      while (j < lines.length && /^\s+-\s*/.test(lines[j])) j++;
      const { data } = parseFrontmatter(`---\n${lines.slice(i, j).join('\n')}\n---\n`);
      const values = asList(data[m[1]]).map(String);
      const mapped = values.map((v) => ({ v, ...valueTarget(v, store) }));
      let any = false;
      const items = mapped.map(({ v, target, counts }) => {
        if (target && target !== self) { any = true; links++; return `"${wiki(target, v)}"`; }
        if (!target && counts) unresolved++;
        return /^[\w.-]+$/.test(v) ? v : JSON.stringify(v);
      });
      if (!any) { out.push(...lines.slice(i, j)); i = j - 1; continue; }
      out.push(`${m[1]}:`, ...items.map((it) => `  - ${it}`));
      i = j - 1;
    }
    return { block: out.join('\n'), links, unresolved };
  }

  /** A whole record file rewritten. */
  return (text, store, self) => {
    const src = String(text).replace(/\r\n/g, '\n');
    let head = '';
    let body = src;
    let links = 0;
    let unresolved = 0;
    if (src.startsWith('---\n')) {
      const end = src.indexOf('\n---', 4);
      if (end !== -1) {
        const fm = rewriteFrontmatter(src.slice(4, end), store, self);
        head = `---\n${fm.block}\n---`;
        body = src.slice(end + 4);
        links += fm.links; unresolved += fm.unresolved;
      }
    }
    const b = rewriteText(body, store, self);
    links += b.links; unresolved += b.unresolved;
    return { text: head + b.text, links, unresolved };
  };
}

const KIND_ORDER = [['memory', 'Pamäť'], ['decision', 'Rozhodnutia'], ['rule', 'Pravidlá'], ['skill', 'Skilly'], ['handover', 'Handovery'], ['doc', 'Dokumenty']];

function readmeText(stores, names, entriesOf) {
  const lines = ['# Vedomosti', '', 'Vault iba na čítanie, poskladaný z úložísk vedomostí stroja. Úpravy sa pri ďalšom zostavení prepíšu; zdroj pravdy sú úložiská (zápis iba cez `save.mjs`).', '', '| Úložisko | Druh | Pamäť | Rozhodnutia | Pravidlá | Skilly | Handovery | Dokumenty |', '|---|---|---|---|---|---|---|---|'];
  const sorted = [...stores].sort((a, b) => names.get(a).localeCompare(names.get(b)));
  for (const s of sorted) {
    const es = entriesOf.get(s);
    const n = (k) => es.filter((e) => e.kind === k).length;
    lines.push(`| [[README#${names.get(s)}\\|${names.get(s)}]] | ${s.kind} | ${KIND_ORDER.map(([k]) => n(k)).join(' | ')} |`);
  }
  lines.push('');
  for (const s of sorted) {
    const es = entriesOf.get(s);
    lines.push(`## ${names.get(s)}`, '', `${s.kind === 'repo' ? 'Repo' : 'Brain'} v doméne ${path.basename(s.domainRoot || '') || '-'}.`, '');
    for (const [kind, label] of KIND_ORDER) {
      const list = es.filter((e) => e.kind === kind).sort((a, b) => a.dest.localeCompare(b.dest));
      if (!list.length) continue;
      lines.push(`### ${label} (${list.length})`, '');
      if (kind === 'memory') {
        const types = [...new Set(list.map((e) => recordType(e.rec)))].sort();
        for (const t of types) {
          lines.push(`**${t}**`, '');
          for (const e of list.filter((x) => recordType(x.rec) === t)) lines.push(`- ${wiki(e.dest, e.rec.key)}${e.rec.description ? ` – ${oneLine(e.rec.description)}` : ''}`);
          lines.push('');
        }
        continue;
      }
      for (const e of list) {
        const r = e.rec;
        if (kind === 'decision') lines.push(`- ${wiki(e.dest, String(r.id || r.key))} – ${oneLine(r.title || r.name, 140)}${r.status ? ` (${r.status})` : ''}`);
        else if (kind === 'skill') lines.push(`- ${wiki(e.dest, r.skillName || r.key)}${r.description ? ` – ${oneLine(r.description)}` : ''}`);
        else lines.push(`- ${wiki(e.dest, path.basename(e.dest, '.md'))}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** Obsidian Bases file (https://obsidian.md/help/bases/syntax): a table view per folder kind over the properties. */
export function baseText() {
  const cols = ['file.name', 'file.folder', 'type', 'status', 'created', 'updated'];
  const view = (name, folder) => [
    '  - type: table', `    name: ${name}`, '    filters:', '      and:', `        - 'file.path.contains("/${folder}/")'`, '    order:', ...cols.map((c) => `      - ${c}`),
  ];
  return ['views:', ...view('Pamäť', 'memory'), ...view('Rozhodnutia', 'decisions'), ''].join('\n');
}

const same = (a, b) => realPathLoose(a) === realPathLoose(b);
const inside = (p, d) => { const r = path.relative(realPathLoose(d), realPathLoose(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** Builds the vault into out. Returns { stores, files, links, unresolved, removed, written }. */
export function buildVault(ctx, out) {
  out = path.resolve(out);
  const stores = machineStores(ctx);
  for (const s of stores) {
    const read = s.kind === 'brain' ? ['memory', 'decisions', 'rules', 'skills', 'topics'].map((d) => path.join(s.dir, d)) : [s.knowledge];
    if (inside(s.dir, out) || read.some((d) => inside(out, d))) throw new Error(`--out ${out} overlaps the store ${s.name} (${s.dir}): it holds the store or lies in a folder the vault reads; choose another folder`);
  }
  const names = vaultNames(stores);
  const entriesOf = new Map(stores.map((s) => [s, storeEntries(s, names.get(s))]));
  const rewrite = makeRewriter(buildIndex(stores, names, entriesOf));
  const generated = new Map(); // dest -> content
  let links = 0;
  let unresolved = 0;
  let files = 0;
  for (const s of stores) {
    for (const e of entriesOf.get(s)) {
      const res = rewrite(readText(e.src, ''), s, e.dest);
      generated.set(e.dest, res.text);
      links += res.links; unresolved += res.unresolved; files++;
    }
  }
  generated.set('README.md', readmeText(stores, names, entriesOf));
  generated.set('vedomosti.base', baseText());

  fs.mkdirSync(out, { recursive: true });
  const manifestFile = path.join(out, MANIFEST);
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files || []; } catch { /* first build */ }
  let written = 0;
  for (const [rel, text] of generated) {
    const file = path.join(out, rel);
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
    if (cur === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written++;
  }
  let removed = 0;
  for (const rel of previous) {
    if (generated.has(rel) || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '.git' || p === '.obsidian') || rel === '.gitignore') continue;
    const file = path.join(out, rel);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    removed++;
    for (let d = path.dirname(file); d !== out && inside(d, out); d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
  }
  const manifest = `${JSON.stringify({ files: [...generated.keys()].sort() }, null, 1)}\n`;
  if (!fs.existsSync(manifestFile) || fs.readFileSync(manifestFile, 'utf8') !== manifest) { fs.writeFileSync(manifestFile, manifest); written++; }
  const app = path.join(out, '.obsidian', 'app.json');
  if (!fs.existsSync(app)) { fs.mkdirSync(path.dirname(app), { recursive: true }); fs.writeFileSync(app, '{"defaultViewMode":"preview"}\n'); written++; }
  const ignore = path.join(out, '.gitignore');
  const want = '.obsidian/workspace*.json';
  const cur = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : null;
  if (cur === null) { fs.writeFileSync(ignore, `${want}\n`); written++; }
  else if (!cur.split('\n').some((l) => l.trim() === want)) { fs.writeFileSync(ignore, `${cur.replace(/\n*$/, '\n')}${want}\n`); written++; }
  return { stores: stores.length, files, links, unresolved, removed, written };
}

export const summaryLine = (out, r) => `vault ${out}: stores ${r.stores}, files ${r.files}, links ${r.links}, unresolved ${r.unresolved}`;

/** Commit and push a built vault. Returns 'unchanged' | 'changed' | throws with a reason. */
export function publishVault(out) {
  out = path.resolve(out);
  if (!fs.existsSync(path.join(out, '.git'))) {
    throw new Error(`${out} is not a git repo: clone the vault repo there first (git clone <vault repo url> ${out}) or run \`git init\` and add a remote; build writes without git`);
  }
  const st = git(['status', '--porcelain'], { cwd: out });
  if (!st.ok) throw new Error(`git status failed in ${out}: ${st.stderr}`);
  if (!st.stdout) return { state: 'unchanged' };
  let r = git(['add', '-A'], { cwd: out });
  if (!r.ok) throw new Error(`git add failed: ${r.stderr}`);
  r = git(['commit', '-q', '-m', 'vault: rebuild'], { cwd: out });
  if (!r.ok) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
  const remotes = git(['remote'], { cwd: out });
  if (!remotes.stdout) return { state: 'changed', note: 'committed, no remote: not pushed' };
  r = gitRemote(['push', 'origin', 'HEAD'], { cwd: out });
  if (!r.ok) throw new Error(`git push failed: ${r.stderr}`);
  return { state: 'changed' };
}
