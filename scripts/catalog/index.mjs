// Files of the catalog directory: index/<source>.jsonl (sorted by path, replaced atomically), state, manifest, last error.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './schema.mjs';

export const paths = (dir, source) => ({
  index: path.join(dir, 'index', `${source}.jsonl`),
  delta: path.join(dir, 'index', `${source}.delta.jsonl`),
  state: path.join(dir, 'state', `${source}.scan.json`),
  manifest: path.join(dir, 'manifest.json'),
  lastError: path.join(dir, 'state', 'last-error.json'),
  lock: path.join(dir, '.lock'),
  human: path.join(dir, 'human'),
});

/** tmp + rename: a reader always sees a whole file. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Lines of a JSONL file; a line that does not parse (torn tail after a crash) is skipped. */
export function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
  }
  return rows;
}

export const serialize = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Index rows with the append-only delta folded in (later line of a path wins; `deleted: true` removes it). */
export function readIndex(dir, source) {
  const p = paths(dir, source);
  const map = new Map();
  for (const r of readJsonl(p.index)) if (r?.path) map.set(r.path, r);
  for (const d of readJsonl(p.delta)) {
    if (!d?.path) continue;
    if (d.deleted) map.delete(d.path);
    else map.set(d.path, { ...(map.get(d.path) || {}), ...d });
  }
  return [...map.values()].sort(byPath);
}

/** Folds the delta into the index and removes it. The caller holds the lock. */
export function writeIndex(dir, source, rows) {
  const p = paths(dir, source);
  writeAtomic(p.index, serialize([...rows].sort(byPath)));
  fs.rmSync(p.delta, { force: true });
}

export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readManifest(dir) {
  return readJsonSafe(paths(dir, '_').manifest, null) || { schema_version: SCHEMA_VERSION, sources: {} };
}

export function writeManifest(dir, patch) {
  const cur = readManifest(dir);
  const next = { ...cur, ...patch, schema_version: SCHEMA_VERSION, sources: { ...cur.sources, ...(patch.sources || {}) } };
  writeAtomic(paths(dir, '_').manifest, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function recordError(dir, source, message) {
  writeAtomic(paths(dir, '_').lastError, JSON.stringify({ source, message: String(message).split('\n')[0].slice(0, 300), at: new Date().toISOString() }) + '\n');
}

export function clearError(dir, source) {
  const p = paths(dir, '_').lastError;
  const cur = readJsonSafe(p, null);
  if (cur && cur.source === source) fs.rmSync(p, { force: true });
}
