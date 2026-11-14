// P-061, 2026-11-13: a thread set timer.mjs --in 20m --then <step>, then comms send --level assist armed the 60 min reply
// window; the thread had one timer slot, so one of them was lost unseen (timer.mjs show showed only the mail timer). Every
// timer of the thread stays; timers due together ring in one turn with all their steps; only the rung ones are spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

test('timer.mjs and the reply window of comms send keep both steps; show lists all; due timers ring together (2026-11-13)', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ messages: [], send_id: 'm-a1' }));
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  const file = path.join(fx.brain, 'local', 'threads', 'a1.json');
  const st = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const steps = (s) => [s.timer, ...(s.timers || [])].filter(Boolean).map((t) => t.then);
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    // The case of the report: a 20 min step, then an assist with its 60 min reply window.
    assert.equal(fx.run('timer.mjs', ['--in', '20m', '--then', 'run the deploy step']).status, 0);
    const sent = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project/beta', '--text', 'question']);
    assert.equal(sent.status, 0, sent.out);
    // A later step bound to the clock must not be replaced by the earlier reply window either.
    assert.equal(fx.run('timer.mjs', ['--in', '3h', '--then', 'daily report', '--blind']).status, 0);
    const shown = fx.run('timer.mjs', ['show']);
    assert.equal(shown.status, 0, shown.out);
    assert.match(shown.out, /^1\. timer: .*then: run the deploy step$/m, shown.out);
    assert.match(shown.out, /^2\. timer: .*then: check the reply to m-a1 .*\(reply window of m-a1\)$/m, shown.out);
    assert.match(shown.out, /^3\. timer: .*then: daily report$/m, shown.out);
    assert.equal(st().timer.then, 'run the deploy step', 'the earliest is the next ring (resume_at)');
    // The same step set again moves its timer, no duplicate.
    assert.equal(fx.run('timer.mjs', ['--in', '25m', '--then', 'run the deploy step']).status, 0);
    assert.equal(steps(st()).filter((s) => s === 'run the deploy step').length, 1);
    // The first two come due together: one ring names both steps, both are spent, the later one stays.
    const s = st();
    const past = new Date(Date.now() - 1000).toISOString();
    const all = [s.timer, ...s.timers].map((t) => (t.then === 'daily report' ? t : { ...t, at: past }));
    fs.writeFileSync(file, JSON.stringify({ ...s, timer: all[0], timers: all.slice(1) }));
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'turn ended with a next step, continue from handover' });
    assert.match(r.context, /timer fired .*: (run the deploy step|check the reply to m-a1)/);
    assert.match(r.context, /run the deploy step/);
    assert.match(r.context, /check the reply to m-a1/);
    assert.deepEqual(steps(st()), ['daily report'], 'only the rung timers are spent');
    // clear <n> removes one and prints it.
    assert.equal(fx.run('timer.mjs', ['--in', '10m', '--then', 'check build']).status, 0);
    const cleared = fx.run('timer.mjs', ['clear', '1']);
    assert.match(cleared.out, /timer cleared: .*then: check build/);
    assert.deepEqual(steps(st()), ['daily report']);
  } finally { fx.cleanup(); }
});
