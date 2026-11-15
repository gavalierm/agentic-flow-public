// Maintainer side of 3b (D-0022, D-0024): a report mailed to an unregistered topic `report-<fp>` of this project waits
// held; the intake gives it its topic (class code, its own thread that holds it) and delivers it. Run by cron every
// minute as code without a thread id (D-0019): the topic library lets such code start a thread (topic.mjs guardThread
// codeStart), never claim a topic itself. Other held messages are not touched (they stay with the operator).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClient, commsProjectName, registerTopic, dropNoticesCache, MAIN_TOPIC } from './comms.mjs';
import { createTopic, startThreadForTopic, topicExists, ensureCodeCopy, orchestratorAddress, topicClass } from './topic.mjs';
import { readHolder } from './brain.mjs';
import { readJson, nowIso, realPathLoose } from './util.mjs';
import { loadContext, loadPolicy, sameMachine, mainCheckout } from './config.mjs';
import { t3ThreadState } from './thread-title.mjs';
import { dataPath, layoutOf } from './layout.mjs';
import { closedTopicExists, readTopicRecord, listTopicRecords } from './topic-files.mjs';
import { knownBrains } from './update.mjs';
import { freezeOf, freezeRejectText, freezeRefusal } from './freeze.mjs';

/**
 * Where an automatic code topic (report intake, issue watch) works, D-0035: policy `topics.auto` of the brain,
 *   { "projects": { "<project dir relative to the brain>": ["<repo name>", ...] }, "default_project": "<dir>",
 *     "orchestrator": "<topic of this brain whose thread gets the questions>" }
 * The repo's project (its T3 project, its worktree topic/<id>, its mail project); a repo not listed (or none, a report)
 * goes to default_project. Without the policy: null, the topic stays in this project without a copy (as before).
 * Returns { ctx, mail, orchestrator } (orchestrator = the record for topic.json, or null).
 */
export function autoTopicTarget(ctx, repo = null) {
  const a = ctx.policy?.topics?.auto;
  if (!a || typeof a !== 'object') return null;
  const projects = a.projects && typeof a.projects === 'object' ? a.projects : {};
  const name = repo ? String(repo).split('/').pop().replace(/\.git$/, '').toLowerCase() : null;
  const listed = name ? Object.keys(projects).find((p) => [].concat(projects[p] || []).some((r) => String(r).toLowerCase() === name)) : null;
  const rel = listed || (typeof a.default_project === 'string' && a.default_project) || null;
  if (!rel) return null;
  const wctx = loadContext({ project: path.resolve(ctx.brainDir, rel) });
  wctx.thread = null; // code without a thread id (D-0019), as the caller
  return { ctx: wctx, mail: commsProjectName(wctx), orchestrator: autoOrchestrator(ctx, wctx, a.orchestrator) };
}

function autoOrchestrator(ctx, wctx, topic) {
  if (typeof topic !== 'string' || !topic || topic === MAIN_TOPIC) return null;
  const from = commsProjectName(ctx);
  const thread = readHolder(ctx.brainDir, topic).thread || null;
  return { topic, ...(thread ? { thread } : {}), ...(from && from !== commsProjectName(wctx) ? { project: from } : {}) };
}

/** Mail address for what an automatic topic could not do itself: the policy orchestrator, else the persona main thread. */
export function autoFallback(ctx, persona = null) {
  const t = autoTopicTarget(ctx);
  if (t?.orchestrator) return orchestratorAddress(t.orchestrator);
  return persona ? `@${persona}/main` : null;
}

/**
 * Limit of automatic topics (agent-alice/D-0069, overload 2026-11-15: ten code topics ran their full tests at once, load
 * 41 on 4 cores): policy `topics.auto_max_active` (default 3) code topics with a running thread on this machine.
 */
export const AUTO_MAX_ACTIVE = 3;
export function autoMaxActive(ctx) {
  const v = Number(ctx.policy?.topics?.auto_max_active);
  return Number.isInteger(v) && v >= 1 ? v : AUTO_MAX_ACTIVE;
}

/**
 * Open topics of class code with a running thread on this machine, from the topics the workflow knows (not from ps): every
 * brain this machine has run a session in (pin record, knownBrains) plus `brains` (the caller's brain and the target's).
 * A running thread is a holder on this machine whose thread T3 does not report archived or gone (`threadState`, as the
 * mail's wake adapter reads it: flow-1-8-1, a topic held by an archived thread kept one of the places for good); a state
 * T3 does not give (no answer, another harness) counts as running. A paused topic does not count. Returns [{ id, brain }].
 */
export function activeCodeTopics(brains = [], { env = process.env, policy = null, threadState = null } = {}) {
  const seen = new Set();
  const out = [];
  const states = new Map();
  const stateOf = threadState || ((thread) => t3ThreadState(policy || loadPolicy(null), thread, { env }));
  const gone = (thread) => {
    if (!states.has(thread)) { let s = null; try { s = stateOf(thread); } catch { /* unknown: counts */ } states.set(thread, !!s?.gone); }
    return states.get(thread);
  };
  for (const b of [...brains, ...knownBrains(env)]) {
    if (!b) continue;
    const real = realPathLoose(b);
    if (seen.has(real)) continue;
    seen.add(real);
    for (const { id, topic, holder } of listTopicRecords(real)) {
      if (topic?.class !== 'code' || topic.state === 'paused' || !holder?.thread || !sameMachine(holder.machine, env)) continue;
      if (gone(String(holder.thread))) continue;
      out.push({ id, brain: real });
    }
  }
  return out;
}

/** The limit is full: { active, limit, topics, reason: 'waiting: <n> active (...)' }; else null. */
export function autoLimitFull(ctx, brains = []) {
  const limit = autoMaxActive(ctx);
  const active = activeCodeTopics([ctx.brainDir, ...brains], { policy: ctx.policy });
  if (active.length < limit) return null;
  return { active: active.length, limit, topics: active.map((t) => t.id), reason: `waiting: ${active.length} active (limit ${limit} code topics with a running thread on this machine: ${active.map((t) => t.id).join(', ')})` };
}

export const REPORT_TOPIC_RE = /^report-[0-9a-f]{8}$/;
export const INTAKE_LOG = 'report-intake.log';
const CLIENT_WAIT_MS = 10000;
/** A message with less time left is not taken: the topic, the thread and the deliver may not make it before it expires. */
export const MIN_LEFT_MS = 5 * 60000;

/** The topic's thread gets no text of the report: it stays in the mail (one copy, scrubbed by the reporter). */
export function intakeTask(project, id) {
  return `Hlásenie od inštancie čaká v pošte témy ${project}/${id}; prečítaj ho (comms receive), over ho a pred opravou sa spýtaj orchestrátora (P-075); potom rieš skillom fix.`;
}

/**
 * Topic `id` with a holder thread (shared by the intake and the issue watchers of 3a): a new topic gets its own thread, a
 * free one (its thread did not start) a thread now, a held one is registered in the mail again (a registration that
 * failed before). With policy topics.auto (D-0035) the topic works in the project of `repo` (autoTopicTarget): its
 * thread in that T3 project, its code copy topic/<id>, its mail there, its questions to the policy orchestrator.
 * A new thread (created or thread) starts only while fewer than topics.auto_max_active code topics run on this machine
 * (D-0069); else nothing is created: { ok: false, step: 'waiting', active, limit, reason: 'waiting: <n> active ...' }.
 * During a freeze (P-074) a new code topic in a frozen repo is not made: { ok: false, step: 'frozen', reason, freeze }.
 * Returns { ok, step: created|thread|held|waiting|frozen, thread, mail (project/topic of its mailbox), copy, reason }.
 */
export function ensureWorkTopic(ctx, { id, subject, task = null, class: cls = 'code', repo = null, run = spawnSync }) {
  if (closedTopicExists(ctx.brainDir, id)) return { ok: false, step: 'archived', reason: `topic ${id} is archived` };
  let target = null;
  try { target = autoTopicTarget(ctx, repo); } catch (err) { return { ok: false, step: 'project', reason: `policy topics.auto: ${err.message}` }; }
  const existing = readTopicRecord(ctx.brainDir, id);
  // A topic made before the policy (or by hand in this project) stays where it is.
  if (existing && target && existing.project !== target.mail) target = null;
  const wctx = target?.ctx || ctx;
  const mail = `${target?.mail || commsProjectName(ctx)}/${id}`;
  // P-074: a new code topic in a frozen repo is not made (the old version is not fixed); the caller rejects the input.
  if (!existing && topicClass(wctx, cls)?.kind === 'code') {
    const frozen = freezeRefusal(wctx.policy, { id, repo: path.basename(mainCheckout(wctx.projectDir)) });
    if (frozen) return { ok: false, step: 'frozen', mail, reason: frozen, freeze: freezeOf(wctx.policy) };
  }
  // A held topic only registers its mail again; a new topic or a thread for a free one waits for the limit (D-0069).
  if (!existing || !readHolder(ctx.brainDir, id).thread) {
    const full = autoLimitFull(ctx, [wctx.brainDir]);
    if (full) return { ok: false, step: 'waiting', mail, ...full };
  }
  task = typeof task === 'function' ? task(mail) : task;
  if (!existing) {
    try {
      // P-075: an automatic topic (report, issue) fixes nothing before its orchestrator agreed (fix_gate in topic.json).
      const out = createTopic(wctx, { id, subject, class: cls, newThread: true, copy: !!target, explicitProject: true, origin: ctx, orchestrator: target?.orchestrator || null, task, run, fixGate: !!target?.orchestrator });
      const copy = out.copy?.path || null;
      if (!out.claim?.ok) return { ok: false, step: 'created', mail, copy, reason: out.claim?.reason || 'no thread was started' };
      if (out.claim.comms && !out.claim.comms.ok) return { ok: false, step: 'created', thread: out.thread, mail, copy, reason: `mail registration failed (${out.claim.comms.reason})` };
      return { ok: true, step: 'created', thread: out.thread, mail, copy };
    } catch (err) {
      // Another run created it meanwhile: go on as an existing topic.
      if (!/already exists/.test(err.message)) return { ok: false, step: 'create', mail, reason: err.message };
    }
  }
  const holder = readHolder(ctx.brainDir, id);
  if (!holder.thread) {
    let copy = null;
    if (target) { try { copy = ensureCodeCopy(wctx, id).path; } catch (err) { return { ok: false, step: 'copy', mail, reason: err.message }; } }
    const r = startThreadForTopic(wctx, id, { task, run });
    if (!r.ok) return { ok: false, step: 'thread', mail, copy, reason: r.reason };
    if (r.claim?.comms && !r.claim.comms.ok) return { ok: false, step: 'thread', thread: r.thread, mail, copy, reason: `mail registration failed (${r.claim.comms.reason})` };
    return { ok: true, step: 'thread', thread: r.thread, mail, copy };
  }
  const reg = registerTopic(wctx, id);
  return reg.ok ? { ok: true, step: 'held', thread: holder.thread, mail } : { ok: false, step: 'held', thread: holder.thread, mail, reason: `mail registration failed (${reg.reason})` };
}

/**
 * The report expired between the topic and the deliver (decide 409 with `expired_at`): the topic's thread waits for a
 * message that never comes. It gets a steer from the instance (no text of the report: the reporter files it as an issue
 * after its no reply, the issue watch handles it) and closes the topic.
 */
export function expiredSteerText(messageId, topic) {
  return `Hlásenie ${messageId} vypršalo pred doručením a do tejto témy nepríde; hlásiteľ ho pošle znova ako blocker do témy správcu (error.mjs report --from, D-0067), issue nezakladá. Tému uzavri: done.mjs --topic --topic-id ${topic} --verified "hlásenie ${messageId} vypršalo pred doručením" --knowledge "nic nové".`;
}
function steerExpired(ctx, project, topic, messageId) {
  return runClient(ctx, ['send', '--text', '-', '--level', 'steer', '--project', project, '--topic', topic, '--supersede-key', `report-expired-${topic}`], { input: expiredSteerText(messageId, topic), timeoutMs: CLIENT_WAIT_MS });
}

/**
 * P-074 (agent-alice/D-0092): a report held during a freeze gets no topic. The reporter gets the rejection (a steer to its
 * topic, else to its persona main thread: no answer is owed) with the call to report it again in the new version, then
 * the held message is discarded (its wait ends). `sent`: the steer of an earlier run went out, only the discard is due.
 * Returns { line, sent }.
 */
export function rejectFrozen(ctx, n, st, freeze, sent = null) {
  const to = st.from_project && st.from_topic ? ['--project', st.from_project, '--topic', st.from_topic]
    : st.sender ? ['--persona', String(st.sender)] : null;
  const where = to ? (to[0] === '--persona' ? `@${to[1]}/main` : `${to[1]}/${to[3]}`) : null;
  let reply = sent;
  if (!reply && to) {
    const s = runClient(ctx, ['send', '--text', '-', '--level', 'steer', ...to, '--supersede-key', `report-frozen-${n.message_id}`], { input: freezeRejectText(freeze, n.message_id), timeoutMs: CLIENT_WAIT_MS });
    // A closed reporter topic (410) cannot get it: the report is discarded all the same.
    if (s.ok) reply = s.data?.id || (s.data?.queued ? 'queued' : 'sent');
    else if (s.data?.status !== 410) return { line: `${n.topic}: message ${n.message_id} rejected by the freeze, the reply to ${where} failed (${s.error}); next run tries again`, sent: null };
    else reply = 'reporter topic closed';
  }
  const d = runClient(ctx, ['decide', '--notice', String(n.id), '--decision', 'discard'], { timeoutMs: CLIENT_WAIT_MS });
  if (!d.ok) return { line: `${n.topic}: message ${n.message_id} rejected by the freeze (reply ${reply || 'none'}), discard failed (${d.error}); next run tries again`, sent: reply };
  dropNoticesCache(ctx);
  return { line: `${n.topic}: message ${n.message_id} rejected: frozen until ${freeze.until || 'the new version'}, no topic; ${where ? `reply to ${where} (${reply})` : 'no way back to the reporter'}, message discarded`, sent: null };
}

function logFile(ctx) {
  return dataPath(ctx.brainDir, 'local', INTAKE_LOG);
}
function stateFile(ctx) {
  return dataPath(ctx.brainDir, 'local', 'report-intake-state.json');
}

/**
 * One intake round: open `unregistered-topic` notices of this project for `report-<8 hex>`, each with a held, unexpired
 * message, get their topic and `decide --decision deliver`. A failure changes nothing: the next minute tries again.
 * At the limit of active code topics (topics.auto_max_active, D-0069) a report waits held, its notice open: no topic.
 * During a freeze (policy freeze, P-074) a report gets no topic: rejectFrozen answers the reporter and discards it.
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
  // A report waiting for the limit of active topics (D-0069): printed every run, into the log only when it starts waiting
  // or the count changes.
  const waiting = {};
  const quiet = new Set();
  // A steer about an expired report that did not go out: tried again every run until it does.
  const steerDue = {};
  // P-074: the freeze of the brain policy rejects every report (an allowed topic of the rebuild still gets its mail).
  const freeze = freezeOf(ctx.policy);
  const rejectSent = {};
  for (const [nid, due] of Object.entries(state.steer_due || {})) {
    const s = steerExpired(ctx, due.project || project, due.topic, due.message_id);
    if (s.ok) log(`${due.topic}: message ${due.message_id} expired before delivery; steer to the topic sent (${s.data?.queued ? 'queued' : s.data?.status || 'sent'})`);
    else { steerDue[nid] = due; log(`${due.topic}: steer about expired message ${due.message_id} failed (${s.error}); next run tries again`); }
  }
  for (const n of ours) {
    const m = runClient(ctx, ['message', '--id', String(n.message_id)], { timeoutMs: CLIENT_WAIT_MS });
    if (!m.ok) { log(`${n.topic}: state of message ${n.message_id} unknown (${m.error}); next run tries again`); continue; }
    const st = m.data || {};
    if (freeze && st.status === 'held' && !freeze.allow.includes(n.topic)) {
      const r = rejectFrozen(ctx, n, st, freeze, state.reject_sent?.[n.id] || null);
      if (r.sent) rejectSent[n.id] = r.sent;
      log(r.line);
      continue;
    }
    const left = st.expires_at ? Date.parse(st.expires_at) - now : Infinity;
    // Model 2 (1a): one `status`; a held message past its deadline carries `expired_at`.
    const expired = !!st.expired_at || left <= 0;
    const short = !expired && left < MIN_LEFT_MS;
    if (st.status !== 'held' || expired || short) {
      skipped[n.id] = state.skipped?.[n.id] || nowIso();
      if (!state.skipped?.[n.id]) log(`${n.topic}: message ${n.message_id} skipped (${st.status || '?'}${st.resolution ? `/${st.resolution}` : ''}${expired ? ', expired' : short ? `, expires in under ${MIN_LEFT_MS / 60000} min (${st.expires_at})` : ''}); the notice stays with the operator`);
      continue;
    }
    // A report names no repo (the intake does not read its text): policy topics.auto sends it to default_project (D-0035).
    const t = ensureWorkTopic(ctx, { id: n.topic, subject: `Hlásenie chyby z pošty ${project}/${n.topic}`, task: (mail) => intakeTask(mail.slice(0, mail.lastIndexOf('/')), n.topic), class: 'code', run });
    if (t.step === 'waiting') {
      waiting[n.id] = t.active;
      const line = `${n.topic}: ${t.reason}; message ${n.message_id} stays held, a later run takes it`;
      if (state.waiting?.[n.id] === t.active) quiet.add(line);
      log(line);
      continue;
    }
    if (!t.ok) { log(`${n.topic}: ${t.reason}; message ${n.message_id} stays held, next run tries again`); continue; }
    // The topic is registered in the repo's mail project: the held message moves there (redirect), else it is delivered.
    const dest = t.mail.slice(0, t.mail.lastIndexOf('/'));
    const d = runClient(ctx, ['decide', '--notice', String(n.id), ...(dest === project ? ['--decision', 'deliver'] : ['--decision', 'redirect', '--target', t.mail])], { timeoutMs: CLIENT_WAIT_MS });
    if (!d.ok && d.data?.status === 409 && d.data?.details?.expired_at) {
      // Expired after the topic was made: its thread is told (steer, no report text) and closes the topic.
      const s = steerExpired(ctx, dest, n.topic, n.message_id);
      if (s.ok) log(`${n.topic}: message ${n.message_id} expired before delivery (${d.data.details.expired_at}); steer to the topic sent (${s.data?.queued ? 'queued' : s.data?.state || 'sent'}), its thread closes the topic`);
      else {
        steerDue[n.id] = { topic: n.topic, message_id: n.message_id, ...(dest !== project ? { project: dest } : {}) };
        log(`${n.topic}: message ${n.message_id} expired before delivery (${d.data.details.expired_at}); steer to the topic failed (${s.error}); next run tries again`);
      }
      continue;
    }
    if (!d.ok) { log(`${n.topic}: topic ready (${t.step}, thread ${t.thread}), deliver of ${n.message_id} failed (${d.error}); next run tries again`); continue; }
    dropNoticesCache(ctx);
    log(`${n.topic}: message ${n.message_id} delivered to thread ${t.thread} (${t.step}${dest === project ? '' : `, ${t.mail}${t.copy ? `, copy ${t.copy}` : ''}`})`);
  }
  try {
    fs.mkdirSync(path.dirname(stateFile(ctx)), { recursive: true });
    fs.writeFileSync(stateFile(ctx), `${JSON.stringify({ skipped, ...(Object.keys(waiting).length ? { waiting } : {}), ...(Object.keys(steerDue).length ? { steer_due: steerDue } : {}), ...(Object.keys(rejectSent).length ? { reject_sent: rejectSent } : {}) }, null, 2)}\n`);
  } catch { /* only dedupes log lines */ }
  return finish(ctx, lines, quiet);
}

function finish(ctx, lines, quiet = null) {
  const logged = quiet ? lines.filter((l) => !quiet.has(l)) : lines;
  if (!logged.length) return lines;
  try {
    fs.mkdirSync(path.dirname(logFile(ctx)), { recursive: true });
    fs.appendFileSync(logFile(ctx), logged.map((l) => `${nowIso()} ${l}\n`).join(''));
  } catch { /* stdout still has it */ }
  return lines;
}

/** One round at a time: cron starts a new one every minute, a thread start may take 30 s. */
export function withIntakeLock(ctx, fn) {
  const lock = dataPath(ctx.brainDir, 'local', 'report-intake.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return null; }
  fs.closeSync(fd);
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
