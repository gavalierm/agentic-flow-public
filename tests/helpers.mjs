// Test fixtures: temporary project + brain + bare origin, all under os.tmpdir(). No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (name) => path.join(PLUGIN_ROOT, 'bin', name);
const HOOK = (name) => path.join(PLUGIN_ROOT, 'hooks', name);

function gitq(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export function cleanEnv(extra = {}) {
  const env = { ...process.env, WORKFLOW_PLUGIN_ROOT: PLUGIN_ROOT, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', WORKFLOW_TEMP_DIRS: '/nonexistent-temp-dir', WORKFLOW_SERVICES_DIR: '/nonexistent-services-dir', WORKFLOW_RULE_JUDGE: 'off', WORKFLOW_MACHINE_FILE: '/nonexistent-machine-dir/machine-id', WORKFLOW_PIN_FILE: '/nonexistent-machine-dir/pin.json', WORKFLOW_ROOT_FILE: '/nonexistent-machine-dir/projects-root' };
  for (const k of ['CLAUDE_PROJECT_DIR', 'WORKFLOW_PROJECT_DIR', 'WORKFLOW_THREAD_ID', 'T3CODE_THREAD_ID', 'WORKFLOW_AGENT_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
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
 * Optional second clone: <root>/project-b + <root>/brain-b.
 */
export function setup({ thread = 'a1', remote = true, second = false, brainName = 'brain' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const origin = path.join(root, 'origin.git');
  if (remote) gitq(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = path.join(root, 'project');
  const brain = path.join(root, brainName);
  initProject(project, { brainRel: `../${brainName}` });
  const env = cleanEnv({ WORKFLOW_THREAD_ID: thread });
  const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), brain, ...(remote ? ['--remote', origin] : []), '--project', project], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
  for (const b of [brain]) { gitq(b, 'config', 'user.name', 't'); gitq(b, 'config', 'user.email', 't@t'); }
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
    initProject(fx.projectB, { brainRel: '../brain-b' });
    gitq(root, 'clone', '-q', origin, fx.brainB);
    const r2 = spawnSync(process.execPath, [BIN('brain-init.mjs'), fx.brainB, '--attach', '--project', fx.projectB], { env, encoding: 'utf8' });
    if (r2.status !== 0) throw new Error(`brain-init --attach failed: ${r2.stderr}`);
    gitq(fx.brainB, 'config', 'user.name', 't'); gitq(fx.brainB, 'config', 'user.email', 't@t');
    fx.envB = cleanEnv({ WORKFLOW_THREAD_ID: 'b2' });
    fx.runB = (bin, args = [], opts = {}) => fx.run(bin, args, { cwd: fx.projectB, env: { ...fx.envB, ...(opts.env || {}) }, ...opts });
    fx.runAsyncB = (bin, args = [], opts = {}) => fx.runAsync(bin, args, { cwd: fx.projectB, env: { ...fx.envB, ...(opts.env || {}) }, ...opts });
  }
  return fx;
}

export const memoryRecord = (key, body = 'x', extra = '') => `---\nkey: ${key}\ntype: ${key.split('-')[0]}\nname: ${key.split('-').slice(1).join(' ')}\norigin: operator\n${extra}---\n${body}\n`;

// --- mail (agentic-comms) fixtures ----------------------------------------------------------------
// The comms client is looked up next to the plugin clone (../agentic-comms) or via AGENTIC_COMMS_DIR; integration
// tests skip when it is missing. The service runs as a child process on a temporary instance under the fixture root.

export function commsClient() {
  const dir = process.env.AGENTIC_COMMS_DIR || path.resolve(PLUGIN_ROOT, '..', 'agentic-comms');
  const client = path.join(dir, 'bin', 'comms.mjs');
  return fs.existsSync(client) ? client : null;
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
  const comms = {
    client, dataDir, keys, instanceId: init.json.instance_id,
    cli(args, sender = senders[0]) { return commsCli(client, [...args, '--data-dir', dataDir, '--key', keys[sender], '--no-start']); },
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
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2000); });
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
    topic(project, topic) {
      const f = path.join(dataDir, 'topics', `${project}__${topic}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
  };
  await comms.start();
  return comms;
}
