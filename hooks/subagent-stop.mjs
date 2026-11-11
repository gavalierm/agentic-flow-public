#!/usr/bin/env node
// SubagentStop: the worker result must contain a "Failures" section (P-028). The triage subagent is removed (2026-11-02):
// the main agent reads the mechanical lines `<id> <category>` itself (P-044).
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
  if (text.length > limit) errors.push(`the result has ${text.length} chars, the limit is ${limit} (P-027): keep the conclusion and its sources (paths, lines, commands), drop raw content and repeated detail`);
  if (!errors.length) return {};
  return { decision: 'block', reason: `Return the result again: ${errors.join('; ')}.` };
}

if (isMain(import.meta.url)) {
  try {
    const input = readHookInput();
    const out = run(input);
    if (!out.decision) {
      try {
        recordWorkerFailures(input, loadContext({ requireBrain: false }));
      } catch (err) { process.stderr.write(`subagent-stop: failures not recorded: ${err.message}\n`); }
    }
    if (out.decision === 'block') {
      try {
        const ctx = loadContext({ requireBrain: false });
        logDecision(ctx.brainDir, { event: 'SubagentStop', out, thread: ctx.thread, agentType: input.agent_type });
      } catch { /* the log never changes the decision */ }
    }
    emit(out);
  } catch (err) {
    process.stderr.write(`subagent-stop: ${err.message}\n`);
    emit({});
  }
}
