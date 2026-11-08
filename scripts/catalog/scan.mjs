// Scan of the sources: walk with lstat, ignore globs, size+mtime comparison with the index, sha256 only of new and
// changed files within a time budget, triage of kind, moves and duplicates by hash, atomic write of the index.
// Everything here is synchronous (a hook is synchronous) and never follows a symlink.
import fs from 'node:fs';
import path from 'node:path';
import { extOf, kindOf } from './kinds.mjs';
import { matcher } from './glob.mjs';
import { hashFile } from './hash.mjs';
import { withLock, LockBusy } from './lock.mjs';
import { paths, readIndex, writeIndex, readJsonSafe, writeAtomic, writeManifest, recordError, clearError } from './index.mjs';
import { SCHEMA_VERSION } from './schema.mjs';
import { detectTools } from './tools.mjs';
import { isInside } from '../util.mjs';

const LOCAL_IGNORE_LINES = new Set(['local', 'local/', '/local', '/local/', 'local/*', '/local/*', 'local/catalog', 'local/catalog/', '/local/catalog', '/local/catalog/']);

/** Adds `local/catalog/` to the repo .gitignore when nothing ignores it yet. Returns true when it changed the file. */
export function ensureGitignore(repo) {
  try {
    if (!fs.statSync(path.join(repo, '.git'), { throwIfNoEntry: false })) return false;
    const file = path.join(repo, '.gitignore');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split(/\r?\n/).some((l) => LOCAL_IGNORE_LINES.has(l.trim()))) return false;
    const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, `${cur}${sep}# katalóg dát (derivát, súkromné, pregenerovateľný)\nlocal/catalog/\n`);
    return true;
  } catch {
    return false;
  }
}

// Depth-first order of directories: by path segments, so "a" < "a/b" < "a-b" (a plain string compare would put "a-b" first).
function dfsCompare(a, b) {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
}
const isAncestor = (dir, rel) => dir === '' || rel === dir || rel.startsWith(`${dir}/`);

/**
 * Lists the files of a source. Over budget it stops after a whole directory and returns `cursor` (the last listed directory);
 * `resumeFrom` continues after it, so a tree bigger than one budget is still covered by repeated runs. At least one
 * directory is listed per run. `finished`: the whole tree was visited; `complete`: also without unreadable entries.
 */
function walk(source, cfg, { deadline, maxFiles, resumeFrom = null }) {
  const ignored = matcher(cfg.ignore);
  const files = [];
  let complete = true;
  let finished = true;
  let cursor = null;
  let listed = 0;
  const stack = [''];
  while (stack.length) {
    if (listed > 0 && (Date.now() > deadline || files.length >= maxFiles)) { finished = false; complete = false; break; }
    const rel0 = stack.pop();
    const abs0 = rel0 ? path.join(source.path, rel0) : source.path;
    let entries;
    try { entries = fs.readdirSync(abs0, { withFileTypes: true }); } catch { complete = false; continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    // a directory on the way to the cursor (or the cursor itself) was already listed in the previous run: only re-entered
    const done = resumeFrom !== null && isAncestor(rel0, resumeFrom);
    if (!done) { listed++; cursor = rel0; }
    const dirs = [];
    for (const e of entries) {
      const rel = rel0 ? `${rel0}/${e.name}` : e.name;
      const abs = path.join(abs0, e.name);
      if (abs === cfg.dir || ignored(rel)) continue;
      if (e.isDirectory()) {
        if (resumeFrom === null || rel0 === resumeFrom || isAncestor(rel, resumeFrom) || dfsCompare(rel, resumeFrom) > 0) dirs.push(rel);
        continue;
      }
      if (done) continue;
      if (e.isSymbolicLink()) {
        let lst; let target;
        try { lst = fs.lstatSync(abs); target = fs.readlinkSync(abs); } catch { complete = false; continue; }
        files.push({ rel, abs, lst, link: target });
      } else if (e.isFile()) {
        let lst;
        try { lst = fs.lstatSync(abs); } catch { complete = false; continue; }
        files.push({ rel, abs, lst });
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, complete, finished, cursor: finished ? null : (cursor ?? resumeFrom) };
}

const iso = (ms) => new Date(ms).toISOString();

function newRow(source, f, nowIso) {
  const ext = extOf(f.rel);
  return {
    v: SCHEMA_VERSION, source: source.name, path: f.rel, ext, kind: kindOf(f.rel), size: f.lst.size, mtime: iso(f.lst.mtimeMs),
    hash: null, hash_mode: null, status: 'pending', dup_of: null, moved_from: null, profile: null, error: null, changed_at: nowIso,
  };
}

function symlinkRow(source, f, nowIso, old) {
  const abs = path.resolve(path.dirname(f.abs), f.link);
  const inside = isInside(source.path, abs);
  const target = inside ? path.relative(source.path, abs).split(path.sep).join('/') : f.link;
  return {
    v: SCHEMA_VERSION, source: source.name, path: f.rel, ext: extOf(f.rel), kind: 'symlink', size: f.lst.size, mtime: iso(f.lst.mtimeMs),
    hash: null, hash_mode: null, status: 'profiled', dup_of: inside ? target : null, moved_from: null,
    profile: { target: inside ? target : f.link, inside_root: inside }, error: null, changed_at: old && old.kind === 'symlink' && old.profile?.target === (inside ? target : f.link) ? old.changed_at : nowIso,
    desc_v: null,
  };
}

const hasContent = (r) => !!(r.profile || r.desc);

/** Rows -> { total, kinds, statuses, ... } (also used by boot lines and status). */
export function summarize(rows) {
  const kinds = {};
  const statuses = {};
  let duplicates = 0;
  let hashPending = 0;
  for (const r of rows) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.status === 'duplicate') duplicates++;
    if (r.hash == null && r.kind !== 'symlink' && r.status !== 'error') hashPending++;
  }
  return { total: rows.length, kinds, statuses, duplicates, hash_pending: hashPending };
}

/** Duplicates by full hash: the lexicographically smallest path is the original; the others are `duplicate` (idempotent). */
export function markDuplicates(rows) {
  for (const r of rows) {
    if (r.status === 'duplicate') { r.status = r.dup_prev || 'pending'; delete r.dup_prev; }
    if (r.kind !== 'symlink') r.dup_of = null;
  }
  const groups = new Map();
  for (const r of rows) {
    if (!r.hash || r.hash_mode !== 'full' || !r.size || r.kind === 'symlink') continue;
    if (!groups.has(r.hash)) groups.set(r.hash, []);
    groups.get(r.hash).push(r);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const r of g.slice(1)) {
      r.dup_prev = r.status === 'stale' ? (r.was || 'pending') : r.status;
      r.status = 'duplicate';
      r.dup_of = g[0].path;
    }
  }
}

/**
 * Scans one source. Returns a summary; writes the index only when the source was readable. `deadline` bounds everything,
 * `hashDeadline` the hashing. At least one file is hashed per run so that a budget never blocks progress.
 */
export function scanSource(cfg, source, { deadline = Infinity, hashDeadline = Infinity, full = false } = {}) {
  const nowIso = new Date().toISOString();
  const prior = readIndex(cfg.dir, source.name);
  const state = readJsonSafe(paths(cfg.dir, source.name).state, {}) || {};
  const base = { name: source.name, mode: source.mode, available: true, new: 0, changed: 0, moved: 0, removed: 0 };
  const off = (reason) => ({ ...base, available: false, reason, ...summarize(prior) });

  let st;
  try { st = fs.statSync(source.path); } catch { return off('zdroj nedostupný'); }
  if (!st.isDirectory()) return off('zdroj nie je priečinok');

  const resumeFrom = full ? null : (typeof state.walk_cursor === 'string' ? state.walk_cursor : null);
  const walked0 = walk(source, cfg, { deadline, maxFiles: full ? Infinity : cfg.scan.max_files, resumeFrom });
  const files = walked0.files;
  // only a walk from the start that saw everything may delete rows or detect moves; a resumed one covers the tail only
  const complete = walked0.complete && walked0.finished && resumeFrom === null;
  if (complete && files.length === 0 && prior.length > 0) return off('zdroj je prázdny'); // an unmounted disk looks like this

  const priorMap = new Map();
  for (const r of prior) {
    const row = { ...r, moved_from: null };
    if (row.status === 'duplicate') { row.status = row.dup_prev || 'pending'; delete row.dup_prev; row.dup_of = null; }
    priorMap.set(row.path, row);
  }
  const walked = new Set(files.map((f) => f.rel));
  const rows = new Map();
  const todo = [];
  for (const f of files) {
    const p = priorMap.get(f.rel);
    if (f.link !== undefined) { rows.set(f.rel, symlinkRow(source, f, nowIso, p)); continue; }
    const mtime = iso(f.lst.mtimeMs);
    if (p && p.kind !== 'symlink' && !full && p.size === f.lst.size && p.mtime === mtime) {
      rows.set(f.rel, p);
      if (p.hash == null && p.status !== 'error') todo.push(f);
      continue;
    }
    let row;
    if (p && p.kind !== 'symlink') {
      row = { ...p, ext: extOf(f.rel), kind: kindOf(f.rel), size: f.lst.size, mtime, changed_at: nowIso, error: null };
      if (p.hash && !row.prev_hash) row.prev_hash = p.hash;
      if (hasContent(p)) {
        if (p.status !== 'stale') row.was = ['profiled', 'described'].includes(p.status) ? p.status : p.was;
        row.status = 'stale';
      } else row.status = 'pending';
      row.hash = null;
      row.hash_mode = null;
    } else {
      row = newRow(source, f, nowIso);
      base.new++;
    }
    rows.set(f.rel, row);
    todo.push(f);
  }

  // Hashing within the budget, starting after the cursor of the previous run so that one slow file cannot starve the rest.
  let order = todo;
  if (state.cursor) {
    const at = todo.findIndex((f) => f.rel > state.cursor);
    if (at > 0) order = todo.slice(at).concat(todo.slice(0, at));
  }
  let cursor = null;
  let hashed = 0;
  for (const f of order) {
    if (hashed > 0 && Date.now() > hashDeadline) { break; }
    const row = rows.get(f.rel);
    const h = hashFile(f.abs, row.size, { partialMb: cfg.partial_hash_mb });
    hashed++;
    cursor = f.rel;
    if (!h) { row.status = 'error'; row.error = { code: 'unreadable' }; row.hash = null; delete row.prev_hash; continue; }
    row.hash = h.hash;
    row.hash_mode = h.mode;
    if (row.prev_hash) {
      if (row.prev_hash === h.hash) { // same content, only the timestamp moved
        row.status = row.was || (row.profile ? 'profiled' : 'pending');
        if (row.dup_prev) delete row.dup_prev;
      } else base.changed++;
      delete row.prev_hash;
      delete row.was;
      if (row.status === 'stale' && row.kind !== kindOf(row.path)) row.status = 'pending';
    }
  }
  const unfinished = order.some((f) => rows.get(f.rel).hash == null && rows.get(f.rel).status !== 'error');
  if (!unfinished) cursor = null;

  // Moves: a new path whose hash belonged to a path that vanished carries over that row (hash is the truth, not the name).
  if (complete) {
    const vanished = new Map();
    for (const r of prior) {
      if (walked.has(r.path) || !r.hash || !r.size || r.kind === 'symlink') continue;
      if (!vanished.has(r.hash)) vanished.set(r.hash, []);
      vanished.get(r.hash).push(priorMap.get(r.path));
    }
    for (const f of files) {
      if (f.link !== undefined || priorMap.has(f.rel)) continue;
      const row = rows.get(f.rel);
      const src = row.hash && vanished.get(row.hash)?.shift();
      if (!src) continue;
      const kind = kindOf(f.rel);
      const moved = { ...src, path: f.rel, ext: extOf(f.rel), size: row.size, mtime: row.mtime, moved_from: src.path, changed_at: nowIso, hash: row.hash, hash_mode: row.hash_mode };
      if (kind !== src.kind) { moved.kind = kind; moved.profile = null; moved.status = 'pending'; }
      rows.set(f.rel, moved);
      base.new--;
      base.moved++;
    }
    for (const r of prior) if (!walked.has(r.path)) base.removed++;
  } else {
    for (const [p, r] of priorMap) if (!walked.has(p)) rows.set(p, r); // incomplete walk: rows not seen stay
  }

  const list = [...rows.values()];
  markDuplicates(list);
  writeIndex(cfg.dir, source.name, list);
  writeAtomic(paths(cfg.dir, source.name).state, JSON.stringify({ v: SCHEMA_VERSION, scanned_at: nowIso, complete, cursor, walk_cursor: walked0.cursor, files: list.length }) + '\n');
  return { ...base, complete, cursor, walk_cursor: walked0.cursor, ...summarize(list) };
}

/**
 * Scan of all sources under the `.lock` of the catalog. A busy catalog skips the scan (`skipped_busy`); an exception of one
 * source goes to state/last-error.json and does not stop the others. Returns { sources, skipped_busy?, errors, gitignore_added }.
 */
export function scanAll(cfg, { budgetMs = cfg.scan.hook_budget_ms, hashBudgetMs = cfg.scan.hash_budget_ms, waitMs = 1000, full = false, only = null } = {}) {
  const out = { sources: [], errors: [], gitignore_added: false, skipped_busy: false };
  if (!cfg.enabled) return out;
  const started = Date.now();
  const deadline = full ? Infinity : started + budgetMs;
  try {
    withLock(paths(cfg.dir, '_').lock, { waitMs }, () => {
      out.gitignore_added = ensureGitignore(cfg.repo);
      fs.mkdirSync(path.join(cfg.dir, 'index'), { recursive: true });
      const summaries = {};
      for (const source of cfg.sources) {
        if (only && source.name !== only) continue;
        try {
          const hashDeadline = full ? Infinity : Math.min(deadline, Date.now() + hashBudgetMs);
          const s = scanSource(cfg, source, { deadline, hashDeadline, full });
          out.sources.push(s);
          summaries[source.name] = { path: source.path, mode: source.mode, available: s.available, reason: s.reason || null, scanned_at: new Date().toISOString(), complete: s.complete ?? null, total: s.total, kinds: s.kinds, statuses: s.statuses, duplicates: s.duplicates, hash_pending: s.hash_pending, last_changes: s.new + s.changed + s.moved + s.removed, last_scan: { new: s.new, changed: s.changed, moved: s.moved, removed: s.removed } };
          if (s.available) clearError(cfg.dir, source.name);
        } catch (err) {
          recordError(cfg.dir, source.name, err?.message || err);
          out.errors.push({ source: source.name, message: String(err?.message || err).split('\n')[0] });
        }
      }
      if (Object.keys(summaries).length) writeManifest(cfg.dir, { scanned_at: new Date().toISOString(), tools: detectTools(), sources: summaries });
    });
  } catch (err) {
    if (err instanceof LockBusy) out.skipped_busy = true;
    else {
      try { recordError(cfg.dir, '*', err?.message || err); } catch { /* the catalog directory may be unwritable */ }
      out.errors.push({ source: '*', message: String(err?.message || err).split('\n')[0] });
    }
  }
  out.elapsed_ms = Date.now() - started;
  return out;
}
