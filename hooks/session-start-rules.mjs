#!/usr/bin/env node
// SessionStart, item 1 of P-021 (rules) in parts, one per hook entry (hooks.json: `session-start-rules.mjs 1` and `2`). The
// harness keeps at most 10 000 chars of one hook output in the context and shows a larger one only as a 2 KB preview: the
// boot context with the rules arrived in full in 58 of 366 starts (audit 2026-11-11), the rules of a persona alone are ~9 900
// chars. Resume: the transcript still holds the rules of its start, a change since then is re-injected by the prompt hook
// (changed sections only); a session without a recorded rules hash gets them here.
import { readHookInput, emit, contextOutput, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { rulesParts, waitBootPull, readBootStamp, markRulesPart, BOOT_MARKERS, RULES_HOOK_PARTS, RULES_PART_CHARS, RULES_READ_WAY } from '../scripts/boot.mjs';

export const HOOK_META = { event: 'SessionStart', class: 'boot', limit: `${RULES_PART_CHARS} chars per part`, principles: ['P-021', 'P-022'] };

/** The brain of an output whose part is through (the mark is written after the output, never before it). */
const through = new WeakMap();
const done = (out, ctx) => { if (ctx.brainDir) through.set(out, ctx.brainDir); return out; };

export function run(input, part = 1) {
  let ctx;
  try {
    ctx = loadContext({ project: input.cwd && !process.env.CLAUDE_PROJECT_DIR ? input.cwd : undefined, requireBrain: false });
  } catch {
    return {}; // session-start.mjs reports the context error
  }
  // session-start.mjs leaves rules_hash unchanged on resume, so this read does not race with its write.
  if ((input.source || 'startup') === 'resume' && ctx.brainDir && ctx.thread && readThreadState(ctx.brainDir, ctx.thread).rules_hash) return {};
  // The rules of the brain after its pull (P-040): session-start.mjs runs at the same time and stamps the end of its pull.
  // The stamp also names the project rules of other operators (session-start.mjs read the authors): marked [by <name>].
  const foreign = ctx.brainDir && waitBootPull(ctx.brainDir, input.session_id) ? readBootStamp(ctx.brainDir, input.session_id)?.foreign_rules || {} : {};
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code', foreign: (rel) => foreign[rel] || null, layers: ctx.layers });
  const parts = rulesParts(rules.shown);
  if (part > parts.length) return done({}, ctx);
  const shown = Math.min(parts.length, RULES_HOOK_PARTS);
  const text = part < RULES_HOOK_PARTS ? parts[part - 1] : parts.slice(part - 1).join('\n');
  const over = part === RULES_HOOK_PARTS && parts.length > RULES_HOOK_PARTS ? `\nlimit: rules need ${parts.length} parts of ${RULES_PART_CHARS} chars, the start carries ${RULES_HOOK_PARTS}; shorten the rules or run consolidate (P-022)` : '';
  return done(contextOutput('SessionStart', `${BOOT_MARKERS[0]}${shown > 1 ? ` (${part}/${shown})` : ''}\n${text}${over}`), ctx);
}

if (isMain(import.meta.url)) {
  const part = Math.max(1, Number.parseInt(process.argv[2] || '1', 10) || 1);
  try {
    const input = readHookInput();
    const out = run(input, part);
    emit(out, () => { if (through.has(out)) markRulesPart(through.get(out), input.session_id, part); });
  } catch (err) {
    // No mark: the first prompt of the session names the missing part and the way once more.
    emit(contextOutput('SessionStart', `## Workflow\nworkflow: session-start-rules ${part} failed (${err.message}); this part of the rules is missing: ${RULES_READ_WAY}`));
  }
}
