// Fixtures of data layout 2 (D-0048): a brain made by brain-init --layout 2 (.brain/, temy/, vystupy/) and a project repo
// whose own data layout is 2 (.brain/policy.json with data_layout 2). Built like setup() in helpers.mjs, under os.tmpdir().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, initProject } from './helpers.mjs';

const BIN = (name) => path.join(PLUGIN_ROOT, 'bin', name);
const HOOK = (name) => path.join(PLUGIN_ROOT, 'hooks', name);

export function gitq(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo in data layout 2: `.brain/policy.json` with data_layout 2, committed. */
export function makeLayout2Repo(dir) {
  fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }, null, 2) + '\n');
  gitq(dir, 'add', '-A');
  gitq(dir, 'commit', '-q', '-m', 'data layout 2');
}

function runner(env, cwdDefault) {
  return (bin, args = [], opts = {}) => {
    const res = spawnSync(process.execPath, [BIN(bin), ...args], { cwd: opts.cwd || cwdDefault, env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: (res.stdout || '') + (res.stderr || '') };
  };
}

function hooker(env, cwdDefault) {
  return (name, input, opts = {}) => {
    const cwd = opts.cwd || cwdDefault;
    const res = spawnSync(process.execPath, [HOOK(name), ...(opts.args || [])], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: opts.projectDir || cwd, ...(opts.env || {}) }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd, ...input }) });
    let json = {};
    try { json = JSON.parse(res.stdout.trim() || '{}'); } catch { json = { raw: res.stdout }; }
    return { status: res.status, json, stderr: res.stderr, context: json.hookSpecificOutput?.additionalContext || '', decision: json.hookSpecificOutput?.permissionDecision, reason: json.hookSpecificOutput?.permissionDecisionReason || '' };
  };
}

/**
 * <root>/origin.git, <root>/project (a code repo, layout 1 unless projectLayout 2) and <root>/brain made by
 * brain-init --layout 2 (or layout 1 with brainLayout 1), pushed to origin.
 */
export function setup2({ thread = 'a1', brainLayout = 2, projectLayout = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-l2-'));
  const origin = path.join(root, 'origin.git');
  gitq(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = path.join(root, 'project');
  const brain = path.join(root, 'brain');
  initProject(project, { brainRel: '../brain' });
  if (projectLayout === 2) makeLayout2Repo(project);
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), brain, '--remote', origin, '--project', project, ...(brainLayout === 1 ? [] : ['--layout', String(brainLayout)])], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
  gitq(brain, 'config', 'user.name', 't'); gitq(brain, 'config', 'user.email', 't@t');
  return {
    root, origin, project, brain, env, thread,
    run: runner(env, project),
    hook: hooker(env, project),
    git: gitq,
    read(rel, base = brain) { return fs.readFileSync(path.join(base, rel), 'utf8'); },
    json(rel, base = brain) { return JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8')); },
    exists(rel, base = brain) { return fs.existsSync(path.join(base, rel)); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** A persona in layout 2: the repository is the brain (`"brain": "."`), made by brain-init --layout 2 and the adapter. */
export function persona2({ thread = 'p1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-l2p-'));
  const origin = path.join(root, 'origin.git');
  gitq(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'bob');
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const run = runner(env, dir);
  const r = run('brain-init.mjs', [dir, '--remote', origin, '--layout', '2'], { cwd: root });
  if (r.status !== 0) throw new Error(r.out);
  gitq(dir, 'config', 'user.name', 't'); gitq(dir, 'config', 'user.email', 't@t');
  const a = run('adapter.mjs', ['claude-code', '--brain', '.']);
  if (a.status !== 0) throw new Error(a.out);
  return { root, origin, dir, env, run, hook: hooker(env, dir), git: gitq, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * A domain (marker in the fixture root, brain `brain`) with the brain in `brainLayout`, the session project in
 * `projectLayout` and a second code repo `srv` in `repoLayout` with knowledge branch main (repo knowledge, D-0002).
 */
export function domain2({ thread = 'd1', brainLayout = 1, projectLayout = 2, repoLayout = 2 } = {}) {
  const fx = setup2({ thread, brainLayout, projectLayout });
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const srv = path.join(fx.root, 'srv');
  initProject(srv);
  fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'main' }) + '\n');
  gitq(srv, 'commit', '-qam', 'knowledge branch');
  if (repoLayout === 2) makeLayout2Repo(srv);
  return { ...fx, srv };
}
