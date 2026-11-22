// Alarms of a thread (spec 10.2, 13 budík), armed by code: the thread timer (bin/timer.mjs, rung by the wake module through
// the closed turn's resume_at), a background task or agent (the harness re-invokes the thread), a harness scheduler
// (schedule_task, CronCreate, ScheduleWakeup), or the mail's wait for an answer to mail the thread sent
// (`obligations.awaiting` with `wait_due_at`, mail design 1e: the mail rings, nothing is armed here). The Stop hook arms
// nothing itself: `otázka` has no alarm, and the state comes from the facts (scripts/topic-turn.mjs). A timer with a
// condition (--until) is checked before its ring by the wake job timer-check (preRing), the prompt hook only as a backup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readThreadState, updateThreadState } from './config.mjs';
import { PLUGIN_ROOT, writeJson } from './util.mjs';

/**
 * Absolute paths in the prompt of a recurring task whose folder does not exist (alice 2026-11-19: the daily report sent
 * the agent to docs/ai-news/ of an older brain layout, so it guessed the paths at every run). A file to be written may be
 * missing, its folder not; a placeholder (<x>, YYYY) is skipped. Returns the paths, [] when all fit.
 */
export function missingTaskPaths(prompt, { home = os.homedir(), exists = fs.existsSync } = {}) {
  const out = [];
  for (const m of String(prompt || '').matchAll(/(?<![\w.:/~-])(~\/|\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?/g)) {
    const raw = m[0];
    if (/YYYY|\bMM\b|\bDD\b/.test(raw) || /[<>]/.test(raw)) continue;
    const abs = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
    const dir = raw.endsWith('/') ? abs : path.dirname(abs);
    if (!exists(dir)) out.push(raw);
  }
  return [...new Set(out)];
}

export const TIMER_CMD = `node ${path.join(PLUGIN_ROOT, 'bin', 'timer.mjs')}`;

export const TIMER_MIN_MS = 60_000;
export const TIMER_MAX_MS = 24 * 3600_000;
/** Background work notifies the thread when done; it counts as a waker until that notification, at most this long. */
export const BACKGROUND_WAKER_MS = 2 * 3600_000;
/** Interval of a timer condition (--until) re-armed without its own interval. */
export const AUTO_TIMER_MS = 15 * 60_000;

/** ms of "30m", "2h", "90s", "15" (minutes). Null when invalid. */
export function parseDelay(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|min|h)?\s*$/i.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return Math.round(n * (unit === 's' ? 1000 : unit === 'h' ? 3600_000 : 60_000));
}

/** Ids of the harness tasks a tool call started or waits on (background command, async agent, Monitor, t3_background_wait):
 * the end notification of the task spends its waker (withoutFinished). */
/** The answer of SendMessage that resumed a finished agent (also JSON-escaped, as in the session transcript). */
const RESUMED = /resumedAgentId[\\":\s]+([\w-]+)/;

function taskIds(ti, resp, respText) {
  const ids = Array.isArray(ti.taskIds) ? ti.taskIds.filter((x) => typeof x === 'string') : [];
  if (resp && typeof resp === 'object') for (const k of ['backgroundTaskId', 'agentId', 'taskId', 'task_id']) if (typeof resp[k] === 'string' && resp[k]) ids.push(resp[k]);
  const named = /running in background with ID: ([\w-]+)/.exec(respText) || /(?:^|\n)agentId: ([\w-]+)/.exec(respText) || RESUMED.exec(respText);
  if (named) ids.push(named[1]);
  return [...new Set(ids)];
}

const FINAL_STATUS = /^(completed|failed|killed|stopped|cancell?ed|error|timeout|timed_out)$/i;
const INTERIM = /waiting on its own background work|background work of its own still running|result below may be interim|will notify again/i;

/** Ids of the tasks whose end the harness notified in `text` (a prompt or the session transcript): a <task-notification>
 * with a final <status>. A notification comes as a prompt when the thread is idle, inside the running turn otherwise. */
export function finishedTasks(text) {
  const s = String(text || '');
  const out = new Set();
  // The status is in the head of the notification, before the agent's <result>: the closing tag may come thousands of
  // characters later (2026-11-16: 3 354 characters, over the former limit of 3 000, so four finished agents
  // kept their wakers for 2 h and the turn closed with no continuation). The head ends at the result, the end or the next id.
  for (const m of s.matchAll(new RegExp(`<task-id>([^<\\s]+)</task-id>|${RESUMED.source}`, 'g'))) {
    // A message resumed the agent after its end: it runs again and notifies again, so its earlier end does not count.
    if (m[2]) { out.delete(m[2]); continue; }
    const from = m.index + m[0].length;
    const head = s.slice(from, from + 4000).split(/<result>|<\/task-notification>|<task-id>/)[0];
    const status = /<status>([\w-]+)<\/status>/.exec(head)?.[1];
    // "completed" of an agent still waiting on its own background work, or resumed with late messages, is interim: the same
    // id notifies again (a project 2026-11-18: the waker went, "continue from handover" rang three times in 2 min).
    // The last notification of an id decides.
    if (INTERIM.test(head)) out.delete(m[1]);
    else if (status && FINAL_STATUS.test(status)) out.add(m[1]);
  }
  return out;
}

/** Wakers without those whose tasks all ended: the harness rings nobody for them any more (operator 2026-11-13: a release
 * notified 1 h before still counted for 2 h, so "Stav: hotovo" passed with a next step in the handover). */
export function withoutFinished(wakers, finished) {
  const list = wakers || [];
  if (!finished?.size) return list;
  return list.filter((w) => !(Array.isArray(w.tasks) && w.tasks.length && w.tasks.every((id) => finished.has(id))));
}

/** Waker an agent armed with this tool call (PostToolUse input), or null. */
export function wakerFromTool(input, now = Date.now()) {
  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input || {};
  const resp = input?.tool_response;
  const respText = typeof resp === 'string' ? resp : typeof resp?.stdout === 'string' ? resp.stdout : JSON.stringify(resp || {}).slice(0, 2000);
  const at = new Date(now).toISOString();
  // A stopped task rings nobody: its waker goes (TaskStop; KillShell in older harness versions).
  if (tool === 'TaskStop' || tool === 'KillShell') {
    const id = ti.task_id || ti.shell_id || (resp && typeof resp === 'object' ? resp.task_id : null);
    return id ? { kind: 'background', ended: [String(id)], at } : null;
  }
  const tasks = taskIds(ti, resp, respText);
  const bg = (kind) => ({ kind, at, until: new Date(now + BACKGROUND_WAKER_MS).toISOString(), ...(tasks.length ? { tasks } : {}) });
  if ((tool === 'Bash' || tool === 'PowerShell') && ti.run_in_background === true) return bg('background');
  if ((tool === 'Agent' || tool === 'Task') && (ti.run_in_background === true || /async_launched|running in the background|run_in_background/i.test(respText))) return bg('agent');
  // A message that resumes a finished agent starts it again in the background and the harness notifies its end (a project
  // 2026-11-20: no waker, so "continue from handover" rang three times in a minute and marked the waiting topic stuck).
  if (tool === 'SendMessage' && RESUMED.test(respText)) return bg('agent');
  // A harness schedule rings this thread on every run, also turns later: it stays a waker until removed, not 2 h
  // (2026-11-03: a daily 06:00 report task did not count in the evening, so auto timers woke the thread for nothing).
  if (/(^|__)schedule_task$/.test(tool)) {
    if (ti.bindToCurrentThread === false) return null;
    const id = ti.scheduledTaskId || /"(?:scheduledTaskId|id)"\s*:\s*"([^"]+)"/.exec(respText)?.[1] || null;
    if (ti.enabled === false) return { kind: 'scheduler', id, remove: true, at };
    return { kind: 'scheduler', id, recurring: true, at };
  }
  if (/(^|__)delete_scheduled_task$/.test(tool)) return { kind: 'scheduler', id: ti.scheduledTaskId || ti.id || null, remove: true, at };
  if (tool === 'CronCreate' && ti.recurring !== false) return { kind: 'scheduler', id: /"id"\s*:\s*"([^"]+)"/.exec(respText)?.[1] || null, recurring: true, at };
  if (tool === 'CronCreate') {
    const fire = Number(/"nextFireAt"\s*:\s*(\d{12,})/.exec(respText)?.[1]);
    return { kind: 'scheduler', at, until: new Date(Math.max(now + BACKGROUND_WAKER_MS, Number.isFinite(fire) ? fire + 15 * 60_000 : 0)).toISOString() };
  }
  if (tool === 'CronDelete') return { kind: 'scheduler', id: ti.id || null, remove: true, at };
  if (tool === 'ScheduleWakeup' && Number(ti.delaySeconds) > 0) return { kind: 'scheduler', at, until: new Date(now + Math.max(BACKGROUND_WAKER_MS, Number(ti.delaySeconds) * 1000 + 15 * 60_000)).toISOString() };
  if (/(^|__)(t3_background_wait|delegate_task)$/.test(tool) || ['ScheduleWakeup', 'Monitor'].includes(tool)) return bg('scheduler');
  // Mail sent here is no waker of this thread: the mail's wait for its answer rings (1e, `awaitingWaker`, P-072).
  return null;
}

/** Every timer of the thread, earliest first. `timer` is the next one (the Stop hook sends its time as resume_at, the prompt
 * hook rings its step), `timers` holds the later ones: one slot let the reply window of an assist replace an earlier
 * timer.mjs step unseen (2026-11-13). */
export function threadTimers(state) {
  return [state?.timer, ...(Array.isArray(state?.timers) ? state.timers : [])].filter((t) => t && t.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** State patch that holds `list` as the timers of the thread (the earliest in `timer`). */
export function timersPatch(list) {
  const s = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 20);
  return { timer: s[0], timers: s.length > 1 ? s.slice(1) : undefined };
}

/** The same timer entry (a copy read from another state). */
export const sameTimer = (a, b) => !!a && !!b && a.at === b.at && a.set_at === b.set_at && a.then === b.then;

/** Thread timer still ahead, or null. */
export function activeTimer(state, now = Date.now()) {
  return threadTimers(state).find((t) => Date.parse(t.at) > now) || null;
}

/** A waker for this turn: armed since the turn started, still running, or a thread timer (one already due rings as the turn
 * closes: the Stop hook sends the earliest timer as resume_at, pilot nudge-why 2026-11-14). */
export function validWaker(state, now = Date.now()) {
  const timer = threadTimers(state)[0] || null;
  if (timer) return { kind: 'timer', at: timer.at };
  const started = Date.parse(state?.turn_started_at || '') || 0;
  return (state?.wakers || []).find((w) => w.recurring || Date.parse(w.at) >= started || (w.until && Date.parse(w.until) > now)) || null;
}

/**
 * The sent messages that make this thread wait (state `čakám`): a blocker without a final answer whose wait is set
 * (`obligations.awaiting[].wait_due_at`). Its sender is blocked, and the answer or the mail's check rings it (1e).
 * An assist and a steer are not among them: their sender does other work and has no step until the result, and the
 * recipient ends a message that asks for no answer with `ack`, or reads a steer, which rings nobody. A turn that ended
 * `čakám (na prevzatie pošty)` after such an assist had no waker once it was acked (error report 2026-11-21).
 * One place for the Stop hook, the facts of a topic (threadAlarms) and nudge-why.
 */
export function awaitedAnswers(obligations) {
  return (obligations?.awaiting || []).filter((a) => a?.wait_due_at && a.level === 'blocker');
}

/** The mail rings this thread for the answer to its blocker (awaitedAnswers; a due wait rings at the next cycle of the wake module). Null without one. */
export function awaitingWaker(obligations) {
  const a = awaitedAnswers(obligations).sort((x, y) => Date.parse(x.wait_due_at) - Date.parse(y.wait_due_at))[0];
  return a ? { kind: 'mail', id: a.id, at: a.wait_due_at } : null;
}

export function recordWaker(brainDir, thread, waker) {
  if (!brainDir || !thread || !waker) return;
  const now = Date.now();
  // A removed schedule drops its waker (by id; without an id every recurring one, the safe side).
  const removed = (w) => waker.remove && w.recurring && (!waker.id || !w.id || w.id === waker.id);
  updateThreadState(brainDir, thread, (state) => {
    const keep = (state.wakers || []).filter((w) => !removed(w) && (w.recurring || (w.until && Date.parse(w.until) > now))).slice(-20);
    if (waker.ended) return { ...state, wakers: withoutFinished(keep, new Set(waker.ended)) };
    return { ...state, wakers: waker.remove ? keep : [...keep.filter((w) => !(waker.id && w.id === waker.id)), waker] };
  });
}

/** Add a thread timer: the wake module rings the thread at `at` with the step `then` (via the closed turn, P-061). Other
 * timers stay, none is lost (2026-11-13); it replaces only its own earlier entry (the same step). No timer is bound to a
 * message: the mail rings for an answer (1e, P-072). */
export function setTimer(brainDir, thread, { delayMs, then, reason = null, until = null, deadline = null, everyMs = null, minMs = TIMER_MIN_MS }, now = Date.now()) {
  const ms = Math.min(Math.max(delayMs, minMs), TIMER_MAX_MS);
  // A condition (--until): the prompt hook runs it at `at` and rings the model only when it holds or `deadline` passed.
  const cond = until ? { until: String(until).slice(0, 300), deadline, every_ms: everyMs || ms } : {};
  const setAt = new Date(now).toISOString();
  const timer = { at: new Date(now + ms).toISOString(), then: String(then || '').slice(0, 300), set_at: setAt, ...(reason ? { reason } : {}), ...cond };
  updateThreadState(brainDir, thread, (state) => ({ ...state, ...timersPatch([...threadTimers(state).filter((t) => t.then !== timer.then), timer]) }));
  return timer;
}

/** A step P-047 refused in a turn from a bell continues by itself: a thread timer in this time (topic close-after-bell). */
// 10 s, not 60 s (operator 2026-11-17, P-079: a thread that waited for its continuation sat idle 2 min).
export const BELL_CONTINUE_MS = 10_000;

/** The command line of this process (`done.mjs --topic …`), the step a bell turn refused; null outside a bin/ command (a hook). */
export function refusedCommand(argv = process.argv) {
  if (!argv[1] || path.basename(path.dirname(argv[1])) !== 'bin') return null;
  const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${String(a).replace(/(["\\$`])/g, '\\$1')}"`);
  return [path.basename(argv[1]), ...argv.slice(2).map(q)].join(' ');
}

/**
 * P-047 refused `step` in a turn a message started: the lock stays (the step never runs in a bell turn), but the thread does
 * not wait silently (2026-11-15: done --topic was refused, the handover held the step, no turn came until the operator).
 * Arms a thread timer in BELL_CONTINUE_MS; the closed turn carries resume_at, wake rings "continue from handover" and in that
 * turn P-047 does not lock. Returns the sentence the refusal ends with ('' when nothing was armed: no thread, or a hook).
 */
export function bellContinuation(brainDir, thread, step = refusedCommand()) {
  if (!brainDir || !thread || !step) return '';
  setTimer(brainDir, thread, { delayMs: BELL_CONTINUE_MS, minMs: 0, then: `${step} (odmietnutý v ťahu zo zvončeka, P-047)` });
  return `; the continuation is set in ${BELL_CONTINUE_MS / 1000} s (a thread timer with this step): end the turn now with "**Stav:** čakám (na pokračovanie z handoveru)"; the next turn continues from handover, where P-047 does not lock, and runs the step there`;
}

/** The prompt hook runs the condition within its 15 s (hooks.json); a slower check counts as not met yet. */
export const UNTIL_TIMEOUT_MS = 8000;

/** The condition of a timer holds (exit 0): true, false (also on timeout), or null when it cannot run (no shell). */
export function untilMet(cmd, cwd) {
  const r = spawnSync('sh', ['-c', String(cmd)], { cwd, timeout: UNTIL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: 'ignore' });
  if (r.error && r.error.code !== 'ETIMEDOUT') return null;
  return r.status === 0;
}

/** Remove the timers `which` selects (all without it); the removed entries, [] when none matched. */
export function clearTimer(brainDir, thread, which = () => true) {
  let gone = [];
  updateThreadState(brainDir, thread, (state) => {
    const all = threadTimers(state);
    gone = all.filter(which);
    if (!gone.length) return null;
    const { timer, timers, ...rest } = state;
    return { ...rest, ...timersPatch(all.filter((t) => !gone.includes(t))) };
  });
  return gone;
}


// Check before the ring (wake job `timer-check`, bin/timer-check.mjs): a timer with a condition is checked by code shortly
// before its time, so a condition that does not hold moves the timer and the turn's resume_at without a prompt to the
// thread. The prompt hook blocked such a bell before, and T3 showed the block as an error with "Your next message starts a
// fresh session" (maintainer/workflow-dev 2026-11-14 21:49): the operator woke the thread into a session without context. The
// check in the prompt hook stays as a backup for a bell this job did not reach.
/** The job checks the timers due within this window: the wake module rings a closed turn about once a minute. */
export const TIMER_CHECK_LEAD_MS = 150_000;

/** resume_at the Stop hook sends for `timer`: a condition gets at least the lead of the check, so the wake job (every
 * 60 s) runs it before the ring; a timer due right after the turn rang first and the hook blocked it (pilot 2026-11-14). */
export function resumeAtFor(timer, now = Date.now()) {
  if (!timer?.at) return null;
  if (!timer.until) return timer.at;
  return new Date(Math.max(Date.parse(timer.at), now + TIMER_CHECK_LEAD_MS)).toISOString();
}

/** The turn of a thread runs: it started after the last end (the Stop hook sends resume_at itself when it ends). */
export function turnRunning(state) {
  const started = Date.parse(state?.turn_started_at || '') || 0;
  return started > (Date.parse(state?.last_end_at || '') || 0);
}

/**
 * Decide the bell of a closed thread before the wake module rings it: { action, timer?, reason?, resume? }.
 * - 'rearm': the first due timer has a condition that does not hold before its deadline: moved (`timer`), the turn's
 *   resume_at must go to `resume` ({ next, at }) so no prompt reaches the thread;
 * - 'ring' (the bell goes as it is: no condition, it holds, it cannot run here, deadline), 'none' (nothing due soon),
 *   'running' (an open turn: its Stop sends the time).
 */
export function preRing(brainDir, thread, { now = Date.now(), cwd = process.cwd(), run = untilMet, lead = TIMER_CHECK_LEAD_MS, skip = () => false } = {}) {
  const state = readThreadState(brainDir, thread);
  if (turnRunning(state)) return { action: 'running' };
  // `skip`: timers moved earlier in the same run (bin/timer-check.mjs checks every due timer of the thread).
  const timer = threadTimers(state).find((t) => Date.parse(t.at) <= now + lead && !skip(t));
  if (!timer) return { action: 'none' };
  if (!timer.until) return { action: 'ring', timer };
  const dl = Date.parse(timer.deadline || '') || 0;
  if (now >= dl) return { action: 'ring', timer, reason: 'deadline' };
  const met = run(timer.until, cwd);
  if (met !== false) return { action: 'ring', timer, reason: met ? 'met' : 'cannot-run' };
  const moved = setTimer(brainDir, thread, { delayMs: Math.min(timer.every_ms || AUTO_TIMER_MS, dl - now), then: timer.then, reason: timer.reason || null, until: timer.until, deadline: timer.deadline, everyMs: timer.every_ms }, now);
  const first = threadTimers(readThreadState(brainDir, thread))[0] || moved;
  return { action: 'rearm', timer: moved, resume: { next: state.last_close?.next || first.then, at: first.at } };
}

/** Threads of this machine with a timer under a condition (timer.mjs --until): the wake job checks them all. */
export function timerIndexFile(env = process.env) {
  return env.WORKFLOW_TIMER_INDEX || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', 'timer-index.json');
}
export function readTimerIndex(env = process.env) {
  try {
    const d = JSON.parse(fs.readFileSync(timerIndexFile(env), 'utf8'));
    return d && typeof d.threads === 'object' && d.threads ? d : { threads: {} };
  } catch { return { threads: {} }; }
}
export function writeTimerIndex(idx, env = process.env) {
  writeJson(timerIndexFile(env), idx);
}
/** Register the thread of `ctx` (brain, project dir: the check's cwd and the mail settings of its turn). Never throws. */
export function registerTimerThread(ctx, env = process.env) {
  try {
    if (!ctx?.brainDir || !ctx.thread) return;
    const idx = readTimerIndex(env);
    const cur = idx.threads[ctx.thread];
    if (cur?.brain === ctx.brainDir && cur?.project === ctx.projectDir) return;
    idx.threads[ctx.thread] = { brain: ctx.brainDir, project: ctx.projectDir || null, since: new Date().toISOString() };
    writeTimerIndex(idx, env);
  } catch { /* the prompt hook still checks the timer when it rings */ }
}
