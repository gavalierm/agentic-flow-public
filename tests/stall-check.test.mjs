// ttl: 2026-12-15
// agent-alice/D-0084: a handed-off topic could stand (its thread had no turn, nothing waited, nothing wrote) and the giver did
// not know. A handoff record arms in the giver's thread a stall check (a timer with the condition `topic.mjs stalled <id>`,
// every topics.stall_check_minutes, default 5, one per topic, no deadline); it rings once per stall with the topic's last
// next step, and drops itself once the topic is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startComms, commsClient } from './helpers.mjs';
import { setTimer, preRing, threadTimers, STALL_CHECK_MS } from '../scripts/waker.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';

const skipMail = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
const t2 = { env: { WORKFLOW_THREAD_ID: 't2' } };
const later = (min) => new Date(Date.now() + min * 60_000).toISOString();
const stallTimers = (fx) => threadTimers(readThreadState(fx.brain, fx.thread)).filter((t) => t.stall);
const closedTurn = (fx, thread, endedMinAgo, extra = {}) => writeThreadState(fx.brain, thread, {
  ...readThreadState(fx.brain, thread),
  turn_started_at: new Date(Date.now() - (endedMinAgo + 1) * 60_000).toISOString(),
  last_end_at: new Date(Date.now() - endedMinAgo * 60_000).toISOString(),
  last_end_state: 'hotovo',
  last_close: { next: 'dokončiť migráciu Beta', resume_at: null },
  ...extra,
});
const handedOff = (fx = setup()) => {
  assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
  const r = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta', '--for-thread', 't2']);
  assert.equal(r.status, 0, r.out);
  return fx;
};
const stalled = (fx, now) => fx.run('topic.mjs', ['stalled', 'domain-migrate', '--now', now]);

test('a handoff arms the stall check in the giver thread: every 5 min, no deadline, one per topic', () => {
  const fx = handedOff();
  try {
    let list = stallTimers(fx);
    assert.equal(list.length, 1, JSON.stringify(readThreadState(fx.brain, fx.thread)));
    assert.equal(list[0].stall, 'domain-migrate');
    assert.match(list[0].until, /topic\.mjs" stalled domain-migrate$/);
    assert.equal(list[0].every_ms, STALL_CHECK_MS);
    assert.equal(list[0].deadline, null);
    assert.ok(Math.abs(Date.parse(list[0].at) - Date.now() - STALL_CHECK_MS) < 60_000);
    // another topic gets its own check; a new handoff of the same topic replaces its check
    assert.equal(fx.run('topic.mjs', ['create', 'invoices', '--subject', 'Faktúry', '--class', 'discussion', '--no-claim']).status, 0);
    assert.equal(stallTimers(fx).length, 2);
    assert.equal(fx.run('topic.mjs', ['thread', 'invoices', '--task', 'tlač faktúr', '--for-thread', 't3']).status, 0);
    list = stallTimers(fx);
    assert.deepEqual(list.map((t) => t.stall).sort(), ['domain-migrate', 'invoices']);
    // timer.mjs show names it
    assert.match(fx.run('timer.mjs', ['show']).out, /stall check of topic domain-migrate/);
  } finally { fx.cleanup(); }
});

test('topic.mjs stalled: 0 for a standing topic, 1 for a running turn, a timer, a continuation, a closed topic', () => {
  const fx = handedOff();
  try {
    closedTurn(fx, 't2', 10);
    let r = stalled(fx, later(10));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /stands since .*next: dokončiť migráciu Beta/);
    // the last turn ended under 5 min ago
    assert.equal(stalled(fx, new Date(Date.now() - 6 * 60_000).toISOString()).status, 1);
    // a running turn
    writeThreadState(fx.brain, 't2', { ...readThreadState(fx.brain, 't2'), turn_started_at: new Date().toISOString() });
    r = stalled(fx, later(10));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /turn running/);
    // a timer ahead
    closedTurn(fx, 't2', 10);
    setTimer(fx.brain, 't2', { delayMs: 60 * 60_000, then: 'pozrieť výsledok' });
    r = stalled(fx, later(10));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /timer set/);
    // a continuation (resume_at ahead)
    writeThreadState(fx.brain, 't2', { ...readThreadState(fx.brain, 't2'), timer: undefined, timers: undefined });
    closedTurn(fx, 't2', 10, { last_close: { next: 'x', resume_at: later(60) } });
    assert.equal(stalled(fx, later(10)).status, 1);
    // closed
    closedTurn(fx, 't2', 10);
    assert.equal(stalled(fx, later(10)).status, 0);
    const d = fx.run('done.mjs', ['--topic', '--topic-id', 'domain-migrate', '--knowledge', 'nic nové', '--verified', 'hotové'], t2);
    assert.equal(d.status, 0, d.out);
    r = stalled(fx, later(10));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /closed/);
  } finally { fx.cleanup(); }
});

test('topic.mjs stalled: 1 while mail waits for the topic', { skip: skipMail }, async () => {
  const fx = setup();
  const comms = await startComms(fx);
  try {
    // the topics are created with the mail running (create registers them, unregistered mail is held)
    handedOff(fx);
    closedTurn(fx, 't2', 10);
    assert.equal(stalled(fx, later(10)).status, 0);
    const s = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'domain-migrate', '--text', 'ako to ide?']);
    assert.equal(s.status, 0, s.out);
    // the holder's state is unchanged, only the mail differs
    const r = stalled(fx, later(10));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /mail waits/);
  } finally { await comms.stop(); fx.cleanup(); }
});

// Mail model 2 (P-072): a topic that sent a question waits for the answer through the mail's wait (awaiting with
// wait_due_at), not a timer of its thread; it does not stand.
test('topic.mjs stalled: 1 while the mail waits for an answer to mail the topic sent', { skip: skipMail }, async () => {
  const fx = setup();
  const comms = await startComms(fx);
  try {
    handedOff(fx);
    closedTurn(fx, 't2', 10);
    assert.equal(stalled(fx, later(10)).status, 0);
    const s = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project/orch', '--from', 'domain-migrate', '--text', 'ktorá doména ďalej?'], t2);
    assert.equal(s.status, 0, s.out);
    assert.deepEqual(threadTimers(readThreadState(fx.brain, 't2')), [], 'no timer of the thread for the answer');
    const r = stalled(fx, later(10));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /waits for a reply/);
  } finally { await comms.stop(); fx.cleanup(); }
});

test('the stall check rings once per stall with the next step, again after a new turn, and drops once the topic is closed', () => {
  const fx = handedOff();
  try {
    closedTurn(fx, 't2', 10);
    closedTurn(fx, fx.thread, 30, { last_end_state: 'čakám' });
    const due = Date.now() + STALL_CHECK_MS + 1000;
    const met = () => true;
    let r = preRing(fx.brain, fx.thread, { now: due, cwd: fx.project, run: met });
    assert.equal(r.action, 'stall', JSON.stringify(r));
    assert.match(r.timer.then, /^téma domain-migrate stojí od .+: dokončiť migráciu Beta; zisti prečo a pohni ju/);
    assert.equal(r.resume.at, new Date(due).toISOString());
    let st = readThreadState(fx.brain, fx.thread);
    assert.equal(threadTimers(st).filter((t) => t.stall).length, 1, 'the check stays armed');
    assert.ok(threadTimers(st).some((t) => t.then === r.timer.then && !t.until), 'a plain timer with the step rings');
    // the same stall: no second ring
    writeThreadState(fx.brain, fx.thread, { ...st, timer: undefined, timers: undefined });
    assert.equal(fx.run('timer.mjs', ['show']).out.trim(), 'no timer');
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'kontrola', until: 'true', deadline: null, everyMs: STALL_CHECK_MS, stall: 'domain-migrate' });
    r = preRing(fx.brain, fx.thread, { now: Date.now() + 61_000, cwd: fx.project, run: met });
    assert.equal(r.action, 'rearm', JSON.stringify(r));
    // a new turn of the topic, standing again: it rings again
    closedTurn(fx, 't2', 7);
    st = readThreadState(fx.brain, fx.thread);
    r = preRing(fx.brain, fx.thread, { now: Date.parse(stallTimers(fx)[0].at), cwd: fx.project, run: met });
    assert.equal(r.action, 'stall', JSON.stringify(r));
    // a check that does not hold moves the timer, no deadline ends it
    writeThreadState(fx.brain, fx.thread, { ...readThreadState(fx.brain, fx.thread), timer: undefined, timers: undefined });
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'kontrola', until: 'false', deadline: null, everyMs: STALL_CHECK_MS, stall: 'domain-migrate' });
    r = preRing(fx.brain, fx.thread, { now: Date.now() + 30 * 3600_000, cwd: fx.project, run: () => false });
    assert.equal(r.action, 'rearm', JSON.stringify(r));
    // closed: dropped without a ring
    assert.equal(fx.run('done.mjs', ['--topic', '--topic-id', 'domain-migrate', '--knowledge', 'nic nové', '--verified', 'hotové'], t2).status, 0);
    r = preRing(fx.brain, fx.thread, { now: Date.parse(stallTimers(fx)[0].at), cwd: fx.project, run: met });
    assert.equal(r.action, 'drop', JSON.stringify(r));
    assert.equal(stallTimers(fx).length, 0);
  } finally { fx.cleanup(); }
});
