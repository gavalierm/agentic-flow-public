// keep: guarded
// Mail calls of a hook inside its process and at once (operator 2026-11-19: parallel and asynchronous, without a race).
// Before: every call was a process of its own, one after another (a prompt: health 88 ms, obligations 130 ms, turn 90 ms).
// The guards: a queued write in the outbox, a service that does not answer and a call that did not pass make the calls
// run in order; a call inside the process never starts the service (a service that does not answer: the call is a
// process, as before), never runs next to a call past its deadline, and never sees another call's environment.
// A hook run by hand with an empty stdin does nothing (it closed the turn record of a live thread).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { runClientsAsync, runClientAsync, recordTurn } from '../scripts/comms.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

/**
 * A mail client of the real layout: bin/comms.mjs (a spawn is a line in spawned.log) and src/client/cli.mjs with `main`,
 * which records each call in globalThis.fakeMail (argv, the thread of its environment, when it began and ended) and
 * answers what `answer(call)` gives: `{ code, out, err }`.
 */
function fakeMail(answer = () => ({ code: 0, out: { ok: true } })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mail-'));
  const brain = path.join(root, 'brain');
  const spawned = path.join(root, 'spawned.log');
  fs.mkdirSync(path.join(root, 'client', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client', 'src', 'client'), { recursive: true });
  fs.mkdirSync(path.join(brain, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'bin', 'comms.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(spawned)}, process.argv.slice(2).join(' ') + '\\n'); process.stdout.write('{"ok":true,"model":3}');\n`);
  fs.writeFileSync(path.join(root, 'client', 'src', 'client', 'cli.mjs'), `export async function main(argv, { stdout, stderr }) {
  const g = globalThis.fakeMail;
  const call = { cmd: argv[0], argv, thread: process.env.COMMS_THREAD_ID, began: g.tick++ };
  g.calls.push(call);
  await new Promise((r) => setTimeout(r, 15));
  call.ended = g.tick++;
  const a = g.answer(call);
  if (a.out) stdout.write(JSON.stringify(a.out));
  if (a.err) stderr.write(JSON.stringify(a.err));
  return a.code;
}\n`);
  const mail = { tick: 0, calls: [], answer: (call) => (call.cmd === 'health' ? { code: 0, out: { ok: true, model: 3 } } : answer(call)) };
  globalThis.fakeMail = mail;
  const ctx = { projectDir: process.cwd(), brainDir: brain, thread: 't-own', policy: {}, config: { comms: { client: path.join(root, 'client', 'bin', 'comms.mjs') } } };
  const made = (cmd) => mail.calls.filter((c) => c.cmd === cmd);
  return { root, brain, ctx, mail, made, spawned: () => (fs.existsSync(spawned) ? fs.readFileSync(spawned, 'utf8') : '') };
}

const PAIR = [{ args: ['obligations'], thread: 't-one' }, { args: ['turn', '--state', 'open'], thread: 't-two', timeoutMs: 1000 }];
const overlap = (a, b) => a.began < b.ended && b.began < a.ended;

test('two calls run inside the process, at once, each with its own thread, and never start the service', async () => {
  const fx = fakeMail((call) => ({ code: 0, out: { ok: true, cmd: call.cmd } }));
  const before = process.env.COMMS_THREAD_ID;
  const res = await runClientsAsync(fx.ctx, PAIR);
  assert.deepEqual(res.map((r) => [r.ok, r.data.cmd]), [[true, 'obligations'], [true, 'turn']], 'results in the order of the calls');
  const [ob] = fx.made('obligations');
  const [turn] = fx.made('turn');
  assert.ok(overlap(ob, turn), 'the calls ran at once');
  assert.ok(ob.argv.includes('--no-start') && turn.argv.includes('--no-start'), 'calls made together never start the service');
  assert.deepEqual([ob.thread, turn.thread], ['t-one', 't-two'], 'each call saw its own thread in the environment');
  assert.equal(process.env.COMMS_THREAD_ID, before, 'the environment of the hook is as before');
  assert.equal(fx.made('health').length, 1, 'one model check for both');
  assert.equal(fx.spawned(), '', 'no client process');
});

test('a queued write in the outbox: the calls run in order (each sends the outbox first)', async () => {
  const fx = fakeMail();
  fs.mkdirSync(path.join(fx.brain, 'local', 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, 'local', 'outbox', '1.json'), '{}');
  await runClientsAsync(fx.ctx, PAIR);
  const [ob] = fx.made('obligations');
  const [turn] = fx.made('turn');
  assert.ok(ob.ended < turn.began, 'one after another, in order');
});

test('a call made together that did not pass: all are made again in order', async () => {
  let round = 0;
  const fx = fakeMail((call) => {
    if (call.cmd === 'obligations') round += 1;
    // First round: the service went away after the model check (the client's backup, offline).
    return call.cmd === 'obligations' && round === 1 ? { code: 0, out: { offline: true, unavailable: true, cached: true } } : { code: 0, out: { ok: true, round } };
  });
  const res = await runClientsAsync(fx.ctx, PAIR);
  assert.equal(fx.made('obligations').length, 2);
  assert.equal(fx.made('turn').length, 2);
  const again = [fx.made('obligations')[1], fx.made('turn')[1]];
  assert.ok(again[0].ended < again[1].began, 'the second round runs in order');
  assert.deepEqual(res.map((r) => r.data.round), [2, 2], 'the answers of the second round');
});

test('a service that does not answer: every call is a process, in order (only a process may start the service)', async () => {
  const fx = fakeMail();
  fx.mail.answer = (call) => (call.cmd === 'health' ? { code: 2, err: { error: 'comms unavailable', code: 'UNAVAILABLE' } } : { code: 0, out: { ok: true } });
  const res = await runClientsAsync(fx.ctx, PAIR);
  assert.deepEqual(res.map((r) => r.ok), [true, true]);
  assert.equal(fx.made('health').length, 1, 'asked once in this process');
  assert.equal(fx.made('obligations').length + fx.made('turn').length, 0, 'no call inside the process');
  const lines = fx.spawned().trim().split('\n').filter((l) => !l.startsWith('health'));
  assert.match(lines[0], /^obligations/);
  assert.match(lines[1], /^turn --state open/);
  assert.ok(lines.every((l) => !l.includes('--no-start')), 'a process may start the service');
});

test('a call with stdin and WORKFLOW_COMMS_SPAWN=1 are processes', async () => {
  const fx = fakeMail();
  const piped = await runClientAsync(fx.ctx, ['send', '-'], { input: 'text' });
  assert.equal(piped.ok, true);
  assert.match(fx.spawned(), /^send -/m, 'a call with stdin is a process');
  process.env.WORKFLOW_COMMS_SPAWN = '1';
  try { await recordTurn(fx.ctx, 'open', []); } finally { delete process.env.WORKFLOW_COMMS_SPAWN; }
  assert.match(fx.spawned(), /^turn --state open/m, 'WORKFLOW_COMMS_SPAWN=1: a process');
  assert.equal(fx.made('turn').length, 0);
});

// Last of the calls inside this process: the call that hangs stays "past its deadline" for the whole test process.
test('a call that does not end in time is "comms unavailable" and no other call is made next to it', async () => {
  const slow = fakeMail();
  globalThis.slowCalls = [];
  fs.writeFileSync(path.join(slow.root, 'client', 'src', 'client', 'cli.mjs'), 'export const main = (argv) => { globalThis.slowCalls.push(argv[0]); return argv[0] === \'health\' ? Promise.resolve(1) : new Promise(() => {}); };\n');
  const t0 = Date.now();
  // The deadline of a call: timeoutMs + 1500 ms.
  const late = await runClientAsync(slow.ctx, ['obligations'], { timeoutMs: 1 });
  assert.equal(late.unavailable, true);
  assert.match(late.error, /timed out/);
  assert.ok(Date.now() - t0 < 4000);
  const next = await recordTurn(slow.ctx, 'open', []);
  assert.equal(next.unavailable, true);
  assert.deepEqual(globalThis.slowCalls, ['health', 'obligations'], 'no call inside the process next to the one past its deadline');
  assert.equal(slow.spawned(), '', 'and none as a process');
});

test('a hook run with an empty stdin does nothing: no mail call, no thread state, no output', () => {
  const fx = setup();
  const log = path.join(fx.root, 'stub-log.jsonl');
  const env = { ...fx.env, CLAUDE_PROJECT_DIR: fx.project, WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_LOG: log, STUB_COMMS_STATE: path.join(fx.root, 'stub-state.json') };
  for (const hook of ['user-prompt-submit', 'stop', 'post-tool-use', 'pre-tool-use']) {
    const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', `${hook}.mjs`)], { cwd: fx.project, env, encoding: 'utf8', input: '' });
    assert.equal(res.status, 0, hook);
    assert.equal(res.stdout, '', hook);
  }
  assert.equal(fs.existsSync(log), false, 'no call of the mail client');
  assert.equal(fs.existsSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`)), false, 'no thread state written');
});
