// A fork of another developer's public repository (operator 2026-11-19, a shop app): the work goes to the upstream
// by pull requests, so the fork's main stays equal to the upstream's. The workflow files (.workflow.json,
// .claude/settings.json, .brain/, ignore lines) are never committed there: they stay untracked, ignored in
// <git common dir>/info/exclude (shared by every worktree), and a topic worktree gets a copy of them. Line endings are not
// normalized (that rewrites the upstream's files, e.g. a CRLF fixture its tests assert on).
import fs from 'node:fs';
import path from 'node:path';
import { git, readJson, exists } from './util.mjs';
import { WORKFLOW_CONFIG } from './config.mjs';

/** Local files of the workflow in a fork (copied into each topic worktree). */
export const FORK_LOCAL_FILES = [WORKFLOW_CONFIG, '.claude/settings.json', '.brain/policy.json'];

/** The upstream (`owner/repo`) when the repository is a fork, else null. */
export function forkOf(dir) {
  const up = readJson(path.join(dir, WORKFLOW_CONFIG), {})?.fork?.upstream;
  return typeof up === 'string' && up ? up : null;
}

function excludeFile(dir) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }).stdout;
  return common ? path.join(common, 'info', 'exclude') : null;
}

/** Add ignore lines to info/exclude (not .gitignore, a tracked file of the upstream). Returns true when it wrote. */
export function excludeLocal(dir, entries) {
  const file = excludeFile(dir);
  if (!file) return false;
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split('\n').map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e) && !lines.includes(`/${e}`) && !lines.includes(e.replace(/\/$/, '')));
  if (!missing.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${current.replace(/\s*$/, '')}${current.trim() ? '\n' : ''}${missing.join('\n')}\n`);
  return true;
}

/** Mark a clone as a fork: `fork.upstream` in .workflow.json, remote `upstream`, workflow files excluded. */
export function setupFork(dir, { upstream, url }) {
  const cfg = path.join(dir, WORKFLOW_CONFIG);
  fs.writeFileSync(cfg, `${JSON.stringify({ ...(readJson(cfg, {}) || {}), fork: { upstream } }, null, 2)}\n`);
  excludeLocal(dir, ['/' + WORKFLOW_CONFIG, '/.claude/settings.json', '/.brain/']);
  const has = git(['remote', 'get-url', 'upstream'], { cwd: dir }).ok;
  if (!has && url) git(['remote', 'add', 'upstream', url], { cwd: dir });
  if (url) git(['fetch', '--quiet', 'upstream'], { cwd: dir });
  return `fork of ${upstream}: remote upstream${url ? ` ${url}` : ''}; workflow files stay untracked (.git/info/exclude), main follows upstream, changes go to ${upstream} by pull request`;
}

/** Copy the workflow files of a fork from its main checkout into a new worktree (they are untracked there). */
export function seedWorktree(repo, worktree) {
  if (!forkOf(repo)) return [];
  const copied = [];
  for (const rel of FORK_LOCAL_FILES) {
    const src = path.join(repo, ...rel.split('/'));
    const dst = path.join(worktree, ...rel.split('/'));
    if (!exists(src) || exists(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(rel);
  }
  return copied;
}
