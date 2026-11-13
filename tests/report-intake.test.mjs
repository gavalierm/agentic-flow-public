// 3b maintainer side (D-0022, D-0024): report-intake.mjs, run by cron as code without a thread id (D-0019), gives a report
// held in `report-<fp>` of its project a topic (class code, no copy, its own T3 thread holds it) and delivers it. Only
// held, unexpired messages; other notices stay with the operator; a failed thread start is retried the next minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, fakeT3, TOPIC } from './fixtures/intake-fx.mjs';

test('intake: a held report gets its code topic, a thread that holds it, and is delivered; the next run does nothing', () => {
  const fx = fixture();
  try {
    const t3 = fakeT3(fx);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`${TOPIC}: message m-1 delivered to thread mcp:launch:rt1 \\(created\\)`));
    const topic = JSON.parse(fx.read(`topics/${TOPIC}/topic.json`));
    assert.equal(topic.class, 'code');
    assert.equal(topic.kind, 'code');
    assert.equal(topic.created_by, undefined, 'code without a thread id creates the topic');
    assert.equal(JSON.parse(fx.read(`topics/${TOPIC}/holder.json`)).thread, 'mcp:launch:rt1');
    assert.ok(!fs.existsSync(path.join(fx.root, 'project-topics', TOPIC)), 'no code copy (copy: false)');
    const [call] = t3.calls();
    assert.deepEqual(call.argv.slice(0, 2), ['--title', TOPIC]);
    assert.match(call.input, /čaká v pošte témy project\/report-0123abcd/);
    assert.ok(!call.input.includes('tajný obsah'), 'the thread task carries no text of the report');
    const decides = fx.calls().filter((c) => c[0] === 'decide');
    assert.deepEqual(decides.map((c) => c.slice(0, 5)), [['decide', '--notice', 'n-1', '--decision', 'deliver']]);
    assert.ok(!fx.calls().some((c) => c[0] === 'message' && c[2] !== 'm-1'), 'other notices are not looked at');
    assert.ok(!fx.calls().some((c) => c.includes('--thread')), 'the mail client acts without a thread');
    assert.match(fx.log(), /report-0123abcd: message m-1 delivered/);
    // Second minute: nothing open for us any more.
    const again = fx.intake();
    assert.equal(again.status, 0, again.out);
    assert.equal(fx.calls().filter((c) => c[0] === 'decide').length, 1);
    assert.equal(t3.calls().length, 1);
  } finally { fx.cleanup(); }
});

test('intake ignores an inherited thread id (cron started from an agent shell)', () => {
  const fx = fixture();
  try {
    fakeT3(fx);
    const r = fx.intake({ WORKFLOW_THREAD_ID: 'a1', T3CODE_THREAD_ID: 't9' });
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.read(`topics/${TOPIC}/holder.json`)).thread, 'mcp:launch:rt1', 'the new thread holds it, not the caller');
    assert.ok(!fx.calls().some((c) => c.includes('--thread')));
  } finally { fx.cleanup(); }
});

test('intake: a failed thread start leaves the topic free and the message held; the next run starts the thread', () => {
  const fx = fixture();
  try {
    const t3 = fakeT3(fx);
    t3.fail(true);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /stays held, next run tries again/);
    assert.ok(fx.exists(`topics/${TOPIC}/topic.json`), 'the topic exists');
    assert.equal(JSON.parse(fx.exists(`topics/${TOPIC}/holder.json`) ? fx.read(`topics/${TOPIC}/holder.json`) : '{}').thread || null, null, 'nobody holds it');
    assert.ok(!fx.calls().some((c) => c[0] === 'decide'), 'not delivered');
    t3.fail(false);
    const again = fx.intake();
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /message m-1 delivered to thread mcp:launch:rt1 \(thread\)/);
    assert.equal(JSON.parse(fx.read(`topics/${TOPIC}/holder.json`)).thread, 'mcp:launch:rt1');
    assert.equal(fx.calls().filter((c) => c[0] === 'decide').length, 1);
  } finally { fx.cleanup(); }
});

test('intake skips an expired message (once in the log) and never touches it', () => {
  for (const opts of [{ expires: '2020-01-01T00:00:00.000Z' }, { outcome: 'expired' }]) {
    const fx = fixture(opts);
    try {
      const t3 = fakeT3(fx);
      const r = fx.intake();
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /message m-1 skipped/);
      assert.ok(!fx.exists(`topics/${TOPIC}/topic.json`), 'no topic for an expired report');
      assert.equal(t3.calls().length, 0);
      assert.ok(!fx.calls().some((c) => c[0] === 'decide'));
      fx.intake();
      assert.equal((fx.log().match(/skipped/g) || []).length, 1, 'logged once, not every minute');
    } finally { fx.cleanup(); }
  }
});

test('intake: a failed deliver leaves the topic ready and retries; the held topic is registered again', () => {
  const fx = fixture();
  try {
    fakeT3(fx);
    const st = fx.state();
    fs.writeFileSync(fx.env.STUB_COMMS_STATE, JSON.stringify({ ...st, decide_fail: true }));
    const r = fx.intake();
    assert.match(r.stdout, /deliver of m-1 failed/);
    fs.writeFileSync(fx.env.STUB_COMMS_STATE, JSON.stringify({ ...fx.state(), decide_fail: false }));
    const again = fx.intake();
    assert.match(again.stdout, /message m-1 delivered to thread mcp:launch:rt1 \(held\)/);
    assert.ok(fx.calls().filter((c) => c[0] === 'register-topic' && c.includes(TOPIC)).length >= 2);
  } finally { fx.cleanup(); }
});
