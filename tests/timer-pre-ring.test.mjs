// ttl: 2026-12-14
// A timer with a condition is checked before its ring (wake job timer-check, preRing in scripts/waker.mjs): a condition that
// does not hold moves the timer without a prompt to the thread (the prompt hook blocked such a bell, T3 showed an error and
// the next message started a fresh session, maintainer/workflow-dev 2026-11-14); nudge-why names a prompt the hook blocked in the
// thread's previous session. (Timers bound to a topic, timer.mjs --topic, are removed: flow v2 plan O6.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { setTimer, preRing, threadTimers, registerTimerThread, resumeAtFor, timersPatch, clearTimer, TIMER_CHECK_LEAD_MS } from '../scripts/waker.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';
import { readTranscript, diagnose } from '../scripts/nudge-why.mjs';

const CONTINUE = 'turn ended with a next step, continue from handover';
const closedThread = (fx, thread, extra = {}) => {
  const ago = new Date(Date.now() - 3600_000).toISOString();
  writeThreadState(fx.brain, thread, { ...readThreadState(fx.brain, thread), turn_started_at: new Date(Date.now() - 2 * 3600_000).toISOString(), last_end_at: ago, last_end_state: 'čakám', ...extra });
};

test('a condition that does not hold moves the timer before the ring, no prompt to the thread', () => {
  const fx = setup();
  try {
    closedThread(fx, fx.thread);
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'check the result', until: 'false', deadline: new Date(Date.now() + 6 * 3600_000).toISOString(), everyMs: 30 * 60_000 });
    const r = preRing(fx.brain, fx.thread, { cwd: fx.project });
    assert.equal(r.action, 'rearm');
    assert.ok(Date.parse(r.resume.at) > Date.now() + 20 * 60_000, 'resume_at moved to the next check');
    assert.equal(threadTimers(readThreadState(fx.brain, fx.thread)).length, 1);
    // The wake job over the index: it reports the move; the timer is no longer due, so no bell is prepared for it.
    const index = path.join(fx.root, 'timer-index.json');
    registerTimerThread({ brainDir: fx.brain, projectDir: fx.project, thread: fx.thread }, { WORKFLOW_TIMER_INDEX: index });
    const st = readThreadState(fx.brain, fx.thread);
    writeThreadState(fx.brain, fx.thread, { ...st, timer: { ...st.timer, at: new Date(Date.now() + 60_000).toISOString() } });
    const job = fx.run('timer-check.mjs', [], { env: { WORKFLOW_TIMER_INDEX: index } });
    assert.equal(job.status, 0, job.out);
    assert.match(job.out, /condition does not hold \(false\), timer moved/);
    assert.ok(Date.parse(readThreadState(fx.brain, fx.thread).last_close.resume_at) > Date.now() + 20 * 60_000);
    // Two conditional timers due together: the job moves both, resume_at keeps the lead of the check.
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'second check', until: 'false', deadline: new Date(Date.now() + 6 * 3600_000).toISOString() });
    const st2 = readThreadState(fx.brain, fx.thread);
    writeThreadState(fx.brain, fx.thread, { ...st2, ...timersPatch(threadTimers(st2).map((t) => ({ ...t, at: new Date(Date.now() + 30_000).toISOString() }))) });
    const job2 = fx.run('timer-check.mjs', [], { env: { WORKFLOW_TIMER_INDEX: index } });
    assert.equal((job2.out.match(/timer moved/g) || []).length, 2, job2.out);
    assert.ok(threadTimers(readThreadState(fx.brain, fx.thread)).every((t) => Date.parse(t.at) > Date.now() + 50_000));
    assert.ok(Date.parse(readThreadState(fx.brain, fx.thread).last_close.resume_at) >= Date.now() + TIMER_CHECK_LEAD_MS - 5000);
    // Stop sends a conditional timer due right away no sooner than the lead of the check (the job runs before the ring).
    const now = Date.now();
    assert.equal(resumeAtFor({ at: new Date(now + 10_000).toISOString(), until: 'false' }, now), new Date(now + TIMER_CHECK_LEAD_MS).toISOString());
    assert.equal(resumeAtFor({ at: new Date(now + 10_000).toISOString() }, now), new Date(now + 10_000).toISOString());
    // The job runs the check with the thread's project, not one the wake process inherited.
    clearTimer(fx.brain, fx.thread);
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'project check', until: `[ "$WORKFLOW_PROJECT_DIR" = "${fx.project}" ]`, deadline: new Date(Date.now() + 6 * 3600_000).toISOString() });
    const job3 = fx.run('timer-check.mjs', [], { env: { WORKFLOW_TIMER_INDEX: index, WORKFLOW_PROJECT_DIR: fx.root } });
    assert.equal(job3.status, 0, job3.out);
    assert.doesNotMatch(job3.out, /timer moved/);
    // A condition that holds: the bell goes as it is.
    clearTimer(fx.brain, fx.thread);
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'other step', until: 'true', deadline: new Date(Date.now() + 6 * 3600_000).toISOString() });
    assert.equal(preRing(fx.brain, fx.thread, { cwd: fx.project }).action, 'ring');
  } finally { fx.cleanup(); }
});

test('nudge-why names a prompt the hook blocked in the previous session', () => {
  const fx = setup();
  try {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const file = path.join(fx.root, 'prev.jsonl');
    const reason = 'timer: its condition does not hold yet (topic.mjs closed other); next check 22:34';
    fs.writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'informational', content: `UserPromptSubmit operation blocked by hook:\n${reason}\n\nOriginal prompt: ${CONTINUE}`, timestamp: at, promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason } } })}\n`);
    const res = diagnose({ thread: fx.thread, prevTranscript: readTranscript(file), transcript: { calls: [], prompts: [{ at: new Date().toISOString(), text: 'up' }], blocked: [], text: '' } });
    const cause = res.causes.find((c) => c.kind === 'blocked-prompt');
    assert.ok(cause, JSON.stringify(res.causes));
    assert.ok(cause.workflow);
    assert.match(cause.text, /continue from handover.*condition does not hold/);
    assert.ok(!res.causes.some((c) => c.kind === 'unknown'));
  } finally { fx.cleanup(); }
});
