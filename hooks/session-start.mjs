#!/usr/bin/env node
// SessionStart (startup, resume, clear, compact): boot sequence P-021 items 1, 3-7. Output class: boot context, limit 15 000 chars.
import fs from 'node:fs';
import path from 'node:path';
import { readHookInput, emit, contextOutput, isMain } from '../scripts/hooks-io.mjs';
import { loadContext } from '../scripts/config.mjs';
import { buildBootContext } from '../scripts/boot.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';
import { installedWorkflow } from '../scripts/update-notice.mjs';
import { handleT3Session } from '../scripts/t3-clear.mjs';
import { brainPull, brainPullNote } from '../scripts/brain.mjs';
import { pinClone, pinFile, readPins, newerThanPin } from '../scripts/update.mjs';
import { PLUGIN_ROOT } from '../scripts/util.mjs';

export const HOOK_META = { event: 'SessionStart', class: 'boot', limit: '15000 chars', principles: ['P-021', 'P-022', 'P-024', 'P-026', 'P-038', 'P-050'] };

export function run(input) {
  let ctx;
  try {
    ctx = loadContext({ project: input.cwd && !process.env.CLAUDE_PROJECT_DIR ? input.cwd : undefined, requireBrain: false });
  } catch (err) {
    return contextOutput('SessionStart', `## Workflow\nworkflow: cannot load context (${err.message})`);
  }
  exportProjectDir(ctx.projectDir);
  // Several machines on one brain (P-040): pull first, so rules, indexes and holders of the boot are current.
  const pull = pullBrain(ctx);
  if (pull?.pulled) {
    try { ctx = loadContext({ project: ctx.projectDir, requireBrain: false }); } catch { /* keep the context loaded before the pull */ }
  }
  const notes = [brainPullNote(pull), pinWorkflow(ctx), t3Session(ctx, input)].filter(Boolean);
  const boot = buildBootContext(ctx, { source: input.source || 'startup', t3Note: notes.length ? notes.join('\n') : null });
  // P-021: the revision this session loaded; the prompt and tool hooks announce a later update once.
  if (ctx.brainDir && ctx.thread) {
    try { const w = installedWorkflow(); writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), plugin_sha: w.sha, plugin_version: w.version }); } catch { /* state is best effort */ }
  }
  return contextOutput('SessionStart', boot.text);
}

export function pullBrain(ctx) {
  if (!ctx.brainDir) return null;
  try { return brainPull(ctx.brainDir); } catch (err) { return { pulled: 0, behind: 0, reason: null, error: err.message }; }
}

/**
 * Brain policy `workflow_version` (P-040): this machine runs the release the brain is pinned to. Only a clean release
 * install is switched; this session's hooks were already loaded, so the switch takes full effect in the next session.
 */
export function pinWorkflow(ctx, root = PLUGIN_ROOT, env = process.env) {
  const want = ctx.policy?.workflow_version;
  if (!want) {
    // Brain without a pin: still listed, so `brain.mjs pin --all` reaches it and a pin added later counts as changed.
    if (ctx.brainDir && readPins(env).brains?.[brainKey(ctx)] === undefined) recordPin(ctx, null, env, false);
    return null;
  }
  const conflict = pinConflict(ctx, String(want), env);
  if (conflict) return conflict;
  let r;
  try { r = pinClone(root, want); } catch (err) { r = { status: 'failed', reason: err.message }; }
  if (r.status === 'updated' || r.status === 'current') recordPin(ctx, String(want), env, true);
  let held = null;
  if (r.status === 'updated' || r.status === 'current') { try { held = newerThanPin(root, want); } catch { /* offline or no clone */ } }
  const heldNote = held ? `workflow pinned to ${r.to} by brain policy workflow_version, newest release ${held}: the pin holds this machine back (tell the operator once; every release: brain.mjs pin latest) (P-040)` : null;
  if (r.status === 'updated') return [`workflow switched ${r.from} -> ${r.to} per brain policy workflow_version; this session started on ${r.from}: hooks and skills load fully in the next session (tell the operator) (P-040)`, heldNote].filter(Boolean).join('\n');
  if (r.status === 'failed' || (r.status === 'skipped' && !r.dev)) return `workflow not switched to ${r.to || want} (brain policy workflow_version): ${r.reason}`;
  return heldNote;
}

/**
 * Different pins of brains on one machine (issue flow-public#2): the pin record (scripts/update.mjs pinFile) says which
 * brain set the clone and the pin each brain had last time. The clone follows the brain that set it, or a brain whose pin
 * the operator just changed; any other brain with a different pin reports the conflict and does not switch.
 */
function brainKey(ctx) {
  try { return fs.realpathSync(ctx.brainDir); } catch { return ctx.brainDir; }
}

export function pinConflict(ctx, want, env = process.env) {
  if (!ctx.brainDir) return null;
  const pins = readPins(env);
  const brain = brainKey(ctx);
  const owner = pins.clone?.brain;
  const changed = pins.brains?.[brain] !== undefined && pins.brains[brain] !== want;
  if (!owner || owner === brain || changed || pins.clone.version === want || !fs.existsSync(owner)) return null;
  recordPin(ctx, want, env, false);
  return `workflow not switched to ${want} (brain policy workflow_version): brain ${owner} pins ${pins.clone.version} and this machine has one install for all projects; set the same workflow_version in every brain on this machine: brain.mjs pin <version> --all (tell the operator) (P-040)`;
}

function recordPin(ctx, want, env, setClone) {
  if (!ctx.brainDir) return;
  const pins = readPins(env);
  const brain = brainKey(ctx);
  const next = { ...pins, brains: { ...(pins.brains || {}), [brain]: want } };
  if (setClone) next.clone = { version: want, brain, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(pinFile(env)), { recursive: true });
    fs.writeFileSync(pinFile(env), `${JSON.stringify(next, null, 2)}\n`);
  } catch { /* the record is advisory: a read-only home never fails the start */ }
}

/** T3-WORKAROUND(t3-clear-cursor) T3 /clear workaround (t3code#24152): record T3's resume cursor, redirect it to the new session on clear. */
export function t3Session(ctx, input) {
  if (!process.env.T3CODE_THREAD_ID || !ctx.brainDir || !ctx.thread) return null;
  try {
    const state = readThreadState(ctx.brainDir, ctx.thread);
    const r = handleT3Session(input, state, { thread: process.env.T3CODE_THREAD_ID, logDir: process.env.WORKFLOW_T3_PROVIDER_LOGS || undefined });
    if (r.state !== state) writeThreadState(ctx.brainDir, ctx.thread, r.state);
    return r.note;
  } catch (err) {
    return `T3 /clear: workaround failed (${err.message})`;
  }
}

/**
 * Workflow scripts run by the agent from Bash resolve the project from WORKFLOW_PROJECT_DIR, so they work from any cwd
 * (the agent often runs them from the skill directory or /root). Claude Code sources CLAUDE_ENV_FILE before each Bash command.
 */
export function exportProjectDir(projectDir, envFile = process.env.CLAUDE_ENV_FILE) {
  if (!envFile || !projectDir) return false;
  try {
    const line = `export WORKFLOW_PROJECT_DIR=${JSON.stringify(projectDir)}\n`;
    const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    if (!current.includes(line)) fs.appendFileSync(envFile, line);
    return true;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  try {
    emit(run(readHookInput()));
  } catch (err) {
    emit(contextOutput('SessionStart', `## Workflow\nworkflow: session-start failed (${err.message})`));
  }
}
