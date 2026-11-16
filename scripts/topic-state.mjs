// State of a topic from facts (flow v2 spec 10.2): the next step of the handover, the items of its sections Otvorené
// otázky and Úlohy pre operátora, and the wakers (alarms) that run. Pure functions without I/O: the Stop hook computes the
// state at the end of a turn and writes it with the alarm time into `.tema.json` (`turn`, topic-files.mjs fieldsOp);
// the supervisor's overview and the lock read it from there. The state line of the reply is checked against the same facts.
// The mail's state of a message never enters (spec kap. 9): of the mail only `obligations.awaiting` with `wait_due_at`.

export const DONE = 'hotovo';
export const QUESTION = 'otázka';
export const WAITING = 'čakám';
export const TURN_STATES = [DONE, QUESTION, WAITING];

/** Kinds of an alarm (spec 13 budík): a timer, a wait for an answer by mail, a background task, the continuation. */
export const ALARM_KINDS = ['timer', 'mail', 'task', 'continue'];

const count = (v) => (Array.isArray(v) ? v.length : Number(v) > 0 ? Number(v) : 0);
const time = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * State of one topic (10.2 points 1 to 3): `čakám` when the handover has a next step or an alarm runs; else `otázka`
 * when an item is in Otvorené otázky or Úlohy pre operátora; else `hotovo`. `next` is the list of next-step items (or
 * their count), `questions` and `tasks` the items (or counts) of the two sections, `alarms` the running alarms.
 */
export function computeState({ next = [], questions = 0, tasks = 0, alarms = [] } = {}) {
  if (count(next) > 0 || count(alarms) > 0) return WAITING;
  if (count(questions) + count(tasks) > 0) return QUESTION;
  return DONE;
}

/**
 * State over several held topics (10.2, 1.1.2): `čakám` when one topic has it, else `otázka` when one has it, else
 * `hotovo`. Each element is a state or the facts of one topic (computeState). No topic: `hotovo`.
 */
export function summaryState(topics = []) {
  const states = topics.map((t) => (typeof t === 'string' ? t : computeState(t)));
  if (states.includes(WAITING)) return WAITING;
  if (states.includes(QUESTION)) return QUESTION;
  return DONE;
}

/**
 * The running alarms of a topic with their times (spec 13): a timer its time (`timers[].at`), a background task its
 * limit (`background[].at`), a wait for an answer by mail the next check of the server (`awaiting[].wait_due_at`; an
 * entry without it does not wait), the continuation (a next step in the handover) the end of the turn (`turnEnd`) when
 * no timer and no background task runs: then that alarm wakes the thread and the step runs after it (10.2 point 1).
 * Mail does not hold the continuation back (3.3.3). Only the obligations of the topic's own messages belong here.
 */
export function turnAlarms({ next = [], timers = [], background = [], awaiting = [], turnEnd = null } = {}) {
  const out = [];
  for (const t of timers) if (time(t?.at) !== null) out.push({ kind: 'timer', at: new Date(time(t.at)).toISOString(), ...(t.id ? { id: t.id } : {}) });
  for (const b of background) if (time(b?.at) !== null) out.push({ kind: 'task', at: new Date(time(b.at)).toISOString(), ...(b.id ? { id: b.id } : {}) });
  for (const a of awaiting) if (time(a?.wait_due_at) !== null) out.push({ kind: 'mail', at: new Date(time(a.wait_due_at)).toISOString(), ...(a.id ? { id: a.id } : {}) });
  const held = out.some((a) => a.kind === 'timer' || a.kind === 'task');
  if (count(next) > 0 && !held && time(turnEnd) !== null) out.push({ kind: 'continue', at: new Date(time(turnEnd)).toISOString() });
  return out;
}

/** The alarm with the earliest time (10.2: with several alarms the earliest time is written), or null. */
export function earliestAlarm(alarms = []) {
  let best = null;
  for (const a of alarms) {
    const t = time(a?.at);
    if (t === null) continue;
    if (!best || t < time(best.at)) best = a;
  }
  return best;
}

/**
 * The `turn` fields of `.tema.json` from the facts (O1): `state` (computeState) and `alarm_at` (earliest alarm, null
 * without one). `stuck` and `continues` are written by the continuation counter (B4), not here.
 */
export function turnFields({ next = [], questions = 0, tasks = 0, alarms = [] } = {}) {
  const alarm = earliestAlarm(alarms);
  return { state: computeState({ next, questions, tasks, alarms }), alarm_at: alarm ? new Date(time(alarm.at)).toISOString() : null };
}
