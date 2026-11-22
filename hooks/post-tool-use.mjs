#!/usr/bin/env node
// PostToolUse / PostToolUseFailure: buffer command sequences and failures (P-030, P-028). Watch (2026-11-02, P-042): after
// a tool call the main thread learns once that a blocker or steer waits in its mailbox; checked at most every 15 s, silent
// when the mail service is down (P-041). Subagents are not watched. Own edits (P-018): the content the thread left in
// a file it changed from a clean state is recorded, so restoring it later does not ask the operator. Otherwise no output.
import { readHookInput, emitAndExit, isMain, contextOutput } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState, updateThreadState, patchThreadState, SCRATCH_DIR } from '../scripts/config.mjs';
import { isInside } from '../scripts/util.mjs';
import { isSessionWorkPath } from '../scripts/layout.mjs';
import { markProgress } from '../scripts/topic-turn.mjs';
import { withLift } from '../scripts/bypass.mjs';
import { bufferAppend, normalizeCommand } from '../scripts/logs.mjs';
import { mailCountAsync, recordWaitingOperator, categoryOf } from '../scripts/comms.mjs';
import { mailboxTopics } from '../scripts/topic.mjs';
import path from 'node:path';
import { heldTopics, topicCopyPath, taskCopyPaths } from '../scripts/topic.mjs';
import { pushFailureLines, clearPushFailures } from '../scripts/push-hook.mjs';
import { settleCall, settleShell, recordScratch, inWorkScratch } from '../scripts/own-files.mjs';
import { bashTargets, bashEdits } from './pre-tool-use.mjs';
import { wakerFromTool, recordWaker } from '../scripts/waker.mjs';
import { updateNotice } from '../scripts/update-notice.mjs';
import { recordPublish } from '../scripts/artifacts.mjs';
import { shownFile, tmpOwner, syncResults, savedLine } from '../scripts/results.mjs';
import { brainWrite } from '../scripts/brain.mjs';
import { isMainTopic } from '../scripts/comms.mjs';
import { contextTokens, compactNudge } from '../scripts/compact.mjs';

export const HOOK_META = { event: 'PostToolUse|PostToolUseFailure', class: 'log+c', limit: '1 line (once per waiting message; once per read step)', principles: ['P-001', 'P-018', 'P-030', 'P-028', 'P-003', 'P-041', 'P-042', 'P-061', 'P-021'] };

// P-001 (2026-11-11): a web project's main thread read a whole page, all CSS and JS, web sources and an image itself and
// its context was compacted after 8 minutes; the rule "research goes to a worker" was text only. The main thread now
// learns how much tool output it took in since the session (re)started and is pointed to a worker at each step.
export const READ_STEP_CHARS = 80_000;
export const WEB_NUDGE_CALLS = 2;
export const IMAGE_CHARS = 6_000;
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

export const WATCH_INTERVAL_MS = 15_000;
export const WATCHED_LEVELS = ['blocker', 'steer'];

/** curl -o /dev/null on Windows Git Bash with MSYS_NO_PATHCONV=1 exits 23 (it cannot write to a literal /dev/null) after a
 * correct status code: no failure (a project 2026-11-18, 12 entries in one day). */
export function curlNullWrite(command, error) {
  return /\bcurl\b/.test(command) && /-o\s*\/dev\/null\b/.test(command) && /^Exit code 23\b/m.test(error);
}

export function toEntry(input, policy) {
  const agent = input.agent_id || 'main';
  const tool = input.tool_name;
  const command = String(input.tool_input?.command || '');
  const response = input.tool_response || {};
  const failed = input.hook_event_name === 'PostToolUseFailure' || response.interrupted === true || /^Exit code [1-9]/m.test(String(response.stderr || response.error || ''));
  if (failed && !curlNullWrite(command, String(input.error || response.error || response.stderr || ''))) {
    const error = String(input.error || response.error || response.stderr || response.stdout || '').trim();
    return { kind: 'fail', agent, tool, command: command || tool, error };
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  return { kind: 'cmd', agent, commands: normalizeCommand(command, policy) };
}

/**
 * The watch line for blockers and steers that wait and were not announced yet (`watch_seen` in the thread state).
 * Returns { line, seen } or null when nothing new waits. Bodies are never shown: the line names ids and levels only.
 */
export function watchLine(items = [], seen = []) {
  const known = new Set(seen);
  // A reply to this thread's own message is announced too (report 2026-11-18: a final reply came 9 s before the end of the
  // turn, unread, and the result was built on older data).
  const fresh = items.filter((it) => (WATCHED_LEVELS.includes(it.level) || categoryOf(it) === 'reply') && !known.has(it.id));
  if (!fresh.length) return null;
  const reply = fresh.some((it) => categoryOf(it) === 'reply')
    ? '; reply to your message: read it and use it before you end the turn'
    : '';
  const steer = fresh.some((it) => it.level === 'steer')
    ? '; steer: read it now and adjust the work on the topic to it, then continue working; a message never stops the work'
    : '';
  const line = `mail waiting: ${fresh.map((it) => `${it.id} ${categoryOf(it) === 'reply' ? 'reply' : it.level}`).join(', ')}; read with comms receive --id <id>${steer}${reply} (P-042${steer || reply ? ', P-061' : ''})`;
  return { line, seen: [...seen, ...fresh.map((it) => it.id)].slice(-200) };
}

/**
 * Watch for the main thread: throttled, announced once per message, silent on an outage (P-041). A steer into the running
 * turn is shown after a tool also in a discussion with the operator (the thread is running and reads it now, P-061); an
 * assist waits for the end of the discussion (D-0022, not watched anyway). The waiting mail is the inbox of the mail's
 * `obligations` (P-072).
 */
export async function watch(ctx, input, now = Date.now()) {
  if (input.agent_id || input.agent_type || !ctx.brainDir || !ctx.thread) return null;
  const state = readThreadState(ctx.brainDir, ctx.thread);
  if (now - (state.watch_at || 0) < WATCH_INTERVAL_MS) return null;
  const upd = updateNotice(state);
  // watch_at is written before the mail is asked: the parallel hooks of this thread that come during the question (await)
  // find it and do not ask the mail again.
  patchThreadState(ctx.brainDir, ctx.thread, { ...(upd?.patch || {}), watch_at: now });
  const mail = await mailCountAsync(ctx, mailboxTopics(ctx));
  const lines = upd?.line ? [upd.line.replace('changed rules follow in full', 'changed rules come with the next prompt')] : [];
  const res = mail.available ? watchLine(mail.items || [], state.watch_seen || []) : null;
  if (res) {
    patchThreadState(ctx.brainDir, ctx.thread, { watch_seen: res.seen });
    lines.push(res.line);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Characters a tool result adds to the context; an image counts as IMAGE_CHARS, not its base64 data. */
export function outputChars(response) {
  if (response == null) return 0;
  if (typeof response === 'string') return response.length;
  let images = 0;
  const text = JSON.stringify(response, (key, value) => {
    if (value && typeof value === 'object' && value.type === 'image') { images += 1; return undefined; }
    if (key === 'base64' || (key === 'data' && typeof value === 'string' && value.length > 1000)) { images += 1; return undefined; }
    return value;
  }) || '';
  return text.length + images * IMAGE_CHARS;
}

/**
 * Read budget of the main thread (P-001): tool output since the session start or the last compaction (session-start
 * clears it). Returns { line, budget }: a line at each READ_STEP_CHARS step and once at the WEB_NUDGE_CALLS-th web call.
 */
export function readNudge(budget, input, chars = outputChars(input.tool_response)) {
  const b = { chars: 0, web: 0, step: 0, web_said: false, ...(budget || {}) };
  b.chars += chars;
  if (WEB_TOOLS.includes(input.tool_name)) b.web += 1;
  const lines = [];
  const step = Math.floor(b.chars / READ_STEP_CHARS);
  if (step > b.step) {
    b.step = step;
    lines.push(`context: the main thread took in ~${Math.round(b.chars / 1000)} KB of tool output this session; further surveys (other files, styles, logs, docs, sources) go to a worker (workflow:delegate, delegate.mjs prepare --task) that returns the conclusion; read here only the part you edit (P-001)`);
  }
  if (b.web >= WEB_NUDGE_CALLS && !b.web_said) {
    b.web_said = true;
    lines.push('context: checking web sources is research: give the remaining checks to a worker (workflow:delegate), it returns the facts with their URLs, not the pages (P-001)');
  }
  return { line: lines.length ? lines.join('\n') : null, budget: b };
}

/** Read budget line for the main thread; subagents read on their own context and are not counted. */
export function readBudget(ctx, input) {
  if (input.agent_id || input.agent_type || !ctx.brainDir || !ctx.thread) return null;
  // The size of the output is counted before the lock (a large result); the sum is added to the current budget inside
  // it, so the results of parallel reads all count.
  const chars = outputChars(input.tool_response);
  let line = null;
  updateThreadState(ctx.brainDir, ctx.thread, (state) => {
    const r = readNudge(state.read_budget, input, chars);
    line = r.line;
    return { ...state, read_budget: r.budget };
  });
  return line;
}

/**
 * P-026 (operator 2026-11-16): near the auto-compact window the main thread that holds a topic saves its handover while
 * it still has the whole context; once per context (session-start clears `compact_nudged`).
 */
export function compactLine(ctx, input) {
  if (input.agent_id || input.agent_type || !ctx.brainDir || !ctx.thread) return null;
  const state = readThreadState(ctx.brainDir, ctx.thread);
  if (state.compact_nudged) return null;
  const window = ctx.policy?.compaction?.auto_compact_window_tokens ?? 200000;
  const r = compactNudge({ tokens: contextTokens(input.transcript_path), window, state, held: heldTopics(ctx.brainDir, ctx.thread) });
  if (!r) return null;
  patchThreadState(ctx.brainDir, ctx.thread, r.patch);
  return r.line;
}

/** Files the finished tool call changed (file tools, shell targets and in-place edits). */
export function changedFiles(input) {
  const cwd = input.cwd || process.cwd();
  const ti = input.tool_input || {};
  const file = input.tool_name === 'NotebookEdit' ? ti.notebook_path : ['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) ? ti.file_path : null;
  if (file) return [path.resolve(cwd, file)];
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') return [...bashTargets(String(ti.command || ''), cwd), ...bashEdits(String(ti.command || ''), cwd)];
  return [];
}

/**
 * Spec 10.2: a save of any type except the handover (save.mjs <type>, save.mjs source and result included) is progress of the held
 * topic: the next continuation count starts from zero. Only a call of the main thread that succeeded.
 */
export function progressCommand(command) {
  const c = String(command || '');
  const save = /(?:^|[\s/\\"'])save\.mjs["']?\s+([a-z][\w-]*)/.exec(c);
  return !!save && save[1] !== 'handover';
}

export async function run(input, now = Date.now()) {
  const ctx = loadContext({ requireBrain: false });
  if (!ctx.brainDir) return {};
  // P-061 (V1): the operator answered (or dismissed) the dialog: the open turn no longer waits for the operator.
  if ((input.tool_name === 'AskUserQuestion') && !input.agent_id && ctx.thread) recordWaitingOperator(ctx, false, readThreadState(ctx.brainDir, ctx.thread).turn_opened_at ?? null);
  // The answered dialog: its questions and answers (flow-public#46 lifts, D-0011 done --topic, P-063 turn intent).
  if (input.tool_name === 'AskUserQuestion' && !input.agent_id && ctx.thread) {
    const given = (Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : []).map((x) => (typeof x === 'string' ? x : x?.question)).filter(Boolean);
    const answers = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response.answers : null;
    const answerOf = (q) => (answers && typeof answers === 'object' ? String(answers[q] ?? '') : '');
    updateThreadState(ctx.brainDir, ctx.thread, (st) => {
      // A dialog closed without an answer answers nothing; a harness that reports no answers counts every question.
      const asked = given.length ? given : st.dialog_questions || [];
      const items = answers && typeof answers === 'object' ? asked.filter((q) => String(answers[q] ?? '').trim()) : asked;
      // D-0011: an answer in this turn lets done --topic close the topic also in a turn started by a message.
      // P-063: the operator's answer in the dialog decides the next step, so the turn is no longer only his question.
      const answeredNow = items.length ? { dialog_answered_at: new Date(now).toISOString(), turn_intent: null } : {};
      // flow-public#46: an answer that allows a target the question names opens it for the rest of the turn (P-054).
      const lifted = items.reduce((s, q) => withLift(s, q, answerOf(q), new Date(now).toISOString()), st);
      return { ...lifted, dialog_questions: [], ...answeredNow };
    });
  }
  // report-80357d47: the address of a published artifact outlives the context (scripts/artifacts.mjs).
  let published = null;
  if (!input.agent_id) { try { published = recordPublish(ctx, input, now); } catch { /* the record never fails the hook */ } }
  // P-078: a work file shown to the operator (Artifact, html_preview) is a result of the held topic, saved at once.
  const shown = !input.agent_id && input.hook_event_name !== 'PostToolUseFailure' ? saveShown(ctx, input, published, now) : null;
  settleCall(ctx, input.tool_use_id, changedFiles(input), input.hook_event_name !== 'PostToolUseFailure' && input.tool_response?.interrupted !== true);
  // report-143e7cdb: what this thread leaves in a scratch/ is its own; another thread's recursive rm of the dir asks (P-018).
  // The work files are in the topic home (a brain in layout 2, D-0056), isSessionWorkPath.
  recordScratch(ctx, changedFiles(input), (abs) => (ctx.projectDir && isSessionWorkPath(ctx.brainDir, ctx.projectDir, abs)) || inWorkScratch(abs));
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') settleShell(ctx, input.tool_use_id);
  const entry = toEntry(input, ctx.policy);
  if (entry) bufferAppend(ctx.brainDir, input.session_id, entry);
  if (entry?.kind === 'cmd' && !input.agent_id && ctx.thread && progressCommand(input.tool_input?.command)) markProgress(ctx.brainDir, ctx.thread, now);
  // P-061: a waker armed by this call (background task or agent, scheduler, mail) lets the turn end waiting.
  if (!input.agent_id && ctx.thread) recordWaker(ctx.brainDir, ctx.thread, wakerFromTool(input, now));
  const lines = [shown, readBudget(ctx, input), await watch(ctx, input, now), compactLine(ctx, input)].filter(Boolean);
  return lines.length ? contextOutput('PostToolUse', lines.join('\n')) : {};
}

/**
 * P-078: the work file an Artifact publish or html_preview showed to the operator goes into the results of the topic the
 * thread holds (bound to its source, scripts/results.mjs). One line of what was saved, or null; a failure never fails the hook.
 */
export function saveShown(ctx, input, url = null, now = Date.now()) {
  if (!ctx.brainDir || !ctx.thread) return null;
  const file = shownFile(input);
  if (!file || !tmpOwner(ctx.brainDir, file)) return null;
  try {
    const topic = heldTopics(ctx.brainDir, ctx.thread).find((t) => !isMainTopic(t));
    if (!topic) return null;
    const via = input.tool_name === 'Artifact' ? 'artifact' : 'preview';
    const res = syncResults(ctx.brainDir, topic.id, { policy: ctx.policy, extra: [{ abs: file, via, url }], now });
    if (!res.ops.length) return null;
    brainWrite(ctx, { ops: res.ops, internal: true, sync: false, message: `save result ${res.saved.map((s) => s.name).join(', ') || 'bindings'} (${via}, P-078)` });
    return savedLine(topic.id, res);
  } catch (err) {
    return `result not saved (P-078): ${String(err.message).split('\n')[0]}`;
  }
}

/**
 * Plan O16 (spec 3.7): one line per commit of a topic or task worktree of this thread that its post-commit hook could not
 * push, once, after a git command that commits. Null when nothing failed.
 */
export function pushFailureLine(input, said = null) {
  if (!['Bash', 'PowerShell'].includes(input.tool_name) || !/\b(commit|merge|cherry-pick|revert|rebase|am)\b/.test(String(input.tool_input?.command || ''))) return null;
  const ctx = loadContext({ requireBrain: false });
  if (!ctx.brainDir || !ctx.thread) return null;
  const dirs = heldTopics(ctx.brainDir, ctx.thread).flatMap((t) => [topicCopyPath(ctx, t), ...taskCopyPaths(ctx, t)]).filter(Boolean);
  const lines = pushFailureLines(dirs, said);
  return lines.length ? lines.join('\n') : null;
}

if (isMain(import.meta.url)) {
  let out = {};
  const said = [];
  try {
    const input = readHookInput();
    out = await run(input);
    const push = pushFailureLine(input, said);
    if (push) out = { ...out, ...contextOutput('PostToolUse', [out.hookSpecificOutput?.additionalContext, push].filter(Boolean).join('\n')) };
  } catch (err) {
    process.stderr.write(`post-tool-use: ${err.message}\n`);
  }
  emitAndExit(out, () => clearPushFailures(said));
}
