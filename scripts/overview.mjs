// Overview of the supervisor without an agent (flow v2 spec 3.9, 4.2.2, 10.2; plan B6, O6, O23): code reads the topic
// record (`.tema.json`: turn.state, turn.alarm_at, turn.stuck, mode, holder) and the last push of the state of every open topic of every
// domain of this machine, in the layout of each brain (layout 2 temy/, layout 3 topics/), and lists what waits for the
// supervisor's review:
//   1. stuck steps (10.2: the continuation reached its cap; the question already waits for the operator);
//   2. idle locks (4.2.2: inactivity from the last push of the topic state, not counted while the state is otázka, hotovo
//      or čakám before its alarm, after a missed alarm from the alarm's time; over overview.idle_days, default 30:
//      operator 2026-11-19, a lock idle for hours is no finding): propose a takeover to the operator;
//   3. topics hotovo without work outside mode discussion (10.6 item 4) and without a question the supervisor owes an answer
//      to, for overview.idle_days since the last push of the state: propose closing to the operator.
// The overlap of topics (3.9.4) stays the supervisor's judgement: no code here. Read only; nothing here writes a brain.
// The wake job `overview` (bin/overview.mjs wake) mails the supervisor only when a finding is new.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, localTime, readJson, relPosix } from './util.mjs';
import { machineRoot } from './config.mjs';
import { domainBrains } from './stores.mjs';
import { layoutOf, dataPath } from './layout.mjs';
import { repoWorkFinding } from './work-classes.mjs';
import { listTopicRecords } from './topic-files.mjs';
import { isMainTopic, commsProjectName, supervisorOf } from './comms.mjs';
import { DONE, QUESTION, WAITING } from './topic-state.mjs';

/** Policy defaults (plan O23): the interval of the wake job and the inactivity threshold of a lock. */
export const OVERVIEW_INTERVAL_MIN = 30;
export const STALE_HOURS = 12;
export const overviewIntervalMs = (policy) => (Number(policy?.overview?.interval_min) > 0 ? Number(policy.overview.interval_min) : OVERVIEW_INTERVAL_MIN) * 60_000;
export const staleHours = (policy) => (Number(policy?.topics?.stale_machine_hours) > 0 ? Number(policy.topics.stale_machine_hours) : STALE_HOURS);
/**
 * Operator 2026-11-19: the overview reports a topic idle for 30 days (policy overview.idle_days), not for hours: an idle
 * lock, and a topic hotovo without work counted from the last push of its state, so work on it starts the count again
 * (a topic hotovo, worked on, hotovo again was mailed as a new finding each time).
 */
export const IDLE_DAYS = 30;
export const idleHours = (policy, env = process.env) => {
  if (Number(env.WORKFLOW_OVERVIEW_IDLE_HOURS) > 0) return Number(env.WORKFLOW_OVERVIEW_IDLE_HOURS);
  const days = Number(policy?.overview?.idle_days);
  return (days > 0 ? days : IDLE_DAYS) * 24;
};

const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * Since when the inactivity of a lock counts (spec 4.2.2), or null while it does not count: the state otázka or hotovo
 * (the topic waits rightfully or has no work), čakám before its alarm time. After a missed alarm it counts from the
 * alarm's time, or from a later push. Another state (none yet) counts from the last push.
 */
export function lockIdleSince({ state = null, alarmAt = null, lastPush = null, now = Date.now() } = {}) {
  if (state === QUESTION || state === DONE) return null;
  const push = ms(lastPush);
  const alarm = ms(alarmAt);
  if (state === WAITING && alarm !== null) {
    if (ms(now) < alarm) return null;
    return Math.max(alarm, push ?? alarm);
  }
  return push;
}

/** Inactivity of a lock in hours when it reaches `hours` (policy topics.stale_machine_hours): { since, hours } or null. */
export function lockInactivity(facts, hours = STALE_HOURS) {
  const since = lockIdleSince(facts);
  if (since === null) return null;
  const idle = (ms(facts.now ?? Date.now()) - since) / 3600_000;
  return idle >= hours ? { since: new Date(since).toISOString(), hours: Math.floor(idle) } : null;
}

/** Items of a stuck step: turn.stuck is the list of the Ďalší krok items marked at the wake that reached the cap (10.2, B4). */
export function stuckItems(stuck) {
  return Array.isArray(stuck) ? stuck.map((s) => String(s).trim()).filter(Boolean) : [];
}

/** Time (ISO) of the last commit of the topic state (its record and handover) in the brain, or null. */
export function lastStatePush(brainDir, id) {
  const L = layoutOf(brainDir);
  const files = [...new Set([L.topicFile, L.holderFile, L.handover])].map((f) => relPosix(brainDir, dataPath(brainDir, 'topics', id, f)));
  const r = git(['log', '-1', '--format=%cI', '--', ...files], { cwd: brainDir });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * The findings of one open topic: [{ kind: 'stuck'|'lock'|'done', ... }]. `rec` is a listTopicRecords entry, `owed` the
 * supervisor's owed items of the mail ({ from_topic }), a topic with one is not proposed for closing (3.9.3).
 */
export function topicFindings(rec, { now = Date.now(), hours = STALE_HOURS, lastPush = null, owed = [] } = {}) {
  const topic = rec.topic || {};
  if (isMainTopic({ ...topic, id: rec.id })) return [];
  const turn = topic.turn && typeof topic.turn === 'object' ? topic.turn : {};
  const holder = rec.holder || {};
  const out = [];
  const stuck = stuckItems(turn.stuck);
  if (stuck.length) out.push({ kind: 'stuck', items: stuck });
  if (holder.thread) {
    const idle = lockInactivity({ state: turn.state || null, alarmAt: turn.alarm_at || null, lastPush, now }, hours);
    if (idle) out.push({ kind: 'lock', holder: holder.thread, machine: holder.machine || null, since: idle.since, hours: idle.hours, state: turn.state || null });
  }
  const owes = owed.some((w) => w && w.from_topic === rec.id);
  const doneFor = ms(lastPush) === null ? Infinity : (ms(now) - ms(lastPush)) / 3600_000;
  if (turn.state === DONE && topic.mode !== 'discussion' && !owes && doneFor >= hours) out.push({ kind: 'done', since: lastPush });
  return out;
}

/** Brains of the machine: every domain under the projects root (`root`, else the saved one, else the parent of `ctx`'s domain). */
export function overviewRoot({ root = null, ctx = null, env = process.env } = {}) {
  if (root) return path.resolve(root);
  const saved = machineRoot(env);
  if (saved) return saved;
  return ctx?.domain?.root ? path.dirname(path.resolve(ctx.domain.root)) : null;
}

/**
 * The overview of the machine: { root, brains, topics, findings }. Each finding names its domain, brain and topic.
 * `brains` may be given (tests, one brain); else every brain of every domain under the root.
 */
export function overview({ root = null, ctx = null, brains = null, now = Date.now(), policy = null, owed = [], env = process.env } = {}) {
  const base = brains ? null : overviewRoot({ root, ctx, env });
  const list = brains || (base ? domainBrains(base) : []);
  const hours = idleHours(policy || ctx?.policy, env);
  const findings = [];
  let topics = 0;
  for (const b of list) {
    let recs = [];
    try { recs = listTopicRecords(b.dir); } catch { recs = []; }
    for (const rec of recs) {
      if (isMainTopic({ ...rec.topic, id: rec.id })) continue;
      topics++;
      const lastPush = lastStatePush(b.dir, rec.id) || rec.holder?.since || rec.topic?.created || null;
      for (const f of topicFindings(rec, { now, hours, lastPush, owed })) {
        findings.push({ ...f, domain: b.domainRoot ? path.basename(b.domainRoot) : null, brain: b.name, brainDir: b.dir, id: rec.id, subject: rec.topic?.subject || '' });
      }
    }
    // Work folders of the brain outside git over the limit (data 2.1 keeps every topic's tmp/ in the brain): data does
    // not pile up unseen (doma-pc 2026-11-16: 3 GB of exports in a never closed work folder).
    try {
      const work = repoWorkFinding(b.dir, layoutOf(b.dir));
      if (work) findings.push({ kind: 'work-files', domain: b.domainRoot ? path.basename(b.domainRoot) : null, brain: b.name, brainDir: b.dir, id: 'tmp', subject: '', text: work.text });
    } catch { /* an unknown layout: other checks name it */ }
  }
  return { root: base, brains: list.length, topics, findings };
}

const where = (f) => `${f.domain ? `${f.domain}/` : ''}${f.brain}/${f.id}`;
const subject = (f) => (f.subject ? ` (${String(f.subject).replace(/\s+/g, ' ').slice(0, 80)})` : '');

/** One line of a finding. */
export function findingLine(f) {
  if (f.kind === 'stuck') return `stuck: ${where(f)}${subject(f)}: ${f.items.join('; ')}; the question waits for the operator, instruct the manager only within your jurisdiction (spec 3.9.1)`;
  if (f.kind === 'lock') return `idle lock: ${where(f)}${subject(f)} held by ${f.holder}${f.machine ? ` on ${f.machine}` : ''}, inactive ${f.hours >= 48 ? `${Math.floor(f.hours / 24)} d` : `${f.hours} h`} since ${localTime(f.since)} (state ${f.state || '-'}): propose a takeover to the operator (spec 4.2.2)`;
  if (f.kind === 'work-files') return `work files: ${f.domain ? `${f.domain}/` : ''}${f.text}`;
  return `done without work: ${where(f)}${subject(f)} is hotovo${f.since ? ` since ${localTime(f.since)}` : ''}: propose closing to the operator (spec 3.9.3)`;
}

/** The key of a finding: a new key wakes the supervisor (the same finding mails once). */
export const findingKey = (f) => `${f.kind}|${f.brainDir}|${f.id}|${f.kind === 'stuck' ? f.items.join(';') : f.kind === 'lock' ? f.since : ''}`;

/** The overview as lines: a head line, then a line per finding. */
export function overviewLines(res) {
  const head = res.findings.length
    ? `overview: ${res.findings.length} finding(s) in ${res.topics} open topic(s) of ${res.brains} brain(s)`
    : `overview: nothing waits for the supervisor (${res.topics} open topic(s) of ${res.brains} brain(s))`;
  return [head, ...res.findings.map(findingLine)];
}

/** The open obligations of the mail for the supervisor's session start (spec 10.5): owed and awaited, one line each. */
export function obligationLines(d) {
  if (!d) return ['obligations: comms unavailable, not checked'];
  const from = (w) => (w.from_project && w.from_topic ? `${w.from_project}/${w.from_topic}` : w.sender || '?');
  const off = d.offline ? ' (offline)' : '';
  const owed = (d.owed || []).map((w) => `owed${off}: ${w.id} ${w.level} from ${from(w)} (${w.status === 'picked' ? 'picked without an answer' : `final reply due, ${w.answer_state || '-'}`})`);
  const awaiting = (d.awaiting || []).map((a) => `awaiting${off}: ${a.id} ${a.level} -> ${a.to} | ${a.status}${a.wait_due_at ? ` | next check ${localTime(a.wait_due_at)}` : ''}`);
  return owed.length || awaiting.length ? [...owed, ...awaiting] : [`obligations${off}: nothing owed, nothing awaited`];
}

/** This session is the supervisor's: a persona brain whose mail name is the supervisor persona of the policy (plan O5). */
export function isSupervisorSession(ctx) {
  const sup = supervisorOf(ctx?.policy);
  return !!ctx?.brainDir && !!ctx.brainInfo?.persona && !!sup.persona && commsProjectName(ctx) === sup.persona;
}

/** The state of the wake job (the keys of the findings last mailed): ~/.config/agentic-flow/overview-state.json. */
export function overviewStateFile(env = process.env) {
  return env.WORKFLOW_OVERVIEW_STATE || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', 'overview-state.json');
}
export function readOverviewState(env = process.env) {
  const d = readJson(overviewStateFile(env), null);
  return d && Array.isArray(d.keys) ? d : { keys: [] };
}
export function writeOverviewState(state, env = process.env) {
  const file = overviewStateFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Findings not mailed yet: those whose key the state does not hold. */
export const newFindings = (findings, state) => findings.filter((f) => !(state?.keys || []).includes(findingKey(f)));
