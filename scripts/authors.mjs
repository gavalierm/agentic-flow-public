// Author of a brain record (memory, decision, rule, skill): the author of the commit that added its file. Several operators
// can share one brain, each on a machine with their own git identity; the frontmatter carries no author, so the records saved
// before need no migration. Shown by name only and only on a record of another operator (session start, find, save): a brain
// of one author reads as before.
import { git } from './util.mjs';
import { LAYOUT, ALL_MAPS, dataRel } from './layout.mjs';

/** Record folders of the brain the author log looks at (logical names of layout.mjs; RECORD_DIRS: their layout-1 paths). */
const RECORD_NAMES = ['memory', 'decisions', 'rules', 'skills'];
export const RECORD_DIRS = RECORD_NAMES.map((n) => LAYOUT[n]);

/** Git identity of this machine for the brain (effective config user.email and user.name); null when neither is set. */
export function localIdentity(brainDir) {
  const r = git(['config', '--get-regexp', '^user\\.(name|email)$'], { cwd: brainDir });
  const id = { name: '', email: '' };
  // Every scope is listed, the effective value (local over global over system) comes last.
  for (const line of r.ok ? r.stdout.split('\n') : []) {
    const m = /^user\.(name|email)\s+(.*)$/i.exec(line.trim());
    if (m) id[m[1].toLowerCase()] = m[2].trim();
  }
  return id.name || id.email ? id : null;
}

/** Same operator: the same e-mail when both sides have one, otherwise the same name. */
export function sameIdentity(a, b) {
  if (!a || !b) return false;
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return !!a.name && a.name === b.name;
}

/**
 * Authors of the brain records in one git log: the author of the commit that first added each file, followed through its
 * moves (a rename, also a migration of the data layout that moved and rewrote it, keeps the author who wrote the record;
 * operator 2026-11-16: a brain migrated by another machine named the migrating agent the author of every record).
 * `paths` narrows the log (save: the one record); the folders of every data layout are searched, so a move from an older
 * layout is followed. A file no commit added belongs to this machine. Returns { me, files: Map<brain-relative path,
 * { name, email }>, git } (`git`: the log result, which also tells a repo git refuses, see gitAccessProblem).
 */
export function recordAuthors(brainDir, { paths = RECORD_NAMES.map((n) => dataRel(brainDir, n)) } = {}) {
  const tracked = git(['-c', 'core.quotePath=false', 'ls-files', '--', ...paths], { cwd: brainDir });
  const pending = new Map(); // path in the commit being read (older going back) -> current path
  for (const p of tracked.ok ? tracked.stdout.split('\n') : []) if (p.trim()) pending.set(p.trim(), p.trim());
  const search = [...new Set([...paths, ...ALL_MAPS.flatMap((L) => RECORD_NAMES.map((n) => L[n]).filter(Boolean))])];
  const res = git(['-c', 'core.quotePath=false', 'log', '-M', '--diff-filter=AR', '--relative', '--format=%x01%ae%x02%an', '--name-status', '--', ...search], { cwd: brainDir });
  const files = new Map();
  let cur = null;
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    if (!pending.size) break;
    if (line.startsWith('\x01')) {
      const [email = '', name = ''] = line.slice(1).split('\x02');
      cur = { email: email.trim(), name: name.trim() };
      continue;
    }
    const parts = line.split('\t');
    if (!cur || parts.length < 2) continue;
    if (parts[0].startsWith('R') && parts.length >= 3) {
      // A move: the record lived at the old path before this commit.
      const now = pending.get(parts[2]);
      if (now !== undefined) { pending.delete(parts[2]); pending.set(parts[1], now); }
    } else if (parts[0] === 'A') {
      const now = pending.get(parts[1]);
      if (now !== undefined) { pending.delete(parts[1]); files.set(now, cur); }
    }
  }
  return { me: files.size ? localIdentity(brainDir) : null, files, git: res };
}

/** Name of the author of the record at `rel` when another operator added it; null for an own or uncommitted file, or without an identity here. */
export function foreignAuthor(authors, rel) {
  if (!authors?.me) return null;
  const a = authors.files.get(String(rel));
  // The name only, never the e-mail.
  return a && !sameIdentity(a, authors.me) ? a.name || 'unknown' : null;
}

/** ` [by <name>]` for a record of another operator, else an empty string. */
export function byTag(name) {
  return name ? ` [by ${name}]` : '';
}

/** Records (.md) of other operators under `prefix` (e.g. the rules folder with a trailing slash): { path: name }. */
export function foreignRecords(authors, prefix = '') {
  const out = {};
  for (const rel of authors?.files?.keys() || []) {
    const by = rel.startsWith(prefix) && rel.endsWith('.md') ? foreignAuthor(authors, rel) : null;
    if (by) out[rel] = by;
  }
  return out;
}

/** Operator memory: preferences of one operator (memory type `operator`). */
export function isOperatorMemory(r) {
  return String(r.type || String(r.key || '').split('-')[0]) === 'operator';
}
