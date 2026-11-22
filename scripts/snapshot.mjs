// Snapshot of a topic (operator 2026-11-18): "uložiť stav aktuálnej témy, aby sme vedeli pokračovať v čerstvej session
// (napr. po /clear); niečo ako done, ale nie done: tému neukončiť, len ju refreshnúť bez straty rozpracovanej práce".
// The agent writes the knowledge and the handover (skill snapshot); this checks that the handover was saved in this turn,
// saves the bound and cited work files now (P-078, as the end of the turn would) and marks the thread: the end of this
// turn sends no continuation (the old context would go on instead of the fresh one) and the start after /clear loads the
// handover (boot.mjs). The topic stays held and open; nothing is merged or closed.
import fs from 'node:fs';
import path from 'node:path';
import { readThreadState, patchThreadState } from './config.mjs';
import { brainWrite, readHolder, isHolderOf } from './brain.mjs';
import { heldTopics, readTopic, topicRel } from './topic.mjs';
import { isMainTopic } from './comms.mjs';
import { handoverNextStep } from './brain-checks.mjs';
import { syncResults, savedLine } from './results.mjs';
import { scratchReminder } from './materialy.mjs';
import { git, localTime } from './util.mjs';

/** The time of a snapshot made in the current turn of the thread, or null (stop.mjs: no continuation after it). */
export function snapshotThisTurn(state) {
  const at = Date.parse(state?.snapshot_at || '');
  const started = Date.parse(state?.turn_started_at || '');
  return Number.isFinite(at) && (!Number.isFinite(started) || at >= started) ? state.snapshot_at : null;
}

/** Snapshot of topic `id` (default: the one topic this thread holds besides main). Returns lines to print; throws a refusal. */
export function snapshotTopic(ctx, id = null, now = Date.now()) {
  if (!ctx.brainDir || !ctx.thread) throw new Error('snapshot: needs a brain and a thread (WORKFLOW_THREAD_ID)');
  const held = heldTopics(ctx.brainDir, ctx.thread).filter((t) => !isMainTopic(t));
  if (!id) {
    if (held.length !== 1) throw new Error(held.length ? `snapshot: this thread holds ${held.map((t) => t.id).join(', ')}; name one: topic.mjs snapshot <id>` : 'snapshot: this thread holds no topic besides main; nothing to snapshot (topic.mjs claim <id> or create one first)');
    id = held[0].id;
  }
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`snapshot: topic ${id} does not exist`);
  if (!isHolderOf(readHolder(ctx.brainDir, id), ctx.thread)) throw new Error(`snapshot: topic ${id} is not held by this thread; only its holder snapshots it`);
  const state = readThreadState(ctx.brainDir, ctx.thread);
  // The time of the commit, not of the file: a save that was killed before its commit (or whose commit was refused)
  // left a new file time, the snapshot said "handover saved" and the next brain write put the old handover back.
  const rel = topicRel(ctx.brainDir, id, 'handover');
  const file = path.join(ctx.brainDir, rel);
  const log = fs.existsSync(file) && !git(['status', '--porcelain', '--', rel], { cwd: ctx.brainDir }).stdout.trim()
    ? git(['log', '-1', '--format=%ct', '--', rel], { cwd: ctx.brainDir }) : null;
  // git keeps whole seconds: the end of that second.
  const savedAt = log?.ok && Number(log.stdout) ? Number(log.stdout) * 1000 + 999 : null;
  const started = Date.parse(state.turn_started_at || '');
  // The handover is the only state a fresh session gets: one from before this turn misses what this turn did.
  if (!savedAt || (Number.isFinite(started) && savedAt < started)) {
    throw new Error(`snapshot: the handover of ${id} was ${savedAt ? `saved ${localTime(savedAt)}, before this turn` : 'not saved (never, or its last save did not finish)'}; save it first with all six sections (save.mjs handover ${id}: the task verbatim with the operator's standing instructions, Hotové with the facts that verify it, the exact Ďalší krok, the files, the questions, the tasks), then run topic.mjs snapshot ${id} again`);
  }
  const lines = [];
  const res = syncResults(ctx.brainDir, id, { policy: ctx.policy, now });
  if (res.ops.length) {
    brainWrite(ctx, { ops: res.ops, internal: true, message: `snapshot ${id}: results (P-078)` });
    const line = savedLine(id, res);
    if (line) lines.push(line);
  }
  if (res.dirs.length) lines.push(`not saved: the handover cites folder(s) of the work files ${res.dirs.map((d) => path.relative(ctx.brainDir, d)).join(', ')}; a folder is never saved: save what the next session needs (save.mjs result <file>) and name those files in the handover`);
  const scratch = scratchReminder(ctx.projectDir, Date.parse(topic.last_done || readHolder(ctx.brainDir, id)?.since || ''), id, ctx.brainDir);
  if (scratch) lines.push(scratch);
  const handover = fs.readFileSync(file, 'utf8');
  if (!(handoverNextStep(handover) || []).length) lines.push(`the handover of ${id} has no Ďalší krok: a fresh session will not know what to do next; add it (save.mjs handover ${id} --next "..."), unless the topic waits on the operator`);
  patchThreadState(ctx.brainDir, ctx.thread, { snapshot_at: new Date(now).toISOString() });
  lines.push(`snapshot of ${id}: handover saved ${localTime(savedAt)}; the topic stays open and held by this thread; this turn ends without a continuation. After /clear the start of the new session loads this handover and goes on from Ďalší krok. End the turn: **Stav:** čakám (na /clear operátora)`);
  return { id, lines };
}
