#!/usr/bin/env node
// Stop: the end of a turn (flow v2 spec 10). The hook never reads the text of the result (10.3, 10.4); it checks only:
// 1. the skeleton: the state line `**Stav:** hotovo|otázka|čakám (na <čo>)`, the headings and numbered items of the blocks
//    **Otázky na operátora:** / **Úlohy pre operátora:** (old forms and an empty heading are skeleton errors, plan O3), the
//    section **Handover:** with a line `<téma> → <krok>` (or `<téma> → žiadny`) for every held topic, else
//    `**Handover:** žiadny`, and as many block items as the handover sections Otvorené otázky and Úlohy pre operátora hold;
// 2. the state against the facts (10.2): a next step in a handover or an alarm armed by code -> čakám, else an item in those
//    sections -> otázka, else hotovo (scripts/topic-state.mjs, scripts/topic-turn.mjs);
// 3. the dialog: in a turn the operator did not start (bell, mail, continuation) with the state otázka, the first question
//    of a topic outside mode discussion is asked with AskUserQuestion (10.3 item 3, 10.6);
// 4. a forged harness notification (a <task-notification> block in the reply).
// A last message that is only the skeleton (no result before **Handover:**) is a skeleton error (the answer stayed folded away,
// flow-public#37; plan O3). At most one block per turn (10.3): the second attempt passes (stop_hook_active), whatever it holds.
// A released turn writes the state and the alarm time of each held topic into `.tema.json` (only when they changed, in the
// commit of the buffered logs, plan risk 4.7), after the pull that checks the lock (4.2.4; a lost topic is not written), and
// closes the turn record (P-043): with a timer its step and time; with a next step the continuation (resume_at = end of the
// turn + CONTINUE_RESUME_MS, plan O2), not while a timer or background task runs and not for a stuck topic (B4); the mail's
// wait for an answer does not hold the continuation back (3.3.3). An interrupted turn has no Stop and writes nothing (10.5).
// Picked mail without an answer (P-042, P-072) is one queued line, not a block.
import { readHookInput, emit, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState, writeThreadState } from '../scripts/config.mjs';
import { logDecision } from '../scripts/denials.mjs';
import { flushBuffer, proposalKey } from '../scripts/logs.mjs';
import { unpushedCount, brainSync, oldestUnpushedAgeMs } from '../scripts/brain.mjs';
import { recordTurn, isMainTopic, readObligations, ageText, OWED_PREFIX, OWED_LINE, unansweredOwed } from '../scripts/comms.mjs';
import { heldTopics, isDiscussionMode } from '../scripts/topic.mjs';
import { fieldsOp } from '../scripts/topic-files.mjs';
import { syncResults, savedLine } from '../scripts/results.mjs';
import { parseReply, HANDOVER_LINE, HANDOVER_NONE_LINE, PROTOCOL_EXAMPLE, handoverMatches } from '../scripts/protocol.mjs';
import { summaryState, WAITING, DONE } from '../scripts/topic-state.mjs';
import { threadAlarms, topicFacts, turnUpdate, stuckNow, verifyLocks, LOCK_LOST_LINE, CONTINUE_RESUME_MS } from '../scripts/topic-turn.mjs';
import { validWaker, awaitingWaker, clearTimer, threadTimers, timersPatch, sameTimer, finishedTasks, withoutFinished, resumeAtFor } from '../scripts/waker.mjs';
import { transcriptTail } from '../scripts/bypass.mjs';

export const HOOK_META = { event: 'Stop', class: 'c', limit: '2 lines (queued to next prompt); 1 block reason', principles: ['P-026', 'P-030', 'P-037', 'P-040', 'P-042', 'P-043', 'P-061', 'P-078'] };

// T3 shows the operator only the last message of a turn and folds the earlier ones under "Worked for …": a note written
// after a block hid the answer (operator 2026-11-03: "the payload I want is hidden, I get the operational message").
export const FINAL_REPLY = 'The operator sees only your last message of this turn (earlier ones are folded away): end with the complete answer (the result, links, items for the operator; corrected where it changed), its **Handover:** section and its state line, never with only the state line. Never write about this hook, a timer, a waker or IDs (P-061)';
// flow-public#37: after a block the reply was only its state line and the result stayed in an earlier, folded message.
export const STATE_ONLY_REASON = 'the last message of this turn is only its skeleton (the **Handover:** section and the state line): the answer stays in an earlier message the operator does not see; write the complete answer above the skeleton in this last message (spec 10.3 item 1, P-061, flow-public#37)';

const STATES_HELP = 'The state comes from the facts, not from the text (spec 10.2): čakám = a held topic\'s handover has a next step ("**Stav:** čakám (na pokračovanie)") or an alarm armed by code runs (timer.mjs, a background task, mail you sent that waits for an answer); otázka = no step and no alarm, and an item in the handover sections Otvorené otázky or Úlohy pre operátora (the blocks **Otázky na operátora:** and **Úlohy pre operátora:** are their content); hotovo = none of that. A step is only the handover\'s Ďalší krok (save.mjs handover --next), a step that waits for the operator\'s answer is a question';
export const NO_STATE_REASON = `the final reply has no state line: end it with exactly one line "**Stav:** hotovo", "**Stav:** otázka" or "**Stav:** čakám (na <what>)", after the section ${HANDOVER_LINE} (P-061), e.g. ${PROTOCOL_EXAMPLE}. ${STATES_HELP}`;
// D-0040 (operator 2026-11-13): items and steps are numbered, the handover is its own section, the state line is bold.
const OLD_FORM_PARTS = {
  state: 'the state line is bold: "**Stav:** hotovo|otázka|čakám (na <what>)", not "Stav: …"',
  items: 'the items under **Otázky na operátora:** and **Úlohy pre operátora:** are a numbered list ("1. <…>", "2. <…>" on their own lines), not "- [ ] <…>", "- <…>" or text after the heading',
  handover: `the handover is its own section, not the line "Handover: <topic> – <step>": the heading **Handover:** and under it one numbered line per held topic "1. <topic> → <next step>", or "${HANDOVER_NONE_LINE}" when the thread holds none`,
  'handover-items': 'the lines under **Handover:** are numbered: "1. <topic> → <next step>"',
};
export const OLD_FORM_REASON = (parts) => `the reply ends in the old form of the protocol: ${parts.map((p) => OLD_FORM_PARTS[p]).join('; ')}. Rewrite the end of the reply in this form, e.g. ${PROTOCOL_EXAMPLE} (P-061, D-0040)`;
export const LEGACY_HEADING_REASON = 'the reply uses the old heading **Operátor:**: split it into **Otázky na operátora:** (decisions and confirmations only the operator has) and **Úlohy pre operátora:** (steps only the operator does: login, install, a click in a UI); omit the heading that has no item (P-061)';
export const EMPTY_SECTION_REASON = (heading) => `the reply has the heading ${heading} with no item: omit a section that has nothing in it, and write it only with numbered items "1. <…>" (P-061)`;
export const NO_WAIT_TARGET_REASON = 'the reply declares "**Stav:** čakám" but not what it waits for: write the state line as "**Stav:** čakám (na <what>)", e.g. "**Stav:** čakám (na pokračovanie)" (P-061)';
// Operator: he could not tell what continues after /clear or in a new session. The section before the state line names every topic the thread holds, or says it holds none (D-0040).
export const HANDOVER_REASON = (topics, said) => `the final reply has ${said ? `a wrong **Handover:** section ("${said.text.slice(0, 80)}"${said.items.length ? `, lines: ${said.items.map((i) => i.topic ? `${i.topic} → …` : `"${String(i.text).slice(0, 60)}" (not "<topic> → <step>")`).join(', ')}` : ''})` : 'no **Handover:** section'}: right before the state line comes the section ${HANDOVER_LINE} (what continues after /clear or in a new session), ${topics.length ? `and it must have a line for every topic this thread holds: ${topics.map((t) => `${t.id} (saved next step: ${t.next ? `"${String(t.next).slice(0, 160)}"` : 'none, "→ žiadny"'})`).join('; ')}` : `this thread holds no topic, so write exactly "${HANDOVER_NONE_LINE}"`} (spec 10.2, D-0040)`;
export const HANDOVER_SECTIONS_REASON = (id) => `the handover of topic ${id} lacks the section "## Otvorené otázky" or "## Úlohy pre operátora": save it again with save.mjs handover (six sections, P-011); the state of the topic is computed from them (spec 10.2)`;
export const COUNT_REASON = (said, saved, topics) => `the blocks of the reply do not match the handover: **Otázky na operátora:** has ${said.questions} item(s) and the section Otvorené otázky ${topics ? `of the held topics ${saved.questions}` : '0 (this thread holds no topic)'}; **Úlohy pre operátora:** has ${said.tasks} item(s) and the section Úlohy pre operátora ${topics ? saved.tasks : 0}. The blocks are the content of these sections, so they survive a takeover and a new session: save the handover with the items (save.mjs handover <topic> --questions "<a>; <b>" --tasks "<c>") or write the blocks as saved; ${topics ? 'an item that is answered or done leaves both' : 'a question or task for the operator needs a held topic (spec 10.1)'} (spec 10.2, 10.3 item 1)`;
const factsText = (facts, alarms) => [
  ...facts.map(({ topic, facts: f }) => `topic ${topic.id}: ${f.next.length} next step(s), ${f.questions ?? 0} open question(s), ${f.tasks ?? 0} task(s) for the operator${f.alarms.length ? `, alarm ${f.alarms.map((a) => a.kind).join('+')}` : ''}`),
  ...(facts.length ? [] : [`no held topic, ${alarms.timers.length + alarms.background.length + alarms.awaiting.length ? 'an alarm runs' : 'no alarm'}`]),
].join('; ');
export const STATE_FACTS_REASON = (declared, actual, facts, alarms) => `the reply declares "**Stav:** ${declared}" but the facts give "${actual}" (${factsText(facts, alarms)}): end with "**Stav:** ${actual === WAITING ? 'čakám (na <what>)' : actual}", or change the facts first (save.mjs handover --next / --questions / --tasks, timer.mjs for an alarm) (spec 10.2, 10.3 item 2). ${STATES_HELP}`;
export const DIALOG_REASON = 'the state is "otázka" and this turn was not started by the operator\'s message (a bell, mail or the continuation started it): the operator is not in the thread, so ask the first item of **Otázky na operátora:** with AskUserQuestion now (your recommended option first, readable without the thread, D-0039); the items stay in the reply. A topic in mode discussion needs no dialog (spec 10.3 item 3, 10.6)';

// flow-public#85: a reply wrote a <task-notification> block (completed, exit 0) for a job still running and went on as if it
// had ended. Only the harness writes that block, so the reply that carries one is refused; a mention inside a code fence or
// in running text (not at the start of a line) is no notification.
export const fakeNotification = (text) => /^[ \t>]*<task-notification\b[^>]*>/im.test(String(text || '').replace(/```[\s\S]*?```/g, ' '));
export const FAKE_NOTIFICATION_REASON = 'the reply contains a <task-notification> block: only the harness writes it, the end of a background job is never predicted in the reply. Remove the block and anything built on it; wait for the real notification (t3_background_wait with the task id, or end the turn with "**Stav:** čakám (na <job>)") and continue only after it (P-020, P-019)';

export { OWED_PREFIX, OWED_LINE, unansweredOwed };

const count = (items) => (Array.isArray(items) ? items.length : 0);

/** The first skeleton or fact violation of the reply (spec 10.3 points 1 to 4), or null. */
export function violationOf({ msg, reply, work, facts, alarms, factsState, turnSource, dialog }) {
  if (fakeNotification(msg)) return FAKE_NOTIFICATION_REASON;
  if (!reply.state) return NO_STATE_REASON;
  if (reply.onlyProtocol) return STATE_ONLY_REASON;
  if (reply.oldForm.length) return OLD_FORM_REASON(reply.oldForm);
  if (reply.legacyOperator) return LEGACY_HEADING_REASON;
  if (reply.emptySection) return EMPTY_SECTION_REASON(reply.emptySection);
  if (reply.state === WAITING && !reply.waitFor) return NO_WAIT_TARGET_REASON;
  if (!handoverMatches(reply.handover, work.map((t) => t.id))) return HANDOVER_REASON(work, reply.handover);
  const broken = facts.find((f) => f.facts.questions === null || f.facts.tasks === null);
  if (broken) return HANDOVER_SECTIONS_REASON(broken.topic.id);
  const saved = { questions: facts.reduce((n, f) => n + f.facts.questions, 0), tasks: facts.reduce((n, f) => n + f.facts.tasks, 0) };
  const said = { questions: count(reply.questions), tasks: count(reply.tasks) };
  if (said.questions !== saved.questions || said.tasks !== saved.tasks) return COUNT_REASON(said, saved, facts.length > 0);
  if (reply.state !== factsState) return STATE_FACTS_REASON(reply.state, factsState, facts, alarms);
  const asks = facts.some((f) => f.facts.questions > 0 && !isDiscussionMode(f.topic));
  if (turnSource !== 'operator' && factsState === 'otázka' && asks && !dialog) return DIALOG_REASON;
  return null;
}

export function run(input) {
  const ctx = loadContext({ requireBrain: false });
  const reply = parseReply(input.last_assistant_message);
  const msg = input.last_assistant_message;
  let held = [];
  if (ctx.thread && ctx.brainDir) { try { held = heldTopics(ctx.brainDir, ctx.thread); } catch { held = []; } }
  const work = held.filter((t) => !isMainTopic(t));
  // `opened_at` of this turn's record (from the prompt hook) keeps a late Stop from closing a newer turn (P-043).
  const openedAt = ctx.brainDir && ctx.thread ? readThreadState(ctx.brainDir, ctx.thread).turn_opened_at ?? null : null;
  // The prompt hook ends a turn that is only protocol without a model call and closes it again with the step and time this
  // Stop sent last (`last_close`). `last_end_state`: comms send --reply-to --state hotovo refuses it in a turn the operator
  // did not start when the previous turn ended otázka (P-061).
  const close = ({ next = null, resumeAt = null } = {}) => {
    if (!ctx.thread) return null;
    if (ctx.brainDir) writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), last_close: { next, resume_at: resumeAt }, last_end_state: reply.state || null, last_end_at: new Date().toISOString() });
    // Spec 2.2 (plan B7): delivered mail wakes the thread in every state: the end of a turn closes the discussion.
    return recordTurn(ctx, 'closed', held, { openedAt, next, resumeAt, discussion: false });
  };
  if (!ctx.brainDir) { close(); return {}; }
  const signals = [];
  // One brain write per turn for the buffered logs (P-030); `ops` (the topic state) go into the same commit and are pushed.
  const flush = (ops = [], message = null) => {
    try {
      const res = flushBuffer(ctx, input.session_id, { sync: ops.length > 0, ops, message });
      signals.push(...res.signals);
      if (res.sync?.conflict) signals.push(`conflict: ${res.sync.conflict.join(', ')} (brain not merged, P-040)`);
      else if (res.sync?.error && res.sync.error !== 'no remote origin') signals.push(`unpushed: ${res.sync.unpushed ?? unpushedCount(ctx.brainDir)} (${res.sync.error})`);
      if (ops.length) return;
    } catch (err) {
      signals.push(`${ops.length ? 'logs and topic state' : 'logs'} not written: ${err.message.split('\n')[0]}`);
    }
    // The log commit stays local: it goes out with the next brain write or here once the oldest unpushed commit is
    // logs.stop_push_minutes old (audit 2.3a: 756 push-per-Stop commits, ~27 min of waiting).
    let unpushed = unpushedCount(ctx.brainDir);
    if (unpushed > 0 && oldestUnpushedAgeMs(ctx.brainDir) >= (ctx.policy.logs?.stop_push_minutes ?? 30) * 6e4) {
      const sync = brainSync(ctx.brainDir);
      unpushed = sync.unpushed ?? unpushedCount(ctx.brainDir);
      if (sync.conflict) signals.push(`conflict: ${sync.conflict.join(', ')} (brain not merged, P-040)`);
      else if (unpushed > 0) signals.push(`unpushed: ${unpushed}${sync.error && sync.error !== 'no remote origin' ? ` (${sync.error})` : ''}`);
    }
  };
  // Signals are queued for the next prompt (P-023 c); each skill proposal once per thread (P-030).
  const queue = () => {
    if (!ctx.thread || !signals.length) return;
    const state = readThreadState(ctx.brainDir, ctx.thread);
    const proposed = Array.isArray(state.proposed) ? state.proposed : [];
    const added = [];
    const fresh = signals.filter((sig) => {
      const key = proposalKey(sig);
      if (!key) return true;
      if (proposed.includes(key) || added.includes(key)) return false;
      added.push(key);
      return true;
    });
    if (fresh.length) writeThreadState(ctx.brainDir, ctx.thread, { ...state, pending_signals: [...(state.pending_signals || []), ...fresh].slice(-(ctx.policy.limits?.hook_signal_lines ?? 2)), proposed: [...proposed, ...added].slice(-200) });
  };
  if (!ctx.thread) { flush(); return {}; }

  // One obligations call; an outage gives the client's backup (offline), another model nothing.
  const res = readObligations(ctx, { held });
  const mail = res.ok && !(res.data?.offline && !res.data?.cached) ? res.data : null;
  const picked = unansweredOwed(mail);
  // Once per queued line: a stop that finds the same reminder still waiting does not queue it again.
  if (picked.length && !(readThreadState(ctx.brainDir, ctx.thread).pending_signals || []).some((sig) => sig.startsWith(OWED_PREFIX))) signals.push(OWED_LINE(picked, mail.offline ? ageText(mail.age_s) : null));
  // A task whose end the harness already notified rings nobody: its waker is spent (operator 2026-11-13).
  const recorded = readThreadState(ctx.brainDir, ctx.thread);
  const live = (recorded.wakers || []).some((w) => w.tasks?.length) ? withoutFinished(recorded.wakers, finishedTasks(transcriptTail(input.transcript_path))) : recorded.wakers;
  if (live !== recorded.wakers && live.length !== recorded.wakers.length) writeThreadState(ctx.brainDir, ctx.thread, { ...recorded, wakers: live });
  const before = readThreadState(ctx.brainDir, ctx.thread);
  // A timer outlives an operator prompt (audit 2026-11-11) and is spent when that turn ends without "čakám"; only that timer
  // (the earliest), later ones of the thread stay.
  const spent = !!before.timer && before.turn_source === 'operator' && !(before.turn_started_at && before.timer.set_at >= before.turn_started_at) && reply.state !== WAITING;
  const alarmState = spent ? { ...before, ...timersPatch(threadTimers(before).filter((t) => !sameTimer(t, before.timer))) } : before;
  const now = Date.now();
  const alarms = threadAlarms(alarmState, mail, now);
  const facts = work.map((topic) => ({ topic, facts: topicFacts(topic, alarms, { turnEnd: now, now }) }));
  const factsState = facts.length ? summaryState(facts.map((f) => f.facts)) : (alarms.timers.length || alarms.background.length || awaitingWaker(mail) ? WAITING : DONE);
  const turnSource = before.turn_source || 'operator';
  // Only whether a dialog was asked in this turn (PreToolUse keeps its time), not its content (10.3 item 3).
  const dialog = !!before.dialog_at && (!before.turn_started_at || before.dialog_at >= before.turn_started_at);
  // A harness that sends no reply text (field missing) cannot be checked; the second attempt of a turn passes (10.3).
  const violation = typeof msg === 'string' && !input.stop_hook_active ? violationOf({ msg, reply, work, facts, alarms, factsState, turnSource, dialog }) : null;
  if (violation) {
    // A blocked stop keeps the agent working: the turn record stays open and nothing of the state is written.
    flush();
    queue();
    return { decision: 'block', reason: `${violation}\n${FINAL_REPLY}` };
  }
  if (spent) clearTimer(ctx.brainDir, ctx.thread, (t) => sameTimer(t, before.timer));
  // Spec 10.2: the state and the alarm time of each held topic, from the facts (not from the state line), only when they
  // changed; after the pull the lock decides (4.2.4): a topic this thread lost is not written and gets no continuation.
  const updates = facts.map((f) => ({ id: f.topic.id, patch: turnUpdate(ctx, f.topic, f.facts, before) })).filter((u) => u.patch);
  // P-078: the results bound to their work files follow them (a changed source is copied over its result) and the work
  // files shown to the operator or cited by the handover are saved, in the commit of the topic state.
  const synced = work.map((t) => {
    try { return { id: t.id, res: syncResults(ctx.brainDir, t.id, { policy: ctx.policy, now }) }; }
    catch (err) { signals.push(`results of ${t.id} not synced: ${err.message.split('\n')[0]}`); return null; }
  }).filter((x) => x && x.res.ops.length);
  const lost = new Set();
  if (updates.length || synced.length) {
    const locks = verifyLocks(ctx, [...new Set([...updates.map((u) => u.id), ...synced.map((x) => x.id)])]);
    for (const l of locks.lost) lost.add(l.id);
    if (locks.lost.length) signals.push(LOCK_LOST_LINE(locks.lost));
    const write = updates.filter((u) => !lost.has(u.id));
    const results = synced.filter((x) => !lost.has(x.id));
    let ops = [];
    try { ops = write.map((u) => fieldsOp(ctx.brainDir, u.id, { turn: u.patch })); } catch (err) { signals.push(`topic state not written: ${err.message.split('\n')[0]}`); }
    ops.push(...results.flatMap((x) => x.res.ops));
    for (const x of results) { const line = savedLine(x.id, x.res); if (line) signals.push(line); }
    const message = [write.length ? `turn ${write.map((u) => `${u.id} ${u.patch.state || 'state'}`).join(', ')}` : null, results.length ? `results ${results.map((x) => `${x.id}: ${x.res.saved.map((r) => r.name).join(', ') || 'bindings'}`).join('; ')} (P-078)` : null].filter(Boolean).join('; ');
    flush(ops, ops.length ? message : null);
  } else flush();
  queue();
  const st = readThreadState(ctx.brainDir, ctx.thread);
  // The earliest timer, also one already due: it came due while this turn ran, so the closed turn carries it and wake rings
  // it at once (pilot nudge-why 2026-11-14).
  const timer = threadTimers(st)[0] || null;
  if (timer) return (close({ next: timer.then, resumeAt: resumeAtFor(timer) }), {});
  const running = work.filter((t) => !lost.has(t.id));
  const snooze = !running.some((t) => t.state !== 'paused' && t.next) && running.find((t) => t.state === 'paused' && t.paused_until && Date.parse(t.paused_until) > Date.now());
  if (snooze) return (close({ next: `pause of topic ${snooze.id} ended: run topic.mjs resume ${snooze.id}, then continue from handover`, resumeAt: snooze.paused_until }), {});
  // A background task or a schedule rings the thread itself; the step runs after it (10.2 point 1).
  if (validWaker(st)) return (close(), {});
  // P-026: the next step travels with the closed turn and wake rings "continue from handover"; resume_at makes it ring also
  // with the same step (plan O2), the cap of continue_max is counted at the wake; a stuck topic has no continuation.
  const cont = running.find((t) => t.state !== 'paused' && t.next && !stuckNow(ctx, t, st));
  close(cont ? { next: cont.next, resumeAt: new Date(Date.now() + CONTINUE_RESUME_MS).toISOString() } : {});
  return {};
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
