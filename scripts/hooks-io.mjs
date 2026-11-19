// Translation of Claude Code hook stdin/stdout (P-017). Logic lives elsewhere; this file only shapes JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readHookInput() {
  let raw;
  // A stdin that cannot be read is an empty input, as before (the hook still runs: session start brings the rules).
  try { raw = fs.readFileSync(0, 'utf8'); } catch { return {}; }
  // A hook run by hand, without the input of the harness (a stdin that is read and empty), does nothing: it took the
  // thread id from the environment, opened and closed the turn record of that live thread in the mail and wrote its
  // thread state (maintainer 2026-11-19: a time measurement closed the running turn of its own thread). A harness
  // always sends JSON.
  if (!raw.trim()) {
    process.stderr.write('hook: empty stdin (no input of the harness), nothing done\n');
    process.exit(0);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * emit for a hook that called the mail client inside its process (scripts/comms.mjs clientInProcess): the process ends once
 * the output is written, whatever the client left open (a connection kept alive, a request past its deadline).
 */
export function emitAndExit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(0));
}

export function contextOutput(event, text, extra = {}) {
  const out = { ...extra };
  if (text && text.trim()) out.hookSpecificOutput = { hookEventName: event, additionalContext: text.replace(/\s+$/, '') };
  return out;
}

export function permissionOutput(decision, reason, additionalContext = null) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  return { hookSpecificOutput };
}

/** Enforce the P-023 line limit for mid-session hooks: report instead of trimming silently. */
export function enforceLines(text, max) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (lines.length <= max) return { text: lines.join('\n'), exceeded: false };
  return { text: lines.slice(0, max).join('\n'), exceeded: true, dropped: lines.length - max };
}
