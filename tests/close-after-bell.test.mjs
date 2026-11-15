// ttl: 2026-12-15
// Topic close-after-bell (observed 2026-11-15, topic worker-named-tests): done --topic was refused in a turn a message started
// (P-047), the thread saved the step to its handover and the turn ended; no turn came to run it, the topic stood until the
// operator stepped in. A step P-047 refuses arms a thread timer in 1 min: the closed turn carries resume_at, wake rings
// "continue from handover", and in that turn the step runs. A topic thread with an orchestrator never ends waiting on nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { setTimer } from '../scripts/waker.mjs';

const stateOf = (fx, thread = 'a1') => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${thread}.json`), 'utf8'));
const WAKE = 'you have mail in topic d';
const CONTINUE = 'turn ended with a next step, continue from handover';

test('done --topic refused in a bell turn arms the continuation in 1 min; the turn from it closes the topic', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: WAKE });
    assert.equal(stateOf(fx).turn_source, 'wake');
    const before = Date.now();
    let r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /P-047/);
    assert.match(r.stderr, /continuation is set in 1 min/);
    assert.ok(fx.exists('topics/d/topic.json'), 'the lock stays: nothing closed in the bell turn');
    const timers = [stateOf(fx).timer, ...(stateOf(fx).timers || [])].filter(Boolean);
    const t = timers.find((x) => /^done\.mjs --topic /.test(x.then));
    assert.ok(t, JSON.stringify(timers));
    assert.match(t.then, /--verified "tests pass".*\(odmietnutý v ťahu zo zvončeka, P-047\)$/);
    const due = Date.parse(t.at) - before;
    assert.ok(due >= 55_000 && due <= 70_000, `timer in ${due} ms`);
    // the turn ends waiting for the continuation: no block, the closed turn carries resume_at and the step
    r = fx.hook('stop.mjs', { last_assistant_message: 'Uzavretie odmietnuté v ťahu zo správy.\n\n**Stav:** čakám (na pokračovanie z handoveru)' });
    assert.notEqual(r.json.decision, 'block', JSON.stringify(r.json));
    assert.equal(stateOf(fx).last_close.resume_at, t.at);
    assert.equal(stateOf(fx).last_close.next, t.then);
    // the ring of wake: P-047 does not lock this turn, done passes
    fx.hook('user-prompt-submit.mjs', { prompt: CONTINUE });
    assert.notEqual(stateOf(fx).turn_source, 'wake');
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('topics/archive/d/topic.json'));
  } finally { fx.cleanup(); }
});

test('topic claim refused in a bell turn arms the continuation too', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: WAKE });
    const r = fx.run('topic.mjs', ['claim', 'd', '--force']);
    assert.equal(r.status === 0, false);
    assert.match(r.out, /P-047.*continuation is set in 1 min/);
    const timers = [stateOf(fx).timer, ...(stateOf(fx).timers || [])].filter(Boolean);
    assert.ok(timers.some((x) => /^topic\.mjs claim d --force \(odmietnutý v ťahu zo zvončeka, P-047\)$/.test(x.then)), JSON.stringify(timers));
  } finally { fx.cleanup(); }
});

test('a topic thread with an orchestrator ending "čakám" with no timer and no awaited reply is blocked once', () => {
  const fx = setup();
  try {
    const o1 = { env: { WORKFLOW_THREAD_ID: 'o1' } };
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion'], o1).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'w', '--subject', 'W', '--class', 'discussion', '--task', 'práca w', '--for-thread', 'a1'], o1).status, 0);
    // a step that only waits got the idle ring in hours, and the thread rested (old code)
    assert.equal(fx.run('save.mjs', ['handover', 'w', '--task', 'práca w', '--done', 'x', '--next', 'čakať na odpoveď orchestrátora']).status, 0);
    const msg = 'Práca hotová.\n\n**Stav:** čakám (na odpoveď orchestrátora)';
    let r = fx.hook('stop.mjs', { last_assistant_message: msg });
    assert.equal(r.json.decision, 'block', JSON.stringify(r.json));
    assert.match(r.json.reason, /orchestrator orch waits for/);
    assert.match(r.json.reason, /comms send --to orch/);
    assert.match(r.json.reason, /timer\.mjs --in/);
    // once: ending so anyway passes
    r = fx.hook('stop.mjs', { last_assistant_message: msg, stop_hook_active: true });
    assert.notEqual(r.json.decision, 'block');
    // with a timer armed it passes at once
    setTimer(fx.brain, 'a1', { delayMs: 10 * 60_000, then: 'skontrolovať odpoveď' });
    r = fx.hook('stop.mjs', { last_assistant_message: msg });
    assert.notEqual(r.json.decision, 'block', JSON.stringify(r.json));
  } finally { fx.cleanup(); }
});
