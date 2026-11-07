// Project wizard (skill workflow:project): find a project on disk and on GitHub, restore it, connect its
// repositories, adopt an older setup, or create a new one. Repositories live under the operator's account.
// Layout (operator 2026-11-04): ~/agentic/<project>/ holds the code repositories of the project and one shared
// brain ~/agentic/<project>/<project>-brain; each code repository is a T3 project. Older projects sit flat in
// ~/agentic (<name> next to <name>-brain); restore still handles them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, git, gitRemote, exists, readJson, toPosix } from './util.mjs';
import { WORKFLOW_CONFIG, BRAIN_COMMIT_TAG, brainScriptEnv } from './config.mjs';
import { brainInit } from '../bin/brain-init.mjs';
import { gh, ghOwner, ghOwnedRepos, ghRootNames, readToken, sshRemote, DEFAULT_TOKEN_FILE, DEFAULT_API_URL } from './github.mjs';

export const DEFAULT_ROOT = path.join(os.homedir(), 'agentic');
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
// Brain layout of the workflow template (P-024).
const BRAIN_MARKS = ['topics', 'logs', 'exceptions'];
// Files of older agent setups: rules and memory kept outside the workflow brain format.
const LEGACY_MARKS = ['RULES.md', 'CLAUDE.md', 'AGENTS.md', 'errors', 'artifacts', 'agentic-brain'];

export function checkName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`project name must be lowercase letters, digits and dashes (3-50 chars), got "${name}"`);
  return name;
}

/** Kind of a repository from the names in its root: workflow-project, workflow-brain, legacy, code, empty. */
export function classifyNames(names) {
  const set = new Set(names);
  if (!names.length) return 'empty';
  if (set.has(WORKFLOW_CONFIG)) return 'workflow-project';
  if (set.has('.githooks') && BRAIN_MARKS.every((m) => set.has(m))) return 'workflow-brain';
  if (LEGACY_MARKS.some((m) => set.has(m))) return 'legacy';
  return 'code';
}

function localNames(dir) {
  try { return fs.readdirSync(dir).filter((n) => n !== '.git' && n !== 'local'); } catch { return []; }
}

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

/** Name for matching: case, spaces, dashes and underscores ignored ("Home assistant" = "home-assistant"). */
export const matchKey = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Folder holding the projects of the session's machine, from the session project: <root>/<name>/<repo> next to
 * <root>/<name>/<name>-brain, else the older flat <root>/<repo> (operator 2026-11-07: a Windows instance keeps its
 * projects in "D:\Claude projekty", probe looked only in ~/agentic and reported nothing).
 */
export function sessionRoot(projectDir, brainDir) {
  if (!projectDir) return null;
  const proj = path.resolve(projectDir);
  const parent = path.dirname(proj);
  const brain = brainDir ? path.resolve(brainDir) : null;
  const nested = brain && brain !== proj && path.dirname(brain) === parent && path.basename(brain).startsWith(`${path.basename(parent)}-`);
  return nested ? path.dirname(parent) : parent;
}

/** Roots to search, the first is where new projects go: --root, WORKFLOW_PROJECTS_ROOT, ~/agentic when it exists, the session's root. */
export function projectRoots({ explicit = [], env = process.env, projectDir = null, brainDir = null, home = DEFAULT_ROOT } = {}) {
  const list = [...explicit, env.WORKFLOW_PROJECTS_ROOT, exists(home) ? home : null, sessionRoot(projectDir, brainDir)].filter(Boolean).map((d) => path.resolve(d));
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [home];
}

/** Repositories on disk whose directory name contains the stem; a project folder lists its repositories. */
export function probeLocal(root, stem) {
  const names = [];
  for (const name of subdirs(root).filter((n) => matchKey(n).includes(matchKey(stem)))) {
    const dir = path.join(root, name);
    if (!exists(path.join(dir, '.git')) && subdirs(dir).some((c) => exists(path.join(dir, c, '.git')))) {
      names.push(...subdirs(dir).map((c) => `${name}/${c}`));
    } else names.push(name);
  }
  return names.map((name) => {
    const dir = path.join(root, name);
    const repo = exists(path.join(dir, '.git'));
    const remote = repo ? git(['remote', 'get-url', 'origin'], { cwd: dir }).stdout || null : null;
    const kind = classifyNames(localNames(dir));
    const brain = kind === 'workflow-project' ? readJson(path.join(dir, WORKFLOW_CONFIG), {})?.brain ?? null : null;
    return { name, dir, root, repo, remote, kind, brain };
  });
}

/** Repositories of the operator's GitHub account whose name contains the stem. */
export async function probeGithub(stem, { apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE } = {}) {
  const token = readToken(tokenFile);
  const owner = await ghOwner(apiUrl, token);
  const repos = (await ghOwnedRepos(apiUrl, token)).filter((r) => matchKey(r.name).includes(matchKey(stem)));
  const out = [];
  for (const r of repos) {
    const names = await ghRootNames(apiUrl, token, owner, r.name);
    out.push({ full: `${owner}/${r.name}`, name: r.name, private: !!r.private, archived: !!r.archived, pushed: r.pushed_at || null, description: r.description || '', branch: r.default_branch || 'main', kind: classifyNames(names) });
  }
  return { owner, repos: out };
}

/**
 * Branch of the wizard: restore (a workflow project on disk), adopt (an older setup found), connect
 * (repositories exist in the workflow format or plain code), create (nothing found).
 */
export function decide(local, remote) {
  const all = [...local, ...remote];
  if (local.some((l) => l.kind === 'workflow-project')) return 'restore';
  if (all.some((r) => r.kind === 'legacy')) return 'adopt';
  if (all.length) return 'connect';
  return 'create';
}

export async function probe(stem, { root = DEFAULT_ROOT, roots = null, apiUrl, tokenFile, github = true } = {}) {
  checkName(stem);
  const dirs = roots && roots.length ? roots : [root];
  const local = dirs.flatMap((r) => probeLocal(r, stem));
  let remote = { owner: null, repos: [] };
  let githubError = null;
  if (github) {
    try { remote = await probeGithub(stem, { apiUrl, tokenFile }); } catch (err) { githubError = err.message; }
  }
  // Without GitHub the disk still decides when it found something; GitHub is needed only to connect or create.
  const branch = githubError && !local.length ? null : decide(local, remote.repos);
  return { stem, root: dirs[0], roots: dirs, branch, local, owner: remote.owner, github: remote.repos, githubError };
}

function adapter(projectDir, brainRel) {
  const args = [path.join(PLUGIN_ROOT, 'bin', 'adapter.mjs'), 'claude-code', '--project', projectDir];
  if (brainRel) args.push('--brain', brainRel);
  const r = spawnSync(process.execPath, args, { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`adapter failed: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout || '').trim();
}

function pullIfClean(dir, label) {
  if (!exists(path.join(dir, '.git'))) return `${label}: not a git repository`;
  const dirty = git(['status', '--porcelain'], { cwd: dir }).stdout;
  if (dirty) return `${label}: uncommitted changes, not pulled (${dirty.split('\n').length} files)`;
  if (!git(['remote', 'get-url', 'origin'], { cwd: dir }).ok) return `${label}: no remote origin`;
  const before = git(['rev-parse', 'HEAD'], { cwd: dir }).stdout;
  const r = gitRemote(['pull', '--ff-only', '--quiet'], { cwd: dir });
  if (!r.ok) return `${label}: pull failed: ${r.stderr.split('\n')[0]}`;
  return before === git(['rev-parse', 'HEAD'], { cwd: dir }).stdout ? `${label}: up to date` : `${label}: updated`;
}

/**
 * Restore a project on disk: pull its repositories and brain when clean, regenerate the settings. The name is a
 * project folder (all its workflow repositories) or an older flat workflow project.
 */
export function restore(name, { root = DEFAULT_ROOT } = {}) {
  checkName(name);
  const base = path.join(root, name);
  const repos = exists(path.join(base, WORKFLOW_CONFIG)) ? [base] : subdirs(base).map((c) => path.join(base, c)).filter((d) => exists(path.join(d, WORKFLOW_CONFIG)));
  if (!repos.length) throw new Error(`${base} holds no workflow project (no ${WORKFLOW_CONFIG}); use connect or adopt`);
  const lines = [];
  const brains = new Set();
  for (const projectDir of repos) {
    const label = path.basename(projectDir);
    lines.push(pullIfClean(projectDir, label));
    const brainRel = readJson(path.join(projectDir, WORKFLOW_CONFIG), {})?.brain ?? null;
    const brainDir = brainRel && brainRel !== '.' ? path.resolve(projectDir, brainRel) : null;
    if (brainDir && !brains.has(brainDir)) { brains.add(brainDir); lines.push(pullIfClean(brainDir, path.basename(brainDir))); }
    adapter(projectDir, brainRel);
    lines.push(`${label}: settings regenerated`);
  }
  return { projectDir: repos[0], projectDirs: repos, lines };
}

function cloneInto(remote, dir, label) {
  if (exists(dir)) {
    const url = git(['remote', 'get-url', 'origin'], { cwd: dir }).stdout;
    if (url !== remote) throw new Error(`${dir} exists and is not a clone of ${remote}; nothing is overwritten (P-018)`);
    return `${label}: already cloned`;
  }
  const r = gitRemote(['clone', '--quiet', remote, dir], { cwd: path.dirname(dir) });
  if (!r.ok) throw new Error(`clone of ${remote} failed: ${r.stderr.split('\n')[0]}`);
  return `${label}: cloned`;
}

/**
 * Connect existing repositories into the project folder: clone the code repository, use the project brain
 * <project>-brain (rename an older brain repository to it with renameBrain, or create it), adopt an older brain,
 * generate the settings. brainBranch: the older brain keeps its current content on another branch.
 */
export async function connect({ project, repo = null, brain = null, renameBrain = false, adopt = false, brainBranch = null, root = DEFAULT_ROOT, apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE, remoteFor = sshRemote }) {
  const token = readToken(tokenFile);
  const owner = await ghOwner(apiUrl, token);
  const name = checkName(project);
  const repoName = checkName(repo || name);
  const brainName = `${name}-brain`;
  const base = path.join(root, name);
  if (exists(base) && exists(path.join(base, '.git'))) throw new Error(`${base} is a repository, not a project folder; nothing is overwritten (P-018)`);
  fs.mkdirSync(base, { recursive: true });
  const projectDir = path.join(base, repoName);
  const brainDir = path.join(base, brainName);
  const lines = [cloneInto(remoteFor(owner, repoName), projectDir, repoName)];

  if (brain && brain !== brainName) {
    if (!renameBrain) throw new Error(`brain repository ${owner}/${brain} must be named ${brainName}; run again with --rename-brain (renames it on GitHub, the old name redirects)`);
    const taken = await gh(apiUrl, token, 'GET', `/repos/${owner}/${brainName}`);
    if (taken.status === 200) throw new Error(`${owner}/${brainName} already exists; resolve it first`);
    const r = await gh(apiUrl, token, 'PATCH', `/repos/${owner}/${brain}`, { name: brainName });
    if (r.status !== 200 || r.json.name !== brainName) throw new Error(`renaming ${owner}/${brain} failed (HTTP ${r.status}): ${r.json.message || ''}`);
    lines.push(`brain repository renamed: ${brain} -> ${brainName}`);
  }
  const brainExists = brain || exists(brainDir) || (await gh(apiUrl, token, 'GET', `/repos/${owner}/${brainName}`)).status === 200;
  if (brainExists) {
    lines.push(cloneInto(remoteFor(owner, brainName), brainDir, 'brain'));
    if (brainBranch && brainBranch !== 'main') {
      gitRemote(['fetch', '--quiet', 'origin'], { cwd: brainDir });
      const target = `origin/${brainBranch}`;
      if (!git(['rev-parse', '--verify', '--quiet', target], { cwd: brainDir }).ok) throw new Error(`brain branch ${brainBranch} not found`);
      const hasMain = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: brainDir }).ok;
      if (!hasMain || git(['merge-base', '--is-ancestor', 'origin/main', target], { cwd: brainDir }).ok) {
        git(['checkout', '--quiet', '-B', 'main', target], { cwd: brainDir });
        lines.push(`brain main fast-forwarded to ${brainBranch}`);
      } else {
        // main has only merge commits of the branch (the older "merge dev" habit): merging adds no content of main.
        git(['checkout', '--quiet', '-B', 'main', 'origin/main'], { cwd: brainDir });
        const merge = git(['merge', '--no-ff', '--quiet', '-m', `${BRAIN_COMMIT_TAG} adopt brain into the workflow: merge ${brainBranch}`, target], { cwd: brainDir, env: brainScriptEnv() });
        if (!merge.ok || !git(['diff', '--quiet', 'HEAD', target], { cwd: brainDir }).ok) {
          git(['merge', '--abort'], { cwd: brainDir });
          git(['reset', '--quiet', '--hard', 'origin/main'], { cwd: brainDir });
          throw new Error(`brain main has content that ${brainBranch} lacks: decide with the operator which content is current`);
        }
        lines.push(`brain main merged with ${brainBranch} (main had only merge commits)`);
      }
    }
    const res = brainInit(brainDir, { attach: true, adopt });
    lines.push(...res.created.map((c) => `brain: ${c}`));
    const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { cwd: brainDir });
    if (!ahead.ok || ahead.stdout !== '0') {
      const push = gitRemote(['push', '--quiet', '-u', 'origin', 'main'], { cwd: brainDir });
      lines.push(push.ok ? 'brain: pushed' : `brain: push failed: ${push.stderr.split('\n')[0]}`);
    } else git(['branch', '--quiet', '--set-upstream-to', 'origin/main'], { cwd: brainDir });
  } else {
    lines.push(...(await createRepo(apiUrl, token, owner, brainName)));
    const res = brainInit(brainDir, { remote: remoteFor(owner, brainName) });
    lines.push(...res.created.map((c) => `brain: ${c}`));
  }
  adapter(projectDir, `../${brainName}`);
  lines.push('settings generated');
  return { owner, projectDir, brainDir, lines };
}

async function createRepo(apiUrl, token, owner, repo) {
  const probeRes = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repo}`);
  if (probeRes.status === 200) throw new Error(`repository ${owner}/${repo} already exists; connect it instead`);
  if (probeRes.status !== 404) throw new Error(`cannot verify that ${owner}/${repo} is free (HTTP ${probeRes.status})`);
  const made = await gh(apiUrl, token, 'POST', '/user/repos', { name: repo, private: true });
  if (made.status !== 201 || made.json.name !== repo) throw new Error(`creating ${owner}/${repo} failed (HTTP ${made.status}): ${made.json.message || made.json.name || ''}`);
  return [`repository created: ${owner}/${repo} (private)`];
}

/** New project: folder, private code and brain repositories, a first commit with the purpose, settings. */
export async function create({ name, repo = null, purpose, root = DEFAULT_ROOT, apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE, remoteFor = sshRemote }) {
  checkName(name);
  const repoName = checkName(repo || name);
  if (!String(purpose || '').trim()) throw new Error('create needs --purpose "<one sentence>"');
  const base = path.join(root, name);
  if (exists(base)) throw new Error(`${base} already exists; nothing is overwritten (P-018)`);
  const projectDir = path.join(base, repoName);
  const brainDir = path.join(base, `${name}-brain`);
  const token = readToken(tokenFile);
  const owner = await ghOwner(apiUrl, token);
  const lines = [...(await createRepo(apiUrl, token, owner, repoName)), ...(await createRepo(apiUrl, token, owner, `${name}-brain`))];
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${repoName}\n\n${String(purpose).trim()}\n`);
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', 'README.md'], ['commit', '--quiet', '-m', `Start ${repoName}`], ['remote', 'add', 'origin', remoteFor(owner, repoName)]]) {
    const r = git(args, { cwd: projectDir });
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  const push = gitRemote(['push', '--quiet', '-u', 'origin', 'main'], { cwd: projectDir });
  lines.push(push.ok ? 'project: pushed' : `project: push failed: ${push.stderr.split('\n')[0]}`);
  const res = brainInit(brainDir, { remote: remoteFor(owner, `${name}-brain`) });
  lines.push(...res.created.map((c) => `brain: ${c}`));
  adapter(projectDir, `../${name}-brain`);
  lines.push('settings generated');
  return { owner, projectDir, brainDir, lines };
}

// Absolute paths in text (older setups pointed at /opt, /root or other homes).
const ABS_PATH = /(?<![\w.:/-])(\/(?:opt|root|home|srv|var|etc|usr)\/[\w.@-]+(?:\/[\w.@-]+)*)/g;

/** Group of a file for the adoption brainstorm. */
export function inventoryGroup(rel) {
  const base = path.posix.basename(rel);
  if (/^(\.githooks|\.git|\.claude)\//.test(rel) || ['.gitignore', '.gitattributes', '.gitkeep', '.assetsignore'].includes(base)) return 'infra';
  if (/^(RULES|CLAUDE|AGENTS)\.md$/i.test(base) || /^rules\//.test(rel)) return 'rules';
  if (/^decisions\//.test(rel)) return 'decisions';
  if (/^skills\//.test(rel)) return 'skills';
  if (/^errors\//.test(rel)) return 'errors';
  if (/^memory\//.test(rel) && /\.(md|txt)$/.test(base)) return 'memory';
  if (/^scratch\//.test(rel)) return 'scratch';
  return 'data';
}

/** Mechanical inventory of a repository: file, group, size, last change, dead absolute paths. */
export function inventory(dir) {
  if (!exists(path.join(dir, '.git'))) throw new Error(`${dir} is not a git repository`);
  const files = git(['ls-files'], { cwd: dir }).stdout.split('\n').filter(Boolean);
  const items = files.map((rel) => {
    const full = path.join(dir, rel);
    const bytes = fs.statSync(full).size;
    const changed = git(['log', '-1', '--format=%cs', '--', rel], { cwd: dir }).stdout || null;
    let dead = [];
    if (bytes < 512 * 1024 && /\.(md|txt|json|jsonc|js|mjs|sh|ya?ml|toml)$|^[^.]+$/.test(path.posix.basename(rel))) {
      const text = fs.readFileSync(full, 'utf8');
      dead = [...new Set([...text.matchAll(ABS_PATH)].map((m) => m[1]))].filter((p) => !exists(p));
    }
    return { path: toPosix(rel), group: inventoryGroup(toPosix(rel)), bytes, changed, dead };
  });
  const branches = git(['branch', '-a', '--format=%(refname:short)'], { cwd: dir }).stdout.split('\n').filter((b) => b && b !== 'origin' && !b.endsWith('/HEAD'));
  const commits = Number(git(['rev-list', '--count', '--all'], { cwd: dir }).stdout || 0);
  return { dir, kind: classifyNames(localNames(dir)), branches, commits, items };
}

export function formatInventory(inv) {
  const groups = {};
  for (const it of inv.items) (groups[it.group] ||= []).push(it);
  const out = [`${inv.dir} (${inv.kind}; ${inv.commits} commits; branches: ${inv.branches.join(', ')})`];
  for (const [g, items] of Object.entries(groups)) {
    out.push(`## ${g} (${items.length})`);
    for (const it of items) out.push(`- ${it.path} ${it.bytes} B ${it.changed || '-'}${it.dead.length ? ` dead: ${it.dead.join(', ')}` : ''}`);
  }
  return out.join('\n');
}
