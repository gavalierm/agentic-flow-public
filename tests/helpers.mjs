// Test fixtures: temporary project + brain + bare origin, all under os.tmpdir(). No dependencies.
import './tmp-scope.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flowModel, commsModel, resolve as resolveComms } from '../scripts/comms-pair.mjs';
import { brainId } from '../scripts/brain-id.mjs';
import { machineName } from '../scripts/config.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (name) => path.join(PLUGIN_ROOT, 'bin', name);
const HOOK = (name) => path.join(PLUGIN_ROOT, 'hooks', name);

function gitq(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

const OPERATOR_HEAD = /^([ \t]*\*\*(?:Otázky na operátora|Úlohy pre operátora):\*\*)[ \t]*(\S.*)?$/;
/** A reply written shortly in a test (`Stav: …`, `- [ ] …` items, a text after an operator heading, the line
 * `Handover: <ids> – <step>`) in the protocol form of D-0040: bold state line, numbered items, a **Handover:** section. */
export function toProtocol(msg) {
  const lines = msg.replace(/\s+$/, '').split('\n');
  const out = [];
  let n = -1;
  for (const line of lines) {
    const head = OPERATOR_HEAD.exec(line);
    if (head) { out.push(head[1]); n = 0; if (head[2]) out.push(`${++n}. ${head[2]}`); continue; }
    const item = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]?\][ \t]*)?|\d+[.)][ \t]+)(.*)$/.exec(line);
    if (item && n >= 0) { out.push(`${++n}. ${item[1]}`); continue; }
    if ((!line.trim() && n > 0) || line.trim()) n = -1;
    const ho = /^[ \t]*Handover[ \t]*:[ \t]*(.*)$/.exec(line);
    if (ho) {
      const [ids, step] = ho[1].split(/\s+[–-]\s+/);
      if (/^(žiadny|ziadny|-|–)/i.test(ho[1].trim())) out.push('**Handover:** žiadny');
      else out.push('**Handover:**', ...ids.split(/,\s*/).map((id, i) => `${i + 1}. ${id.trim()} → ${step || 'ďalší krok'}`));
      continue;
    }
    out.push(/^Stav[ \t]*:/.test(line) ? line.replace(/^Stav[ \t]*:/, '**Stav:**') : line);
  }
  return out.join('\n');
}

/** The reply in the protocol form (toProtocol) when its last line is a state line, else as written. */
export function inProtocol(msg) {
  const lines = toProtocol(msg).split('\n');
  return /^stav\s*:/i.test(lines[lines.length - 1].replace(/[*_`>]/g, '').trim()) ? lines.join('\n') : msg;
}

/** Files of the repo at root as git sees them: tracked, and untracked that are not ignored, present on disk (absolute paths).
 * Static checks scan only these: a shared checkout holds ignored deployed files (.claude/skills/ with persona .sh scripts,
 * local/, scratch/) that are not workflow files (release v0.9.92, 2026-11-13). Not a git repo: every file but .git, node_modules, local/. */
export function repoFiles(root) {
  const r = fs.existsSync(path.join(root, '.git')) ? spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }) : null;
  if (r && r.status === 0) {
    return [...new Set(r.stdout.split('\0').filter(Boolean))].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'local'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(root);
  return out;
}

// No GitHub access in tests (agentic-flow-public#97): a test whose mail fails made error.mjs report file a real issue
// with the machine token; a test that needs GitHub stubs it (skill stub-prikaz) and overrides these.
// No real T3 in tests (flow-1-8-1): `t3 thread show` (thread state, title) goes to a missing program, a state T3 does not
// give; a test of the state stubs it (skill stub-prikaz) through WORKFLOW_T3_SHOW_COMMAND or policy thread_title.command.
export const NO_T3 = { WORKFLOW_T3_SHOW_COMMAND: '/nonexistent-machine-dir/t3 thread show --json' };
export const NO_GITHUB = { WORKFLOW_GITHUB_TOKEN_FILE: '/nonexistent-machine-dir/github_token', WORKFLOW_GH_CLI: '/nonexistent-machine-dir/gh', WORKFLOW_GITHUB_API: 'http://127.0.0.1:9' };

export function cleanEnv(extra = {}) {
  const env = { ...process.env, WORKFLOW_PLUGIN_ROOT: PLUGIN_ROOT, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', WORKFLOW_TEMP_DIRS: '/nonexistent-temp-dir', WORKFLOW_SERVICES_DIR: '/nonexistent-services-dir', WORKFLOW_RULE_JUDGE: 'off', WORKFLOW_OVERLAP_JUDGE: 'off', WORKFLOW_MACHINE_FILE: '/nonexistent-machine-dir/machine-id', WORKFLOW_PIN_FILE: '/nonexistent-machine-dir/pin.json', WORKFLOW_ROOT_FILE: '/nonexistent-machine-dir/projects-root', WORKFLOW_ISSUE_WATCH_INDEX: '/nonexistent-machine-dir/issue-watch-index.json', WORKFLOW_WAKE_FILE: '/nonexistent-machine-dir/wake.json', WORKFLOW_TIMER_INDEX: '/nonexistent-machine-dir/timer-index.json', WORKFLOW_MACHINE_COMMS: '/nonexistent-machine-dir/comms.json', WORKFLOW_MAINTAINER_MAIL: '/nonexistent-machine-dir/maintainer-mail.json', ...NO_T3, ...NO_GITHUB };
  // The configuration of the installation (operator repo, plan O9): never the real ~/.config/agentic-flow/config.json.
  env.WORKFLOW_INSTALL_CONFIG = '/nonexistent-machine-dir/config.json';
  for (const k of ['CLAUDE_PROJECT_DIR', 'WORKFLOW_COMMS_CONFIG', 'WORKFLOW_PROJECT_DIR', 'WORKFLOW_THREAD_ID', 'T3CODE_THREAD_ID', 'WORKFLOW_AGENT_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
  return { ...env, ...extra };
}

export function initProject(dir, { brainRel = '../brain', remote = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  gitq(dir, 'init', '-q', '-b', 'main');
  gitq(dir, 'config', 'user.name', 't');
  gitq(dir, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, '.workflow.json'), JSON.stringify({ brain: brainRel }) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);\n');
  gitq(dir, 'add', '-A');
  gitq(dir, 'commit', '-q', '-m', 'init');
  if (remote) {
    gitq(dir, 'remote', 'add', 'origin', remote);
    gitq(dir, 'push', '-q', '-u', 'origin', 'main');
  }
}

/**
 * Fixture: <root>/origin.git (bare), <root>/project, <root>/brain (pushed to origin).
 * Optional second clone: <root>/project-b + <root>/brain-b. The brain is in data layout `layout` (1 unless given; a new
 * brain without --layout is layout 3, tests/layout-2-helpers.mjs setup3).
 */
// P-079 (speed): setup() built the repos and the brain anew for every test (~400 ms: git init, commits, brain-init.mjs,
// push to the bare remote; ~330 tests). The first setup of a shape builds them once per test process; every setup copies
// that template (~10 ms) and rewrites the absolute paths it holds (git config and logs of the brains).
// WORKFLOW_TEST_FRESH_SETUP=1 builds every fixture anew.
const TEMPLATES = new Map();
function templateFiles(root) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'objects') walk(p); } else if (e.isFile() && fs.readFileSync(p).includes(root)) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  return hits;
}
export function fixtureRoot(key, build) {
  if (process.env.WORKFLOW_TEST_FRESH_SETUP === '1') { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-')); build(root); return root; }
  let t = TEMPLATES.get(key);
  if (!t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tpl-'));
    build(root);
    t = { root, files: templateFiles(root) };
    if (!TEMPLATES.size) process.on('exit', () => { for (const x of TEMPLATES.values()) fs.rmSync(x.root, { recursive: true, force: true }); });
    TEMPLATES.set(key, t);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  fs.cpSync(t.root, root, { recursive: true });
  for (const rel of t.files) { const f = path.join(root, rel); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(t.root).join(root)); }
  return root;
}

export function setup({ thread = 'a1', remote = true, second = false, brainName = 'brain', layout = 1 } = {}) {
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const root = fixtureRoot(JSON.stringify({ thread, remote, second, brainName, layout }), (dir) => {
    const origin = path.join(dir, 'origin.git');
    if (remote) gitq(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    const project = path.join(dir, 'project');
    const brain = path.join(dir, brainName);
    initProject(project, { brainRel: `../${brainName}` });
    const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), brain, ...(remote ? ['--remote', origin] : []), '--project', project, '--layout', String(layout)], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
    gitq(brain, 'config', 'user.name', 't'); gitq(brain, 'config', 'user.email', 't@t');
    if (second) {
      const projectB = path.join(dir, 'project-b');
      const brainB = path.join(dir, 'brain-b');
      initProject(projectB, { brainRel: '../brain-b' });
      gitq(dir, 'clone', '-q', origin, brainB);
      const r2 = spawnSync(process.execPath, [BIN('brain-init.mjs'), brainB, '--attach', '--project', projectB], { env, encoding: 'utf8' });
      if (r2.status !== 0) throw new Error(`brain-init --attach failed: ${r2.stderr}`);
      gitq(brainB, 'config', 'user.name', 't'); gitq(brainB, 'config', 'user.email', 't@t');
    }
  });
  const origin = path.join(root, 'origin.git');
  const project = path.join(root, 'project');
  const brain = path.join(root, brainName);
  const fx = {
    root, origin, project, brain, env, thread,
    run(bin, args = [], opts = {}) {
      const res = spawnSync(process.executablePath || process.execPath, [BIN(bin), ...args], { cwd: opts.cwd || project, env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: (res.stdout || '') + (res.stderr || '') };
    },
    runAsync(bin, args = [], opts = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN(bin), ...args], { cwd: opts.cwd || project, env: { ...env, ...(opts.env || {}) } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
      });
    },
    hook(name, input, opts = {}) {
      // P-061: a short test reply (`Stav: …`, `- [ ] …`) goes to Stop in the protocol form; `raw: true` leaves it as written.
      const { raw, ...rest } = input;
      input = rest;
      if (name === 'stop.mjs' && !raw && typeof input.last_assistant_message === 'string') input = { ...input, last_assistant_message: inProtocol(input.last_assistant_message) };
      const res = spawnSync(process.execPath, [HOOK(name), ...(opts.args || [])], { cwd: opts.cwd || project, env: { ...env, CLAUDE_PROJECT_DIR: opts.cwd || project, ...(opts.env || {}) }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: opts.cwd || project, ...input }) });
      let json = {};
      try { json = JSON.parse(res.stdout.trim() || '{}'); } catch { json = { raw: res.stdout }; }
      return { status: res.status, json, stderr: res.stderr, context: json.hookSpecificOutput?.additionalContext || '' };
    },
    git(cwd, ...args) { return gitq(cwd, ...args); },
    read(rel, base = brain) { return fs.readFileSync(path.join(base, rel), 'utf8'); },
    exists(rel, base = brain) { return fs.existsSync(path.join(base, rel)); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
  if (second) {
    fx.projectB = path.join(root, 'project-b');
    fx.brainB = path.join(root, 'brain-b');
    fx.envB = cleanEnv({ WORKFLOW_THREAD_ID: 'b2' });
    fx.runB = (bin, args = [], opts = {}) => fx.run(bin, args, { cwd: fx.projectB, env: { ...fx.envB, ...(opts.env || {}) }, ...opts });
    fx.runAsyncB = (bin, args = [], opts = {}) => fx.runAsync(bin, args, { cwd: fx.projectB, env: { ...fx.envB, ...(opts.env || {}) }, ...opts });
  }
  return fx;
}

export const memoryRecord = (key, body = 'x', extra = '') => `---\nkey: ${key}\ntype: ${key.split('-')[0]}\nname: ${key.split('-').slice(1).join(' ')}\norigin: operator\n${extra}---\n${body}\n`;

// --- mail (agentic-comms) fixtures ----------------------------------------------------------------
// The comms client is looked up via AGENTIC_COMMS_DIR, next to the plugin clone (../agentic-comms) or, from a topic
// worktree <domain>/.worktrees/<repo>/<id>, in <domain>/agentic-comms; integration tests skip when it is missing. The
// service runs as a child process on a temporary instance under the fixture root.
// Only mail of the model the workflow declares (package.json commsModel, D-0089, scripts/comms-pair.mjs): a found
// checkout of another model is replaced by its newest tag with the model (export in the system temp dir); none, or
// AGENTIC_COMMS_DIR of another model, throws: the mail tests fail loudly, never run against another model.

let commsClientCache;
export function commsClient() {
  if (commsClientCache !== undefined) return commsClientCache;
  const explicit = process.env.AGENTIC_COMMS_DIR;
  const dirs = explicit ? [explicit]
    : [path.resolve(PLUGIN_ROOT, '..', 'agentic-comms'), path.resolve(PLUGIN_ROOT, '..', '..', '..', 'agentic-comms')];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'bin', 'comms.mjs')));
  if (!dir) return (commsClientCache = null);
  const model = flowModel();
  let use = dir;
  if (commsModel(dir) !== model) {
    if (explicit) throw new Error(`AGENTIC_COMMS_DIR=${dir} is mail model ${commsModel(dir)}, the workflow model ${model} (package.json commsModel)`);
    const r = resolveComms(dir, model, path.join(os.tmpdir(), 'agentic-comms-pair'));
    if (r.error) throw new Error(r.line);
    use = r.dir;
  }
  return (commsClientCache = path.join(use, 'bin', 'comms.mjs'));
}

function commsCli(client, args, env = {}) {
  const r = spawnSync(process.execPath, [client, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Temporary mail instance for a fixture: `init`, client config in <brain>/local/comms.json (autostart off so an
 * outage fails fast), `comms` wiring in <project>/local/workflow.json, service as a child process.
 */
export async function startComms(fx, { senders = ['alice'], brains = null } = {}) {
  const client = commsClient();
  if (!client) throw new Error('agentic-comms not found');
  const dataDir = path.join(fx.root, 'comms');
  const init = commsCli(client, ['init', '--instance', 'wf-test', '--sender', senders[0], '--data-dir', dataDir]);
  if (init.code !== 0) throw new Error(`comms init failed: ${init.out}`);
  const keys = { [senders[0]]: init.json.key };
  for (const s of senders.slice(1)) {
    const k = commsCli(client, ['key', 'add', '--sender', s, '--data-dir', dataDir]);
    keys[s] = k.json.key;
  }
  const pairs = brains || [[fx.project, fx.brain, senders[0]]];
  for (const [project, brain, sender] of pairs) {
    fs.mkdirSync(path.join(brain, 'local'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'local', 'comms.json'), JSON.stringify({ data_dir: dataDir, key: keys[sender], instance_id: init.json.instance_id, autostart: false }) + '\n');
    fs.mkdirSync(path.join(project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(project, 'local', 'workflow.json'), JSON.stringify({ comms: { client: path.relative(project, client).split(path.sep).join('/') } }) + '\n');
  }
  let child = null;
  // Mail model 3: a raw client call names the sender's brain and the machine the workflow gives its client (scripts/comms.mjs).
  const brainOf = (sender) => pairs.find((p) => p[2] === sender)?.[1] || null;
  const machine = machineName(cleanEnv());
  const comms = {
    client, dataDir, keys, instanceId: init.json.instance_id,
    cli(args, sender = senders[0]) {
      const b = brainOf(sender);
      const who = args.includes('--brain') || !b ? [] : ['--brain', brainId(b), '--brain-name', path.basename(b)];
      return commsCli(client, [...args, '--data-dir', dataDir, '--key', keys[sender], '--no-start', ...who, ...(args.includes('--machine') ? [] : ['--machine', machine])]);
    },
    async start() {
      child = spawn(process.execPath, [client, 'serve', '--data-dir', dataDir], { stdio: 'ignore' });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (commsCli(client, ['health', '--data-dir', dataDir, '--no-start']).code === 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('comms service did not start');
    },
    async stop() {
      if (!child) return;
      if (child.exitCode !== null || child.signalCode !== null) { child = null; return; }
      child.kill('SIGTERM');
      // The fallback timer is cleared: left running, it held every test file with mail 2 s after its last test (P-079).
      await new Promise((resolve) => { const t = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      child = null;
    },
    /** Move the outage backoff (and an old client's 60 s cache) into the past so the next count asks the service. */
    expireCache(brain) {
      const file = path.join(brain, 'local', 'comms', 'count-cache.json');
      if (!fs.existsSync(file)) return;
      const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of Object.keys(cache)) { if (cache[k].at) cache[k].at -= 120000; if (cache[k].failed_at) cache[k].failed_at -= 120000; }
      fs.writeFileSync(file, JSON.stringify(cache));
    },
    /** The record of <project>/<topic> (model 3: files are named by a hash of the key): the open one, else the newest. */
    topic(project, topic) {
      const dir = path.join(dataDir, 'topics');
      const recs = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.json'))
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
        .filter((r) => r && r.project === project && r.topic === topic);
      return recs.find((r) => r.state !== 'closed') || recs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
    },
  };
  await comms.start();
  return comms;
}
