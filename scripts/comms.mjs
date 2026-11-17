// Interface to the mail service (P-041, P-042, P-044, P-047). The client is `bin/comms.mjs` of agentic-comms;
// this module only resolves where it is, spawns it with the hook deadline and shapes its JSON output.
// Without a reachable client the workflow works unchanged: `mail: 0`, nothing waits.
//
// Configuration (`.workflow.json`, overridable per machine in `local/workflow.json`), field `comms`:
//   absent            -> first existing of DEFAULT_CLIENTS (`../../comms`, `../agentic-comms`), used only when it exists
//   false             -> mail off
//   { client, instance, config, project }
//     client   path to the comms client script, relative to the project (default above)
//     instance comms instance name (`--instance`); omit when the client config names it
//     config   client config file (key, instance_id, data_dir ...), default `<brain>/local/comms.json`
//     project  project name used in mail addresses, default: project directory name
// Environment: WORKFLOW_COMMS_CLIENT overrides the client path (tests, machine-specific installs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, PLUGIN_ROOT } from './util.mjs';
import { machineName, servicesDir, threadStateFile } from './config.mjs';
import { knownBrains } from './update.mjs';
import { PERSONA_REPO_RE, PERSONA_PREFIX } from './persona-name.mjs';
import { dataPath, layoutOf } from './layout.mjs';
import { readTopicRecord, readHolderRecord, listTopicRecords } from './topic-files.mjs';

/**
 * Default client locations relative to the project, first existing wins. Recommended layout (pilot 2026-11-01): mail is
 * shared by all projects and sits outside them; each project folder holds the project and its brain:
 *   <root>/comms/                       mail service (agentic-comms)
 *   <root>/<project-x>/<repo>/          project, its brain next to it: <root>/<project-x>/<brain>/
 * The older flat layout (comms next to the project) is still found. v3 (D-0003): the installed release of the mail
 * service is `~/services/agentic-comms/` (absolute, see servicesClient), found before these.
 */
export const DEFAULT_CLIENTS = ['../../comms/bin/comms.mjs', '../agentic-comms/bin/comms.mjs'];
export const DEFAULT_CLIENT = DEFAULT_CLIENTS[0];
/** The installed release of the mail client (v3, D-0003): `~/services/agentic-comms/bin/comms.mjs`. */
export function servicesClient(env = process.env) {
  return path.join(servicesDir(env), 'agentic-comms', 'bin', 'comms.mjs');
}
/**
 * Mail name of a project: a persona repo `agent-<name>` is the persona `<name>` (v3: the domain `<name>/` holds the repo
 * `agent-<name>/`; mail addresses `@alice/main`, `alice/<topic>` stay when the repo is renamed or moved).
 */
export function mailProjectName(ctx) {
  const name = ctx.projectName;
  return ctx.persona && PERSONA_REPO_RE.test(name || '') ? name.slice(PERSONA_PREFIX.length) : name;
}
/**
 * Mail project of this project: `comms.project` of the workflow configuration, else the mail name (mailProjectName).
 * Every mail address the workflow builds for this project uses it (the client settings, the report intake, the issue
 * records), so a project with its own mail name is addressed the same way everywhere.
 */
export function commsProjectName(ctx) {
  const raw = ctx.config?.comms;
  return (raw && typeof raw === 'object' && raw.project) || mailProjectName(ctx);
}
export const LEVELS = ['blocker', 'steer', 'assist'];
/** Mechanical categories of the prompt line (P-044, operator 2026-11-02): a reply (reply_to or thread-addressed), else the level.
 * An interim reply names its state after the category: `reply otázka`, `reply čakám` (P-061). */
export const INTERIM_REPLY_STATES = ['otázka', 'čakám'];
export const CATEGORIES = ['reply', ...LEVELS];
/** Client subcommands a subagent may run (read only, P-025; `status` and `notices` only read, audit M2 2026-11-11). The triage subagent is removed (2026-11-02). */
export const SUBAGENT_ALLOWED = ['receive', 'list', 'count', 'status', 'notices'];

/**
 * Default client: the pilot layout (`../../comms`, a test instance next to its projects) first, then the installed
 * release (`~/services/agentic-comms`), then a development checkout next to the project.
 */
function defaultClient(projectDir) {
  const rel = (c) => fs.existsSync(path.resolve(projectDir, c));
  if (rel(DEFAULT_CLIENTS[0])) return DEFAULT_CLIENTS[0];
  if (fs.existsSync(servicesClient())) return servicesClient();
  return DEFAULT_CLIENTS.slice(1).find(rel) || DEFAULT_CLIENT;
}

const mailHomes = new Map();
/**
 * Brain whose mail settings (key, outbox) a thread uses when its session project has no brain (P-024): among the brains
 * this machine started a session in that have mail settings, the one with this thread's state (it sent or read mail
 * there; the newest); with `any` (an explicit comms command) else the first one of a non-pilot instance. Mail addressed
 * to a thread is that thread's in any mailbox key of the instance. Nothing is written there by this choice. Cause
 * (operator 2026-11-17, critical: mail not picked up is lost mail): a thread in a project without a brain got the bell
 * `you have mail in topic thread/<id>` for a reply to its message and comms.mjs refused with "brain unavailable".
 */
export function threadMailBrain(thread, { any = false } = {}) {
  if (!thread) return null;
  const key = `${thread}\0${any}`;
  if (mailHomes.has(key)) return mailHomes.get(key);
  let pick = null;
  try {
    const conf = (b) => dataPath(b, 'local', 'comms.json');
    const withMail = knownBrains().filter((b) => { try { return fs.existsSync(conf(b)); } catch { return false; } });
    const at = (b) => { try { return fs.statSync(threadStateFile(b, thread)).mtimeMs; } catch { return -1; } };
    const own = withMail.map((b) => [b, at(b)]).filter(([, t]) => t >= 0).sort((a, b) => b[1] - a[1]);
    pick = own.length ? own[0][0] : any ? (withMail.find((b) => readJson(conf(b), {})?.instance !== 'pilot') || withMail[0] || null) : null;
  } catch { pick = null; }
  mailHomes.set(key, pick);
  return pick;
}

/** Brain of the mail settings: the session's, else the thread's mail home (threadMailBrain). */
export function mailBrain(ctx, opts) {
  return ctx?.brainDir || ctx?.mailBrainDir || (ctx?.thread ? threadMailBrain(ctx.thread, opts) : null);
}

/** Resolve the comms settings of a project. Never throws. */
export function commsSettings(ctx) {
  const raw = ctx.config?.comms;
  const projectDir = ctx.projectDir;
  if (raw === false) return { enabled: false, reason: 'comms disabled in configuration', configured: true };
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const explicit = !!(process.env.WORKFLOW_COMMS_CLIENT || cfg.client);
  const clientRel = process.env.WORKFLOW_COMMS_CLIENT || cfg.client
    || defaultClient(projectDir);
  const client = path.resolve(projectDir, clientRel);
  const home = mailBrain(ctx);
  const configFile = cfg.config
    ? path.resolve(projectDir, cfg.config)
    : home ? dataPath(home, 'local', 'comms.json') : null;
  const out = {
    enabled: fs.existsSync(client),
    configured: explicit || raw !== undefined,
    client,
    clientRel,
    instance: cfg.instance || null,
    configFile: configFile && fs.existsSync(configFile) ? configFile : null,
    project: commsProjectName(ctx),
    outbox: home ? dataPath(home, 'local', 'outbox') : null,
    clientDir: home ? dataPath(home, 'local', 'comms') : null,
    mailHome: !ctx.brainDir && home ? home : null,
    waitMs: ctx.policy?.comms?.hook_wait_ms ?? 2000,
  };
  if (!out.enabled) out.reason = explicit ? `comms client not found at ${clientRel}` : 'comms not configured';
  return out;
}

export function commsConfigured(ctx) {
  return commsSettings(ctx).enabled;
}

export const NOTICES_CACHE = 'notices-count.json';

/**
 * Open notices of the instance for the status line of the persona main thread (D-0011: 41 open notices, none decided
 * since 11-02, nobody saw them). One client call per `comms.notices_ttl_s` (300 s), cached in the client dir; null when
 * comms is off or does not answer.
 */
export function noticesCount(ctx, now = Date.now()) {
  const s = commsSettings(ctx);
  if (!s.enabled || !s.clientDir) return null;
  const file = path.join(s.clientDir, NOTICES_CACHE);
  const cached = readJson(file, null);
  if (Number.isFinite(cached?.count) && now - Date.parse(cached.at) < (ctx.policy?.comms?.notices_ttl_s ?? 300) * 1000) return cached.count;
  const res = runClient(ctx, ['notices']);
  if (!res.ok || !Array.isArray(res.data?.notices)) return null;
  const count = res.data.notices.length;
  try {
    fs.mkdirSync(s.clientDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), count }) + '\n');
  } catch { /* the count is shown without the cache */ }
  return count;
}

/** A decision changes the count: the next status line asks again. */
export function dropNoticesCache(ctx) {
  const s = commsSettings(ctx);
  if (s.clientDir) fs.rmSync(path.join(s.clientDir, NOTICES_CACHE), { force: true });
}

let cachedVersion;
/** Installed workflow version `v<package.json version>` (null when unreadable), sent to the mail client. */
export function workflowVersion() {
  if (cachedVersion === undefined) {
    const v = readJson(path.join(PLUGIN_ROOT, 'package.json'), {})?.version;
    cachedVersion = v ? `v${v}` : null;
  }
  return cachedVersion;
}

/** Mail model of this workflow (package.json `commsModel`, D-0089): the mail must report the same in `/health`. */
export const COMMS_MODEL = Number(readJson(path.join(PLUGIN_ROOT, 'package.json'), {})?.commsModel) || null;
/** The one line of a model mismatch (mail design 4a, P-073): nothing is read, written or queued. */
export const modelMismatchText = (model) => `comms model ${model ?? '?'} ≠ ${COMMS_MODEL}: update mail and workflow together`;
/** A successful model check is kept this long in the client dir (one `health` call per minute, not per hook). */
export const MODEL_CHECK_TTL_MS = 60_000;
export const MODEL_CHECK_FILE = 'model-check.json';
const modelChecks = new Map();

function spawnClient(ctx, s, args, { timeoutMs, input, thread } = {}) {
  const wait = timeoutMs ?? s.waitMs;
  const th = thread === undefined ? ctx.thread : thread;
  const common = ['--timeout', String(wait)];
  if (s.configFile) common.push('--config', s.configFile);
  if (s.instance) common.push('--instance', s.instance);
  if (s.outbox) common.push('--outbox', s.outbox, '--client-dir', s.clientDir);
  if (th) common.push('--thread', th);
  const res = spawnSync(process.execPath, [s.client, ...args, ...common], {
    cwd: ctx.projectDir,
    encoding: 'utf8',
    input,
    timeout: wait + 1500,
    // The mail service records the workflow version per persona and machine (`comms clients`).
    env: { ...process.env, COMMS_THREAD_ID: th || '', COMMS_WORKFLOW_VERSION: workflowVersion() || '' },
  });
  const parse = (t) => { try { return JSON.parse(String(t || '').trim()); } catch { return null; } };
  if (res.error || res.status === null) {
    return { ok: false, code: 2, data: null, error: 'comms unavailable (client timed out)', unavailable: true };
  }
  if (res.status === 0) return { ok: true, code: 0, data: parse(res.stdout) ?? {}, error: null, unavailable: false };
  const err = parse(res.stderr);
  const message = err?.error || (res.stderr || res.stdout || '').trim().split('\n')[0] || `comms client exit ${res.status}`;
  // The client refuses a service of another model itself (exit 3, MODEL_MISMATCH): reported as the model line.
  if (res.status === 3 && err?.code === 'MODEL_MISMATCH') return { ok: false, code: 3, data: err, error: message, unavailable: false, model: true };
  return { ok: false, code: res.status, data: err, error: res.status === 2 ? 'comms unavailable' : message, unavailable: res.status === 2 };
}

/**
 * The mail speaks the model of this workflow (4a, I10): `health` once per process, a match kept MODEL_CHECK_TTL_MS in
 * the client dir. Returns null when it matches or cannot be told (mail unavailable: the client's outbox rule applies),
 * else the mismatch `{ model, error }` (a mail without `model` in /health is model `?`).
 */
export function modelMismatch(ctx, s = commsSettings(ctx)) {
  if (!s.enabled) return null;
  const key = `${s.client}|${s.configFile || ''}|${s.instance || ''}`;
  if (modelChecks.has(key)) return modelChecks.get(key);
  const file = s.clientDir ? path.join(s.clientDir, MODEL_CHECK_FILE) : null;
  const cached = file ? readJson(file, null) : null;
  if (cached?.key === key && cached.model === COMMS_MODEL && Date.now() - Date.parse(cached.at) < MODEL_CHECK_TTL_MS) {
    modelChecks.set(key, null);
    return null;
  }
  const r = spawnClient(ctx, s, ['health']);
  let out = null;
  if (r.ok && r.data?.model !== COMMS_MODEL) out = { model: r.data?.model ?? null, error: modelMismatchText(r.data?.model) };
  else if (r.model) out = { model: null, error: r.error };
  if (r.unavailable) return null;
  modelChecks.set(key, out);
  if (!out && file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ key, model: COMMS_MODEL, version: r.data?.version ?? null, at: new Date().toISOString() }) + '\n'); } catch { /* checked again next time */ }
  }
  return out;
}

/**
 * Run the comms client once. Returns { ok, code, data, error, unavailable, model }. A mail of another model (modelMismatch)
 * runs nothing: `{ ok: false, code: 3, model: true, error: "comms model … ≠ 2: update mail and workflow together" }`.
 * Exit codes of the client: 0 ok, 1 rejected/usage, 2 comms unavailable, 3 other instance or other model.
 * `thread`: the thread the call is for (default ctx.thread; null: none, e.g. the view of another topic).
 */
export function runClient(ctx, args, { timeoutMs, input, thread } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, code: null, data: null, error: s.reason, unavailable: false, disabled: true };
  const mismatch = modelMismatch(ctx, s);
  if (mismatch) return { ok: false, code: 3, data: null, error: mismatch.error, unavailable: false, model: true };
  return spawnClient(ctx, s, args, { timeoutMs, input, thread });
}

/** Obligations query of held topics (section 2): work topics as `<project>/<topic>`, topic main as the persona mailbox. */
export function obligationsArgs(ctx, held = []) {
  const s = commsSettings(ctx);
  const topics = held.filter((t) => !isMainTopic(t)).map((t) => `${s.project}/${t.id}`);
  const a = ['obligations'];
  if (topics.length) a.push('--topics', [...new Set(topics)].join(','));
  if (held.some(isMainTopic)) a.push('--persona', s.project);
  return a;
}

/**
 * What the thread owes and awaits, from the mail (P-072): `GET /obligations` for the thread and its held topics
 * (inbox, owed, awaiting, recent after `since`, cursor, topics, server). The client keeps the last answer as the read-only
 * backup (`offline: true`, `age_s`) and reconciles after an outage (server wins); the workflow keeps no copy.
 * `topics` (`<project>/<topic>` list) replaces the held topics; `thread: null` asks without a thread (another topic's view).
 * Returns the runClient result; `none: true` when there is nothing to ask for.
 */
export function readObligations(ctx, { held = [], topics = null, since = null, thread } = {}) {
  const th = thread === undefined ? ctx.thread : thread;
  const a = topics ? ['obligations', ...(topics.length ? ['--topics', topics.join(',')] : [])] : obligationsArgs(ctx, held);
  if (!th && a.length === 1) return { ok: false, none: true, error: 'no thread or held topic: not checked' };
  if (since != null && since !== '') a.push('--since', String(since));
  return runClient(ctx, a, { thread: th });
}

/** Age of the backup for the status line: `45 s`, `12 min`, `3 h`. */
export function ageText(s) {
  const n = Math.max(0, Number(s) || 0);
  return n < 60 ? `${n} s` : n < 3600 ? `${Math.round(n / 60)} min` : `${Math.round(n / 3600)} h`;
}

/** Prefix of the queued line about owed mail (Stop); the prompt hook replaces a queued one with the mail's live `owed`. */
export const OWED_PREFIX = 'picked mail unanswered';
export const OWED_LINE = (list, offline = null) => `${OWED_PREFIX}${offline ? ` (offline, ${offline})` : ''}: ${list.map((w) => `${w.id} ${w.level}`).join(', ')}; answer each with comms send --reply-to <id> --state hotovo|otázka|čakám; answered another way (one reply for several, a new message): comms settle --id <id>; no answer needed: comms ack --id <id> (P-042)`;
/** Owed mail the stop reminds of: picked without an answer (an interim answer is not reminded), from the mail (P-072). */
export const unansweredOwed = (obligations) => (obligations?.owed || []).filter((w) => w.status === 'picked');

/**
 * One line of the mail's `recent` rows (section 2: settled or acked without a reply, withdrawn, no answer after 4 checks),
 * shown once per row: the prompt hook sends the cursor of the rows shown as `since` with its next call.
 */
export function recentLine(rows = [], max = 5) {
  if (!rows.length) return '';
  const shown = rows.slice(0, max).map((r) => r.line || `${r.kind} ${r.id}`);
  return `mail: ${shown.join(', ')}${rows.length > max ? ` (+${rows.length - max} more)` : ''} (comms message --id <id> for details)`;
}

/** Mailbox queries of a thread: each held topic (first one also carries the thread for replies), else the thread alone. */
export function mailQueries(ctx, held = []) {
  const s = commsSettings(ctx);
  // The persona's main thread (topic `main`, P-045) reads the mailbox `@<persona>/main` in the mail service.
  const queries = held.map((t, i) => (isMainTopic(t)
    ? { persona: s.project, thread: i === 0 ? ctx.thread : null }
    : { project: s.project, topic: t.id, thread: i === 0 ? ctx.thread : null }));
  if (!queries.length && ctx.thread) queries.push({ project: null, topic: null, thread: ctx.thread });
  return queries;
}

export function queryArgs(q) {
  const a = [];
  if (q.persona) a.push('--persona', q.persona);
  else if (q.project && q.topic) a.push('--project', q.project, '--topic', q.topic);
  if (q.thread) a.push('--thread', q.thread);
  return a;
}

/** Category of a waiting message from its listing item, without its body (P-044): a reply or a message addressed to a
 * thread is `reply`, else its level. */
export function categoryOf(item) {
  return item.reply_to || item.to_thread ? 'reply' : item.level;
}

/** Category with the state of an interim reply (`reply otázka`, `reply čakám`); a final reply is plain `reply`. */
export function categoryLabel(item) {
  const category = categoryOf(item);
  return category === 'reply' && INTERIM_REPLY_STATES.includes(item.reply_state) ? `reply ${item.reply_state}` : category;
}

/**
 * Waiting messages (status line P-023 e, prompt hooks), from the inbox of one `obligations` call (section 2: one request
 * per hook): items `{ id, level, reply_to, reply_state, code_answer, expired_at }` give the mechanical category of each
 * message; counting never picks a message up (P-042). The whole answer rides along (`obligations`: owed, awaiting,
 * recent, cursor) for the same hook. During an outage the client's backup is shown with `offline, <age>`; a mail of
 * another model is `?` with the model line (4a). `since`: the cursor of the recent rows this thread was shown.
 * Returns { count, blockers, steers, items, available, unknown, offline, note, configured, model, obligations }.
 */
export function mailCount(ctx, held = [], { since = null } = {}) {
  const s = commsSettings(ctx);
  const out = { count: 0, blockers: 0, steers: 0, items: [], available: false, unknown: false, offline: false, note: null, configured: s.enabled, obligations: null };
  if (!s.enabled) {
    if (s.configured && s.clientRel) out.note = s.reason; // explicit client path that does not exist: configuration error
    return out;
  }
  const res = readObligations(ctx, { held, since });
  // Nothing to ask for (no thread, no held topic): the mail is not checked, so it is unknown, never `0` as checked.
  if (res.none || !res.ok) { out.unknown = true; out.note = res.error; out.model = !!res.model; return out; }
  const d = res.data || {};
  if (d.offline && !d.cached) { out.unknown = true; out.note = 'comms unavailable'; return out; }
  out.obligations = d;
  for (const it of d.inbox?.ids || []) {
    out.items.push(it);
    out.count += 1;
    if (it.level === 'blocker') out.blockers += 1;
    if (it.level === 'steer') out.steers += 1;
  }
  if (d.wake) out.wake = d.wake;
  if (d.offline) { out.offline = true; out.note = `offline, ${ageText(d.age_s)}`; } else out.available = true;
  return out;
}

/**
 * Levels an open discussion with the operator holds back from the mail lines (D-0015, D-0022): a blocker, a steer and every
 * reply pass. A steer changes the running work, so the line shows it as the line after a tool does (P-061; report
 * 2026-11-17: a steer and two assists with the operator's own remarks waited while the line said `mail: 0`). The mail
 * still rings neither steer nor assist during the discussion (its own list in agentic-comms).
 */
export const DISCUSSION_HELD_LEVELS = ['assist'];

/**
 * The running turn of the thread discusses with the operator (D-0015): `discussion` of the thread state, written by the
 * prompt hook (turnDiscussion). A state without it (written before) is no discussion: the hooks show the mail as before.
 */
export function discussionOpen(state) {
  return !!state && state.discussion === true;
}

/**
 * Discussion of a turn that starts now (prompt hook, D-0015): the operator started it; an interrupted turn resumed by
 * keepalive keeps its own. A turn that ended `Stav: otázka` keeps no discussion open: delivered mail wakes the thread in
 * every state (spec 2.2, plan B7). The AskUserQuestion dialog is the mail's `waiting_operator`.
 */
export function turnDiscussion(turnSource, prior = null, kind = null) {
  if (turnSource === 'operator') return true;
  return kind === 'keepalive' && prior?.discussion === true;
}

/**
 * The mail a discussing thread is told about (D-0022): steer and assist wait for the end of the discussion, a blocker and
 * a reply pass. Mail without listing items (older server) only tells its blockers apart, so only they are kept.
 */
export function discussionMail(mail) {
  if (!mail || !mail.count) return mail;
  const all = Array.isArray(mail.items) ? mail.items : [];
  const items = all.filter((it) => !DISCUSSION_HELD_LEVELS.includes(categoryOf(it)));
  const unlisted = Math.max(0, (mail.blockers || 0) - all.filter((it) => it.level === 'blocker').length);
  const count = items.length + unlisted;
  const held = all.filter((it) => DISCUSSION_HELD_LEVELS.includes(categoryOf(it)));
  return { ...mail, items, count, blockers: items.filter((it) => it.level === 'blocker').length + unlisted, steers: items.filter((it) => it.level === 'steer').length, held_back: mail.count - count, held };
}

/**
 * The line of mail held back for the discussion (D-0022, report 2026-11-17): ids and levels, never a body, so the thread
 * does not read them now but tells the operator they wait (the operator decides; one of them may carry their own remark).
 */
export function heldMailLine(mail, max = 10) {
  const held = Array.isArray(mail?.held) ? mail.held : [];
  if (!held.length) return '';
  const shown = held.slice(0, max).map((it) => `${it.id} ${categoryLabel(it)}`).join(', ');
  return `mail held for the discussion with the operator: ${held.length} (${shown}${held.length > max ? `, +${held.length - max} more` : ''}); do not read them now; say in your reply in one line that ${held.length === 1 ? 'a message waits' : `${held.length} messages wait`} (level, sender topic from comms list), the operator decides; they ring when the turn ends hotovo or čakám (D-0015, D-0022)`;
}

export function formatMail(mail) {
  let s = `mail: ${mail.unknown && !mail.count ? '?' : mail.count}`;
  if (mail.blockers) s += ` (${mail.blockers} blocker)`;
  if (mail.steers) s += ` (${mail.steers} steer)`;
  if (mail.held_back) s += ` (+${mail.held_back} held for the discussion)`;
  if (mail.note) s += ` (${mail.note})`;
  if (mail.wake && mail.wake.running === false) s += ' | wake: off';
  return s;
}

/**
 * The supervisor (spec 1, 2.2; plan O5): policy `supervisor` {persona, comms} of the workflow, a brain policy overrides it
 * key by key (like `maintainer`). `persona` is the sender of its mail (the mail key it sends with), `comms` its address
 * for questions (3.3.2). Null fields when none is set.
 */
export function supervisorOf(policy = {}) {
  const s = policy && typeof policy.supervisor === 'object' && policy.supervisor ? policy.supervisor : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { persona: str(s.persona), comms: str(s.comms) };
}

/** A message (or a listing item) the supervisor sent: its instruction (2.2); mail of anyone else stays data (P-047). */
export function fromSupervisor(m, sup) {
  return !!sup?.persona && !!m && m.sender === sup.persona;
}

/**
 * Senders of waiting mail by message id (the `count` listing names them; the inbox of `obligations` does not): asked only
 * when a bell turn must tell the supervisor's mail apart (plan B7). A failed call leaves its ids out.
 */
export function mailSenders(ctx, held = []) {
  const senders = new Map();
  for (const q of mailQueries(ctx, held)) {
    const res = runClient(ctx, ['count', ...queryArgs(q)]);
    if (res.ok) for (const it of res.data?.items || []) if (it?.id && it.sender) senders.set(it.id, it.sender);
  }
  return senders;
}

/** Mechanical lines of waiting mail for the prompt: `<id> <category>`, never a body (P-044); the supervisor's marked. */
export function mailLines(items = [], sup = null) {
  return items.map((it) => `${it.id} ${categoryLabel(it)}${fromSupervisor(it, sup) ? ' (supervisor: instruction)' : ''}`);
}

/**
 * One prompt line with the waiting mail (2026-11-02: the triage subagent is removed, the main agent reads the ids itself):
 * `mail: <n> waiting: <id> <category>, ...` (at most `max` ids). Empty when nothing waits; without listing items only the count.
 */
export function mailNoticeLine(mail, max = 10, sup = null) {
  if (!mail || !mail.count) return '';
  const lines = mailLines(mail.items || [], sup);
  if (!lines.length) return `mail: ${mail.count} waiting`;
  const shown = lines.slice(0, max);
  const more = lines.length > max ? ` (+${lines.length - max} more)` : '';
  return `mail: ${mail.count} waiting: ${shown.join(', ')}${more}`;
}

/** Options of `comms turn` an older client may not know (dropped one by one when the client names it). */
const TURN_OPTIONAL = ['--discussion', '--opened-at', '--resume-at'];

/**
 * Turn record for keepalive (P-043): `open` at the prompt, `closed` at Stop. The thread travels as `--thread` (runClient);
 * machine and holder mode come from holder.json of the first held topic (as registerTopic), else this machine.
 * `open` answers `turn.opened_at` (kept in the thread state as `turn_opened_at`); `closed` sends it back as `--opened-at`
 * so the service ignores a Stop of an older turn (`stale: true`). The client queues a `closed` in its outbox during an
 * outage (`queued: true`); `open` is never queued. `discussion` (boolean, D-0015): `--discussion open|closed`, the thread
 * discusses with the operator, so the mail holds back steer and assist rings and answers their senders `otázka`. An older
 * client without `--opened-at`, `--resume-at` or `--discussion` (usage error naming it) gets the call again without it.
 * Never throws.
 */
export function recordTurn(ctx, state, held = [], { openedAt = null, next = null, resumeAt = null, discussion = null } = {}) {
  try {
    const s = commsSettings(ctx);
    if (!s.enabled || !ctx.thread) return { ok: false, skipped: true };
    const h = held[0];
    const args = ['turn', '--state', state, '--machine', String(h?.holder?.machine || machineName())];
    if (h) {
      if (!isMainTopic(h)) args.push('--project', s.project, '--topic', h.id);
      if (h.holder?.mode === 'operator' || h.holder?.mode === 'auto') args.push('--holder-mode', h.holder.mode);
    }
    const timeoutMs = Math.min(s.waitMs, 1000);
    // P-026: the next step of the held work topic goes with `closed`; wake rings the thread to continue it.
    if (state === 'closed' && next) args.push('--next', String(next).slice(0, 300));
    // P-061: the thread timer; wake rings the thread at resume_at with the next step.
    if (state === 'closed' && next && resumeAt) args.push('--resume-at', String(resumeAt));
    if (state === 'closed' && openedAt) args.push('--opened-at', String(openedAt));
    if (typeof discussion === 'boolean') args.push('--discussion', discussion ? 'open' : 'closed');
    let call = args;
    let res = runClient(ctx, call, { timeoutMs });
    // An older mail client refuses a newer option (usage error naming it): the call goes again without it. Without
    // --resume-at the step is rung after the usual delay; without --discussion the mail rings as before.
    for (let tries = 0; !res.ok && res.code === 1 && tries < TURN_OPTIONAL.length; tries++) {
      const flag = TURN_OPTIONAL.find((f) => call.includes(f) && String(res.error || '').includes(f.slice(2)));
      if (!flag) break;
      call = call.filter((a, i, all) => a !== flag && all[i - 1] !== flag);
      res = runClient(ctx, call, { timeoutMs });
    }
    if (res.ok && res.data && res.data.ok === false) return { ok: false, ...res.data };
    return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, unavailable: !!res.unavailable, error: res.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * P-061 (V1): the flag `waiting_operator` of this thread's OPEN turn record in the mail (`comms turn --waiting-operator`):
 * the turn waits for the operator's dialog (AskUserQuestion), so the service does not expire a message of this thread as
 * "no reply" but tells the sender `otázka`. `openedAt` (turn_opened_at of the thread state) binds it to this very turn; the
 * end of the turn record (Stop, keepalive close after a crash) clears it. Never throws; an outage or an older client = nothing.
 */
export function recordWaitingOperator(ctx, waiting, openedAt = null) {
  try {
    const s = commsSettings(ctx);
    if (!s.enabled || !ctx.thread) return { ok: false, skipped: true };
    const args = ['turn', '--waiting-operator', waiting ? 'true' : 'false', ...(openedAt ? ['--opened-at', String(openedAt)] : [])];
    const res = runClient(ctx, args, { timeoutMs: Math.min(s.waitMs, 1000) });
    return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, unavailable: !!res.unavailable, error: res.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Idempotent topic registration in the mail service (P-037, P-041). The holder is the thread in topics/<id>/holder.json
 * unless `holder` is given (null: the topic is free). `takeover: true` lets the service replace another holder (a takeover
 * on operator instruction, P-037, P-045); `release: true` clears the holder (client flags `--takeover`, `--release`);
 * `close: true` marks the closed topic closed: the mail refuses new mail for it (410) and bounces what still waits.
 */
export function registerTopic(ctx, topicId, { holder = undefined, subject, takeover = false, release = false, close = false } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, reason: s.reason, topic: topicId, project: s.project, skipped: true };
  const topic = subject ? { subject } : (ctx.brainDir ? readTopicRecord(ctx.brainDir, topicId) || readTopicRecord(ctx.brainDir, topicId, { closed: true }) || {} : {});
  // Topic `main` of a persona is its main thread `@<persona>/main` in the mail service (P-045).
  const main = isMainTopic({ id: topicId, ...topic });
  const args = main
    ? ['register-topic', '--persona', s.project, '--main']
    : ['register-topic', '--project', s.project, '--topic', topicId, '--subject', topic.subject || topicId];
  const hj = ctx.brainDir ? readHolderRecord(ctx.brainDir, topicId) : {};
  // Holder from holder.json (P-037): a free topic (no thread there) is never registered to the calling thread.
  const h = holder === undefined ? (hj.thread || null) : holder;
  if (close) {
    args.push('--close');
  } else if (release) {
    args.push('--release');
  } else if (h) {
    args.push('--holder', h);
    if (hj.mode === 'operator' || hj.mode === 'auto') args.push('--holder-mode', hj.mode);
    // Machine of the holder (P-043): only the wake module on that machine rings the thread.
    if (hj.machine) args.push('--holder-machine', String(hj.machine));
  }
  if (takeover) args.push('--takeover');
  const res = runClient(ctx, args);
  if (!res.ok) return { ok: false, reason: res.error, topic: topicId, project: s.project, unavailable: res.unavailable };
  return { ok: true, created: !!res.data.created, topic: main ? 'main' : topicId, project: main ? `@${s.project}` : s.project, holder: h || null };
}

/**
 * Archived topics (topics/archive/<id>) the mail service still holds open are closed there. Topics archived before the
 * mail knew `close` kept their holder and took mail nobody read (alice 2026-11-02). Which ones the mail closed already is
 * the mail's `obligations.topics` (state per topic), not a local list (P-072). Returns the ids closed now; skipped during
 * an outage (the backup is no ground for a write).
 */
export function closeArchivedTopics(ctx) {
  const s = commsSettings(ctx);
  if (!s.enabled || !ctx.brainDir) return [];
  // Layout 1: the folders of topics/archive; layout 2: the topics with state closed (they stay in temy/).
  const closed = listTopicRecords(ctx.brainDir, { closed: true }).map((t) => t.id).filter((id) => id !== MAIN_TOPIC);
  if (!closed.length) return [];
  const res = readObligations(ctx, { topics: closed.map((id) => `${s.project}/${id}`), thread: null });
  if (!res.ok || res.data?.offline) return [];
  const open = new Set((res.data.topics || []).filter((t) => t.registered && t.state !== 'closed').map((t) => t.topic));
  const out = [];
  for (const id of closed) {
    if (!open.has(id)) continue;
    const r = registerTopic(ctx, id, { close: true });
    if (r.ok) out.push(id);
    else if (r.unavailable) break;
  }
  return out;
}

/** Topic `main` (kind `main`): the persona's main thread, permanent, outside the topic limit (P-045). */
export const MAIN_TOPIC = 'main';
export function isMainTopic(t) {
  return !!t && t.id === MAIN_TOPIC && t.kind === 'main';
}

export function parseAddress(to, defaultProject) {
  const raw = String(to || '').trim();
  // Persona main thread (P-045): `@<persona>/main` or `@<persona>`.
  const p = /^@([a-z0-9][a-z0-9._-]*)(?:\/main)?$/i.exec(raw);
  if (p) return { persona: p[1] };
  const m = /^(?:([a-z0-9][a-z0-9._-]*)\/)?([a-z0-9][a-z0-9-]*)$/i.exec(raw);
  if (!m) return null;
  return { project: m[1] || defaultProject, topic: m[2] };
}
