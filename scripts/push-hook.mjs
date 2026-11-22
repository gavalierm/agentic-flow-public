// Push of every commit of a topic branch and of a task branch (spec 3.7, plan B13, O16): a git post-commit hook installed
// when the workflow creates the worktree, so it works for a subagent and outside the harness as well. The hook folder is
// set for that worktree only (core.hooksPath in its config.worktree): every other hook of the repo still runs through a
// wrapper, the checkout of the human keeps its hooks as they are. A failed push leaves one line in the worktree's git dir;
// PostToolUse reports it once (pushFailureLines).
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRemote, toPosix } from './util.mjs';

export const HOOKS_DIR = 'workflow-hooks';
export const PUSH_FAILED = 'workflow-push-failed';
// Hooks git runs in a working tree: each one is passed on to the repo's own (a check of the repo must not get lost).
const GIT_HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'pre-auto-gc', 'reference-transaction', 'push-to-checkout', 'post-index-change', 'sendemail-validate'];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Absolute git dir of a worktree, or null. */
export function gitDirOf(dir) {
  const r = git(['rev-parse', '--absolute-git-dir'], { cwd: dir });
  return r.ok ? r.stdout : null;
}

/** Shell lines that find the repo's own hook folder (the one the worktree had before) into $orig. */
function origLines(before) {
  return [
    `orig=${shq(before || '')}`,
    'if [ -z "$orig" ]; then orig="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"; fi',
    'case "$orig" in /*) ;; *) orig="$(git rev-parse --show-toplevel)/$orig" ;; esac',
  ];
}

function wrapper(name, before) {
  return ['#!/bin/sh', `# workflow (plan O16): runs the repo's own ${name} hook; written by the workflow, do not edit`, ...origLines(before), `if [ -x "$orig/${name}" ]; then exec "$orig/${name}" "$@"; fi`, 'exit 0', ''].join('\n');
}

function postCommit(before) {
  return ['#!/bin/sh',
    '# workflow (spec 3.7, plan O16): every commit of a topic or task branch is pushed at once; written by the workflow',
    ...origLines(before),
    'if [ -x "$orig/post-commit" ]; then "$orig/post-commit" "$@"; fi',
    'branch="$(git symbolic-ref --quiet --short HEAD)" || exit 0',
    'case "$branch" in topic/*) ;; *) exit 0 ;; esac',
    'git remote get-url origin >/dev/null 2>&1 || exit 0',
    `marker="$(git rev-parse --absolute-git-dir)/${PUSH_FAILED}"`,
    'if out="$(git push --quiet origin "HEAD:refs/heads/$branch" 2>&1)"; then rm -f "$marker"; else',
    '  line="$(printf \'%s\\n\' "$out" | grep -v \'^ *$\' | head -n 1)"',
    '  printf \'%s\\t%s\\n\' "$branch" "$line" > "$marker"',
    '  echo "workflow: push of $branch failed: $line" >&2',
    'fi',
    'exit 0', ''].join('\n');
}

/**
 * Install the hooks of the worktree `dir` (idempotent): core.hooksPath of this worktree only (extensions.worktreeConfig)
 * points to `<git dir>/workflow-hooks`, which pushes after each commit and passes every hook on to the repo's own folder.
 * Returns { installed, already, error }.
 */
export function installPushHook(dir) {
  const gitDir = gitDirOf(dir);
  if (!gitDir) return { installed: false, error: `${toPosix(dir)} is no git worktree` };
  const hooks = path.join(gitDir, HOOKS_DIR);
  const own = git(['config', '--worktree', '--get', 'core.hooksPath'], { cwd: dir });
  if (own.ok && path.resolve(own.stdout) === path.resolve(hooks) && fs.existsSync(path.join(hooks, 'post-commit'))) return { installed: false, already: true };
  // The hook folder the worktree runs before ours: core.hooksPath of the repo (its shared config, else the global one),
  // else <common dir>/hooks.
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  const shared = [['--file', path.join(common.stdout, 'config')], ['--global']].map((scope) => git(['config', ...scope, '--get', 'core.hooksPath'], { cwd: dir })).find((r) => r.ok && r.stdout);
  const before = shared ? shared.stdout : '';
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of GIT_HOOKS) {
    const file = path.join(hooks, name);
    fs.writeFileSync(file, name === 'post-commit' ? postCommit(before) : wrapper(name, before));
    fs.chmodSync(file, 0o755);
  }
  const ext = git(['config', 'extensions.worktreeConfig', 'true'], { cwd: dir });
  if (!ext.ok) return { installed: false, error: `extensions.worktreeConfig not set: ${ext.stderr.split('\n')[0]}` };
  const set = git(['config', '--worktree', 'core.hooksPath', hooks], { cwd: dir });
  if (!set.ok) return { installed: false, error: `core.hooksPath of the worktree not set: ${set.stderr.split('\n')[0]}` };
  return { installed: true };
}

/** Push `branch` of the worktree to origin now (task-merge: a merge runs no post-commit). Returns null or the failure. */
export function pushBranch(dir, branch) {
  if (!git(['remote', 'get-url', 'origin'], { cwd: dir }).ok) return null;
  const push = gitRemote(['push', '--quiet', 'origin', `${branch}:refs/heads/${branch}`], { cwd: dir });
  return push.ok ? null : `push of ${branch} failed: ${push.stderr.split('\n').find((l) => l.trim()) || 'unknown error'}`;
}

/** The marks `pushFailureLines` gave in `said`, removed once their lines are out. */
export const clearPushFailures = (marks) => { for (const mark of marks) fs.rmSync(mark, { force: true }); };

/**
 * One line per failed push the post-commit hook left in the git dir of the worktrees `dirs` (PostToolUse, plan O16);
 * each is reported once. `said` (an array) gets the marks instead of their removal: the caller removes them after its output
 * is written, so a hook that stops before it says the line again (the line was lost and the commit stayed on one machine
 * without a word, audit 2026-11-22). Without `said` the mark is removed here.
 */
export function pushFailureLines(dirs, said = null) {
  const lines = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const gitDir = gitDirOf(dir);
    const mark = gitDir && path.join(gitDir, PUSH_FAILED);
    if (!mark || !fs.existsSync(mark)) continue;
    const [branch, why] = fs.readFileSync(mark, 'utf8').trim().split('\t');
    if (said) said.push(mark); else fs.rmSync(mark, { force: true });
    lines.push(`push: ${branch} of ${toPosix(dir)} not pushed (${why || 'unknown error'}); the commit is only on this machine: fix the cause and push it (git -C ${toPosix(dir)} push origin ${branch}); a push refused as not fast-forward means another holder pushed after you (spec 4.2.4)`);
  }
  return lines;
}
