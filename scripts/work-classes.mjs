// Classes of the work files in topics/<id>/tmp/ (operator 2026-11-19: 13 GB of work files in one domain, mostly full shop
// exports; "helper files go at once, temporary ones stay until the triage"):
//   - helper (tmp/_pomocne/): the output of one step that can be made again (an export to read, a download, a log, a
//     script for one run); the end of every turn that does not wait for a job removes it;
//   - backup (tmp/_zalohy/, also a folder named zaloha or zalohy in tmp/): a copy taken before a write to production
//     (D-0021 of a domain); the first one of the folder and the last BACKUP_KEEP stay, the end of a turn removes the rest;
//   - temporary (the rest of tmp/): the state of the work; it stays until done --topic (P-062).
// Names linked to one file (a hardlink) are one backup. The size of a held work folder is checked at most once an hour.
import fs from 'node:fs';
import path from 'node:path';
import { sizeOf, human, tmpFiles, workFinding } from './leftovers.mjs';
import { MAIN } from './layout.mjs';

export const HELPER_DIR = '_pomocne';
export const BACKUP_DIR = '_zalohy';
export const BACKUP_DIRS = Object.freeze(new Set([BACKUP_DIR, 'zaloha', 'zalohy']));
export const BACKUP_KEEP = 3;
export const SIZE_CHECK_MS = 60 * 60 * 1000;
const SKIP = new Set(['node_modules', '.git']);

/** Remove the content of tmp/_pomocne/ (the folder stays): { files, bytes } removed. */
export function clearHelpers(tmp) {
  const dir = path.join(tmp, HELPER_DIR);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { files: 0, bytes: 0 }; }
  const out = { files: 0, bytes: 0 };
  for (const name of entries) {
    const p = path.join(dir, name);
    const w = sizeOf(p);
    try { fs.rmSync(p, { recursive: true, force: true }); out.files += w.files; out.bytes += w.bytes; } catch { /* in use */ }
  }
  return out;
}

/** Backup folders in tmp/ (to the depth 3, not in node_modules or a dot folder). */
export function backupFolders(tmp, depth = 3) {
  const found = [];
  const walk = (dir, d) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name) || e.name === HELPER_DIR) continue;
      const p = path.join(dir, e.name);
      if (BACKUP_DIRS.has(e.name)) found.push(p);
      else if (d > 1) walk(p, d - 1);
    }
  };
  walk(tmp, depth);
  return found;
}

/**
 * Keep the first backup of a folder and the last `keep` (files directly in it, by time; the names of one hardlinked file
 * are one backup), remove the other files: [{ name, bytes }] removed.
 */
export function pruneBackups(dir, keep = BACKUP_KEEP) {
  const groups = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    let st;
    try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    const key = `${st.dev}:${st.ino}`;
    const g = groups.get(key) || { names: [], time: st.mtimeMs, bytes: st.size };
    g.names.push(e.name);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => a.time - b.time);
  if (list.length <= keep + 1) return [];
  const removed = [];
  for (const g of list.slice(1, list.length - keep)) {
    for (const name of g.names) {
      try { fs.unlinkSync(path.join(dir, name)); removed.push({ name, bytes: g.names.at(-1) === name ? g.bytes : 0 }); } catch { /* gone */ }
    }
  }
  return removed;
}

/**
 * Backup folders of a topic's tmp/ whose files the end of a turn rotates (tidyWork of Stop): a size limit does not count
 * them, the flow bounds them by itself (operator 2026-11-20: 936 MB of rotated backups of 4 topics were alone over the
 * limit of the brain, so the finding could never go away by a triage). Topic main is never tidied: it counts in full.
 */
export const rotatedDirs = (id, tmp) => (id === MAIN ? [] : backupFolders(tmp));

/** The work files finding of a repository (leftovers.mjs workFinding) without the backups the flow rotates. */
export const repoWorkFinding = (dir, map, opts = {}) => workFinding(dir, map, { ...opts, keptDirs: rotatedDirs });

/** The line for a work folder over the limit (the rotated backups not counted), else null. */
export function sizeLine(id, tmp, limit) {
  const w = { bytes: tmpFiles(tmp, { keep: rotatedDirs(id, tmp) }).files.reduce((n, f) => n + f.bytes, 0) };
  if (w.bytes <= limit) return null;
  return `work files of topic ${id}: ${human(w.bytes)} in tmp/ (limit ${human(limit)}). Put a helper file (an export to read, a download, a log, a one-run script) in tmp/${HELPER_DIR}/ (work-dir.mjs --helper; the end of the turn removes it) and a backup before a write in tmp/${BACKUP_DIR}/ (work-dir.mjs --backup; the first and the last ${BACKUP_KEEP} stay); remove what the topic does not need (P-062)`;
}
