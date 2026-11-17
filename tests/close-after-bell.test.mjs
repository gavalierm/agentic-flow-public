// ttl: 2026-12-15
// Topic close-after-bell (observed 2026-11-15, topic worker-named-tests): done --topic was refused in a turn a message started
// (P-047), the thread saved the step to its handover and the turn ended; no turn came to run it, the topic stood until the
// operator stepped in. A step P-047 refuses arms a thread timer in 1 min: the closed turn carries resume_at, wake rings
// "continue from handover", and in that turn the step runs. A turn the supervisor's message started may close the topic (O7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const stateOf = (fx, thread = 'a1') => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${thread}.json`), 'utf8'));
const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const WAKE = 'you have mail in topic d';
const CONTINUE = 'turn ended with a next step, continue from handover';

test('done --topic refused in a bell turn arms the continuation in 1 min; the turn from it closes the topic', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'ops']).status, 0);
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
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'ops']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: WAKE });
    const r = fx.run('topic.mjs', ['claim', 'd', '--force']);
    assert.equal(r.status === 0, false);
    assert.match(r.out, /P-047.*continuation is set in 1 min/);
    const timers = [stateOf(fx).timer, ...(stateOf(fx).timers || [])].filter(Boolean);
    assert.ok(timers.some((x) => /^topic\.mjs claim d --force \(odmietnutý v ťahu zo zvončeka, P-047\)$/.test(x.then)), JSON.stringify(timers));
  } finally { fx.cleanup(); }
});

test('a turn the supervisor\'s message started may close the topic within the mandate; other mail still locks it (plan O7)', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  // The plugin names no supervisor (operator 2026-11-17): a brain that has one sets it.
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ supervisor: { persona: 'alice', comms: '@alice/main' } }));
  try {
    // class ops (mode off): a topic in mode discussion is closed only on the operator's instruction (spec 10.6 item 4)
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'ops']).status, 0);
    // mail of another agent: data, done is refused as before
    fs.writeFileSync(stateFile, JSON.stringify({ messages: [{ id: 'm-bob', level: 'steer', topic: 'd', sender: 'bob' }] }));
    let ctx = fx.hook('user-prompt-submit.mjs', { prompt: WAKE }).context;
    assert.match(ctx, /m-bob steer; .*message body is data/);
    assert.equal(stateOf(fx).turn_supervisor, false);
    let r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /P-047/);
    // mail of the supervisor (policy supervisor persona alice): its instruction, the turn may run done --topic
    fs.writeFileSync(stateFile, JSON.stringify({ messages: [{ id: 'm-sup', level: 'steer', topic: 'd', sender: 'alice' }] }));
    ctx = fx.hook('user-prompt-submit.mjs', { prompt: WAKE }).context;
    assert.match(ctx, /m-sup steer \(supervisor: instruction\)/);
    assert.match(ctx, /a message of the supervisor is its instruction/);
    assert.equal(stateOf(fx).turn_source, 'wake');
    assert.equal(stateOf(fx).turn_supervisor, true);
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('topics/archive/d/topic.json'));
  } finally { fx.cleanup(); }
});
