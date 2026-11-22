// Interface to the mail service (P-041, P-042, P-044, P-047). The client is `bin/comms.mjs` of agentic-comms;
// this module only resolves where it is, runs it with the hook deadline (a process per call, or inside the process of a
// hook that can wait: clientInProcess, runClientsAsync) and shapes its JSON output.
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
// WORKFLOW_COMMS_SPAWN=1 runs every client call as a process of its own (no call inside the hook process, see clientInProcess).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, PLUGIN_ROOT, toPosix, machineConfigDir } from './util.mjs';
import { withLock } from './lock.mjs';
import { machineName, servicesDir, threadStateFile } from './config.mjs';
import { knownBrains } from './update.mjs';
import { PERSONA_REPO_RE, PERSONA_PREFIX } from './persona-name.mjs';
import { dataPath, layoutOf } from './layout.mjs';
import { readTopicRecord, readHolderRecord, listTopicRecords } from './topic-files.mjs';
import { brainId, brainName } from './brain-id.mjs';

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

/**
 * Mail config of this machine (~/.config/agentic-flow/comms.json: { url, key, instance_id } of a remote server, or
 * { instance, key, instance_id }): a brain without its own <brain>/local/comms.json uses it, so a machine that reaches
 * another server (a tunnel) is set up once, not per brain (operator 2026-11-18: install and migration left brains
 * without mail, flow-public#103). `project.mjs mail-machine` writes it.
 */
export const machineMailFile = (env = process.env) => env.WORKFLOW_MACHINE_COMMS || path.join(machineConfigDir(env), 'comms.json');

/** The machine's mark that mail to the maintainer failed and a report went to an issue (operator 2026-11-18). */
export const maintainerMailFile = (env = process.env) => env.WORKFLOW_MAINTAINER_MAIL || path.join(machineConfigDir(env), 'maintainer-mail.json');

export const MAIL_FIX = () => `the mail of this machine must reach the maintainer's mail server: node ${toPosix(path.join(PLUGIN_ROOT, 'bin', 'project.mjs'))} mail-machine --url <server url> --instance-id <id> --key-file <file with the key the maintainer issued>, then error.mjs report again`;

/** Mark (why) or clear (null) that mail to the maintainer does not work. Never throws. */
export function markMaintainerMail(why, env = process.env, now = new Date()) {
  const file = maintainerMailFile(env);
  try {
    if (!why) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ broken_at: now.toISOString(), why: String(why).slice(0, 300) })}\n`);
  } catch { /* the line of the report says it anyway */ }
}

/** Session start: mail to the maintainer failed (reports go to GitHub issues): a line with the fix, or null. */
export function maintainerMailLine(env = process.env) {
  const rec = readJson(maintainerMailFile(env), null);
  if (!rec?.broken_at) return null;
  return `mail to the maintainer does NOT work since ${rec.broken_at} (${rec.why || 'unknown'}): error reports go to GitHub issues only as a fallback; tell the operator in your reply and keep the fix in Úlohy pre operátora: ${MAIL_FIX()}`;
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
  const brainFile = home ? dataPath(home, 'local', 'comms.json') : null;
  const machineFile = machineMailFile();
  // WORKFLOW_COMMS_CONFIG: the mail config of a session without a brain of its own (the maintainer's thread, operator
  // 2026-11-18): without it such a session took the key of a brain it only reads mail through and signed as that brain.
  const envFile = process.env.WORKFLOW_COMMS_CONFIG || null;
  const configFile = cfg.config
    ? path.resolve(projectDir, cfg.config)
    : envFile ? path.resolve(envFile)
    : brainFile && fs.existsSync(brainFile) ? brainFile : fs.existsSync(machineFile) ? machineFile : brainFile;
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

/**
 * flow-public#103: the brain of this session has no <brain>/local/comms.json (no sender key) while the mail client exists:
 * the client calls instance `default` without a key and every call fails. A line with the fix, or null.
 */
export function noMailConfigLine(ctx) {
  if (!ctx?.brainDir || ctx.config?.comms === false || ctx.config?.comms?.config) return null;
  const s = commsSettings(ctx);
  if (!s.enabled || s.configFile) return null;
  return `mail: NOT set up for this brain (no ${toPosix(dataPath(ctx.brainDir, 'local', 'comms.json'))}, no ${toPosix(machineMailFile())}): every mail call goes to instance default without a key; a mail server on this machine: node ${toPosix(path.join(PLUGIN_ROOT, 'bin', 'project.mjs'))} mail ${toPosix(ctx.projectDir)}; another server (tunnel), once for the machine: node ${toPosix(path.join(PLUGIN_ROOT, 'bin', 'project.mjs'))} mail-machine --url <server url> --instance-id <id> --key-file <file> (flow-public#103)`;
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

/** Client options that name a topic mailbox or address (mail model 3: they need the brain of this session). */
const TOPIC_OPTIONS = ['--project', '--topics', '--to', '--persona'];

/**
 * Brain and machine of this session for the client (mail model 3): COMMS_BRAIN and COMMS_BRAIN_NAME when the session has
 * a brain (empty otherwise: the maintainer's thread has none), COMMS_MACHINE always machineName() (the one machine source,
 * also of wake.json). A brain without an id (shallow clone, no commit) fails only a call that names a topic; a thread-only
 * call goes without the brain. Returns { env } or { error }.
 */
export function clientIdentity(ctx, args = []) {
  const env = { COMMS_MACHINE: machineName(), COMMS_BRAIN: '', COMMS_BRAIN_NAME: '' };
  if (!ctx?.brainDir) return { env };
  try {
    env.COMMS_BRAIN = brainId(ctx.brainDir);
    env.COMMS_BRAIN_NAME = brainName(ctx.brainDir);
  } catch (err) {
    if (args[0] === 'register-topic' || args.some((a) => TOPIC_OPTIONS.includes(a))) return { error: err.message };
  }
  return { env };
}

/** One client call: its argv after the script, its environment and its deadline; `{ error }` when the brain cannot be named. */
function clientCall(ctx, s, args, { timeoutMs, thread, noStart = false } = {}) {
  const wait = timeoutMs ?? s.waitMs;
  const th = thread === undefined ? ctx.thread : thread;
  const who = clientIdentity(ctx, args);
  if (who.error) return { error: { ok: false, code: 1, data: null, error: who.error, unavailable: false } };
  const common = ['--timeout', String(wait)];
  if (s.configFile) common.push('--config', s.configFile);
  if (s.instance) common.push('--instance', s.instance);
  if (s.outbox) common.push('--outbox', s.outbox, '--client-dir', s.clientDir);
  if (th) common.push('--thread', th);
  if (noStart) common.push('--no-start');
  // The mail service records the workflow version per persona and machine (`comms clients`).
  return { argv: [...args, ...common], wait, env: { ...who.env, COMMS_THREAD_ID: th || '', COMMS_WORKFLOW_VERSION: workflowVersion() || '' } };
}

/**
 * The mail client of this machine is at least `version` (its package.json). The client is updated apart from the
 * workflow, and an older one refuses an option it does not know (usage error): the caller leaves the option out.
 */
const clientVersions = new Map();
export function mailClientHas(ctx, version) {
  const s = commsSettings(ctx);
  if (!s.enabled || !s.client) return false;
  if (!clientVersions.has(s.client)) clientVersions.set(s.client, readJson(path.join(path.dirname(s.client), '..', 'package.json'), null)?.version || null);
  const part = (v) => String(v || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const have = part(clientVersions.get(s.client)); const need = part(version);
  for (let i = 0; i < 3; i++) if ((have[i] || 0) !== (need[i] || 0)) return (have[i] || 0) > (need[i] || 0);
  return !!clientVersions.get(s.client);
}
/** The mail version whose client has `send --no-queue` and `--op-id` (send, resolve). */
export const MAIL_ONCE_VERSION = '2.0.37';

/**
 * `--op-id` of one write of this thread: the same write repeated in the same turn has the same id, and the mail answers
 * the repeat with the first result. The workflow stops a client at its time limit and cannot see whether the write
 * arrived; the command run again sent a second message (audit 2026-11-22). `parts`: what makes the write (address,
 * level, text). Empty for an older client.
 */
export function onceArgs(ctx, parts) {
  if (!mailClientHas(ctx, MAIL_ONCE_VERSION)) return [];
  let turn = '';
  try { turn = ctx.brainDir && ctx.thread ? readJson(threadStateFile(ctx.brainDir, ctx.thread), {})?.turn_started_at || '' : ''; } catch { /* no state: the hour below */ }
  const seed = [ctx.thread || '', turn || new Date().toISOString().slice(0, 13), ...parts.map(String)].join('\u0000');
  return ['--op-id', `flow-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`];
}

/** The result of one client run from its exit code and output; `status` null: it did not end within its deadline. */
function clientResult(status, stdout, stderr) {
  const parse = (t) => { try { return JSON.parse(String(t || '').trim()); } catch { return null; } };
  if (status === null) {
    // A client that printed its whole answer and did not end in time did its work: the answer counts. Thrown away, a
    // pickup it confirmed was lost with the bodies, and a send was repeated (audit 2026-11-22).
    const late = parse(stdout);
    if (late && typeof late === 'object') return { ok: true, code: 0, data: late, error: null, unavailable: false, late: true };
    return { ok: false, code: 2, data: null, error: 'comms unavailable (client timed out)', unavailable: true };
  }
  if (status === 0) return { ok: true, code: 0, data: parse(stdout) ?? {}, error: null, unavailable: false };
  const err = parse(stderr);
  const message = err?.error || (stderr || stdout || '').trim().split('\n')[0] || `comms client exit ${status}`;
  // The client refuses a service of another model itself (exit 3, MODEL_MISMATCH): reported as the model line.
  if (status === 3 && err?.code === 'MODEL_MISMATCH') return { ok: false, code: 3, data: err, error: message, unavailable: false, model: true };
  return { ok: false, code: status, data: err, error: status === 2 ? 'comms unavailable' : message, unavailable: status === 2 };
}

function spawnClient(ctx, s, args, opts = {}) {
  const call = clientCall(ctx, s, args, opts);
  if (call.error) return call.error;
  const res = spawnSync(process.execPath, [s.client, ...call.argv], {
    cwd: ctx.projectDir,
    encoding: 'utf8',
    input: opts.input,
    timeout: call.wait + 1500,
    env: { ...process.env, ...call.env },
  });
  return clientResult(res.error ? null : res.status, res.stdout, res.stderr);
}

const clientMains = new Map();
/**
 * `main(argv, { stdout, stderr })` of the client's CLI module (`<client>/../src/client/cli.mjs`, the function its
 * `bin/comms.mjs` runs) for a call inside this process, or null: the client has no such module (a stub, another layout),
 * WORKFLOW_COMMS_SPAWN=1, or a path of the client is relative (the spawned client runs in the project and resolves it
 * there; this process may run in any directory of the session).
 */
function clientMain(ctx, s) {
  if (process.env.WORKFLOW_COMMS_SPAWN === '1') return Promise.resolve(null);
  if (path.resolve(ctx.projectDir || '.') !== process.cwd()) {
    const cfg = s.configFile ? readJson(s.configFile, {}) || {} : {};
    const dirs = [
      ...Object.entries({ ...cfg, ...(cfg.wake && typeof cfg.wake === 'object' ? cfg.wake : {}) }).filter(([k]) => /(_dir|^outbox)$/.test(k)),
      ...Object.entries(process.env).filter(([k]) => /^(COMMS|WAKE)_\w*(DIR|OUTBOX)$/.test(k)),
    ].map(([, v]) => v);
    if (dirs.some((d) => typeof d === 'string' && d && !path.isAbsolute(d))) return Promise.resolve(null);
  }
  if (!clientMains.has(s.client)) {
    const file = path.join(path.dirname(s.client), '..', 'src', 'client', 'cli.mjs');
    clientMains.set(s.client, fs.existsSync(file) ? loadClientMain(file).catch(() => null) : Promise.resolve(null));
  }
  return clientMains.get(s.client);
}

async function loadClientMain(file) {
  const main = (await import(pathToFileURL(file).href)).main;
  if (typeof main !== 'function') return null;
  // One connection per request: node's default agent keeps a connection alive, and the service closes an idle one after
  // 5 s. A hook that works between two calls without a turn of the event loop (Stop: the brain write between
  // `obligations` and `turn closed`) would send the second call into the closed connection (review 2026-11-19).
  const [{ default: http }, { default: https }] = await Promise.all([import('node:http'), import('node:https')]);
  http.globalAgent = new http.Agent({ keepAlive: false });
  https.globalAgent = new https.Agent({ keepAlive: false });
  return main;
}

const LATE = Symbol('late');
/** `promise`, or LATE when it does not settle within `ms`. */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), ms); })]).finally(() => clearTimeout(timer));
}

/** Calls past their deadline that still run in this process (a spawned client was killed at its deadline; this one cannot be). */
const overdue = new Set();
/**
 * No call past its deadline runs any more; they get `ms` to end. While one runs, no other call is made, here or as a
 * process: it may be sending the outbox, or its request would arrive after the next one.
 */
async function overdueEnded(ms) {
  return !overdue.size || (await within(Promise.all([...overdue]), ms)) !== LATE;
}
/** Deadline of the probe of the service (serviceUp): the answer of a running service takes a few ms. */
const PROBE_MS = 500;
/** Clients whose service did not answer the probe in this process: their calls are spawned, as before. */
const servicesDown = new Set();

/**
 * One client call inside this process (operator 2026-11-19: asynchronous, no new `node` per call: a spawned client is
 * ~90 ms, the first call here ~15 ms, the next ones ~2 ms). Arguments, environment, deadline and result as spawnClient.
 * It never starts the service (`--no-start`): only a spawned client does, one at a time (two starts at once unlink each
 * other's socket: the server probes, unlinks, listens); the callers come here only after the service answered (serviceUp)
 * and no call past its deadline runs (overdueEnded).
 */
async function clientInProcess(main, ctx, s, args, opts = {}) {
  const call = clientCall(ctx, s, args, { ...opts, noStart: true });
  if (call.error) return call.error;
  const sink = () => { let text = ''; return { write: (chunk) => { text += chunk; return true; }, text: () => text }; };
  const out = sink();
  const err = sink();
  // The client reads the settings of a call from process.env before its first await (resolveConfig in main, agentic-comms
  // src/client/cli.mjs): the variables of this call are set for that synchronous part only, so two calls at once never
  // see each other's thread or brain.
  const before = Object.fromEntries(Object.keys(call.env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, call.env);
  let run;
  try {
    run = main(call.argv, { stdout: out, stderr: err });
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const ended = Promise.resolve(run).then((code) => code, () => 1);
  const status = await within(ended, call.wait + 1500);
  if (status !== LATE) return clientResult(status, out.text(), err.text());
  const still = ended.then(() => { overdue.delete(still); });
  overdue.add(still);
  return clientResult(null);
}

/**
 * The service answers now, asked inside this process: `{ mismatch }` (modelMismatch, from the same answer), or null: no
 * answer (kept for this process: the calls are spawned, the spawned client may start the service).
 */
async function serviceUp(main, ctx, s) {
  if (servicesDown.has(s.client)) return null;
  const probe = await clientInProcess(main, ctx, s, ['health'], { timeoutMs: PROBE_MS });
  if (probe.unavailable) { servicesDown.add(s.client); return null; }
  const k = modelKnown(s);
  return { mismatch: k.known ? k.value : modelJudged(k, probe) };
}

/**
 * The mail speaks the model of this workflow (4a, I10): `health` once per process, a match kept MODEL_CHECK_TTL_MS in
 * the client dir. Returns null when it matches or cannot be told (mail unavailable: the client's outbox rule applies),
 * else the mismatch `{ model, error }` (a mail without `model` in /health is model `?`).
 */
export function modelMismatch(ctx, s = commsSettings(ctx)) {
  if (!s.enabled) return null;
  const k = modelKnown(s);
  return k.known ? k.value : modelJudged(k, spawnClient(ctx, s, ['health']));
}

/** The check a process already made, or a match kept in the client dir: `{ key, file, known, value }`. */
function modelKnown(s) {
  const key = `${s.client}|${s.configFile || ''}|${s.instance || ''}`;
  if (modelChecks.has(key)) return { key, known: true, value: modelChecks.get(key) };
  const file = s.clientDir ? path.join(s.clientDir, MODEL_CHECK_FILE) : null;
  const cached = file ? readJson(file, null) : null;
  if (cached?.key === key && cached.model === COMMS_MODEL && Date.now() - Date.parse(cached.at) < MODEL_CHECK_TTL_MS) {
    modelChecks.set(key, null);
    return { key, file, known: true, value: null };
  }
  return { key, file, known: false };
}

/** modelMismatch from the answer `r` of `health`; only an answer of the service (a match or another model) is kept. */
function modelJudged({ key, file }, r) {
  // No answer about the model (outage, a refused call, another instance): cannot be told, asked again next time. A
  // refused `health` was kept as a match for a minute before (review 2026-11-19).
  if (!r.ok && !r.model) return null;
  const out = r.ok && r.data?.model === COMMS_MODEL ? null : r.ok ? { model: r.data?.model ?? null, error: modelMismatchText(r.data?.model) } : { model: null, error: r.error };
  modelChecks.set(key, out);
  if (!out && file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ key, model: COMMS_MODEL, version: r.data?.version ?? null, at: new Date().toISOString() }) + '\n'); } catch { /* checked again next time */ }
  }
  return out;
}

const CLIENT_OFF = (s) => ({ ok: false, code: null, data: null, error: s.reason, unavailable: false, disabled: true });
const CLIENT_MODEL = (mismatch) => ({ ok: false, code: 3, data: null, error: mismatch.error, unavailable: false, model: true });

/**
 * Run the comms client once. Returns { ok, code, data, error, unavailable, model }. A mail of another model (modelMismatch)
 * runs nothing: `{ ok: false, code: 3, model: true, error: "comms model … ≠ <COMMS_MODEL>: update mail and workflow together" }`.
 * Exit codes of the client: 0 ok, 1 rejected/usage, 2 comms unavailable, 3 other instance or other model.
 * `thread`: the thread the call is for (default ctx.thread; null: none, e.g. the view of another topic).
 */
export function runClient(ctx, args, { timeoutMs, input, thread } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return CLIENT_OFF(s);
  const mismatch = modelMismatch(ctx, s);
  if (mismatch) return CLIENT_MODEL(mismatch);
  return spawnClient(ctx, s, args, { timeoutMs, input, thread });
}

/**
 * runClient for a caller that can wait (hooks): the call runs inside this process (clientInProcess) while the service
 * answers; a call with stdin, a client that cannot run here (clientMain) and a service that does not answer go the way
 * of runClient: a process of its own, which may start the service and is stopped at its deadline.
 */
export async function runClientAsync(ctx, args, { timeoutMs, input, thread } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return CLIENT_OFF(s);
  if (!(await overdueEnded(timeoutMs ?? s.waitMs))) return clientResult(null);
  const main = input === undefined ? await clientMain(ctx, s) : null;
  const up = main ? await serviceUp(main, ctx, s) : null;
  if (!up) return runClient(ctx, args, { timeoutMs, input, thread });
  if (up.mismatch) return CLIENT_MODEL(up.mismatch);
  return clientInProcess(main, ctx, s, args, { timeoutMs, thread });
}

/** The outbox holds a queued write, or cannot be told (the client's own default outbox). */
function outboxWaits(s) {
  if (!s.outbox) return true;
  try { return fs.readdirSync(s.outbox).some((f) => f.endsWith('.json')); } catch { return false; }
}

/**
 * The mail calls of one hook at once (operator 2026-11-19: parallel and asynchronous, without a race). `list`: items
 * `{ args, timeoutMs, thread }`, or `{ result }` for a call that is not made; the results come in the same order.
 * Only calls that may run twice and queue nothing during an outage belong here (obligations, turn open).
 * They run at once only inside this process, after the service answered (serviceUp), so none of them starts it. They
 * run one after another (runClientAsync), as before, when a race is possible or the fast way is closed:
 * - the outbox holds a queued write: every call sends the outbox first, two of them at once would send an item twice
 *   (a queued `closed` without opened_at after the new `open` closes the new turn);
 * - the service does not answer, speaks another model, or the client cannot run in this process;
 * - one of the calls made at once did not pass (the service went away): all are made again in order.
 */
export async function runClientsAsync(ctx, list) {
  const inOrder = async () => { const out = []; for (const c of list) out.push(c.args ? await runClientAsync(ctx, c.args, { timeoutMs: c.timeoutMs, thread: c.thread }) : c.result); return out; };
  const s = commsSettings(ctx);
  if (!s.enabled || list.filter((c) => c.args).length < 2 || outboxWaits(s) || overdue.size) return inOrder();
  const main = await clientMain(ctx, s);
  const up = main ? await serviceUp(main, ctx, s) : null;
  if (!up || up.mismatch) return inOrder();
  const res = await Promise.all(list.map((c) => (c.args ? clientInProcess(main, ctx, s, c.args, { timeoutMs: c.timeoutMs, thread: c.thread }) : c.result)));
  const passed = (r) => r.ok && !r.data?.unavailable && !r.data?.offline;
  return res.every((r, i) => !list[i].args || passed(r)) ? res : inOrder();
}

/** Obligations query of held topics (section 2): work topics as `<project>/<topic>`, topic main as the persona mailbox. */
export function obligationsArgs(ctx, held = []) {
  const s = commsSettings(ctx);
  const topics = held.filter((t) => !isMainTopic(t)).map((t) => `${topicProject(s, t)}/${t.id}`);
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
export function readObligations(ctx, query = {}) {
  const c = obligationsCall(ctx, query);
  return c.result || runClient(ctx, c.args, { thread: c.thread });
}

/** readObligations for a caller that can wait (hooks, runClientAsync). */
export async function readObligationsAsync(ctx, query = {}) {
  const c = obligationsCall(ctx, query);
  return c.result || runClientAsync(ctx, c.args, { thread: c.thread });
}

/** The client call of readObligations: `{ args, thread }`, or `{ result }` when there is nothing to ask for. */
export function obligationsCall(ctx, { held = [], topics = null, since = null, thread } = {}) {
  const th = thread === undefined ? ctx.thread : thread;
  const a = topics ? ['obligations', ...(topics.length ? ['--topics', topics.join(',')] : [])] : obligationsArgs(ctx, held);
  if (!th && a.length === 1) return { result: { ok: false, none: true, error: 'no thread or held topic: not checked' } };
  if (since != null && since !== '') a.push('--since', String(since));
  return { args: a, thread: th };
}

/** Age of the backup for the status line: `45 s`, `12 min`, `3 h`. */
export function ageText(s) {
  const n = Math.max(0, Number(s) || 0);
  return n < 60 ? `${n} s` : n < 3600 ? `${Math.round(n / 60)} min` : `${Math.round(n / 3600)} h`;
}

/** Prefix of the queued line about owed mail (Stop); the prompt hook replaces a queued one with the mail's live `owed`. */
export const OWED_PREFIX = 'picked mail unanswered';
export const OWED_LINE = (list, offline = null) => `${OWED_PREFIX}${offline ? ` (offline, ${offline})` : ''}: ${list.map((w) => `${w.id} ${w.level}`).join(', ')}; end each: it asks for an answer or a result: comms send --reply-to <id> --state hotovo|otázka|čakám; it asks for none and is done: comms ack --id <id>; answered another way (one reply for several, a new message): comms settle --id <id> (P-042)`;
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
    : { project: topicProject(s, t), topic: t.id, thread: i === 0 ? ctx.thread : null }));
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
  return mailCounted(ctx, commsSettings(ctx).enabled ? readObligations(ctx, { held, since }) : null);
}

/** mailCount for a caller that can wait (hooks, runClientAsync). */
export async function mailCountAsync(ctx, held = [], { since = null } = {}) {
  return mailCounted(ctx, commsSettings(ctx).enabled ? await readObligationsAsync(ctx, { held, since }) : null);
}

/** The result of mailCount from the answer `res` of its obligations call (not asked while the mail is off). */
export function mailCounted(ctx, res) {
  const s = commsSettings(ctx);
  const out = { count: 0, blockers: 0, steers: 0, items: [], available: false, unknown: false, offline: false, note: null, configured: s.enabled, obligations: null };
  if (!s.enabled) {
    if (s.configured && s.clientRel) out.note = s.reason; // explicit client path that does not exist: configuration error
    return out;
  }
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
export async function recordTurn(ctx, state, held = [], opts = {}) {
  try {
    const call = turnCall(ctx, state, held, opts);
    return call ? await turnRecorded(ctx, call, await runClientAsync(ctx, call.args, { timeoutMs: call.timeoutMs })) : { ok: false, skipped: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The client call of recordTurn: `{ args, timeoutMs }`, or null (mail off, no thread: nothing is recorded). */
function turnCall(ctx, state, held = [], { openedAt = null, next = null, resumeAt = null, discussion = null } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled || !ctx.thread) return null;
  const h = held[0];
  const args = ['turn', '--state', state, '--machine', String(h?.holder?.machine || machineName())];
  if (h) {
    if (!isMainTopic(h)) args.push('--project', topicProject(s, h), '--topic', h.id);
    if (h.holder?.mode === 'operator' || h.holder?.mode === 'auto') args.push('--holder-mode', h.holder.mode);
  }
  // P-026: the next step of the held work topic goes with `closed`; wake rings the thread to continue it.
  if (state === 'closed' && next) args.push('--next', String(next).slice(0, 300));
  // P-061: the thread timer; wake rings the thread at resume_at with the next step.
  if (state === 'closed' && next && resumeAt) args.push('--resume-at', String(resumeAt));
  if (state === 'closed' && openedAt) args.push('--opened-at', String(openedAt));
  if (typeof discussion === 'boolean') args.push('--discussion', discussion ? 'open' : 'closed');
  return { args, timeoutMs: Math.min(s.waitMs, 1000) };
}

/** The result of recordTurn from the answer `res` of its call (a call made together with another one: runClientsAsync). */
async function turnRecorded(ctx, call, res) {
  // An older mail client refuses a newer option (usage error naming it): the call goes again without it. Without
  // --resume-at the step is rung after the usual delay; without --discussion the mail rings as before.
  let args = call.args;
  for (let tries = 0; !res.ok && res.code === 1 && tries < TURN_OPTIONAL.length; tries++) {
    const flag = TURN_OPTIONAL.find((f) => args.includes(f) && String(res.error || '').includes(f.slice(2)));
    if (!flag) break;
    args = args.filter((a, i, all) => a !== flag && all[i - 1] !== flag);
    res = await runClientAsync(ctx, args, { timeoutMs: call.timeoutMs });
  }
  if (res.ok && res.data && res.data.ok === false) return { ok: false, ...res.data };
  return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, unavailable: !!res.unavailable, error: res.error };
}

/**
 * The mail of a prompt, asked together (runClientsAsync): what the thread owes and awaits in its mailboxes `mailTopics`
 * (`counted`, as mailCount) and the open turn record of its held topics (`opened`, as recordTurn). Neither needs the
 * other's answer and the service keeps them apart (messages, turn record).
 */
export async function promptMail(ctx, { mailTopics = [], held = [], since = null, discussion = null } = {}) {
  const asked = commsSettings(ctx).enabled ? obligationsCall(ctx, { held: mailTopics, since }) : { result: null };
  let turn = null;
  try { turn = turnCall(ctx, 'open', held, { discussion }); } catch { /* the prompt goes on without the turn record */ }
  const [obligations, first] = await runClientsAsync(ctx, [asked, turn || { result: null }]);
  let opened = { ok: false, skipped: true };
  if (turn) { try { opened = await turnRecorded(ctx, turn, first); } catch (err) { opened = { ok: false, error: err.message }; } }
  return { counted: mailCounted(ctx, obligations), opened };
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
export function registerTopic(ctx, topicId, { holder = undefined, subject, takeover = false, release = false, close = false, project: inProject = null } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, reason: s.reason, topic: topicId, project: s.project, skipped: true };
  const record = ctx.brainDir ? readTopicRecord(ctx.brainDir, topicId) || readTopicRecord(ctx.brainDir, topicId, { closed: true }) || {} : {};
  const topic = subject ? { ...record, subject } : record;
  // Topic `main` of a persona is its main thread `@<persona>/main` in the mail service (P-045).
  const main = isMainTopic({ id: topicId, ...topic });
  // D-0035: a topic that records its project is registered there, else under the session's project (mail model 3).
  const project = inProject || topicProject(s, topic);
  const args = main
    ? ['register-topic', '--persona', s.project, '--main']
    : ['register-topic', '--project', project, '--topic', topicId, '--subject', topic.subject || topicId];
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
  if (!res.ok) return { ok: false, reason: res.error, topic: topicId, project, unavailable: res.unavailable };
  // Mail model 3: a registration on another machine moves the topic (I11); the answer names where it came from.
  return { ok: true, created: !!res.data.created, topic: main ? 'main' : topicId, project: main ? `@${s.project}` : project, holder: h || null, moved: res.data.moved || null, moved_from: res.data.moved_from || null };
}

// The mail part of a close (done --topic) or of a release that the mail did not take (an outage). Nothing named the
// topic again: a closed topic is gone from the brain in layout 3, so the mail kept it open with its holder and took mail
// nobody read, though done said "the next session start retries"; a released topic kept its old holder in the mail and
// the bell went to that thread (audit 2026-11-22). The list is the workflow's own duty, not a copy of the mail's state
// (P-072): an entry goes when the mail answered. One file for all threads of the brain: changed under a lock.
const pendingMailFile = (brainDir) => dataPath(brainDir, 'local', 'mail-pending.json');
const samePending = (a, b) => a.id === b.id && a.project === b.project && a.op === b.op;
function changePendingMail(brainDir, change) {
  try {
    withLock(`${pendingMailFile(brainDir)}.lock`, { waitMs: 3000, staleMs: 30000 }, () => {
      const now = readJson(pendingMailFile(brainDir), []);
      const next = change(Array.isArray(now) ? now : []);
      if (next.length) writeJson(pendingMailFile(brainDir), next);
      else fs.rmSync(pendingMailFile(brainDir), { force: true });
    });
  } catch { /* the step stays undone until the next run that can write */ }
}

/** One mail step of a topic that ends its holder; a step the mail could not take is kept for the next session start. */
function endInMail(ctx, id, op) {
  const res = registerTopic(ctx, id, op === 'close' ? { close: true } : { holder: null, release: true });
  if (!ctx.brainDir || res.ok || res.skipped) return res;
  const entry = { id, project: res.project, op, at: new Date().toISOString() };
  if (res.unavailable) changePendingMail(ctx.brainDir, (list) => (list.some((p) => samePending(p, entry)) ? list : [...list, entry]));
  return res;
}
/** Close topic `id` in the mail (done --topic). */
export const closeTopicInMail = (ctx, id) => endInMail(ctx, id, 'close');
/** The mail stops carrying a holder of topic `id` (release, handoff). */
export const releaseTopicInMail = (ctx, id) => endInMail(ctx, id, 'release');

/** The kept steps, tried again; stops at the first outage. Returns the ids closed now. */
function settlePendingMail(ctx) {
  const list = readJson(pendingMailFile(ctx.brainDir), null);
  if (!Array.isArray(list) || !list.length) return [];
  const settled = [];
  const closed = [];
  for (const p of list) {
    // A topic that is held again: its claim registered the new holder, the old release must not take it away.
    const r = p.op === 'release' && readHolderRecord(ctx.brainDir, p.id).thread ? { ok: true }
      : registerTopic(ctx, p.id, { ...(p.op === 'close' ? { close: true } : { holder: null, release: true }), project: p.project });
    if (r.unavailable) break;
    // Done, or refused by the mail (it does not know the topic any more): the same call would get the same answer.
    settled.push(p);
    if (r.ok && p.op === 'close') closed.push(p.id);
  }
  if (settled.length) changePendingMail(ctx.brainDir, (now) => now.filter((p) => !settled.some((d) => samePending(p, d))));
  return closed;
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
  const out = settlePendingMail(ctx);
  // Layout 1: the folders of topics/archive; layout 2: the topics with state closed (they stay in temy/).
  const closed = listTopicRecords(ctx.brainDir, { closed: true }).map((t) => t.id).filter((id) => id !== MAIN_TOPIC);
  if (!closed.length) return out;
  const recs = new Map(listTopicRecords(ctx.brainDir, { closed: true }).map((t) => [t.id, t]));
  const res = readObligations(ctx, { topics: closed.map((id) => `${topicProject(s, recs.get(id))}/${id}`), thread: null });
  if (!res.ok || res.data?.offline) return out;
  const open = new Set((res.data.topics || []).filter((t) => t.registered && t.state !== 'closed').map((t) => t.topic));
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

/** Mail project of a topic: the project its record names (D-0035), else the session's mail project. */
export function topicProject(s, t) {
  return (t && typeof t.project === 'string' && t.project) || s.project;
}

/**
 * Mail address (mail model 3, agentic-comms docs/MODEL.md): `@<persona>[/main]`, or a topic
 * `[<brain>[@<machine>]:]<project>/<topic>` (brain = id or unique brain name), or `[<project>/]<topic>` (a bare topic is
 * this project and brain). Returns { persona } | { brain, machine, project, topic }, or null.
 */
export function parseAddress(to, defaultProject) {
  const raw = String(to || '').trim();
  // Persona main thread (P-045): `@<persona>/main` or `@<persona>`.
  const p = /^@([a-z0-9][a-z0-9._-]*)(?:\/main)?$/i.exec(raw);
  if (p) return { persona: p[1] };
  const q = /^([a-z0-9][a-z0-9._-]*)(?:@([a-z0-9][a-z0-9._-]*))?:([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9-]*)$/i.exec(raw);
  if (q) return { brain: q[1], machine: q[2] || null, project: q[3], topic: q[4] };
  const m = /^(?:([a-z0-9][a-z0-9._-]*)\/)?([a-z0-9][a-z0-9-]*)$/i.exec(raw);
  if (!m) return null;
  return { brain: null, machine: null, project: m[1] || defaultProject, topic: m[2] };
}

/** The address as text: `@<persona>/main`, `[<brain>[@<machine>]:]<project>/<topic>`. */
export function formatAddress(a) {
  if (!a) return '';
  if (a.persona) return `@${a.persona}/main`;
  return `${a.brain ? `${a.brain}${a.machine ? `@${a.machine}` : ''}:` : ''}${a.project}/${a.topic}`;
}

/** Client options of a send to an address: `--persona`, a brain-qualified `--to`, else `--project --topic`. */
export function addressArgs(a) {
  if (a.persona) return ['--persona', a.persona];
  return a.brain ? ['--to', formatAddress(a)] : ['--project', a.project, '--topic', a.topic];
}

/**
 * Lines of a send the mail resolved (mail model 3): `resolved` (a topic of another brain, step 3 of the resolution), or
 * a 409 `ambiguous` (the topic is open in several brains; nothing was written) with the exact addresses to send again.
 */
export function resolvedNote(data) {
  return data?.resolved ? ` (resolved: ${data.resolved})` : '';
}
export function ambiguousLine(res) {
  const d = res?.data?.details || res?.data || {};
  const list = Array.isArray(d.ambiguous) ? d.ambiguous : null;
  if (!list?.length) return null;
  const forms = list.map((e) => {
    // `<brain_name> (<brain>)@<machine>`: the id is unique, the machine names one record.
    // An older topic without a brain (`- (-)@…`) has no address of its own: the operator decides it (notice legacy-topic).
    const m = /^(.*?)\s*\(([^)]+)\)@(.+)$/.exec(String(e));
    if (!m || m[2] === '-') return null;
    return `--to ${m[2]}${m[3] && m[3] !== '?' ? `@${m[3]}` : ''}:${d.project}/${d.topic}`;
  }).filter(Boolean);
  return `topic ${d.project}/${d.topic} is open in ${list.length} brains (${list.join(', ')}); nothing sent; send again with one of: ${forms.join(', ') || '(none has a brain: ask the operator)'}`;
}
