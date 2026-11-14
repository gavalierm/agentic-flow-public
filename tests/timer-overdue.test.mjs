// P-061: a timer that came due while the turn ran rings right after the turn closes, not with the next new timer (pilot
// nudge-why 2026-11-14: timers of 02:21, 07:53 and 08:37 rang only at 11:51).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { setTimer, validWaker } from '../scripts/waker.mjs';

test('a timer due during the turn travels with the closed turn (resume_at) and counts as its waker', () => {
  const fx = setup();
  const file = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
  const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']);
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    for (const [min, then] of [[5, 'check topic x'], [7, 'check topic y']]) setTimer(fx.brain, fx.thread, { delayMs: min * 60_000, then, until: 'true', deadline: new Date(Date.now() + 3600_000).toISOString() });
    // The turn ran past both times (wake does not ring a running thread).
    const st = state();
    const past = (m) => new Date(Date.now() - m * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...st, timer: { ...st.timer, at: past(20) }, timers: st.timers.map((t) => ({ ...t, at: past(10) })) }));
    assert.ok(validWaker(state()), 'a due timer is a waker: it rings when the turn closes');
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Čakám na témy.\n\n**Handover:**\n1. alpha → check topic x\n\n**Stav:** čakám (na témy x a y)' });
    assert.equal(r.json.decision, undefined, r.json.reason);
    assert.deepEqual(state().last_close, { next: 'check topic x', resume_at: state().timer.at }, 'the closed turn carries the due timer');
    assert.ok(Date.parse(state().last_close.resume_at) < Date.now(), 'wake clamps a past resume_at to now and rings at once');
  } finally { fx.cleanup(); }
});
