// Knowledge of one repo of a domain, kept in the repo itself: `<repo>/agentic/` (D-0002, P-007 step 4). It travels with
// the code, so whoever takes the repo over gets it (operator 2026-11-04). Read together with the brain; written only by
// save (P-013), committed into the repo, never into the brain.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRetry, readJson, toPosix, isInside } from './util.mjs';
import { BRAIN_COMMIT_TAG, DOMAIN_MARKER, WORKTREES_DIR, WORKFLOW_CONFIG, brainScriptEnv, mainCheckout } from './config.mjs';
import { withBrainLock, readHolder } from './brain.mjs';
import { checkBrainFile } from './brain-checks.mjs';

/** Project knowledge folder in a repo (v3, D-0002): travels with the repo, never deployed. */
export const PROJECT_KNOWLEDGE = 'agentic';
/** Subfolders of `<repo>/agentic/` and the record kind each holds. */
export const KNOWLEDGE_KINDS = { memory: 'memory', decisions: 'decision', runbooks: 'runbook', skills: 'skill' };
export const REPO_HANDOVER = 'HANDOVER.md';

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
    if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(path.join(dir, PROJECT_KNOWLEDGE))) continue;
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
  return [{ topic: null, dir: path.join(domain.root, repo, PROJECT_KNOWLEDGE) }, ...repoWorktrees(domain, repo).map((w) => ({ topic: w.topic, dir: path.join(w.dir, PROJECT_KNOWLEDGE) }))];
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
  if (own) add(own, null, path.join(ctx.projectDir, PROJECT_KNOWLEDGE));
  for (const r of domainRepos(ctx.domain, ctx.brainDir)) {
    const w = heldRepoTopic(ctx, r.name);
    if (w) add(r.name, w.topic, path.join(w.dir, PROJECT_KNOWLEDGE));
  }
  return out;
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

/** Highest D-number of a repo over its main checkout and all topic worktrees, plus one (`<repo>/D-0001`). */
export function nextRepoDecisionId(domain, repo) {
  let max = 0;
  for (const { dir } of knowledgeDirs(domain, repo)) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'decisions')); } catch { continue; }
    for (const f of files) {
      const m = /^d-(\d+)/i.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
      const text = f.endsWith('.md') ? fs.readFileSync(path.join(dir, 'decisions', f), 'utf8') : '';
      const id = /^id:\s*D-(\d+)\s*$/m.exec(text);
      if (id) max = Math.max(max, Number(id[1]));
    }
  }
  return `D-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Branch that receives knowledge saved outside a code topic: `knowledge_branch` in the repo's .workflow.json, else dev
 * when the repo has it. main is never guessed: in some repos it is production (mojprojekt), so it must be named.
 */
export function knowledgeBranch(repoDir) {
  const cfg = readJson(path.join(repoDir, WORKFLOW_CONFIG), {}) || {};
  if (typeof cfg.knowledge_branch === 'string' && cfg.knowledge_branch.trim()) return cfg.knowledge_branch.trim();
  if (git(['rev-parse', '--verify', '--quiet', 'refs/heads/dev'], { cwd: repoDir }).ok) return 'dev';
  throw new Error(`${path.basename(repoDir)} has no knowledge branch: set "knowledge_branch": "<branch>" in ${path.basename(repoDir)}/${WORKFLOW_CONFIG} (the repo owner decides; main may be production), or save inside a code topic of the repo`);
}

/** Code topic of the repo held by this thread with an existing worktree, or null. */
export function heldRepoTopic(ctx, repo) {
  if (!ctx.thread || !ctx.domain) return null;
  for (const w of repoWorktrees(ctx.domain, repo)) {
    const topic = readJson(path.join(ctx.brainDir, 'topics', w.topic, 'topic.json'), null);
    if (topic?.kind !== 'code') continue;
    if (readHolder(ctx.brainDir, w.topic)?.thread === ctx.thread) return w;
  }
  return null;
}

function worktreeOf(repoDir, branch) {
  const list = git(['worktree', 'list', '--porcelain'], { cwd: repoDir });
  if (!list.ok) return null;
  let dir = null;
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return null;
}

/** Format checks of a knowledge file, the same as brain records (P-049, P-031, P-009, P-032), without the holder check. */
export function checkKnowledgeFile(rel, content, policy) {
  const errors = [];
  const r = toPosix(rel);
  if (r.split('/').includes('..') || path.isAbsolute(r)) return [`${r}: path must be relative inside ${PROJECT_KNOWLEDGE}/`];
  if (r === REPO_HANDOVER) {
    if (content !== null && !String(content).trim()) errors.push(`${r}: empty handover`);
    const limit = policy?.limits?.repo_handover_lines ?? 150;
    const n = String(content ?? '').replace(/\n+$/, '').split('\n').length;
    if (content !== null && n > limit) errors.push(`${r}: ${n} lines, limit ${limit}; the repo handover keeps the current state, not history (P-011)`);
    return errors;
  }
  const sub = r.split('/')[0];
  if (!KNOWLEDGE_KINDS[sub]) return [`${r}: ${PROJECT_KNOWLEDGE}/ holds ${REPO_HANDOVER}, ${Object.keys(KNOWLEDGE_KINDS).join('/, ')}/ (D-0002)`];
  // Skills of a repo are agentic only (operator skills stay in brain): checked as skills/agentic/<name>/SKILL.md.
  const asBrain = sub === 'skills' ? r.replace(/^skills\//, 'skills/agentic/') : r;
  return errors.concat(checkBrainFile(asBrain, content, { policy }).map((e) => e.replace(asBrain, r)));
}

/**
 * Write knowledge files into a repo and commit them there (P-013: save is the only writer). ops are relative to
 * `<repo>/agentic/`: [{ path, content }] or [{ path, remove: true }]. Target: the code topic of the repo held by this
 * thread (its worktree, branch topic/<id>, reaches the repo through done --topic); else the knowledge branch, through
 * the checkout that has it or a temporary worktree. Only agentic/ paths are committed, nothing is pushed. A refused
 * commit (the repo's pre-commit) leaves nothing behind.
 */
export function repoWrite(ctx, repoName, { ops, message }) {
  const repo = repoByName(ctx.domain, repoName, ctx.brainDir);
  if (!message || !String(message).trim()) throw new Error('commit message required');
  const errors = ops.flatMap((op) => checkKnowledgeFile(op.path, op.remove ? null : op.content, ctx.policy));
  if (errors.length) throw new Error(errors.join('\n'));
  return withBrainLock(repo.dir, () => {
    const topic = heldRepoTopic(ctx, repo.name);
    let dir = topic?.dir;
    let branch = topic ? `topic/${topic.topic}` : null;
    let temp = null;
    if (!dir) {
      branch = knowledgeBranch(repo.dir);
      if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo.dir }).ok) throw new Error(`${repo.name}: knowledge branch ${branch} does not exist`);
      dir = worktreeOf(repo.dir, branch);
      if (!dir) {
        temp = path.join(repo.dir, '.git', `workflow-save-${process.pid}`);
        fs.rmSync(temp, { recursive: true, force: true });
        git(['worktree', 'prune'], { cwd: repo.dir });
        const add = git(['worktree', 'add', '--quiet', temp, branch], { cwd: repo.dir });
        if (!add.ok) throw new Error(`${repo.name}: temporary worktree on ${branch} failed: ${add.stderr.split('\n')[0]}`);
        dir = temp;
      }
    }
    const rels = ops.map((op) => `${PROJECT_KNOWLEDGE}/${toPosix(op.path)}`);
    try {
      const dirty = git(['status', '--porcelain', '--', ...rels], { cwd: dir });
      if (dirty.ok && dirty.stdout.trim()) throw new Error(`${repo.name} (${branch}): uncommitted changes in ${dirty.stdout.trim().split('\n').map((l) => l.slice(3)).join(', ')}; only save writes ${PROJECT_KNOWLEDGE}/, settle them first (commit or restore)`);
      for (const [i, op] of ops.entries()) {
        const file = path.join(dir, rels[i]);
        if (op.remove) fs.rmSync(file, { recursive: true, force: true });
        else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, op.content); }
      }
      const env = brainScriptEnv();
      const add = gitRetry(['add', '-A', '--', ...rels], { cwd: dir, env });
      if (!add.ok) throw new Error(`git add failed: ${add.stderr.split('\n')[0]}`);
      const staged = git(['diff', '--cached', '--quiet', '--', ...rels], { cwd: dir });
      const result = { committed: false, sha: null, repo: repo.name, branch, topic: topic?.topic || null, paths: rels.map((r) => `${repo.name}/${r}`) };
      if (staged.ok) return result;
      const commit = gitRetry(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} ${message}`, '--', ...rels], { cwd: dir, env });
      if (!commit.ok) {
        for (const rel of rels) {
          if (git(['cat-file', '-e', `HEAD:${rel}`], { cwd: dir }).ok) git(['checkout', '--quiet', 'HEAD', '--', rel], { cwd: dir });
          else { git(['rm', '-r', '--quiet', '--cached', '--ignore-unmatch', '--', rel], { cwd: dir }); fs.rmSync(path.join(dir, rel), { recursive: true, force: true }); }
        }
        throw new Error(`commit into ${repo.name} (${branch}) failed: ${String(commit.stderr || commit.stdout).trim().split('\n').slice(0, 6).join('\n')}`);
      }
      result.committed = true;
      result.sha = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout;
      return result;
    } finally {
      if (temp) {
        git(['worktree', 'remove', '--force', temp], { cwd: repo.dir });
        fs.rmSync(temp, { recursive: true, force: true });
        git(['worktree', 'prune'], { cwd: repo.dir });
      }
    }
  });
}

export function formatRepoWrite(res) {
  const where = res.topic ? `topic ${res.topic} worktree, ${res.branch}: reaches the repo through done --topic` : `${res.branch}, not pushed`;
  return `${res.committed ? 'written' : 'unchanged'}: ${res.paths.join(', ')}${res.sha ? ` (${res.repo} ${res.sha})` : ''} [${where}]`;
}

/** Absolute knowledge folder a path lies in (`<repo>/agentic/` of the domain or of a topic worktree), or null. */
export function knowledgeDirOf(domain, brainDir, abs) {
  if (!domain?.root || !isInside(domain.root, abs)) return null;
  for (const r of domainRepos(domain, brainDir)) {
    for (const k of knowledgeDirs(domain, r.name)) if (isInside(k.dir, abs)) return { repo: r.name, topic: k.topic, dir: k.dir };
  }
  return null;
}
