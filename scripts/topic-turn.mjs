// The end of a turn and the continuation of a topic (flow v2 spec 10.2, 10.3, 4.2.4): the facts of each held topic (its
// handover: Ďalší krok, Otvorené otázky, Úlohy pre operátora; the alarms of the thread), the `turn` fields the Stop hook
// writes into `.tema.json`, the count of continuation wakes without progress with its cap (`topics.continue_max`) and the
// stuck mark, and the lock check after the pull (save, the state written at the end of a turn and a wake check it first).
// The reply text is never read here; the hook checks the reply's state line against these facts.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readThreadState, writeThreadState } from './config.mjs';
import { handoverNextStep, handoverQuestions, handoverTasks } from './brain-checks.mjs';
import { turnAlarms, turnFields } from './topic-state.mjs';
import { fieldsOp, holderFileRel } from './topic-files.mjs';
import { syncAndCheckHolder, checkHolder } from './brain.mjs';
import { threadTimers, TIMER_MAX_MS } from './waker.mjs';

/**
 * Plan O2: the continuation goes to the mail with resume_at (end of the turn + this), so the mail rings it also with the same
 * step. 10 s, not 60 s (operator 2026-11-17, P-079: "čakám (na pokračovanie)" and nothing happened for 2 min).
 */
export const CONTINUE_RESUME_MS = 10_000;
/** Default of `topics.continue_max` (plan O23): continuation wakes without progress; the one that reaches it is the last. */
export const CONTINUE_MAX = 3;

export const continueMax = (policy) => {
  const n = Number(policy?.topics?.continue_max);
  return Number.isInteger(n) && n > 0 ? n : CONTINUE_MAX;
};

const time = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

/**
 * The alarms of the thread (spec 13 budík) as inputs of turnAlarms: its timers (each its time), its background tasks and
 * schedules (a waker armed by a tool: its limit `until`, a recurring schedule without one TIMER_MAX_MS from now), the mail's
 * waits for answers (`obligations.awaiting` with `wait_due_at`). Wakers already spent (their task ended) are left out by the caller.
 */
export function threadAlarms(state, mail, now = Date.now()) {
  const timers = threadTimers(state).map((t) => ({ at: t.at }));
  const started = time(state?.turn_started_at) || 0;
  const background = (state?.wakers || [])
    .filter((w) => w.recurring || (w.until && time(w.until) > now) || (time(w.at) || 0) >= started)
    .map((w) => ({ at: w.until || new Date(now + TIMER_MAX_MS).toISOString() }));
  const awaiting = (mail?.awaiting || []).filter((a) => a?.wait_due_at).map((a) => ({ id: a.id, wait_due_at: a.wait_due_at }));
  return { timers, background, awaiting };
}

/**
 * The facts of one held topic (10.2): `next` (items of Ďalší krok; none while the topic is paused, its end is an alarm),
 * `questions` and `tasks` (item counts, null when the handover lacks the section), `alarms` (turnAlarms over the thread's
 * alarms, the continuation at `turnEnd` when no timer or task runs). The thread's alarms belong to each topic it holds.
 */
export function topicFacts(topic, alarmsIn = {}, { turnEnd = Date.now(), now = Date.now() } = {}) {
  const handover = topic?.handover || '';
  const paused = topic?.state === 'paused';
  const next = paused ? [] : handoverNextStep(handover) || [];
  const questions = handoverQuestions(handover);
  const tasks = handoverTasks(handover);
  const timers = [...(alarmsIn.timers || [])];
  if (paused && time(topic.paused_until) > now) timers.push({ at: topic.paused_until });
  const alarms = turnAlarms({ next, timers, background: alarmsIn.background || [], awaiting: alarmsIn.awaiting || [], turnEnd: new Date(turnEnd).toISOString() });
  return { next, questions: questions === null ? null : questions.length, questionItems: questions || [], tasks: tasks === null ? null : tasks.length, alarms };
}

/** The open questions of the held topics as one key: the operator saw them (their turn or a dialog) when it is unchanged. */
export const questionsKey = (facts) => facts.flatMap((f) => (f.facts.questionItems || []).map((q) => `${f.topic.id}\u0000${String(q).trim()}`)).sort().join('\u0001');

/** The `turn` fields of the facts (state and alarm time): turnFields with a missing section counted as none. */
export const factsFields = (facts) => turnFields({ next: facts.next, questions: facts.questions || 0, tasks: facts.tasks || 0, alarms: facts.alarms });

/**
 * Fingerprint of the commits of a topic: the heads of its branch `topic/<id>` and of its task branches `topic/<id>--*`
 * in its code copy (`copy` is relative to the project dir; '' without a copy). A changed fingerprint is progress (a
 * commit of the topic or of a task). `ctx`: { brainDir, projectDir }.
 */
export function branchHeads(ctx, topic) {
  if (!topic?.copy || !topic?.id) return '';
  const r = spawnSync('git', ['-C', path.resolve(ctx?.projectDir || ctx?.brainDir || '.', topic.copy), 'for-each-ref', '--format=%(refname:short) %(objectname)', `refs/heads/topic/${topic.id}`, `refs/heads/topic/${topic.id}--*`], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort().join(';') : '';
}

/**
 * Progress of the topic since the last counted continuation (10.2): a commit of its branch or a task branch (fingerprint),
 * or a progress event of this thread after the count (`progress_at`: a save of any type except the handover, a message
 * picked up, an operator prompt in the thread). False when nothing was counted.
 */
export function progressed(ctx, topic, state) {
  const c = topic?.turn?.continues;
  if (!c || typeof c !== 'object') return false;
  if ((time(state?.progress_at) || 0) > (time(c.at) || 0)) return true;
  return branchHeads(ctx, topic) !== String(c.heads ?? '');
}

/** Records a progress event of this thread (save, pickup of a message, operator prompt): the next count starts from zero. */
export function markProgress(brainDir, thread, now = Date.now()) {
  if (!brainDir || !thread) return;
  writeThreadState(brainDir, thread, { ...readThreadState(brainDir, thread), progress_at: new Date(now).toISOString() });
}

/**
 * A continuation wake (`continue from handover`, no timer rang it): one more count for each held topic whose handover has
 * a next step, from zero after progress. The wake that reaches `max` is the last: its topic is stuck with every item of
 * Ďalší krok in the handover at this time. Returns { ops, counts: [{ id, n, stuck: items|null }] }; the caller writes the ops.
 */
export function countContinue(ctx, topics, state, { max = CONTINUE_MAX, now = Date.now() } = {}) {
  const ops = [];
  const counts = [];
  for (const t of topics) {
    const items = t?.state === 'paused' ? [] : handoverNextStep(t?.handover || '') || [];
    if (!items.length) continue;
    const c = t.turn?.continues;
    const fresh = !c || progressed(ctx, t, state);
    const n = (fresh ? 0 : Number(c.n) || 0) + 1;
    const stuck = n >= max ? items : fresh ? null : t.turn?.stuck ?? null;
    ops.push(fieldsOp(ctx.brainDir, t.id, { turn: { continues: { n, at: new Date(now).toISOString(), heads: branchHeads(ctx, t) }, stuck } }));
    counts.push({ id: t.id, n, stuck: n >= max ? items : null });
  }
  return { ops, counts };
}

/** The line of the wake that reached the cap (10.2): the stuck steps go to Otvorené otázky and into Otázky na operátora. */
export const STUCK_LINE = (counts, max) => `stuck: ${counts.map((c) => `topic ${c.id} reached ${c.n} continuation wakes without progress (topics.continue_max ${max}); its next steps are marked stuck in .tema.json: ${c.stuck.map((s) => `"${String(s).slice(0, 120)}"`).join(', ')}`).join('; ')}. This is the last continuation wake: move every one of these steps into Otvorené otázky (save.mjs handover <topic> with the whole handover, the steps as --questions and no --next), ask them under **Otázky na operátora:**, and end with the state the facts give, usually "**Stav:** otázka" (spec 10.2)`;

/**
 * The fields the Stop hook writes for one held topic at the end of a released turn: the state and alarm time from the
 * facts; after progress the count and the stuck mark are cleared. Null when nothing changed (no write, no push: plan risk 4.7).
 */
export function turnUpdate(ctx, topic, facts, state) {
  const f = factsFields(facts);
  const turn = topic?.turn && typeof topic.turn === 'object' ? topic.turn : {};
  const patch = {};
  if (turn.state !== f.state) patch.state = f.state;
  if ((turn.alarm_at ?? null) !== f.alarm_at) patch.alarm_at = f.alarm_at;
  if ((turn.continues || turn.stuck) && progressed(ctx, topic, state)) { patch.continues = null; patch.stuck = null; }
  return Object.keys(patch).length ? patch : null;
}

/** The topic is stuck and nothing moved since: Stop closes the turn without its step (10.2, plan O2). */
export const stuckNow = (ctx, topic, state) => Array.isArray(topic?.turn?.stuck) && topic.turn.stuck.length > 0 && !progressed(ctx, topic, state);

/**
 * Spec 4.2.4: the lock of each topic in `ids` after a pull (syncAndCheckHolder of scripts/brain.mjs: sync once, then the
 * holder record of each). Returns { held: ids still held by this thread here, lost: [{ id, reason }] }.
 */
export function verifyLocks(ctx, ids) {
  const lost = [];
  let synced = false;
  for (const id of ids) {
    const rel = holderFileRel(ctx.brainDir, id);
    const err = synced ? checkHolder(ctx.brainDir, rel, ctx.thread) : syncAndCheckHolder(ctx.brainDir, rel, ctx.thread);
    synced = true;
    if (err) lost.push({ id, reason: err });
  }
  return { held: ids.filter((id) => !lost.some((l) => l.id === id)), lost };
}

/** Spec 4.2.4: a thread that lost the lock writes nothing into the topic and says so in its reply. */
export const LOCK_LOST_LINE = (lost) => `lock lost: ${lost.map((l) => `topic ${l.id} (${l.reason})`).join('; ')}: this thread no longer holds it, so nothing of it is written (no save, no handover, no state); say so in your reply and do not continue its work (spec 4.2.4)`;
