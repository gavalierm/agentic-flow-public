#!/usr/bin/env node
// Check of the thread timers with a condition before their ring (P-061): job `timer-check` of the wake module (wake.json,
// written with issue-watch by adapter.mjs claude-code / project.mjs t3). For every thread of the timer index (timer.mjs
// --until registers it) whose closed turn has a conditional timer due soon, preRing (scripts/waker.mjs) runs the
// check: not met -> the timer moves and the turn record is closed again with the new resume_at, so no prompt reaches the
// thread (a prompt the hook blocks is an error in T3 and starts a fresh session). The prompt hook keeps its check as a backup.
//   timer-check.mjs [--now <iso>]
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext, readThreadState, patchThreadState } from '../scripts/config.mjs';
import { recordTurn } from '../scripts/comms.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { preRing, readTimerIndex, writeTimerIndex, threadTimers, resumeAtFor, sameTimer } from '../scripts/waker.mjs';

// Code without a thread id of its own: each turn record names its thread (ctx.thread), never an inherited one.
delete process.env.WORKFLOW_THREAD_ID;
delete process.env.T3CODE_THREAD_ID;

const args = parseArgs(process.argv.slice(2));
const now = typeof args.now === 'string' ? Date.parse(args.now) : Date.now();
try {
  const idx = readTimerIndex();
  let changed = false;
  for (const [thread, entry] of Object.entries(idx.threads)) {
    const state = readThreadState(entry.brain, thread);
    // No condition left: the thread leaves the index (timer.mjs registers it again).
    if (!threadTimers(state).some((t) => t.until)) { delete idx.threads[thread]; changed = true; continue; }
    let ctx;
    try { ctx = { ...loadContext({ project: entry.project || entry.brain, requireBrain: false }), brainDir: entry.brain, thread }; } catch (e) { process.stdout.write(`${thread}: no context (${e.message})\n`); continue; }
    // The check runs as in the thread's prompt hook: with its project (an inherited WORKFLOW_PROJECT_DIR of another
    // project made `topic.mjs closed` fail, pilot 2026-11-14, so a closed topic counted as open).
    if (entry.project) process.env.WORKFLOW_PROJECT_DIR = entry.project;
    else delete process.env.WORKFLOW_PROJECT_DIR;
    // Every due timer of the thread: one moved timer must not hand resume_at to the next one, unchecked (pilot 2026-11-14:
    // two timers due together, the second rang 1 s after the first was moved).
    const done = [];
    let r;
    for (let i = 0; i < 20; i++) {
      r = preRing(entry.brain, thread, { now, cwd: entry.project || entry.brain, skip: (t) => done.some((d) => sameTimer(d.timer, t)) });
      if (r.action !== 'rearm') break;
      done.push(r);
    }
    if (!done.length) continue;
    const left = threadTimers(readThreadState(entry.brain, thread));
    r = { ...done[done.length - 1], resume: { next: left.length ? readThreadState(entry.brain, thread).last_close?.next || left[0].then : null, at: left.length ? resumeAtFor(left[0], now) : null } };
    const st = patchThreadState(entry.brain, thread, { last_close: { next: r.resume.next, resume_at: r.resume.at } });
    // The same close the Stop hook sent, with the new time: discussion as that turn ended (Stop: state otázka).
    const res = await recordTurn(ctx, 'closed', heldTopics(entry.brain, thread), { openedAt: st.turn_opened_at || null, next: r.resume.next, resumeAt: r.resume.at, discussion: st.last_end_state === 'otázka' });
    const mail = res.ok ? (res.stale ? 'turn record newer, left' : 'turn record moved') : `turn record not moved (${res.error || 'mail off'}): the prompt hook checks it`;
    for (const d of done.slice(0, -1)) process.stdout.write(`${thread}: condition does not hold (${d.timer.until}), timer moved to ${d.timer.at}\n`);
    process.stdout.write(`${thread}: condition does not hold (${r.timer.until}), timer moved to ${r.timer.at}; ${mail}\n`);
  }
  if (changed) writeTimerIndex(idx);
} catch (err) {
  fail(`timer-check: ${err.message}`);
}
