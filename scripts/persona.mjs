// Persona = project whose repository is its brain (P-024). Generated files are committed through the brain script (P-040).
import fs from 'node:fs';
import path from 'node:path';
import { brainWrite } from './brain.mjs';

/** Set by a caller whose commits wait for a check (migrate.mjs): the adapter commits the persona's files and pushes nothing. */
export const NO_PUSH_ENV = 'WORKFLOW_NO_PUSH';

/** Commit generated files of a persona through the brain script; returns one note line. */
export function commitPersonaFiles({ brainDir, policy, files }) {
  const ops = files
    .filter((rel) => fs.existsSync(path.join(brainDir, rel)))
    .map((rel) => ({ path: rel, content: fs.readFileSync(path.join(brainDir, rel), 'utf8') }));
  try {
    // A migration runs the adapter before its check: the persona's brain is the repo it moved, so no push (the push of the
    // move waits for the check, release-2.0 step 4; agent-bob 2026-11-16 was pushed in the middle of the apply).
    const noPush = process.env[NO_PUSH_ENV] === '1';
    const res = brainWrite({ brainDir, thread: null, policy }, { ops, message: 'adapter: generated files of the persona', internal: true, sync: !noPush });
    if (noPush) return res.committed ? `persona: generated files committed (${res.sha}, not pushed)` : 'persona: generated files unchanged';
    return res.committed ? `persona: generated files committed (${res.sha})${res.warnings.length ? `; ${res.warnings.join('; ')}` : ''}` : 'persona: generated files unchanged';
  } catch (err) {
    return `persona: commit of generated files failed: ${err.message.split('\n')[0]}`;
  }
}
