#!/usr/bin/env node
// SubagentStop: the worker result must contain a "Failures" section (P-028), and "Failures: none" must not hide a failed
// source call in the worker transcript (flow-public#34). The triage subagent is removed (2026-11-02):
// the main agent reads the mechanical lines `<id> <category>` itself (P-044).
import fs from 'node:fs';
import path from 'node:path';
import { readHookInput, emit, isMain } from '../scripts/hooks-io.mjs';
import { loadPolicy, loadContext } from '../scripts/config.mjs';
import { logDecision } from '../scripts/denials.mjs';
import { appendOp } from '../scripts/logs.mjs';
import { brainWrite } from '../scripts/brain.mjs';
import { nowIso } from '../scripts/util.mjs';

export const HOOK_META = { event: 'SubagentStop', class: 'block', limit: '1 reason', principles: ['P-028'] };

export function hasFailuresSection(text) {
  return /(^|\n)\s*(#+\s*|\*\*)?failures\b/i.test(String(text || ''));
}

/** The text of the "Failures" section without its heading; "" when there is none or it says none (P-028). */
export function failuresText(text) {
  const s = String(text || '');
  const m = /(^|\n)\s*(#+\s*|\*\*)?failures\b/i.exec(s);
  if (!m) return '';
  const rest = s.slice(m.index + m[0].length).replace(/^[ \t:*\u2014\u2013-]*/, '').trim();
  return /^none\b/i.test(rest) ? '' : rest;
}

// Tools that read a source (web, MCP): a failed call there is a source not read, not a fact not found (flow-public#34: a
// worker reported sources it could not read as missing, with "Failures: none"). Bash is left out (grep without a match
// also ends with a non-zero exit code), except a command that runs a browser: a browser that did not start is a source
// not read, even when curl then returned a page without its JavaScript content (flow-public#52).
const SOURCE_TOOL = /^(WebFetch|WebSearch|mcp__.+)$/;
const BROWSER_CMD = /(^|[^\w-])(agent-browser|playwright|puppeteer|chromium(-browser)?|google-chrome|chrome\.exe|msedge(\.exe)?)([^\w-]|$)/i;
const isSourceCall = (c) => SOURCE_TOOL.test(String(c.name || '')) || (c.name === 'Bash' && BROWSER_CMD.test(String(c.input?.command || '')));
const TRANSCRIPT_MAX = 8 * 1024 * 1024;

/** The worker's own transcript: `agent_transcript_path`, else `<session>/subagents/agent-<id>.jsonl` next to the main transcript. */
export function agentTranscriptPath(input) {
  if (input.agent_transcript_path) return input.agent_transcript_path;
  if (!input.transcript_path || !input.session_id || !input.agent_id) return null;
  return path.join(path.dirname(input.transcript_path), input.session_id, 'subagents', `agent-${input.agent_id}.jsonl`);
}

/** Failed calls of source tools in a worker transcript (its last 8 MB): [{ tool, target, error }] (flow-public#34). */
export function failedSourceCalls(file) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TRANSCRIPT_MAX);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return []; }
  const calls = new Map();
  const failed = [];
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use' && isSourceCall(c)) calls.set(c.id, c);
      else if (c?.type === 'tool_result' && c.is_error === true && calls.has(c.tool_use_id)) {
        const use = calls.get(c.tool_use_id);
        const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text || '').join(' ') : '';
        const target = use.input?.url || use.input?.query || use.input?.command || Object.values(use.input || {}).find((v) => typeof v === 'string') || '';
        failed.push({ tool: use.name, target: String(target).slice(0, 120), error: body.replace(/\s+/g, ' ').trim().slice(0, 120) });
      }
    }
  }
  return failed;
}

/** One failures.log line in the shape the PostToolUse log uses: `<time> <agent> <session> <command> :: <error>` (error list reads field 2). */
export function failureLine(input, failures, now = nowIso()) {
  const agent = String(input.agent_id || input.agent_type || 'worker').replace(/\s+/g, '-');
  const session = String(input.session_id || 'subagent').replace(/\s+/g, '-');
  return `${now} ${agent} ${session} worker-result :: ${failures.replace(/\s+/g, ' ').slice(0, 400)}`;
}

/** A worker result with a non-empty Failures section goes to <brain>/logs/failures.log, the same write as the log flush (issue #28). */
export function recordWorkerFailures(input, ctx, now = nowIso()) {
  if (!/(^|:)worker$/.test(String(input.agent_type || ''))) return null;
  const failures = failuresText(input.last_assistant_message);
  if (!failures || !ctx.brainDir) return null;
  const line = failureLine(input, failures, now);
  brainWrite(ctx, { ops: [appendOp('failures.log', [line])], internal: true, message: 'worker failures' });
  return line;
}

export function run(input, policy = loadPolicy(null)) {
  if (input.stop_hook_active) return {};
  const exempt = policy.harness?.subagent_stop_exempt_agent_types || [];
  if (exempt.includes(input.agent_type)) return {};
  // Only the workflow worker gets the result rules (delegate.mjs prepare); a built-in or plugin agent never saw them,
  // and a block there only cost a turn (operator 2026-11-08, hooks review).
  if (!/(^|:)worker$/.test(String(input.agent_type || ''))) return {};
  // The limit is enforced here: 45 of 47 results were over it and the manual `delegate.mjs check` ran 0 times (audit M4
  // 2026-11-11). A block costs the worker one cached turn; stop_hook_active above lets the second stop through.
  const text = String(input.last_assistant_message || '');
  const limit = policy.limits?.worker_result_chars ?? 3000;
  const errors = [];
  if (!hasFailuresSection(text)) errors.push('the result must end with a section "Failures: <what failed and what finally worked>" (write "Failures: none" if nothing failed), P-028');
  if (hasFailuresSection(text) && !failuresText(text)) {
    const file = agentTranscriptPath(input);
    const failed = file ? failedSourceCalls(file) : [];
    if (failed.length) errors.push(`${failed.length} source call(s) failed (${failed.slice(0, 3).map((f) => `${f.tool} ${f.target}: ${f.error}`).join('; ')}), yet the result says "Failures: none": a source not read (error, blocked, empty or cut page) is a failure, list it under Failures and in the conclusion tell sources not read apart from facts not found (P-028, flow-public#34)`);
  }
  if (text.length > limit) errors.push(`the result has ${text.length} chars, the limit is ${limit} (P-027): keep the conclusion and its sources (paths, lines, commands), drop raw content and repeated detail`);
  if (!errors.length) return {};
  return { decision: 'block', reason: `Return the result again: ${errors.join('; ')}.` };
}

if (isMain(import.meta.url)) {
  try {
    const input = readHookInput();
    // The project's composed policy (D-0025): its limit and exempt types, not the plugin's alone.
    let ctx = null;
    try { ctx = loadContext({ requireBrain: false }); } catch (err) { process.stderr.write(`subagent-stop: plugin policy only: ${err.message}\n`); }
    const out = ctx ? run(input, ctx.policy) : run(input);
    if (!out.decision) {
      try {
        if (!ctx) throw new Error('no context');
        recordWorkerFailures(input, ctx);
      } catch (err) { process.stderr.write(`subagent-stop: failures not recorded: ${err.message}\n`); }
    }
    if (out.decision === 'block') {
      try {
        logDecision(ctx.brainDir, { event: 'SubagentStop', out, thread: ctx.thread, agentType: input.agent_type });
      } catch { /* the log never changes the decision */ }
    }
    emit(out);
  } catch (err) {
    process.stderr.write(`subagent-stop: ${err.message}\n`);
    emit({});
  }
}
