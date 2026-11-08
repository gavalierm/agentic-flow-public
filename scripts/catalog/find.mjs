// Search in the catalog index: query tokens against path, tags, title, description and profile (column names and values,
// zip listing). Returns paths and descriptions only, never file content (P-031).
import path from 'node:path';
import { normalizeKey, tokens } from '../keys.mjs';
import { readIndex } from './index.mjs';
import { resolveRef } from './config.mjs';

const STATUS_RANK = { described: 0, profiled: 1, stale: 2, pending: 3, skipped: 4, error: 4, duplicate: 5 };
const LINE_MAX = 240;
const DESC_MAX = 120;

const norm = (v) => `-${normalizeKey(Array.isArray(v) ? v.join(' ') : String(v ?? ''))}-`;

function fieldsOf(r) {
  const cols = Array.isArray(r.profile?.columns) ? r.profile.columns : [];
  return {
    strong: norm([r.title, ...(r.tags_sk || []), ...(r.tags_en || []), ...(r.entities || [])].filter(Boolean)),
    path: norm(r.path.replace(/\.[^./]+$/, '')),
    weak: norm([r.desc, r.ext, r.kind, ...cols.map((c) => c.name), ...cols.flatMap((c) => (Array.isArray(c.values) ? c.values : [])), ...(Array.isArray(r.profile?.listing) ? r.profile.listing : []), r.profile?.target].filter(Boolean)),
  };
}

const has = (hay, t) => hay.includes(`-${t}`);

/**
 * Rows containing every query token (prefix match on a token boundary), best first: weight 3 for title/tags/entities,
 * 2 for the path, 1 for description and profile; then described before pending, originals before duplicates, then path.
 * `limit` 0 means no limit. Returns { matches, total }.
 */
export function findCatalog(cfg, query, { kind = null, source = null, limit = cfg.find.max_lines } = {}) {
  const qt = tokens(query);
  if (!cfg.enabled || !qt.length) return { matches: [], total: 0 };
  const scored = [];
  for (const s of cfg.sources) {
    if (source && s.name !== source) continue;
    for (const r of readIndex(cfg.dir, s.name)) {
      if (kind && r.kind !== kind) continue;
      const f = fieldsOf(r);
      let score = 0;
      let all = true;
      for (const t of qt) {
        const w = has(f.strong, t) ? 3 : has(f.path, t) ? 2 : has(f.weak, t) ? 1 : 0;
        if (!w) { all = false; break; }
        score += w;
      }
      if (all) scored.push({ r, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || (STATUS_RANK[a.r.status] ?? 6) - (STATUS_RANK[b.r.status] ?? 6) || (a.r.path < b.r.path ? -1 : a.r.path > b.r.path ? 1 : 0));
  const total = scored.length;
  const take = limit > 0 ? scored.slice(0, limit) : scored;
  return { total, matches: take.map(({ r, score }) => ({ source: r.source, path: r.path, kind: r.kind, status: r.status, title: r.title || null, desc: r.desc || null, dup_of: r.dup_of || null, size: r.size, score })) };
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `<source>/<path> [kind, status]: <title>; <desc>` – one line, no content. */
export function formatMatch(m) {
  const text = [m.title, m.desc && cut(m.desc, DESC_MAX)].filter(Boolean).join('; ') || (m.dup_of ? `duplikát ${m.dup_of}` : '');
  return cut(`${m.source}/${m.path} [${m.kind}, ${m.status}]${text ? `: ${text}` : ''}`, LINE_MAX);
}

export function formatCatalogBlock(res, cfg) {
  const names = cfg.sources.map((s) => s.name).join(', ');
  const more = res.total > res.matches.length ? ` (zobrazených ${res.matches.length}, všetky: catalog.mjs find --all)` : '';
  return `katalóg (${names}): ${res.total} zhôd${more}\n${res.matches.map(formatMatch).join('\n')}`.trimEnd();
}

/** The row of a catalog reference (`<source>/<path>`, a path in a source, or a unique tail of a path); { row } or { error }. */
export function getRow(cfg, ref, cwd = process.cwd()) {
  const hit = resolveRef(cfg, ref, cwd);
  const candidates = [];
  const sources = hit ? [hit.source] : cfg.sources;
  for (const s of sources) {
    const rows = readIndex(cfg.dir, s.name);
    const rel = hit ? hit.rel : String(ref).replace(/\\/g, '/');
    const exact = rows.find((r) => r.path === rel);
    if (exact) return { row: exact };
    if (hit) continue;
    for (const r of rows) if (r.path.endsWith(`/${rel}`) || path.posix.basename(r.path) === rel) candidates.push(r);
  }
  if (candidates.length === 1) return { row: candidates[0] };
  if (candidates.length > 1) return { error: `nejednoznačné (${candidates.length}): ${candidates.slice(0, 5).map((r) => `${r.source}/${r.path}`).join(', ')}` };
  return { error: `v katalógu nie je: ${ref}` };
}
