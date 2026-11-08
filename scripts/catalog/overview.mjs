// Overview for a human, derived from the index: human/INDEX.md (counts, duplicates, largest files, recent changes) and
// human/by-folder.md (folder tree with counts). Local only, regenerated on demand, never edited by hand.
import path from 'node:path';
import { paths, readIndex, writeAtomic } from './index.mjs';

const MB = 1024 * 1024;
const fmtSize = (n) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const RECENT_DAYS = 30;
const LIST_MAX = 15;
const FILES_PER_FOLDER = 25;

function counts(rows, key) {
  const m = {};
  for (const r of rows) m[r[key]] = (m[r[key]] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
}

function duplicateGroups(rows) {
  const g = new Map();
  for (const r of rows) {
    if (!r.hash || r.hash_mode !== 'full' || !r.size || r.kind === 'symlink') continue;
    if (!g.has(r.hash)) g.set(r.hash, []);
    g.get(r.hash).push(r);
  }
  return [...g.values()].filter((x) => x.length > 1).map((x) => ({ files: x.sort((a, b) => (a.path < b.path ? -1 : 1)), saving: x[0].size * (x.length - 1) })).sort((a, b) => b.saving - a.saving);
}

function sourceSection(source, rows, now) {
  const out = [`## ${source.name}`, '', `Cesta: \`${source.path}\` (${source.mode === 'rw' ? 'zápis povolený' : 'iba čítanie'}). Súborov: ${rows.length}, spolu ${fmtSize(rows.reduce((s, r) => s + r.size, 0))}.`, ''];
  out.push(`- Podľa druhu: ${counts(rows, 'kind')}`, `- Podľa stavu: ${counts(rows, 'status')}`);
  const nodesc = rows.filter((r) => !r.desc && r.status !== 'duplicate' && r.status !== 'skipped').length;
  const errors = rows.filter((r) => r.status === 'error' || r.status === 'skipped');
  out.push(`- Bez popisu (čakajú na profil alebo popisovač): ${nodesc}`, `- Chyby a preskočené: ${errors.length}`, '');
  if (errors.length) out.push('### Chyby a preskočené', '', ...errors.slice(0, LIST_MAX).map((r) => `- \`${r.path}\`: ${r.error?.code || r.status}`), '');
  const dups = duplicateGroups(rows);
  out.push(`### Duplikáty (${dups.length} skupín, úspora ${fmtSize(dups.reduce((s, d) => s + d.saving, 0))})`, '');
  if (!dups.length) out.push('Žiadne.', '');
  else for (const d of dups.slice(0, LIST_MAX)) out.push(`- ${d.files.length}× ${fmtSize(d.files[0].size)}: ${d.files.slice(0, 4).map((f) => `\`${f.path}\``).join(', ')}${d.files.length > 4 ? ', …' : ''}`);
  out.push('', '### Najväčšie súbory', '');
  for (const r of [...rows].sort((a, b) => b.size - a.size).slice(0, 10)) out.push(`- ${fmtSize(r.size)} \`${r.path}\` [${r.kind}]`);
  const since = now - RECENT_DAYS * 86400000;
  const recent = rows.filter((r) => Date.parse(r.mtime) >= since).sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  out.push('', `### Posledné zmeny (${RECENT_DAYS} dní: ${recent.length})`, '');
  if (!recent.length) out.push('Žiadne.');
  for (const r of recent.slice(0, LIST_MAX)) out.push(`- ${r.mtime.slice(0, 10)} \`${r.path}\` [${r.kind}]`);
  out.push('');
  return out.join('\n');
}

function folderTree(rows) {
  const dirs = new Map([['', { files: [], count: 0, size: 0, kids: new Set() }]]);
  const dir = (p) => {
    if (!dirs.has(p)) {
      dirs.set(p, { files: [], count: 0, size: 0, kids: new Set() });
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      dir(parent).kids.add(p);
    }
    return dirs.get(p);
  };
  for (const r of rows) {
    const d = path.posix.dirname(r.path);
    const own = dir(d === '.' ? '' : d);
    own.files.push(r);
    for (let p = d === '.' ? '' : d; ; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
      const x = dir(p);
      x.count++;
      x.size += r.size;
      if (p === '') break;
    }
  }
  return dirs;
}

function folderSection(source, rows) {
  const dirs = folderTree(rows);
  const out = [`## ${source.name}`, ''];
  const emit = (p, depth) => {
    const d = dirs.get(p);
    const name = p === '' ? '.' : p.slice(p.lastIndexOf('/') + 1);
    out.push(`${'  '.repeat(depth)}- **${name}/** – ${d.count} súborov, ${fmtSize(d.size)}${d.files.length ? ` (priamo ${d.files.length})` : ''}`);
    for (const f of d.files.sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, FILES_PER_FOLDER)) {
      const base = f.path.slice(f.path.lastIndexOf('/') + 1);
      out.push(`${'  '.repeat(depth + 1)}- ${base} – ${f.desc || `[${f.kind}, ${f.status}]`}`);
    }
    if (d.files.length > FILES_PER_FOLDER) out.push(`${'  '.repeat(depth + 1)}- … a ďalších ${d.files.length - FILES_PER_FOLDER}`);
    for (const k of [...d.kids].sort()) emit(k, depth + 1);
  };
  emit('', 0);
  out.push('');
  return out.join('\n');
}

/** Writes human/INDEX.md and human/by-folder.md; returns the written paths. */
export function writeOverview(cfg, { now = Date.now() } = {}) {
  const human = paths(cfg.dir, '_').human;
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const head = (title) => `# ${title}\n\nVygenerované ${stamp} z \`local/catalog/index\`; súbor je odvodený, neupravuj ho ručne. Zostáva na tomto stroji.\n\n`;
  const bySource = cfg.sources.map((s) => ({ s, rows: readIndex(cfg.dir, s.name) }));
  const index = path.join(human, 'INDEX.md');
  const folders = path.join(human, 'by-folder.md');
  writeAtomic(index, head('Katalóg dát: prehľad') + bySource.map(({ s, rows }) => sourceSection(s, rows, now)).join('\n'));
  writeAtomic(folders, head('Katalóg dát: podľa priečinkov') + bySource.map(({ s, rows }) => folderSection(s, rows)).join('\n'));
  return [index, folders];
}
