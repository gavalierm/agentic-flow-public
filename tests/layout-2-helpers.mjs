// Fixtures of data layout 2 (D-0048): a brain made by brain-init --layout 2 (.brain/, temy/, vystupy/) and a project repo
// whose own data layout is 2 (.brain/policy.json with data_layout 2). Built like setup() in helpers.mjs, under os.tmpdir().
// Layout 3 (flow v2, spec 4): setup3, a brain made by brain-init --layout 3 (topics/, memory/, ... in its root) beside a
// project repo in layout 3 (makeLayout3Repo: .brain/policy.json with data_layout 3).
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
export function makeLayout2Repo(dir, version = 2) {
  fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.brain', 'policy.json'), JSON.stringify({ data_layout: version }, null, 2) + '\n');
  gitq(dir, 'add', '-A');
  gitq(dir, 'commit', '-q', '-m', `data layout ${version}`);
}

/** A project repo in data layout 3: `.brain/policy.json` with data_layout 3 (O11: .brain/ as in layout 2), committed. */
export const makeLayout3Repo = (dir) => makeLayout2Repo(dir, 3);

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
  if (projectLayout !== 1) makeLayout2Repo(project, projectLayout);
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), brain, '--remote', origin, '--project', project, '--layout', String(brainLayout)], { env, encoding: 'utf8' });
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

/** Layout 3: brain (brain-init --layout 3) and the session project in layout 3; setup2 with both layouts 3. */
export const setup3 = ({ thread = 'a1', projectLayout = 3 } = {}) => setup2({ thread, brainLayout: 3, projectLayout });

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
 * `projectLayout` and a second code repo `srv` in `repoLayout` with target branch main (repo knowledge, D-0002; plan O12).
 */
export function domain2({ thread = 'd1', brainLayout = 1, projectLayout = 2, repoLayout = 2 } = {}) {
  const fx = setup2({ thread, brainLayout, projectLayout });
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const srv = path.join(fx.root, 'srv');
  initProject(srv);
  fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', target_branch: 'main' }) + '\n');
  gitq(srv, 'commit', '-qam', 'target branch');
  if (repoLayout === 2) makeLayout2Repo(srv);
  return { ...fx, srv };
}

/**
 * A domain of layout 3 (spec 4, plan B11): the marker in the fixture root (brain `brain`, layout 3, `default_repo` in its
 * policy when given), the session repo `project` and a second repo `web`, both in layout 3 with a bare origin of their own
 * (`project.git`, `web.git`) on branch main. thread(state) writes the state of the session thread (turn source, dialog).
 */
export function domain3({ thread = 'a1', defaultRepo = null, web = true } = {}) {
  const fx = setup3({ thread });
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const withOrigin = (dir) => {
    const bare = `${dir}.git`;
    gitq(fx.root, 'init', '-q', '--bare', '-b', 'main', bare);
    gitq(dir, 'remote', 'add', 'origin', bare);
    gitq(dir, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  };
  const projectOrigin = withOrigin(fx.project);
  let webDir = null;
  let webOrigin = null;
  if (web) {
    webDir = path.join(fx.root, 'web');
    initProject(webDir);
    makeLayout3Repo(webDir);
    webOrigin = withOrigin(webDir);
  }
  if (defaultRepo) {
    const policy = path.join(fx.brain, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({ ...JSON.parse(fs.readFileSync(policy, 'utf8')), default_repo: defaultRepo }, null, 2) + '\n');
    gitq(fx.brain, 'add', '-A');
    gitq(fx.brain, 'commit', '-q', '--no-verify', '-m', 'default repo');
    gitq(fx.brain, 'push', '-q', 'origin', 'HEAD');
  }
  const thread_ = (state = {}) => {
    const file = path.join(fx.brain, 'local', 'threads', `${thread}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ turn_source: 'operator', turn_started_at: new Date(Date.now() - 60_000).toISOString(), ...state }));
  };
  /** Files of a branch on a bare origin (empty when the branch is not there). */
  const onOrigin = (bare, branch) => {
    const r = spawnSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: bare, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  };
  const showOrigin = (bare, ref) => spawnSync('git', ['show', ref], { cwd: bare, encoding: 'utf8' }).stdout;
  return { ...fx, web: webDir, projectOrigin, webOrigin, thread: thread_, threadId: thread, onOrigin, showOrigin };
}
