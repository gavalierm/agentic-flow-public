// Knowledge of one repo of a domain, kept in the repo itself: `<repo>/agentic/` (D-0002, P-007 step 4). It travels with
// the code, so whoever takes the repo over gets it (operator 2026-11-04). Read together with the brain; written only by
// save (P-013), committed into the repo, never into the brain.
import fs from 'node:fs';
import path from 'node:path';
import { git, readJson, toPosix, isInside, listFiles } from './util.mjs';
import { BRAIN_COMMIT_TAG, DOMAIN_MARKER, WORKTREES_DIR, WORKFLOW_CONFIG, brainScriptEnv, mainCheckout, resolveDomain, threadId } from './config.mjs';
import { readHolder } from './brain.mjs';
import { cloneWrite, ownCloneDir } from './own-clone.mjs';
import { checkBrainFile } from './brain-checks.mjs';
import { LAYOUT, dataPath, dataRel, dataLayoutVersion, layoutFor, ROLE_REPO } from './layout.mjs';
import { readTopicRecord, workTopic } from './topic-files.mjs';
import { targetBranch, contentTarget } from './target.mjs';
import { INDEX_FILE, refreshIndex, refreshDeployIgnores, formatDeployIgnores } from './data-index.mjs';

/** Project knowledge folder in a repo (v3, D-0002): travels with the repo, never deployed. Layout 1; layout 2 is the repo root. */
export const PROJECT_KNOWLEDGE = LAYOUT.projectKnowledge;
const KIND_NAMES = { memory: 'memory', decisions: 'decision', runbooks: 'runbook', skills: 'skill', rules: 'rule' };
/**
 * Folders of a knowledge root in layout `version` (relative to it) and the record kind each holds (memoized). A knowledge
 * root is a project repo (or its agentic/ in layout 1): the map of the repo role (layout 3: .brain/ as in layout 2).
 */
const repoLayout = (version) => layoutFor(version, ROLE_REPO);
const KINDS = new Map();
export function knowledgeKindsFor(version = 1) {
  if (!KINDS.has(version)) {
    const L = repoLayout(version);
    KINDS.set(version, Object.freeze(Object.fromEntries(Object.entries(KIND_NAMES).map(([n, kind]) => [L[n], kind]))));
  }
  return KINDS.get(version);
}
/** Subfolders of `<repo>/agentic/` and the record kind each holds (layout 1; knowledgeKinds(dir) per version). */
export const KNOWLEDGE_KINDS = knowledgeKindsFor(1);
export const REPO_HANDOVER = LAYOUT.repoHandover;
/** Kinds and handover of the knowledge root `dir` (`<repo>/agentic` in layout 1, the repo itself in layout 2). */
export const knowledgeKinds = (dir) => knowledgeKindsFor(dataLayoutVersion(dir));
export const repoHandoverRel = (dir) => dataRel(dir, 'repoHandover');
export const knowledgeLabel = (dir) => dataRel(dir, 'projectKnowledge') || '.';

/** Kind of a path relative to a knowledge root (longest folder first), 'handover', or null. */
export function knowledgeKindOf(version, rel) {
  const r = String(rel).split('\\').join('/');
  if (r === repoLayout(version).repoHandover) return 'handover';
  const kinds = knowledgeKindsFor(version);
  const sub = Object.keys(kinds).sort((a, b) => b.length - a.length).find((k) => r.startsWith(`${k}/`));
  return sub ? { sub, kind: kinds[sub] } : null;
}

/**
 * Markdown files of a knowledge root: [{ file, rel, kind }]. Layout 1: every .md under `<repo>/agentic/` (kind by its
 * folder, else 'project'); layout 2: only the knowledge folders and the handover (the root is the repo with its code).
 */
export function knowledgeFiles(dir) {
  const v = dataLayoutVersion(dir);
  const md = (d) => listFiles(d, (x) => x.endsWith('.md'));
  // A knowledge folder of its own (layout 1 agentic/): every .md in it; else the repo root with its code beside.
  const files = repoLayout(v).projectKnowledge !== '' ? md(dir) : [...Object.keys(knowledgeKindsFor(v)).flatMap((sub) => md(path.join(dir, ...sub.split('/')))), dataPath(dir, 'repoHandover')].filter((f) => fs.existsSync(f));
  return files.map((file) => {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const k = knowledgeKindOf(v, rel);
    return { file, rel, kind: k === 'handover' ? 'handover' : k ? k.kind : 'project' };
  });
}

/**
 * The path is knowledge written only by save (P-013): layout 1 anything under `<repo>/agentic/`; layout 2 the workflow
 * data of the repo (.brain/), its decisions and of a topic its record and handover (the rest is code and work files).
 */
export function knowledgeProtected(dir, abs) {
  if (!isInside(dir, abs)) return false;
  const L = repoLayout(dataLayoutVersion(dir));
  if (L.projectKnowledge !== '') return true;
  const rel = path.relative(dir, abs).split(path.sep).join('/');
  const under = (p) => rel === p || rel.startsWith(`${p}/`);
  if (under(L.policy.split('/')[0]) || under(L.decisions)) return true;
  const parts = rel.split('/');
  return parts.length === 3 && parts[0] === L.topics && [L.topicFile, L.handover].includes(parts[2]);
}

const hasChildDomain = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, DOMAIN_MARKER))); } catch { return false; }
};

/**
 * Repos of a domain that can hold knowledge: visible folders of the domain root that are a git repo or already have
 * agentic/, without the domain brain and without a folder of nested domains (the pilot holds whole test domains).
 */
export function domainRepos(domain, brainDir = null) {
  if (!domain?.root || !fs.existsSync(domain.root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(domain.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(domain.root, entry.name);
    if (brainDir && path.resolve(dir) === path.resolve(brainDir)) continue;
    if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(dataPath(dir, 'projectKnowledge'))) continue;
    if (hasChildDomain(dir)) continue;
    out.push({ name: entry.name, dir });
  }
  return out;
}

/** Topic worktrees of a repo: `<domain>/.worktrees/<repo>/<id>/` (hidden entries are scratch of save). */
export function repoWorktrees(domain, repo) {
  if (!domain?.root) return [];
  const base = path.join(domain.root, WORKTREES_DIR, repo);
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(base, e.name, '.git')))
      .map((e) => ({ topic: e.name, dir: path.join(base, e.name) }));
  } catch { return []; }
}

/** Knowledge folders of a repo: its main checkout first, then every topic worktree (topic: null for the main one). */
export function knowledgeDirs(domain, repo) {
  return [{ topic: null, dir: dataPath(path.join(domain.root, repo), 'projectKnowledge') }, ...repoWorktrees(domain, repo).map((w) => ({ topic: w.topic, dir: dataPath(w.dir, 'projectKnowledge') }))];
}

/**
 * Knowledge folders this session works with: the session checkout's agentic/ (its repo) and agentic/ of every code-topic
 * worktree the thread holds. Deduplicated by path; used by skills-sync and the start line.
 */
export function sessionKnowledgeSources(ctx) {
  if (!ctx?.domain) return [];
  const out = [];
  const seen = new Set();
  const add = (repo, topic, dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ repo, topic, dir });
  };
  const own = sessionRepo(ctx);
  if (own) add(own, null, dataPath(ctx.projectDir, 'projectKnowledge'));
  for (const r of domainRepos(ctx.domain, ctx.brainDir)) {
    const w = heldRepoTopic(ctx, r.name);
    if (w) add(r.name, w.topic, dataPath(w.dir, 'projectKnowledge'));
  }
  return out;
}

/**
 * Knowledge folders whose skills the session deploys: the session sources, and for a session that runs in the domain
 * brain (no repo of its own, a persona) also agentic/ of the main checkout of every domain repo. A persona does the
 * domain's work from its brain while the skills over a repo live in <repo>/agentic/skills (operator 2026-11-08).
 * Only skills: the start line and HANDOVER stay with sessionKnowledgeSources.
 */
export function skillSources(ctx) {
  const out = sessionKnowledgeSources(ctx);
  if (!ctx?.domain || sessionRepo(ctx)) return out;
  const seen = new Set(out.map((s) => s.repo));
  for (const r of domainRepos(ctx.domain, ctx.brainDir)) {
    if (!seen.has(r.name)) out.push({ repo: r.name, topic: null, dir: dataPath(r.dir, 'projectKnowledge') });
  }
  return out;
}

/** skillSources for the adapter, which has no session context: the same sources a start or save of this project deploys. */
export function adapterSkillSources(projectDir, brainDir) {
  return skillSources({ projectDir, brainDir, domain: resolveDomain(projectDir), thread: threadId() });
}

/** Repo of the domain by name; fails with the list of valid names. */
export function repoByName(domain, name, brainDir = null) {
  if (!domain) throw new Error('--repo needs a domain (.agentic-domain); this project is not in one (D-0002)');
  const repos = domainRepos(domain, brainDir);
  const hit = repos.find((r) => r.name === name);
  if (!hit) throw new Error(`--repo ${name}: no such repo in domain ${path.basename(domain.root)} (repos: ${repos.map((r) => r.name).join(', ') || 'none'})`);
  if (!fs.existsSync(path.join(hit.dir, '.git'))) throw new Error(`--repo ${name}: ${hit.dir} is not a git repo; knowledge is committed into the repo`);
  return hit;
}

/** The repo of the session (its main checkout); null when the session runs in the brain itself (a persona). */
export function sessionRepo(ctx) {
  if (!ctx.domain) return null;
  const main = mainCheckout(ctx.projectDir);
  if (ctx.brainDir && path.resolve(main) === path.resolve(ctx.brainDir)) return null;
  return path.dirname(main) === path.resolve(ctx.domain.root) ? path.basename(main) : null;
}

/** Repo whose files a list of paths (relates_to, sources) all point into, or null (knowledge about several repos stays in brain). */
export function singleRepoOf(domain, brainDir, refs) {
  const repos = domainRepos(domain, brainDir).map((r) => r.name);
  const hits = new Set();
  for (const ref of refs.map((r) => toPosix(String(r)).replace(/^(\.\.?\/)+/, ''))) {
    const first = ref.split('/')[0];
    if (!repos.includes(first) || !ref.includes('/')) return null;
    hits.add(first);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Highest D-number a store's git history ever had under `dir` (one git call over all branches): a removed or moved
 * decision keeps its number, so a new one never reuses it (D-0028).
 */
export function historyDecisionMax(cwd, dir) {
  const r = git(['log', '--all', '--format=', '--name-only', '--', dir], { cwd });
  let max = 0;
  if (r.ok) for (const line of r.stdout.split('\n')) { const m = /(?:^|\/)d-(\d+)[^/]*$/i.exec(line.trim()); if (m) max = Math.max(max, Number(m[1])); }
  return max;
}

/**
 * Highest D-number of a repo over its main checkout, all topic worktrees and its history (a removed or moved decision
 * keeps its number), plus one (`<repo>/D-0001`).
 */
export function nextRepoDecisionId(domain, repo) {
  const repoDir = path.join(domain.root, repo);
  const decisionsRel = dataRel(repoDir, 'projectKnowledge', dataRel(dataPath(repoDir, 'projectKnowledge'), 'decisions'));
  let max = historyDecisionMax(repoDir, decisionsRel);
  // The own clone of save (spec 4.1) holds the latest decisions of origin, written by every thread of the machine.
  const clone = ownCloneDir(repoDir);
  const cloned = fs.existsSync(path.join(clone, '.git')) ? [{ dir: dataPath(clone, 'projectKnowledge') }] : [];
  if (cloned.length) max = Math.max(max, historyDecisionMax(clone, decisionsRel));
  for (const { dir } of [...knowledgeDirs(domain, repo), ...cloned]) {
    let files = [];
    try { files = fs.readdirSync(dataPath(dir, 'decisions')); } catch { continue; }
    for (const f of files) {
      const m = /^d-(\d+)/i.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
      const text = f.endsWith('.md') ? fs.readFileSync(dataPath(dir, 'decisions', f), 'utf8') : '';
      const id = /^id:\s*D-(\d+)\s*$/m.exec(text);
      if (id) max = Math.max(max, Number(id[1]));
    }
  }
  return `D-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Branch that receives knowledge saved into a repo: its target branch (`target_branch` in its .workflow.json, default
 * main; plan O12, scripts/target.mjs).
 */
export function knowledgeBranch(repoDir) {
  return targetBranch(repoDir);
}

/** Code topic of the repo held by this thread with an existing worktree, or null. */
export function heldRepoTopic(ctx, repo) {
  if (!ctx.thread || !ctx.domain) return null;
  for (const w of repoWorktrees(ctx.domain, repo)) {
    const topic = readTopicRecord(ctx.brainDir, w.topic);
    if (topic?.kind !== 'code') continue;
    if (readHolder(ctx.brainDir, w.topic)?.thread === ctx.thread) return w;
  }
  return null;
}

/** Format checks of a knowledge file, the same as brain records (P-049, P-031, P-009, P-032), without the holder check. */
export function checkKnowledgeFile(rel, content, policy, version = 1) {
  const errors = [];
  const r = toPosix(rel);
  const L = repoLayout(version);
  const home = L.projectKnowledge ? `${L.projectKnowledge}/` : 'the repo';
  if (r.split('/').includes('..') || path.isAbsolute(r)) return [`${r}: path must be relative inside ${home}`];
  if (r === L.repoHandover) {
    if (content !== null && !String(content).trim()) errors.push(`${r}: empty handover`);
    const limit = policy?.limits?.repo_handover_lines ?? 150;
    const n = String(content ?? '').replace(/\n+$/, '').split('\n').length;
    if (content !== null && n > limit) errors.push(`${r}: ${n} lines, limit ${limit}; the repo handover keeps the current state, not history (P-011)`);
    return errors;
  }
  const kinds = knowledgeKindsFor(version);
  const k = knowledgeKindOf(version, r);
  if (!k || k === 'handover') return [`${r}: ${home} holds ${L.repoHandover}, ${Object.keys(kinds).join('/, ')}/ (D-0002)`];
  const sub = k.sub;
  // Skills of a repo are agentic only (operator skills stay in brain): checked as skills/agentic/<name>/SKILL.md.
  const asBrain = sub === L.skills && r.length > sub.length ?[L.skills, 'agentic', r.slice(sub.length + 1)].join('/') : r;
  return errors.concat(checkBrainFile(asBrain, content, { policy, version, role: ROLE_REPO }).map((e) => e.replace(asBrain, r)));
}

/**
 * A code repo public on GitHub (`"visibility": "public"` in its .workflow.json, written by connect): its knowledge stays in
 * the private brain. save --repo would have pushed project records, decisions and deploy runbooks publicly (alice 2026-11-11).
 */
export function repoPublic(dir) {
  return readJson(path.join(dir, WORKFLOW_CONFIG), {})?.visibility === 'public';
}

/**
 * Write knowledge files into a repo (P-013: save is the only writer) through the own clone of the workflow (spec 4.1, plan
 * B8): pull, write, commit, push on the target branch (topic/<topic>--obsah when it is protected), never in the checkout of a human or in a topic worktree. ops are
 * relative to the knowledge root (`<repo>/agentic/` in layout 1, the repo in layout 2 and 3): [{ path, content }] or
 * [{ path, remove: true }]. INDEX.md and the deploy ignore files of the repo go into the same commit; a conflict in
 * INDEX.md after a refused push is settled by writing it again, one in another file is a question to the operator. A
 * refused commit (the repo's pre-commit) or push leaves nothing behind.
 * rewrite(knowledgeDir): extra ops computed from the clone the write lands in (references save move rewrites), the same commit.
 */
export function repoWrite(ctx, repoName, { ops: given, message, rewrite = null }) {
  const repo = repoByName(ctx.domain, repoName, ctx.brainDir);
  if (repoPublic(repo.dir)) throw new Error(`${repo.name} is public on GitHub ("visibility": "public" in ${repo.name}/${WORKFLOW_CONFIG}): its knowledge would be pushed publicly; save it into brain without --repo (a project-${repo.name} record needs no --brain), secrets into local/`);
  if (!message || !String(message).trim()) throw new Error('commit message required');
  const version = dataLayoutVersion(repo.dir);
  const errors = given.flatMap((op) => checkKnowledgeFile(op.path, op.remove ? null : op.content, ctx.policy, version));
  if (errors.length) throw new Error(errors.join('\n'));
  // Spec 4.1, 4.6: the target branch, or topic/<topic>--obsah of the held topic when only a human writes into it.
  const work = workTopic(ctx);
  const where = contentTarget(repo.dir, work && work !== 'main' ? work : null);
  const branch = where.branch;
  const env = brainScriptEnv();
  let paths = [];
  let deployIgnores = [];
  const res = cloneWrite(repo.dir, {
    branch,
    base: where.protected ? where.target : null,
    name: repo.name,
    message: `${BRAIN_COMMIT_TAG} ${message}`,
    env,
    indexFiles: [INDEX_FILE],
    ops: (dir) => {
      let ops = given;
      if (rewrite) {
        const extra = rewrite(dataPath(dir, 'projectKnowledge')).filter((op) => !ops.some((o) => toPosix(o.path) === toPosix(op.path)));
        const bad = extra.flatMap((op) => checkKnowledgeFile(op.path, op.content, ctx.policy, version));
        if (bad.length) throw new Error(bad.join('\n'));
        ops = [...ops, ...extra];
      }
      const rels = ops.map((op) => dataRel(dir, 'projectKnowledge', toPosix(op.path)));
      paths = rels.map((r) => `${repo.name}/${r}`);
      return ops.map((op, i) => ({ ...op, path: rels[i] }));
    },
    // Layout 2 and 3: INDEX.md of the staged files; deploy ignore files (.assetsignore ...) get the internal folders.
    index: (dir) => {
      refreshIndex(dir, env);
      const added = refreshDeployIgnores(dir, env);
      if (added.length) deployIgnores = added;
    },
  });
  return { committed: res.committed, sha: res.sha, pushed: res.pushed, repo: repo.name, branch, paths, deployIgnores, notes: res.notes };
}

export function formatRepoWrite(res) {
  const ignores = formatDeployIgnores(res.deployIgnores);
  const where = res.committed ? `${res.branch}, pushed from the own clone of the workflow` : res.branch;
  return [`${res.committed ? 'written' : 'unchanged'}: ${res.paths.join(', ')}${res.sha ? ` (${res.repo} ${res.sha})` : ''} [${where}]`, ...(res.notes || []), ...(ignores ? [ignores] : [])].join('\n');
}

/** Absolute knowledge folder a path lies in (`<repo>/agentic/` of the domain or of a topic worktree), or null. */
export function knowledgeDirOf(domain, brainDir, abs) {
  if (!domain?.root || !isInside(domain.root, abs)) return null;
  for (const r of domainRepos(domain, brainDir)) {
    for (const k of knowledgeDirs(domain, r.name)) if (knowledgeProtected(k.dir, abs)) return { repo: r.name, topic: k.topic, dir: k.dir };
  }
  return null;
}
