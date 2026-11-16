// Own clone of the workflow for a repo it writes into (spec 4.1 last row, plan B8, O8): save writes into the project repo
// and into the operator repo never in a checkout of a human nor in a topic worktree, but in a clone only the workflow uses
// on this machine. A local lock of the clone puts the writes of the threads of one machine in a row; each write is
// pull -> write -> commit -> push, a refused push pulls again and retries. On a conflict the generated index (INDEX.md)
// is written again; a conflict in another file is never merged by code: it is a question to the operator.
// The brain itself is no such repo: its checkout is the clone of the workflow (O8), brainWrite keeps writing it.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRetry, gitRemote, toPosix } from './util.mjs';
import { WORKTREES_DIR, mainCheckout } from './config.mjs';
import { withLock } from './brain.mjs';

/** Folder of the own clone inside `<parent>/.worktrees/<repo>/` (a hidden entry: no topic worktree, scripts/repo-knowledge.mjs). */
export const CLONE_DIR = '.clone';
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const PUSH_REJECTED = /rejected|fetch first|non-fast-forward|failed to push|stale info/;

/**
 * Where the own clone of a repo lives: `<parent of the repo>/.worktrees/<repo>/.clone`, beside the topic worktrees of a
 * domain repo (the parent of a domain repo is the domain root, scripts/topic.mjs codeCopyPath).
 */
export function ownCloneDir(repoDir) {
  const main = mainCheckout(repoDir);
  return path.join(path.dirname(main), WORKTREES_DIR, path.basename(main), CLONE_DIR);
}

/** origin of a repo as a URL the clone can use: a relative local path resolved against the repo. Null without origin. */
export function originUrl(repoDir) {
  const r = git(['remote', 'get-url', 'origin'], { cwd: repoDir });
  if (!r.ok || !r.stdout) return null;
  const u = r.stdout.trim();
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || (!path.isAbsolute(u) && /^[^/\\]+:/.test(u));
  return remote || path.isAbsolute(u) ? u : path.resolve(mainCheckout(repoDir), u);
}

/** Absolute hooks folder a repo runs: core.hooksPath (a relative one stays relative: the tracked folder), else .git/hooks. */
function repoHooks(repoDir) {
  const set = git(['config', '--get', 'core.hooksPath'], { cwd: repoDir });
  if (set.ok && set.stdout) return set.stdout;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoDir });
  return common.ok ? path.join(common.stdout, 'hooks') : null;
}

/** The clone exists, points at the origin of the repo and runs its hooks and identity (a commit the repo refuses is refused here too). */
function ensureClone(repoDir, dir, name) {
  const url = originUrl(repoDir);
  if (!url) throw new Error(`${name}: no remote origin; save writes into a repo through the own clone of the workflow (pull, write, push; spec 4.1), so the repo needs its remote (git -C ${toPosix(repoDir)} remote add origin <url>); nothing written`);
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (git(['remote', 'get-url', 'origin'], { cwd: dir }).stdout !== url) git(['remote', 'set-url', 'origin', url], { cwd: dir });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    const clone = gitRemote(['clone', '--quiet', '--no-checkout', '--reference-if-able', mainCheckout(repoDir), '--dissociate', url, dir]);
    if (!clone.ok) throw new Error(`${name}: own clone of ${url} failed, nothing written: ${firstLine(clone.stderr)}`);
  }
  for (const key of ['user.name', 'user.email']) {
    const v = git(['config', '--get', key], { cwd: repoDir });
    if (v.ok && v.stdout) git(['config', key, v.stdout], { cwd: dir });
  }
  const hooks = repoHooks(repoDir);
  if (hooks) git(['config', 'core.hooksPath', hooks], { cwd: dir });
}

/**
 * The clone on origin/<branch> (or origin/<from>, the start of a branch not on origin yet) with nothing of its own (an
 * aborted rebase, a commit that was not pushed, stray files).
 */
function resetClone(dir, branch, from = branch) {
  for (const d of ['rebase-merge', 'rebase-apply']) if (fs.existsSync(path.join(dir, '.git', d))) git(['rebase', '--abort'], { cwd: dir });
  const co = git(['checkout', '--quiet', '-f', '-B', branch, `origin/${from}`], { cwd: dir });
  if (!co.ok) return co;
  git(['clean', '-fdq'], { cwd: dir });
  return co;
}

/**
 * Write into a repo through its own clone. ops: [{ path, content } | { path, remove: true }] relative to the repo root, or
 * a function (cloneDir) -> ops called once the clone is on origin's latest commit. index(cloneDir) writes and stages the
 * generated files (returns their paths); indexFiles are the files it generates, the only ones a conflict may settle.
 * base: the branch a `branch` not on origin yet starts from (topic/<topic>--obsah from the protected target branch, spec
 * 4.6); the push creates it. Returns { committed, sha, pushed, branch, clone, notes }. Throws, with nothing written, when origin cannot be read, the
 * commit is refused, the push fails for another reason than a newer commit, or another file conflicts (question to the
 * operator).
 */
export function cloneWrite(repoDir, { branch, base = null, ops, message, env = {}, index = null, indexFiles = [], attempts = 3, name = path.basename(mainCheckout(repoDir)) }) {
  const dir = ownCloneDir(repoDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return withLock(path.join(path.dirname(dir), `${CLONE_DIR}.lock`), () => cloneWriteLocked(repoDir, dir, { branch, base, ops, message, env, index, indexFiles, attempts, name }), `own clone of ${name} is busy`);
}

function cloneWriteLocked(repoDir, dir, { branch, base, ops, message, env, index, indexFiles, attempts, name }) {
  ensureClone(repoDir, dir, name);
  const fetch = () => gitRemote(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir });
  let f = fetch();
  if (!f.ok) throw new Error(`${name}: pull from origin failed, nothing written: ${firstLine(f.stderr)}`);
  const onOrigin = (b) => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { cwd: dir }).ok;
  // The start of the write: the branch on origin, else (a new branch) its base on origin.
  const start = () => (onOrigin(branch) ? branch : base && onOrigin(base) ? base : null);
  if (!start()) throw new Error(`${name}: branch ${base && !onOrigin(branch) ? base : branch} is not on origin, nothing written (push it first: git -C ${toPosix(repoDir)} push origin ${base && !onOrigin(branch) ? base : branch})`);
  const co = resetClone(dir, branch, start());
  if (!co.ok) throw new Error(`${name}: own clone not on origin/${start()}, nothing written: ${firstLine(co.stderr)}`);
  const drop = () => resetClone(dir, branch, start() || branch);
  const list = typeof ops === 'function' ? ops(dir) : ops;
  const rels = [];
  for (const op of list) {
    const rel = toPosix(op.path).replace(/^\.\//, '');
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) { drop(); throw new Error(`${rel}: path must be relative inside ${name}`); }
    const file = path.join(dir, rel);
    if (op.remove) fs.rmSync(file, { recursive: true, force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, op.content); }
    rels.push(rel);
  }
  const result = { committed: false, sha: null, pushed: false, branch, clone: dir, notes: [] };
  const add = gitRetry(['add', '-A', '--', ...rels], { cwd: dir, env });
  if (!add.ok) { drop(); throw new Error(`${name}: git add failed: ${firstLine(add.stderr)}`); }
  try { if (index) index(dir); } catch (err) { drop(); throw err; }
  if (git(['diff', '--cached', '--quiet'], { cwd: dir }).ok) return result;
  const commit = gitRetry(['commit', '--quiet', '-m', message], { cwd: dir, env });
  if (!commit.ok) { drop(); throw new Error(`commit into ${name} (${branch}) failed, nothing written: ${String(commit.stderr || commit.stdout).trim().split('\n').slice(0, 6).join('\n')}`); }
  result.committed = true;
  for (let attempt = 0; ; attempt++) {
    const push = gitRemote(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, env });
    if (push.ok) break;
    if (!PUSH_REJECTED.test(push.stderr) || attempt + 1 >= attempts) {
      drop();
      throw new Error(`${name}: push to origin ${branch} failed${attempt ? ` after ${attempt + 1} attempts` : ''}, nothing written: ${firstLine(push.stderr)}`);
    }
    // A newer commit on origin: pull again (rebase onto it) and try once more.
    f = fetch();
    if (!f.ok) { drop(); throw new Error(`${name}: pull after a refused push failed, nothing written: ${firstLine(f.stderr)}`); }
    const renv = { ...env, GIT_EDITOR: 'true' };
    let rebase = gitRetry(['rebase', '--quiet', `origin/${start()}`], { cwd: dir, env: renv });
    for (let step = 0; !rebase.ok && step < 20; step++) {
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split('\n').filter(Boolean);
      const other = unmerged.filter((u) => !indexFiles.includes(u));
      if (!unmerged.length || other.length) {
        git(['rebase', '--abort'], { cwd: dir });
        drop();
        if (!unmerged.length) throw new Error(`${name}: pull after a refused push failed, nothing written: ${firstLine(rebase.stderr)}`);
        throw new Error(`${name} (${branch}): ${other.join(', ')} changed on origin meanwhile as well; save does not merge another file (spec 4.1): ask the operator which version holds, then save again; nothing written`);
      }
      // The generated index is written again from the merged files, never merged by lines.
      if (index) index(dir);
      result.notes.push(`${unmerged.join(', ')}: conflict with origin, generated again`);
      const empty = git(['diff', '--cached', '--quiet'], { cwd: dir }).ok;
      rebase = gitRetry(['rebase', empty ? '--skip' : '--continue'], { cwd: dir, env: renv });
    }
    if (!rebase.ok) { git(['rebase', '--abort'], { cwd: dir }); drop(); throw new Error(`${name}: rebase onto origin failed, nothing written: ${firstLine(rebase.stderr)}`); }
    // A rebase that merged the index by lines without a conflict: written again from the merged files.
    if (index) {
      index(dir);
      if (!git(['diff', '--cached', '--quiet'], { cwd: dir }).ok) gitRetry(['commit', '--quiet', '--amend', '--no-edit'], { cwd: dir, env });
    }
  }
  result.pushed = true;
  result.sha = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout;
  const ff = fastForwardCheckout(repoDir, branch);
  if (ff) result.notes.push(ff);
  return result;
}

/** Checkout (main or worktree) of the repo that has `branch` checked out, or null. */
function checkoutOf(repoDir, branch) {
  const list = git(['worktree', 'list', '--porcelain'], { cwd: repoDir });
  if (!list.ok) return null;
  let dir = null;
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return null;
}

/**
 * After a push from the clone the checkout of the repo shows the write (find, profile, people read it there): the checkout
 * on that branch is fast-forwarded when it has no change of its own, a local branch without a checkout is moved forward;
 * anything else stays as it is and the note says how to update it. Returns the note, or null when updated.
 */
export function fastForwardCheckout(repoDir, branch) {
  const main = mainCheckout(repoDir);
  const fetch = gitRemote(['fetch', '--quiet', 'origin', branch], { cwd: main });
  if (!fetch.ok) return `checkout ${toPosix(main)} not updated (fetch failed: ${firstLine(fetch.stderr)}); git pull there`;
  const wt = checkoutOf(main, branch);
  if (!wt) {
    if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main }).ok) return null;
    const ff = git(['fetch', '--quiet', '.', `refs/remotes/origin/${branch}:refs/heads/${branch}`], { cwd: main });
    return ff.ok ? null : `local branch ${branch} of ${toPosix(main)} not moved forward (it has commits of its own); merge origin/${branch} there`;
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: wt });
  if (dirty.stdout.trim()) return `checkout ${toPosix(wt)} has uncommitted changes, not updated: git pull there after settling them`;
  const merge = git(['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: wt });
  return merge.ok ? null : `checkout ${toPosix(wt)} not updated (${firstLine(merge.stderr)}); git pull there`;
}

/**
 * Merge `from` (a branch on origin) into `branch` in the own clone of the repo and push it (spec 4.1, plan B12: done
 * merges the topic branch into the target branch of the repo, never in a checkout of a human). A merge that conflicts
 * only in `indexFiles` writes them again (index); another conflict aborts with nothing pushed and throws, naming the
 * files: the topic merges `branch` into its own branch first. A push refused by a newer commit merges again from origin.
 * Returns { merged, already, sha, notes }: already = `from` was in `branch` before.
 */
export function cloneMerge(repoDir, { branch, from, message, env = {}, index = null, indexFiles = [], attempts = 3, name = path.basename(mainCheckout(repoDir)) }) {
  const dir = ownCloneDir(repoDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return withLock(path.join(path.dirname(dir), `${CLONE_DIR}.lock`), () => cloneMergeLocked(repoDir, dir, { branch, from, message, env, index, indexFiles, attempts, name }), `own clone of ${name} is busy`);
}

function cloneMergeLocked(repoDir, dir, { branch, from, message, env, index, indexFiles, attempts, name }) {
  ensureClone(repoDir, dir, name);
  const notes = [];
  for (let attempt = 0; ; attempt++) {
    const f = gitRemote(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir });
    if (!f.ok) throw new Error(`${name}: pull from origin failed, nothing merged: ${firstLine(f.stderr)}`);
    for (const b of [branch, from]) {
      if (!git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { cwd: dir }).ok) throw new Error(`${name}: branch ${b} is not on origin, nothing merged (push it first: git -C ${toPosix(repoDir)} push origin ${b})`);
    }
    const co = resetClone(dir, branch);
    if (!co.ok) throw new Error(`${name}: own clone not on origin/${branch}, nothing merged: ${firstLine(co.stderr)}`);
    if (git(['merge-base', '--is-ancestor', `origin/${from}`, 'HEAD'], { cwd: dir }).ok) return { merged: false, already: true, sha: git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout, notes };
    const merge = gitRetry(['merge', '--no-ff', '--quiet', '-m', message, `origin/${from}`], { cwd: dir, env: { ...env, GIT_EDITOR: 'true' } });
    if (!merge.ok) {
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split('\n').filter(Boolean);
      const other = unmerged.filter((u) => !indexFiles.includes(u));
      if (!unmerged.length || other.length || !index) {
        git(['merge', '--abort'], { cwd: dir });
        resetClone(dir, branch);
        throw new Error(unmerged.length ? `${name}: merge of ${from} into ${branch} conflicts in ${(other.length ? other : unmerged).join(', ')}; nothing merged: merge origin/${branch} into ${from} in the topic worktree, settle the conflict there (a conflict in content, not code, is a question to the operator, spec 4.1), commit, then run done again` : `${name}: merge of ${from} into ${branch} failed, nothing merged: ${firstLine(merge.stderr || merge.stdout)}`);
      }
      index(dir);
      notes.push(`${unmerged.join(', ')}: conflict, generated again`);
      const done = gitRetry(['commit', '--quiet', '--no-edit'], { cwd: dir, env });
      if (!done.ok) { git(['merge', '--abort'], { cwd: dir }); resetClone(dir, branch); throw new Error(`${name}: merge commit refused, nothing merged: ${firstLine(done.stderr || done.stdout)}`); }
    } else if (index) {
      index(dir);
      if (!git(['diff', '--cached', '--quiet'], { cwd: dir }).ok) gitRetry(['commit', '--quiet', '--amend', '--no-edit'], { cwd: dir, env });
    }
    const push = gitRemote(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, env });
    if (push.ok) break;
    if (!PUSH_REJECTED.test(push.stderr) || attempt + 1 >= attempts) {
      resetClone(dir, branch);
      throw new Error(`${name}: push of ${branch} failed${attempt ? ` after ${attempt + 1} attempts` : ''}, nothing merged: ${firstLine(push.stderr)}`);
    }
  }
  const sha = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout;
  const ff = fastForwardCheckout(repoDir, branch);
  if (ff) notes.push(ff);
  return { merged: true, already: false, sha, notes };
}
