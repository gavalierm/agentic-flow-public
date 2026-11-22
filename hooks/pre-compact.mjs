#!/usr/bin/env node
// PreCompact (manual /compact and auto): plain stdout becomes the instructions of the compaction summary (Claude Code
// hooks reference, PreCompact output). The summary is the state of the work (P-026); the time of the compaction goes to
// the thread state so the start after it can weigh the handover against the summary. Never blocks: compaction inside a
// unit of work must not be blocked (P-026), so every error ends with exit 0 and the plain prompt.
import { readHookInput, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, patchThreadState } from '../scripts/config.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { COMPACT_PROMPT, compactInstructions } from '../scripts/compact.mjs';

export const HOOK_META = { event: 'PreCompact', class: 'summary instructions', limit: '10 000 chars (harness cap)', principles: ['P-026'] };

export function run(input, now = Date.now()) {
  const ctx = loadContext({ requireBrain: false });
  if (!ctx.brainDir || !ctx.thread) return compactInstructions({ now });
  const held = heldTopics(ctx.brainDir, ctx.thread);
  try {
    patchThreadState(ctx.brainDir, ctx.thread, { compacted_at: new Date(now).toISOString(), compact_trigger: input.trigger || null });
  } catch { /* state is best effort */ }
  return compactInstructions({ held, brainDir: ctx.brainDir, now });
}

if (isMain(import.meta.url)) {
  let out = COMPACT_PROMPT;
  try { out = run(readHookInput()); } catch (err) { process.stderr.write(`pre-compact: ${err.message}\n`); }
  process.stdout.write(`${out}\n`);
}
