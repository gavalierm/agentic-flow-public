#!/usr/bin/env node
// Thread timer (P-061): work is deferred to a set time, never stopped. The Stop hook sends the timer with the closed turn
// (resume_at); the wake module rings the thread then ("turn ended with a next step, continue from handover") and the
// prompt hook names the step.
//   timer.mjs --in <30m|2h|90s|15> --then "<step to do when it fires>"   add a timer; other timers of the thread stay (one with
//                                                                       the same step is moved); timers due together ring in one
//                                                                       turn with all their steps (2026-11-13: one slot let the
//                                                                       reply window of a mail replace a timer step unseen)
//   timer.mjs --in 5m --until "<check>" --deadline 2h --then "<step>"     a condition: code runs the check every --in, without
//                                                                       a model turn, and rings the step only when it exits 0
//                                                                       or the deadline passed (22 of 44 timer turns only saw
//                                                                       the same state, audit 2026-11-11)
//   timer.mjs --in 10m --topic <id> --then "<step>"                      waiting for another topic: the check is topic.mjs closed
//                                                                       <id> (deadline 24h unless --deadline); over 30m without a
//                                                                       condition needs --blind (a step bound to the clock itself)
//   timer.mjs show                                                      every timer of this thread, earliest first, numbered
//   timer.mjs clear [<n>]                                                remove timer n of show (the awaited event came); without n
//                                                                       all of them, each removed step is printed
import path from 'node:path';
import { parseArgs, fail, PLUGIN_ROOT, localTime } from '../scripts/util.mjs';
import { readTopic } from '../scripts/topic.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { commsSettings } from '../scripts/comms.mjs';
import { parseDelay, setTimer, clearTimer, threadTimers, TIMER_MIN_MS, TIMER_MAX_MS, UNTIL_TIMEOUT_MS } from '../scripts/waker.mjs';
import { run as guard } from '../hooks/pre-tool-use.mjs';

/** Longer than this without a condition is a blind wait (report-32db110e): --topic, --until, mail, or --blind. */
const BLIND_MAX_MS = 30 * 60_000;
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || (args.in !== undefined ? 'set' : 'show');
const out = (s) => process.stdout.write(`${s}\n`);
const line = (t) => `timer: ${localTime(t.at)}; then: ${t.then}${t.until ? `; until: ${t.until} (deadline ${localTime(t.deadline)})` : ''}${t.for ? ` (reply window of ${t.for})` : ''}${t.auto ? ' (armed by the Stop hook)' : ''}`;
const str = (v) => (v === true || v === undefined ? '' : String(v).trim());
try {
  const ctx = loadContext({ project: args.project });
  if (!ctx.brainDir || !ctx.thread) fail('timer needs a brain and a stable thread id (thread <id> in the status line)');
  if (cmd === 'set') {
    const ms = parseDelay(args.in);
    if (!ms) fail('usage: timer.mjs --in <30m|2h|90s|15> --then "<step>" [--until "<check>" --deadline <2h> | --topic <id>] [--blind]');
    const then = str(args.then);
    if (!then) fail('--then "<step to do when the timer fires>" is required: the ring must say what to do');
    if (!commsSettings(ctx).enabled) fail('comms off: no wake module can ring this thread; continue the work now instead of waiting (P-061)');
    const topic = str(args.topic);
    if (topic && str(args.until)) fail('--topic builds its own --until check; give one of them');
    if (topic && !readTopic(ctx.brainDir, topic)) fail(`--topic ${topic}: no open topic of that id in this brain (topic.mjs list); it is already closed or the id is wrong`);
    // Waiting for another topic is a condition, not a time: code checks it (topic.mjs closed), the step rings when it holds.
    const until = topic ? `node "${path.join(PLUGIN_ROOT, 'bin', 'topic.mjs')}" closed ${topic}` : str(args.until);
    // A blind long timer saw the awaited event come early and the operator had to ask (report-32db110e, 2026-11-13).
    if (!until && ms > BLIND_MAX_MS && !args.blind) fail(`a timer over ${BLIND_MAX_MS / 60_000}m without a condition waits blind: waiting for another topic → --topic <id>; for an event a command can check → --until "<check>" --deadline <2h>; for its result by mail → a message with a deadline; only a step bound to the clock itself → --blind`);
    let deadline = null;
    if (until) {
      const dl = parseDelay(args.deadline || (topic ? '24h' : undefined));
      if (!dl) fail('--until "<check>" needs --deadline <30m|2h|…>: code runs the check until then, then the step rings anyway');
      if (dl <= ms) fail('--deadline must come after the first check (--in)');
      // The check runs unattended in the prompt hook: it passes the same guard as a Bash call of this thread (P-054).
      const g = guard({ tool_name: 'Bash', tool_input: { command: until }, cwd: ctx.projectDir || process.cwd() })?.hookSpecificOutput;
      if (g?.permissionDecision === 'deny' || g?.permissionDecision === 'ask') fail(`--until refused (the check runs unattended as a Bash call of this thread): ${g.permissionDecisionReason || g.permissionDecision}`);
      deadline = new Date(Date.now() + Math.min(dl, TIMER_MAX_MS)).toISOString();
    }
    const t = setTimer(ctx.brainDir, ctx.thread, { delayMs: ms, then, until: until || null, deadline });
    const clamped = ms < TIMER_MIN_MS || ms > TIMER_MAX_MS ? ` (clamped to ${TIMER_MIN_MS / 60_000}m..${TIMER_MAX_MS / 3600_000}h)` : '';
    const check = until ? `; code runs the check (exit 0 = met, at most ${UNTIL_TIMEOUT_MS / 1000} s) at each time without a turn and rings the step when it holds or at ${localTime(deadline)}` : '';
    const others = threadTimers(readThreadState(ctx.brainDir, ctx.thread)).filter((x) => x !== t && !(x.at === t.at && x.set_at === t.set_at)).length;
    out(`timer set: ${localTime(t.at)}${clamped}; then: ${t.then}${check}${others ? `; ${others} other timer(s) of this thread stay (timer.mjs show)` : ''}. The wake module rings this thread then; end the turn with your **Handover:** section (a numbered line "1. <topic> → <next step>") and "**Stav:** čakám (na <what>)" (P-061)`);
  } else if (cmd === 'show') {
    const all = threadTimers(readThreadState(ctx.brainDir, ctx.thread));
    out(all.length ? all.map((t, i) => `${i + 1}. ${line(t)}`).join('\n') : 'no timer');
  } else if (cmd === 'clear') {
    const n = args._[1] === undefined ? null : Number(args._[1]);
    const all = threadTimers(readThreadState(ctx.brainDir, ctx.thread));
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= all.length)) fail(`timer.mjs clear [<n>]: n is the number of a timer in timer.mjs show (1..${all.length})`);
    const gone = clearTimer(ctx.brainDir, ctx.thread, n === null ? () => true : (t) => t === all[n - 1] || (t.at === all[n - 1].at && t.set_at === all[n - 1].set_at && t.then === all[n - 1].then));
    out(gone.length ? gone.map((t) => `timer cleared: ${line(t)}`).join('\n') : 'no timer');
  } else {
    fail('usage: timer.mjs --in <30m|2h> --then "<step>" [--until "<check>" --deadline <2h> | --topic <id>] [--blind] | show | clear');
  }
} catch (err) {
  fail(err.message);
}
