// Maintainer side of 3b (D-0022, D-0024): a report mailed to an unregistered topic `report-<fp>` of this project waits
// held; the intake gives it its topic (class code, its own thread that holds it) and delivers it. Run by cron every
// minute as code without a thread id (D-0019): the topic library lets such code start a thread (topic.mjs guardThread
// codeStart), never claim a topic itself. Other held messages are not touched (they stay with the operator).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClient, commsProjectName, registerTopic, dropNoticesCache } from './comms.mjs';
import { createTopic, startThreadForTopic, topicExists } from './topic.mjs';
import { readHolder } from './brain.mjs';
import { readJson, nowIso } from './util.mjs';

export const REPORT_TOPIC_RE = /^report-[0-9a-f]{8}$/;
export const INTAKE_LOG = 'report-intake.log';
const CLIENT_WAIT_MS = 10000;
/** A message with less time left is not taken: the topic, the thread and the deliver may not make it before it expires. */
export const MIN_LEFT_MS = 5 * 60000;

/** The topic's thread gets no text of the report: it stays in the mail (one copy, scrubbed by the reporter). */
export function intakeTask(project, id) {
  return `Hlásenie od inštancie čaká v pošte témy ${project}/${id}; prečítaj ho (comms receive) a rieš skillom fix.`;
}

/**
 * Topic `id` with a holder thread (shared by the intake and the issue watchers of 3a): a new topic gets its own thread, a
 * free one (its thread did not start) a thread now, a held one is registered in the mail again (a registration that
 * failed before). Returns { ok, step: created|thread|held, thread, reason }.
 */
export function ensureWorkTopic(ctx, { id, subject, task, class: cls = 'code', run = spawnSync }) {
  if (fs.existsSync(path.join(ctx.brainDir, 'topics', 'archive', id))) return { ok: false, step: 'archived', reason: `topic ${id} is archived` };
  if (!topicExists(ctx.brainDir, id)) {
    try {
      const out = createTopic(ctx, { id, subject, class: cls, newThread: true, copy: false, explicitProject: true, task, run });
      if (!out.claim?.ok) return { ok: false, step: 'created', reason: out.claim?.reason || 'no thread was started' };
      if (out.claim.comms && !out.claim.comms.ok) return { ok: false, step: 'created', thread: out.thread, reason: `mail registration failed (${out.claim.comms.reason})` };
      return { ok: true, step: 'created', thread: out.thread };
    } catch (err) {
      // Another run created it meanwhile: go on as an existing topic.
      if (!/already exists/.test(err.message)) return { ok: false, step: 'create', reason: err.message };
    }
  }
  const holder = readHolder(ctx.brainDir, id);
  if (!holder.thread) {
    const r = startThreadForTopic(ctx, id, { task, run });
    if (!r.ok) return { ok: false, step: 'thread', reason: r.reason };
    if (r.claim?.comms && !r.claim.comms.ok) return { ok: false, step: 'thread', thread: r.thread, reason: `mail registration failed (${r.claim.comms.reason})` };
    return { ok: true, step: 'thread', thread: r.thread };
  }
  const reg = registerTopic(ctx, id);
  return reg.ok ? { ok: true, step: 'held', thread: holder.thread } : { ok: false, step: 'held', thread: holder.thread, reason: `mail registration failed (${reg.reason})` };
}

/**
 * The report expired between the topic and the deliver (decide 409 with `expired_at`): the topic's thread waits for a
 * message that never comes. It gets a steer from the instance (no text of the report: the reporter files it as an issue
 * after its no reply, the issue watch handles it) and closes the topic.
 */
export function expiredSteerText(messageId, topic) {
  return `Hlásenie ${messageId} vypršalo pred doručením a do tejto témy nepríde; hlásiteľ ho podá ako issue (vybaví ho sledovanie issues). Tému uzavri: done.mjs --topic --topic-id ${topic} --verified "hlásenie ${messageId} vypršalo pred doručením".`;
}
function steerExpired(ctx, project, topic, messageId) {
  return runClient(ctx, ['send', '--text', '-', '--level', 'steer', '--project', project, '--topic', topic, '--supersede-key', `report-expired-${topic}`], { input: expiredSteerText(messageId, topic), timeoutMs: CLIENT_WAIT_MS });
}

function logFile(ctx) {
  return path.join(ctx.brainDir, 'local', INTAKE_LOG);
}
function stateFile(ctx) {
  return path.join(ctx.brainDir, 'local', 'report-intake-state.json');
}

/**
 * One intake round: open `unregistered-topic` notices of this project for `report-<8 hex>`, each with a held, unexpired
 * message, get their topic and `decide --decision deliver`. A failure changes nothing: the next minute tries again.
 * Returns the log lines of this round.
 */
export function runIntake(ctx, { run = spawnSync, now = Date.now() } = {}) {
  const lines = [];
  const log = (l) => lines.push(l);
  const project = commsProjectName(ctx);
  const res = runClient(ctx, ['notices'], { timeoutMs: CLIENT_WAIT_MS });
  if (!res.ok || !Array.isArray(res.data?.notices)) {
    log(`notices failed (${res.error || 'no list'})`);
    return finish(ctx, lines);
  }
  const ours = res.data.notices.filter((n) => n.kind === 'unregistered-topic' && n.state === 'open' && n.project === project && REPORT_TOPIC_RE.test(String(n.topic || '')));
  // A skipped notice (expired message) is logged once, not every minute.
  const state = readJson(stateFile(ctx), {}) || {};
  const skipped = {};
  // A steer about an expired report that did not go out: tried again every run until it does.
  const steerDue = {};
  for (const [nid, due] of Object.entries(state.steer_due || {})) {
    const s = steerExpired(ctx, project, due.topic, due.message_id);
    if (s.ok) log(`${due.topic}: message ${due.message_id} expired before delivery; steer to the topic sent (${s.data?.queued ? 'queued' : s.data?.state || 'sent'})`);
    else { steerDue[nid] = due; log(`${due.topic}: steer about expired message ${due.message_id} failed (${s.error}); next run tries again`); }
  }
  for (const n of ours) {
    const m = runClient(ctx, ['message', '--id', String(n.message_id)], { timeoutMs: CLIENT_WAIT_MS });
    if (!m.ok) { log(`${n.topic}: state of message ${n.message_id} unknown (${m.error}); next run tries again`); continue; }
    const st = m.data || {};
    const left = st.expires_at ? Date.parse(st.expires_at) - now : Infinity;
    const expired = st.outcome === 'expired' || left <= 0;
    const short = !expired && left < MIN_LEFT_MS;
    if (st.state !== 'held' || expired || st.outcome || short) {
      skipped[n.id] = state.skipped?.[n.id] || nowIso();
      if (!state.skipped?.[n.id]) log(`${n.topic}: message ${n.message_id} skipped (${st.state || '?'}${st.outcome ? `, ${st.outcome}` : expired ? ', expired' : short ? `, expires in under ${MIN_LEFT_MS / 60000} min (${st.expires_at})` : ''}); the notice stays with the operator`);
      continue;
    }
    const t = ensureWorkTopic(ctx, { id: n.topic, subject: `Hlásenie chyby z pošty ${project}/${n.topic}`, task: intakeTask(project, n.topic), class: 'code', run });
    if (!t.ok) { log(`${n.topic}: ${t.reason}; message ${n.message_id} stays held, next run tries again`); continue; }
    const d = runClient(ctx, ['decide', '--notice', String(n.id), '--decision', 'deliver'], { timeoutMs: CLIENT_WAIT_MS });
    if (!d.ok && d.data?.status === 409 && d.data?.details?.expired_at) {
      // Expired after the topic was made: its thread is told (steer, no report text) and closes the topic.
      const s = steerExpired(ctx, project, n.topic, n.message_id);
      if (s.ok) log(`${n.topic}: message ${n.message_id} expired before delivery (${d.data.details.expired_at}); steer to the topic sent (${s.data?.queued ? 'queued' : s.data?.state || 'sent'}), its thread closes the topic`);
      else {
        steerDue[n.id] = { topic: n.topic, message_id: n.message_id };
        log(`${n.topic}: message ${n.message_id} expired before delivery (${d.data.details.expired_at}); steer to the topic failed (${s.error}); next run tries again`);
      }
      continue;
    }
    if (!d.ok) { log(`${n.topic}: topic ready (${t.step}, thread ${t.thread}), deliver of ${n.message_id} failed (${d.error}); next run tries again`); continue; }
    dropNoticesCache(ctx);
    log(`${n.topic}: message ${n.message_id} delivered to thread ${t.thread} (${t.step})`);
  }
  try {
    fs.mkdirSync(path.dirname(stateFile(ctx)), { recursive: true });
    fs.writeFileSync(stateFile(ctx), `${JSON.stringify({ skipped, ...(Object.keys(steerDue).length ? { steer_due: steerDue } : {}) }, null, 2)}\n`);
  } catch { /* only dedupes log lines */ }
  return finish(ctx, lines);
}

function finish(ctx, lines) {
  if (!lines.length) return lines;
  try {
    fs.mkdirSync(path.dirname(logFile(ctx)), { recursive: true });
    fs.appendFileSync(logFile(ctx), lines.map((l) => `${nowIso()} ${l}\n`).join(''));
  } catch { /* stdout still has it */ }
  return lines;
}

/** One round at a time: cron starts a new one every minute, a thread start may take 30 s. */
export function withIntakeLock(ctx, fn) {
  const lock = path.join(ctx.brainDir, 'local', 'report-intake.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return null; }
  fs.closeSync(fd);
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
