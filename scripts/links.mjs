// relates_to links (D-0029). A link is one of four forms, and save, consolidate and find read it the same way:
//   - the key of a memory record (<type>-<name>) in any store of the machine;
//   - a decision: D-NNNN of the own store, <store>/D-NNNN of another (stores.mjs refProblem, D-0028);
//   - a workflow principle P-NNN (docs/principles of the workflow);
//   - a file or folder git tracks, as a path from the store's project, the store (a repo's root) or the domain root.
// A topic name or a free word is no link: it belongs in the body, where find reads it. Read only; nothing here writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, PLUGIN_ROOT } from './util.mjs';
import { normalizeKey, tokens } from './keys.mjs';
import { machineStores, machineRecords, refProblem, storeOptions, memoryArgs } from './stores.mjs';

const DECISION = /^(?:([A-Za-z0-9][\w.-]*)\/)?(D-\d{4})$/i;
const PRINCIPLE = /^P-\d{3}$/i;
const PRINCIPLES = path.join(PLUGIN_ROOT, 'docs', 'principles');
const LOOKS_LIKE_PATH = (v) => /[/\\]/.test(v) || /\.[a-z0-9]{1,6}$/i.test(v) || v.startsWith('~');

export const FORMS = 'a link is a record key (<type>-<name>), a decision (D-NNNN, <store>/D-NNNN), a principle (P-NNN) or a file tracked in git; a topic or a free word belongs in the body';

/** A decision link (D-NNNN, <store>/D-NNNN): the decision reference report covers it (consolidate). */
export const isDecisionLink = (v) => DECISION.test(String(v).trim());

const keyCache = new WeakMap();
function memoryKeys(ctx) {
  if (!keyCache.has(ctx)) keyCache.set(ctx, new Set(machineRecords(ctx).filter((r) => r.kind === 'memory').map((r) => String(r.key))));
  return keyCache.get(ctx);
}

/** Folders a relative path is read from: the store's project, the store itself (a repo's root), the domain root. */
function bases(ctx, store) {
  const dirs = [store.project, store.dir, store.domainRoot, store.session ? ctx.projectDir : null];
  return [...new Set(dirs.filter(Boolean).map((d) => path.resolve(d)))];
}

/** 'tracked', 'untracked' (exists, git does not track it) or 'missing'. */
function fileState(ctx, store, value) {
  const v = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const hit = (path.isAbsolute(v) ? [v] : bases(ctx, store).map((b) => path.resolve(b, v))).find((c) => fs.existsSync(c));
  if (!hit) return 'missing';
  const dir = fs.statSync(hit).isDirectory() ? hit : path.dirname(hit);
  const r = git(['ls-files', '--', hit], { cwd: dir });
  return r.ok && r.stdout ? 'tracked' : 'untracked';
}

/** Memory keys a free word likely meant (beszel -> service-beszel): the key ends with it, or the name or an alias is it; else a shared name token. */
export function similarKeys(ctx, value, max = 3) {
  const v = String(value).trim();
  if (LOOKS_LIKE_PATH(v)) return [];
  const n = normalizeKey(v);
  const want = new Set(tokens(v));
  const strong = [];
  const weak = [];
  for (const r of machineRecords(ctx).filter((x) => x.kind === 'memory')) {
    const key = String(r.key);
    const names = [r.data?.name, ...(r.aliases || [])].filter((x) => x !== undefined && x !== null).map((x) => normalizeKey(x));
    if (n && (key.endsWith(`-${n}`) || names.includes(n))) strong.push(key);
    else if (tokens(key.replace(/^[a-z]+-/, '')).some((t) => want.has(t))) weak.push(key);
  }
  const pick = strong.length ? strong : weak;
  return [...new Set(pick)].sort().slice(0, max);
}

/** What is wrong with one link of a record in store, or null when it resolves. */
export function linkProblem(ctx, store, value) {
  const v = String(value ?? '').trim();
  if (!v) return 'an empty link';
  const d = DECISION.exec(v);
  if (d) return refProblem(machineStores(ctx), store, { store: d[1] || null, id: d[2].toUpperCase() }, ctx.brainDir || store.dir);
  if (PRINCIPLE.test(v)) {
    // A workflow install without docs/principles cannot check the number: the form is enough there.
    return !fs.existsSync(PRINCIPLES) || fs.existsSync(path.join(PRINCIPLES, `${v.toUpperCase()}.md`)) ? null : `${v}: the workflow has no principle ${v.toUpperCase()}`;
  }
  if (memoryKeys(ctx).has(v)) return null;
  const file = fileState(ctx, store, v);
  if (file === 'tracked') return null;
  if (file === 'untracked') return `${v}: the file exists but git does not track it (local/, scratch/ and ignored files have no history)`;
  const similar = similarKeys(ctx, v);
  return `${v}: no record key, decision, principle or file tracked in git${similar.length ? ` (similar key: ${similar.join(', ')})` : ''}`;
}

/** Problems of the links values (each value once), [] when all resolve. */
export function linkProblems(ctx, store, values) {
  return [...new Set(values.map((v) => String(v).trim()))].map((v) => linkProblem(ctx, store, v)).filter(Boolean);
}

/** Refusal text of save for new links that do not resolve, or null. */
export function checkLinks(ctx, store, values) {
  const problems = linkProblems(ctx, store, values);
  return problems.length ? `relates_to: ${problems.join('; ')}; ${FORMS}; nothing saved` : null;
}

// Sources (D-0036): what a record was derived from or checked against must outlive the work files. scratch/, local/ and
// ignored files have no history (the one derived record of the machine pointed into scratch/), so a source is a file git
// tracks (material from outside goes to materialy/<topic>/ first), a decision, a principle or a URL. A record key is no
// source: the fingerprint reads files, and a key would never turn stale.
const URL_RE = /^https?:\/\/\S+$/i;
export const SOURCE_FORMS = 'a source is a file tracked in git (material from outside: save it to materialy/<topic>/ first, skill materialy), a decision (D-NNNN), a principle (P-NNN) or a URL';

/** What is wrong with one source of a record in store, or null when it lasts. */
export function sourceProblem(ctx, store, value) {
  const v = String(value ?? '').trim();
  if (!v) return 'an empty source';
  if (URL_RE.test(v)) return null;
  if (DECISION.test(v) || PRINCIPLE.test(v)) return linkProblem(ctx, store, v);
  const file = fileState(ctx, store, v);
  if (file === 'tracked') return null;
  if (file === 'untracked') return `${v}: git does not track it (scratch/, local/ and ignored files have no history)`;
  return `${v}: no such file${memoryKeys(ctx).has(v) ? ' (a record key is no source: name the file the record is in)' : ''}`;
}

/** Problems of the sources values (each value once), [] when all last. */
export function sourceProblems(ctx, store, values) {
  return [...new Set(values.map((v) => String(v).trim()))].map((v) => sourceProblem(ctx, store, v)).filter(Boolean);
}

/** Refusal text of save for new sources that do not last, or null. */
export function checkSources(ctx, store, values) {
  const problems = sourceProblems(ctx, store, values);
  return problems.length ? `sources: ${problems.join('; ')}; ${SOURCE_FORMS}; nothing saved` : null;
}

/** Work-file paths (scratch/) named in a body: they vanish when the work files are cleaned (consolidate, D-0036). */
export function scratchPaths(body) {
  const found = [...String(body || '').matchAll(/(?:^|[\s(`'"[])(\/?(?:[\w.~-]+\/)*scratch\/[^\s)`'"\],;]+)/gm)].map((m) => m[1].replace(/[.,;:]+$/, ''));
  return [...new Set(found)];
}

const arg = (v) => (/[\s"'$`\\]/.test(v) ? `"${v.replace(/(["$`\\])/g, '\\$1')}"` : v);

/** The save command that drops (or replaces) a link that does not resolve (consolidate, D-0029). */
export function linkFix(ctx, r, value) {
  const { opts, note } = storeOptions(ctx, r.storeOf);
  const similar = similarKeys(ctx, value);
  const others = (r.relates_to || []).filter((v) => v !== value);
  const add = similar.length === 1 ? ` --relates-to ${similar[0]}` : r.kind === 'decision' && !others.length ? ' --relates-to <key|D-NNNN|P-NNN|file>' : '';
  const what = r.kind === 'decision' ? `decision --relink ${String(r.id || r.key).toUpperCase()}` : `memory ${memoryArgs(r)}`;
  return `save.mjs ${what}${opts} --unrelate ${arg(value)}${add}${note}`;
}
