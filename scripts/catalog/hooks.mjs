// SessionStart part of the catalog: scan within the hook budget, cheap profiles with what is left, and the boot lines
// (1 per source, at most `catalog_boot_lines`, each at most `catalog_line_chars`). An error never fails the boot.
import { createHash } from 'node:crypto';
import { catalogConfig } from './config.mjs';
import { readManifest, readJsonSafe, paths } from './index.mjs';
import { scanAll } from './scan.mjs';
import { profileAll } from './profiles.mjs';

const HOOK_PROFILE_MAX_BYTES = 32 * 1024 * 1024;
const KIND_LABELS = [['csv', 'csv'], ['pdf', null], ['image', 'obr'], ['text', 'text'], ['doc', 'doc'], ['archive', 'zip']];

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** `csv 120, pdf 400, obr 300, iné 414` – the three biggest groups, the rest as "iné". */
export function kindSummary(kinds = {}) {
  const grouped = {};
  for (const [k, n] of Object.entries(kinds)) {
    const label = k === 'pdf_text' || k === 'pdf_scan' ? 'pdf' : (KIND_LABELS.find(([x]) => x === k)?.[1] ?? 'iné');
    grouped[label] = (grouped[label] || 0) + n;
  }
  const rest = grouped['iné'] || 0;
  delete grouped['iné'];
  const top = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 4);
  const other = rest + top.slice(4).reduce((s, [, n]) => s + n, 0);
  return [...shown.map(([k, n]) => `${k} ${fmt(n)}`), ...(other ? [`iné ${fmt(other)}`] : [])].join(', ');
}

/** Boot lines of the catalog from the manifest and the result of this session's scan. */
export function catalogLines(cfg, scan = null, { pluginRoot = '<plugin>' } = {}) {
  const manifest = readManifest(cfg.dir);
  const lastError = readJsonSafe(paths(cfg.dir, '_').lastError, null);
  const maxLines = cfg.boot_lines ?? 2;
  const maxChars = cfg.line_chars ?? 220;
  const lines = [];
  for (const source of cfg.sources) {
    if (lines.length >= maxLines) break;
    const m = manifest.sources?.[source.name];
    const at = m?.scanned_at ? m.scanned_at.slice(0, 10) : 'neznámy dátum';
    const result = scan?.sources?.find((s) => s.name === source.name);
    let line;
    // the error of this run (the catalog directory may be unwritable, then nothing was recorded on disk)
    const failed = scan?.errors?.find((e) => e.source === source.name || e.source === '*') || (scan?.errors?.length ? lastError : null);
    if (failed) {
      line = `katalóg ${source.name}: scan zlyhal (${String(failed.message).slice(0, 120)}); index z ${at} ostáva`;
    } else if (scan?.skipped_busy) {
      line = `katalóg ${source.name}: scan preskočený (zaneprázdnený), index z ${at}`;
    } else if (result && !result.available) {
      line = `katalóg ${source.name}: zdroj nedostupný (${result.reason || 'odpojený disk alebo sync'}), index z ${at}`;
    } else if (m) {
      const open = (m.statuses?.pending || 0) + (m.statuses?.stale || 0);
      const parts = [`katalóg ${source.name}: ${fmt(m.total ?? 0)} súborov${m.kinds ? ` (${kindSummary(m.kinds)})` : ''}`];
      if (m.last_changes) parts.push(`${fmt(m.last_changes)} zmenených`);
      if (open) parts.push(`${fmt(open)} nepopísaných`);
      if (m.hash_pending) parts.push(`${fmt(m.hash_pending)} bez hashu`);
      line = parts.join(', ');
      if (!lines.length) { // the hint is the point of the line: it is the numbers that give way on a long plugin path
        const hint = `; hľadaj: node ${pluginRoot}/bin/catalog.mjs find <slová> (nikdy ls/grep po zdroji)`;
        line = cut(line, Math.max(40, maxChars - hint.length)) + hint;
      }
    } else continue;
    lines.push(cut(line, maxChars));
  }
  return lines;
}

/**
 * Scan (+ cheap profiles) and boot lines for a session start. `state` is the thread state or null; for `compact` the
 * lines are left out when they did not change since the last boot of the thread (`catalog_boot_hash`).
 * Returns { lines, stateHash } and never throws.
 */
export function catalogBoot(ctx, { source = 'startup', state = null } = {}) {
  try {
    const cfg = catalogConfig(ctx.projectDir);
    if (!cfg.enabled) return { lines: [], stateHash: null };
    cfg.boot_lines = ctx.policy?.limits?.catalog_boot_lines ?? 2;
    cfg.line_chars = ctx.policy?.limits?.catalog_line_chars ?? 220;
    const started = Date.now();
    const scan = scanAll(cfg, { waitMs: 1000 });
    if (!scan.skipped_busy && !scan.errors.length) {
      const left = cfg.scan.hook_budget_ms - (Date.now() - started);
      if (left > 150) {
        try { profileAll(cfg, { deadline: Date.now() + left, maxBytes: HOOK_PROFILE_MAX_BYTES, waitMs: 500 }); } catch { /* the next session continues */ }
      }
    }
    const lines = catalogLines(cfg, scan, { pluginRoot: ctx.pluginRoot });
    // the count of changes of the last scan is not part of the identity: a quiet second boot must stay quiet; the identity
    // uses the untruncated lines, since the cut moves with that count (a long plugin path cut "nepopísaných" only once)
    const full = catalogLines({ ...cfg, line_chars: Infinity }, scan, { pluginRoot: ctx.pluginRoot });
    const stateHash = createHash('sha1').update(full.join('\n').replace(/, [\d  ]+ zmenených/g, '')).digest('hex').slice(0, 12);
    if (source === 'compact' && state?.catalog_boot_hash === stateHash) return { lines: [], stateHash };
    return { lines, stateHash };
  } catch (err) {
    return { lines: [`katalóg: scan zlyhal (${String(err?.message || err).split('\n')[0].slice(0, 120)})`], stateHash: null };
  }
}
