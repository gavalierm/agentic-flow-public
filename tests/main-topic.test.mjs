// P-045, P-050: the persona main thread holds the permanent topic `main` (mailbox `@<persona>/main`); a topic created
// for a new thread is held by that thread from its first turn (Bob 2026-11-01: both threads showed `Téma: žiadna`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, setup } from './helpers.mjs';

const block = (ctx) => (/MUST start with exactly the next \d+ lines[^\n]*\n([\s\S]*?)\n\(end of status block\)/.exec(ctx) || [])[1];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Fake mail client: logs argv, `count` answers one waiting blocker. */
function fakeClient(root) {
  const log = path.join(root, 'client.log');
  const file = path.join(root, 'fake-comms.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');
if (a[0] === 'count') process.stdout.write(JSON.stringify({ total: 1, blocker: 1, ids: ['m1'], cached: false }));
else if (a[0] === 'notices') process.stdout.write(JSON.stringify({ notices: [{ id: 'n1' }, { id: 'n2' }] }));
else process.stdout.write(JSON.stringify({ ok: true, created: true }));
`);
  return { file, lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function persona() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-main-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'bob');
  const client = fakeClient(root);
  const env = cleanEnv({ WORKFLOW_THREAD_ID: 'p1', WORKFLOW_COMMS_CLIENT: client.file });
  const run = (bin, args) => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', bin), ...args], { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const init = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), dir, '--remote', origin], { cwd: root, env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  fs.writeFileSync(path.join(dir, '.workflow.json'), JSON.stringify({ brain: '.' }));
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t');
  const hook = (name, input) => {
    const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', name)], { cwd: dir, env: { ...env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: dir, ...input }) });
    return JSON.parse(res.stdout.trim() || '{}').hookSpecificOutput?.additionalContext || '';
  };
  return { dir, run, hook, client, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('persona main thread: topic main is held, registered as @<persona>/main, counts its mailbox, never free or closed', () => {
  const p = persona();
  try {
    const before = block(p.hook('session-start.mjs', { source: 'startup' }));
    assert.match(before, /^bob \/ bez témy/, 'without topic main the main thread has no topic (the bug)');

    const claim = p.run('topic.mjs', ['main']);
    assert.equal(claim.status, 0, claim.out);
    assert.match(claim.out, /topic main claimed by p1/);
    assert.ok(p.client.lines().some((l) => /^register-topic --persona bob --main --holder p1\b/.test(l)), p.client.lines().join('\n'));

    const started = p.hook('session-start.mjs', { source: 'startup' });
    const after = block(started);
    assert.equal(after, 'bob / main\nPošta: 1 (1 blocker)\nOtvorené oznamy: 2');
    assert.match(started, /\| notices: 2 open/, 'open notices in the status line of the main thread (D-0011)');
    assert.ok(p.client.lines().some((l) => /^count --persona bob --thread p1\b/.test(l)), 'mailbox @bob/main is counted');

    assert.equal(p.run('topic.mjs', ['main']).status, 0, 'idempotent');
    assert.match(p.run('topic.mjs', ['create', 'main', '--subject', 'x']).out, /reserved for the persona main thread/);
    const fin = p.run('done.mjs', ['--topic', '--topic-id', 'main', '--verified', 'x']);
    assert.notEqual(fin.status, 0);
    assert.match(fin.out, /never closed or archived/);

    // A work topic of the main thread comes first; main is not offered as free to other threads.
    assert.equal(p.run('topic.mjs', ['create', 'work', '--subject', 'Work']).status, 0);
    assert.equal(block(p.hook('session-start.mjs', { source: 'startup' })).split('\n')[0], 'bob / work');
    assert.equal(p.client.lines().filter((l) => /^notices\b/.test(l)).length, 1, 'notices cached for comms.notices_ttl_s');
  } finally { p.cleanup(); }
});

test('topic main outside a persona is refused', () => {
  const fx = setup();
  try {
    const r = fx.run('topic.mjs', ['main']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /only in a persona brain/);
  } finally { fx.cleanup(); }
});

test('topic create --for-thread: the new thread holds the topic from its first turn', () => {
  const fx = setup();
  try {
    const r = fx.run('topic.mjs', ['create', 'beszel', '--subject', 'Beszel', '--for-thread', 'mcp:launch:abc']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /assigned to mcp:launch:abc/);
    const holder = JSON.parse(fx.read('topics/beszel/holder.json'));
    assert.equal(holder.thread, 'mcp:launch:abc');
    assert.equal(holder.assigned_by, 'a1');
    const ctx = fx.hook('session-start.mjs', { source: 'startup' }, { env: { WORKFLOW_THREAD_ID: 'mcp:launch:abc' } }).context;
    assert.equal(block(ctx), 'project / beszel');
    assert.match(fx.run('topic.mjs', ['create', 'x', '--subject', 'X', '--for-thread', 'bad id']).out, /is not a thread id/);
  } finally { fx.cleanup(); }
});

test('topic create in T3 starts the topic thread titled by the topic, with its content, and assigns the topic to it (P-036)', () => {
  const fx = setup();
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-t3-'));
    const log = path.join(tmp, 't3-calls.json');
    const fake = path.join(tmp, 'fake-t3.mjs');
    fs.writeFileSync(fake, `import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }));\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:new1' }));\n`);
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${fake}` } }));
    // a thread without a topic takes the new topic itself: the operator gave the task in it (alice 2026-11-03)
    const free = fx.run('topic.mjs', ['create', 'own', '--subject', 'Own'], { env: { T3CODE_THREAD_ID: 'a0', WORKFLOW_THREAD_ID: 'a0' } });
    assert.match(free.out, /claimed by a0/);
    assert.ok(!fs.existsSync(log), 'no thread started for a thread without a topic');
    const t3 = { env: { T3CODE_THREAD_ID: 'a1' } };
    assert.match(fx.run('topic.mjs', ['create', 'base', '--subject', 'Base', '--here'], t3).out, /claimed by a1/);
    const r = fx.run('topic.mjs', ['create', 'tracker-owner', '--subject', 'Vlastník Trackera'], t3);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /thread mcp:launch:new1 started with title tracker-owner/);
    const call = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepEqual(call.argv.slice(0, 2), ['--title', 'tracker-owner']);
    assert.equal(call.argv.at(-1), '-');
    assert.match(call.input, /Téma tracker-owner \(discussion\)[\s\S]*Predmet: Vlastník Trackera[\s\S]*počkaj na jeho pokyn/);
    assert.equal(JSON.parse(fx.read('topics/tracker-owner/holder.json')).thread, 'mcp:launch:new1');
    // --task: the operator already gave the work, so the thread does it now instead of waiting (operator 2026-11-02)
    fs.rmSync(log);
    const tk = fx.run('topic.mjs', ['create', 'playbook', '--subject', 'Playbook', '--task', 'Aktualizuj playbook a pushni'], t3);
    assert.equal(tk.status, 0, tk.out);
    const tcall = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.match(tcall.input, /Zadanie operátora:\nAktualizuj playbook a pushni[\s\S]*vykonaj hneď/);
    assert.doesNotMatch(tcall.input, /počkaj na jeho pokyn/);
    // --here keeps the old way: this thread claims it, no thread is started
    fs.rmSync(log);
    const h = fx.run('topic.mjs', ['create', 'stay', '--subject', 'Stay', '--here'], t3);
    assert.match(h.out, /claimed by a1/);
    assert.ok(!fs.existsSync(log));
    // a failing start leaves the topic free and says how to go on
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} -e process.exit(3)` } }));
    const f = fx.run('topic.mjs', ['create', 'broken', '--subject', 'Broken'], t3);
    assert.equal(f.status, 1);
    assert.match(f.out, /no thread was started.*t3_thread_launch .*title broken.*topic.mjs thread broken .*--for-thread <new thread id>.*topic.mjs claim broken/);
    assert.equal(fx.read('topics/broken/holder.json').trim(), '{}');
    // a machine without the t3 CLI (agentic-flow-public#10): the same thread through t3_thread_launch, then assigned
    const msgFile = f.out.match(/content of (\S+?)\)/)[1];
    assert.match(fs.readFileSync(msgFile, 'utf8'), /Téma broken \(discussion\)[\s\S]*Predmet: Broken/);
    const nf = fx.run('topic.mjs', ['thread', 'broken', '--task', 'x'], t3);
    assert.equal(nf.status, 1);
    assert.match(nf.out, /no thread was started.*t3_thread_launch/);
    const asg = fx.run('topic.mjs', ['thread', 'broken', '--for-thread', 'mcp:launched:9'], t3);
    assert.equal(asg.status, 0, asg.out);
    assert.match(asg.out, /thread mcp:launched:9 assigned; it holds the topic/);
    assert.equal(JSON.parse(fx.read('topics/broken/holder.json')).thread, 'mcp:launched:9');
    fx.run('topic.mjs', ['release', 'broken'], { env: { T3CODE_THREAD_ID: 'mcp:launched:9', WORKFLOW_THREAD_ID: 'mcp:launched:9' } });
    assert.equal(fx.read('topics/broken/holder.json').trim(), '{}', 'free again for the next step');
    // topic thread: a free topic gets its own thread later (Bob 2026-11-03: a topic thread that never claimed it had no address)
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${fake}` } }));
    const st = fx.run('topic.mjs', ['thread', 'broken', '--task', 'Over to'], t3);
    assert.equal(st.status, 0, st.out);
    assert.match(st.out, /thread mcp:launch:new1 started with title broken; it holds the topic/);
    assert.match(JSON.parse(fs.readFileSync(log, 'utf8')).input, /Téma broken[\s\S]*Zadanie operátora:\nOver to/);
    assert.equal(JSON.parse(fx.read('topics/broken/holder.json')).thread, 'mcp:launch:new1');
    const held = fx.run('topic.mjs', ['thread', 'base'], t3);
    assert.equal(held.status, 1);
    assert.match(held.out, /a new thread needs a free topic/);
  } finally { fx.cleanup(); }
});

test('thread start command on Windows: an npm shim t3.cmd is found over PATH and PATHEXT and run through the shell (agentic-flow-public#10)', async () => {
  const { spawnTarget } = await import('../scripts/topic.mjs');
  const env = { PATH: 'C:\\bin;C:\\npm', PATHEXT: '.EXE;.CMD' };
  const t = spawnTarget('t3', ['--title', 'x', 'D:\\Claude projekty\\Home assistant\\ha', '-'], { platform: 'win32', env, exists: (f) => f === 'C:\\npm\\t3.CMD' });
  assert.equal(t.shell, true);
  assert.equal(t.file, '"C:\\npm\\t3.CMD" "--title" "x" "D:\\Claude projekty\\Home assistant\\ha" "-"');
  const exe = spawnTarget('t3', ['a'], { platform: 'win32', env, exists: (f) => f === 'C:\\bin\\t3.EXE' });
  assert.deepEqual(exe, { file: 'C:\\bin\\t3.EXE', args: ['a'], shell: false });
  assert.deepEqual(spawnTarget('t3', ['a'], { platform: 'linux', env }), { file: 't3', args: ['a'], shell: false });
  assert.deepEqual(spawnTarget('t3', ['a'], { platform: 'win32', env, exists: () => false }), { file: 't3', args: ['a'], shell: false });
});

test('topic main in a wake turn: first adoption allowed, taking over a held main refused (P-047)', async () => {
  const { writeThreadState } = await import('../scripts/config.mjs');
  const p = persona();
  try {
    writeThreadState(p.dir, 'p1', { turn_source: 'wake' });
    const first = p.run('topic.mjs', ['main']);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /topic main claimed by p1/);
    const holder = path.join(p.dir, 'topics/main/holder.json');
    fs.writeFileSync(holder, JSON.stringify({ thread: 'other', machine: 'm' }));
    git(p.dir, 'commit', '-q', '--no-verify', '-am', 'other holder');
    const again = p.run('topic.mjs', ['main']);
    assert.notEqual(again.status, 0);
    assert.match(again.out, /started by a message/);
  } finally { p.cleanup(); }
});

test('topic main held by another thread: takeover only with --force; done on main counts the persona mailbox (bob 2026-11-01)', async () => {
  const p = persona();
  try {
    assert.equal(p.run('topic.mjs', ['main']).status, 0);
    const fin = p.run('done.mjs', ['--topic-id', 'main', '--verified', 'x']);
    assert.equal(fin.status, 0, fin.out);
    assert.match(fin.out, /mail: 1 waiting for topic main \(free point\)/);
    const holder = path.join(p.dir, 'topics/main/holder.json');
    fs.writeFileSync(holder, JSON.stringify({ thread: 'other', machine: 'm' }));
    git(p.dir, 'commit', '-q', '--no-verify', '-am', 'other holder');
    const refused = p.run('topic.mjs', ['main']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /held by other: only a new persona main thread takes it over/);
    // --force alone is not enough: the takeover needs the operator's approval named by the flag (P-037, P-045).
    const unapproved = p.run('topic.mjs', ['main', '--force']);
    assert.notEqual(unapproved.status, 0, unapproved.out);
    assert.match(unapproved.out, /--force requires --operator-approved/);
    assert.equal(JSON.parse(fs.readFileSync(holder, 'utf8')).thread, 'other', 'refused takeover leaves the holder');
    const forced = p.run('topic.mjs', ['main', '--force', '--operator-approved']);
    assert.equal(forced.status, 0, forced.out);
    assert.match(forced.out, /took over from other/);
    // The takeover is registered with the takeover flag, so the mail service accepts the holder change.
    assert.ok(p.client.lines().some((l) => /^register-topic --persona bob --main --holder p1 .*--takeover\b/.test(l)), p.client.lines().join('\n'));
  } finally { p.cleanup(); }
});

test('topic main is never released; done on main records no free point and says it stays held (P-045)', () => {
  const p = persona();
  try {
    assert.equal(p.run('topic.mjs', ['main']).status, 0);
    const rel = p.run('topic.mjs', ['release', 'main']);
    assert.notEqual(rel.status, 0, rel.out);
    assert.match(rel.out, /never released \(P-045\)/);
    const fin = p.run('done.mjs', ['--topic-id', 'main', '--verified', 'x']);
    assert.equal(fin.status, 0, fin.out);
    assert.doesNotMatch(fin.out, /is free/);
    assert.match(fin.out, /topic main stays held by p1/);
    const stateFile = path.join(p.dir, 'local', 'threads', 'p1.json');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    assert.ok(!(state.free_point || []).includes('main'), 'main is not recorded in free_point');
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'topics', 'main', 'topic.json'), 'utf8')).state, 'working', 'main stays working');
  } finally { p.cleanup(); }
});

test('count and send address topic main as the persona mailbox, also with --topic main (topic record keeps its kind)', () => {
  const p = persona();
  try {
    assert.equal(p.run('topic.mjs', ['main']).status, 0);
    const count = p.run('comms.mjs', ['count', '--topic', 'main']);
    assert.equal(count.status, 0, count.out);
    assert.ok(p.client.lines().some((l) => /^count --persona bob --thread p1\b/.test(l)), p.client.lines().join('\n'));
    assert.ok(!p.client.lines().some((l) => /^count --project/.test(l)), 'main is not queried as a project topic');
  } finally { p.cleanup(); }
});

test('code topic from a persona session without --project is refused; a discussion topic and --project pass (bob 2026-11-03)', () => {
  const p = persona();
  try {
    // bob/main created code topic t3-workarounds-check in project bob instead of the managed project.
    const r = p.run('topic.mjs', ['create', 'wa-check', '--subject', 'x', '--kind', 'code', '--no-claim']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /persona project bob.*--project/);
    assert.ok(!fs.existsSync(path.join(p.dir, 'topics/wa-check')));
    assert.equal(p.run('topic.mjs', ['create', 'talk', '--subject', 'x', '--no-claim']).status, 0);
    const own = p.run('topic.mjs', ['create', 'own-code', '--subject', 'x', '--kind', 'code', '--no-claim', '--no-copy', '--project', p.dir]);
    assert.equal(own.status, 0, own.out);
  } finally { p.cleanup(); }
});
