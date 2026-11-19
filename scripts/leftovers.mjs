// Leftovers outside git in the folders of an older data layout (doma-pc 2026-11-16): a move of the data takes the tracked
// files, and what git does not track stays behind on the machine: generated files (__pycache__, *.pyc, .DS_Store) that kept
// a folder of data 1 alive after its content moved (materialy/ holding only .pyc), and work files (scratch/ of 2.7 GB of
// exports) nobody looked at. Operator: no junk may stay after a migration, and data does not pile up without triage.
//   - junk (generated, never work): removed by the migration and by --check --fix, the folders it leaves empty too;
//   - other files outside git in an old folder: reported (preview blocker, --check problem) with size and file count per
//     entry, so the operator triages them; nothing that is not junk is deleted by code;
//   - work folders (topics/<id>/tmp/) over a limit: a finding with the largest files (pre-release), and a large one moves
//     in a migration only with the operator's approval.
// Read and delete only: tracked files are never touched (a folder that git tracks a file in is live data, only its
// untracked junk goes).
import fs from 'node:fs';
import path from 'node:path';
import { git } from './util.mjs';
import { layoutFor, ROLE_BRAIN, ROLE_REPO } from './layout.mjs';

/** Folders and files that are generated, never work (operator 2026-11-16: "materialy which held only pycache"). */
export const JUNK_DIRS = Object.freeze(new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.ipynb_checkpoints']));
const JUNK_FILE = /^(\.DS_Store|Thumbs\.db|ehthumbs\.db|desktop\.ini|\._.+)$|\.py[co]$/i;
/** A path (posix, relative) that is junk: under a junk folder or a junk file name. */
export const isJunk = (rel) => {
  const parts = String(rel).split('/').filter(Boolean);
  return parts.some((p) => JUNK_DIRS.has(p)) || JUNK_FILE.test(parts.at(-1) || '');
};

/** A work folder this large (or with this many files) is not moved without the operator's approval. */
export const LARGE_BYTES = 100 * 1024 * 1024;
export const LARGE_FILES = 500;
/** Work files of one repository above this size are a finding (pre-release): data does not pile up unseen. */
export const TMP_WARN_BYTES = 500 * 1024 * 1024;

export const isLarge = (s) => s.bytes > LARGE_BYTES || s.files > LARGE_FILES;
/** Size for people: "317 MB", "2.7 GB", "12 kB". */
export function human(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
/** "2083 file(s), 317 MB". */
export const sizeText = (s) => `${s.files} file(s), ${human(s.bytes)}`;

const posix = (p) => String(p).split(path.sep).join('/');
const ROLE = (role) => (role === ROLE_REPO || role === 'project' ? ROLE_REPO : ROLE_BRAIN);

/**
 * Folders of the older layouts a repository of `version` and `role` no longer has: [{ rel, report }]. `report`: other
 * files outside git there are leftovers to triage; false (docs/ of a project repo, where a code repo may keep its own
 * build output) only the junk counts. Data 2.0 lists the folders of data 1; data 2.1 those of data 2.0 and of data 1
 * (a machine that pulled the move of 2.0 has the untracked files of data 1 still).
 */
export function oldFolders(version, role = ROLE_BRAIN) {
  const repo = ROLE(role) === ROLE_REPO;
  const v = Number(version);
  if (v === 2) {
    return repo
      ? [['agentic', true], ['topics', true], ['scratch', true], ['materialy', true], ['docs', false]].map(([rel, report]) => ({ rel, report }))
      : ['memory', 'decisions', 'rules', 'skills', 'exceptions', 'logs', 'runbooks', 'topics', 'scratch', 'materialy', 'docs'].map((rel) => ({ rel, report: true }));
  }
  if (v === 3) {
    return repo
      ? [['temy', true], ['.brain/archive', true], ['agentic', true], ['scratch', true], ['materialy', true], ['docs', false]].map(([rel, report]) => ({ rel, report }))
      : ['.brain', 'temy', 'vystupy', 'zdroje', 'scratch', 'materialy', 'docs'].map((rel) => ({ rel, report: true }));
  }
  return [];
}

/** Tracked files under `rel` (posix), as a set; a repository git does not read: null. */
function trackedUnder(dir, rel) {
  const r = git(['-c', 'core.quotepath=false', 'ls-files', '-z', '--', `${rel}/`], { cwd: dir });
  return r.ok ? new Set(r.stdout.split('\0').filter(Boolean)) : null;
}

/**
 * Bytes of a file on the disk once: the names of one hardlinked file count its size at the first name only (2026-11-19:
 * 86 backups made hardlinks of identical ones; the overview still reported 8.9 GB of the 3.3 GB on the disk). `seen`: the
 * inodes already counted in this walk.
 */
export function diskBytes(st, seen) {
  if (st.nlink <= 1 || !seen) return st.size;
  const key = `${st.dev}:${st.ino}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  return st.size;
}

/** Files and bytes under an absolute path, a nested repository and links counted as they are (not followed); a hardlinked file once. */
export function sizeOf(abs, seen = new Set()) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return { files: 0, bytes: 0 }; }
  if (!st.isDirectory()) return { files: 1, bytes: diskBytes(st, seen) };
  const out = { files: 0, bytes: 0 };
  let entries = [];
  try { entries = fs.readdirSync(abs); } catch { return out; }
  for (const e of entries) { const s = sizeOf(path.join(abs, e), seen); out.files += s.files; out.bytes += s.bytes; }
  return out;
}

/**
 * The leftovers of one repository: { junk: [rel], other: [{ path, files, bytes, why }], folders: [rel] } (posix, relative
 * to `dir`). `other` is grouped per entry of an old folder (scratch/<entry>, a nested repository as one entry), so the
 * operator triages entries, not thousands of files. `skip(rel)`: paths the caller takes care of (the work folders a
 * migration moves). Tracked files are never listed.
 */
export function leftovers(dir, { version, role = ROLE_BRAIN, folders = null, skip = () => false } = {}) {
  const out = { junk: [], other: [], folders: [] };
  const groups = new Map();
  for (const f of folders || oldFolders(version, role)) {
    const top = path.join(dir, ...f.rel.split('/'));
    let st;
    try { st = fs.lstatSync(top); } catch { continue; }
    if (!st.isDirectory()) continue;
    const tracked = trackedUnder(dir, f.rel);
    if (tracked === null) continue;
    out.folders.push(f.rel);
    const walk = (rel) => {
      if (skip(rel)) return;
      const abs = path.join(dir, ...rel.split('/'));
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = `${rel}/${e.name}`;
        if (skip(r) || tracked.has(r)) continue;
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (JUNK_DIRS.has(e.name)) { if (![...tracked].some((t) => t.startsWith(`${r}/`))) out.junk.push(`${r}/`); continue; }
          // A nested repository is one entry, never entered (its own history is not junk).
          if (fs.existsSync(path.join(abs, e.name, '.git'))) { if (f.report) add(f.rel, r, sizeOf(path.join(abs, e.name)), 'a nested repository'); continue; }
          walk(r);
          continue;
        }
        if (isJunk(r)) { out.junk.push(r); continue; }
        if (!f.report) continue;
        let size = 0;
        try { size = fs.lstatSync(path.join(abs, e.name)).size; } catch { /* gone */ }
        add(f.rel, r, { files: 1, bytes: size }, null);
      }
    };
    walk(f.rel);
  }
  function add(top, rel, s, why) {
    const rest = rel.slice(top.length + 1).split('/');
    const key = rest.length > 1 || why ? `${top}/${rest[0]}/` : rel;
    if (!groups.has(key)) groups.set(key, { path: key, files: 0, bytes: 0, why: null });
    const g = groups.get(key);
    g.files += s.files;
    g.bytes += s.bytes;
    if (why) g.why = why;
  }
  out.other = [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  out.junk.sort();
  return out;
}

/** Empty folders under `rel` removed bottom-up, `rel` itself too when it ends empty: [rel/]. A nested repository is left. */
export function pruneEmptyTree(dir, rel) {
  const abs = path.join(dir, ...rel.split('/'));
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  if (entries.some((e) => e.name === '.git')) return [];
  const out = [];
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) out.push(...pruneEmptyTree(dir, `${rel}/${e.name}`));
  try { if (!fs.readdirSync(abs).length) { fs.rmdirSync(abs); out.push(`${rel}/`); } } catch { /* stays */ }
  return out;
}

/**
 * Junk of the old folders removed, then the folders it leaves empty: { removed: [rel], pruned: [rel/], left } (left: the
 * leftovers that are not junk, for the report). Only untracked junk is deleted (generated files, never work).
 */
export function removeJunk(dir, opts = {}) {
  const found = leftovers(dir, opts);
  const removed = [];
  for (const rel of found.junk) {
    try { fs.rmSync(path.join(dir, ...rel.replace(/\/$/, '').split('/')), { recursive: true, force: true }); removed.push(rel); } catch { /* stays, reported */ }
  }
  const pruned = found.folders.flatMap((rel) => pruneEmptyTree(dir, rel));
  return { removed, pruned, left: found.other };
}

/** One line per leftover entry (largest first, `max` of them): "scratch/exports/ (2083 file(s), 317 MB)". */
export function leftoverLines(other, { max = 10 } = {}) {
  const lines = other.slice(0, max).map((g) => `${g.path} (${sizeText(g)}${g.why ? `, ${g.why}` : ''})`);
  if (other.length > max) {
    const rest = other.slice(max).reduce((s, g) => ({ files: s.files + g.files, bytes: s.bytes + g.bytes }), { files: 0, bytes: 0 });
    lines.push(`… ${other.length - max} more entr${other.length - max === 1 ? 'y' : 'ies'} (${sizeText(rest)})`);
  }
  return lines;
}

/** The text of the junk found: "14 generated file(s) (__pycache__, *.pyc, .DS_Store) in materialy/, docs/". */
export function junkText(junk) {
  const tops = [...new Set(junk.map((r) => r.split('/')[0]))].map((t) => `${t}/`);
  return `${junk.length} generated file(s) or folder(s) (__pycache__, *.pyc, .DS_Store …) in ${tops.join(', ')}`;
}

/**
 * Work folders of a repository (topics/<id>/tmp/ of its layout): [{ path, files, bytes, largest: [{ path, bytes }] }],
 * the largest first; and the sum. The pre-release check reports a repository over TMP_WARN_BYTES.
 */
export function workFolders(dir, map) {
  if (!map?.topics || !map?.topicTmp) return { list: [], files: 0, bytes: 0 };
  const root = path.join(dir, ...map.topics.split('/'));
  const list = [];
  let ids = [];
  try { ids = fs.readdirSync(root); } catch { return { list, files: 0, bytes: 0 }; }
  for (const id of ids) {
    const abs = path.join(root, id, map.topicTmp);
    if (!fs.existsSync(abs)) continue;
    const files = [];
    const seen = new Set();
    const walk = (a) => {
      let entries = [];
      try { entries = fs.readdirSync(a, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(a, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
        else { try { files.push({ path: posix(path.relative(dir, p)), bytes: diskBytes(fs.lstatSync(p), seen) }); } catch { /* gone */ } }
      }
    };
    walk(abs);
    files.sort((a, b) => b.bytes - a.bytes);
    list.push({ path: `${map.topics}/${id}/${map.topicTmp}/`, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), largest: files.slice(0, 5) });
  }
  list.sort((a, b) => b.bytes - a.bytes);
  return { list, files: list.reduce((n, w) => n + w.files, 0), bytes: list.reduce((n, w) => n + w.bytes, 0) };
}

/** Map of a repository for its work folders (data 2.0 has one map, data 2.1 one per role). */
export const workMap = (version, role) => layoutFor(version, ROLE(role));

/**
 * The finding of a repository whose work folders outside git exceed TMP_WARN_BYTES (doma-pc 2026-11-16: 3 GB of exports
 * piled up unseen): { dir, files, bytes, text } or null. The text names the largest work folders and files.
 */
export function workFinding(dir, map, { limit = TMP_WARN_BYTES } = {}) {
  const w = workFolders(dir, map);
  if (w.bytes <= limit) return null;
  const name = path.basename(dir);
  const folders = w.list.slice(0, 3).map((f) => `${f.path} ${human(f.bytes)}`).join(', ');
  const files = w.list.flatMap((f) => f.largest).sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((f) => `${f.path} ${human(f.bytes)}`).join(', ');
  return { dir, files: w.files, bytes: w.bytes, text: `${name}: ${sizeText(w)} of work files outside git (limit ${human(limit)}): ${folders}; largest: ${files}. Triage them with the operator: remove exports, backups and copies not needed; a finished work belongs to vystupy/ or zdroje/` };
}
