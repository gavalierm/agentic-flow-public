#!/usr/bin/env node
// Codex hook translator (P-017): shapes stdin/stdout for the three events whose Codex format differs from Claude Code.
// No workflow logic here; it calls the same hook scripts as Claude Code.
//   hook.mjs session-start | pre-tool-use | stop   (JSON on stdin, JSON on stdout, exit 0)
import path from 'node:path';
import { readHookInput, emit, contextOutput, permissionOutput, isMain } from '../../scripts/hooks-io.mjs';
import { loadContext } from '../../scripts/config.mjs';
import { buildBootContext } from '../../scripts/boot.mjs';
import { readText } from '../../scripts/util.mjs';
import { run as preToolUse, NO_ASK_WAY } from '../../hooks/pre-tool-use.mjs';
import { run as stop } from '../../hooks/stop.mjs';
import { agentsBlock, extractAgentsBlock } from './generate.mjs';

/** One notice line when AGENTS.md does not match the assembled rules (P-017: generated files equal the source). */
export function agentsNotice(ctx, rulesText) {
  const text = readText(path.join(ctx.projectDir, 'AGENTS.md'), null);
  if (text === null) return 'AGENTS.md missing: run node <plugin>/bin/adapter.mjs codex (P-017)';
  const block = extractAgentsBlock(text);
  if (!block) return 'AGENTS.md has no workflow block: run node <plugin>/bin/adapter.mjs codex (P-017)';
  const brainRel = ctx.brainInfo?.brainRel || '../<brain>';
  return block === agentsBlock(rulesText, brainRel) ? null : 'AGENTS.md stale (rules or exceptions changed): run node <plugin>/bin/adapter.mjs codex (P-017)';
}

/** SessionStart: items 3-7 of the boot sequence; item 1 (rules) is carried by AGENTS.md. Same output shape as Claude Code. */
export function sessionStart(input) {
  let ctx;
  try {
    ctx = loadContext({ requireBrain: false });
  } catch (err) {
    return contextOutput('SessionStart', `## Workflow\nworkflow: cannot load context (${err.message})`);
  }
  const boot = buildBootContext(ctx, { source: input.source || 'startup', harness: 'codex', includeRules: false });
  const notice = agentsNotice(ctx, boot.rules.text);
  return contextOutput('SessionStart', notice ? `${boot.text.replace(/\s*$/, '')}\n${notice}\n` : boot.text);
}

/** File targets of an apply_patch payload (`*** Add File: p`, `*** Update File: p`, `*** Delete File: p`, `*** Move to: p`). */
export function patchTargets(patch) {
  return [...String(patch || '').matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => ({ op: m[1], file: m[2].trim() }));
}

/**
 * PreToolUse: `apply_patch` is translated into one Edit/Write check per file; a step that needs the operator's consent
 * is a deny already (D-0042), Codex has no dialog, so its way becomes the Codex one (P-017, P-018).
 */
export function preToolUseCodex(input) {
  let results;
  if (input.tool_name === 'apply_patch') {
    results = patchTargets(input.tool_input?.command).map((t) => preToolUse({
      ...input,
      tool_name: t.op === 'Delete File' ? 'Write' : 'Edit',
      tool_input: t.op === 'Delete File' ? { file_path: t.file, content: '' } : { file_path: t.file },
    }));
  } else {
    results = [preToolUse(input)];
  }
  const decided = (d) => results.find((r) => r.hookSpecificOutput?.permissionDecision === d);
  const deny = decided('deny');
  const why = deny?.hookSpecificOutput?.permissionDecisionReason || '';
  if (why.endsWith(NO_ASK_WAY)) {
    return permissionOutput('deny', `${why.slice(0, -NO_ASK_WAY.length).replace(/[\s.]+$/, '')}. Codex cannot ask: commit the target first so it is recoverable from git, or let the operator perform this step (P-018, D-0042)`);
  }
  if (deny) return deny;
  const context = results.map((r) => r.hookSpecificOutput?.additionalContext).filter(Boolean);
  return context.length ? contextOutput('PreToolUse', context[0]) : {};
}

/**
 * Stop: same turn record, logging and signal queue as Claude Code. A missing reply to `assist` is found by the message
 * TTL in the mail service (P-042, P-043), so Stop adds no continuation turn.
 */
export function stopCodex(input) {
  stop(input);
  return {};
}

if (isMain(import.meta.url)) {
  const event = process.argv[2];
  const input = readHookInput();
  try {
    if (event === 'session-start') emit(sessionStart(input));
    else if (event === 'pre-tool-use') emit(preToolUseCodex(input));
    else if (event === 'stop') emit(stopCodex(input));
    else { process.stderr.write(`codex hook: unknown event "${event}"\n`); emit({}); }
  } catch (err) {
    process.stderr.write(`codex hook ${event}: ${err.message}\n`);
    emit(event === 'session-start' ? contextOutput('SessionStart', `## Workflow\nworkflow: session-start failed (${err.message})`) : {});
  }
}
