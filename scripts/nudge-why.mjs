// Why the operator had to wake this thread (operator nudge "up", operator 2026-11-14): the facts of the records only, read,
// never written: the end of the last turn (time, state line, its waker), the thread timers (due and not rung, with the
// wake module's reason when its log names one), the last bells and their delivery, waiting and held mail, a tool call
// that waited for an approval window or a dialog (session transcript: a call without its result, or a result long after
// the call), and long background work. Night 2026-11-14: the orchestrator stood 2:24-7:49 on an approval window; its
// timers did not ring while the turn was open, and the operator found it only in the morning.
import fs from 'node:fs';
import { localTime } from './util.mjs';
import { threadTimers, finishedTasks } from './waker.mjs';

/** A tool call whose result came this long after it (or not yet) waited on the operator: an approval window or a dialog. */
export const WAIT_GAP_MS = 15 * 60_000;
/** Background work older than this, not ended, is long-running. */
export const LONG_BACKGROUND_MS = 30 * 60_000;
/** Mail waiting longer than this was not picked up in time. */
export const MAIL_LATE_MS = 15 * 60_000;
/** The transcript is read from its end, at most this much (a long session is tens of MB). */
export const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
// Calls that run long by design (the harness waits on work, not on the operator).
const LONG_BY_DESIGN = /^(Agent|Task|Monitor|TaskOutput)$|(^|__)(t3_background_wait|t3_thread_wait|delegate_task|task_status)$/;
const DIALOG_TOOLS = /^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$/;

const dur = (ms) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clip = (s, n = 100) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Parse a session transcript (JSONL): tool calls with the time of their result, operator prompts, the last entry time. */
export function readTranscript(file) {
  const out = { calls: [], prompts: [], lastAt: null, text: '', file };
  if (!file) return null;
  let text;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, TRANSCRIPT_MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  out.text = text;
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
    if (ts && (o.type === 'user' || o.type === 'assistant') && (!out.lastAt || ts > out.lastAt)) out.lastAt = ts;
    const content = o.message && typeof o.message === 'object' ? o.message.content : null;
    if (o.type === 'user' && typeof content === 'string') out.prompts.push({ at: ts, text: content });
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (o.type === 'assistant' && c.type === 'tool_use' && c.id) {
        const call = { id: c.id, name: String(c.name || ''), input: c.input || {}, at: ts, resultAt: null };
        byId.set(c.id, call);
        out.calls.push(call);
      } else if (o.type === 'user' && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
        byId.get(c.tool_use_id).resultAt = ts;
      } else if (o.type === 'user' && c.type === 'text' && !content.some((x) => x?.type === 'tool_result')) {
        out.prompts.push({ at: ts, text: String(c.text || '') });
      }
    }
  }
  return out;
}

/** What the call did, for the operator: its description or command, else its first input value. */
function callLabel(call) {
  const i = call.input || {};
  if (DIALOG_TOOLS.test(call.name)) return `${call.name}${Array.isArray(i.questions) && i.questions[0]?.question ? `: ${clip(i.questions[0].question, 90)}` : ''}`;
  const what = i.description || i.command || i.file_path || i.prompt || Object.values(i).find((v) => typeof v === 'string') || '';
  return `${call.name}${what ? `: ${clip(what, 90)}` : ''}`;
}

/** Lines of the wake module's log about this thread (its id), or about a topic label it holds. */
export function wakeLines(log, thread, labels = []) {
  if (!log) return [];
  // A skip of mail to a held topic ends with the topic label (`skip <seq> (<reason>) <type> <project>/<topic>`); a ring to
  // another thread names this topic only as the sender, so the label counts only at the end of a skip line.
  return String(log).split('\n').filter((l) => l.trim() && (l.includes(String(thread)) || (/\] skip \d+ /.test(l) && labels.some((k) => k && l.trimEnd().endsWith(` ${k}`)))));
}

const stampOf = (line) => /\[wake (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line)?.[1] || null;

/**
 * The diagnosis: { facts: [line], causes: [{ kind, workflow, text }] }. Inputs are plain data (tests give fixtures):
 * state (thread state), turn (the mail's turn record), wakeState (wake-state.json), wakeLog (text), transcript
 * (readTranscript), mail (mailCount result or null), nudges (policy prompt.nudge_prompts), now (ms), since (ms).
 */
export function diagnose({ thread, state = {}, turn = null, wakeState = null, wakeLog = '', transcript = null, mail = null, nudges = ['up', '?', 'check', 'ckeck'], now = Date.now(), since = now - 12 * 3600_000, topics = [] }) {
  const facts = [];
  const causes = [];
  const t = (v) => localTime(v);
  const nudgeSet = new Set(nudges.map((n) => String(n).trim().toLowerCase()));
  // The moment the operator woke the thread: the last nudge prompt in the transcript, else now.
  const nudge = [...(transcript?.prompts || [])].reverse().find((p) => nudgeSet.has(String(p.text).trim().toLowerCase()) && p.at && Date.parse(p.at) <= now);
  const wokeAt = nudge ? Date.parse(nudge.at) : now;
  facts.push(`nudge: ${t(wokeAt)}${nudge ? ' (prompt in the transcript)' : ' (now)'}; records read from ${t(since)}`);

  // 1. End of the last turn: time, state line, waker.
  const endAt = state.last_end_at ? Date.parse(state.last_end_at) : null;
  const close = state.last_close || {};
  const endState = state.last_end_state || null;
  // A --now in the past reads the live state: a turn end after it is not the end before the nudge.
  if (endAt && endAt > now) facts.push(`last turn: the state records an end after this moment (${t(endAt)}); the end before it is not kept`);
  else if (endAt) {
    const wakers = (state.wakers || []).filter((w) => w.recurring || (w.until && Date.parse(w.until) > endAt));
    const timersAfter = threadTimers(state).filter((x) => Date.parse(x.at) > endAt);
    const waker = close.resume_at ? `timer ${t(close.resume_at)}` : timersAfter.length ? `timer ${t(timersAfter[0].at)}` : wakers.length ? `${wakers[0].kind}${wakers[0].until ? ` until ${t(wakers[0].until)}` : ''}` : 'none';
    facts.push(`last turn: ended ${t(endAt)}, Stav: ${endState || '(none recorded)'}, waker: ${waker}${close.next ? `; next: ${clip(close.next, 120)}` : ''}`);
    if (endState === 'čakám' && waker === 'none') causes.push({ kind: 'no-waker', workflow: true, text: `the turn ended ${t(endAt)} with "Stav: čakám" and no waker: nothing could ring the thread` });
    if (endState === 'otázka') causes.push({ kind: 'question', workflow: false, text: `the turn ended ${t(endAt)} with a question for the operator ("Stav: otázka"): it waited on the operator's answer` });
    if (endState === 'hotovo' && !close.next) causes.push({ kind: 'done', workflow: false, text: `the turn ended ${t(endAt)} with "Stav: hotovo" and no next step: nothing was due, the nudge gives new work` });
  } else facts.push('last turn: no end recorded in the thread state');
  const turnOpen = turn && turn.state === 'open';
  if (turn) facts.push(`turn record (mail): ${turn.state}${turn.opened_at ? `, opened ${t(turn.opened_at)}` : ''}${turn.closed_at ? `, closed ${t(turn.closed_at)}` : ''}${turn.resume_at ? `, resume ${t(turn.resume_at)}` : ''}${turn.waiting_operator ? ', waiting on the operator' : ''}`);

  // 2. Transcript: a call that waited on the operator (approval window, dialog) or still waits.
  const waits = [];
  for (const c of transcript?.calls || []) {
    if (!c.at || LONG_BY_DESIGN.test(c.name)) continue;
    if (c.name === 'Bash' && c.input?.run_in_background) continue;
    const start = Date.parse(c.at);
    const end = c.resultAt ? Date.parse(c.resultAt) : null;
    // A call without a result made after the nudge is this turn's own (the run of this script).
    if (end === null ? wokeAt - start >= WAIT_GAP_MS : end - start >= WAIT_GAP_MS && end >= since) waits.push({ c, start, end });
  }
  for (const w of waits.slice(-3)) {
    const kind = DIALOG_TOOLS.test(w.c.name) ? 'dialog' : 'approval window';
    if (w.end === null) facts.push(`transcript: ${callLabel(w.c)}: called ${t(w.start)}, no result yet (${kind} open, ${dur(wokeAt - w.start)})`);
    else facts.push(`transcript: ${callLabel(w.c)}: called ${t(w.start)}, result ${t(w.end)} after ${dur(w.end - w.start)} (${kind}, or a call that ran that long)`);
  }
  const lastWait = waits[waits.length - 1];
  if (lastWait) {
    const kind = DIALOG_TOOLS.test(lastWait.c.name) ? 'dialog' : 'approval-window';
    const span = lastWait.end === null ? `since ${t(lastWait.start)} and still open` : `${t(lastWait.start)}–${t(lastWait.end)} (${dur(lastWait.end - lastWait.start)})`;
    causes.push({ kind, workflow: kind === 'approval-window', text: `the turn stood on ${kind === 'dialog' ? 'a dialog' : 'an approval window'} of ${callLabel(lastWait.c)} ${span}; while a turn is open, no timer or bell rings it` });
  }
  if (transcript?.lastAt) {
    const idle = wokeAt - Date.parse(transcript.lastAt);
    const before = [...(transcript.prompts || [])].filter((p) => p.at && Date.parse(p.at) < wokeAt).map((p) => p.at);
    const prevAct = (transcript.calls || []).flatMap((c) => [c.at, c.resultAt]).concat(before).filter((x) => x && Date.parse(x) < wokeAt).sort().pop();
    if (prevAct && wokeAt - Date.parse(prevAct) >= WAIT_GAP_MS) facts.push(`transcript: no activity from ${t(prevAct)} until the nudge (${dur(wokeAt - Date.parse(prevAct))})`);
    else if (!nudge && idle >= WAIT_GAP_MS) facts.push(`transcript: last entry ${t(transcript.lastAt)} (${dur(idle)} ago)`);
  } else facts.push('transcript: not found (pass --transcript <file>)');

  // 3. Timers: due and not rung (the prompt hook spends a timer it rings).
  const log = wakeLines(wakeLog, thread, topics);
  const timers = threadTimers(state).filter((x) => !x.set_at || Date.parse(x.set_at) <= now);
  if (!timers.length) facts.push('timers: none');
  timers.forEach((x, i) => {
    const at = Date.parse(x.at);
    if (at > now) { facts.push(`timer ${i + 1}: ${t(at)} pending; then: ${clip(x.then, 100)}`); return; }
    const near = log.filter((l) => { const s = stampOf(l); return s && /continue/.test(l) && Math.abs(Date.parse(s) - at) < 3600_000; });
    const inWait = waits.find((w) => w.start <= at && (w.end === null || w.end >= at));
    const reason = near.length ? `wake log: ${clip(near[near.length - 1].replace(/^.*?\] /, ''), 120)}`
      : inWait ? `the turn was open then (${callLabel(inWait.c)} waited since ${t(inWait.start)}); the wake module rings only a closed turn`
        : turnOpen ? 'the turn record is open now; the wake module rings only a closed turn'
          : 'the wake log names no reason';
    facts.push(`timer ${i + 1}: ${t(at)} due, not rung (${dur(now - at)} late); then: ${clip(x.then, 100)}; ${reason}`);
    causes.push({ kind: 'timer-not-rung', workflow: true, text: `the timer of ${t(at)} did not ring (${reason})` });
  });

  // 4. Bells: what the wake module rang and whether it reached a turn.
  const rings = log.filter((l) => /\b(rang|continue rang|ring failed|continue ring failed|skip|release|limit)\b/.test(l) && (!stampOf(l) || (Date.parse(stampOf(l)) >= since && Date.parse(stampOf(l)) <= now)));
  for (const l of rings.slice(-5)) facts.push(`bell: ${clip(l.replace(/^.*?\[wake [^\]]+\] /, `${t(stampOf(l)) || ''} `), 200)}`);
  if (!rings.length) facts.push(wakeLog ? 'bells: none in the wake log for this thread' : 'bells: wake log not available');
  const queued = wakeState?.queued?.[thread];
  if (queued) facts.push(`bell queued behind the open run ${t(queued)} (wake-state)`);
  const failed = rings.filter((l) => /ring failed/.test(l));
  if (failed.length) causes.push({ kind: 'ring-failed', workflow: true, text: `a bell failed to ring the thread (${clip(failed[failed.length - 1].replace(/^.*?\] /, ''), 120)})` });
  const queuedRings = rings.filter((l) => /zvonček zaradený|queued/.test(l));
  if (queuedRings.length && lastWait) facts.push(`bells: ${queuedRings.length} queued behind the open turn, delivered only after it closed`);

  // 5. Mail: waiting (not picked up) and held back by a discussion with the operator.
  if (mail && !mail.unknown && mail.configured !== false) {
    const late = (mail.items || []).filter((m) => m.created_at && now - Date.parse(m.created_at) >= MAIL_LATE_MS);
    facts.push(`mail: ${mail.count || 0} waiting${late.length ? `, ${late.length} not picked up for over ${MAIL_LATE_MS / 60_000} min (${late.slice(0, 5).map((m) => `${m.id} ${m.level || ''}`.trim()).join(', ')})` : ''}`);
    if (late.length) causes.push({ kind: 'mail-not-picked', workflow: false, text: `${late.length} message(s) waited unpicked since ${t(late.map((m) => m.created_at).sort()[0])}` });
  } else facts.push(`mail: not checked${mail?.note ? ` (${mail.note})` : ''}`);
  const held = Object.values(wakeState?.held || {}).filter((h) => h && h.holder === thread);
  if (held.length) facts.push(`mail held by the wake module (discussion with the operator, no bell): ${held.slice(0, 5).map((h) => `${h.message_id} ${h.level || ''} to ${h.project || '?'}/${h.topic || '?'} since ${t(h.held_at || h.created_at)}`).join('; ')}`);
  const unanswered = (state.picked_assist || []).filter((w) => !w.state);
  if (unanswered.length) facts.push(`picked mail without an answer: ${unanswered.map((w) => w.id).join(', ')}`);

  // 6. Background work still counted as running.
  const ended = transcript ? finishedTasks(transcript.text) : new Set();
  const bg = (state.wakers || []).filter((w) => ['background', 'agent'].includes(w.kind) && Date.parse(w.at) <= now - LONG_BACKGROUND_MS && !(Array.isArray(w.tasks) && w.tasks.length && w.tasks.every((id) => ended.has(id))));
  for (const w of bg) facts.push(`background: ${w.kind}${w.tasks?.length ? ` ${w.tasks.join(', ')}` : ''} started ${t(w.at)}, no end seen (${dur(now - Date.parse(w.at))})`);
  if (bg.length && !causes.length) causes.push({ kind: 'background', workflow: false, text: `the thread waited on background work started ${t(bg[0].at)} with no end notified` });

  if (!causes.length) causes.push({ kind: 'unknown', workflow: false, text: 'the records show no reason: say so and what you checked' });
  return { facts, causes };
}

export function format({ thread, facts, causes }) {
  const wf = causes.some((c) => c.workflow);
  return [
    `nudge-why ${thread}`,
    ...facts.map((f) => `- ${f}`),
    ...causes.map((c) => `cause: ${c.kind}${c.workflow ? ' (workflow error)' : ''}: ${c.text}`),
    wf ? 'verdict: workflow error: fix it (skill fix) or queue the fix and report it (workflow:error); then mail and the next step of the handover'
      : 'verdict: no workflow error in the records: name the cause, then mail and the next step of the handover',
  ].join('\n');
}
