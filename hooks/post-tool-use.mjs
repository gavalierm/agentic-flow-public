#!/usr/bin/env node
// PostToolUse / PostToolUseFailure: buffer command sequences and failures (P-030, P-028). Watch (2026-11-02, P-042): after
// a tool call the main thread learns once that a blocker or steer waits in its mailbox; checked at most every 15 s, silent
// when the mail service is down (P-041). Subagents are not watched. Own edits (P-018): the content the thread left in
// a file it changed from a clean state is recorded, so restoring it later does not ask the operator. Otherwise no output.
import { readHookInput, emit, isMain, contextOutput } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState, writeThreadState } from '../scripts/config.mjs';
import { bufferAppend, normalizeCommand } from '../scripts/logs.mjs';
import { mailCount } from '../scripts/comms.mjs';
import { mailboxTopics } from '../scripts/topic.mjs';
import path from 'node:path';
import { settleOwn, settleShell } from '../scripts/own-files.mjs';
import { bashTargets, bashEdits } from './pre-tool-use.mjs';
import { wakerFromTool, recordWaker } from '../scripts/waker.mjs';
import { updateNotice } from '../scripts/update-notice.mjs';

export const HOOK_META = { event: 'PostToolUse|PostToolUseFailure', class: 'log+c', limit: '1 line (once per waiting message)', principles: ['P-018', 'P-030', 'P-028', 'P-003', 'P-041', 'P-042', 'P-061', 'P-021'] };

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
  settleOwn(ctx, changedFiles(input));
  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') settleShell(ctx, input.tool_use_id);
  const entry = toEntry(input, ctx.policy);
  if (entry) bufferAppend(ctx.brainDir, input.session_id, entry);
  // P-061: a waker armed by this call (background task or agent, scheduler, mail) lets the turn end waiting.
  if (!input.agent_id && ctx.thread) recordWaker(ctx.brainDir, ctx.thread, wakerFromTool(input, now));
  const line = watch(ctx, input, now);
  return line ? contextOutput('PostToolUse', line) : {};
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
