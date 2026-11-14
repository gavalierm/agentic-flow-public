// Topics: create, claim, release, list (P-036, P-037, P-045, P-047).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { git, readJson, nowIso, relPosix, toPosix } from './util.mjs';
import { isWakeTurn, machineName, sameMachine, inSubagent, inHarness, readThreadState, writeThreadState, mainCheckout, WORKTREES_DIR } from './config.mjs';
import { brainWrite, brainSync, readHolder, currentBranch, withBrainLock, isHolderOf } from './brain.mjs';
import { freeHandover, renderHandover, checkHandover } from './brain-checks.mjs';
import { pendingBuffers, flushBuffer } from './logs.mjs';
import { readTopics } from './records.mjs';
import { isValidId } from './keys.mjs';
import { registerTopic, mailCount, mailLines, isMainTopic, MAIN_TOPIC, runClient, commsConfigured, commsProjectName } from './comms.mjs';

export function topicDir(brainDir, id) {
  return path.join(brainDir, 'topics', id);
}

export function topicExists(brainDir, id) {
  return fs.existsSync(path.join(topicDir(brainDir, id), 'topic.json'));
}

export function readTopic(brainDir, id) {
  return readJson(path.join(topicDir(brainDir, id), 'topic.json'), null);
}

/** The topic was created by this thread (its own test or mistake to clean up, P-018). */
export function ownTopic(ctx, id) {
  return !!ctx.thread && readTopic(ctx.brainDir, id)?.created_by === ctx.thread;
}

/**
 * P-064: the orchestrator of a topic another thread created for a new thread: the creating thread and the topic it held
 * (in its own project, `origin`). A thread that takes its own new topic has none: it talks to the operator itself.
 */
export function orchestratorFor(ctx, origin = ctx, { holderThread = null } = {}) {
  if (!ctx.thread || holderThread === ctx.thread) return null;
  const held = origin?.brainDir ? heldTopics(origin.brainDir, ctx.thread) : [];
  if (!held.length) return null;
  // The mail name, not the folder: a persona repo agent-alice is mail project alice, and agent-alice/<topic> reached nobody
  // (topic-project-move, D-0035: a code topic created with --project for agentic-flow by a alice thread).
  const from = commsProjectName(origin);
  const project = from && from !== commsProjectName(ctx) ? from : null;
  return { topic: held[0].id, thread: ctx.thread, ...(project ? { project } : {}) };
}

/**
 * Mail project of a topic created with --project in another project of the same brain (D-0035): it is registered in the
 * mail service under that project, so a bare `comms send --to <topic>` from the creating project addresses it there.
 * With `thread`: a bare address that names the orchestrator topic of a topic this thread holds goes to the orchestrator's
 * project (P-064); not the sender's project, because a topic thread in another project sent its question to the
 * unregistered `<project>/workflow-dev` and the mail held it (report-785024c3).
 */
export function topicMailProject(brainDir, id, thread = null) {
  if (thread) {
    for (const t of heldTopics(brainDir, thread)) {
      const o = t?.orchestrator && typeof t.orchestrator === 'object' ? t.orchestrator : null;
      if (o?.topic === id && typeof o.project === 'string' && o.project) return o.project;
    }
  }
  const p = readTopic(brainDir, id)?.project;
  return typeof p === 'string' && p ? p : null;
}

/**
 * P-064: the orchestrator a topic thread asks instead of the operator: `topic.orchestrator` (recorded at create), else the
 * creating thread (`created_by`, a topic from before the record) and the topic it holds now, else its persona main thread.
 * Null when this thread created the topic itself, or code created it (no thread). `to` is the mail address.
 */
export function topicOrchestrator(brainDir, topic, thread) {
  if (!topic || isMainTopic(topic)) return null;
  const o = topic.orchestrator && typeof topic.orchestrator === 'object' ? topic.orchestrator : null;
  const by = o?.thread || topic.created_by || null;
  // An automatic topic (report intake, issue watch: code without a thread, policy topics.auto, D-0035) records only the
  // orchestrator topic: its thread asks that topic, whoever holds it.
  if (by ? by === thread : !o?.topic) return null;
  let id = o?.topic || null;
  if (!id) { try { id = heldTopics(brainDir, by)[0]?.id || null; } catch { id = null; } }
  // A closed orchestrator topic (same brain) has no address: the main thread triages the mail.
  if (id && !o?.project && !topicExists(brainDir, id)) id = null;
  id = id || MAIN_TOPIC;
  return { topic: id, thread: by, project: o?.project || null, to: orchestratorAddress({ topic: id, project: o?.project }) };
}

/** P-064: the orchestrator of the work topic this thread holds, or null. */
export function threadOrchestrator(brainDir, thread) {
  if (!brainDir || !thread) return null;
  let held = [];
  try { held = heldTopics(brainDir, thread).filter((t) => !isMainTopic(t)); } catch { held = []; }
  for (const t of held) { const o = topicOrchestrator(brainDir, t, thread); if (o) return { ...o, of: t.id }; }
  return null;
}

/** P-064: why a question to the operator is refused in a topic thread with an orchestrator, and what to do instead. */
export const ORCHESTRATOR_QUESTION_REASON = (o) => `topic ${o.of} was created by another thread (its orchestrator, topic ${o.to}): the operator does not follow topic threads, so this thread never asks them (no AskUserQuestion, no **Otázky na operátora:**, no "**Stav:** otázka"). Send the question by mail to the orchestrator: comms send --to ${o.to} --level blocker (the work cannot go on without it) or assist, with the options and your recommendation; then go on with the recommended assumption and end the turn with "**Stav:** čakám (na odpoveď orchestrátora)". The orchestrator decides itself or asks the operator in its own thread and replies by mail (P-064)`;

// P-064 (orchestrator 2026-11-13, option A): a step a hook leaves to the operator's confirmation (ask, P-018) waited in the
// topic thread the operator does not follow. There it is refused; the orchestrator grants the exact call with
// `topic.mjs consent`, recorded in topics/<id>/consents.json, and the same call then passes once.

/** The target a consent names: the exact command of a shell call, else the path the tool writes. */
export function consentTarget(tool, toolInput = {}) {
  if (tool === 'Bash' || tool === 'PowerShell') return String(toolInput.command || '').trim();
  return String(toolInput.file_path || toolInput.notebook_path || toolInput.path || '').trim();
}

export const consentsPath = (brainDir, id) => path.join(topicDir(brainDir, id), 'consents.json');
export const readConsents = (brainDir, id) => { const c = readJson(consentsPath(brainDir, id), []); return Array.isArray(c) ? c : []; };

/** The consent of the orchestrator for this exact call that this thread has not used yet, or null. */
export function findConsent(brainDir, id, tool, toolInput, used = []) {
  const target = consentTarget(tool, toolInput);
  if (!target) return null;
  return readConsents(brainDir, id).find((c) => c && c.tool === tool && c.target === target && !used.includes(c.id)) || null;
}

/**
 * The orchestrator grants one exact call of the thread of topic `id` (P-064): only the thread the topic names as its
 * orchestrator, or the thread that now holds the orchestrator topic (`origin`: its own project). Within its authority
 * (its own test, its own mistake) it grants itself; otherwise only after the operator said yes in its own thread.
 */
export function grantConsent(ctx, id, { tool, target, reason = null, origin = ctx } = {}) {
  if (inSubagent()) throw new Error('topic consent refused in subagent (P-025)');
  if (!ctx.thread) throw new Error('topic consent needs a stable thread id (P-038)');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist (archived or never created)`);
  if (!tool || !String(tool).trim()) throw new Error('topic consent needs --tool <Bash|Write|Edit|…>');
  const t = String(target || '').trim();
  if (!t) throw new Error('topic consent needs --target "<the exact command or path>" (or --target-file <file>)');
  const holder = readHolder(ctx.brainDir, id);
  const o = topicOrchestrator(ctx.brainDir, topic, holder.thread || null);
  if (!o) throw new Error(`topic ${id} has no orchestrator: its thread asks the operator itself (P-064)`);
  let holds = false;
  try { holds = heldTopics((origin || ctx).brainDir, ctx.thread).some((h) => h.id === o.topic); } catch { holds = false; }
  if (o.thread !== ctx.thread && !holds) throw new Error(`only the orchestrator of topic ${id} (topic ${o.to}, thread ${o.thread}) grants its steps (P-064)`);
  const consent = { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, tool: String(tool).trim(), target: t, by: ctx.thread, at: nowIso(), ...(reason ? { reason: String(reason).trim() } : {}) };
  const list = [...readConsents(ctx.brainDir, id), consent].slice(-50);
  const res = brainWrite(ctx, { internal: true, ops: [{ path: `topics/${id}/consents.json`, content: JSON.stringify(list, null, 2) + '\n' }], message: `topic consent ${id}: ${consent.tool} (by ${ctx.thread})` });
  return { consent, write: res };
}

export const ORCHESTRATOR_CONSENT_REASON = (o, why, tool) => `this step needs a confirmation (${String(why || '').replace(/\s+/g, ' ').slice(0, 220)}), and the thread of topic ${o.of} never asks the operator: its orchestrator (topic ${o.to}) grants it. Send a blocker: comms send --to ${o.to} --level blocker with the tool (${tool}), the exact command or path verbatim, the reason and your recommendation; the orchestrator grants it with topic.mjs consent ${o.of} --tool ${tool} --target-file <file with the exact call> (or asks the operator first) and replies. Meanwhile go on with work that does not need it; after the reply run the same call again, unchanged: it then passes once (P-064)`;

/** Mail address of a recorded orchestrator: `[<project>/]<topic>`. */
export const orchestratorAddress = (o) => (o?.project ? `${o.project}/${o.topic}` : String(o?.topic || MAIN_TOPIC));

/**
 * Where a code topic works. In a domain (v3, D-0002): a git worktree `<domain>/.worktrees/<repo>/<topic>/` of the
 * project's main checkout, inside the write boundary and sharing the repo's objects. Without a domain (not migrated
 * yet): the legacy clone `../<project>-topics/<topic>/`.
 */
export function codeCopyPath(ctx, id) {
  if (ctx.domain) return path.join(ctx.domain.root, WORKTREES_DIR, path.basename(mainCheckout(ctx.projectDir)), id);
  return path.resolve(ctx.projectDir, '..', `${ctx.projectName}-topics`, id);
}

// codeStart: the action starts a new thread that holds the topic. Code without a thread id (cron, e.g. issues/watch.sh of a
// persona, D-0019) may do that: it holds nothing and no message started it. An agent session still needs its id (P-038).
function guardThread(ctx, action, { allowWake = false, codeStart = false } = {}) {
  if (inSubagent()) throw new Error(`topic ${action} refused in subagent (P-025)`);
  if (!ctx.thread && codeStart && !inHarness()) return;
  if (!ctx.thread) throw new Error(`topic ${action} needs a stable thread id: start the harness via thread.mjs or in T3 (WORKFLOW_THREAD_ID / T3CODE_THREAD_ID, P-038)`);
  if (!allowWake && isWakeTurn(ctx.brainDir, ctx.thread)) throw new Error(`topic ${action} refused: this turn was started by a message, not by the operator (P-047)`);
}

function idleHours(since) {
  const t = Date.parse(since || '');
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 36e5);
}

export function heldBy(holder) {
  const idle = idleHours(holder.since);
  return `held by thread ${holder.thread}${holder.machine ? ` on ${holder.machine}` : ''}${idle !== null ? ` (since ${holder.since}, idle ${idle}h)` : ''}`;
}

const staleHours = (ctx) => ctx.policy?.topics?.stale_machine_hours ?? 12;

/** Hours without activity (claim or a commit in topics/<id>/) of a holder on another machine, when over the limit; else null. */
export function staleOnOtherMachine(ctx, id, holder) {
  if (!holder?.thread || !holder.machine || sameMachine(holder.machine)) return null;
  const claimed = Date.parse(holder.since || '') || 0;
  const commit = Number(git(['log', '-1', '--format=%ct', '--', `topics/${id}`], { cwd: ctx.brainDir }).stdout || 0) * 1000;
  const last = Math.max(claimed, commit);
  if (!last) return null;
  const idle = Math.floor((Date.now() - last) / 36e5);
  return idle >= staleHours(ctx) ? idle : null;
}

/**
 * Hand a topic over to another machine (P-040, P-026): flush this machine's log buffers, send its mail outbox, save the
 * handover, release with a handoff record, push. The other machine then claims it without --force (claim pulls first).
 * Refused when the outbox cannot be sent (the messages would stay on this machine) unless leaveOutbox, and reported
 * when the push fails (the other machine would not see the release).
 */
export function handoffTopic(ctx, id, opts = {}) {
  return withBrainLock(ctx.brainDir, () => handoffTopicUnlocked(ctx, id, opts));
}

function handoffTopicUnlocked(ctx, id, { handover = null, leaveOutbox = false } = {}) {
  guardThread(ctx, 'handoff');
  const first = brainSync(ctx.brainDir);
  if (first.conflict) throw new Error(`brain has a disagreement: ${first.conflict.join(', ')}; resolve before the handoff (P-040)`);
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist (archived or never created)`);
  if (isMainTopic(topic)) throw new Error('topic main is the persona main thread: it is not handed off; on the other machine start the main thread there (topic.mjs main, P-045)');
  const holder = readHolder(ctx.brainDir, id);
  if (!isHolderOf(holder, ctx.thread)) throw new Error(`topic ${id} ${holder.thread ? heldBy(holder) : 'has no holder'}; only its holder on this machine hands it off (P-037)`);
  const steps = [];
  for (const file of pendingBuffers(ctx.brainDir)) {
    const session = path.basename(file, '.jsonl');
    const r = flushBuffer(ctx, session);
    if (r.written) steps.push(`logs of session ${session} flushed`);
  }
  const outbox = path.join(ctx.brainDir, 'local', 'outbox');
  const waiting = () => { try { return fs.readdirSync(outbox).filter((f) => !f.startsWith('.')).length; } catch { return 0; } };
  if (waiting() && commsConfigured(ctx)) runClient(ctx, ['count']);
  const left = waiting();
  if (left && !leaveOutbox) return { ok: false, reason: `${left} message(s) in this machine's mail outbox could not be sent (mail unavailable): hand off when mail is up, or with --leave-outbox they are sent from this machine later` };
  if (left) steps.push(`${left} message(s) left in this machine's outbox`);
  const ops = [];
  if (handover) {
    const content = renderHandover(handover);
    const errors = checkHandover(content, ctx.policy.limits.handover_lines);
    if (errors.length) throw new Error(errors.join('\n'));
    ops.push({ path: `topics/${id}/handover.md`, content });
  } else {
    let current = '';
    try { current = fs.readFileSync(path.join(topicDir(ctx.brainDir, id), 'handover.md'), 'utf8'); } catch { /* none */ }
    if (!current.trim() || current.trim() === freeHandover().trim()) throw new Error(`topic ${id} has no handover: give --task, --done and --next, the other machine continues from it (P-026)`);
  }
  const record = { handoff_from: { thread: ctx.thread, machine: machineName(), at: nowIso() } };
  ops.push({ path: `topics/${id}/holder.json`, content: JSON.stringify(record, null, 2) + '\n' });
  const res = brainWrite(ctx, { internal: true, ops, message: `topic handoff ${id} by ${ctx.thread} from ${machineName()}` });
  const comms = registerTopic(ctx, id, { holder: null, release: true });
  const sync = res.sync || {};
  if (!sync.pushed && sync.error !== 'no remote origin') {
    return { ok: false, steps, comms, reason: `handoff of ${id} committed but not pushed (${sync.conflict ? `conflict: ${sync.conflict.join(', ')}` : sync.error}): the other machine does not see it yet; fix the push (brain.mjs sync) (P-040)` };
  }
  return { ok: true, steps, comms, pushed: !!sync.pushed, notices: res.warnings };
}

export function createTopic(ctx, opts = {}) {
  return withBrainLock(ctx.brainDir, () => createTopicUnlocked(ctx, opts));
}

/** The project is a persona: its repository is its brain (P-025). */
export function isPersonaProject(ctx) {
  try { return !!ctx.brainDir && fs.realpathSync(ctx.projectDir) === fs.realpathSync(ctx.brainDir); } catch { return false; }
}

/**
 * Topic classes (D-0020, D-0021): what the topic is for decides its kind (a code copy or not) and the model of its thread.
 * The four classes and when to pick each are fixed here; kind, thread (provider, model, effort) and subagent_model come
 * from policy topics.classes, which a brain policy.json overrides key by key (deepMerge in loadPolicy).
 */
export const TOPIC_CLASSES = {
  web: { kind: 'code', when: 'website and content (pages, texts, images)' },
  code: { kind: 'code', when: 'code and workflow development with a release' },
  ops: { kind: 'discussion', when: 'operations and deployment: server, DNS, cron' },
  discussion: { kind: 'discussion', when: 'discussion and design with the operator' },
};

export const CLASS_HELP = `--class web|code|ops|discussion is required (D-0021): ${Object.entries(TOPIC_CLASSES).map(([c, v]) => `${c} = ${v.when} (kind ${v.kind})`).join('; ')}. Research is not a class: a worker (subagent) does it`;

/** Settings of a class: kind (policy, else built in), thread {provider, model, effort}, subagent_model; null for an unknown class. */
export function topicClass(ctx, cls) {
  if (!cls || !Object.hasOwn(TOPIC_CLASSES, cls)) return null;
  const p = ctx?.policy?.topics?.classes?.[cls] || {};
  const t = p.thread && typeof p.thread === 'object' ? p.thread : {};
  return {
    class: cls,
    kind: ['code', 'discussion'].includes(p.kind) ? p.kind : TOPIC_CLASSES[cls].kind,
    thread: { provider: t.provider || null, model: t.model || null, effort: t.effort || null },
    subagent_model: p.subagent_model ?? null,
  };
}

/** Class of a new topic (--class required); --kind alone is refused, --kind that disagrees with the class too. */
export function resolveClass(ctx, cls, kind = null) {
  if (!cls || cls === true) throw new Error(kind ? `--kind alone is not enough, the class decides the kind: ${CLASS_HELP}` : `topic create needs a class: ${CLASS_HELP}`);
  const c = topicClass(ctx, String(cls));
  if (!c) throw new Error(`unknown class "${cls}": ${CLASS_HELP}`);
  if (kind && kind !== c.kind) throw new Error(`--kind ${kind} contradicts --class ${cls} (kind ${c.kind}): leave out --kind, the class decides it`);
  return c;
}

function createTopicUnlocked(ctx, { id, subject, class: cls = null, kind: askedKind = null, mode, claim = true, copy = true, forThread = null, newThread = false, task = null, explicitProject = false, origin = ctx, orchestrator = null, run = spawnSync }) {
  if (!isValidId(id)) throw new Error(`topic id "${id}" must be lowercase letters, digits and hyphens (P-036)`);
  if (id === MAIN_TOPIC) throw new Error('topic id "main" is reserved for the persona main thread: use topic.mjs main (P-045)');
  if (!subject || !String(subject).trim()) throw new Error('topic needs --subject "<one sentence>" (P-045)');
  const { kind } = resolveClass(ctx, cls, askedKind);
  // A persona has no project code (P-025): a code topic from its session without --project went to the persona repo
  // instead of the managed project (bob 2026-11-03, t3-workarounds-check in bob, not the managed project).
  if (kind === 'code' && !explicitProject && isPersonaProject(ctx)) throw new Error(`code topic ${id} would be created in persona project ${path.basename(ctx.projectDir)}: a persona has no project code (P-025). Pass --project <managed project dir> (or --project ${ctx.projectDir} if the persona repo itself is the code)`);
  guardThread(ctx, 'create', { codeStart: newThread && !forThread });
  if (topicExists(ctx.brainDir, id) || fs.existsSync(path.join(ctx.brainDir, 'topics', 'archive', id))) throw new Error(`topic ${id} already exists`);
  const topic = { id, subject: String(subject).trim(), class: String(cls), kind, state: 'working', created: nowIso() };
  // The creating thread may clean up its own topic (test, mistake) without operator approval (P-018).
  if (ctx.thread) topic.created_by = ctx.thread;
  if (kind === 'code') {
    // Only a copy that is made is recorded: the intake (copy: false) recorded a path its thread then named as
    // `Kópia kódu`, a folder that never existed (report-228e044c).
    if (copy) topic.copy = relPosix(ctx.projectDir, codeCopyPath(ctx, id));
    topic.repo = path.basename(mainCheckout(ctx.projectDir)); // the repo the topic changes (v3: one domain, several repos)
  }
  // D-0035: a topic of another project (--project) is registered in the mail service under that project's mail name.
  if (explicitProject) {
    const mp = commsProjectName(ctx);
    if (mp && mp !== commsProjectName(origin || ctx)) topic.project = mp;
  }
  // This thread claims its own new topic: the holder goes into the create commit, one sync cycle instead of two
  // (49 extra `topic claim` commits, median 11.1 s against ~6 s).
  const claimNow = claim && !forThread && !newThread;
  // P-064: a topic for another thread records its orchestrator (this thread and its topic); that thread asks it, not the operator.
  // An automatic topic (policy topics.auto, D-0035) gets the orchestrator of the policy: code has no thread to name.
  if (!claimNow && orchestrator?.topic) topic.orchestrator = orchestrator;
  if (!claimNow && !topic.orchestrator) {
    const o = orchestratorFor(ctx, origin || ctx, { holderThread: forThread ? String(forThread) : null });
    if (o) topic.orchestrator = o;
  }
  const holder = claimNow ? { thread: ctx.thread, machine: machineName(), mode: mode || ctx.policy?.topics?.default_holder_mode || 'operator', since: nowIso() } : null;
  const res = brainWrite(ctx, {
    internal: true,
    ops: [
      { path: `topics/${id}/topic.json`, content: JSON.stringify(topic, null, 2) + '\n' },
      { path: `topics/${id}/holder.json`, content: holder ? JSON.stringify(holder, null, 2) + '\n' : '{}\n' },
      { path: `topics/${id}/handover.md`, content: freeHandover() },
    ],
    message: `topic create ${id}${holder ? ` (claimed by ${ctx.thread})` : ''}`,
  });
  const out = { topic, write: res, claim: null, copy: null, thread: null, effortNote: null };
  let model = null;
  if (newThread && !forThread) {
    // P-036: a new topic gets its own T3 thread titled by the topic; its first message shows what the topic holds, so the
    // operator does not have to prompt it (alice 2026-11-02). Failure keeps the topic free and says why.
    // The code copy first: the thread's first message names it and the thread may look before the assignment below.
    if (kind === 'code' && copy) out.copy = ensureCodeCopy(ctx, id);
    const started = startTopicThread(ctx, topic, run, { task });
    if (!started.ok) { out.claim = { ok: false, reason: `topic ${id} created, but no thread was started (${started.reason}); ${started.fallback}; or claim it here with topic.mjs claim ${id}` }; return out; }
    out.thread = started.thread;
    out.effortNote = started.effortNote;
    model = started.model;
    forThread = started.thread;
  }
  if (forThread) {
    // Topic for a new thread (P-037): the new thread holds it from its first turn, so its status block shows the topic
    // instead of `Téma: žiadna` (Bob 2026-11-01: topic beszel created for a new thread that then asked for a topic).
    out.claim = assignTopic(ctx, id, String(forThread), { mode, model });
    if (kind === 'code' && copy && !out.copy) out.copy = ensureCodeCopy(ctx, id);
    return out;
  }
  if (claimNow) {
    const sync = res.sync || {};
    if (sync.conflict || (sync.error && sync.remoteAhead)) {
      out.claim = { ok: false, reason: `topic ${id} created locally but not pushed (${sync.conflict ? `conflict: ${sync.conflict.join(', ')}` : sync.error}); resolve, then topic.mjs claim ${id} (P-040)` };
      return out;
    }
    // Mail registration only after a successful push, as in claim.
    const pushFailed = sync.error && sync.error !== 'no remote origin';
    const comms = pushFailed ? { ok: false, reason: 'brain push failed: mail registration not done (repeat topic.mjs claim to register)', topic: id, skipped: false } : registerTopic(ctx, id);
    out.claim = { ok: true, holder, pushed: !!sync.pushed, sha: res.sha, comms, ...(pushFailed ? { warning: `claim committed but not pushed (${sync.error})` } : {}) };
    if (kind === 'code' && copy) out.copy = ensureCodeCopy(ctx, id);
  }
  return out;
}

/** First message of a topic's own thread: what the topic holds and what to do (P-036). */
// With a task the operator already gave the work, so the thread does it now instead of waiting for a prompt (operator
// 2026-11-02: topic agent-playbook was created for a clear task and its thread stopped asking for an instruction).
export function topicThreadMessage(topic, { task = null } = {}) {
  const t = task && String(task).trim();
  return [
    // The class (D-0021) next to the kind; a topic from before the classes has none.
    `Téma ${topic.id} (${topic.kind})${topic.class ? `, trieda ${topic.class},` : ''} je pridelená tomuto vláknu.`,
    `Predmet: ${topic.subject}`,
    ...(topic.copy ? [`Kópia kódu: ${topic.copy}`] : []),
    // P-064: the operator does not follow topic threads; questions go to the thread that created the topic.
    ...(topic.orchestrator?.topic ? [`Orchestrátor: ${orchestratorAddress(topic.orchestrator)}. Operátora sa nepýtaj (AskUserQuestion ani Otázky na operátora): otázku pošli poštou orchestrátorovi (comms send --to ${orchestratorAddress(topic.orchestrator)}, blocker alebo assist, možnosti a odporúčanie) a pokračuj odporúčaným predpokladom.`] : []),
    '',
    ...(t
      ? ['Zadanie operátora:', t, '', 'Zadanie vykonaj hneď; na ďalší pokyn nečakaj a nepýtaj sa, či začať.']
      : ['Vypíš operátorovi stručne, čo téma obsahuje (predmet, handover), a počkaj na jeho pokyn.']),
  ].join('\n');
}

/**
 * Command to spawn on this platform. Windows: spawnSync finds only `<name>.exe` by itself, an npm shim `t3.cmd` gives
 * ENOENT (Windows instance 2026-11-07, agentic-flow-public#10): the name is resolved over PATH and PATHEXT, a .cmd/.bat runs
 * through the shell with quoted arguments.
 */
export function spawnTarget(name, args, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32' || /[\\/]/.test(name) && path.extname(name)) return { file: name, args, shell: false };
  const exts = path.extname(name) ? [''] : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = /[\\/]/.test(name) ? [''] : String(env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = dir ? path.win32.join(dir, name + ext) : name + ext;
      if (!exists(full)) continue;
      if (!/\.(cmd|bat)$/i.test(full)) return { file: full, args, shell: false };
      const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
      return { file: [full, ...args].map(q).join(' '), args: [], shell: true };
    }
  }
  return { file: name, args, shell: false };
}

/** Where the first message of a topic's thread is kept when the CLI could not start it (fallback t3_thread_launch). */
export function threadMessageFile(ctx, id) {
  return path.join(ctx.projectDir, 'scratch', `topic-${id}-thread.md`);
}

/**
 * Model of the thread of a topic's class (D-0021): {provider, model, effort}; null for a topic without a class (created
 * before the classes), whose thread starts on the project's default model as before.
 */
export function classThread(ctx, topic) {
  return topic?.class ? topicClass(ctx, topic.class)?.thread || null : null;
}

/**
 * T3-WORKAROUND(t3-cli-effort) `t3 thread start` has --provider and --model but no --effort (T3 issue #29863): one line
 * telling the agent to set the class's effort on the new thread with the T3 tool t3_thread_configure; null when nothing to set.
 */
export function effortNote(topic, sel, thread) {
  if (!sel?.effort || !sel.provider || !sel.model || !thread) return null;
  const modelSelection = { instanceId: sel.provider, model: sel.model, options: [{ id: 'effort', value: sel.effort }] };
  return `effort: class ${topic.class} wants effort ${sel.effort}, the T3 CLI cannot set it (T3 issue #29863): set it now with the T3 tool t3_thread_configure, threadId ${thread}, modelSelection ${JSON.stringify(modelSelection)}`;
}

/**
 * T3-WORKAROUND(t3-cli-title) Start a T3 thread for the topic via `topics.thread_start_command` (default `t3 thread start --json`); returns its id.
 * The class's provider and model go along (`--provider <id> --model <slug>`); `model` in the result is the one passed, else null.
 */
export function startTopicThread(ctx, topic, run = spawnSync, { task = null, platform } = {}) {
  const cmd = String(ctx.policy?.topics?.thread_start_command || '').trim().split(/\s+/).filter(Boolean);
  const input = topicThreadMessage(topic, { task });
  const failed = (reason) => {
    // No CLI on this machine (T3 Code without `t3` in PATH): the same thread through the T3 tool, then assigned here.
    let file = null;
    try { file = threadMessageFile(ctx, topic.id); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, input + '\n'); } catch { file = null; }
    const fallback = `start it with the T3 tool t3_thread_launch (project ${ctx.projectDir}, title ${topic.id}, message${file ? ` = content of ${file}` : ': the topic subject and task'}), then: topic.mjs thread ${topic.id} --project ${ctx.projectDir} --for-thread <new thread id>`;
    return { ok: false, reason, fallback };
  };
  if (!cmd.length) return failed('topics.thread_start_command not set');
  // `--provider` only with `--model` (t3 thread start --help: "Provider instance id. Pass with --model").
  const sel = classThread(ctx, topic);
  const modelArgs = sel?.model ? [...(sel.provider ? ['--provider', sel.provider] : []), '--model', sel.model] : [];
  const t = spawnTarget(cmd[0], [...cmd.slice(1), '--title', topic.id, ...modelArgs, ctx.projectDir, '-'], { platform });
  const r = run(t.file, t.args, { encoding: 'utf8', input, timeout: 30000, shell: t.shell });
  if (r.error || r.status !== 0) return failed((r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]);
  let thread = null;
  try {
    const d = JSON.parse(r.stdout);
    thread = d?.threadId ?? d?.thread?.threadId ?? d?.thread?.id ?? d?.id ?? null;
  } catch { thread = String(r.stdout || '').trim().split(/\s+/)[0] || null; }
  if (!thread || !/^[A-Za-z0-9._:-]{1,200}$/.test(thread)) return failed(`no thread id in output of ${cmd.join(' ')}`);
  return { ok: true, thread, model: modelArgs.length ? sel.model : null, effortNote: modelArgs.length ? effortNote(topic, sel, thread) : null };
}

/**
 * New T3 thread for an existing topic nobody holds (P-036): the persona's main thread could not start the work of a topic
 * whose own thread never claimed it; mail has no address without a holder and t3_thread_send is not for other agents'
 * work (Bob 2026-11-03: thread of tracker-remote-verify stood on a question). A held topic is refused (takeover is P-037).
 */
export function startThreadForTopic(ctx, id, { task = null, mode, run, forThread = null } = {}) {
  guardThread(ctx, 'thread', { codeStart: !forThread });
  if (!topicExists(ctx.brainDir, id)) throw new Error(`topic ${id} does not exist (archived or never created)`);
  const holder = readHolder(ctx.brainDir, id);
  if (holder.thread) return { ok: false, reason: `topic ${id} ${heldBy(holder)}; a new thread needs a free topic: write to the holder (comms send --to ${topicMailProject(ctx.brainDir, id) || commsProjectName(ctx)}/${id}) or ask the operator about a takeover (P-037)` };
  // --for-thread: the thread was started by the T3 tool (fallback of a failed CLI start); it only gets the topic.
  if (forThread) return { ok: true, thread: String(forThread), claim: assignTopic(ctx, id, String(forThread), { mode }) };
  // The class comes from topic.json (D-0021); a topic from before the classes starts on the project's default model.
  const topic = readTopic(ctx.brainDir, id);
  const started = startTopicThread(ctx, topic, run, { task });
  if (!started.ok) return { ok: false, reason: `no thread was started (${started.reason}); ${started.fallback}` };
  const claim = assignTopic(ctx, id, started.thread, { mode, model: started.model });
  return { ok: true, thread: started.thread, claim, effortNote: started.effortNote };
}

/**
 * Holder of a just-created topic is another (new) thread; the topic has no holder yet, so no takeover is possible.
 * `model` is the one passed to the T3 CLI (else null); `effort` stays null while the CLI cannot set it (T3 issue #29863).
 */
function assignTopic(ctx, id, thread, { mode, model = null } = {}) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(thread)) throw new Error(`--for-thread "${thread}" is not a thread id`);
  const policyMode = ctx.policy?.topics?.default_holder_mode || 'operator';
  const holder = { thread, machine: machineName(), mode: mode || policyMode, since: nowIso(), assigned_by: ctx.thread, model: model || null, effort: null };
  const res = brainWrite(ctx, {
    internal: true,
    ops: [{ path: `topics/${id}/holder.json`, content: JSON.stringify(holder, null, 2) + '\n' }],
    message: `topic assign ${id} to ${thread} by ${ctx.thread}`,
  });
  const comms = registerTopic(ctx, id, { holder: thread });
  return { ok: true, assigned: true, holder, pushed: !!res.pushed, sha: res.sha, comms };
}

/** Claim per P-037: sync, check holder, write, push immediately; holder.json content after fetch decides. */
export function claimTopic(ctx, id, opts = {}) {
  return withBrainLock(ctx.brainDir, () => claimTopicUnlocked(ctx, id, opts));
}

function claimTopicUnlocked(ctx, id, { force = false, operatorApproved = false, mode, allowWake = false } = {}) {
  guardThread(ctx, 'claim', { allowWake });
  const first = brainSync(ctx.brainDir);
  if (first.conflict) throw new Error(`brain has a disagreement: ${first.conflict.join(', ')}; resolve before claiming (P-040)`);
  // Several machines on one brain: a claim over commits that cannot be pushed would decide on a stale holder and,
  // on a lost race, put those commits at risk. Push first, then claim.
  if (first.error && first.error !== 'no remote origin' && first.unpushed > 0) {
    return { ok: false, reason: `brain has ${first.unpushed} unpushed commit(s) that could not be pushed (${first.error}); topic ${id} not claimed: fix the push, then claim again (P-040)` };
  }
  // Origin moved on but this clone could not take it in: the local holder.json is stale, a claim would decide on it.
  if (first.error && first.remoteAhead) {
    return { ok: false, reason: `brain is behind origin and could not be updated (${first.error}); topic ${id} not claimed (P-040)` };
  }
  if (!topicExists(ctx.brainDir, id)) throw new Error(`topic ${id} does not exist (archived or never created)`);
  let holder = readHolder(ctx.brainDir, id);
  if (holder.thread && !isHolderOf(holder, ctx.thread)) {
    if (!force) {
      const stale = staleOnOtherMachine(ctx, id, holder);
      if (stale !== null) return { ok: false, reason: `topic ${id} ${heldBy(holder)}; no activity for ${stale}h on another machine (limit ${staleHours(ctx)}h): offer the operator a takeover in one question (blocker, P-059); after their yes: topic.mjs claim ${id} --force --operator-approved (P-037)`, holder, stale };
      return { ok: false, reason: `topic ${id} ${heldBy(holder)}; not taken. An instruction to claim it is not an instruction to take it over: tell the operator who holds it and ask (blocker, P-059) whether to take it over; only after an explicit yes: --force --operator-approved (P-037)`, holder };
    }
    if (!operatorApproved && !ownTopic(ctx, id)) throw new Error('--force requires --operator-approved: takeover is allowed only on explicit operator instruction (P-037); a topic this thread created is its own to clean up (P-018)');
  }
  if (isHolderOf(holder, ctx.thread)) {
    // Idempotent re-registration: repairs a claim whose mail registration failed earlier (P-041).
    if (!mode || holder.mode === mode) return { ok: true, already: true, holder, pushed: first.pushed, comms: registerTopic(ctx, id) };
    // Holder changes its own mode (P-037): rewrite holder.json and re-register so wake events follow the new mode.
    const updated = { ...holder, mode };
    const w = brainWrite(ctx, {
      internal: true,
      ops: [{ path: `topics/${id}/holder.json`, content: JSON.stringify(updated, null, 2) + '\n' }],
      message: `topic mode ${id} ${mode} by ${ctx.thread}`,
    });
    const comms = registerTopic(ctx, id);
    return { ok: true, modeChanged: true, holder: updated, pushed: !!w.pushed, sha: w.sha, comms };
  }
  const policyMode = ctx.policy?.topics?.default_holder_mode || 'operator';
  const newHolder = { thread: ctx.thread, machine: machineName(), mode: mode || policyMode, since: nowIso() };
  if (force && holder.thread) newHolder.took_over_from = holder.machine && !sameMachine(holder.machine) ? `${holder.thread} on ${holder.machine}` : holder.thread;
  const before = git(['rev-parse', 'HEAD'], { cwd: ctx.brainDir }).stdout;
  const res = brainWrite(ctx, {
    internal: true,
    sync: false,
    ops: [{ path: `topics/${id}/holder.json`, content: JSON.stringify(newHolder, null, 2) + '\n' }],
    message: `topic claim ${id} by ${ctx.thread}${force ? (operatorApproved ? ' (force, operator approved)' : ' (force, own topic)') : ''}`,
  });
  const sync = brainSync(ctx.brainDir);
  // Origin moved on and our claim could not go on top (a conflict, or uncommitted changes blocking the rebase): same race.
  if (sync.conflict || (sync.error && sync.remoteAhead)) {
    // Lost the race: drop only our claim commit (other local commits and uncommitted changes stay), read the remote holder.
    // Not `reset --hard origin/<branch>`: it threw away every unpushed commit and uncommitted change of this clone.
    const branch = currentBranch(ctx.brainDir);
    if (res.committed) {
      const undo = git(['reset', '--quiet', '--keep', before], { cwd: ctx.brainDir });
      if (!undo.ok) throw new Error(`claim of ${id} lost the race and its commit could not be dropped (${undo.stderr.split('\n')[0]}); nothing was discarded, resolve by hand (P-040)`);
    }
    const remote = git(['show', `origin/${branch}:topics/${id}/holder.json`], { cwd: ctx.brainDir });
    try { holder = remote.ok ? JSON.parse(remote.stdout || '{}') : readHolder(ctx.brainDir, id); } catch { holder = {}; }
    brainSync(ctx.brainDir);
    if (holder.thread && !isHolderOf(holder, ctx.thread)) {
      return { ok: false, reason: `topic ${id} ${heldBy(holder)} (claimed first)`, holder };
    }
    return { ok: false, reason: `claim of ${id} could not be pushed (${sync.conflict ? `conflict: ${sync.conflict.join(', ')}` : sync.error})`, holder };
  }
  // holder.json changed on origin too: the sync kept origin's holder (P-040). Who holds it now decides.
  const after = readHolder(ctx.brainDir, id);
  if (after.thread !== ctx.thread || after.since !== newHolder.since) {
    if (after.thread) return { ok: false, reason: `topic ${id} ${heldBy(after)} (claimed first)`, holder: after };
    return { ok: false, reason: `claim of ${id} was replaced by origin's holder.json (released meanwhile); claim again`, holder: after };
  }
  if (sync.error && sync.error !== 'no remote origin') {
    // Mail registration comes after a successful push: it is not done here; a repeated claim registers it (`already`).
    const comms = { ok: false, reason: 'brain push failed: mail registration not done (repeat topic.mjs claim to register)', topic: id, skipped: false };
    return { ok: true, holder: newHolder, pushed: false, warning: `claim committed but not pushed (${sync.error}); other machines will not see it until push succeeds`, comms };
  }
  // A takeover replaces the other holder in the mail service too (the service refuses it without takeover, P-037).
  const comms = registerTopic(ctx, id, { takeover: !!newHolder.took_over_from });
  return { ok: true, holder: newHolder, pushed: sync.pushed, sha: res.sha, comms };
}

/**
 * Main thread of a persona (P-045, P-050): permanent topic `main` (kind `main`) held by the persona's main thread.
 * Created on first use, registered in the mail service as `@<persona>/main`. A claim held by another thread is refused
 * without --force (a new main thread after a restart takes over on operator instruction, `--force --operator-approved`; bob 2026-11-01: a topic thread
 * took main silently and got the persona bell); refused in a wake turn (P-047) unless main has no holder yet (first adoption takes nothing over). Outside the topic limit, never offered as free, never closed.
 */
export function claimMain(ctx, opts = {}) {
  if (!ctx.brainInfo?.persona) throw new Error('topic main exists only in a persona brain ("brain": ".", P-024)');
  return withBrainLock(ctx.brainDir, () => {
    // First adoption takes nothing over: allowed in a wake turn, so a request by mail to @<persona>/main is enough.
    const unheld = !topicExists(ctx.brainDir, MAIN_TOPIC) || !readHolder(ctx.brainDir, MAIN_TOPIC).thread;
    guardThread(ctx, 'main', { allowWake: unheld });
    if (!topicExists(ctx.brainDir, MAIN_TOPIC)) {
      const topic = { id: MAIN_TOPIC, subject: `Hlavné vlákno persony ${ctx.projectName}`, kind: 'main', state: 'working', created: nowIso() };
      brainWrite(ctx, {
        internal: true,
        ops: [
          { path: `topics/${MAIN_TOPIC}/topic.json`, content: JSON.stringify(topic, null, 2) + '\n' },
          { path: `topics/${MAIN_TOPIC}/holder.json`, content: '{}\n' },
          { path: `topics/${MAIN_TOPIC}/handover.md`, content: freeHandover() },
        ],
        message: 'topic main created',
      });
    } else if (!isMainTopic(readTopic(ctx.brainDir, MAIN_TOPIC))) {
      throw new Error('topic main exists but is not of kind main; rename it first (P-045)');
    }
    // Takeover of a main held by another thread only with --force on operator instruction (a new main thread after a
    // restart); a topic thread must not take the persona mailbox (bob 2026-11-01: tunnel thread took main).
    const holder = readHolder(ctx.brainDir, MAIN_TOPIC).thread;
    const takeover = !!holder && holder !== ctx.thread;
    if (takeover && !opts.force) return { ok: false, reason: `topic main is held by ${holder}: only a new persona main thread takes it over, on operator instruction: topic.mjs main --force --operator-approved (P-045, P-037)` };
    // Same rule as `claim --force` (P-037): the operator's approval is named by the flag, not implied by --force.
    if (takeover && !opts.operatorApproved) return { ok: false, reason: '--force requires --operator-approved: takeover of topic main is allowed only on explicit operator instruction (P-045, P-037)' };
    return claimTopicUnlocked(ctx, MAIN_TOPIC, { mode: opts.mode, force: takeover, operatorApproved: takeover, allowWake: unheld });
  });
}

export function releaseTopic(ctx, id, opts = {}) {
  return withBrainLock(ctx.brainDir, () => releaseTopicUnlocked(ctx, id, opts));
}

function releaseTopicUnlocked(ctx, id, { force = false, operatorApproved = false } = {}) {
  guardThread(ctx, 'release');
  // Main is the persona's main thread, permanent and never free (P-045), like done (done.mjs refuses it too).
  if (isMainTopic(readTopic(ctx.brainDir, id))) throw new Error('topic main is the persona main thread: it is never released (P-045)');
  const holder = readHolder(ctx.brainDir, id);
  if (holder.thread && !isHolderOf(holder, ctx.thread)) {
    if (!force) throw new Error(`topic ${id} ${heldBy(holder)}; only the holder releases it (P-037)`);
    if (!operatorApproved && !ownTopic(ctx, id)) throw new Error('--force requires --operator-approved (P-037); a topic this thread created is its own to clean up (P-018)');
  }
  // An already free topic still registers the release: a mail registration that failed earlier is repaired here (P-041).
  const res = holder.thread ? brainWrite(ctx, {
    internal: true,
    ops: [{ path: `topics/${id}/holder.json`, content: '{}\n' }],
    message: `topic release ${id} by ${ctx.thread}`,
  }) : null;
  // The mail service stops carrying this thread as holder (wake events, P-043); messages for the topic keep waiting.
  const comms = registerTopic(ctx, id, { holder: null, release: true });
  return { ok: true, already: !holder.thread, write: res, comms, mail: freePointMail(ctx, id) };
}

/**
 * Messages waiting for a topic at its free point (P-044): offered to the agent, never injected. The thread is passed to
 * the count (the message ids are listed, not read). An outage says so and still records the topic (the
 * mailbox is read again when the service is back).
 * `record: false` (topic main, never free, P-045) leaves the free_point list alone.
 */
export function freePointMail(ctx, id, { record = true } = {}) {
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) return null;
  // The topic record keeps its kind: topic main is read from the persona mailbox `@<persona>/main` (bob 2026-11-01).
  const mail = mailCount(ctx, [{ ...topic, state: 'free' }]);
  if (!mail.count && !mail.unknown) return null;
  // The thread no longer holds the topic, yet handles its free-point mail: remember it so comms list/receive still
  // read that mailbox (pilot 2026-11-01: after release `receive --id` found nothing).
  if (record && ctx.brainDir && ctx.thread) {
    const state = readThreadState(ctx.brainDir, ctx.thread);
    const fp = Array.isArray(state.free_point) ? state.free_point : [];
    if (!fp.includes(id)) writeThreadState(ctx.brainDir, ctx.thread, { ...state, free_point: [...fp, id] });
  }
  if (mail.count) {
    const ids = mailLines(mail.items);
    return `mail: ${mail.count} waiting for topic ${id} (free point)${ids.length ? `: ${ids.join('; ')}` : ''}; read each one with comms receive --id <id> and handle it now (skill workflow:comms, P-044)`;
  }
  if (mail.unknown) return `mail: unknown (comms unavailable) for topic ${id} (free point): run comms receive when it is back (P-044)`;
  return null;
}

/**
 * Topics whose mailbox this thread reads (P-044): the held topics, then the topics it released with mail waiting (free
 * point, until another thread claims them). Status line, Stop free-point block, comms list/receive use the same set.
 */
export function mailboxTopics(ctx) {
  if (!ctx.brainDir) return [];
  const own = heldTopics(ctx.brainDir, ctx.thread);
  const fp = ctx.thread ? (readThreadState(ctx.brainDir, ctx.thread).free_point || []) : [];
  const extra = [];
  for (const id of fp) {
    if (own.some((t) => t.id === id) || extra.some((t) => t.id === id)) continue;
    const topic = readTopic(ctx.brainDir, id);
    // Main is never free (P-045): a stale free_point entry for it is not a free topic.
    if (topic && !isMainTopic(topic) && !readHolder(ctx.brainDir, id).thread) extra.push({ ...topic, state: 'free' });
  }
  return [...own, ...extra];
}

/**
 * Pause (snooze) a topic that stays relevant but gets no work for a while (operator 2026-11-03: a topic set aside kept
 * waking to check its threads). A paused topic gets no continue bell, no next-step block and no auto timer; with
 * `until` its thread is rung once at that time. Messages still arrive.
 */
export function pauseTopic(ctx, id, { until = null, reason = null } = {}) {
  guardThread(ctx, 'pause');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  if (isMainTopic(topic)) throw new Error('topic main is the persona main thread: it is never paused (P-045)');
  const holder = readHolder(ctx.brainDir, id);
  if (holder.thread && !isHolderOf(holder, ctx.thread)) throw new Error(`topic ${id} ${heldBy(holder)}; only the holder pauses it (P-037)`);
  const at = until ? Date.parse(until) : null;
  if (until && !(at > Date.now())) throw new Error('--until must be a future time (ISO 8601 or <n>d / <n>h)');
  const { paused_until: _u, paused_reason: _r, ...rest } = topic;
  const next = { ...rest, state: 'paused', paused_at: nowIso(), ...(at ? { paused_until: new Date(at).toISOString() } : {}), ...(reason ? { paused_reason: String(reason).slice(0, 200) } : {}), updated: nowIso() };
  const write = brainWrite(ctx, { internal: true, ops: [{ path: `topics/${id}/topic.json`, content: JSON.stringify(next, null, 2) + '\n' }], message: `topic pause ${id}${at ? ` until ${next.paused_until}` : ''}` });
  return { ok: true, topic: next, write };
}

export function resumeTopic(ctx, id) {
  guardThread(ctx, 'resume');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  if (topic.state !== 'paused') return { ok: true, already: true, topic };
  const { paused_at: _a, paused_until: _u, paused_reason: _r, ...rest } = topic;
  const next = { ...rest, state: 'working', updated: nowIso() };
  const write = brainWrite(ctx, { internal: true, ops: [{ path: `topics/${id}/topic.json`, content: JSON.stringify(next, null, 2) + '\n' }], message: `topic resume ${id}` });
  return { ok: true, topic: next, write };
}

export const isPaused = (t) => t?.state === 'paused';

export function setTopicState(ctx, id, state) {
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  topic.state = state;
  topic.updated = nowIso();
  return { path: `topics/${id}/topic.json`, content: JSON.stringify(topic, null, 2) + '\n' };
}

/**
 * Start point of a new topic branch: the checked-out branch as on origin when the local one is not ahead of it. HEAD of a
 * shared checkout lagged origin/dev, so a topic worktree began on an old dev (topic-project-move, D-0035). null = HEAD.
 */
export function newBranchBase(repo) {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
  const name = b.ok ? b.stdout.trim() : '';
  if (!name || name === 'HEAD') return null;
  const remote = `origin/${name}`;
  if (!git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`], { cwd: repo }).ok) return null;
  return git(['merge-base', '--is-ancestor', 'HEAD', remote], { cwd: repo }).ok ? remote : null;
}

// --no-track: topic/<id> must not get origin/dev as its upstream.
const newBranchArgs = (branch, copy, base) => (base ? ['--no-track', '-b', branch, copy, base] : ['-b', branch, copy]);

export function ensureCodeCopy(ctx, id) {
  const copy = codeCopyPath(ctx, id);
  const branch = `topic/${id}`;
  if (fs.existsSync(path.join(copy, '.git'))) return { path: copy, branch, created: false };
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  if (ctx.domain) {
    const repo = mainCheckout(ctx.projectDir);
    // The brain is never checked out twice: a persona repo is its brain (P-024) and a second checkout would share its
    // index of records with a topic branch (the reason worktrees were refused before v3).
    if (ctx.brainDir && fs.realpathSync(repo) === fs.realpathSync(ctx.brainDir)) throw new Error(`code topic ${id}: ${repo} is the brain; a worktree of the brain is not allowed (P-024). Pass --project <code repo>`);
    if (git(['remote', 'get-url', 'origin'], { cwd: repo }).ok) git(['fetch', '--quiet', 'origin'], { cwd: repo });
    const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).ok;
    const remote = !local && git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repo }).ok;
    const add = local ? git(['worktree', 'add', '--quiet', copy, branch], { cwd: repo })
      : remote ? git(['worktree', 'add', '--quiet', '-b', branch, copy, `origin/${branch}`], { cwd: repo })
        : git(['worktree', 'add', '--quiet', ...newBranchArgs(branch, copy, newBranchBase(repo))], { cwd: repo });
    if (!add.ok) throw new Error(`git worktree add ${copy} (${branch}) failed: ${add.stderr.split('\n')[0]}`);
    return { path: copy, branch, created: true, worktree: true };
  }
  const clone = git(['clone', '--quiet', ctx.projectDir, copy]);
  if (!clone.ok) throw new Error(`clone of project into ${copy} failed: ${clone.stderr.split('\n')[0]}`);
  const existing = git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: copy });
  const checkout = existing.ok
    ? git(['checkout', '--quiet', '-b', branch, `origin/${branch}`], { cwd: copy })
    : git(['checkout', '--quiet', '-b', branch], { cwd: copy });
  if (!checkout.ok) throw new Error(`checkout ${branch} failed: ${checkout.stderr}`);
  return { path: copy, branch, created: true };
}

/** A discussion topic: class discussion, or a topic from before the classes of kind discussion (D-0020). */
export function isDiscussionTopic(topic) {
  return topic?.class ? topic.class === 'discussion' : topic?.kind === 'discussion';
}

/** The topic has a code copy: a code topic always, another one (not main) once `topic.mjs copy` recorded it (D-0020). */
export function hasCodeCopy(topic) {
  if (!topic || isMainTopic(topic)) return false;
  return topic.kind === 'code' || !!topic.copy;
}

/** Path of the topic's code copy (where ensureCodeCopy makes it), or null for a topic without one. */
export function topicCopyPath(ctx, topic) {
  return hasCodeCopy(topic) ? codeCopyPath(ctx, topic.id) : null;
}

/**
 * Code copy for a topic without one (D-0020): a discussion gets it after the operator approved the proposal
 * (--operator-approved), only from its holder and never in a turn started by a message (P-047). The copy is recorded in
 * topic.json (`copy`, `repo`); class and kind stay, so `done` merges it like the copy of a code topic (P-036).
 * A code topic (web, code) only gets its copy made again, as before.
 */
export function copyTopic(ctx, id, opts = {}) {
  return withBrainLock(ctx.brainDir, () => copyTopicUnlocked(ctx, id, opts));
}

function copyTopicUnlocked(ctx, id, { operatorApproved = false, explicitProject = false } = {}) {
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist (archived or never created)`);
  if (topic.kind === 'code') return { ...ensureCodeCopy(ctx, id), recorded: false };
  if (isMainTopic(topic)) throw new Error('topic main is the persona main thread: it has no code copy (P-045)');
  guardThread(ctx, 'copy');
  const holder = readHolder(ctx.brainDir, id);
  if (!isHolderOf(holder, ctx.thread)) throw new Error(`topic ${id} ${holder.thread ? heldBy(holder) : 'has no holder'}; only its holder makes its code copy (P-037)`);
  const discussion = isDiscussionTopic(topic);
  if (discussion && !operatorApproved) throw new Error(`topic ${id} is a discussion: its implementation is approved by the operator (D-0020). Show the operator the proposal and ask; only after an explicit yes: topic.mjs copy ${id} --operator-approved, then delegate.mjs prepare --implement web|code|ops`);
  if (!explicitProject && isPersonaProject(ctx)) throw new Error(`code copy of topic ${id} would be made of persona project ${path.basename(ctx.projectDir)}: a persona has no project code (P-025). Pass --project <managed project dir>`);
  const copy = ensureCodeCopy(ctx, id);
  const rel = relPosix(ctx.projectDir, copy.path);
  if (topic.copy === rel) return { ...copy, recorded: false };
  const next = { ...topic, copy: rel, repo: path.basename(mainCheckout(ctx.projectDir)), ...(discussion ? { copy_approved: { by: 'operator', at: nowIso(), thread: ctx.thread } } : {}), updated: nowIso() };
  const write = brainWrite(ctx, { internal: true, ops: [{ path: `topics/${id}/topic.json`, content: JSON.stringify(next, null, 2) + '\n' }], message: `topic copy ${id}${discussion ? ' (operator approved)' : ''} by ${ctx.thread}` });
  return { ...copy, recorded: true, write };
}

/** Classes an implementation runs in (D-0021): a discussion is not one, its implementation takes the class of the work. */
export const IMPLEMENT_CLASSES = ['web', 'code', 'ops'];
export const IMPLEMENT_HELP = IMPLEMENT_CLASSES.map((c) => `${c} = ${TOPIC_CLASSES[c].when}`).join('; ');

/**
 * Class and model of an implementation in a topic (D-0020, D-0021): the class of a web, code or ops topic decides (an asked
 * class that differs is refused); a discussion topic (or one from before the classes) names the class of the work. The model
 * is the class's subagent_model from policy; a class without one is a blocker of the policy, never a fallback model.
 */
export function implementationClass(ctx, topic, asked = null) {
  const own = IMPLEMENT_CLASSES.includes(topic?.class) ? topic.class : null;
  const want = typeof asked === 'string' && asked.trim() ? asked.trim() : null;
  let cls = own;
  if (own && want && want !== own) throw new Error(`--implement ${want} contradicts the class of topic ${topic.id} (${own}): the topic's class decides the implementation; leave the class out`);
  if (!own) {
    if (!want) throw new Error(`topic ${topic.id} is ${topic.class ? `of class ${topic.class}` : `a ${topic.kind} topic without a class`}: name the class of the work, --implement web|code|ops (D-0021): ${IMPLEMENT_HELP}`);
    if (!IMPLEMENT_CLASSES.includes(want)) throw new Error(`--implement ${want} is not a class of an implementation (D-0021): ${IMPLEMENT_HELP}`);
    cls = want;
  }
  const model = topicClass(ctx, cls)?.subagent_model;
  if (!model || typeof model !== 'string') throw new Error(`policy topics.classes.${cls}.subagent_model is not set: an implementation of class ${cls} has no model; set it in policy.json (a blocker of the policy, no fallback model, D-0021)`);
  return { cls, model };
}

/**
 * Class and model the hook expects for an implementation in a topic: the topic's class, else the class of its last
 * implementation recorded by delegate.mjs prepare --implement (a discussion); model from policy. Null without a class.
 */
export function expectedImplementation(ctx, topic) {
  const last = Array.isArray(topic?.implementations) ? topic.implementations.at(-1) : null;
  const cls = IMPLEMENT_CLASSES.includes(topic?.class) ? topic.class : IMPLEMENT_CLASSES.includes(last?.class) ? last.class : null;
  if (!cls) return null;
  const model = topicClass(ctx, cls)?.subagent_model;
  return { cls, model: typeof model === 'string' && model ? model : null };
}

/** Evidence of an implementation (D-0020): {at, class, model} appended to `implementations` in topic.json. */
export function recordImplementation(ctx, id, { cls, model }) {
  return withBrainLock(ctx.brainDir, () => {
    const topic = readTopic(ctx.brainDir, id);
    if (!topic) throw new Error(`topic ${id} does not exist (archived or never created)`);
    const entry = { at: nowIso(), class: cls, model };
    const next = { ...topic, implementations: [...(Array.isArray(topic.implementations) ? topic.implementations : []), entry] };
    const write = brainWrite(ctx, { internal: true, ops: [{ path: `topics/${id}/topic.json`, content: JSON.stringify(next, null, 2) + '\n' }], message: `topic implement ${id}: class ${cls}, model ${model} by ${ctx.thread}` });
    return { entry, write };
  });
}

/** Marker line of delegate.mjs prepare --implement in a worker brief; the PreToolUse hook reads it (D-0020). */
export function implementMarker({ id, cls, model, copy, branch }) {
  return `implement: topic ${id}, class ${cls}, model ${model}, code copy ${toPosix(copy)} (branch ${branch})`;
}

/** Marker lines in a text: [{ id, cls, model, copy, branch }]. */
export function implementMarkers(text) {
  const re = /^[ \t]*implement: topic ([a-z0-9-]+), class ([a-z]+), model (\S+), code copy (.+?) \(branch (\S+)\)[ \t]*$/gm;
  return [...String(text || '').matchAll(re)].map((m) => ({ id: m[1], cls: m[2], model: m[3], copy: m[4], branch: m[5] }));
}

export function listTopics(brainDir) {
  return readTopics(brainDir);
}

export function heldTopics(brainDir, thread) {
  if (!thread) return [];
  // Work topics first: the main topic (P-045) is the fallback, so a main thread working on a topic shows that topic.
  const held = readTopics(brainDir).filter((t) => isHolderOf(t.holder, thread));
  return [...held.filter((t) => !isMainTopic(t)), ...held.filter(isMainTopic)];
}
