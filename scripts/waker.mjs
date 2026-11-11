// Work never stops (P-061, operator 2026-11-03/08): no message, question or event stops the work; it may only be deferred
// to a set time. A turn that declares "Stav: čakám" needs a real waker armed by code: the thread timer (bin/timer.mjs,
// rung by the wake module through the closed turn's resume_at), a background task or agent (the harness re-invokes the
// thread), a harness scheduler (schedule_task, CronCreate, ScheduleWakeup), or mail sent with a pickup deadline. The Stop
// hook blocks such an end without one and, if the agent ends anyway, arms the timer itself, so no thread is left idle.
// The reply is never read as prose here (scripts/protocol.mjs reads its state line); only the handover's next step is.
import path from 'node:path';
import { readThreadState, writeThreadState } from './config.mjs';
import { PLUGIN_ROOT } from './util.mjs';

export const TIMER_CMD = `node ${path.join(PLUGIN_ROOT, 'bin', 'timer.mjs')}`;

export const TIMER_MIN_MS = 60_000;
export const TIMER_MAX_MS = 24 * 3600_000;
/** Background work notifies the thread when done; it counts as a waker this long. */
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

/** Waker an agent armed with this tool call (PostToolUse input), or null. */
export function wakerFromTool(input, now = Date.now()) {
  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input || {};
  const resp = input?.tool_response;
  const respText = typeof resp === 'string' ? resp : typeof resp?.stdout === 'string' ? resp.stdout : JSON.stringify(resp || {}).slice(0, 2000);
  const at = new Date(now).toISOString();
  const bg = (kind) => ({ kind, at, until: new Date(now + BACKGROUND_WAKER_MS).toISOString() });
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
  if ((tool === 'Bash' || tool === 'PowerShell') && /comms\.mjs\s+send\b/.test(String(ti.command || '')) && !/--reply-to/.test(String(ti.command || '')) && /(^|\n)sent \S+/.test(respText)) return bg('mail');
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

/** Thread timer still ahead, or null. */
export function activeTimer(state, now = Date.now()) {
  const t = state?.timer;
  return t && Date.parse(t.at) > now ? t : null;
}

/** A waker for this turn: armed since the turn started, still running, or the thread timer ahead. */
export function validWaker(state, now = Date.now()) {
  const timer = activeTimer(state, now);
  if (timer) return { kind: 'timer', at: timer.at };
  const started = Date.parse(state?.turn_started_at || '') || 0;
  return (state?.wakers || []).find((w) => w.recurring || Date.parse(w.at) >= started || (w.until && Date.parse(w.until) > now)) || null;
}

export function recordWaker(brainDir, thread, waker) {
  if (!brainDir || !thread || !waker) return;
  const state = readThreadState(brainDir, thread);
  const now = Date.now();
  // A removed schedule drops its waker (by id; without an id every recurring one, the safe side: auto timers return).
  const removed = (w) => waker.remove && w.recurring && (!waker.id || !w.id || w.id === waker.id);
  const keep = (state.wakers || []).filter((w) => !removed(w) && (w.recurring || (w.until && Date.parse(w.until) > now))).slice(-20);
  writeThreadState(brainDir, thread, { ...state, wakers: waker.remove ? keep : [...keep.filter((w) => !(waker.id && w.id === waker.id)), waker] });
}

/** Set the thread timer: the wake module rings the thread at `at` with the step `then` (via the closed turn, P-061). */
export function setTimer(brainDir, thread, { delayMs, then, reason = null, auto = false, forId = null }, now = Date.now()) {
  const ms = Math.min(Math.max(delayMs, TIMER_MIN_MS), TIMER_MAX_MS);
  const state = readThreadState(brainDir, thread);
  const timer = { at: new Date(now + ms).toISOString(), then: String(then || '').slice(0, 300), set_at: new Date(now).toISOString(), ...(reason ? { reason } : {}), ...(auto ? { auto: true } : {}), ...(forId ? { for: forId } : {}) };
  writeThreadState(brainDir, thread, { ...state, timer, ...(auto ? {} : { auto_timer_n: 0 }) });
  return timer;
}

export function clearTimer(brainDir, thread) {
  const state = readThreadState(brainDir, thread);
  if (!state.timer) return false;
  const { timer, ...rest } = state;
  writeThreadState(brainDir, thread, rest);
  return true;
}

export const WAIT_REASON = (what) => `the reply ${what} but no waker is armed: work must never stop (P-061). Either continue the work now (decide with your recommended option and say it; the operator may override later), or arm a real timer before ending: ${TIMER_CMD} --in <minutes>m --then "<the step to do when it fires>" (or mail with a deadline, a background task, schedule_task). Writing "čakám" without a timer is forbidden`;
