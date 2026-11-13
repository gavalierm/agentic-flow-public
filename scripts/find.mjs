// Deterministic lookup in brain (P-031). Returns paths and one-line descriptions, never content.
// find, findWords, findRelatesTo and findSimilar read the session (its brain and domain repos: save, error, hooks);
// the *All variants read every store of the machine (D-0028, the find CLI).
import { allRecords, readDecisions, normalizedNames } from './records.mjs';
import { normalizeKey, tokens } from './keys.mjs';
import { foreignAuthor, byTag } from './authors.mjs';
import { machineRecords } from './stores.mjs';

// A record outside the session brain carries its store (brain or repo name); a session brain match prints as before.
function line(r) {
  return { path: r.path, description: r.description, kind: r.kind, key: r.key, status: r.status, id: r.id, ...(r.repo ? { repo: r.repo } : {}), ...(r.topic ? { topic: r.topic } : {}), ...(r.storeOf && !r.storeOf.session ? { store: r.storeOf.name } : {}) };
}

const exact = (query) => {
  const q = normalizeKey(query);
  return q ? (r) => normalizedNames(r).has(q) : null;
};

const words = (query) => {
  const want = tokens(query);
  if (!want.length) return null;
  return (r) => {
    const have = new Set([r.key, r.name, r.title, r.description, ...r.aliases].filter(Boolean).flatMap((v) => tokens(v)));
    return want.every((t) => have.has(t));
  };
};

const relates = (target, validOnly) => {
  const t = String(target).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = t.split('/').pop();
  return (r) => r.relates_to.some((v) => {
    const x = String(v).replace(/\\/g, '/').replace(/^\.\//, '');
    return x === t || t.endsWith('/' + x) || x.endsWith('/' + t) || (x === base && !x.includes('/') && base === t) || normalizeKey(x) === normalizeKey(t);
  }) && (!validOnly || r.kind !== 'decision' || !r.status || r.status === 'valid');
};

const similar = (key) => {
  const [type, ...rest] = String(key).split('-');
  const want = new Set(tokens(rest.join('-')));
  if (!want.size) return null;
  return (r) => r.kind === 'memory' && r.key !== key && String(r.key).startsWith(type + '-') && tokens(String(r.key).slice(type.length + 1)).some((t) => want.has(t));
};

const select = (recs, pred) => (pred ? recs.filter(pred).map(line) : []);

/** Exact match on key, alias or normalized name/title. */
export function find(brainDir, query, domain = null) {
  return select(allRecords(brainDir, domain), exact(query));
}

/** Word match: every query token occurs among the tokens of key, name, title, aliases or description.
 *  Fallback of the CLI when there is no exact match; save and error keep using exact find(). */
export function findWords(brainDir, query, domain = null) {
  return select(allRecords(brainDir, domain), words(query));
}

/** Records with the target path/thing in relates_to (P-008). Matches exact value, or basename, or path suffix. */
export function findRelatesTo(brainDir, target, { validOnly = false, domain = null } = {}) {
  return select(allRecords(brainDir, domain), relates(target, validOnly));
}

/** Similar keys of the same type: share at least one name token (P-031, save refuses silently creating a near duplicate). */
export function findSimilar(brainDir, key, domain = null) {
  return select(allRecords(brainDir, domain), similar(key));
}

const QUALIFIED_ID = /^([A-Za-z0-9][\w.-]*)\/(D-\d{4})$/i;

/**
 * Exact match over every store of the machine, in order session brain, domain brain, the others (D-0028). D-NNNN
 * finds that number in every store; `<store>/D-NNNN` only in the named store.
 */
export function findAll(ctx, query) {
  const m = QUALIFIED_ID.exec(String(query).trim());
  if (m) return select(machineRecords(ctx), (r) => r.kind === 'decision' && r.storeOf.name === m[1] && String(r.id || r.key).toUpperCase() === m[2].toUpperCase());
  return select(machineRecords(ctx), exact(query));
}

export function findWordsAll(ctx, query) {
  return select(machineRecords(ctx), words(query));
}

export function findRelatesToAll(ctx, target, { validOnly = false } = {}) {
  return select(machineRecords(ctx), relates(target, validOnly));
}

export function findSimilarAll(ctx, key) {
  return select(machineRecords(ctx), similar(key));
}

export function rejectedProposal(brainDir, name) {
  return readDecisions(brainDir).some((d) => (!d.status || d.status === 'valid') && d.relates_to.some((v) => normalizeKey(v) === normalizeKey(name)) && /zamietnut|rejected/i.test(`${d.title} ${d.description}`));
}

/** Matches with `by: <name>` on a record another operator added (authors: recordAuthors of scripts/authors.mjs). */
export function withAuthors(matches, authors) {
  return matches.map((m) => {
    const by = foreignAuthor(authors, m.path);
    return by ? { ...m, by } : m;
  });
}

export function formatMatches(matches) {
  return matches.map((m) => `${m.path}: ${m.description}${byTag(m.by)}${m.store ? ` [store ${m.store}]` : ''}`).join('\n');
}
