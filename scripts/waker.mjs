// Work never stops (P-061, operator 2026-11-03/08): no message, question or event stops the work; it may only be deferred
// to a set time. A turn that declares "Stav: čakám" is rung again by a waker armed by code: the thread timer (bin/timer.mjs,
// rung by the wake module through the closed turn's resume_at), a background task or agent (the harness re-invokes the
// thread), a harness scheduler (schedule_task, CronCreate, ScheduleWakeup), or the mail's wait for an answer to mail the
// thread sent (`obligations.awaiting` with `wait_due_at`, mail design 1e: the mail rings, nothing is armed here). Without one
// the Stop hook arms the timer itself with the wait target, no block: 7 of 8 such blocks only led to timer.mjs (audit
// 2026-11-11). A timer with a condition (--until) is checked before its ring by the wake job timer-check (preRing), the
// prompt hook only as a backup.
// The reply is never read as prose here (scripts/protocol.mjs reads its state line); only the handover's next step is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readThreadState, writeThreadState } from './config.mjs';
import { PLUGIN_ROOT, localTime } from './util.mjs';
import { listTopicRecords } from './topic-files.mjs';

export const TIMER_CMD = `node ${path.join(PLUGIN_ROOT, 'bin', 'timer.mjs')}`;

export const TIMER_MIN_MS = 60_000;
export const TIMER_MAX_MS = 24 * 3600_000;
/** Background work notifies the thread when done; it counts as a waker until that notification, at most this long. */
export const BACKGROUND_WAKER_MS = 2 * 3600_000;
/** Timer the Stop hook arms itself when the agent ended waiting without one (doubles per repeat, up to the max). */
export const AUTO_TIMER_MS = 15 * 60_000;
export const AUTO_TIMER_MAX_MS = 2 * 3600_000;
/** Waiting on the operator rings in hours, not minutes (operator 2026-11-03: "the interval must be far longer, in hours"). */
export const OPERATOR_TIMER_MS = 4 * 3600_000;
export const OPERATOR_TIMER_MAX_MS = 24 * 3600_000;
/** Rings of a next step that only waits (no own work): then the thread rests until mail or the operator wakes it. */
export const IDLE_RING_MS = [4 * 3600_000, 12 * 3600_000, 24 * 3600_000];

const L = '\\p{L}';
// "čakám", "počkám", "čakáme", "cakam", "čakať", "čaká na …", "waiting for", "I'll wait" (sk without diacritics too).
const WAIT_PATTERNS = [
  new RegExp(`(^|[^${L}])(po)?[čc]ak(ám|am|áme|ame|ať|at)(?![${L}])`, 'iu'),
  new RegExp(`(^|[^${L}])(po)?[čc]ak(á|a|ajú|aju|ú|u)\\s+na(?![${L}])`, 'iu'),
  new RegExp(`(^|[^${L}])po[čc]k(ám|am|áme|ame|ať|at)(?![${L}])`, 'iu'),
  /\b(waiting|wait|awaiting)\s+(for|on|until)\b/i,
  /\bI('ll| will| am|'m)\s+(wait|waiting)\b/i,
  // bob 2026-11-03: "Zostáva len čakanie na teba", "Potrebujem od teba, čo …" ended a turn waiting, unseen.
  new RegExp(`(^|[^${L}])(zost[áa]va|ost[áa]va|nasleduje)\\s+(len\\s+|iba\\s+|u[žz]\\s+)?[čc]akanie\\s+na(?![${L}])`, 'iu'),
  new RegExp(`(^|[^${L}])potrebujem\\s+od\\s+(teba|vás|vas)(?![${L}])`, 'iu'),
  new RegExp(`(^|[^${L}])bez\\s+tvojho\\s+pokynu(?![${L}])`, 'iu'),
];

const CONDITIONAL = new RegExp(`^\\s*([-*•]\\s*)?(\\*\\*)?(keď|ked|ak|kým|kym|pokiaľ|pokial|až|if|when|whenever|once)(?![${L}])`, 'iu');

/** The waiting phrase of a handover step ("čakám na …"), or null. Quoted and code text is left out (it is data, not a claim). */
export function waitingClaim(text) {
  if (typeof text !== 'string' || !text) return null;
  const quoted = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/[„"“][^„"“”\n]*[”"“]/g, ' ');
  // A conditional clause describes a case, not this reply's state (alice 2026-11-03: "Keď krok čaká na neskoršiu udalosť,
  // hook …" was blocked as waiting).
  const prose = quoted.split(/(?<=[,.;:!?\n])/).filter((c) => !CONDITIONAL.test(c)).join(' ');
  for (const re of WAIT_PATTERNS) {
    const m = re.exec(prose);
    if (m) {
      const at = m.index + (m[1] ? m[1].length : 0);
      return prose.slice(at, at + 60).split('\n')[0].trim();
    }
  }
  return null;
}

/** The next step only waits (for the operator, another topic, a reply): the topic has no own work to continue. */
export function waitOnlyStep(next) {
  if (typeof next !== 'string' || !next.trim()) return null;
  const head = next.trim().split(/[;.\n]/)[0];
  return waitingClaim(head) || (new RegExp(`^(oper[áa]tor|operator)\\s+(rozhodne|odpovie|potvrd[íi]|schv[áa]li|decides|answers|confirms)(?![${L}])`, 'iu').test(head) ? head.slice(0, 60) : null);
}

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
function taskIds(ti, resp, respText) {
  const ids = Array.isArray(ti.taskIds) ? ti.taskIds.filter((x) => typeof x === 'string') : [];
  if (resp && typeof resp === 'object') for (const k of ['backgroundTaskId', 'agentId', 'taskId', 'task_id']) if (typeof resp[k] === 'string' && resp[k]) ids.push(resp[k]);
  const named = /running in background with ID: ([\w-]+)/.exec(respText) || /(?:^|\n)agentId: ([\w-]+)/.exec(respText);
  if (named) ids.push(named[1]);
  return [...new Set(ids)];
}

const FINAL_STATUS = /^(completed|failed|killed|stopped|cancell?ed|error|timeout|timed_out)$/i;

/** Ids of the tasks whose end the harness notified in `text` (a prompt or the session transcript): a <task-notification>
 * with a final <status>. A notification comes as a prompt when the thread is idle, inside the running turn otherwise. */
export function finishedTasks(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/<task-id>([^<\s]+)<\/task-id>([\s\S]{0,3000}?)<\/task-notification>/g)) {
    const status = /<status>([\w-]+)<\/status>/.exec(m[2])?.[1];
    if (status && FINAL_STATUS.test(status)) out.add(m[1]);
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

// A reminder or a step bound to a clock time or date lives in a harness schedule (schedule_task in T3), not as text in the
// handover: the text rang nobody and the reminder was closed instead of moved (operator 2026-11-11, claude CLI re-auth).
const REMINDER_WORD = /(?<![\p{L}])(pripom[ie]n\p{L}*|pripomeň\p{L}*|budík\p{L}*|budik\p{L}*|remind\p{L}*|alarm\p{L}*|expir\p{L}*)/iu;
const AT_TIME = /(?<![\p{L}\d])(?:o|do|pred|po|okolo|at|by|before|after|~)\s*\d{1,2}:\d{2}(?!\d)/iu;
const ON_DATE = /(?<![\p{L}\d])(?:o|do|pred|by|before|on|dňa|dna)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.)(?!\d)/iu;
const IN_HOURS = /(?<![\p{L}\d])(?:o|za|in)\s+\d+\s*(?:h|hod\p{L}*|hours?|d|dní|dni|dňa|days?)(?![\p{L}])/iu;
const TOMORROW = /(?<![\p{L}])(zajtra|pozajtra|tomorrow)(?![\p{L}])/iu;

/** The phrase of a handover step that names a reminder or a time it is bound to, or null. */
export function reminderStep(next) {
  const s = String(next || '');
  for (const re of [REMINDER_WORD, AT_TIME, ON_DATE, IN_HOURS, TOMORROW]) {
    const m = re.exec(s);
    if (m) return m[0].trim();
  }
  return null;
}

/** A harness schedule (schedule_task, CronCreate, ScheduleWakeup) recorded for this thread and still armed, or null. */
export function armedSchedule(state, now = Date.now()) {
  return (state?.wakers || []).find((w) => w.kind === 'scheduler' && !w.remove && (w.recurring || (w.until && Date.parse(w.until) > now))) || null;
}

export const REMINDER_REFUSAL = (phrase) => `handover not saved: the next step names a reminder or a time ("${phrase}"), and no schedule is armed in this thread. A reminder is a T3 timer, not text in the handover or memory (operator 2026-11-11): arm it first with schedule_task (or CronCreate), at a time before the event, then save the handover again. A reminder that is due is moved to the next time, never closed without a new timer`;

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
 * The mail rings this thread for an answer it waits for (1e): a message it sent without a final answer whose wait is set
 * (`obligations.awaiting[].wait_due_at`; a due one rings at the next cycle of the wake module). Null without one.
 */
export function awaitingWaker(obligations) {
  const a = (obligations?.awaiting || []).filter((x) => x.wait_due_at).sort((x, y) => Date.parse(x.wait_due_at) - Date.parse(y.wait_due_at))[0];
  return a ? { kind: 'mail', id: a.id, at: a.wait_due_at } : null;
}

export function recordWaker(brainDir, thread, waker) {
  if (!brainDir || !thread || !waker) return;
  const state = readThreadState(brainDir, thread);
  const now = Date.now();
  // A removed schedule drops its waker (by id; without an id every recurring one, the safe side: auto timers return).
  const removed = (w) => waker.remove && w.recurring && (!waker.id || !w.id || w.id === waker.id);
  const keep = (state.wakers || []).filter((w) => !removed(w) && (w.recurring || (w.until && Date.parse(w.until) > now))).slice(-20);
  if (waker.ended) return writeThreadState(brainDir, thread, { ...state, wakers: withoutFinished(keep, new Set(waker.ended)) });
  writeThreadState(brainDir, thread, { ...state, wakers: waker.remove ? keep : [...keep.filter((w) => !(waker.id && w.id === waker.id)), waker] });
}

/** Add a thread timer: the wake module rings the thread at `at` with the step `then` (via the closed turn, P-061). Other
 * timers stay, none is lost (2026-11-13); it replaces only its own earlier entry: the same step of a plain timer, the timer
 * of the same topic (`topic`, timer.mjs --topic: 3 of 4 backup timers of one thread were for closed topics, 2026-11-14), or
 * the auto timer of code (any own timer of the agent replaces that one, it only stood in for a waker). `topicSince` keeps
 * the first set time of a topic timer across the re-arms of its check. No timer is bound to a message: the mail rings for
 * an answer (1e, P-072). */
export function setTimer(brainDir, thread, { delayMs, then, reason = null, auto = false, until = null, deadline = null, everyMs = null, topic = null, topicSince = null, stall = null }, now = Date.now()) {
  const ms = Math.min(Math.max(delayMs, TIMER_MIN_MS), TIMER_MAX_MS);
  const state = readThreadState(brainDir, thread);
  // A condition (--until): the prompt hook runs it at `at` and rings the model only when it holds or `deadline` passed.
  const cond = until ? { until: String(until).slice(0, 300), deadline, every_ms: everyMs || ms } : {};
  const setAt = new Date(now).toISOString();
  const bound = topic ? { topic: String(topic), topic_since: topicSince || setAt } : stall ? { stall: String(stall) } : {};
  const timer = { at: new Date(now + ms).toISOString(), then: String(then || '').slice(0, 300), set_at: setAt, ...(reason ? { reason } : {}), ...(auto ? { auto: true } : {}), ...cond, ...bound };
  // A stall check (setStallCheck) is one per handed-off topic: a new one replaces the earlier one of that topic.
  const replaced = (t) => t.auto || (topic && timerTopic(t) === topic) || (stall && t.stall === stall) || t.then === timer.then;
  writeThreadState(brainDir, thread, { ...state, ...timersPatch([...threadTimers(state).filter((t) => !replaced(t)), timer]), ...(auto ? {} : { auto_timer_n: 0 }) });
  return timer;
}

/** A step P-047 refused in a turn from a bell continues by itself: a thread timer in this time (topic close-after-bell). */
export const BELL_CONTINUE_MS = 60_000;

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
  setTimer(brainDir, thread, { delayMs: BELL_CONTINUE_MS, then: `${step} (odmietnutý v ťahu zo zvončeka, P-047)` });
  return `; the continuation is set in 1 min (a thread timer with this step): end the turn now with your **Handover:** section and "**Stav:** čakám (na pokračovanie z handoveru)"; the next turn continues from handover, where P-047 does not lock, and runs the step there`;
}

/** The topic a timer waits for (timer.mjs --topic), also of a timer set before the `topic` field (its check names it). */
export function timerTopic(t) {
  return t?.topic || String(t?.until || '').match(/topic\.mjs"? closed (\S+)$/)?.[1] || null;
}

/** A topic timer whose result already came: this thread took mail from that topic (comms receive) since the timer was set. */
export function topicResultCame(state, t) {
  const topic = timerTopic(t);
  const got = Date.parse(state?.topic_mail?.[topic] || '');
  return !!topic && Number.isFinite(got) && got >= Date.parse(t.topic_since || t.set_at || '');
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
  const state = readThreadState(brainDir, thread);
  const all = threadTimers(state);
  const gone = all.filter(which);
  if (!gone.length) return [];
  const { timer, timers, ...rest } = state;
  writeThreadState(brainDir, thread, { ...rest, ...timersPatch(all.filter((t) => !gone.includes(t))) });
  return gone;
}


// Check before the ring (wake job `timer-check`, bin/timer-check.mjs): a timer with a condition is checked by code shortly
// before its time, so a condition that does not hold moves the timer and the turn's resume_at without a prompt to the
// thread. The prompt hook blocked such a bell before, and T3 showed the block as an error with "Your next message starts a
// fresh session" (maintainer/workflow-dev 2026-11-14 21:49): the operator woke the thread into a session without context. The
// check in the prompt hook stays as a backup for a bell this job did not reach.
/** The job checks the timers due within this window: the wake module rings a closed turn about once a minute. */
export const TIMER_CHECK_LEAD_MS = 150_000;
/** A topic a timer waits on stands after this long without a commit, mail or turn (policy timer.topic_stall_h). */
export const TOPIC_STALL_MS = 2 * 3600_000;

/** resume_at the Stop hook sends for `timer`: a condition gets at least the lead of the check, so the wake job (every
 * 60 s) runs it before the ring; a timer due right after the turn rang first and the hook blocked it (pilot 2026-11-14). */
export function resumeAtFor(timer, now = Date.now()) {
  if (!timer?.at) return null;
  if (!timer.until || timer.ring_reason) return timer.at;
  return new Date(Math.max(Date.parse(timer.at), now + TIMER_CHECK_LEAD_MS)).toISOString();
}

/** The turn of a thread runs: it started after the last end (the Stop hook sends resume_at itself when it ends). */
export function turnRunning(state) {
  const started = Date.parse(state?.turn_started_at || '') || 0;
  return started > (Date.parse(state?.last_end_at || '') || 0);
}

/** Time of the last commit on the topic's branch (topic/<id>) in its copy, or 0. */
export function topicCommitAt(brainDir, topic) {
  if (!topic?.copy) return 0;
  const r = spawnSync('git', ['-C', path.resolve(brainDir, topic.copy), 'log', '-1', '--format=%cI', `topic/${topic.id}`], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? Date.parse(r.stdout.trim()) || 0 : 0;
}

/**
 * Why open topic `id` stands, or null: its thread has no running turn and its last turn ended with a question for the
 * operator or waiting on the operator, or the topic shows no activity (commit, a turn of its thread: mail rings one) for
 * `stallMs`. Topic index-name 2026-11-14 waited on the operator while a timer for it would have moved silently for 24 h.
 */
export function topicStall(brainDir, id, { stallMs = TOPIC_STALL_MS, now = Date.now(), commitAt = topicCommitAt } = {}) {
  const rec = listTopicRecords(brainDir).find((t) => t.id === id);
  if (!rec) return null;
  const topic = { ...rec.topic, id, holder: rec.holder || null };
  const th = topic.holder?.thread || null;
  const st = th ? readThreadState(brainDir, th) : {};
  if (turnRunning(st)) return null;
  const ended = Date.parse(st.last_end_at || '') || 0;
  const onOperator = st.last_end_state === 'otázka' || (st.last_end_state === 'čakám' && /oper[áa]tor/iu.test(waitOnlyStep(st.last_close?.next) || ''));
  if (ended && onOperator) return { since: st.last_end_at, reason: `its thread's last turn ended ${localTime(ended)} ${st.last_end_state === 'otázka' ? 'with a question for the operator' : 'waiting on the operator'}` };
  const last = Math.max(ended, Date.parse(st.turn_started_at || '') || 0, commitAt(brainDir, topic) || 0, Date.parse(topic.holder?.since || topic.created || '') || 0);
  if (last && now - last >= stallMs) return { since: new Date(last).toISOString(), reason: `no activity (commit, mail, turn) since ${localTime(last)}` };
  return null;
}

/**
 * Decide the bell of a closed thread before the wake module rings it: { action, timer?, reason?, resume? }.
 * - 'rearm': the first due timer has a condition that does not hold before its deadline: moved (`timer`), the turn's
 *   resume_at must go to `resume` ({ next, at }) so no prompt reaches the thread;
 * - 'stall': its topic stands (topicStall): the timer rings now with the model, `reason` names the topic and why
 *   (once per stall: a new one needs new activity of the topic);
 * - 'ring' (the bell goes as it is: no condition, it holds, it cannot run here, deadline), 'none' (nothing due soon),
 *   'running' (an open turn: its Stop sends the time).
 */
export function preRing(brainDir, thread, { now = Date.now(), cwd = process.cwd(), run = untilMet, stallMs = TOPIC_STALL_MS, commitAt = topicCommitAt, lead = TIMER_CHECK_LEAD_MS, skip = () => false } = {}) {
  const state = readThreadState(brainDir, thread);
  if (turnRunning(state)) return { action: 'running' };
  // `skip`: timers moved earlier in the same run (bin/timer-check.mjs checks every due timer of the thread).
  const timer = threadTimers(state).find((t) => Date.parse(t.at) <= now + lead && !skip(t));
  if (!timer) return { action: 'none' };
  if (!timer.until || timer.ring_reason) return { action: 'ring', timer };
  if (timer.stall) return stallRing(brainDir, thread, timer, { now, cwd, run });
  const dl = Date.parse(timer.deadline || '') || 0;
  if (now >= dl) return { action: 'ring', timer, reason: 'deadline' };
  const met = run(timer.until, cwd);
  // A topic timer is a backup: the topic is closed and this thread took its mail since the timer was set, so it goes
  // without a prompt (the prompt hook blocked that bell too, maintainer/workflow-dev 2026-11-14 22:34, wake-picked-check).
  if (met === true && topicResultCame(state, timer)) {
    const left = threadTimers(state).filter((t) => !sameTimer(t, timer));
    writeThreadState(brainDir, thread, { ...state, ...timersPatch(left) });
    return { action: 'drop', timer, resume: { next: left[0]?.then ?? null, at: left[0]?.at ?? null } };
  }
  if (met !== false) return { action: 'ring', timer, reason: met ? 'met' : 'cannot-run' };
  const topic = timerTopic(timer);
  const stall = topic ? topicStall(brainDir, topic, { stallMs, now, commitAt }) : null;
  if (stall && state.topic_stall_rung?.[topic] !== stall.since) {
    const reason = `topic ${topic} stands: ${stall.reason}`;
    const rung = { ...timer, at: new Date(now).toISOString(), ring_reason: reason };
    const list = threadTimers(state).map((t) => (sameTimer(t, timer) ? rung : t));
    writeThreadState(brainDir, thread, { ...state, ...timersPatch(list), topic_stall_rung: { ...(state.topic_stall_rung || {}), [topic]: stall.since } });
    return { action: 'stall', timer: rung, reason, resume: { next: state.last_close?.next || rung.then, at: rung.at } };
  }
  const moved = setTimer(brainDir, thread, { delayMs: Math.min(timer.every_ms || AUTO_TIMER_MS, dl - now), then: timer.then, reason: timer.reason || null, until: timer.until, deadline: timer.deadline, everyMs: timer.every_ms, topic: timer.topic || null, topicSince: timer.topic_since || null }, now);
  const first = threadTimers(readThreadState(brainDir, thread))[0] || moved;
  return { action: 'rearm', timer: moved, resume: { next: state.last_close?.next || first.then, at: first.at } };
}

// Stall check of a handed-off topic (agent-alice/D-0084, operator 2026-11-15): a topic given to another thread (handoff
// record, scripts/handoff.mjs) could stand (its thread had no turn, nothing waited, nothing wrote) and the giver did not
// know: its backup timers had a guessed time (30 min) and too wide a window. The giver gets a timer with a condition
// (`topic.mjs stalled <id>`, code without a model turn) every policy topics.stall_check_minutes (default 5), one per
// topic, without a deadline while the topic is open; it rings once per stall (a new ring needs a new turn of the topic)
// and drops itself once the topic is closed.
export const STALL_CHECK_MS = 5 * 60_000;
/** Minutes of the policy (topics.stall_check_minutes) as ms; 5 min when unset or invalid. */
export const stallCheckMs = (policy) => { const m = Number(policy?.topics?.stall_check_minutes); return m > 0 ? m * 60_000 : STALL_CHECK_MS; };
export const stallCommand = (id) => `node "${path.join(PLUGIN_ROOT, 'bin', 'topic.mjs')}" stalled ${id}`;

/** Arm (or re-arm) the stall check of topic `id` in `thread`: it replaces the earlier one of that topic. */
export function setStallCheck(brainDir, thread, id, { everyMs = STALL_CHECK_MS } = {}, now = Date.now()) {
  return setTimer(brainDir, thread, { delayMs: everyMs, then: `kontrola zastavenia témy ${id} (D-0084)`, until: stallCommand(id), deadline: null, everyMs, stall: id }, now);
}

/**
 * Does open topic `id` stand? { stalled: true, since, next } or { stalled: false, why }. It stands when its holder's thread
 * has no running turn and its last turn ended at least `quietMs` ago, it has no timer and no continuation ahead (resume_at,
 * a background task or a schedule), it waits for no reply (`awaitingReply(id, now)`: mail the topic sent has the mail's
 * next check ahead, D-0084 with P-072) and no mail waits for the topic (`mailWaiting(id)`). A paused topic does not stand;
 * a topic nobody holds stands since it was created or released.
 */
export function topicStalled(brainDir, id, { quietMs = STALL_CHECK_MS, now = Date.now(), mailWaiting = () => false, awaitingReply = () => false } = {}) {
  const rec = listTopicRecords(brainDir).find((t) => t.id === id);
  if (!rec) return { stalled: false, why: 'closed' };
  if (rec.topic?.state === 'paused') return { stalled: false, why: 'paused' };
  const th = rec.holder?.thread || null;
  const st = th ? readThreadState(brainDir, th) : {};
  if (turnRunning(st)) return { stalled: false, why: 'turn running' };
  // Since its last turn ended; a thread without a turn yet since it took the topic (or the topic was created).
  const last = Date.parse(st.last_end_at || '') || Math.max(Date.parse(rec.holder?.since || '') || 0, Date.parse(rec.topic?.created || '') || 0);
  if (last && now - last < quietMs) return { stalled: false, why: `last turn ended ${localTime(last)}, under ${Math.round(quietMs / 60_000)} min ago` };
  const ahead = (iso) => (Date.parse(iso || '') || 0) > now;
  if (threadTimers(st).some((t) => ahead(t.at))) return { stalled: false, why: 'timer set' };
  if (ahead(st.last_close?.resume_at)) return { stalled: false, why: 'continuation set (resume_at)' };
  if ((st.wakers || []).some((w) => w.recurring || ahead(w.until))) return { stalled: false, why: 'background task or schedule' };
  if (awaitingReply(id, now)) return { stalled: false, why: 'waits for a reply' };
  if (mailWaiting(id)) return { stalled: false, why: 'mail waits for the topic' };
  return { stalled: true, since: new Date(last || now).toISOString(), next: st.last_close?.next || null };
}

/**
 * The stall check before its ring (preRing; the prompt hook as a backup): 'drop' (the topic is closed: the timer goes
 * without a ring), 'rearm' (it does not stand, or this stall already rang: the next check in every_ms), or 'stall' (a plain
 * timer with the step rings now, the check is armed again).
 */
export function stallRing(brainDir, thread, timer, { now = Date.now(), cwd = process.cwd(), run = untilMet } = {}) {
  const id = timer.stall;
  const state = readThreadState(brainDir, thread);
  const others = threadTimers(state).filter((t) => !sameTimer(t, timer));
  if (!listTopicRecords(brainDir).some((t) => t.id === id)) {
    writeThreadState(brainDir, thread, { ...state, ...timersPatch(others) });
    return { action: 'drop', timer, resume: { next: others[0]?.then ?? null, at: others[0]?.at ?? null } };
  }
  const everyMs = timer.every_ms || STALL_CHECK_MS;
  const rearm = () => {
    const moved = setStallCheck(brainDir, thread, id, { everyMs }, now);
    const first = threadTimers(readThreadState(brainDir, thread))[0] || moved;
    return { action: 'rearm', timer: moved, resume: { next: state.last_close?.next || first.then, at: first.at } };
  };
  if (run(timer.until, cwd) !== true) return rearm();
  // `topic.mjs stalled` checked it all (also its mail); here only since when and with which step, once per stall.
  const info = topicStalled(brainDir, id, { quietMs: 0, now });
  if (!info.stalled || state.stall_rung?.[id] === info.since) return rearm();
  const step = `téma ${id} stojí od ${localTime(info.since)}: ${info.next || '-'}; zisti prečo a pohni ju (D-0084)`;
  const rung = { at: new Date(now).toISOString(), then: step.slice(0, 300), set_at: new Date(now).toISOString() };
  writeThreadState(brainDir, thread, { ...state, ...timersPatch([...others, rung]), stall_rung: { ...(state.stall_rung || {}), [id]: info.since } });
  setStallCheck(brainDir, thread, id, { everyMs }, now);
  return { action: 'stall', timer: rung, reason: `topic ${id} stands since ${localTime(info.since)}`, resume: { next: rung.then, at: rung.at } };
}

/** Threads of this machine with a timer under a condition (timer.mjs --until | --topic): the wake job checks them all. */
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
  const file = timerIndexFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(idx, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
