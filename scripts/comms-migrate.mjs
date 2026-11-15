// First run of mail model 2 (agentic-flow 1.8.0, mail design 4b step 5, P-072): the local waits of model 1 (thread timers
// bound to a message `for: <id>`, `reply_wait[id]`) are handed over to the mail (`POST /wait-adopt`: only the sender, only a
// non-final message), then the local message state of 3a is removed from every thread state of the brain
// (`<brain>/local/threads/*.json`): `picked_assist`, `picked_at`, `reply_wait`, the timers `for: <id>`, the mail wakers and
// the queued "picked assist unanswered" line; `local/comms-closed.json` goes too (the mail's `obligations.topics` decides).
// Once per brain: the marker `<brain>/local/comms/model-2.json`. A mail of another model, or an outage while a wait is
// still to hand over, changes nothing (retried at the next run); a wait the mail refuses (not the sender, final, a reply,
// gone) is dropped: the server wins (3c).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readJson } from './util.mjs';
import { dataPath } from './layout.mjs';
import { writeThreadState } from './config.mjs';
import { commsSettings, modelMismatch } from './comms.mjs';

export const MODEL2_MARKER = 'model-2.json';
/** Thread-state fields of model 1 that held the state of a message (3a). */
export const MAIL_STATE_FIELDS = ['picked_assist', 'picked_at', 'reply_wait'];
const PICKED_LINE = /^picked assist unanswered/;

const timersOf = (st) => [st?.timer, ...(Array.isArray(st?.timers) ? st.timers : [])].filter((t) => t && t.at);

/** Local waits of a thread state: message id → due time (the earliest timer of it; a reply_wait without one is due now). */
export function localWaits(state, now = Date.now()) {
  const out = new Map();
  for (const t of timersOf(state)) {
    if (!t.for) continue;
    const prev = out.get(String(t.for));
    if (!prev || Date.parse(t.at) < Date.parse(prev)) out.set(String(t.for), t.at);
  }
  for (const id of Object.keys(state?.reply_wait || {})) if (!out.has(id)) out.set(id, new Date(now).toISOString());
  return out;
}

/** The thread state without the message state of model 1 (3a). */
export function withoutMailState(state) {
  const rest = { ...state };
  for (const f of MAIL_STATE_FIELDS) delete rest[f];
  const kept = timersOf(state).filter((t) => !t.for).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 20);
  delete rest.timer;
  delete rest.timers;
  if (kept.length) rest.timer = kept[0];
  if (kept.length > 1) rest.timers = kept.slice(1);
  if (Array.isArray(state.wakers)) rest.wakers = state.wakers.filter((w) => w.kind !== 'mail' && !w.for);
  if (Array.isArray(state.pending_signals)) rest.pending_signals = state.pending_signals.filter((l) => !PICKED_LINE.test(String(l)));
  return rest;
}

/** The state holds message state of model 1. */
export function hasMailState(state) {
  return MAIL_STATE_FIELDS.some((f) => state?.[f] !== undefined) || timersOf(state).some((t) => t.for)
    || (state?.wakers || []).some((w) => w.kind === 'mail' || w.for) || (state?.pending_signals || []).some((l) => PICKED_LINE.test(String(l)));
}

const threadsDir = (brainDir) => dataPath(brainDir, 'local', 'threads');

function threadStates(brainDir) {
  let names = [];
  try { names = fs.readdirSync(threadsDir(brainDir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    const state = readJson(path.join(threadsDir(brainDir), f), null);
    if (!state || typeof state !== 'object') continue;
    let id = state.thread;
    if (!id) { try { id = decodeURIComponent(f.slice(0, -5)); } catch { id = f.slice(0, -5); } }
    out.push({ id: String(id), state });
  }
  return out;
}

// The mail client's library (`<client>/../src/client/index.mjs`): its CLI has no `wait-adopt` command, so the hand-over
// calls Client.waitAdopt in a child process (one call per run, the waits in order; stops at an outage or another model).
const ADOPT = `
const [lib, cfg, items] = process.argv.slice(1);
const { Client, resolveConfig } = await import(lib);
const client = new Client(resolveConfig(JSON.parse(cfg)));
const out = [];
for (const it of JSON.parse(items)) {
  try { out.push({ id: it.id, ok: true, data: await client.waitAdopt(it) }); }
  catch (e) { out.push({ id: it.id, ok: false, code: e.code || 'ERROR', status: e.status || null, error: e.message }); if (!['REJECTED'].includes(e.code)) break; }
}
process.stdout.write(JSON.stringify(out));
`;

/** Hand the waits over: [{ id, ok, status?, code? }] in order, or { error } when the client library cannot run. */
export function adoptWaits(ctx, items, s = commsSettings(ctx)) {
  const lib = path.resolve(path.dirname(s.client), '..', 'src', 'client', 'index.mjs');
  if (!fs.existsSync(lib)) return { error: `mail client library not found (${lib})` };
  const cfg = { config: s.configFile || undefined, instance: s.instance || undefined, outbox: s.outbox || undefined, clientDir: s.clientDir || undefined, timeout: s.waitMs };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', ADOPT, pathToFileURL(lib).href, JSON.stringify(cfg), JSON.stringify(items)], {
    cwd: ctx.projectDir, encoding: 'utf8', timeout: s.waitMs * Math.max(1, items.length) + 3000,
    env: { ...process.env, COMMS_THREAD_ID: '' },
  });
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return { error: (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}` }; }
}

/** The mail refused the wait for good (403 not the sender, 400 a reply, 404 gone, 409 final): dropped, the server wins. */
const refused = (r) => !r.ok && r.code === 'REJECTED' && [400, 403, 404, 409].includes(r.status);

/**
 * Run the hand-over once per brain (marker in the client dir). Returns { done, adopted, dropped, cleaned } or
 * { done: false, reason } when it waits for the next run (another model, mail unavailable, client library missing).
 */
export function migrateLocalMail(ctx, now = Date.now()) {
  if (!ctx?.brainDir) return { done: false, reason: 'no brain' };
  const s = commsSettings(ctx);
  const markerDir = s.clientDir || dataPath(ctx.brainDir, 'local', 'comms');
  const marker = path.join(markerDir, MODEL2_MARKER);
  if (fs.existsSync(marker)) return { done: true, already: true };
  const threads = threadStates(ctx.brainDir).filter((t) => hasMailState(t.state));
  const waits = [];
  for (const t of threads) for (const [id, due] of localWaits(t.state, now)) if (!waits.some((w) => w.id === id)) waits.push({ id, due_at: due });
  const adopted = [];
  const dropped = [];
  if (waits.length && s.enabled) {
    // Another model: nothing is written, nothing handed over (4a); tried again at the next run.
    const mismatch = modelMismatch(ctx, s);
    if (mismatch) return { done: false, reason: mismatch.error };
    const res = adoptWaits(ctx, waits, s);
    if (!Array.isArray(res)) return { done: false, reason: res.error };
    for (const r of res) {
      if (r.ok) adopted.push(r.id);
      else if (refused(r)) dropped.push(r.id);
    }
    if (adopted.length + dropped.length < waits.length) return { done: false, reason: `mail: ${res.find((r) => !r.ok && !refused(r))?.error || 'waits not handed over'}`, adopted, dropped };
  }
  for (const t of threads) writeThreadState(ctx.brainDir, t.id, withoutMailState(t.state));
  fs.rmSync(dataPath(ctx.brainDir, 'local', 'comms-closed.json'), { force: true });
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ migrated_at: new Date(now).toISOString(), adopted, dropped, threads: threads.map((t) => t.id) }, null, 2) + '\n');
  } catch { /* the next run finds nothing left to clean */ }
  return { done: true, adopted, dropped, cleaned: threads.map((t) => t.id) };
}
