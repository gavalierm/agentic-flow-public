// Knowledge stores of the machine (D-0028): one subject has one record in one place. save, find, move and consolidate
// see the same set: the brains the projects of each domain point to (a persona "." included), each domain's brain and
// <repo>/agentic/ of the domain repos. A folder with memory/ that no .workflow.json points to (a copy of another brain
// kept for reading) is no store. Read only; nothing here writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMAIN_MARKER, WORKFLOW_CONFIG, LOCAL_CONFIG, PERSONA_BRAIN, brainExists } from './config.mjs';
import { listFiles, readJson, realPathLoose, toPosix } from './util.mjs';
import { PROJECT_KNOWLEDGE, REPO_HANDOVER, domainRepos, knowledgeDirs } from './repo-knowledge.mjs';
import { readMemory, readDecisions, readRules, readSkills, repoRecords } from './records.mjs';

/** Memory types that name one subject across the machine: a second record of it in another store is refused. */
export const SUBJECT_TYPES = ['project', 'service', 'person', 'tool'];

const same = (a, b) => !!a && !!b && realPathLoose(a) === realPathLoose(b);
const show = (p) => toPosix(p);
/** Names compare case-insensitively, spaces collapsed. */
export const lc = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Visible subfolders, never through a symlink (an old name of a renamed domain points to the same folder). */
function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name)); } catch { return []; }
}

/** Brain a project folder points to (local/workflow.json, then .workflow.json; "." is the folder itself), without git. */
function configuredBrain(dir) {
  for (const f of [LOCAL_CONFIG, WORKFLOW_CONFIG]) {
    const cfg = readJson(path.join(dir, f), null);
    if (!cfg || typeof cfg.brain !== 'string') continue;
    const rel = cfg.brain.trim();
    if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) return null;
    return rel.replace(/\/+$/, '') === PERSONA_BRAIN ? dir : path.resolve(dir, rel);
  }
  return null;
}

function markerBrain(root) {
  const cfg = readJson(path.join(root, DOMAIN_MARKER), {}) || {};
  return typeof cfg.brain === 'string' && !path.isAbsolute(cfg.brain) ? path.resolve(root, cfg.brain) : null;
}

/** Stores of one domain: its brain first, then the brains its projects point to, then the repos with agentic/. */
function domainStores(root, domainBrain) {
  const out = [];
  const brains = [];
  const addBrain = (dir, project) => {
    if (!dir || !brainExists(dir)) return;
    const hit = brains.find((b) => same(b.dir, dir));
    if (hit) { if (!hit.project && project) hit.project = project; return; }
    const s = { name: path.basename(path.resolve(dir)), kind: 'brain', dir: path.resolve(dir), knowledge: path.resolve(dir), domainRoot: root, project: project || null };
    brains.push(s);
    out.push(s);
  };
  addBrain(domainBrain, null);
  const dirs = subdirs(root);
  for (const dir of dirs) addBrain(configuredBrain(dir), dir);
  const domainProject = brains[0]?.project || brains.find((b) => b.project)?.project || null;
  for (const r of domainRepos({ root }, null)) {
    if (brains.some((b) => same(b.dir, r.dir))) continue;
    if (!knowledgeDirs({ root }, r.name).some((k) => fs.existsSync(k.dir))) continue;
    out.push({ name: r.name, kind: 'repo', dir: r.dir, knowledge: path.join(r.dir, PROJECT_KNOWLEDGE), domainRoot: root, repo: r.name, project: domainProject });
  }
  return out;
}

const storeCache = new Map();

/**
 * Every knowledge store of the machine for a session, in search order: the session brain, the domain brain, the other
 * stores of the session domain, then the other domains. The root is the parent of the session's domain folder; its
 * domains are the subfolders with DOMAIN_MARKER. A test fixture has that root in its own tree, so it sees only itself;
 * a domain directly in the system temp folder sees only its own domain. A project without a marker of its own (the
 * pilot) belongs to the domain above it and sees the stores of that machine.
 */
export function machineStores(ctx) {
  const cacheKey = `${ctx.brainDir}|${ctx.domain?.root || ''}`;
  if (storeCache.has(cacheKey)) return storeCache.get(cacheKey);
  const out = [];
  const push = (s) => { if (!out.some((o) => same(o.dir, s.dir))) out.push(s); };
  if (ctx.brainDir) push({ name: path.basename(path.resolve(ctx.brainDir)), kind: 'brain', dir: path.resolve(ctx.brainDir), knowledge: path.resolve(ctx.brainDir), domainRoot: ctx.domain?.root || null, project: ctx.projectDir, session: true, sessionDomain: true });
  if (ctx.domain?.root) {
    const own = path.resolve(ctx.domain.root);
    for (const s of domainStores(own, ctx.domain.brain)) push({ ...s, sessionDomain: true });
    const root = path.dirname(own);
    if (!same(root, os.tmpdir())) {
      for (const d of subdirs(root)) {
        if (same(d, own) || !fs.existsSync(path.join(d, DOMAIN_MARKER))) continue;
        for (const s of domainStores(d, markerBrain(d))) push(s);
      }
    }
  }
  storeCache.set(cacheKey, out);
  return out;
}

/** Stores a consolidate of this session reports on: the session brain, the domain brain and the domain repos. */
export function sessionStores(ctx) {
  return machineStores(ctx).filter((s) => s.session || (s.sessionDomain && (s.kind === 'repo' || same(s.dir, ctx.domain?.brain))));
}

const recordCache = new Map();

/** Records of one store, paths relative to base (the session brain), each with its store (r.storeOf). */
export function storeRecords(store, base) {
  const cacheKey = `${store.dir}|${base}`;
  if (recordCache.has(cacheKey)) return recordCache.get(cacheKey);
  const recs = store.kind === 'brain'
    ? [...readMemory(store.dir, base), ...readDecisions(store.dir, base), ...readRules(store.dir, base), ...readSkills(store.dir, base)]
    : repoRecords({ root: store.domainRoot }, store.repo, base);
  for (const r of recs) r.storeOf = store;
  recordCache.set(cacheKey, recs);
  return recs;
}

/** Records of every store of the machine in search order. */
export function machineRecords(ctx) {
  return machineStores(ctx).flatMap((s) => storeRecords(s, ctx.brainDir || s.dir));
}

/** The store a save writes into: the session brain, or the repo of the session domain. */
export function targetStore(ctx, repo = null) {
  const stores = machineStores(ctx);
  if (!repo) return stores.find((s) => s.session);
  const dir = path.join(ctx.domain.root, repo);
  return stores.find((s) => s.kind === 'repo' && same(s.dir, dir)) || { name: repo, kind: 'repo', dir, knowledge: path.join(dir, PROJECT_KNOWLEDGE), domainRoot: ctx.domain.root, repo, sessionDomain: true };
}

export const sameStore = (a, b) => !!a && !!b && same(a.dir, b.dir);

/** Decision IDs a store has (its main checkout and topic worktrees for a repo). */
export function decisionIds(store, base = store.dir) {
  return new Set(storeRecords(store, base).filter((r) => r.kind === 'decision').map((r) => String(r.id || r.key).toUpperCase()));
}

/**
 * Files whose text may reference decisions: memory, decisions, rules and the handovers (a brain's topic handovers, a
 * repo's HANDOVER.md). knowledge: the folder to read (a repo's checkout the write lands in), default the store's own.
 */
export function refFiles(store, knowledge = store.knowledge) {
  const md = (sub) => listFiles(path.join(knowledge, sub), (f) => f.endsWith('.md'));
  const files = [...md('memory'), ...md('decisions'), ...md('rules')];
  if (store.kind === 'repo') {
    const ho = path.join(knowledge, REPO_HANDOVER);
    if (fs.existsSync(ho)) files.push(ho);
  } else {
    for (const t of subdirs(path.join(knowledge, 'topics'))) {
      if (path.basename(t) === 'archive') continue;
      const ho = path.join(t, 'handover.md');
      if (fs.existsSync(ho)) files.push(ho);
    }
  }
  return files;
}

// A bare D-NNNN means the own store; another store's decision is `<store>/D-NNNN` (a brain or repo name).
const BARE_REF = /(^|[^\w/-])(D-\d{4})\b/g;
const QUALIFIED_REF = /(^|[^\w/.-])([A-Za-z0-9][\w.-]*)\/(D-\d{4})\b/g;
/** Lines of a record's own frontmatter that carry IDs, not references. */
export const ID_LINE = /^\s*(key|id|moved_from):/;

/** Decision references in a text: [{ store (null = bare), id, line }]. */
export function decisionRefs(text, { skip = null } = {}) {
  const out = [];
  String(text ?? '').split('\n').forEach((l, i) => {
    if (skip && skip.test(l)) return;
    for (const m of l.matchAll(BARE_REF)) out.push({ store: null, id: m[2], line: i + 1 });
    for (const m of l.matchAll(QUALIFIED_REF)) out.push({ store: m[2], id: m[3], line: i + 1 });
  });
  return out;
}

/**
 * Text with decision references replaced: bare(id) and qualified(store, id) return the new reference or null (kept).
 * Lines matching skip (a record's own key, id, moved_from) stay as they are.
 */
export function rewriteDecisionRefs(text, { bare = () => null, qualified = () => null, skip = ID_LINE } = {}) {
  return String(text).split('\n').map((l) => {
    if (skip && skip.test(l)) return l;
    const q = l.replace(QUALIFIED_REF, (all, pre, store, id) => { const to = qualified(store, id); return to ? `${pre}${to}` : all; });
    return q.replace(BARE_REF, (all, pre, id) => { const to = bare(id); return to ? `${pre}${to}` : all; });
  }).join('\n');
}

/** What is wrong with one reference, read from target (the store the text lives in), or null. */
export function refProblem(stores, target, ref, base) {
  const ids = (s) => decisionIds(s, base);
  const holders = stores.filter((s) => ids(s).has(ref.id)).map((s) => `${s.name}/${ref.id}`);
  const where = holders.length ? `; it is ${holders.join(' or ')}` : `; no store has ${ref.id}`;
  if (!ref.store) return ids(target).has(ref.id) ? null : `${ref.id}: ${target.name} has no ${ref.id} (a bare D-NNNN means the own store${holders.length ? ', another store\'s decision is written <store>/D-NNNN' : ''})${where}`;
  const named = stores.filter((s) => s.name === ref.store);
  if (target.name === ref.store && !named.some((s) => sameStore(s, target))) named.push(target);
  if (named.some((s) => ids(s).has(ref.id))) return null;
  return named.length ? `${ref.store}/${ref.id}: ${ref.store} has no ${ref.id}${where}` : `${ref.store}/${ref.id}: no store ${ref.store}${where}`;
}

/**
 * Refusal text for decision references a save would write (D-0028): a bare D-NNNN the target store lacks, a
 * `<store>/D-NNNN` the named store lacks or of a store that does not exist. null when all resolve.
 */
export function checkDecisionRefs(ctx, target, texts) {
  const stores = machineStores(ctx);
  const base = ctx.brainDir || target.dir;
  const problems = [...new Set(texts.flatMap((t) => decisionRefs(t)).map((ref) => refProblem(stores, target, ref, base)).filter(Boolean))];
  return problems.length ? `decision references: ${problems.join('; ')}; nothing saved` : null;
}

/** Names of a subject record: name and aliases, compared case-insensitively. */
export function subjectNames(r) {
  return [r.data?.name, ...(r.aliases || [])].filter((v) => v !== undefined && v !== null && String(v).trim()).map(lc);
}

export const recordType = (r) => String(r.type || String(r.key).split('-')[0]);

/** How a memory record matches a subject: 'same key', 'name x', 'alias x', or null. */
export function subjectMatch(r, { key, names }) {
  if (r.kind !== 'memory') return null;
  if (r.key === key) return 'same key';
  if (!SUBJECT_TYPES.includes(recordType(r))) return null;
  const want = new Set(names.map(lc).filter(Boolean));
  const name = r.data?.name !== undefined ? lc(r.data.name) : null;
  if (name && want.has(name)) return `name "${name}"`;
  const alias = (r.aliases || []).map(lc).find((a) => want.has(a));
  return alias ? `alias "${alias}"` : null;
}

/** How to write into a record of another store: the save options that target it. */
export function saveHint(ctx, r) {
  const s = r.storeOf;
  const type = recordType(r);
  const name = r.data?.name ? String(r.data.name) : String(r.key).slice(type.length + 1);
  const quoted = /\s/.test(name) ? `"${name}"` : name;
  const opts = [];
  if (s.kind === 'repo') {
    opts.push(`--repo ${s.repo}`);
    if (!same(s.domainRoot, ctx.domain?.root) && s.project) opts.push(`--project ${show(s.project)}`);
  } else if (!s.session && s.project) opts.push(`--project ${show(s.project)}`);
  return `save.mjs memory ${type} ${quoted}${opts.length ? ` ${opts.join(' ')}` : ''} --content ...${!s.project && s.kind === 'brain' && !s.session ? ` (from a session of ${s.name})` : ''}`;
}

export const displayPath = (r) => show(r.abs);

// A tombstone is a short body that only says where the record went (consolidate reports it, save memory --remove takes
// it without an operator order: it holds no subject of its own).
const TOMBSTONE = /presun|moved|nahraden|superseded/i;
export const isTombstone = (body) => String(body || '').trim().length < 300 && TOMBSTONE.test(String(body || ''));
