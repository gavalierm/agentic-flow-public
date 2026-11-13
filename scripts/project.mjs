// Project wizard (skill workflow:project): find a project on disk and on GitHub, restore it, connect its
// repositories, adopt an older setup, or create a new one. Repositories live under the operator's account; probe and
// connect with `owner` find and clone those of another account or organization where the operator is a collaborator.
// Layout (operator 2026-11-04): ~/agentic/<Project>/ (upper case first letter, domainDirName, operator 2026-11-07)
// holds the code repositories of the project and one shared brain ~/agentic/<Project>/<project>-brain; each code repository is a T3 project. Older projects sit flat in
// ~/agentic (<name> next to <name>-brain); restore still handles them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, git, gitRemote, exists, readJson, toPosix } from './util.mjs';
import { WORKFLOW_CONFIG, BRAIN_COMMIT_TAG, brainScriptEnv, domainDir, domainDirName, checkDomainName, DOMAIN_MARKER, machineRoot } from './config.mjs';
// The projects root saved for this machine lives in config.mjs: the write hook reads it without this module's GitHub code.
export { ROOT_FILE, rootFile, machineRoot, setMachineRoot } from './config.mjs';
import { brainInit } from '../bin/brain-init.mjs';
import { brainSync } from './brain.mjs';
import { ensureLineEndings, EOL_RULE } from './eol.mjs';
import { servicesClient } from './comms.mjs';
import { gh, ghOwner, ghOwnedRepos, ghOwnerRepos, ghRootNames, grantAgentAccess, checkOwner, readToken, sshRemote, DEFAULT_TOKEN_FILE, DEFAULT_AGENT_TOKEN_FILE, DEFAULT_API_URL } from './github.mjs';

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
  // The domain may be a chosen folder name with spaces (`Home assistant` holding home-assistant-brain).
  const nested = brain && brain !== proj && path.dirname(brain) === parent && (path.basename(brain).toLowerCase().startsWith(`${path.basename(parent).toLowerCase()}-`)
    || matchKey(path.basename(brain).replace(/-brain$/i, '')) === matchKey(path.basename(parent)));
  return nested ? path.dirname(parent) : parent;
}

/**
 * Roots to search, the first is where new projects and personas go: --root, WORKFLOW_PROJECTS_ROOT, the root saved for this
 * machine (machineRoot), ~/agentic when it exists, the session's root.
 */
export function projectRoots({ explicit = [], env = process.env, projectDir = null, brainDir = null, home = DEFAULT_ROOT } = {}) {
  const list = [...explicit, env.WORKFLOW_PROJECTS_ROOT, machineRoot(env), exists(home) ? home : null, sessionRoot(projectDir, brainDir)].filter(Boolean).map((d) => path.resolve(d));
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

/** Access of the token to a repository of another owner, from the listing's permissions: admin, push or read. */
const accessOf = (r) => (r.permissions?.admin ? 'admin' : r.permissions?.push ? 'push' : 'read');

/**
 * Repositories whose name contains the stem: of the operator's GitHub account, or with `owner` of that account or
 * organization where the operator is a collaborator or member (each with the operator's access).
 */
export async function probeGithub(stem, { apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE, owner: ownerOpt = null } = {}) {
  const token = readToken(tokenFile);
  const me = await ghOwner(apiUrl, token);
  const foreign = !!ownerOpt && String(ownerOpt).toLowerCase() !== me.toLowerCase();
  const listed = foreign ? await ghOwnerRepos(apiUrl, token, checkOwner(ownerOpt)) : await ghOwnedRepos(apiUrl, token);
  const owner = foreign ? listed[0]?.owner?.login || ownerOpt : me;
  const repos = listed.filter((r) => matchKey(r.name).includes(matchKey(stem)));
  const out = [];
  for (const r of repos) {
    const names = await ghRootNames(apiUrl, token, owner, r.name);
    out.push({ full: `${owner}/${r.name}`, name: r.name, private: !!r.private, archived: !!r.archived, pushed: r.pushed_at || null, description: r.description || '', branch: r.default_branch || 'main', kind: classifyNames(names), ...(foreign ? { access: accessOf(r) } : {}) });
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

export async function probe(stem, { root = DEFAULT_ROOT, roots = null, apiUrl, tokenFile, github = true, owner = null } = {}) {
  checkName(stem);
  if (owner) checkOwner(owner);
  const dirs = roots && roots.length ? roots : [root];
  const local = dirs.flatMap((r) => probeLocal(r, stem));
  let remote = { owner: null, repos: [] };
  let githubError = null;
  if (github) {
    try { remote = await probeGithub(stem, { apiUrl, tokenFile, owner }); } catch (err) { githubError = err.message; }
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

/**
 * The domain marker (D-0002, P-052): the project folder holding the code repositories and the brain is the domain.
 * Without it resolveDomain returns null and a code topic falls back to the legacy clone ../<repo>-topics/ next to the
 * project instead of a worktree in <domain>/.worktrees/ (home-assistant adopted on Windows, 2026-11-07). Written when
 * missing; a marker naming another brain is refused (a domain has one brain).
 */
export function ensureDomainMarker(base, brainName) {
  const marker = path.join(base, DOMAIN_MARKER);
  if (exists(marker)) {
    const named = readJson(marker, {})?.brain;
    if (named && named !== brainName) throw new Error(`${marker} names brain ${named}, not ${brainName}; a domain has one brain`);
    return null;
  }
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ brain: brainName }, null, 2) + '\n');
  return `domain marker written: ${path.basename(base)}/${DOMAIN_MARKER} (brain ${brainName})`;
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
 * Activation of a brain clone on restore, the same as `brain-init.mjs --attach` (P-024): core.hooksPath, executable
 * hooks (a 100644 hook gets 100755 in a brain script commit), local/. What the attach committed goes to origin with brainSync. A brain that
 * cannot be attached is a NOT line with the command, restore goes on.
 */
function attachBrain(brainDir, label) {
  let res;
  try { res = brainInit(brainDir, { attach: true }); } catch (err) {
    return [`${label}: brain NOT attached (${err.message.split('\n')[0]}): node ${toPosix(path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'))} ${toPosix(brainDir)} --attach`];
  }
  const lines = [`${label}: brain attached (core.hooksPath .githooks; ${res.created.join('; ')})`];
  // brainSync, not a bare push: a brain left unpulled above (only the hook modes made it dirty) is behind origin.
  if (res.created.some((c) => c.startsWith('committed')) && git(['remote', 'get-url', 'origin'], { cwd: brainDir }).ok) {
    const sync = brainSync(brainDir);
    lines.push(sync.pushed ? `${label}: attach commit pushed (brain synced with origin)`
      : `${label}: attach commit NOT pushed (${sync.error || `disagreement with origin: ${(sync.conflict || []).join(', ')}`}); the next brain write pushes it`);
  }
  return lines;
}

/**
 * Restore a project on disk: pull its repositories and brain when clean, attach the brain (attachBrain), regenerate the
 * settings. The name is a project folder (all its workflow repositories) or an older flat workflow project. brains: each
 * separate brain with its first repository, for the mail key (bin/project.mjs restore, as `project.mjs mail`).
 */
export function restore(name, { root = DEFAULT_ROOT, domain = null } = {}) {
  checkName(name);
  const base = domainDir(root, name, domain);
  const repos = exists(path.join(base, WORKFLOW_CONFIG)) ? [base] : subdirs(base).map((c) => path.join(base, c)).filter((d) => exists(path.join(d, WORKFLOW_CONFIG)));
  if (!repos.length) throw new Error(`${base} holds no workflow project (no ${WORKFLOW_CONFIG}); use connect or adopt`);
  const lines = [];
  const brains = new Map();
  for (const projectDir of repos) {
    const label = path.basename(projectDir);
    lines.push(pullIfClean(projectDir, label));
    const eol = ensureLineEndings(projectDir, { label });
    if (eol) lines.push(eol);
    const brainRel = readJson(path.join(projectDir, WORKFLOW_CONFIG), {})?.brain ?? null;
    const brainDir = brainRel && brainRel !== '.' ? path.resolve(projectDir, brainRel) : null;
    // A persona repository is its own brain ("brain": "."): pulled above, attached here.
    if (brainRel === '.') lines.push(...attachBrain(projectDir, label));
    if (brainDir && !brains.has(brainDir)) {
      brains.set(brainDir, projectDir);
      lines.push(pullIfClean(brainDir, path.basename(brainDir)));
      if (exists(path.join(brainDir, '.git'))) lines.push(...attachBrain(brainDir, path.basename(brainDir)));
      // A project folder adopted before the marker existed becomes a domain on restore (D-0002).
      if (base !== projectDir && path.dirname(brainDir) === base) { const m = ensureDomainMarker(base, path.basename(brainDir)); if (m) lines.push(m); }
    }
    adapter(projectDir, brainRel);
    lines.push(`${label}: settings regenerated`);
  }
  return { projectDir: repos[0], projectDirs: repos, brains: [...brains].map(([brainDir, projectDir]) => ({ brainDir, projectDir })), lines };
}

/**
 * One repository in any spelling: git@host:o/r.git, ssh://git@host/o/r, https://host/o/r -> host/o/r. `git remote get-url`
 * returns the address after url.<base>.insteadOf (ssh rewritten to https), so an exact match refused an existing clone
 * of the same repository (flow-public#13).
 */
export function remoteKey(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(u);
  return m ? `${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '').toLowerCase()}` : u.toLowerCase();
}

function cloneInto(remote, dir, label) {
  if (exists(dir)) {
    // The configured address and the rewritten one: either names the repository.
    const urls = [git(['config', '--get', 'remote.origin.url'], { cwd: dir }).stdout, git(['remote', 'get-url', 'origin'], { cwd: dir }).stdout];
    if (!urls.some((u) => u && remoteKey(u) === remoteKey(remote))) throw new Error(`${dir} exists and is not a clone of ${remote} (origin ${urls[1] || urls[0] || 'none'}); nothing is overwritten (P-018)`);
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
/**
 * --set-aside <a,b>: older folders of the setup being adopted (e.g. "Home assistant") renamed to <x>.pre-adopt in
 * the projects root. The project skill does this, not the agent: the folders are outside its domain (P-052, issue #8).
 * All names are checked before anything is renamed; a workflow domain is never set aside.
 */
function isWorkflowDomain(dir) {
  if (exists(path.join(dir, DOMAIN_MARKER)) || exists(path.join(dir, WORKFLOW_CONFIG))) return true;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return entries.some((e) => e.isDirectory() && exists(path.join(dir, e.name, WORKFLOW_CONFIG)));
}

function setAsideNamed(root, setAside) {
  if (typeof setAside !== 'string') return [];
  const names = setAside.split(',').map((s) => s.trim()).filter(Boolean);
  const plan = names.map((n) => {
    if (n !== path.basename(n) || n === '.' || n === '..') throw new Error(`--set-aside takes folder names in ${root}, got "${n}"`);
    const from = path.join(root, n);
    const to = `${from}.pre-adopt`;
    if (!exists(from)) throw new Error(`${from} does not exist`);
    if (isWorkflowDomain(from)) throw new Error(`${from} is a workflow domain; it is not set aside`);
    if (exists(to)) throw new Error(`${to} already exists; resolve it first`);
    return { n, from, to };
  });
  return plan.map(({ n, from, to }) => { fs.renameSync(from, to); return `set aside: ${n} -> ${path.basename(to)}`; });
}

// owner: the account or organization of the code repository when it is not the operator's (the operator is a
// collaborator there). Its brain is cloned from that owner when it has one, else it is the operator's (found or created
// there: a new repository can be created only in the token's own account). The agent account gets push access where the
// operator's token can give it; where it cannot (not owner or admin), a NOT line says the step, connect goes on.
export async function connect({ project, repo = null, brain = null, renameBrain = false, adopt = false, brainBranch = null, setAside = false, domain = null, owner: ownerOpt = null, root = DEFAULT_ROOT, apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE, agentTokenFile = DEFAULT_AGENT_TOKEN_FILE, remoteFor = sshRemote }) {
  const token = readToken(tokenFile);
  const me = await ghOwner(apiUrl, token);
  if (ownerOpt) checkOwner(ownerOpt);
  const foreign = !!ownerOpt && ownerOpt.toLowerCase() !== me.toLowerCase();
  const owner = foreign ? ownerOpt : me;
  const name = checkName(project);
  const repoName = checkName(repo || name);
  const brainName = `${name}-brain`;
  if (domain) checkDomainName(domain);
  if (foreign && (await gh(apiUrl, token, 'GET', `/repos/${owner}/${repoName}`)).status !== 200) throw new Error(`${owner}/${repoName} not found with the operator's token (is the operator a collaborator there?); probe --owner ${owner} lists what it can reach`);
  const brainOwner = foreign && (await gh(apiUrl, token, 'GET', `/repos/${owner}/${brain || brainName}`)).status !== 200 ? me : owner;
  const setAsideLines = setAsideNamed(root, setAside);
  let base = domainDir(root, name, domain);
  // A chosen domain name may be the old setup's own folder (`Home assistant`): it is not taken over as the domain.
  if (domain && exists(base) && !exists(path.join(base, '.git')) && !isWorkflowDomain(base) && subdirs(base).length) {
    throw new Error(`${base} exists and is not a workflow domain; nothing is overwritten (P-018). Set it aside first (--set-aside "${path.basename(base)}", renamed to ${path.basename(base)}.pre-adopt, nothing is deleted)`);
  }
  // An older flat clone at <root>/<name> takes the domain's name (on Windows and macOS also <Name>: case-insensitive).
  // The agent may not rename it (outside its domain, P-052, public issue #8), so connect does it on --set-aside,
  // which the operator approves in the adoption summary. Nothing is deleted.
  if (exists(base) && exists(path.join(base, '.git'))) {
    const aside = `${base}.pre-adopt`;
    if (!setAside) throw new Error(`${base} is a repository, not a project folder; nothing is overwritten (P-018). Run again with --set-aside to rename it to ${path.basename(aside)} (nothing is deleted)`);
    if (exists(aside)) throw new Error(`${aside} already exists; resolve it first`);
    fs.renameSync(base, aside);
    setAsideLines.push(`set aside: ${path.basename(base)} -> ${path.basename(aside)}`);
    base = path.join(root, domain || domainDirName(name));
  }
  fs.mkdirSync(base, { recursive: true });
  const projectDir = path.join(base, repoName);
  const brainDir = path.join(base, brainName);
  const lines = [...setAsideLines];
  // Another owner's repository: the machine's SSH key (the agent account) needs access before the clone.
  const access = foreign ? await grantAgentAccess(apiUrl, token, owner, repoName, agentTokenFile, { foreign: true }) : null;
  if (access) lines.push(access);
  try { lines.push(cloneInto(remoteFor(owner, repoName), projectDir, repoName)); } catch (err) { throw new Error(access && / NOT /.test(access) ? `${err.message}; ${access}` : err.message); }
  const eol = ensureLineEndings(projectDir, { label: repoName });
  if (eol) lines.push(eol);

  if (brain && brain !== brainName) {
    if (!renameBrain) throw new Error(`brain repository ${brainOwner}/${brain} must be named ${brainName}; run again with --rename-brain (renames it on GitHub, the old name redirects)`);
    const taken = await gh(apiUrl, token, 'GET', `/repos/${brainOwner}/${brainName}`);
    if (taken.status === 200) throw new Error(`${brainOwner}/${brainName} already exists; resolve it first`);
    const r = await gh(apiUrl, token, 'PATCH', `/repos/${brainOwner}/${brain}`, { name: brainName });
    if (r.status !== 200 || r.json.name !== brainName) throw new Error(`renaming ${brainOwner}/${brain} failed (HTTP ${r.status}): ${r.json.message || ''}`);
    lines.push(`brain repository renamed: ${brain} -> ${brainName}`);
  }
  if (foreign) lines.push(brainOwner === owner ? `brain: from ${owner}/${brainName}` : `brain: in the operator's account, ${me}/${brainName} (${owner} has no ${brain || brainName})`);
  const brainExists = brain || exists(brainDir) || (await gh(apiUrl, token, 'GET', `/repos/${brainOwner}/${brainName}`)).status === 200;
  if (brainExists) {
    const brainAccess = foreign && brainOwner === owner ? await grantAgentAccess(apiUrl, token, owner, brainName, agentTokenFile, { foreign: true }) : null;
    if (brainAccess) lines.push(brainAccess);
    lines.push(cloneInto(remoteFor(brainOwner, brainName), brainDir, 'brain'));
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
    lines.push(...(await createRepo(apiUrl, token, brainOwner, brainName, agentTokenFile)));
    const res = brainInit(brainDir, { remote: remoteFor(brainOwner, brainName) });
    lines.push(...res.created.map((c) => `brain: ${c}`));
  }
  const marker = ensureDomainMarker(base, brainName);
  if (marker) lines.push(marker);
  adapter(projectDir, `../${brainName}`);
  lines.push('settings generated');
  // A public code repo keeps no workflow knowledge (repoPublic): records, decisions and runbooks would be pushed publicly
  // (alice 2026-11-11, an adopted static web).
  const info = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repoName}`);
  if (info.status === 200 && info.json?.private === false) {
    const cfgFile = path.join(projectDir, WORKFLOW_CONFIG);
    fs.writeFileSync(cfgFile, `${JSON.stringify({ ...(readJson(cfgFile, {}) || {}), visibility: 'public' }, null, 2)}\n`);
    lines.push(`visibility: ${owner}/${repoName} is PUBLIC: its knowledge stays in brain (save --repo refuses it), secrets in local/; check its history for secrets and that its deploy leaves out the workflow files (skill project, public repo)`);
  }
  return { owner, projectDir, brainDir, lines };
}

// The machine's agent account gets push access before the first push (Repository not found otherwise, Alice 2026-11-09).
async function createRepo(apiUrl, token, owner, repo, agentTokenFile = DEFAULT_AGENT_TOKEN_FILE) {
  const probeRes = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repo}`);
  if (probeRes.status === 200) throw new Error(`repository ${owner}/${repo} already exists; connect it instead`);
  if (probeRes.status !== 404) throw new Error(`cannot verify that ${owner}/${repo} is free (HTTP ${probeRes.status})`);
  const made = await gh(apiUrl, token, 'POST', '/user/repos', { name: repo, private: true });
  if (made.status !== 201 || made.json.name !== repo) throw new Error(`creating ${owner}/${repo} failed (HTTP ${made.status}): ${made.json.message || made.json.name || ''}`);
  const access = await grantAgentAccess(apiUrl, token, owner, repo, agentTokenFile);
  return [`repository created: ${owner}/${repo} (private)`, ...(access ? [access] : [])];
}

/** New project: folder, private code and brain repositories, a first commit with the purpose, settings. */
export async function create({ name, repo = null, purpose, domain = null, root = DEFAULT_ROOT, apiUrl = DEFAULT_API_URL, tokenFile = DEFAULT_TOKEN_FILE, agentTokenFile = DEFAULT_AGENT_TOKEN_FILE, remoteFor = sshRemote }) {
  checkName(name);
  const repoName = checkName(repo || name);
  if (!String(purpose || '').trim()) throw new Error('create needs --purpose "<one sentence>"');
  const base = domainDir(root, name, domain);
  if (exists(base)) throw new Error(`${base} already exists; nothing is overwritten (P-018)`);
  const projectDir = path.join(base, repoName);
  const brainDir = path.join(base, `${name}-brain`);
  const token = readToken(tokenFile);
  const owner = await ghOwner(apiUrl, token);
  const lines = [...(await createRepo(apiUrl, token, owner, repoName, agentTokenFile)), ...(await createRepo(apiUrl, token, owner, `${name}-brain`, agentTokenFile))];
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${repoName}\n\n${String(purpose).trim()}\n`);
  fs.writeFileSync(path.join(projectDir, '.gitattributes'), `${EOL_RULE}\n`);
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', 'README.md', '.gitattributes'], ['commit', '--quiet', '-m', `Start ${repoName}`], ['remote', 'add', 'origin', remoteFor(owner, repoName)]]) {
    const r = git(args, { cwd: projectDir });
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  const push = gitRemote(['push', '--quiet', '-u', 'origin', 'main'], { cwd: projectDir });
  lines.push(push.ok ? 'project: pushed' : `project: push failed: ${push.stderr.split('\n')[0]}`);
  const res = brainInit(brainDir, { remote: remoteFor(owner, `${name}-brain`) });
  lines.push(...res.created.map((c) => `brain: ${c}`));
  lines.push(ensureDomainMarker(base, `${name}-brain`));
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

/**
 * Mail of a project's brain: a sender key for the project (its folder name, the mail project name) and
 * `<brain>/local/comms.json` with the instance of the session's mail config. connect and create left a new brain without
 * it: the project's topics were not registered and its mail stayed in local/outbox (alice 2026-11-11). The key is never
 * printed; a brain that has the config keeps it.
 */
export function issueMailKey({ projectDir, brainDir, sessionBrain, client = servicesClient(), run = spawnSync }) {
  const target = path.join(brainDir, 'local', 'comms.json');
  if (exists(target)) return 'mail: config exists (<brain>/local/comms.json)';
  const sender = path.basename(projectDir);
  const how = `issue a key with node ${toPosix(client)} key add --instance <instance> --sender ${sender} and write {instance, key, instance_id} to ${toPosix(target)} (mode 600)`;
  const src = sessionBrain ? readJson(path.join(sessionBrain, 'local', 'comms.json'), null) : null;
  if (!src?.instance || !src?.instance_id) return `mail: NOT set up (this session has no mail config with instance and instance_id): ${how}`;
  if (!exists(client)) return `mail: NOT set up (mail client ${toPosix(client)} not found): ${how}`;
  const json = (text) => { try { return JSON.parse(String(text || '')); } catch { return null; } };
  const r = run(process.execPath, [client, 'key', 'add', '--instance', src.instance, '--sender', sender], { encoding: 'utf8', timeout: 15000 });
  const res = json(r.stdout);
  if (r.status !== 0 || !res?.key) {
    const why = json(r.stderr)?.error || String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0];
    return `mail: NOT set up (key add failed: ${why}): ${how}`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ instance: src.instance, key: res.key, instance_id: src.instance_id }, null, 2)}\n`, { mode: 0o600 });
  const h = run(process.execPath, [client, 'health', '--config', target], { encoding: 'utf8', timeout: 15000 });
  const ok = h.status === 0 && json(h.stdout)?.instance_id === src.instance_id;
  return `mail: key issued for sender ${sender} (<brain>/local/comms.json)${ok ? ', service answers' : '; the service did NOT answer: run comms.mjs status in the project'}`;
}
