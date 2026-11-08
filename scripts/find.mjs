// Deterministic lookup in brain (P-031). Returns paths and one-line descriptions, never content.
import { allRecords, readDecisions, normalizedNames } from './records.mjs';
import { normalizeKey, tokens } from './keys.mjs';

function line(r) {
  return { path: r.path, description: r.description, kind: r.kind, key: r.key, status: r.status, id: r.id, ...(r.repo ? { repo: r.repo } : {}), ...(r.topic ? { topic: r.topic } : {}) };
}

/** Exact match on key, alias or normalized name/title. */
export function find(brainDir, query, domain = null) {
  const q = normalizeKey(query);
  if (!q) return [];
  return allRecords(brainDir, domain).filter((r) => normalizedNames(r).has(q)).map(line);
}

/** Word match: every query token occurs among the tokens of key, name, title, aliases or description.
 *  Fallback of the CLI when there is no exact match; save and error keep using exact find(). */
export function findWords(brainDir, query, domain = null) {
  const want = tokens(query);
  if (!want.length) return [];
  return allRecords(brainDir, domain)
    .filter((r) => {
      const have = new Set([r.key, r.name, r.title, r.description, ...r.aliases].filter(Boolean).flatMap((v) => tokens(v)));
      return want.every((t) => have.has(t));
    })
    .map(line);
}

/** Records with the target path/thing in relates_to (P-008). Matches exact value, or basename, or path suffix. */
export function findRelatesTo(brainDir, target, { validOnly = false, domain = null } = {}) {
  const t = String(target).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = t.split('/').pop();
  return allRecords(brainDir, domain)
    .filter((r) => r.relates_to.some((v) => {
      const x = String(v).replace(/\\/g, '/').replace(/^\.\//, '');
      return x === t || t.endsWith('/' + x) || x.endsWith('/' + t) || (x === base && !x.includes('/') && base === t) || normalizeKey(x) === normalizeKey(t);
    }))
    .filter((r) => !validOnly || r.kind !== 'decision' || !r.status || r.status === 'valid')
    .map(line);
}

/** Similar keys of the same type: share at least one name token (P-031, save refuses silently creating a near duplicate). */
export function findSimilar(brainDir, key, domain = null) {
  const [type, ...rest] = String(key).split('-');
  const want = new Set(tokens(rest.join('-')));
  if (!want.size) return [];
  return allRecords(brainDir, domain)
    .filter((r) => r.kind === 'memory' && r.key !== key && String(r.key).startsWith(type + '-'))
    .filter((r) => tokens(String(r.key).slice(type.length + 1)).some((t) => want.has(t)))
    .map(line);
}

export function rejectedProposal(brainDir, name) {
  return readDecisions(brainDir).some((d) => (!d.status || d.status === 'valid') && d.relates_to.some((v) => normalizeKey(v) === normalizeKey(name)) && /zamietnut|rejected/i.test(`${d.title} ${d.description}`));
}

export function formatMatches(matches) {
  return matches.map((m) => `${m.path}: ${m.description}`).join('\n');
}
