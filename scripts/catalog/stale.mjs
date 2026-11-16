// A catalog left on the old path of its source after a move of the data (doma-pc 2026-11-16: a repo indexed
// materialy/ with 85 files while zdroje/ held 1717): the migration moves the folder, the local index (outside git) stays.
// The session start scans the source on its current path, but a repo nobody opened after the move kept the stale index.
import fs from 'node:fs';
import path from 'node:path';
import { catalogConfig } from './config.mjs';
import { readManifest } from './index.mjs';
import { scanAll } from './scan.mjs';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Sources whose index names another path than the source has now: [{ name, indexed, path }]. */
export function staleCatalog(dir) {
  const cfg = catalogConfig(dir);
  if (!cfg.enabled || !fs.existsSync(cfg.dir)) return [];
  const manifest = readManifest(cfg.dir);
  const out = [];
  for (const s of cfg.sources) {
    const m = manifest.sources?.[s.name];
    if (m?.path && real(m.path) !== real(s.path)) out.push({ name: s.name, indexed: m.path, path: s.path });
  }
  return out;
}

/** The stale sources scanned again on their current path (a full scan): lines. */
export function rescanStale(dir) {
  const stale = staleCatalog(dir);
  if (!stale.length) return [];
  const cfg = catalogConfig(dir);
  const res = scanAll(cfg, { full: true, waitMs: 5000 });
  const lines = res.sources.filter((s) => stale.some((x) => x.name === s.name)).map((s) => `${path.basename(dir)}: catalog ${s.name} scanned again on ${s.path || cfg.sources.find((x) => x.name === s.name)?.path} (${s.total} files)`);
  for (const e of res.errors) lines.push(`${path.basename(dir)}: catalog ${e.source}: ${e.message}`);
  return lines;
}
