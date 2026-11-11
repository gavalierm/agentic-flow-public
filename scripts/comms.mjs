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
import { readJson } from './util.mjs';
import { machineName, servicesDir } from './config.mjs';
import { PERSONA_REPO_RE, PERSONA_PREFIX } from './persona-name.mjs';

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
export const LEVELS = ['blocker', 'steer', 'assist'];
/** Mechanical categories of the prompt line (P-044, operator 2026-11-02): a reply (reply_to or thread-addressed), else the level.
 * An interim reply names its state after the category: `reply otázka`, `reply čakám` (P-061). */
export const INTERIM_REPLY_STATES = ['otázka', 'čakám'];
export const CATEGORIES = ['reply', ...LEVELS];
/** Client subcommands a subagent may run (read only, P-025). The triage subagent is removed (2026-11-02). */
export const SUBAGENT_ALLOWED = ['receive', 'list', 'count'];

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
  const configFile = cfg.config
    ? path.resolve(projectDir, cfg.config)
    : ctx.brainDir ? path.join(ctx.brainDir, 'local', 'comms.json') : null;
  const out = {
    enabled: fs.existsSync(client),
    configured: explicit || raw !== undefined,
    client,
    clientRel,
    instance: cfg.instance || null,
    configFile: configFile && fs.existsSync(configFile) ? configFile : null,
    project: cfg.project || mailProjectName(ctx),
    outbox: ctx.brainDir ? path.join(ctx.brainDir, 'local', 'outbox') : null,
    clientDir: ctx.brainDir ? path.join(ctx.brainDir, 'local', 'comms') : null,
    waitMs: ctx.policy?.comms?.hook_wait_ms ?? 2000,
  };
  if (!out.enabled) out.reason = explicit ? `comms client not found at ${clientRel}` : 'comms not configured';
  return out;
}

export function commsConfigured(ctx) {
  return commsSettings(ctx).enabled;
}

/**
 * Run the comms client once. Returns { ok, code, data, error, unavailable }.
 * Exit codes of the client: 0 ok, 1 rejected/usage, 2 comms unavailable, 3 other instance.
 */
export function runClient(ctx, args, { timeoutMs, input } = {}) {
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, code: null, data: null, error: s.reason, unavailable: false, disabled: true };
  const wait = timeoutMs ?? s.waitMs;
  const common = ['--timeout', String(wait)];
  if (s.configFile) common.push('--config', s.configFile);
  if (s.instance) common.push('--instance', s.instance);
  if (s.outbox) common.push('--outbox', s.outbox, '--client-dir', s.clientDir);
  if (ctx.thread) common.push('--thread', ctx.thread);
  const res = spawnSync(process.execPath, [s.client, ...args, ...common], {
    cwd: ctx.projectDir,
    encoding: 'utf8',
    input,
    timeout: wait + 1500,
    env: { ...process.env, COMMS_THREAD_ID: ctx.thread || '' },
  });
  const parse = (t) => { try { return JSON.parse(String(t || '').trim()); } catch { return null; } };
  if (res.error || res.status === null) {
    return { ok: false, code: 2, data: null, error: 'comms unavailable (client timed out)', unavailable: true };
  }
  if (res.status === 0) return { ok: true, code: 0, data: parse(res.stdout) ?? {}, error: null, unavailable: false };
  const err = parse(res.stderr);
  const message = err?.error || (res.stderr || res.stdout || '').trim().split('\n')[0] || `comms client exit ${res.status}`;
  return { ok: false, code: res.status, data: err, error: res.status === 2 ? 'comms unavailable' : message, unavailable: res.status === 2 };
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
 * Waiting messages (status line P-023 e, prompt hooks). Comms listing items (`count.items`: id, level, reply_to, to_thread,
 * sender, created_at) give the mechanical category of each message; a server without items only gives a total.
 * The client asks the service live (comms 0.3.11+; older clients cache 60 s); after an outage it retries no sooner than
 * 60 s (P-041); `first_report` marks the first failure of a window. Counting never picks a message up (P-042).
 * Returns { count, blockers, steers, items, available, unknown, note, configured }.
 */
export function mailCount(ctx, held = []) {
  const s = commsSettings(ctx);
  const out = { count: 0, blockers: 0, steers: 0, items: [], available: false, unknown: false, note: null, configured: s.enabled };
  if (!s.enabled) {
    if (s.configured && s.clientRel) out.note = s.reason; // explicit client path that does not exist: configuration error
    return out;
  }
  const queries = mailQueries(ctx, held);
  // Nothing to ask for (no thread, no held topic): the mail is not checked, so it is unknown, never `0` as checked.
  if (!queries.length) { out.unknown = true; out.note = 'no thread or held topic: not checked'; return out; }
  const ids = new Set();
  const add = (d) => {
    if (Array.isArray(d.items)) {
      for (const it of d.items) {
        if (ids.has(it.id)) continue;
        ids.add(it.id);
        out.items.push(it);
        out.count += 1;
        if (it.level === 'blocker') out.blockers += 1;
        if (it.level === 'steer') out.steers += 1;
      }
    } else {
      out.count += d.total || 0;
      out.blockers += d.blocker || 0;
    }
  };
  const started = Date.now();
  let seen = false;
  for (const q of queries) {
    if (Date.now() - started > s.waitMs) { out.unknown = true; break; }
    const res = runClient(ctx, ['count', ...queryArgs(q)]);
    if (res.ok) {
      const d = res.data;
      // comms >= 0.4.6: whether this machine's wake runs (absent when wake never ran here, comms-public#4).
      if (d.wake && out.wake === undefined) out.wake = d.wake;
      if (d.unavailable) {
        if (d.first_report) out.note = 'comms unavailable';
        if (d.total == null) out.unknown = true; else add(d);
      } else {
        seen = true;
        add(d);
      }
    } else {
      out.unknown = true;
      out.note = res.error;
      if (res.disabled) break;
    }
  }
  out.available = seen;
  return out;
}

export function formatMail(mail) {
  let s = `mail: ${mail.unknown && !mail.count ? '?' : mail.count}`;
  if (mail.blockers) s += ` (${mail.blockers} blocker)`;
  if (mail.steers) s += ` (${mail.steers} steer)`;
  if (mail.note) s += ` (${mail.note})`;
  if (mail.wake && mail.wake.running === false) s += ' | wake: off';
  return s;
}

/** Mechanical lines of waiting mail for the prompt: `<id> <category>`, never a body (P-044). */
export function mailLines(items = []) {
  return items.map((it) => `${it.id} ${categoryLabel(it)}`);
}

/**
 * One prompt line with the waiting mail (2026-11-02: the triage subagent is removed, the main agent reads the ids itself):
 * `mail: <n> waiting: <id> <category>, ...` (at most `max` ids). Empty when nothing waits; without listing items only the count.
 */
export function mailNoticeLine(mail, max = 10) {
  if (!mail || !mail.count) return '';
  const lines = mailLines(mail.items || []);
  if (!lines.length) return `mail: ${mail.count} waiting`;
  const shown = lines.slice(0, max);
  const more = lines.length > max ? ` (+${lines.length - max} more)` : '';
  return `mail: ${mail.count} waiting: ${shown.join(', ')}${more}`;
}

/**
 * Turn record for keepalive (P-043): `open` at the prompt, `closed` at Stop. The thread travels as `--thread` (runClient);
 * machine and holder mode come from holder.json of the first held topic (as registerTopic), else this machine.
 * `open` answers `turn.opened_at` (kept in the thread state as `turn_opened_at`); `closed` sends it back as `--opened-at`
 * so the service ignores a Stop of an older turn (`stale: true`). The client queues a `closed` in its outbox during an
 * outage (`queued: true`); `open` is never queued. An older client without `--opened-at` (usage error) gets the call again
 * without it. Never throws.
 */
export function recordTurn(ctx, state, held = [], { openedAt = null, next = null, resumeAt = null } = {}) {
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
    const withOpened = state === 'closed' && openedAt ? [...args, '--opened-at', String(openedAt)] : args;
    let res = runClient(ctx, withOpened, { timeoutMs });
    if (!res.ok && res.code === 1 && withOpened !== args && /opened-at/.test(String(res.error || ''))) res = runClient(ctx, args, { timeoutMs });
    // An older mail client without --resume-at: the step still goes (rung after the usual delay).
    if (!res.ok && res.code === 1 && resumeAt && /resume-at/.test(String(res.error || ''))) res = runClient(ctx, withOpened.filter((a, i, all) => a !== '--resume-at' && all[i - 1] !== '--resume-at'), { timeoutMs });
    if (res.ok && res.data && res.data.ok === false) return { ok: false, ...res.data };
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
  const topic = subject ? { subject } : (ctx.brainDir ? readJson(path.join(ctx.brainDir, 'topics', topicId, 'topic.json'), null) || readJson(path.join(ctx.brainDir, 'topics', 'archive', topicId, 'topic.json'), {}) : {});
  // Topic `main` of a persona is its main thread `@<persona>/main` in the mail service (P-045).
  const main = isMainTopic({ id: topicId, ...topic });
  const args = main
    ? ['register-topic', '--persona', s.project, '--main']
    : ['register-topic', '--project', s.project, '--topic', topicId, '--subject', topic.subject || topicId];
  const hj = ctx.brainDir ? readJson(path.join(ctx.brainDir, 'topics', topicId, 'holder.json'), {}) || {} : {};
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
 * Archived topics (topics/archive/<id>) not yet closed in the mail service are closed there (once; done ids in
 * local/comms-closed.json). Topics archived before the mail knew `close` kept their holder and took mail nobody read
 * (alice 2026-11-02). Returns the ids closed now; skipped during an outage.
 */
export function closeArchivedTopics(ctx) {
  const s = commsSettings(ctx);
  if (!s.enabled || !ctx.brainDir) return [];
  const dir = path.join(ctx.brainDir, 'topics', 'archive');
  if (!fs.existsSync(dir)) return [];
  const file = path.join(ctx.brainDir, 'local', 'comms-closed.json');
  const done = new Set(readJson(file, []) || []);
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    if (done.has(id) || !fs.existsSync(path.join(dir, id, 'topic.json'))) continue;
    const r = registerTopic(ctx, id, { close: true });
    if (r.ok || /nie je registrovaná|404/.test(String(r.reason || ''))) { done.add(id); out.push(id); }
    else if (r.unavailable) break;
  }
  if (out.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify([...done].sort(), null, 2) + '\n'); }
  return out;
}

/** Topic `main` (kind `main`): the persona's main thread, permanent, outside the topic limit (P-045, P-050). */
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
