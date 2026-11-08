#!/usr/bin/env node
// Thread timer (P-061): work is deferred to a set time, never stopped. The Stop hook sends the timer with the closed turn
// (resume_at); the wake module rings the thread then ("turn ended with a next step, continue from handover") and the
// prompt hook names the step.
//   timer.mjs --in <30m|2h|90s|15> --then "<step to do when it fires>"   set (replaces the previous timer)
//   timer.mjs show                                                       the timer of this thread
//   timer.mjs clear                                                      remove it (the awaited event came)
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { commsSettings } from '../scripts/comms.mjs';
import { parseDelay, setTimer, clearTimer, activeTimer, TIMER_MIN_MS, TIMER_MAX_MS } from '../scripts/waker.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || (args.in !== undefined ? 'set' : 'show');
const out = (s) => process.stdout.write(`${s}\n`);
try {
  const ctx = loadContext({ project: args.project });
  if (!ctx.brainDir || !ctx.thread) fail('timer needs a brain and a stable thread id (thread <id> in the status line)');
  if (cmd === 'set') {
    const ms = parseDelay(args.in);
    if (!ms) fail('usage: timer.mjs --in <30m|2h|90s|15> --then "<step>"');
    const then = args.then === true || args.then === undefined ? '' : String(args.then).trim();
    if (!then) fail('--then "<step to do when the timer fires>" is required: the ring must say what to do');
    if (!commsSettings(ctx).enabled) fail('comms off: no wake module can ring this thread; continue the work now instead of waiting (P-061)');
    const t = setTimer(ctx.brainDir, ctx.thread, { delayMs: ms, then });
    const clamped = ms < TIMER_MIN_MS || ms > TIMER_MAX_MS ? ` (clamped to ${TIMER_MIN_MS / 60_000}m..${TIMER_MAX_MS / 3600_000}h)` : '';
    out(`timer set: ${t.at}${clamped}; then: ${t.then}. The wake module rings this thread then; end the turn with "Stav: čakám (na <what>)" (P-061)`);
  } else if (cmd === 'show') {
    const t = activeTimer(readThreadState(ctx.brainDir, ctx.thread));
    out(t ? `timer: ${t.at}; then: ${t.then}${t.auto ? ' (armed by the Stop hook)' : ''}` : 'no timer');
  } else if (cmd === 'clear') {
    out(clearTimer(ctx.brainDir, ctx.thread) ? 'timer cleared' : 'no timer');
  } else {
    fail('usage: timer.mjs --in <30m|2h> --then "<step>" | show | clear');
  }
} catch (err) {
  fail(err.message);
}
