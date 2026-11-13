// Author of a brain record (memory, decision, rule, skill): the author of the commit that added its file. Several operators
// can share one brain, each on a machine with their own git identity; the frontmatter carries no author, so the records saved
// before need no migration. Shown by name only and only on a record of another operator (session start, find, save): a brain
// of one author reads as before.
import { git } from './util.mjs';

/** Record folders of the brain the author log looks at. */
export const RECORD_DIRS = ['memory', 'decisions', 'rules', 'skills'];

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
 * Authors of the brain records in one git log: the author of the newest commit that added each path (`--no-renames`, so a
 * moved file has its addition). `paths` narrows the log (save: the one record). A file no commit added belongs to this
 * machine. Returns { me, files: Map<brain-relative path, { name, email }>, git } (`git`: the log result, which also tells a
 * repo git refuses, see gitAccessProblem).
 */
export function recordAuthors(brainDir, { paths = RECORD_DIRS } = {}) {
  const res = git(['-c', 'core.quotePath=false', 'log', '--no-renames', '--diff-filter=A', '--relative', '--format=%x01%ae%x02%an', '--name-only', '--', ...paths], { cwd: brainDir });
  const files = new Map();
  let cur = null;
  for (const line of res.ok ? res.stdout.split('\n') : []) {
    if (line.startsWith('\x01')) {
      const [email = '', name = ''] = line.slice(1).split('\x02');
      cur = { email: email.trim(), name: name.trim() };
    } else if (cur && line.trim() && !files.has(line.trim())) files.set(line.trim(), cur);
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

/** Records (.md) of other operators under `prefix` (e.g. `rules/`): { path: name }. */
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
