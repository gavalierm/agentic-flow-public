#!/usr/bin/env node
// Thread timer (P-061): work is deferred to a set time, never stopped. The Stop hook sends the timer with the closed turn
// (resume_at); the wake module rings the thread then ("turn ended with a next step, continue from handover") and the
// prompt hook names the step.
//   timer.mjs --in <30m|2h|90s|15> --then "<step to do when it fires>"   set (replaces the previous timer)
//   timer.mjs --in 5m --until "<check>" --deadline 2h --then "<step>"     a condition: code runs the check every --in, without
//                                                                       a model turn, and rings the step only when it exits 0
//                                                                       or the deadline passed (22 of 44 timer turns only saw
//                                                                       the same state, audit 2026-11-11)
//   timer.mjs show                                                       the timer of this thread
//   timer.mjs clear                                                      remove it (the awaited event came)
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { commsSettings } from '../scripts/comms.mjs';
import { parseDelay, setTimer, clearTimer, activeTimer, TIMER_MIN_MS, TIMER_MAX_MS, UNTIL_TIMEOUT_MS } from '../scripts/waker.mjs';
import { run as guard } from '../hooks/pre-tool-use.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || (args.in !== undefined ? 'set' : 'show');
const out = (s) => process.stdout.write(`${s}\n`);
const str = (v) => (v === true || v === undefined ? '' : String(v).trim());
try {
  const ctx = loadContext({ project: args.project });
  if (!ctx.brainDir || !ctx.thread) fail('timer needs a brain and a stable thread id (thread <id> in the status line)');
  if (cmd === 'set') {
    const ms = parseDelay(args.in);
    if (!ms) fail('usage: timer.mjs --in <30m|2h|90s|15> --then "<step>" [--until "<check>" --deadline <2h>]');
    const then = str(args.then);
    if (!then) fail('--then "<step to do when the timer fires>" is required: the ring must say what to do');
    if (!commsSettings(ctx).enabled) fail('comms off: no wake module can ring this thread; continue the work now instead of waiting (P-061)');
    const until = str(args.until);
    let deadline = null;
    if (until) {
      const dl = parseDelay(args.deadline);
      if (!dl) fail('--until "<check>" needs --deadline <30m|2h|…>: code runs the check until then, then the step rings anyway');
      if (dl <= ms) fail('--deadline must come after the first check (--in)');
      // The check runs unattended in the prompt hook: it passes the same guard as a Bash call of this thread (P-054).
      const g = guard({ tool_name: 'Bash', tool_input: { command: until }, cwd: ctx.projectDir || process.cwd() })?.hookSpecificOutput;
      if (g?.permissionDecision === 'deny' || g?.permissionDecision === 'ask') fail(`--until refused (the check runs unattended as a Bash call of this thread): ${g.permissionDecisionReason || g.permissionDecision}`);
      deadline = new Date(Date.now() + Math.min(dl, TIMER_MAX_MS)).toISOString();
    }
    const t = setTimer(ctx.brainDir, ctx.thread, { delayMs: ms, then, until: until || null, deadline });
    const clamped = ms < TIMER_MIN_MS || ms > TIMER_MAX_MS ? ` (clamped to ${TIMER_MIN_MS / 60_000}m..${TIMER_MAX_MS / 3600_000}h)` : '';
    const check = until ? `; code runs the check (exit 0 = met, at most ${UNTIL_TIMEOUT_MS / 1000} s) at each time without a turn and rings the step when it holds or at ${deadline}` : '';
    out(`timer set: ${t.at}${clamped}; then: ${t.then}${check}. The wake module rings this thread then; end the turn with "Stav: čakám (na <what>)" (P-061)`);
  } else if (cmd === 'show') {
    const t = activeTimer(readThreadState(ctx.brainDir, ctx.thread));
    out(t ? `timer: ${t.at}; then: ${t.then}${t.until ? `; until: ${t.until} (deadline ${t.deadline})` : ''}${t.auto ? ' (armed by the Stop hook)' : ''}` : 'no timer');
  } else if (cmd === 'clear') {
    out(clearTimer(ctx.brainDir, ctx.thread) ? 'timer cleared' : 'no timer');
  } else {
    fail('usage: timer.mjs --in <30m|2h> --then "<step>" [--until "<check>" --deadline <2h>] | show | clear');
  }
} catch (err) {
  fail(err.message);
}
