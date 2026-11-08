// Open window of the project wizard (skill workflow:project); kept small, the PreToolUse hook imports it.
import { readThreadState, writeThreadState } from './config.mjs';

// The project wizard may ask the operator in a dialog (operator 2026-11-04); the open window is in the thread state.
export const WIZARD_TTL_MS = 2 * 60 * 60 * 1000;

export function wizardOpen(brainDir, thread, now = Date.now()) {
  const w = readThreadState(brainDir, thread).wizard;
  return !!(w && Date.parse(w.until) > now);
}

export function setWizard(brainDir, thread, name, now = Date.now()) {
  if (!brainDir || !thread) throw new Error('the wizard needs a thread with a brain (WORKFLOW_THREAD_ID)');
  const state = readThreadState(brainDir, thread);
  if (name) state.wizard = { name, until: new Date(now + WIZARD_TTL_MS).toISOString() };
  else delete state.wizard;
  writeThreadState(brainDir, thread, state);
  return state.wizard || null;
}

/** Steps left for the T3 tools, kept in the thread state until `project.mjs t3 <dir> --registered`; the Stop hook names them. */
export function pendingT3Line(pending) {
  const items = Object.entries(pending || {}).filter(([, steps]) => steps?.length);
  if (!items.length) return null;
  return `T3 setup not finished (project skill): ${items.map(([dir, steps]) => `${dir}: ${steps.join('; ')}`).join(' | ')}. Do these steps with the T3 tools now, then run project.mjs t3 "<dir>" --registered for each folder`;
}
