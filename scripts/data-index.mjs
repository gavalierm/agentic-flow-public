// INDEX.md of a repository in data layout 2 (D-0048 phase 2b): one row per file git tracks in zdroje/, temy/ and
// vystupy/ (not temy/<id>/tmp/, not hidden files such as .tema.json), sorted by path. Columns: path, description, origin,
// topic, date; files of a closed topic are marked. Everything is read from the git index (the staged blobs), never from
// the clock or the order of files on disk, so two machines with the same files write the same INDEX.md. Layout 1 has no
// INDEX.md: every function here does nothing there.
//
// Data of a source (description, origin, date) is kept in one hidden file beside the policy, .brain/sources.json (key =
// path in zdroje/, sorted by path), so zdroje/ holds only files from outside (save.mjs source --record --description).
// Description: frontmatter `description` (a decision has none: its `title`), else the first heading of a .md (when it is a
// template heading such as Zadanie or Hotové, the first line of text under it), else the `description` of the source in
// sources.json, else empty. A topic's handover: the subject of the topic (.tema.json), else the first line under Zadanie.
// Date of a handover: the date the topic closed, else the date it was created (.tema.json).
// Origin: of a source its `from` in sources.json (else the `from` of its big file record or frontmatter); of other files
// the entries of frontmatter `sources` and `relates_to` that point to a file of a topic (temy/) or a source (zdroje/).
// Date: frontmatter `updated`, `created` or `date`, else the `date` of the source in sources.json or of its record.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { layoutOf } from './layout.mjs';
import { parseFrontmatter, asList } from './frontmatter.mjs';
import { HANDOVER_SECTIONS, HANDOVER_FREE_TEXT, REPORTS_SECTION } from './brain-checks.mjs';

export const INDEX_FILE = 'INDEX.md';
const RECORD_SUFFIX = '.zaznam.json';
const CLOSED_MARK = '(uzavretá)';
const HEADER = [
  '# INDEX',
  '',
  'Súbory v zdroje/, temy/ a vystupy/, ktoré sleduje git. Generuje ho workflow pri každom zápise do repa; ručne sa needituje (P-013).',
  '',
  '| cesta | popis | pôvod | téma | dátum |',
  '| --- | --- | --- | --- | --- |',
];

// Map of the repository (layout.mjs, by its version and role); null when the workflow does not know its version.
const mapOf = (root) => { try { return layoutOf(root); } catch { return null; } };
/** Path (posix, relative) of the data of the sources: beside the policy of the layout (.brain/sources.json). */
export const sourcesFileRel = (root) => path.posix.join(path.posix.dirname(mapOf(root).policy), 'sources.json');

/** Data of the sources as on disk: { <path in zdroje/>: { description?, from?, date? } }. */
export function readSources(root) {
  try { const v = JSON.parse(fs.readFileSync(path.join(root, ...sourcesFileRel(root).split('/')), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Text of sources.json with one source set (empty fields left out), keys sorted by path. */
export function sourcesWith(root, rel, fields) {
  const all = { ...readSources(root) };
  // One source or several (a folder added at once) with the same fields.
  for (const r of Array.isArray(rel) ? rel : [rel]) {
    const entry = { ...(all[r] || {}) };
    for (const [k, v] of Object.entries(fields)) if (typeof v === 'string' && v.trim()) entry[k] = v.trim();
    all[r] = entry;
  }
  const sorted = Object.fromEntries(Object.keys(all).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, all[k]]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
/** The repository keeps an INDEX.md (its map names one: layouts 2 and 3). */
export const hasDataIndex = (root) => !!root && !!mapOf(root)?.index;

/** Top folders the index lists, by the map of the layout (zdroje, temy, vystupy; a brain of layout 3 topics, decisions). */
function folders(root) {
  const L = mapOf(root);
  return [...new Set([L.materialy, L.topics, L.decisions, L.docs].filter(Boolean).map((p) => p.split('/')[0]))];
}

const run = (root, args, input) => spawnSync('git', args, { cwd: root, input, maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/** Staged files (stage 0) of the repository: [{ path, sha }], or null when git cannot list them. */
function stagedFiles(root) {
  const r = run(root, ['ls-files', '-s', '-z']);
  if (r.status !== 0) return null;
  const out = [];
  for (const entry of r.stdout.toString('utf8').split('\0')) {
    const m = /^\d+ ([0-9a-f]+) (\d)\t(.+)$/s.exec(entry);
    if (m && m[2] === '0') out.push({ sha: m[1], path: m[3] });
  }
  return out;
}

/** Contents (utf8) of blobs by sha, one git call. */
function blobs(root, shas) {
  const map = new Map();
  const want = [...new Set(shas)];
  if (!want.length) return map;
  const r = run(root, ['cat-file', '--batch'], want.join('\n') + '\n');
  if (r.status !== 0) return map;
  const buf = r.stdout;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [sha, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    if (type === 'missing' || size === undefined) { at = nl + 1; continue; }
    const n = Number(size);
    map.set(sha, buf.subarray(nl + 1, nl + 1 + n).toString('utf8'));
    at = nl + 1 + n + 1;
  }
  return map;
}

const json = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const str = (v) => (typeof v === 'string' ? v.trim() : v instanceof Date ? v.toISOString().slice(0, 10) : '');
const cell = (v) => String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Headings of the templates (handover sections): they say nothing about one file, so they are no description. */
const TEMPLATE_HEADINGS = new Set([...HANDOVER_SECTIONS, REPORTS_SECTION].map((h) => h.replace(/^#+\s*/, '')));
/** Text of a line that is no description: an empty item of a template ("-", "(voľná)"). */
const EMPTY_ITEM = new Set(['-', HANDOVER_FREE_TEXT]);

/**
 * Description from the body: the first heading, or when it is a template heading (Zadanie, Hotové ...) the first line of
 * text under a heading (list mark left out, empty items of the template skipped).
 */
function bodyDescription(body) {
  let fence = false;
  let generic = false;
  for (const line of String(body || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      if (!TEMPLATE_HEADINGS.has(m[1])) return generic ? '' : m[1];
      generic = true;
      continue;
    }
    if (!generic) continue;
    const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (text && !EMPTY_ITEM.has(text)) return text;
  }
  return '';
}

/** Text under "## Zadanie" of a handover (its first line of text), '' when none. */
function handoverTask(body) {
  const lines = String(body || '').split('\n');
  const i = lines.findIndex((l) => l.trim() === HANDOVER_SECTIONS[0]);
  if (i === -1) return '';
  for (const line of lines.slice(i + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (text && !EMPTY_ITEM.has(text)) return text;
  }
  return '';
}

/** Fields of one file from its staged content. */
function describe(rel, text, { topicsRel, sourcesRel }) {
  const points = (v) => asList(v).map(String).filter((s) => s.startsWith(`${topicsRel}/`) || s.startsWith(`${sourcesRel}/`));
  if (text === undefined) return { desc: '', from: '', date: '', fmTopic: '' };
  if (rel.endsWith(RECORD_SUFFIX)) {
    const r = json(text) || {};
    return { desc: '', from: str(r.from), date: str(r.date).slice(0, 10), fmTopic: '' };
  }
  let data = {};
  let body = text;
  try { ({ data = {}, body = text } = parseFrontmatter(text) || {}); } catch { data = {}; }
  const desc = str(data.description) || str(data.title) || bodyDescription(body);
  const from = [str(data.from), ...points(data.sources), ...points(data.relates_to)].filter(Boolean);
  const date = (str(data.updated) || str(data.created) || str(data.date)).slice(0, 10);
  return { desc, from: [...new Set(from)].join(', '), date, fmTopic: str(data.topic), body };
}

/**
 * Rows of the index from the git index of `root`: [{ path, desc, from, topic, closed, date }] sorted by path (code
 * points, not locale), or null outside layout 2 or without git.
 */
export function indexRows(root) {
  if (!hasDataIndex(root)) return null;
  const L = mapOf(root);
  const files = stagedFiles(root);
  if (!files) return null;
  const tops = folders(root);
  const topicsRel = L.topics;
  const sourcesRel = L.materialy;
  const temaRe = new RegExp(`^${topicsRel}/([^/]+)/${L.topicFile.replace(/\./g, '\\.')}$`);
  const listed = files.filter((f) => {
    const parts = f.path.split('/');
    if (parts.length < 2 || !tops.includes(parts[0])) return false;
    if (parts.some((p) => p.startsWith('.'))) return false;
    if (parts[0] === topicsRel && parts.length > 3 && parts[2] === L.topicTmp) return false;
    return true;
  });
  const temas = files.filter((f) => temaRe.test(f.path));
  const textual = listed.filter((f) => f.path.endsWith('.md') || f.path.endsWith(RECORD_SUFFIX));
  const sourcesBlob = files.find((f) => f.path === sourcesFileRel(root));
  const content = blobs(root, [...temas, ...textual, ...(sourcesBlob ? [sourcesBlob] : [])].map((f) => f.sha));
  const sources = (sourcesBlob && json(content.get(sourcesBlob.sha))) || {};
  // A big file is in git only as its record: its data is under the path of the file.
  const sourceOf = (p) => sources[p] || (p.endsWith(RECORD_SUFFIX) ? sources[p.slice(0, -RECORD_SUFFIX.length)] : null) || {};
  const temaOf = new Map(temas.map((f) => [temaRe.exec(f.path)[1], json(content.get(f.sha)) || {}]));
  const closed = new Set([...temaOf].filter(([, t]) => t.state === 'closed').map(([id]) => id));
  const handoverRe = new RegExp(`^${topicsRel}/([^/]+)/${L.handover.replace(/\./g, '\\.')}$`);
  const topicIn = (p) => {
    const parts = p.split('/');
    return (parts[0] === topicsRel || parts[0] === sourcesRel) && parts.length > 2 ? parts[1] : '';
  };
  const rows = listed.map((f) => {
    const d = describe(f.path, content.get(f.sha), { topicsRel, sourcesRel });
    if (f.path.startsWith(`${sourcesRel}/`)) {
      const s = sourceOf(f.path);
      d.desc = d.desc || str(s.description);
      d.from = str(s.from) || d.from;
      d.date = d.date || str(s.date).slice(0, 10);
    }
    // The handover of a topic: the subject of the topic, else its task; the date the topic closed, else was created.
    const ho = handoverRe.exec(f.path);
    if (ho) {
      const t = temaOf.get(ho[1]) || {};
      d.desc = str(t.subject) || handoverTask(d.body) || d.desc;
      d.date = d.date || (str(t.closed) || str(t.created)).slice(0, 10);
    }
    const topic = topicIn(f.path) || d.fmTopic || d.from.split(', ').map(topicIn).find(Boolean) || '';
    return { path: f.path, desc: d.desc, from: d.from, topic, closed: !!topic && closed.has(topic), date: d.date };
  });
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Text of INDEX.md (no generation time: the same files give the same text on every machine). */
export function renderIndex(rows) {
  const lines = rows.map((r) => `| ${[cell(r.path), cut(cell(r.desc)), cell(r.from), r.topic ? cell(`${r.topic}${r.closed ? ` ${CLOSED_MARK}` : ''}`) : '', cell(r.date)].join(' | ')} |`);
  return `${[...HEADER, ...lines].join('\n')}\n`;
}

/** INDEX.md as it should be for the staged files of `root`, or null outside layout 2. */
export function buildIndex(root) {
  const rows = indexRows(root);
  return rows ? renderIndex(rows) : null;
}

/**
 * Writes INDEX.md for the staged files and stages it. Returns true when it changed, false when it was current, null
 * outside layout 2. `env`: git env of the caller (script tag of the brain).
 */
export function refreshIndex(root, env = {}) {
  const rows = indexRows(root);
  if (rows === null) return null;
  const text = renderIndex(rows);
  const file = path.join(root, INDEX_FILE);
  let staged = null;
  const show = spawnSync('git', ['show', `:${INDEX_FILE}`], { cwd: root, encoding: 'utf8' });
  if (show.status === 0) staged = show.stdout;
  // No listed file yet (a write of .brain/ only): no empty INDEX.md; it comes with the first file of zdroje/, temy/, vystupy/.
  if (!rows.length && staged === null) return false;
  let disk = null;
  try { disk = fs.readFileSync(file, 'utf8'); } catch { disk = null; }
  if (disk !== text) fs.writeFileSync(file, text);
  if (staged === text) return false;
  const add = spawnSync('git', ['add', '--', INDEX_FILE], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  if (add.status !== 0) throw new Error(`git add ${INDEX_FILE} failed: ${String(add.stderr).split('\n')[0]}`);
  return true;
}

/**
 * Ignore files of deploy tools in the root of a repository (gitignore syntax): a static web deployed from the repository
 * (wrangler assets, Vercel, Netlify, Docker, gcloud, Cloud Foundry, Elastic Beanstalk, Heroku slug, npm package) publishes
 * every file such a file does not exclude.
 */
export const DEPLOY_IGNORES = ['.assetsignore', '.vercelignore', '.netlifyignore', '.dockerignore', '.gcloudignore', '.cfignore', '.ebignore', '.slugignore', '.npmignore'];

/** Entries of layout 2 a deploy must not publish: the data folders and INDEX.md (only those the staged files have). */
function internalEntries(root, staged) {
  const L = mapOf(root);
  const tops = [...new Set([...folders(root), L.policy.split('/')[0]])].filter((t) => t && t !== '.');
  const have = new Set(staged.map((f) => f.path.split('/')[0]));
  return [...tops.filter((t) => have.has(t)), ...(have.has(INDEX_FILE) ? [INDEX_FILE] : [])];
}

/**
 * Layout 2: every deploy ignore file of the repository root (DEPLOY_IGNORES, only one that exists) gets the internal
 * entries it lacks (zdroje, temy, vystupy, .brain, INDEX.md, those the staged files have), appended and staged, so the
 * write that first creates them never lets the next deploy publish them (a static web repo, 2026-11-14). An entry counts as
 * present as `x`, `x/`, `/x` or `/x/`. Returns [{ file, added: [entry] }] (empty when nothing changed or outside layout 2).
 */
export function refreshDeployIgnores(root, env = {}) {
  const out = [];
  for (const { file: f, text, missing: added } of deployIgnoreGaps(root)) {
    const abs = path.join(root, f);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(abs, `${text}${text && !text.endsWith('\n') ? eol : ''}${added.join(eol)}${eol}`);
    const add = spawnSync('git', ['add', '--', f], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
    if (add.status !== 0) throw new Error(`git add ${f} failed: ${String(add.stderr).split('\n')[0]}`);
    out.push({ file: f, added });
  }
  return out;
}

/**
 * Layout 2: the deploy ignore files of the repository root (DEPLOY_IGNORES) that lack an internal entry the repository
 * has, as refreshDeployIgnores adds it (from the files of the git index): [{ file, text, missing: [entry] }]. Nothing
 * changes (migrate --check reports them: a repo moved before the move filled deploy ignores, 2026-11-14).
 */
export function deployIgnoreGaps(root) {
  if (!hasDataIndex(root)) return [];
  const files = DEPLOY_IGNORES.filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } });
  if (!files.length) return [];
  const entries = internalEntries(root, stagedFiles(root) || []);
  const out = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')));
    const missing = entries.filter((e) => !have.has(e));
    if (missing.length) out.push({ file, text, missing });
  }
  return out;
}

/** One line of the entries added to deploy ignore files, or null. */
export function formatDeployIgnores(list) {
  if (!list?.length) return null;
  return `deploy ignore: ${list.map((x) => `${x.file} += ${x.added.join(', ')}`).join('; ')} (internal data of layout 2 is not deployed; in the same commit)`;
}

/**
 * INDEX.md of HEAD against the one its tracked files give: 'missing' (none in HEAD though zdroje/, temy/ or vystupy/
 * have files), 'stale' (differs), null when current or outside layout 2.
 */
export function indexProblem(root) {
  const expected = buildIndex(root);
  if (expected === null) return null;
  const head = spawnSync('git', ['show', `HEAD:${INDEX_FILE}`], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) return indexRows(root).length ? 'missing' : null;
  return head.stdout === expected ? null : 'stale';
}

/**
 * After a merge or rebase brought files of another machine or branch: INDEX.md is not merged line by line but written
 * again from the merged files. Commits the new INDEX.md when HEAD's differs. Returns true when it committed.
 */
export function commitIndexAfterMerge(root, { env = {}, message = 'regenerate INDEX.md after merge' } = {}) {
  if (!hasDataIndex(root)) return false;
  const changed = refreshIndex(root, env);
  if (!changed) return false;
  const head = spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD', '--', INDEX_FILE], { cwd: root });
  if (head.status === 0) return false;
  const c = spawnSync('git', ['commit', '--quiet', '-m', message, '--', INDEX_FILE], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  if (c.status !== 0) throw new Error(`commit of ${INDEX_FILE} failed: ${String(c.stderr || c.stdout).trim().split('\n')[0]}`);
  return true;
}

/**
 * `git merge <args>` in `dir` with INDEX.md written again instead of merged by lines (layout 2): a conflict only in
 * INDEX.md is settled by regenerating it, a clean merge gets a regenerated INDEX.md when its lines merged wrong.
 * Returns the result of the merge like util git(): { ok, stdout, stderr }.
 */
export function mergeWithIndex(dir, mergeArgs, env = {}) {
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } });
    return { ok: r.status === 0, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
  };
  const merge = g(['merge', ...mergeArgs]);
  if (!hasDataIndex(dir)) return merge;
  if (!merge.ok) {
    const unmerged = g(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    if (unmerged.length !== 1 || unmerged[0] !== INDEX_FILE) return merge;
    refreshIndex(dir, env);
    const done = g(['commit', '--quiet', '--no-edit']);
    return done.ok ? { ...done, ok: true } : done;
  }
  commitIndexAfterMerge(dir, { env });
  return merge;
}

/** A write op naming INDEX.md of a layout 2 repository: only the workflow writes it (P-013). */
export function indexWriteError(root, rel) {
  if (!hasDataIndex(root) || String(rel).replace(/^\.\//, '') !== INDEX_FILE) return null;
  return `${INDEX_FILE} is generated by the workflow at every write into the repo; it is not written by hand or by a write op (P-013)`;
}

/** An absolute path that is INDEX.md in the root of a layout 2 git repository (brain or project repo). */
export function isDataIndexPath(abs) {
  if (!abs || path.basename(abs) !== INDEX_FILE) return false;
  const dir = path.dirname(path.resolve(abs));
  return fs.existsSync(path.join(dir, '.git')) && hasDataIndex(dir);
}

/** Summary of INDEX.md for a session start: { file, total, byFolder: [[folder, n]], undescribed, openTopics } or null. */
export function indexSummary(root) {
  if (!hasDataIndex(root)) return null;
  const file = path.join(root, INDEX_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, missing: true, total: 0, byFolder: [], undescribed: 0, openTopics: [] }; }
  const L = mapOf(root);
  const rows = text.split('\n').slice(HEADER.length).filter((l) => l.startsWith('| '))
    .map((l) => l.slice(2, -2).split(/(?<!\\) \| /));
  const byFolder = new Map(folders(root).map((f) => [f, 0]));
  const open = new Set();
  let undescribed = 0;
  for (const [p, desc, , topic] of rows) {
    const top = String(p).split('/')[0];
    byFolder.set(top, (byFolder.get(top) || 0) + 1);
    if (!String(desc || '').trim()) undescribed++;
    if (top === L.topics && topic && !topic.endsWith(CLOSED_MARK)) open.add(topic.trim());
  }
  // A topic without a listed file yet (only its .tema.json) is open too.
  let ids = [];
  try { ids = fs.readdirSync(path.join(root, ...L.topics.split('/')), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { ids = []; }
  for (const id of ids) {
    let tema = null;
    try { tema = JSON.parse(fs.readFileSync(path.join(root, ...L.topics.split('/'), id, L.topicFile), 'utf8')); } catch { continue; }
    if (tema && tema.state !== 'closed') open.add(id);
  }
  return { file, total: rows.length, byFolder: [...byFolder], undescribed, openTopics: [...open].sort() };
}

/** One boot line from INDEX.md (session start in layout 2, in place of the line of the catalog source materialy). */
export function indexBootLine(root, label = null) {
  const s = indexSummary(root);
  if (!s) return null;
  const name = label ? `${label} ` : '';
  if (s.missing) return `${name}${INDEX_FILE}: zatiaľ nie je (vznikne pri prvom zápise do repa); ${s.file}`;
  const open = s.openTopics.length ? `otvorené témy: ${s.openTopics.join(', ')}` : 'otvorené témy: žiadne';
  return `${name}${INDEX_FILE}: ${s.total} súborov (${s.byFolder.map(([f, n]) => `${f} ${n}`).join(', ')}), ${s.undescribed} bez popisu; ${open}; ${s.file}`;
}
