// Profiles without an LLM for the rows the scan left `pending` or `stale`: CSV (stream), zip (central directory),
// image (header), PDF (pdfinfo when present). A profile is computed outside the lock and merged into the index
// under the lock, only into a row that still has the same hash (the file may have changed meanwhile).
import path from 'node:path';
import { LockBusy, withLock } from './lock.mjs';
import { paths, readIndex, readManifest, writeIndex, writeManifest } from './index.mjs';
import { profileCsv, describeCsv } from './profile-csv.mjs';
import { profileZip } from './profile-zip.mjs';
import { profileImage } from './profile-image.mjs';
import { headHash } from './hash.mjs';
import { profilePdf } from './profile-pdf.mjs';
import { markDuplicates, summarize } from './scan.mjs';

const PROFILE_DESC_V = 'p1';
const bySize = (a, b) => a.size - b.size;

const cheapFirst = (rows) => {
  const cheap = rows.filter((r) => r.kind !== 'csv').sort(bySize);
  const csv = rows.filter((r) => r.kind === 'csv').sort(bySize);
  return cheap.concat(csv);
};

const wants = (r) => r.hash && ['pending', 'stale'].includes(r.status) && ['csv', 'archive', 'image', 'pdf_text', 'pdf_scan'].includes(r.kind) && r.size > 0;

function describeZip(p) {
  const top = Object.entries(p.ext_counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${e || 'bez prípony'} ${n}`).join(', ');
  return `ZIP, ${p.entries} položiek${top ? ` (${top})` : ''}${p.truncated ? ', zoznam skrátený' : ''}`;
}
const describeImage = (p) => (p.width ? `Obrázok ${String(p.format).toUpperCase()} ${p.width}×${p.height}` : `Obrázok ${String(p.format).toUpperCase()}`);
const describePdf = (p, scan) => `PDF, ${p.pages} strán, ${scan ? 'sken bez textovej vrstvy' : 's textovou vrstvou'}`;

/** The first `head_bytes` bytes of the file are what they were: rows were only added after them (a small file grows past its old head). */
function appendedOnly(abs, old) {
  return !!old.head_hash && old.head_bytes > 0 && headHash(abs, old.head_bytes) === old.head_hash;
}

/** Result of one profiler for one row: { patch } to merge, { skip } to leave it pending, or { aborted }. */
function profileRow(cfg, source, row, { deadline }) {
  const abs = path.join(source.path, ...row.path.split('/'));
  if (row.kind === 'csv') {
    const p = profileCsv(abs, row.size, cfg.csv, { deadline });
    if (p?.aborted) return { aborted: true };
    if (!p) return { patch: { status: 'skipped', error: { code: 'csv_unreadable' }, profile: null } };
    const old = row.profile;
    const appendOnly = row.status === 'stale' && old?.columns_hash && old.columns_hash === p.columns_hash && p.rows >= old.rows && appendedOnly(abs, old);
    return { patch: { profile: p, desc: describeCsv(p) }, appendOnly };
  }
  if (row.kind === 'archive') {
    if (row.ext !== 'zip') return { skip: true };
    const p = profileZip(abs, row.size, { maxEntries: cfg.archives.max_entries });
    if (!p) return { patch: { status: 'skipped', error: { code: 'zip_unreadable' }, profile: null } };
    return { patch: { profile: p, desc: describeZip(p) } };
  }
  if (row.kind === 'image') {
    const p = profileImage(abs, row.size) || { format: row.ext, width: null, height: null };
    return { patch: { profile: p, desc: describeImage(p) } };
  }
  const p = profilePdf(abs);
  if (!p) return { skip: true };
  const scan = p.text === false;
  return { patch: { kind: scan ? 'pdf_scan' : 'pdf_text', profile: p, desc: describePdf(p, scan) } };
}

function apply(row, res) {
  const { desc, ...patch } = res.patch;
  const was = row.was;
  delete row.was;
  Object.assign(row, patch);
  if (patch.status) return; // skipped
  const llm = !!row.described_by && row.described_by !== 'profile' && row.described_by !== 'copy';
  row.error = null;
  if (llm) { // an LLM description stays: valid for an append-only CSV, obsolete (stale) otherwise
    row.status = res.appendOnly ? was || 'described' : 'stale';
    return;
  }
  row.status = 'profiled';
  row.desc = desc;
  row.desc_v = PROFILE_DESC_V;
  row.described_by = 'profile';
}

/** A duplicate shows what its original shows (no second profile of the same bytes). */
function copyToDuplicates(rows) {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  for (const r of rows) {
    if (r.status !== 'duplicate' || !r.dup_of) continue;
    const o = byPath.get(r.dup_of);
    if (!o || !o.profile || (r.described_by && r.described_by !== 'copy')) continue;
    r.profile = o.profile;
    r.kind = o.kind;
    if (o.desc) { r.desc = o.desc; r.desc_v = o.desc_v ?? null; r.described_by = 'copy'; }
  }
}

/**
 * Profiles the rows of one source. `maxBytes` skips bigger files (the hook leaves them for `catalog profile`), `only` is a
 * catalog path, `deadline` bounds the whole run. Returns { profiled, pending, aborted, busy? }.
 */
export function profileSource(cfg, source, { deadline = Infinity, maxBytes = Infinity, only = null, waitMs = 1000 } = {}) {
  const rows = readIndex(cfg.dir, source.name);
  const todo = cheapFirst(rows.filter((r) => wants(r) && r.size <= maxBytes && (!only || r.path === only)));
  const results = [];
  let aborted = false;
  for (const row of todo) {
    if (Date.now() > deadline) { aborted = true; break; }
    let res;
    try { res = profileRow(cfg, source, row, { deadline }); } catch { res = { skip: true }; }
    if (res.aborted) { aborted = true; break; }
    if (res.patch) results.push({ path: row.path, hash: row.hash, res });
  }
  let profiled = 0;
  if (results.length || rows.some((r) => r.status === 'duplicate' && !r.profile)) {
    try {
      withLock(paths(cfg.dir, '_').lock, { waitMs }, () => {
        const fresh = readIndex(cfg.dir, source.name);
        const map = new Map(fresh.map((r) => [r.path, r]));
        for (const { path: p, hash, res } of results) {
          const row = map.get(p);
          if (!row || row.hash !== hash) continue; // changed meanwhile: the next scan decides
          apply(row, res);
          profiled++;
        }
        markDuplicates(fresh);
        copyToDuplicates(fresh);
        writeIndex(cfg.dir, source.name, fresh);
        const m = readManifest(cfg.dir);
        const cur = m.sources?.[source.name] || {};
        writeManifest(cfg.dir, { sources: { [source.name]: { ...cur, ...pickCounts(summarize(fresh)), profiled_at: new Date().toISOString() } } });
      });
    } catch (err) {
      if (err instanceof LockBusy) return { profiled: 0, pending: todo.length, aborted, busy: true };
      throw err;
    }
  }
  return { profiled, pending: todo.length - results.length, aborted };
}

const pickCounts = (s) => ({ total: s.total, kinds: s.kinds, statuses: s.statuses, duplicates: s.duplicates, hash_pending: s.hash_pending });

export function profileAll(cfg, opts = {}) {
  if (!cfg.enabled) return [];
  return cfg.sources.filter((s) => !opts.source || s.name === opts.source).map((source) => ({ source: source.name, ...profileSource(cfg, source, opts) }));
}
