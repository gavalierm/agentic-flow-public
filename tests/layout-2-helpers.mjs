// Fixtures of data layout 2 (D-0048): a brain made by brain-init --layout 2 (.brain/, temy/, vystupy/) and a project repo
// whose own data layout is 2 (.brain/policy.json with data_layout 2). Built like setup() in helpers.mjs, under os.tmpdir().
// Layout 3 (flow v2, spec 4): setup3, a brain made by brain-init --layout 3 (topics/, memory/, ... in its root) beside a
// project repo in layout 3 (makeLayout3Repo: .brain/policy.json with data_layout 3).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, initProject, fixtureRoot } from './helpers.mjs';

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
function buildSetup2(root, { brainLayout, projectLayout }, env) {
  const origin = path.join(root, 'origin.git');
  gitq(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = path.join(root, 'project');
  const brain = path.join(root, 'brain');
  initProject(project, { brainRel: '../brain' });
  if (projectLayout !== 1) makeLayout2Repo(project, projectLayout);
  const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), brain, '--remote', origin, '--project', project, '--layout', String(brainLayout)], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
  gitq(brain, 'config', 'user.name', 't'); gitq(brain, 'config', 'user.email', 't@t');
}

/** The fixture of setup2 over `root` (built by buildSetup2, copied from its template, P-079). */
function setup2At(root, thread, env) {
  const origin = path.join(root, 'origin.git');
  const project = path.join(root, 'project');
  const brain = path.join(root, 'brain');
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

export function setup2({ thread = 'a1', brainLayout = 2, projectLayout = 1 } = {}) {
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const root = fixtureRoot(JSON.stringify({ f: 'setup2', thread, brainLayout, projectLayout }), (dir) => buildSetup2(dir, { brainLayout, projectLayout }, env));
  return setup2At(root, thread, env);
}

/** Layout 3: brain (brain-init --layout 3) and the session project in layout 3; setup2 with both layouts 3. */
export const setup3 = ({ thread = 'a1', projectLayout = 3 } = {}) => setup2({ thread, brainLayout: 3, projectLayout });

/** A persona in layout 2: the repository is the brain (`"brain": "."`), made by brain-init --layout 2 and the adapter. */
export function persona2({ thread = 'p1' } = {}) {
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const root = fixtureRoot(JSON.stringify({ f: 'persona2', thread }), (top) => {
    const origin = path.join(top, 'origin.git');
    gitq(top, 'init', '-q', '--bare', '-b', 'main', origin);
    const d = path.join(top, 'bob');
    const build = runner(env, d);
    const r = build('brain-init.mjs', [d, '--remote', origin, '--layout', '2'], { cwd: top });
    if (r.status !== 0) throw new Error(r.out);
    gitq(d, 'config', 'user.name', 't'); gitq(d, 'config', 'user.email', 't@t');
    const a = build('adapter.mjs', ['claude-code', '--brain', '.']);
    if (a.status !== 0) throw new Error(a.out);
  });
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'bob');
  const run = runner(env, dir);
  return { root, origin, dir, env, run, hook: hooker(env, dir), git: gitq, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * A domain (marker in the fixture root, brain `brain`) with the brain in `brainLayout`, the session project in
 * `projectLayout` and a second code repo `srv` in `repoLayout` with target branch main (repo knowledge, D-0002; plan O12).
 */
export function domain2({ thread = 'd1', brainLayout = 1, projectLayout = 2, repoLayout = 2 } = {}) {
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const root = fixtureRoot(JSON.stringify({ f: 'domain2', thread, brainLayout, projectLayout, repoLayout }), (dir) => {
    buildSetup2(dir, { brainLayout, projectLayout }, env);
    fs.writeFileSync(path.join(dir, '.agentic-domain'), '{"brain":"brain"}');
    const s = path.join(dir, 'srv');
    initProject(s);
    fs.writeFileSync(path.join(s, '.workflow.json'), JSON.stringify({ brain: '../brain', target_branch: 'main' }) + '\n');
    gitq(s, 'commit', '-qam', 'target branch');
    if (repoLayout === 2) makeLayout2Repo(s);
  });
  return { ...setup2At(root, thread, env), srv: path.join(root, 'srv') };
}

/**
 * A domain of layout 3 (spec 4, plan B11): the marker in the fixture root (brain `brain`, layout 3, `default_repo` in its
 * policy when given), the session repo `project` and a second repo `web`, both in layout 3 with a bare origin of their own
 * (`project.git`, `web.git`) on branch main. thread(state) writes the state of the session thread (turn source, dialog).
 */
export function domain3({ thread = 'a1', defaultRepo = null, web = true } = {}) {
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const root = fixtureRoot(JSON.stringify({ f: 'domain3', thread, defaultRepo, web }), (dir) => {
    buildSetup2(dir, { brainLayout: 3, projectLayout: 3 }, env);
    fs.writeFileSync(path.join(dir, '.agentic-domain'), '{"brain":"brain"}');
    const withOrigin = (repo) => {
      const bare = `${repo}.git`;
      gitq(dir, 'init', '-q', '--bare', '-b', 'main', bare);
      gitq(repo, 'remote', 'add', 'origin', bare);
      gitq(repo, 'push', '-q', '-u', 'origin', 'main');
    };
    withOrigin(path.join(dir, 'project'));
    if (web) {
      const w = path.join(dir, 'web');
      initProject(w);
      makeLayout3Repo(w);
      withOrigin(w);
    }
    if (defaultRepo) {
      const b = path.join(dir, 'brain');
      const policy = path.join(b, 'policy.json');
      fs.writeFileSync(policy, JSON.stringify({ ...JSON.parse(fs.readFileSync(policy, 'utf8')), default_repo: defaultRepo }, null, 2) + '\n');
      gitq(b, 'add', '-A');
      gitq(b, 'commit', '-q', '--no-verify', '-m', 'default repo');
      gitq(b, 'push', '-q', 'origin', 'HEAD');
    }
  });
  const fx = setup2At(root, thread, env);
  const projectOrigin = `${fx.project}.git`;
  const webDir = web ? path.join(root, 'web') : null;
  const webOrigin = web ? `${webDir}.git` : null;
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
