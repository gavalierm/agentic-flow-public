#!/usr/bin/env node
// PostToolUse / PostToolUseFailure: buffer command sequences and failures (P-030, P-028). Watch (2026-11-02, P-042): after
// a tool call the main thread learns once that a blocker or steer waits in its mailbox; checked at most every 15 s, silent
// when the mail service is down (P-041). Subagents are not watched. Own edits (P-018): the content the thread left in
// a file it changed from a clean state is recorded, so restoring it later does not ask the operator. Otherwise no output.
import { readHookInput, emit, isMain, contextOutput } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState, writeThreadState } from '../scripts/config.mjs';
import { withAnswered } from '../scripts/protocol.mjs';
import { bufferAppend, normalizeCommand } from '../scripts/logs.mjs';
import { mailCount, recordWaitingOperator } from '../scripts/comms.mjs';
import { mailboxTopics } from '../scripts/topic.mjs';
import path from 'node:path';
import { settleOwn, settleShell } from '../scripts/own-files.mjs';
import { bashTargets, bashEdits } from './pre-tool-use.mjs';
import { wakerFromTool, recordWaker } from '../scripts/waker.mjs';
import { updateNotice } from '../scripts/update-notice.mjs';

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

export function toEntry(input, policy) {
  const agent = input.agent_id || 'main';
  const tool = input.tool_name;
  const command = String(input.tool_input?.command || '');
  const response = input.tool_response || {};
  const failed = input.hook_event_name === 'PostToolUseFailure' || response.interrupted === true || /^Exit code [1-9]/m.test(String(response.stderr || response.error || ''));
  if (failed) {
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
  const fresh = items.filter((it) => WATCHED_LEVELS.includes(it.level) && !known.has(it.id));
  if (!fresh.length) return null;
  const steer = fresh.some((it) => it.level === 'steer')
    ? '; steer: read it now and adjust the work on the topic to it, then continue working; a message never stops the work'
    : '';
  const line = `mail waiting: ${fresh.map((it) => `${it.id} ${it.level}`).join(', ')}; read with comms receive --id <id>${steer} (P-042${steer ? ', P-061' : ''})`;
  return { line, seen: [...seen, ...fresh.map((it) => it.id)].slice(-200) };
}

/** Watch for the main thread: throttled, announced once per message, silent on an outage (P-041). */
export function watch(ctx, input, now = Date.now()) {
  if (input.agent_id || input.agent_type || !ctx.brainDir || !ctx.thread) return null;
  const state = readThreadState(ctx.brainDir, ctx.thread);
  if (now - (state.watch_at || 0) < WATCH_INTERVAL_MS) return null;
  const upd = updateNotice(state);
  const mail = mailCount(ctx, mailboxTopics(ctx));
  writeThreadState(ctx.brainDir, ctx.thread, { ...state, ...(upd?.patch || {}), watch_at: now });
  const lines = upd?.line ? [upd.line.replace('changed rules follow in full', 'changed rules come with the next prompt')] : [];
  const res = mail.available ? watchLine(mail.items || [], state.watch_seen || []) : null;
  if (res) {
    writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), watch_seen: res.seen });
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
export function readNudge(budget, input) {
  const b = { chars: 0, web: 0, step: 0, web_said: false, ...(budget || {}) };
  b.chars += outputChars(input.tool_response);
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
  const state = readThreadState(ctx.brainDir, ctx.thread);
  const r = readNudge(state.read_budget, input);
  writeThreadState(ctx.brainDir, ctx.thread, { ...state, read_budget: r.budget });
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

export function run(input, now = Date.now()) {
  const ctx = loadContext({ requireBrain: false });
  if (!ctx.brainDir) return {};
  // P-061 (V1): the operator answered (or dismissed) the dialog: the open turn no longer waits for the operator.
  if ((input.tool_name === 'AskUserQuestion') && !input.agent_id && ctx.thread) recordWaitingOperator(ctx, false, readThreadState(ctx.brainDir, ctx.thread).turn_opened_at ?? null);
  // P-059: the answered dialog question stands for further steps of its kind (the input's questions, else those PreToolUse kept).
  if (input.tool_name === 'AskUserQuestion' && !input.agent_id && ctx.thread) {
    const st = readThreadState(ctx.brainDir, ctx.thread);
    const given = (Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : []).map((x) => (typeof x === 'string' ? x : x?.question)).filter(Boolean);
    const answers = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response.answers : null;
    // A dialog closed without an answer answers nothing; a harness that reports no answers counts every question.
    const asked = given.length ? given : st.dialog_questions || [];
    const items = answers && typeof answers === 'object' ? asked.filter((q) => String(answers[q] ?? '').trim()) : asked;
    // D-0011: an answer in this turn lets done --topic close the topic also in a turn started by a message.
    const answeredNow = items.length ? { dialog_answered_at: new Date(now).toISOString() } : {};
    writeThreadState(ctx.brainDir, ctx.thread, { ...withAnswered(st, items), dialog_questions: [], ...answeredNow });
  }
  settleOwn(ctx, changedFiles(input));
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') settleShell(ctx, input.tool_use_id);
  const entry = toEntry(input, ctx.policy);
  if (entry) bufferAppend(ctx.brainDir, input.session_id, entry);
  // P-061: a waker armed by this call (background task or agent, scheduler, mail) lets the turn end waiting.
  if (!input.agent_id && ctx.thread) recordWaker(ctx.brainDir, ctx.thread, wakerFromTool(input, now));
  const lines = [readBudget(ctx, input), watch(ctx, input, now)].filter(Boolean);
  return lines.length ? contextOutput('PostToolUse', lines.join('\n')) : {};
}

if (isMain(import.meta.url)) {
  let out = {};
  try {
    out = run(readHookInput());
  } catch (err) {
    process.stderr.write(`post-tool-use: ${err.message}\n`);
  }
  emit(out);
}
