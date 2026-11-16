// Maintainer side of the error reports (spec 7.3, plan B15): a report is mailed once under the key `report-<fp>` of this
// project, an unregistered topic, so the mail holds it; the intake only delivers it to the maintainer topic (policy
// maintainer comms), whose thread picks it up, acks it and fixes it in its worktree. No topic and no thread per report;
// during a freeze reports are delivered too (spec 9, P-074). Run by cron every minute as code without a thread id
// (D-0019). Other held messages are not touched (they stay with the operator).
import fs from 'node:fs';
import path from 'node:path';
import { runClient, commsProjectName, dropNoticesCache, parseAddress } from './comms.mjs';
import { readJson, nowIso } from './util.mjs';
import { dataPath } from './layout.mjs';
import { maintainerOf } from './report.mjs';

export const REPORT_TOPIC_RE = /^report-[0-9a-f]{8}$/;
export const INTAKE_LOG = 'report-intake.log';
const CLIENT_WAIT_MS = 10000;

function logFile(ctx) {
  return dataPath(ctx.brainDir, 'local', INTAKE_LOG);
}
function stateFile(ctx) {
  return dataPath(ctx.brainDir, 'local', 'report-intake-state.json');
}

/** The maintainer topic the reports go to: `<project>/<topic>` of policy maintainer comms, else null. */
export function maintainerTopic(ctx) {
  const comms = maintainerOf(ctx.policy).comms;
  const addr = comms ? parseAddress(comms, commsProjectName(ctx)) : null;
  return addr?.topic ? `${addr.project}/${addr.topic}` : null;
}

/**
 * One intake round: open `unregistered-topic` notices of this project for `report-<8 hex>`, each with a held, unexpired
 * message, are delivered to the maintainer topic (`decide --decision redirect`). A failure changes nothing: the next
 * minute tries again. Returns the log lines of this round.
 */
export function runIntake(ctx) {
  const lines = [];
  const log = (l) => lines.push(l);
  const project = commsProjectName(ctx);
  const target = maintainerTopic(ctx);
  if (!target) {
    log('no maintainer topic configured (policy maintainer comms): reports stay held with the operator');
    return finish(ctx, lines);
  }
  const res = runClient(ctx, ['notices'], { timeoutMs: CLIENT_WAIT_MS });
  if (!res.ok || !Array.isArray(res.data?.notices)) {
    log(`notices failed (${res.error || 'no list'})`);
    return finish(ctx, lines);
  }
  const ours = res.data.notices.filter((n) => n.kind === 'unregistered-topic' && n.state === 'open' && n.project === project && REPORT_TOPIC_RE.test(String(n.topic || '')));
  // A skipped notice (expired message) is logged once, not every minute.
  const state = readJson(stateFile(ctx), {}) || {};
  const skipped = {};
  for (const n of ours) {
    const m = runClient(ctx, ['message', '--id', String(n.message_id)], { timeoutMs: CLIENT_WAIT_MS });
    if (!m.ok) { log(`${n.topic}: state of message ${n.message_id} unknown (${m.error}); next run tries again`); continue; }
    const st = m.data || {};
    // Model 2 (1a): one `status`; a held message past its deadline carries `expired_at`.
    const expired = !!st.expired_at || (st.expires_at && Date.parse(st.expires_at) <= Date.now());
    if (st.status !== 'held' || expired) {
      skipped[n.id] = state.skipped?.[n.id] || nowIso();
      if (!state.skipped?.[n.id]) log(`${n.topic}: message ${n.message_id} skipped (${st.status || '?'}${st.resolution ? `/${st.resolution}` : ''}${expired ? ', expired' : ''}); the notice stays with the operator`);
      continue;
    }
    const d = runClient(ctx, ['decide', '--notice', String(n.id), '--decision', 'redirect', '--target', target], { timeoutMs: CLIENT_WAIT_MS });
    if (!d.ok) { log(`${n.topic}: delivery of ${n.message_id} to ${target} failed (${d.error}); next run tries again`); continue; }
    dropNoticesCache(ctx);
    log(`${n.topic}: message ${n.message_id} delivered to the maintainer topic ${target}`);
  }
  try {
    fs.mkdirSync(path.dirname(stateFile(ctx)), { recursive: true });
    fs.writeFileSync(stateFile(ctx), `${JSON.stringify({ skipped }, null, 2)}\n`);
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

/** One round at a time: cron starts a new one every minute. */
export function withIntakeLock(ctx, fn) {
  const lock = dataPath(ctx.brainDir, 'local', 'report-intake.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return null; }
  fs.closeSync(fd);
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
