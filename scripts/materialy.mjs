// Sources of a topic in the project repo (`materialy/<téma>/` or `zdroje/<téma>/`, git) and the results of its work in the
// topic home (topicHome: a brain in layout 2 temy/<téma>/, D-0056). The only code here is what is simple to enforce:
// the size limit (a file over materialy_max_mb never goes to git, only a record of it) and the check of that limit.
// Everything else (what is saved, where, shared materials) is the rule P-062 and the skill `save` (save.mjs source and
// save.mjs result write through this library, plan O15).
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInside, localTime } from './util.mjs';
import { LAYOUT, dataPath, dataRel, dataLayoutVersion, layoutFor, layoutOf, workDirFor, workLabel, topicHome, topicWorkLabel, separateProject, hasData, hasScratch } from './layout.mjs';

// Layout 1; a message names the folder of the repository it is about (materialyDir(root)).
export const MATERIALY_DIR = LAYOUT.materialy;
/** Materials folder of a repository by its layout: materialy (1), zdroje (2). */
export const materialyDir = (root) => dataRel(root, 'materialy');
export const DEFAULT_MAX_MB = 50;
const MB = 1024 * 1024;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const maxBytes = (policy) => (Number.isFinite(policy?.limits?.materialy_max_mb) && policy.limits.materialy_max_mb > 0 ? policy.limits.materialy_max_mb : DEFAULT_MAX_MB) * MB;
export const validTopic = (t) => typeof t === 'string' && TOPIC_RE.test(t) && t !== '.' && t !== '..';

/** Deny reason for a Write of `bytes` into materialy/ of the project over the limit, else null. */
export function bigWriteDeny(projectDir, policy, absTarget, bytes, brainDir = null) {
  if (!projectDir || !absTarget || !isInside(dataPath(projectDir, 'materialy'), absTarget)) return null;
  const max = maxBytes(policy);
  if (bytes <= max) return null;
  const mat = materialyDir(projectDir);
  return `súbor ${(bytes / MB).toFixed(0)} MB je nad limitom ${max / MB} MB pre ${mat}/ (nejde do gitu): nechaj ho tam, odkiaľ prišiel, stiahnutý v ${topicWorkLabel(brainDir, projectDir)}, a v ${mat}/ nechaj iba záznam: node <plugin>/bin/save.mjs source --record <súbor> --from <odkiaľ>`;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(MB);
    for (let n; (n = fs.readSync(fd, buf, 0, MB, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * Record of a big file: <sources>/<topic>/<name>.zaznam.json with from, date, size, sha256 and where the file lies (save.mjs
 * source --record). The file itself is not touched or copied, nothing is written here. Returns { rel, content, record }.
 */
export function recordBigFileOp(projectDir, topic, file, { from, now = new Date(), brainDir = null } = {}) {
  if (!validTopic(topic)) throw new Error(`neplatná téma: ${topic}`);
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`nie je súbor: ${file}`);
  if (isInside(dataPath(projectDir, 'materialy'), abs)) throw new Error(`súbor je už v ${materialyDir(projectDir)}/: presuň ho mimo (stiahnutý do ${topicWorkLabel(brainDir, projectDir, topic)}) a zaznamenaj až potom`);
  const name = path.basename(abs);
  const record = {
    name,
    from: from || null,
    date: now.toISOString().slice(0, 10),
    size: st.size,
    sha256: sha256(abs),
    stored_at: path.relative(projectDir, abs).startsWith('..') ? abs : path.relative(projectDir, abs).split(path.sep).join('/'),
  };
  return { rel: dataRel(projectDir, 'materialy', topic, `${name}.zaznam.json`), content: JSON.stringify(record, null, 2) + '\n', record };
}

/**
 * Write op of a source added through the workflow (save.mjs source): a file outside the sources is copied to
 * <sources>/<topic>/<name>, a file already inside the sources stays where it is. Over the size limit it belongs to
 * `record` (outside git). Returns { rel (posix, relative to the repo), content (Buffer), date }.
 */
export function sourceAddOp(projectDir, topic, file, { name = null, policy = {}, now = new Date() } = {}) {
  if (!validTopic(topic)) throw new Error(`neplatná téma: ${topic}`);
  const abs = path.resolve(file);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`súbor neexistuje: ${file}`); }
  if (!st.isFile()) throw new Error(`nie je súbor: ${file}`);
  const max = maxBytes(policy);
  if (st.size > max) throw new Error(`súbor ${(st.size / MB).toFixed(0)} MB je nad limitom ${max / MB} MB (nejde do gitu): zaznamenaj ho cez save.mjs source --record <súbor> --from <odkiaľ>`);
  const root = dataPath(projectDir, 'materialy');
  const inSources = isInside(root, abs);
  if (name !== null && !validSubpath(name)) throw new Error(`neplatné meno: ${name} (meno alebo podcesta a/b bez .. a lomky na začiatku)`);
  const target = inSources ? abs : path.join(root, topic, ...(name || path.basename(abs)).split('/'));
  if (!inSources && fs.existsSync(target)) throw new Error(`${path.relative(projectDir, target).split(path.sep).join('/')} už existuje: zdroj sa nemení, zvoľ iné meno (--as <meno>)`);
  return { rel: path.relative(projectDir, target).split(path.sep).join('/'), content: fs.readFileSync(abs), date: now.toISOString().slice(0, 10) };
}

/** A name or a subpath (a/b/c) of a source: no empty part, no `.` or `..`, no backslash, not absolute. */
const validSubpath = (name) => typeof name === 'string' && !!name && !name.includes('\\') && name.split('/').every((p) => p && p !== '.' && p !== '..');

/**
 * Name of a path part by the rule of names (P-049: english lowercase, no diacritics, no spaces): diacritics removed,
 * lowercase, every run of spaces and characters other than a-z 0-9 . _ - becomes one `-`.
 */
export function normalizeName(part) {
  const s = part.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'subor';
}

/**
 * Write ops of a folder added as sources (save.mjs source <folder>): every file under it to
 * <sources>/<topic>/<name>/<path> (name: --as, may be a subpath, else the normalized folder name), each path part
 * normalized by the rule of names; the mapping lists the files whose path changed. Refused as a whole (nothing written)
 * for a nested repository, a symlink, a file over the limit, a target that exists or two files on one target.
 * Returns { ops: [{ rel, content }], mapping: [[from, to]], date }.
 */
export function sourceAddDirOps(projectDir, topic, dir, { name = null, policy = {}, now = new Date() } = {}) {
  if (!validTopic(topic)) throw new Error(`neplatná téma: ${topic}`);
  const abs = path.resolve(dir);
  const root = dataPath(projectDir, 'materialy');
  if (isInside(root, abs)) throw new Error(`${dir} je už v zdrojoch: priečinok zo zdrojov sa nepridáva znova`);
  if (name !== null && !validSubpath(name)) throw new Error(`neplatné meno: ${name} (meno alebo podcesta a/b bez .. a lomky na začiatku)`);
  const max = maxBytes(policy);
  const base = name ? name.split('/') : [normalizeName(path.basename(abs))];
  const files = [];
  const problems = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) problems.push(`${r}: symbolický odkaz`);
      else if (e.isDirectory()) { if (e.name === '.git') problems.push(`${r}: vnorené repo gitu`); else walk(path.join(d, e.name), r); }
      else if (e.isFile()) files.push(r);
    }
  };
  walk(abs, '');
  if (!files.length) throw new Error(`${dir}: priečinok bez súborov`);
  const ops = [];
  const mapping = [];
  const seen = new Map();
  for (const r of files) {
    const st = fs.statSync(path.join(abs, r));
    if (st.size > max) { problems.push(`${r}: ${(st.size / MB).toFixed(0)} MB nad limitom ${max / MB} MB (save.mjs source --record)`); continue; }
    const parts = r.split('/').map(normalizeName);
    const target = path.join(root, topic, ...base, ...parts);
    const rel = path.relative(projectDir, target).split(path.sep).join('/');
    if (seen.has(rel)) { problems.push(`${r} a ${seen.get(rel)}: rovnaké meno ${rel}`); continue; }
    seen.set(rel, r);
    if (fs.existsSync(target)) { problems.push(`${rel} už existuje`); continue; }
    if (parts.join('/') !== r) mapping.push([r, parts.join('/')]);
    ops.push({ rel, content: fs.readFileSync(path.join(abs, r)) });
  }
  if (problems.length) throw new Error(`priečinok ${dir} sa nepridal (nič sa nezapísalo):\n  ${problems.join('\n  ')}`);
  return { ops, mapping, date: now.toISOString().slice(0, 10) };
}

/**
 * Write op of a result of a topic's work (save.mjs result, D-0056): into the work of the topic in its topic home
 * `home` (topicHome): layout 2 temy/<topic>/<name>, layout 1 materialy/<topic>/<name> (results lie with the sources there).
 * The topic record, the handover and tmp/ are not a name of a result; an existing file is overwritten only with `replace`
 * (a new version of the same result, the old one stays in git history), never in layout 1, where results lie with sources.
 * Returns { rel (posix, relative to `home`), content (Buffer) }.
 */
export function resultAddOp(home, topic, file, { name = null, policy = {}, replace = false } = {}) {
  if (hasScratch(home)) {
    if (replace) throw new Error('--replace: iba v tvare dát 2 (v tvare 1 ležia výsledky pri zdrojoch, tie sa nemenia); zvoľ iné meno (--as <meno>)');
    return sourceAddOp(home, topic, file, { name, policy });
  }
  if (!validTopic(topic)) throw new Error(`neplatná téma: ${topic}`);
  const abs = path.resolve(file);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`súbor neexistuje: ${file}`); }
  if (!st.isFile()) throw new Error(`nie je súbor: ${file}`);
  const max = maxBytes(policy);
  if (st.size > max) throw new Error(`súbor ${(st.size / MB).toFixed(0)} MB je nad limitom ${max / MB} MB (nejde do gitu): nechaj ho v pracovných súboroch témy`);
  if (name !== null && (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..')) throw new Error(`neplatné meno: ${name}`);
  const L = layoutOf(home);
  const base = name || path.basename(abs);
  if ([L.topicFile, L.handover, L.topicTmp].includes(base)) throw new Error(`${base}: meno patrí workflow témy, zvoľ iné (--as <meno>)`);
  const target = dataPath(home, 'topics', topic, base);
  if (fs.existsSync(target)) {
    if (!replace) throw new Error(`${dataRel(home, 'topics', topic, base)} už existuje: novú verziu toho istého výsledku zapíš s --replace (stará ostane v histórii gitu), iný výsledok pod iným menom (--as <meno>)`);
    if (!fs.statSync(target).isFile()) throw new Error(`${dataRel(home, 'topics', topic, base)} nie je súbor: --replace prepíše iba súbor výsledku`);
  }
  return { rel: dataRel(home, 'topics', topic, base), content: fs.readFileSync(abs) };
}

/** Files in materialy/ over the limit: [{ path (relative to the project), size }]. Symlinks and .git are skipped. */
export function oversized(projectDir, policy) {
  const root = dataPath(projectDir, 'materialy');
  const max = maxBytes(policy);
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else if (e.isFile()) {
        const size = fs.statSync(p).size;
        if (size > max) found.push({ path: path.relative(projectDir, p).split(path.sep).join('/'), size });
      }
    }
  };
  walk(root);
  return found;
}

const SCRATCH_SKIP = new Set(['.git', 'node_modules', '.cache', '__pycache__']);

/**
 * Files in the work files of a topic changed since `sinceMs`: { count, files } (newest first, relative to `projectDir`,
 * the repository that holds them: the topic home, topicHome). A directory with its own .git (a clone) is skipped, its work
 * lives in that repo. The walk stops after `budget` entries. Work files are not in git (P-052): inputs and results left
 * there were lost (operator 2026-11-08); done reminds of them.
 */
export function scratchSince(projectDir, sinceMs, { budget = 5000, topic = null } = {}) {
  const found = [];
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root && entries.some((e) => e.name === '.git')) return;
    for (const e of entries) {
      if (++seen > budget) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SCRATCH_SKIP.has(e.name)) walk(p); } else if (e.isFile()) {
        let m;
        try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m >= sinceMs) found.push({ path: path.relative(projectDir, p).split(path.sep).join('/'), m });
      }
    }
  };
  // Layout 2: the work files of the topic (temy/<topic>/tmp, outside git).
  const root = workDirFor(projectDir, topic);
  walk(root);
  found.sort((a, b) => b.m - a.m);
  return { count: found.length, files: found.map((f) => f.path) };
}

/**
 * Where the results of a topic's work go (D-0056), as a message names it: the topic home in layout 1 `materialy/<topic>/`
 * (with the sources), in layout 2 `temy/<topic>/` of the topic home (`brain temy/<topic>/` for a brain beside the project).
 */
export function topicResultsLabel(brainDir, projectDir, topic = null) {
  const home = topicHome(brainDir, projectDir);
  const t = topic || '<téma>';
  if (!home || hasScratch(home)) return `${materialyDir(home || projectDir)}/${t}/`;
  const inBrain = separateProject(brainDir, projectDir) && path.resolve(home) === path.resolve(brainDir);
  return `${inBrain ? 'brain ' : ''}${dataRel(home, 'topics', t)}/`;
}

/**
 * One reminder line for done, or null: work files of the topic changed since the topic was taken or last closed (P-062).
 * The work files are in the topic home (topicHome(brainDir, projectDir)): a brain in layout 2 holds them in temy/<topic>/tmp.
 */
export function scratchReminder(projectDir, sinceMs, topic, brainDir = null) {
  if (!projectDir || !Number.isFinite(sinceMs)) return null;
  const home = topicHome(brainDir, projectDir);
  const { count, files } = scratchSince(home, sinceMs, { topic });
  if (!count) return null;
  const shown = files.slice(0, 5).join(', ') + (count > 5 ? `, … (+${count - 5})` : '');
  // A brain of layout 3 as its own project keeps no sources (spec 4): only the results of the topic.
  const sources = hasData(projectDir, 'materialy') ? `${materialyDir(projectDir)}/${topic || '<téma>'}/` : null;
  const results = topicResultsLabel(brainDir, projectDir, topic);
  const move = !sources ? `Inputs from outside move now to zdroje/<topic>/ of the main target repo (save.mjs source), results of work to ${results} (save.mjs result; skill workflow:save)` : results === sources
    ? `Inputs from outside and results of work move now to ${sources} (save.mjs source, save.mjs result; skill workflow:save)`
    : `Inputs from outside move now to ${sources}${separateProject(brainDir, projectDir) ? ' of the project repo' : ''} (save.mjs source), results of work to ${results} (save.mjs result; skill workflow:save)`;
  return `scratch: ${count} file(s) changed since ${localTime(sinceMs)} are only in ${topicWorkLabel(brainDir, projectDir, topic)} (not in git): ${shown}. ${move}, procedures to a skill; intermediate results stay (P-062, P-052)`;
}

// D-0032 (knowledge point 4): a worker result lived only in the conversation; the hook keeps it with the topic.
export const RESULTS_FILE = LAYOUT.results;

/** The first line of the worker task: the first non-empty, non-heading line of the first user message of its transcript. */
export function workerTaskLine(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(256 * 1024); text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); }
  } catch { return ''; }
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user' && entry?.message?.role !== 'user') continue;
    const c = entry?.message?.content;
    const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x?.type === 'text' ? x.text : '')).join('\n') : '';
    const first = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (first) return first.slice(0, 200);
  }
  return '';
}

/** One entry of topics/<id>/results.md: a heading (time, agent, task line) and the result as returned. */
export function resultEntry({ at, agent, task, result }) {
  return `\n## ${at} ${agent}${task ? ` – ${task.replace(/\s+/g, ' ')}` : ''}\n\n${String(result || '').trim()}\n`;
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Work file paths in a text, by layout (memoized): layout 1 `scratch/...`, layout 2 `temy/<topic>/tmp/...`.
const SCRATCH_REFS = new Map();
function scratchRef(version) {
  if (!SCRATCH_REFS.has(version)) {
    const L = layoutFor(version);
    const dir = L.scratch !== null ? esc(L.scratch) : `${esc(L.topics)}\\/[^/\\s\`'")]+\\/${esc(L.topicTmp)}`;
    SCRATCH_REFS.set(version, new RegExp(`(?:^|[\\s\`'"(])((?:\\/[^\\s\`'")]+\\/)?${dir}\\/[^\\s\`'"),;]+)`, 'g'));
  }
  return SCRATCH_REFS.get(version);
}

/**
 * Work file paths cited in a results.md text that still exist under `projectDir` (only there, not in git): relative paths.
 * `projectDir` is the repository of the work files, the topic home (topicHome): a brain in layout 2 beside the project.
 */
export function citedScratch(projectDir, text) {
  const seen = new Set();
  const v = dataLayoutVersion(projectDir);
  const scratch = hasScratch(projectDir);
  for (const m of String(text || '').matchAll(scratchRef(v))) {
    let p = m[1].replace(/[.:]+$/, '');
    const inWork = (abs) => (scratch ? isInside(dataPath(projectDir, 'scratch'), abs) : isInside(dataPath(projectDir, 'topics'), abs) && path.relative(dataPath(projectDir, 'topics'), abs).split(path.sep)[1] === layoutOf(projectDir).topicTmp);
    if (path.isAbsolute(p)) { if (!inWork(p)) continue; p = path.relative(projectDir, p); }
    const under = scratch ? dataRel(projectDir, 'scratch', '') : `${dataRel(projectDir, 'topics')}/`;
    if (!p.startsWith(under) || p === under || !inWork(path.join(projectDir, p))) continue;
    if (fs.existsSync(path.join(projectDir, p))) seen.add(p.split(path.sep).join('/'));
  }
  return [...seen];
}

/** Untracked files under docs/ and materialy/ of a git repo (content not in git): relative paths, [] when clean or no git. */
export function untrackedKnowledge(dir) {
  const dirs = ['docs', 'materialy'].filter((n) => hasData(dir, n)).map((n) => dataRel(dir, n));
  if (!dirs.length) return [];
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...dirs], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
}
