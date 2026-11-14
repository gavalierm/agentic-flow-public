// Work never stops (P-061, operator 2026-11-03/08): no message, question or event stops the work; it may only be deferred
// to a set time. A turn that declares "Stav: čakám" is rung again by a waker armed by code: the thread timer (bin/timer.mjs,
// rung by the wake module through the closed turn's resume_at), a background task or agent (the harness re-invokes the
// thread), a harness scheduler (schedule_task, CronCreate, ScheduleWakeup), or mail sent with a pickup deadline. Without one
// the Stop hook arms the timer itself with the wait target, no block: 7 of 8 such blocks only led to timer.mjs (audit
// 2026-11-11). A timer with a condition (--until) is checked by the prompt hook without a model call until it holds.
// The reply is never read as prose here (scripts/protocol.mjs reads its state line); only the handover's next step is.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readThreadState, writeThreadState } from './config.mjs';
import { PLUGIN_ROOT } from './util.mjs';

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
/** Reply window after sending mail that needs an answer: the sender is rung then even if nobody replied. */
export const REPLY_WINDOW_MS = { blocker: 15 * 60_000, assist: 60 * 60_000 };
/** Sender timer after an interim reply, [first, max] (doubles per unchanged check): `otázka` waits on the recipient's operator (hours), `čakám` on an event. */
export const REPLY_STATE_TIMER_MS = { otázka: [OPERATOR_TIMER_MS, OPERATOR_TIMER_MAX_MS], čakám: [REPLY_WINDOW_MS.assist, 4 * 3600_000] };

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
  // The mail waker names its message: the final reply or the no-reply/undelivered bell of it spends it (withoutMailWaker).
  const sent = /(^|\n)sent (\S+)/.exec(respText)?.[2];
  if ((tool === 'Bash' || tool === 'PowerShell') && /comms\.mjs\s+send\b/.test(String(ti.command || '')) && !/--reply-to/.test(String(ti.command || '')) && sent) return { ...bg('mail'), for: sent };
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

/** A waker for this turn: armed since the turn started, still running, or the thread timer ahead. */
export function validWaker(state, now = Date.now()) {
  const timer = activeTimer(state, now);
  if (timer) return { kind: 'timer', at: timer.at };
  const started = Date.parse(state?.turn_started_at || '') || 0;
  return (state?.wakers || []).find((w) => w.recurring || Date.parse(w.at) >= started || (w.until && Date.parse(w.until) > now)) || null;
}

/** Wakers without the mail waker of message `id`: its final reply or its no-reply/undelivered bell spends it (pilot 2026-11-12:
 * left for 2 h after the no-reply bell, it kept Stop from arming the timer of a later "Stav: čakám (na …)"). */
export const withoutMailWaker = (wakers, id) => (wakers || []).filter((w) => !(w.kind === 'mail' && id && w.for === id));

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
 * timers stay, none is lost (2026-11-13); it replaces only its own earlier entry: the same message (`forId`), the same step of
 * a plain timer, or the auto timer of code (any own timer of the agent replaces that one, it only stood in for a waker). */
export function setTimer(brainDir, thread, { delayMs, then, reason = null, auto = false, forId = null, until = null, deadline = null, everyMs = null }, now = Date.now()) {
  const ms = Math.min(Math.max(delayMs, TIMER_MIN_MS), TIMER_MAX_MS);
  const state = readThreadState(brainDir, thread);
  // A condition (--until): the prompt hook runs it at `at` and rings the model only when it holds or `deadline` passed.
  const cond = until ? { until: String(until).slice(0, 300), deadline, every_ms: everyMs || ms } : {};
  const timer = { at: new Date(now + ms).toISOString(), then: String(then || '').slice(0, 300), set_at: new Date(now).toISOString(), ...(reason ? { reason } : {}), ...(auto ? { auto: true } : {}), ...(forId ? { for: forId } : {}), ...cond };
  const replaced = (t) => t.auto || (forId ? t.for === forId : !t.for && t.then === timer.then);
  writeThreadState(brainDir, thread, { ...state, ...timersPatch([...threadTimers(state).filter((t) => !replaced(t)), timer]), ...(auto ? {} : { auto_timer_n: 0 }) });
  return timer;
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

