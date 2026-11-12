#!/usr/bin/env node
// Stop: closes the turn record for keepalive (P-043, with the turn's opened_at); one brain write per turn for buffered logs
// (P-030); signals are queued for the next prompt (P-023 c), each skill proposal once per thread. A missing reply is found by the message TTL in the mail service (P-042, P-046), not here.
// Picked assist (P-042, 2026-11-02): an assist message this thread picked up (`comms receive`) and has given no reply state
// (`send --reply-to --state`) is one queued line at the stop, not a block: the answer is due, the turn may still end.
// One answered `otázka` or `čakám` is not reminded: its sender knows the state, the final `hotovo` follows.
// Reply protocol (P-061, operator 2026-11-08): the final reply declares its state on the last line, `Stav: hotovo|otázka|čakám`;
// the hook reads only that line and checks it against facts, in every turn (bell turns too), never the wording of the reply:
// no state, a step written as prose ("Ostáva: …", operator 2026-11-09), items under **Otázky na operátora:** / **Úlohy pre operátora:** with a state other than
// `otázka`, the old **Operátor:** heading or an empty section (once), `otázka` without such an item or asked as text and not in the dialog (AskUserQuestion, so T3 shows "Awaiting Input",
// operator 2026-11-08), `čakám` without what it waits for (`Stav: čakám (na <čo>)`,
// operator 2026-11-08) or without a waker armed by code, or `hotovo` while the
// held work topic's handover has a next step blocks the stop once. Ending anyway keeps the loop alive: `otázka` and `čakám`
// get the thread timer (operator wait in hours, a job in minutes), an unfinished step the continue ring (P-026).
// Mistake (P-003, operator 2026-11-03): a reply that says something happened by mistake ("omylom", "by mistake") names an
// error; the stop is blocked once, also in bell turns: handle it with workflow:error (fix, skill or rule, report).
import { readHookInput, emit, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState, writeThreadState } from '../scripts/config.mjs';
import { pendingT3Line } from '../scripts/wizard.mjs';
import { logDecision } from '../scripts/denials.mjs';
import { flushBuffer, proposalKey } from '../scripts/logs.mjs';
import { unpushedCount, brainSync, oldestUnpushedAgeMs } from '../scripts/brain.mjs';
import { recordTurn, isMainTopic } from '../scripts/comms.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { parseReply, repeatsAnswered, REPEATED_QUESTION_REASON } from '../scripts/protocol.mjs';
export { REPEATED_QUESTION_REASON };
import { TOPIC_QUESTION } from '../scripts/boot.mjs';
import { waitOnlyStep, validWaker, activeTimer, setTimer, clearTimer, AUTO_TIMER_MS, AUTO_TIMER_MAX_MS, OPERATOR_TIMER_MS, OPERATOR_TIMER_MAX_MS, IDLE_RING_MS } from '../scripts/waker.mjs';

export const HOOK_META = { event: 'Stop', class: 'c', limit: '2 lines (queued to next prompt); 1 block reason', principles: ['P-003', 'P-026', 'P-030', 'P-040', 'P-042', 'P-043', 'P-061'] };

// A recommended option is chosen only inside the asked work: an offered change the operator did not ask for waits for them (flow-public#25).
export const AUTO_TIMER_THEN = 'the last turn ended waiting without a timer: continue the asked work now; decide with your recommended option, except an offered change the operator did not ask for: that waits for their answer (P-061, P-002)';
// "Stav: čakám" without a waker is not blocked: the timer carries what the turn waits for (7 of 8 such blocks only led to
// timer.mjs, audit 2026-11-11).
export const WAIT_TIMER_THEN = (what) => `the last turn ended "Stav: čakám (${String(what).replace(/\s+/g, ' ').trim().slice(0, 120)})" without a waker: check it now; if it came, continue the work; if not, end with the same state, the timer comes back later (P-061)`;

// T3 shows the operator only the last message of a turn and folds the earlier ones under "Worked for …": a note written
// after a block hid the answer (operator 2026-11-03: "the payload I want is hidden, I get the operational message").
export const FINAL_REPLY = 'The operator sees only your last message of this turn (earlier ones are folded away): end with the complete answer (the result, links, items for the operator; corrected where it changed) and its state line, never with only the state line. Never write about this hook, a timer, a waker or IDs (P-061)';
// flow-public#37: after a block the reply was only its state line and the result stayed in an earlier, folded message.
export const STATE_ONLY_REASON = 'the last message of this turn is only its state line: the answer stayed in an earlier message the operator does not see (P-061, flow-public#37)';

// flow-public#25 (2026-11-10): the operator asked how to hand a task to another agent; "do it now" made the agent create and
// deploy a skill nobody asked for. Every "do it" here is bound to the work the operator asked for; a proposal stays an offer.
export const OFFER = 'Only work the operator asked for is done now; a change they did not ask for (their prompt asked a question, for advice, a proposal or to find something out) is never done: offer it as an item "- [ ] <…>" under **Otázky na operátora:** with "Stav: otázka" (P-002, P-063)';
const STATES_HELP = 'hotovo = nothing is left, neither for you nor for the operator (the handover has no next step, no item for the operator); otázka = what only the operator decides or confirms is an item "- [ ] <…>" under **Otázky na operátora:**, what only the operator does (login, install, a click) an item under **Úlohy pre operátora:** (omit a heading with no item), and the first asked with AskUserQuestion (your recommended option first) so T3 shows it; čakám = an event with a waker armed by code, written "Stav: čakám (na <what>)" (<plugin>/bin/timer.mjs --in <min>m --then "<step>", mail with a deadline, run_in_background, schedule_task). A promise ("I will do it later", "at your next message") is no state: do the asked work now. ' + OFFER;
export const NO_STATE_REASON = `the final reply has no state line: end it with exactly one line "Stav: hotovo", "Stav: otázka" or "Stav: čakám (na <what>)" (P-061). ${STATES_HELP}`;
export const NO_QUESTION_REASON = `the reply declares "Stav: otázka" but has no item under **Otázky na operátora:** or **Úlohy pre operátora:**: list there what only the operator decides or confirms (questions) or does (tasks) ("- [ ] <…>", a choice with your recommended option), or declare the state that is true (P-061). ${STATES_HELP}`;
// Operator 2026-11-09: carol ended "Ostáva: … zmažem ho až na tvoje potvrdenie" with "Stav: hotovo"; a step is protocol,
// never a sentence.
export const STEP_REASON = (step) => `the reply writes a step as prose ("${step}"), outside the protocol: a step of the asked work is done now, or saved with save handover --next and the state "Stav: čakám (na <what>)" with a waker; what the operator decides or confirms is an item "- [ ] <…>" under **Otázky na operátora:**, what only the operator does an item under **Úlohy pre operátora:**, with "Stav: otázka" (P-061). ${STATES_HELP}`;
export const OPERATOR_STATE_REASON = (state, item) => `the reply lists for the operator "${item}" under **Otázky na operátora:** / **Úlohy pre operátora:** but declares "Stav: ${state}": what waits on the operator is "Stav: otázka", asked with AskUserQuestion, or "Stav: čakám (na <event>)" with a waker when the turn waits on an event and the item can wait (D-0011); if it is part of the asked work and you can do it yourself, do it and drop the item (P-061, P-058); a change the operator did not ask for stays an item, with "Stav: otázka". ${STATES_HELP}`;
export const LEGACY_HEADING_REASON = `the reply uses the old heading **Operátor:**: split it into **Otázky na operátora:** (decisions and confirmations only the operator has, also asked with AskUserQuestion) and **Úlohy pre operátora:** (steps only the operator does: login, install, a click in a UI); omit the heading that has no item (P-061)`;
export const EMPTY_SECTION_REASON = (heading) => `the reply has the heading ${heading} with no item: omit a section that has nothing in it, and write it only with items "- [ ] <…>" (P-061)`;
// flow-public#35: PreToolUse refused the dialog of this turn as a repeat and the agent asked in text: a repeat of the dialog passes.
export const DIALOG_AFTER_REPEAT = 'the dialog was refused in this turn as a repeat of an answered question: when his decision does not cover this step (a serious step, another scope), ask the same dialog again now, the repeat passes; when it covers the step, act on it and end without the question (P-059)';
export const DIALOG_REASON = `the reply asks the operator in text, which is lost in the thread among other turns: ask the one decision only the operator has with AskUserQuestion now (your recommended option first, what it decides about in the dialog: the open dialog covers the text of the turn), so T3 shows the thread as "Awaiting Input"; after the answer continue the work. The items under the operator headings stay in the reply; the dialog asks the first one, the further ones in the same dialog (up to 4 questions): a second dialog right after the answer covers the thread again (P-061, operator 2026-11-08, flow-public#45). ${STATES_HELP}`;
// P-050 (operator 2026-11-08): "Chcem riešiť tému predaja pneumatík" got "<project> / bez témy" as the first reply and the work
// went on without a topic; the status block of a thread without a topic is only for a topic that stays unknown.
export const STALE_STATUS_REASON = (project, id) => `the reply shows "${project} / bez témy", but this thread holds topic ${id}: start the reply with "${project} / ${id}", without the list of topics and without the topic question (P-050)`;
export const NO_TOPIC_REASON = (project) => `the reply shows "${project} / bez témy" and goes on without a topic: if the operator's prompt names the topic or starts work, claim it or create it now (topic.mjs create <id> --subject "<subject>" claims it, skill workflow:topic) and start the reply with "${project} / <id>"; if the topic is unknown or you only propose one (the prompt asks for a proposal or says to change nothing), do not create it: end with "**Otázky na operátora:** Aká bude téma? (návrh: <id>)", the same question in AskUserQuestion, and "Stav: otázka" (P-050)`;
export const NO_WAIT_TARGET_REASON = `the reply declares "Stav: čakám" but not what it waits for: write the state line as "Stav: čakám (na <what>)", e.g. "Stav: čakám (na výsledok pracovníka)" (P-061, operator 2026-11-08)`;
export const NEXT_STEP_REASON = (topic, next) => `the reply declares "Stav: hotovo", but the handover of topic ${topic} has a next step: "${next}". Do it now in this turn. If it waits for an event, arm a waker and declare "Stav: čakám (na <what>)"; if it needs the operator, ask with AskUserQuestion; if it is done, save the handover without it (P-061, P-026)`;

// Words that admit a mistake (sk, cs, en). `\b` is ASCII-only, so letter boundaries use \p{L}.
const MISTAKE = /(?<!\p{L})(omylom|omylem|nedopatrením|nechtiac|by mistake|accidentally|mistakenly|inadvertently|unintentionally)(?!\p{L})/iu;

// A word next to the hit that makes it a guard or a negation, not an admission (alice 2026-11-07: "či sa skill
// nespúšťa omylom" in a design was blocked): sk/cs negated verb (ne-), nie, aby, či, not, never, avoid, prevent, without.
const GUARD = /^(ne\p{L}{2,}|nie|aby|či|zda|nič|nic|not|never|nothing|no|avoid\p{L}*|prevent\p{L}*|without|doesn't|don't|won't|isn't)$/iu;
const NOT_NEGATION = /^(nedávno|nejak\p{L}*|neskôr|nedeľ\p{L}*|nech|než|nedopatrením|nechtiac)$/iu;

function admits(plain, m) {
  const words = (s) => s.split(/[^\p{L}']+/u).filter(Boolean);
  // Only within the clause: "omylom, nie zámerne" is still an admission.
  const before = plain.slice(Math.max(0, m.index - 40), m.index).split(/[,.;:!?\n]/).pop();
  const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 40).split(/[,.;:!?\n]/)[0];
  const near = [...words(before).slice(-2), ...words(after).slice(0, 2)];
  return !near.some((w) => GUARD.test(w) && !NOT_NEGATION.test(w));
}

/** The sentence of the reply that admits a mistake, or null. */
export function mistakeClaim(text) {
  if (typeof text !== 'string') return null;
  // A quoted word is a mention, not an admission (alice 2026-11-03: the reply describing this hook was blocked).
  const plain = text.replace(/„[^“\n]*“|"[^"\n]*"|`[^`\n]*`/g, (q) => ' '.repeat(q.length));
  const re = new RegExp(MISTAKE.source, 'giu');
  let m;
  while ((m = re.exec(plain)) && !admits(plain, m)) { /* a guarded or negated use: look further */ }
  if (!m) return null;
  const from = Math.max(text.lastIndexOf('\n', m.index), ...['. ', '! ', '? '].map((d) => text.lastIndexOf(d, m.index))) + 1;
  const ends = ['. ', '! ', '? ', '\n'].map((d) => text.indexOf(d, m.index)).filter((i) => i >= 0);
  const to = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(from, to).replace(/[*_`]/g, '').trim().slice(0, 160);
}

// A queued signal for the next turn, not a block: the word list cannot tell an admitted mistake from a quoted or
// hypothetical one, and a wrong block cost a whole extra turn (operator 2026-11-08, hooks review).
export const MISTAKE_REASON = (sentence) => `mistake named in the last reply: "${sentence.slice(0, 120)}"; if it was one, handle it with skill workflow:error (fix, clean up, save a skill or rule, report it) and say what you saved (P-003)`;

export const PICKED_ASSIST_LINE = (list) => `picked assist unanswered: ${list.map((w) => w.id).join(', ')}; answer each with comms send --reply-to <id> --state hotovo|otázka|čakám; answered another way (one reply for several, a new message): comms settle --id <id> (P-042)`;
/** Picked assist without a reply state: the only ones the stop reminds of. */
export const unansweredPicked = (state) => (Array.isArray(state?.picked_assist) ? state.picked_assist : []).filter((w) => !w.state);

export function run(input) {
  const ctx = loadContext({ requireBrain: false });
  // Turn record for keepalive (P-043); an outage never fails the hook.
  // `opened_at` of this turn's record (from the prompt hook) keeps a late Stop from closing a newer turn.
  let held = [];
  let work = null;
  let idleWait = null;
  let closeTurn = () => {};
  // P-061: the declared state. A question to the operator makes the handover step the operator's move, not a continuation;
  // only a timer (resume_at) rings the thread (bob 2026-11-03: rung 76 s after a question, before the operator could read it).
  const reply = parseReply(input.last_assistant_message);
  // Items under the operator headings wait on the operator whatever state the reply declares (operator 2026-11-09).
  const toOperator = reply.state === 'otázka' || !!reply.operator?.length;
  if (ctx.thread) {
    try { held = ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread) : []; } catch { held = []; }
    const openedAt = ctx.brainDir ? readThreadState(ctx.brainDir, ctx.thread).turn_opened_at ?? null : null;
    // P-026: the next step travels with the closed turn; wake (code, not the agent) rings the thread to continue it.
    // A paused topic (snooze) is no work: no continue bell, no next-step block; its end rings the thread once.
    work = held.find((t) => !isMainTopic(t) && t.next && t.state !== 'paused');
    // A next step that only waits (bob 2026-11-03: "Čakať na hlásenie témy …" rang 11 times in 4 h) is rung in hours, at most
    // IDLE_RING_MS.length times per step; then the thread rests until mail or the operator wakes it.
    idleWait = work ? waitOnlyStep(work.next) : null;
    const snooze = !work && held.find((t) => t.state === 'paused' && t.paused_until && Date.parse(t.paused_until) > Date.now());
    // The prompt hook ends a turn that is only protocol without a model call (wake without mail, a timer whose condition does
    // not hold yet) and closes it again with the step and time this Stop sent last (P-061).
    const close = ({ next, resumeAt }) => {
      if (ctx.brainDir) writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), last_close: { next: next || null, resume_at: resumeAt || null } });
      // D-0015, D-0022: a turn ending `otázka` keeps the discussion with the operator open (steer/assist still wait);
      // `hotovo` or `čakám` closes it and the mail rings what it held back.
      return recordTurn(ctx, 'closed', held, { openedAt, next, resumeAt, discussion: reply.state === 'otázka' });
    };
    closeTurn = () => {
      // The state this turn ended with: `comms send --reply-to --state hotovo` refuses it in a turn the operator did not start
      // when the previous turn ended `otázka` (P-061, phase 2).
      if (ctx.brainDir) writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), last_end_state: reply.state || null, last_end_at: new Date().toISOString(), last_questions: reply.state === 'otázka' ? (reply.questions || []).slice(0, 5).map((q) => q.replace(/\s+/g, ' ').trim().slice(0, 300)) : [] });
      const st = ctx.brainDir ? readThreadState(ctx.brainDir, ctx.thread) : {};
      const timer = activeTimer(st);
      if (!timer && snooze) return close({ next: `pause of topic ${snooze.id} ended: run topic.mjs resume ${snooze.id}, then continue from handover`, resumeAt: snooze.paused_until });
      // An armed waker (schedule, background task, mail) rings the thread itself: no continue bell on top of it
      // (2026-11-03: rung 2 min after arming the check for 06:00, only to say there is nothing to do).
      const armed = !timer && validWaker(st);
      if (!timer && idleWait && !armed) {
        const key = `${work.id}\n${work.next}`;
        const n = st.idle_ring?.key === key && st.turn_source !== 'operator' ? Number(st.idle_ring.n || 0) : 0;
        if (ctx.brainDir) writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), idle_ring: { key, n: n + 1 } });
        const due = IDLE_RING_MS[n];
        return close({ next: due ? work.next : null, resumeAt: due ? new Date(Date.now() + due).toISOString() : null });
      }
      close({ next: timer?.then || (toOperator || armed ? null : work?.next) || null, resumeAt: timer?.at || null });
    };
  }
  // The turn is closed only when the stop really ends it: a blocked stop keeps the agent working, so the record stays open
  // (wake dedupes against open turns and does not ring a running thread, P-043).
  const end = (out) => {
    if (!out.decision) closeTurn();
    else out.reason = `${out.reason}\n${FINAL_REPLY}`;
    return out;
  };
  if (!ctx.brainDir) return end({});
  const signals = [];
  try {
    const res = flushBuffer(ctx, input.session_id, { sync: false });
    signals.push(...res.signals);
  } catch (err) {
    signals.push(`logs not written: ${err.message.split('\n')[0]}`);
  }
  let unpushed = unpushedCount(ctx.brainDir);
  // The log commit stays local: it goes out with the next brain write (brainSync pushes all commits) or here once the oldest
  // unpushed commit is logs.stop_push_minutes old (audit 2.3a: 756 push-per-Stop commits, ~27 min of waiting).
  if (unpushed > 0 && oldestUnpushedAgeMs(ctx.brainDir) >= (ctx.policy.logs?.stop_push_minutes ?? 30) * 6e4) {
    const sync = brainSync(ctx.brainDir);
    unpushed = sync.unpushed ?? unpushedCount(ctx.brainDir);
    if (sync.conflict) signals.push(`conflict: ${sync.conflict.join(', ')} (brain not merged, P-040)`);
    else if (unpushed > 0) signals.push(`unpushed: ${unpushed}${sync.error && sync.error !== 'no remote origin' ? ` (${sync.error})` : ''}`);
  }
  if (ctx.thread) {
    const state = readThreadState(ctx.brainDir, ctx.thread);
    const picked = unansweredPicked(state);
    // Once per queued line: a stop that finds the same reminder still waiting does not queue it again.
    if (picked.length && !(state.pending_signals || []).some((sig) => sig.startsWith('picked assist unanswered'))) signals.push(PICKED_ASSIST_LINE(picked));
    // P-030: each proposal (sequence -> skill) once per thread, not at every Stop that sees the count again.
    const proposed = Array.isArray(state.proposed) ? state.proposed : [];
    const added = [];
    const fresh = signals.filter((sig) => {
      const key = proposalKey(sig);
      if (!key) return true;
      if (proposed.includes(key) || added.includes(key)) return false;
      added.push(key);
      return true;
    });
    if (fresh.length) {
      const pending = [...(state.pending_signals || []), ...fresh].slice(-(ctx.policy.limits?.hook_signal_lines ?? 2));
      writeThreadState(ctx.brainDir, ctx.thread, { ...state, pending_signals: pending, proposed: [...proposed, ...added].slice(-200) });
    }
    // P-061: the declared state against the facts, in every turn (a message never ends the loop of work).
    const msg = input.last_assistant_message;
    const mistake = input.stop_hook_active ? null : mistakeClaim(msg);
    if (mistake) {
      const st = readThreadState(ctx.brainDir, ctx.thread);
      const line = MISTAKE_REASON(mistake);
      const queued = st.pending_signals || [];
      if (!queued.includes(line)) writeThreadState(ctx.brainDir, ctx.thread, { ...st, pending_signals: [...queued, line].slice(-(ctx.policy.limits?.hook_signal_lines ?? 2)) });
    }
    // A timer outlives an operator prompt (12 of 59 timers were dropped by one, audit 2026-11-11) and is spent here, when that
    // turn ends without "čakám"; an auto timer of code is always spent then, the turn arms its own wait.
    const before = readThreadState(ctx.brainDir, ctx.thread);
    const spent = !!before.timer && before.turn_source === 'operator' && !(before.turn_started_at && before.timer.set_at >= before.turn_started_at) && (before.timer.auto || reply.state !== 'čakám');
    const waker = validWaker(spent ? { ...before, timer: undefined } : before);
    const paused = held.some((t) => t.state === 'paused') && !work;
    // A dialog asked in this turn (PreToolUse keeps the time) that failed or was declined leaves the text question as fallback; one
    // the operator answered does not (flow-public#35 pilot: a consent answered, the next consent asked in text ended the turn).
    const turnState = readThreadState(ctx.brainDir, ctx.thread);
    const dialog = !!turnState.dialog_at && (!turnState.turn_started_at || turnState.dialog_at >= turnState.turn_started_at) && !(turnState.dialog_answered_at && turnState.dialog_answered_at >= turnState.dialog_at);
    // The start question of a thread without a topic comes from the status block of the session start (boot.mjs).
    const topicStart = !held.length && toOperator && reply.question === TOPIC_QUESTION;
    const noTopicBlock = typeof msg === 'string' && ctx.projectName && msg.split('\n').some((l) => l.replace(/[*_`]/g, '').trim() === `${ctx.projectName} / bez témy`);
    // P-059: a question item that repeats one the operator answered earlier in the thread (an answer of this very turn is no earlier one).
    const earlier = (turnState.answered_questions || []).filter((a) => !turnState.turn_started_at || a.at < turnState.turn_started_at);
    let repeated = null;
    // PreToolUse refused a dialog of this turn as a repeat (its key: the turn start, else 'turn'): not challenged again here.
    const repeatDenied = !!turnState.repeat_denied_at && turnState.repeat_denied_at === (turnState.turn_started_at || 'turn');
    if (reply.state === 'otázka' && !repeatDenied) for (const item of reply.questions || []) { const old = repeatsAnswered(item, earlier); if (old) { repeated = REPEATED_QUESTION_REASON(old, item.replace(/\s+/g, ' ').trim()); break; } }
    let violation = null;
    // A harness that sends no reply text (field missing) cannot be checked; an empty reply is no state.
    if (typeof msg !== 'string') violation = null;
    else if (noTopicBlock && held.length) violation = STALE_STATUS_REASON(ctx.projectName, held[0].id);
    // Pilot 2026-11-12: the operator chose "Bez témy" in the topic dialog and the hook asked for the topic again (D-0010).
    else if (noTopicBlock && !topicStart && !turnState.no_topic_chosen_at) violation = NO_TOPIC_REASON(ctx.projectName);
    else if (!reply.state) violation = NO_STATE_REASON;
    else if (reply.legacyOperator) violation = LEGACY_HEADING_REASON;
    else if (reply.emptySection) violation = EMPTY_SECTION_REASON(reply.emptySection);
    else if (reply.step) violation = STEP_REASON(reply.step);
    else if (reply.operator?.length && reply.state !== 'otázka' && reply.state !== 'čakám') violation = OPERATOR_STATE_REASON(reply.state, reply.operator[0].slice(0, 120));
    else if (reply.state === 'otázka' && !dialog && !topicStart) violation = repeatDenied ? `${DIALOG_AFTER_REPEAT}; ${DIALOG_REASON}` : DIALOG_REASON;
    else if (reply.state === 'otázka' && !reply.question) violation = NO_QUESTION_REASON;
    else if (repeated) violation = repeated;
    else if (reply.state === 'čakám' && !reply.waitFor) violation = NO_WAIT_TARGET_REASON;
    else if (reply.state === 'hotovo' && work && !idleWait && !waker) violation = NEXT_STEP_REASON(work.id, work.next);
    // Trust, T3 project and welcome thread that project.mjs could not do without the `t3` CLI (skipped by hand, 2026-11-08).
    const t3Left = input.stop_hook_active ? null : pendingT3Line(readThreadState(ctx.brainDir, ctx.thread).t3_pending);
    // After a block of this turn a reply of only the state line is returned once per turn (its key: the turn start, else 'turn').
    const turnKey = turnState.turn_started_at || 'turn';
    const stateOnly = !!input.stop_hook_active && typeof msg === 'string' && !!reply.state && !msg.replace(/\s+$/, '').split('\n').slice(0, -1).join('').trim() && turnState.state_only_blocked_at !== turnKey;
    if (stateOnly) writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), state_only_blocked_at: turnKey });
    const reasons = [!input.stop_hook_active && violation, stateOnly && STATE_ONLY_REASON, t3Left].filter(Boolean);
    if (reasons.length) return end({ decision: 'block', reason: reasons.join('\n') });
    if (spent) clearTimer(ctx.brainDir, ctx.thread);
    // Ending waiting without a waker, or without a true state, keeps the loop alive: code arms the thread timer, no note about it (P-061). The start
    // question of a thread without a topic (which topic?) gets none: a timer turn told to "decide with your recommended option"
    // would pick the topic itself (flow-public#1). An unfinished step under "hotovo" gets the continue ring in closeTurn.
    if (!topicStart && !waker && !paused && !idleWait && (reply.state !== 'hotovo' || toOperator)) {
      const st = readThreadState(ctx.brainDir, ctx.thread);
      const n = Number(st.auto_timer_n || 0);
      // Waiting on the operator rings in hours (operator 2026-11-03), waiting on a job in minutes.
      const [base, max] = toOperator ? [OPERATOR_TIMER_MS, OPERATOR_TIMER_MAX_MS] : [AUTO_TIMER_MS, AUTO_TIMER_MAX_MS];
      setTimer(ctx.brainDir, ctx.thread, { delayMs: Math.min(base * 2 ** n, max), then: reply.state === 'čakám' && reply.waitFor ? WAIT_TIMER_THEN(reply.waitFor) : AUTO_TIMER_THEN, auto: true });
      writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), auto_timer_n: n + 1 });
    }
  }
  return end({});
}

if (isMain(import.meta.url)) {
  let out = {};
  try {
    const input = readHookInput();
    out = run(input) || {};
    if (out.decision === 'block') {
      try {
        const ctx = loadContext({ requireBrain: false });
        logDecision(ctx.brainDir, { event: 'Stop', out, thread: ctx.thread });
      } catch { /* the log never changes the decision */ }
    }
  } catch (err) {
    process.stderr.write(`stop: ${err.message}\n`);
  }
  emit(out);
}
