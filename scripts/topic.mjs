// Topics: create, claim, release, list (P-036, P-037, P-045, P-047).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { git, gitRemote, readText, nowIso, relPosix, toPosix, realPathLoose } from './util.mjs';
import { installPushHook, pushBranch } from './push-hook.mjs';
import { isWakeTurn, machineName, sameMachine, inSubagent, inHarness, readThreadState, writeThreadState, mainCheckout, WORKTREES_DIR, loadContext, readWorkflowConfig, PERSONA_BRAIN } from './config.mjs';
import { domainRepos } from './repo-knowledge.mjs';
import { bellContinuation } from './waker.mjs';
import { brainWrite, brainSync, readHolder, currentBranch, withBrainLock, isHolderOf } from './brain.mjs';
import { freeHandover, renderHandover, checkHandover, handoverNextStep, sectionItems } from './brain-checks.mjs';
import { turnFields } from './topic-state.mjs';
import { pendingBuffers, flushBuffer } from './logs.mjs';
import { readTopics } from './records.mjs';
import { isValidId } from './keys.mjs';
import { dataPath, dataRel, layoutOf, topicWorkDir } from './layout.mjs';
import { ASSIGNED_OPERATOR, ASSIGNED_TECHNICAL, hasTriage } from './triage.mjs';
import { topicOp, holderOp, fieldsOp, MODES, openTopicExists, closedTopicExists, closedTopicDir, readTopicRecord, holderFromText, workDir, workTopic } from './topic-files.mjs';
import { registerTopic, mailCount, mailLines, isMainTopic, MAIN_TOPIC, runClient, commsConfigured, commsProjectName, supervisorOf } from './comms.mjs';
import { checkOverlap, topicScopeText } from './overlap.mjs';
import { freezeRefusal } from './freeze.mjs';

export function topicDir(brainDir, id) {
  return dataPath(brainDir, 'topics', id);
}

/** Brain-relative path (posix) of a topic folder, or of a file in it by its logical name (topicFile, holderFile, handover). */
export function topicRel(brainDir, id, name) {
  return name ? dataRel(brainDir, 'topics', id, layoutOf(brainDir)[name]) : dataRel(brainDir, 'topics', id);
}

/** An open topic of this id exists (a closed one: closedTopicExists; layout 2 keeps it in place with state closed). */
export function topicExists(brainDir, id) {
  return openTopicExists(brainDir, id);
}

/** The record of an open topic without its holder, or null (closed or missing). */
export function readTopic(brainDir, id) {
  return readTopicRecord(brainDir, id);
}

export { topicOp, holderOp, closedTopicExists, closedTopicDir, readTopicRecord, workDir, workTopic };

/** The topic was created by this thread (its own test or mistake to clean up, P-018). */
export function ownTopic(ctx, id) {
  return !!ctx.thread && readTopic(ctx.brainDir, id)?.created_by === ctx.thread;
}

/**
 * Mail project of a topic created with --project in another project of the same brain (D-0035): it is registered in the
 * mail service under that project, so a bare `comms send --to <topic>` from the creating project addresses it there.
 */
export function topicMailProject(brainDir, id) {
  const p = readTopic(brainDir, id)?.project;
  return typeof p === 'string' && p ? p : null;
}

/**
 * Where a code topic works. In a domain (v3, D-0002): a git worktree `<domain>/.worktrees/<repo>/<topic>/` of the
 * project's main checkout, inside the write boundary and sharing the repo's objects. Without a domain (not migrated
 * yet): the legacy clone `../<project>-topics/<topic>/`. `repo`: the worktree in that target repo of the topic (spec 4.5).
 */
export function codeCopyPath(ctx, id, repo = null) {
  if (ctx.domain) return path.join(ctx.domain.root, WORKTREES_DIR, repo || path.basename(topicRepoDir(ctx, id)), id);
  return path.resolve(ctx.projectDir, '..', `${ctx.projectName}-topics`, id);
}

/**
 * Main checkout of the repo a topic's code copy is made of: in a domain the repo its record names (`repo`), so a persona
 * whose session runs in its brain finds the copy of a topic it holds (delegate.mjs prepare --implement); else, or before
 * the record has one, the repo of the session. `repo`: that repo of the domain (a target repo of the topic, spec 4.5).
 */
export function topicRepoDir(ctx, id, repo = null) {
  const name = ctx.domain && ctx.brainDir ? repo || readTopicRecord(ctx.brainDir, id)?.repo : null;
  if (name) {
    const dir = path.join(ctx.domain.root, name);
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return mainCheckout(ctx.projectDir);
}

// codeStart: the action starts a new thread that holds the topic. Code without a thread id (cron, e.g. issues/watch.sh of a
// persona, D-0019) may do that: it holds nothing and no message started it. An agent session still needs its id (P-038).
// allowWake: the action may run in a turn started by a message. P-047 locks takeover, closing, rules and dangerous
// operations; a new topic or a thread for a free topic is none of them (agent-alice/D-0066).
function guardThread(ctx, action, { allowWake = false, codeStart = false } = {}) {
  if (inSubagent()) throw new Error(`topic ${action} refused in subagent (P-025)`);
  if (!ctx.thread && codeStart && !inHarness()) return;
  if (!ctx.thread) throw new Error(`topic ${action} needs a stable thread id: start the harness via thread.mjs or in T3 (WORKFLOW_THREAD_ID / T3CODE_THREAD_ID, P-038)`);
  if (!allowWake && isWakeTurn(ctx.brainDir, ctx.thread)) {
    throw new Error(`topic ${action} refused: this turn was started by a message, not by the operator (P-047)${bellContinuation(ctx.brainDir, ctx.thread)}`);
  }
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
  const commit = Number(git(['log', '-1', '--format=%ct', '--', topicRel(ctx.brainDir, id)], { cwd: ctx.brainDir }).stdout || 0) * 1000;
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
  const outbox = dataPath(ctx.brainDir, 'local', 'outbox');
  // Queued items are the .json files of the outbox (the client moves refused ones to rejected/); `flush` sends them in order.
  const waiting = () => { try { return fs.readdirSync(outbox).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length; } catch { return 0; } };
  if (waiting() && commsConfigured(ctx)) runClient(ctx, ['flush']);
  const left = waiting();
  if (left && !leaveOutbox) return { ok: false, reason: `${left} message(s) in this machine's mail outbox could not be sent (mail unavailable): hand off when mail is up, or with --leave-outbox they are sent from this machine later` };
  if (left) steps.push(`${left} message(s) left in this machine's outbox`);
  const ops = [];
  if (handover) {
    const content = renderHandover(handover);
    const errors = checkHandover(content);
    if (errors.length) throw new Error(errors.join('\n'));
    const nextSteps = handoverNextStep(content) || [];
    if (nextSteps.length && isDiscussionMode(topic)) throw new Error(DISCUSSION_NEXT_REFUSAL(id, nextSteps));
    ops.push({ path: topicRel(ctx.brainDir, id, 'handover'), content });
  } else {
    let current = '';
    try { current = fs.readFileSync(path.join(topicDir(ctx.brainDir, id), layoutOf(ctx.brainDir).handover), 'utf8'); } catch { /* none */ }
    if (!current.trim() || current.trim() === freeHandover().trim()) throw new Error(`topic ${id} has no handover: give --task, --done and --next, the other machine continues from it (P-026)`);
  }
  const record = { handoff_from: { thread: ctx.thread, machine: machineName(), at: nowIso() } };
  ops.push(holderOp(ctx.brainDir, id, record));
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

function createTopicUnlocked(ctx, { id, subject, class: cls = null, kind: askedKind = null, mode, claim = true, copy = true, forThread = null, newThread = false, task = null, explicitProject = false, origin = ctx, assignedBy = ASSIGNED_TECHNICAL, run = spawnSync, requestedBy = null }) {
  if (!isValidId(id)) throw new Error(`topic id "${id}" must be lowercase letters, digits and hyphens (P-036)`);
  if (id === MAIN_TOPIC) throw new Error('topic id "main" is reserved for the persona main thread: use topic.mjs main (P-045)');
  if (!subject || !String(subject).trim()) throw new Error('topic needs --subject "<one sentence>" (P-045)');
  const { kind } = resolveClass(ctx, cls, askedKind);
  // Spec 3.4: a new thread only on the explicit request of the operator or the supervisor, and the record names who asked.
  const forNewThread = !!forThread || newThread;
  if (forNewThread) requestedBy = threadRequester(requestedBy);
  // A persona has no project code (P-025): a code topic from its session without --project went to the persona repo
  // instead of the managed project (bob 2026-11-03, t3-workarounds-check in bob, not the managed project).
  if (kind === 'code' && !explicitProject && isPersonaProject(ctx)) throw new Error(`code topic ${id} would be created in persona project ${path.basename(ctx.projectDir)}: a persona has no project code (P-025). Pass --project <managed project dir> (or --project ${ctx.projectDir} if the persona repo itself is the code)`);
  guardThread(ctx, 'create', { allowWake: true, codeStart: newThread && !forThread });
  // P-074 (agent-alice/D-0092): during a freeze a code topic in a frozen repo (workflow, mail) runs only when the freeze
  // allows it (the work of the rebuild); the old version is not fixed, so the report or issue is rejected instead.
  if (kind === 'code') {
    const frozen = freezeRefusal(ctx.policy, { id, repo: path.basename(mainCheckout(ctx.projectDir)) });
    if (frozen) throw new Error(frozen);
  }
  if (topicExists(ctx.brainDir, id) || closedTopicExists(ctx.brainDir, id)) throw new Error(`topic ${id} already exists`);
  const topic = { id, subject: String(subject).trim(), class: String(cls), kind, state: 'working', created: nowIso() };
  // flow-public#87: the task is kept with the topic, so the drift judge compares new work with it, not only with the subject.
  if (task && String(task).trim()) topic.task = String(task).trim();
  if (forNewThread) topic.thread_requested_by = requestedBy;
  // The creating thread may clean up its own topic (test, mistake) without operator approval (P-018).
  if (ctx.thread) topic.created_by = ctx.thread;
  // Layout 2 (D-0044): who gave the topic decides the triage at done --topic; a brain without it records nothing.
  if (hasTriage(ctx.brainDir)) topic.assigned_by = assignedBy === ASSIGNED_OPERATOR ? ASSIGNED_OPERATOR : ASSIGNED_TECHNICAL;
  if (kind === 'code') {
    // Only a copy that is made is recorded: the intake (copy: false) recorded a path its thread then named as
    // `Kópia kódu`, a folder that never existed (report-228e044c).
    if (copy) topic.copy = relPosix(ctx.projectDir, codeCopyPath(ctx, id));
    topic.repo = path.basename(mainCheckout(ctx.projectDir)); // the repo the topic changes (v3: one domain, several repos)
  }
  // Flow v2 (plan O1): a topic of class discussion is created in mode discussion (spec 10.6, 13), another one with mode
  // off; its target repos (4.5) are the repo of a code topic, else none; its turn is the state of the free handover.
  topic.mode = String(cls) === 'discussion' ? 'discussion' : 'off';
  topic.repos = topic.repo ? { main: topic.repo, list: [topic.repo] } : { main: null, list: [] };
  topic.turn = turnFields({});
  // D-0035: a topic of another project (--project) is registered in the mail service under that project's mail name.
  if (explicitProject) {
    const mp = commsProjectName(ctx);
    if (mp && mp !== commsProjectName(origin || ctx)) topic.project = mp;
  } else if (sharedDomainBrain(ctx)) {
    // A domain brain shared by the domain's projects: registerTopic registers the topic under this session's mail project,
    // so the record names it; the topic folder alone tells the sender only the brain repo (report-3c65fd98:
    // <domain brain>/<topic> held while the topic was registered as <project of the domain>/<topic>).
    const mp = commsProjectName(ctx);
    if (mp) topic.project = mp;
  }
  // This thread claims its own new topic: the holder goes into the create commit, one sync cycle instead of two
  // (49 extra `topic claim` commits, median 11.1 s against ~6 s).
  const claimNow = claim && !forThread && !newThread;
  const holder = claimNow ? { thread: ctx.thread, machine: machineName(), mode: mode || ctx.policy?.topics?.default_holder_mode || 'operator', since: nowIso() } : null;
  // Plan O6: the new scope is compared with the open topics of the same repo or project and the overlaps are listed, never
  // refused (the overlap of topics is the supervisor's judgement, spec 3.9.4); code without a thread (intake) is not checked.
  const overlap = ctx.thread ? checkOverlap(ctx, { scope: topicScopeText(topic.subject, topic.task), repo: topic.repo || null, project: topic.project || null, exclude: [id] }) : { lines: [] };
  const res = brainWrite(ctx, {
    internal: true,
    ops: [
      topicOp(ctx.brainDir, id, topic),
      holderOp(ctx.brainDir, id, holder || {}),
      { path: topicRel(ctx.brainDir, id, 'handover'), content: freeHandover() },
    ],
    message: `topic create ${id}${holder ? ` (claimed by ${ctx.thread})` : ''}`,
  });
  const out = { topic, write: res, claim: null, copy: null, thread: null, effortNote: null, overlap: overlap.lines };
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

/**
 * The session's brain is the domain brain (marker `brain`), a repo of its own other than the session's, and not a persona
 * brain (a persona brain keeps its topics in its own mail project, D-0035).
 */
function sharedDomainBrain(ctx) {
  if (!ctx.brainDir || !ctx.domain?.brain) return false;
  const brain = realPathLoose(mainCheckout(ctx.brainDir));
  if (brain !== realPathLoose(ctx.domain.brain) || brain === realPathLoose(mainCheckout(ctx.projectDir))) return false;
  return readWorkflowConfig(brain).brain !== PERSONA_BRAIN;
}

/** Who may ask for a new thread (spec 3.4): the operator or the supervisor; recorded as topic.thread_requested_by. */
export const THREAD_REQUESTERS = ['operator', 'supervisor'];

/** The requester of a new thread, else the refusal (spec 3.4: nobody else starts a thread, a topic manager only subagents). */
export function threadRequester(requestedBy) {
  const r = typeof requestedBy === 'string' ? requestedBy.trim() : '';
  if (!THREAD_REQUESTERS.includes(r)) throw new Error(`a new thread starts only on the explicit request of the operator or the supervisor (spec 3.4): pass --requested-by ${THREAD_REQUESTERS.join('|')}; a topic manager starts only subagents, a topic of its own work it claims itself (--here)`);
  return r;
}

/** First message of a topic's own thread: what the topic holds and what to do (P-036). */
// With a task the thread does it now instead of waiting for a prompt (operator 2026-11-02: topic agent-playbook was
// created for a clear task and its thread stopped asking for an instruction). A thread the supervisor asked for gets the
// supervisor introduced and its task as the Zadanie (spec 2.2, 3.2; plan B7).
export function topicThreadMessage(topic, { task = null, supervisor = null } = {}) {
  const t = task && String(task).trim();
  const bySupervisor = topic.thread_requested_by === 'supervisor';
  const sup = supervisor && (supervisor.persona || supervisor.comms) ? `${supervisor.persona || '?'}${supervisor.comms ? `, pošta ${supervisor.comms}` : ''}` : null;
  return [
    // The class (D-0021) next to the kind; a topic from before the classes has none.
    `Téma ${topic.id} (${topic.kind})${topic.class ? `, trieda ${topic.class},` : ''} je pridelená tomuto vláknu.`,
    `Predmet: ${topic.subject}`,
    ...(topic.copy ? [`Kópia kódu: ${topic.copy}`] : []),
    ...(bySupervisor ? [`Vlákno založil supervisor${sup ? ` (${sup})` : ''}: je nadriadený manažéra témy a jeho správa v pošte je pokyn (2.2). Otázky patria najprv operátorovi, supervisorovi iba v jeho jurisdikcii alebo na pokyn operátora (3.3).`] : []),
    '',
    ...(t
      ? [bySupervisor ? 'Zadanie supervisora:' : 'Zadanie operátora:', t, '', `Zadanie zapíš do handoveru (save handover) s pôvodom ${bySupervisor ? 'správa supervisora' : 'vlákno'} a vykonaj ho hneď; na ďalší pokyn nečakaj a nepýtaj sa, či začať.`]
      : ['Vypíš operátorovi stručne, čo téma obsahuje (predmet, handover), a počkaj na jeho pokyn.']),
  ].join('\n');
}

/**
 * Command to spawn on this platform. Windows: spawnSync finds only `<name>.exe` by itself, an npm shim `t3.cmd` gives
 * ENOENT (Windows instance 2026-11-07, agentic-flow-public#10): the name is resolved over PATH and PATHEXT, a .cmd/.bat runs
 * through the shell with quoted arguments.
 */
/**
 * The T3 CLI when `t3` is not in PATH (doma-pc 2026-11-16: connect said "t3 not found on this machine"): T3 gives its
 * threads T3CODE_CLI_PATH and installs the CLI as ~/.t3/bin/t3 (Windows t3.cmd) without adding it to PATH; the mail's
 * wake module finds it the same way. null when `t3` is in PATH or no fallback exists.
 */
export function t3Cli({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const exts = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const join = win ? path.win32.join : path.posix.join;
  for (const dir of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) for (const ext of exts) if (exists(join(dir, `t3${ext}`))) return null;
  const home = env.USERPROFILE || env.HOME || '';
  return [env.T3CODE_CLI_PATH, home && join(home, '.t3', 'bin', win ? 't3.cmd' : 't3')].find((f) => f && exists(f)) || null;
}

export function spawnTarget(name, args, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (name === 't3') name = t3Cli({ platform, env, exists }) || name;
  // A .cmd/.bat spawns only through a shell (EINVAL without one, CVE-2024-27980), also with its full path (t3.cmd).
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(name) && /[\\/]/.test(name)) {
    const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
    return { file: [name, ...args].map(q).join(' '), args: [], shell: true };
  }
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
  return path.join(topicWorkDir(ctx.brainDir, ctx.projectDir, id), `topic-${id}-thread.md`);
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
  const input = topicThreadMessage(topic, { task, supervisor: supervisorOf(ctx.policy) });
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
 * Context of the repo a code topic changes (.tema.json `repo`, set with `project` by create --project, D-0035) when this
 * command runs in another project of the same brain (the persona brain): thread <id> started the thread in the persona's
 * T3 project and done --topic merged the copy into the persona repo (alice 2026-11-14, index-name: 'topic/index-name - not
 * something we can merge'). Otherwise ctx itself.
 */
export function topicRepoContext(ctx, topic) {
  const name = topic?.kind === 'code' ? topic.repo || topic.project : null;
  if (!name || !ctx.domain || path.basename(mainCheckout(ctx.projectDir)) === name) return ctx;
  const hit = domainRepos(ctx.domain).find((r) => r.name === name);
  if (!hit) return ctx;
  let repoCtx;
  try { repoCtx = loadContext({ project: hit.dir }); } catch { return ctx; }
  if (!repoCtx.brainDir || realPathLoose(repoCtx.brainDir) !== realPathLoose(ctx.brainDir)) return ctx;
  return repoCtx;
}

/**
 * New T3 thread for an existing topic nobody holds (P-036): the persona's main thread could not start the work of a topic
 * whose own thread never claimed it; mail has no address without a holder and t3_thread_send is not for other agents'
 * work (Bob 2026-11-03: thread of tracker-remote-verify stood on a question). A held topic is refused (takeover is P-037).
 */
export function startThreadForTopic(ctx, id, { task = null, mode, run, forThread = null, requestedBy = null } = {}) {
  guardThread(ctx, 'thread', { allowWake: true, codeStart: !forThread });
  requestedBy = threadRequester(requestedBy);
  if (!topicExists(ctx.brainDir, id)) throw new Error(`topic ${id} does not exist (archived or never created)`);
  const holder = readHolder(ctx.brainDir, id);
  if (holder.thread) return { ok: false, reason: `topic ${id} ${heldBy(holder)}; a new thread needs a free topic: write to the holder (comms send --to ${topicMailProject(ctx.brainDir, id) || commsProjectName(ctx)}/${id}) or ask the operator about a takeover (P-037)` };
  // The class comes from topic.json (D-0021); a topic from before the classes starts on the project's default model.
  let topic = readTopic(ctx.brainDir, id);
  // flow-public#87: a new task for the thread is kept with the topic (drift judge).
  const newTask = task && String(task).trim();
  // flow-public#87 and spec 3.4: the new task and who asked for the thread are kept with the topic.
  if ((newTask && topic.task !== newTask) || topic.thread_requested_by !== requestedBy) {
    topic = { ...topic, ...(newTask ? { task: newTask } : {}), thread_requested_by: requestedBy };
    brainWrite(ctx, { internal: true, ops: [topicOp(ctx.brainDir, id, topic)], message: `topic thread ${id} (requested by ${requestedBy})` });
  }
  // The thread of a repo topic starts in the repo's T3 project, as create --project does (D-0035).
  ctx = topicRepoContext(ctx, topic);
  // --for-thread: the thread was started by the T3 tool (fallback of a failed CLI start); it only gets the topic.
  if (forThread) return { ok: true, thread: String(forThread), claim: assignTopic(ctx, id, String(forThread), { mode }) };
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
    ops: [holderOp(ctx.brainDir, id, holder)],
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
      ops: [holderOp(ctx.brainDir, id, updated)],
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
    ops: [holderOp(ctx.brainDir, id, newHolder)],
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
    const remote = git(['show', `origin/${branch}:${topicRel(ctx.brainDir, id, 'holderFile')}`], { cwd: ctx.brainDir });
    try { holder = remote.ok ? holderFromText(ctx.brainDir, remote.stdout) : readHolder(ctx.brainDir, id); } catch { holder = {}; }
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
 * Main thread of a persona (P-045): permanent topic `main` (kind `main`) held by the persona's main thread.
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
          topicOp(ctx.brainDir, MAIN_TOPIC, topic),
          holderOp(ctx.brainDir, MAIN_TOPIC, {}),
          { path: topicRel(ctx.brainDir, MAIN_TOPIC, 'handover'), content: freeHandover() },
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
    ops: [holderOp(ctx.brainDir, id, {})],
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
  const write = brainWrite(ctx, { internal: true, ops: [topicOp(ctx.brainDir, id, next)], message: `topic pause ${id}${at ? ` until ${next.paused_until}` : ''}` });
  return { ok: true, topic: next, write };
}

export function resumeTopic(ctx, id) {
  guardThread(ctx, 'resume');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  if (topic.state !== 'paused') return { ok: true, already: true, topic };
  const { paused_at: _a, paused_until: _u, paused_reason: _r, ...rest } = topic;
  const next = { ...rest, state: 'working', updated: nowIso() };
  const write = brainWrite(ctx, { internal: true, ops: [topicOp(ctx.brainDir, id, next)], message: `topic resume ${id}` });
  return { ok: true, topic: next, write };
}

export const isPaused = (t) => t?.state === 'paused';

export function setTopicState(ctx, id, state) {
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  topic.state = state;
  topic.updated = nowIso();
  return topicOp(ctx.brainDir, id, topic);
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

export function ensureCodeCopy(ctx, id, { repo: repoName = null } = {}) {
  const copy = codeCopyPath(ctx, id, repoName);
  const branch = `topic/${id}`;
  // Spec 3.7, plan O16: each commit of the topic branch is pushed by the post-commit hook of the worktree (also one made
  // before the hook existed).
  if (fs.existsSync(path.join(copy, '.git'))) return { path: copy, branch, created: false, hook: installPushHook(copy) };
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  if (ctx.domain) {
    const repo = topicRepoDir(ctx, id, repoName);
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
    return { path: copy, branch, created: true, worktree: true, hook: installPushHook(copy) };
  }
  const clone = git(['clone', '--quiet', ctx.projectDir, copy]);
  if (!clone.ok) throw new Error(`clone of project into ${copy} failed: ${clone.stderr.split('\n')[0]}`);
  const existing = git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: copy });
  const checkout = existing.ok
    ? git(['checkout', '--quiet', '-b', branch, `origin/${branch}`], { cwd: copy })
    : git(['checkout', '--quiet', '-b', branch], { cwd: copy });
  if (!checkout.ok) throw new Error(`checkout ${branch} failed: ${checkout.stderr}`);
  return { path: copy, branch, created: true, hook: installPushHook(copy) };
}

/** Task name reserved by spec 4.6: `topic/<topic>--obsah` carries the non-code content of a protected target branch. */
export const RESERVED_TASKS = ['obsah'];

/** Worktree of task `task` of a topic: beside the topic's copy, `<topic>--<task>` (branch `topic/<topic>--<task>`, spec 3.7). */
export function taskCopyPath(ctx, topic, task) {
  return path.join(path.dirname(codeCopyPath(ctx, topic.id)), `${topic.id}--${task}`);
}

/** Existing task worktrees of a topic (folders `<topic>--<task>` with a .git beside its copy). */
export function taskCopyPaths(ctx, topic) {
  if (!hasCodeCopy(topic)) return [];
  const base = path.dirname(codeCopyPath(ctx, topic.id));
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names.filter((n) => n.startsWith(`${topic.id}--`) && fs.existsSync(path.join(base, n, '.git'))).map((n) => path.join(base, n));
}

/** The work topic with a code copy a task worktree belongs to: --topic <id>, else the one topic this thread holds. */
function taskTopic(ctx, asked, action) {
  guardThread(ctx, action, { allowWake: true });
  const held = heldTopics(ctx.brainDir, ctx.thread).filter((t) => !isMainTopic(t));
  const ids = held.map((t) => t.id).join(', ') || 'none';
  const topic = asked ? held.find((t) => t.id === String(asked)) : held.length === 1 ? held[0] : null;
  if (!topic) throw new Error(asked ? `this thread does not hold topic ${asked} (held: ${ids}); a task worktree belongs to a topic it holds (P-037)` : held.length ? `this thread holds ${held.length} topics (${ids}): pick one with --topic <id>` : 'this thread holds no work topic: a task worktree belongs to a topic it holds (P-037)');
  if (!hasCodeCopy(topic)) throw new Error(`topic ${topic.id} has no code copy: a task worktree branches off the topic branch (topic.mjs copy ${topic.id} first)`);
  return topic;
}

function checkTaskName(task) {
  if (!task || !isValidId(String(task)) || String(task).includes('--')) throw new Error(`task name "${task || ''}" must be lowercase letters, digits and single hyphens (it becomes topic/<topic>--<task>)`);
  if (RESERVED_TASKS.includes(String(task))) throw new Error(`task name ${task} is reserved: topic/<topic>--${task} carries the non-code content of a protected target branch (spec 4.6); choose another name`);
}

/**
 * Worktree of one task of the held topic (spec 3.7, plan B13): branch `topic/<topic>--<task>` from the topic branch (or the
 * one already pushed), beside the topic's copy, with the push hook of O16. Several implementing subagents run at once
 * only in separate task worktrees. Returns { path, branch, base, created }.
 */
export function taskCopy(ctx, task, { topic: asked = null } = {}) {
  checkTaskName(task);
  const topic = taskTopic(ctx, asked, 'task-copy');
  const base = ensureCodeCopy(ctx, topic.id);
  const dir = taskCopyPath(ctx, topic, task);
  const branch = `topic/${topic.id}--${task}`;
  if (fs.existsSync(path.join(dir, '.git'))) return { path: dir, branch, base: base.branch, created: false, hook: installPushHook(dir) };
  const cwd = base.path;
  if (git(['remote', 'get-url', 'origin'], { cwd }).ok) git(['fetch', '--quiet', 'origin'], { cwd });
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd }).ok;
  const remote = !local && git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd }).ok;
  const add = local ? git(['worktree', 'add', '--quiet', dir, branch], { cwd })
    : remote ? git(['worktree', 'add', '--quiet', '-b', branch, dir, `origin/${branch}`], { cwd })
      : git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, base.branch], { cwd });
  if (!add.ok) throw new Error(`git worktree add ${toPosix(dir)} (${branch}) failed: ${add.stderr.split('\n')[0]}`);
  return { path: dir, branch, base: base.branch, created: true, hook: installPushHook(dir) };
}

/**
 * After the topic thread checked the task (spec 3.7): merge `topic/<topic>--<task>` into the topic branch in the topic's copy,
 * push the topic branch, remove the task worktree, its branch and the branch on origin. Refused while the task worktree or
 * the topic copy has uncommitted changes, and on a merge conflict (the merge is aborted, nothing changes).
 * Returns { merged, sha, branch, lines }.
 */
export function taskMerge(ctx, task, { topic: asked = null } = {}) {
  checkTaskName(task);
  const topic = taskTopic(ctx, asked, 'task-merge');
  const base = codeCopyPath(ctx, topic.id);
  const into = `topic/${topic.id}`;
  const dir = taskCopyPath(ctx, topic, task);
  const branch = `${into}--${task}`;
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`topic ${topic.id} has no task worktree ${task} (${toPosix(dir)}): topic.mjs task-copy ${task} makes one`);
  if (!fs.existsSync(path.join(base, '.git'))) throw new Error(`the code copy of topic ${topic.id} (${toPosix(base)}) is missing: topic.mjs copy ${topic.id}`);
  const dirty = git(['status', '--porcelain'], { cwd: dir }).stdout;
  if (dirty.trim()) throw new Error(`task worktree ${toPosix(dir)} has changes that are not committed (${dirty.trim().split('\n').map((l) => l.slice(3)).slice(0, 5).join(', ')}): commit them on ${branch} after your check, or discard them; nothing merged`);
  const baseDirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: base }).stdout;
  if (baseDirty.trim()) throw new Error(`the topic copy ${toPosix(base)} has uncommitted changes (${baseDirty.trim().split('\n').map((l) => l.slice(3)).slice(0, 5).join(', ')}): commit or discard them first; nothing merged`);
  const ahead = Number(git(['rev-list', '--count', `${into}..${branch}`], { cwd: base }).stdout || 0);
  const lines = [];
  let sha = null;
  if (ahead) {
    const merge = git(['merge', '--no-ff', '--no-edit', '-m', `merge task ${task} into ${into}`, branch], { cwd: base });
    if (!merge.ok) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: base }).stdout.split('\n').filter(Boolean);
      git(['merge', '--abort'], { cwd: base });
      throw new Error(`merge of ${branch} into ${into} failed${files.length ? ` (conflict: ${files.join(', ')})` : `: ${merge.stderr.split('\n')[0]}`}; nothing merged, the task worktree stays: settle it on ${branch} (merge ${into} into it there), then task-merge again`);
    }
    sha = git(['rev-parse', '--short', 'HEAD'], { cwd: base }).stdout;
    lines.push(`merged ${branch} into ${into} (${ahead} commit(s), ${sha})`);
    const pushed = pushBranch(base, into);
    lines.push(pushed || (git(['remote', 'get-url', 'origin'], { cwd: base }).ok ? `${into} pushed` : `${into}: no remote origin, not pushed`));
  } else lines.push(`${branch} has no commit beyond ${into}: nothing to merge`);
  const remove = git(['worktree', 'remove', dir], { cwd: base });
  if (!remove.ok) throw new Error(`${lines.join('; ')}; task worktree ${toPosix(dir)} not removed: ${remove.stderr.split('\n')[0]}`);
  const del = git(['branch', '-d', branch], { cwd: base });
  lines.push(del.ok ? `task worktree and branch ${branch} removed` : `task worktree removed; branch ${branch} kept (${del.stderr.split('\n')[0]})`);
  if (git(['remote', 'get-url', 'origin'], { cwd: base }).ok && git(['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: base }).ok) {
    const gone = gitRemote(['push', '--quiet', 'origin', '--delete', branch], { cwd: base });
    lines.push(gone.ok ? `${branch} removed from origin` : `${branch} stays on origin (${gone.stderr.split('\n')[0]})`);
  }
  return { merged: ahead, sha, branch, lines };
}

/**
 * done --topic (spec 3.7, 4.1): the task worktrees and local task branches `topic/<topic>--*` of a topic end with it, run in
 * any checkout of the repo (the topic's copy or the repo). A task worktree with uncommitted changes stays (named); a local
 * task branch goes only when origin has its commits or the topic branch holds them, else it stays with the push command.
 * Branches on origin stay. Returns the lines to print.
 */
export function removeTaskCopies(dir, id) {
  const lines = [];
  const prefix = `topic/${id}--`;
  const origin = git(['remote', 'get-url', 'origin'], { cwd: dir }).ok;
  if (origin) gitRemote(['fetch', '--quiet', 'origin'], { cwd: dir });
  const kept = new Set();
  let cur = null;
  const worktrees = [];
  for (const line of git(['worktree', 'list', '--porcelain'], { cwd: dir }).stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; worktrees.push(cur); } else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  for (const wt of worktrees.filter((w) => w.branch?.startsWith(prefix))) {
    const dirty = fs.existsSync(wt.path) ? git(['status', '--porcelain'], { cwd: wt.path }).stdout.trim() : '';
    if (dirty) { kept.add(wt.branch); lines.push(`task worktree ${toPosix(wt.path)} kept: uncommitted changes (${dirty.split('\n').map((l) => l.replace(/^\s*\S{1,2}\s+/, '')).slice(0, 5).join(', ')}); commit and push them on ${wt.branch} or discard them, then remove it (git worktree remove)`); continue; }
    const rm = git(['worktree', 'remove', wt.path], { cwd: dir });
    if (!rm.ok) { kept.add(wt.branch); lines.push(`task worktree ${toPosix(wt.path)} not removed: ${rm.stderr.split('\n')[0]}`); continue; }
    lines.push(`task worktree ${toPosix(wt.path)} removed`);
  }
  const has = (ref) => git(['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).ok;
  const within = (sha, ref) => has(ref) && git(['merge-base', '--is-ancestor', sha, ref], { cwd: dir }).ok;
  const refs = git(['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', `refs/heads/${prefix}*`], { cwd: dir }).stdout.split('\n').filter(Boolean);
  for (const [branch, sha] of refs.map((l) => l.split(' '))) {
    if (kept.has(branch)) continue;
    const pushed = origin && within(sha, `refs/remotes/origin/${branch}`);
    if (!pushed && !within(sha, `refs/heads/topic/${id}`) && !within(sha, `refs/remotes/origin/topic/${id}`)) {
      lines.push(`task branch ${branch} kept: its commits are neither on origin nor in topic/${id}; push it (git -C ${toPosix(dir)} push origin ${branch}) or delete it (git -C ${toPosix(dir)} branch -D ${branch})`);
      continue;
    }
    const del = git(['branch', '-D', branch], { cwd: dir });
    lines.push(del.ok ? `task branch ${branch} removed${pushed ? ' (stays on origin)' : ` (in topic/${id})`}` : `task branch ${branch} not removed: ${del.stderr.split('\n')[0]}`);
  }
  return lines;
}

/**
 * Spec 4.2.3 (plan B5): the pushed topic branch and task branches `topic/<topic>` and `topic/<topic>--*` of every target repo,
 * for the comparison of a takeover with "Hotové" of the handover. One line per repo.
 */
export function pushedTopicBranches(ctx, topic) {
  const names = Array.isArray(topic?.repos?.list) && topic.repos.list.length ? topic.repos.list : topic?.repo ? [topic.repo] : [];
  if (!names.length) return [`pushed branches: topic ${topic.id} has no target repo (no code branch to compare)`];
  return names.map((name) => {
    const dir = ctx.domain && fs.existsSync(path.join(ctx.domain.root, name, '.git')) ? path.join(ctx.domain.root, name) : path.basename(mainCheckout(ctx.projectDir)) === name ? mainCheckout(ctx.projectDir) : null;
    if (!dir) return `pushed branches of ${name}: repo not found on this machine, not compared`;
    if (!git(['remote', 'get-url', 'origin'], { cwd: dir }).ok) return `pushed branches of ${name}: the repo has no remote origin, nothing pushed to compare`;
    const fetch = gitRemote(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir });
    if (!fetch.ok) return `pushed branches of ${name}: fetch failed (${fetch.stderr.split('\n')[0]}), not compared`;
    const refs = git(['for-each-ref', '--format=%(refname:lstrip=3) %(objectname:short) %(committerdate:short) %(subject)', `refs/remotes/origin/topic/${topic.id}`, `refs/remotes/origin/topic/${topic.id}--*`], { cwd: dir });
    const list = refs.stdout.split('\n').filter(Boolean);
    return `pushed branches of ${name}: ${list.length ? list.join('; ') : 'none'}`;
  });
}

/** Takeover report (spec 4.2.3): "Hotové" of the handover beside the pushed branches; on a mismatch ask the operator. */
export function takeoverLines(ctx, id) {
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) return [];
  const done = sectionItems(readText(path.join(topicDir(ctx.brainDir, id), layoutOf(ctx.brainDir).handover), ''), '## Hotové') || [];
  return [
    `takeover check (spec 4.2.3): compare "Hotové" of the handover with the files and with the pushed branches below; when they differ, ask the operator before going on`,
    `Hotové: ${done.filter((d) => d && d !== '-').join('; ') || '-'}`,
    ...pushedTopicBranches(ctx, topic),
  ];
}

/**
 * Target repos of a topic (spec 4.5, plan B11): `repos: { main, list }` in its .tema.json, the main one first by default;
 * only its holder sets them, each a repo of the domain (outside a domain only the session's repo). A topic with a code copy
 * gets its worktree in every one of them (topic/<id>). Returns { topic, repos, copies, write }.
 */
export function setTopicRepos(ctx, id, names, { main = null } = {}) {
  return withBrainLock(ctx.brainDir, () => setTopicReposUnlocked(ctx, id, names, { main }));
}

function setTopicReposUnlocked(ctx, id, names, { main }) {
  guardThread(ctx, 'repos');
  const list = [...new Set((names || []).map(String).filter(Boolean))];
  if (!list.length) throw new Error('usage: topic.mjs repos <id> <repo> [<repo> ...] [--main <repo>]');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  if (isMainTopic(topic)) throw new Error('topic main is the persona main thread: it has no target repos (P-045)');
  const holder = readHolder(ctx.brainDir, id);
  if (!isHolderOf(holder, ctx.thread)) throw new Error(`topic ${id} ${holder.thread ? heldBy(holder) : 'has no holder'}; only its holder sets its target repos (P-037)`);
  const known = ctx.domain ? domainRepos(ctx.domain, ctx.brainDir).map((r) => r.name) : ctx.projectDir ? [path.basename(mainCheckout(ctx.projectDir))] : [];
  const unknown = list.filter((n) => !known.includes(n));
  if (unknown.length) throw new Error(`topic repos ${id}: ${unknown.join(', ')} is no repo of ${ctx.domain ? `domain ${path.basename(ctx.domain.root)}` : 'this session'} (repos: ${known.join(', ') || 'none'}); nothing written`);
  const first = main ? String(main) : list[0];
  if (!list.includes(first)) throw new Error(`--main ${first} is not in the list (${list.join(', ')})`);
  const repos = { main: first, list: [first, ...list.filter((n) => n !== first)] };
  const write = brainWrite(ctx, { internal: true, ops: [fieldsOp(ctx.brainDir, id, { repos })], message: `topic repos ${id} ${repos.list.join(',')} by ${ctx.thread}` });
  const copies = hasCodeCopy(topic) && ctx.domain ? repos.list.map((name) => ensureCodeCopy(ctx, id, { repo: name })) : [];
  return { topic: { ...topic, repos }, repos, copies, write };
}

/** The topic is in mode discussion (spec 10.6): only the field `mode` decides, never class or kind (hooks, save handover). */
export function isDiscussionMode(topic) {
  return topic?.mode === 'discussion';
}

/** Refusal of a next step in a topic in mode discussion (spec 10.6: save handover --next, topic handoff --next). */
export const DISCUSSION_NEXT_REFUSAL = (topic, steps) => `handover not saved: topic ${topic} is in mode discussion (spec 10.6), its handover has no next step (given: "${steps.join('; ').slice(0, 160)}"). The open points of the discussion go into the reply and its state into Hotové; work for later goes into Otvorené otázky as a question. When the operator gives an order to work, end the mode first: topic.mjs mode ${topic} off, then save the step. Nothing written, the current handover stays`;

/**
 * Set the mode of a topic (spec 10.6): `discussion` when the operator says "we only discuss", `off` when they give an
 * order to work. Only the holder sets it; discussion is set only over a handover without a next step (the steps go to
 * Otvorené otázky first, as a question whether to go on with them). The class stays.
 */
export function setTopicMode(ctx, id, mode) {
  return withBrainLock(ctx.brainDir, () => setTopicModeUnlocked(ctx, id, mode));
}

function setTopicModeUnlocked(ctx, id, mode) {
  if (!MODES.includes(mode)) throw new Error(`usage: topic.mjs mode <id> ${MODES.join('|')}`);
  guardThread(ctx, 'mode');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist`);
  if (isMainTopic(topic)) throw new Error('topic main is the persona main thread: it has no mode (P-045)');
  const holder = readHolder(ctx.brainDir, id);
  if (!isHolderOf(holder, ctx.thread)) throw new Error(`topic ${id} ${holder.thread ? heldBy(holder) : 'has no holder'}; only its holder sets its mode (P-037)`);
  if (topic.mode === mode) return { ok: true, already: true, topic };
  if (mode === 'discussion') {
    const steps = handoverNextStep(readText(path.join(topicDir(ctx.brainDir, id), layoutOf(ctx.brainDir).handover), ''));
    if (steps === null) throw new Error(`topic ${id}: its handover has no section "## Ďalší krok" (P-011); save the handover with its six sections first`);
    if (steps.length) throw new Error(`topic ${id} has a next step in its handover ("${steps.join('; ').slice(0, 160)}"): mode discussion is set only over a handover without a step (spec 10.6). Move the steps into Otvorené otázky as a question whether to go on with them (save.mjs handover ${id} --next "" --questions "..."), then set the mode again`);
  }
  const write = brainWrite(ctx, { internal: true, ops: [fieldsOp(ctx.brainDir, id, { mode })], message: `topic mode ${id} ${mode} by ${ctx.thread}` });
  return { ok: true, topic: { ...topic, mode }, write };
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
  const write = brainWrite(ctx, { internal: true, ops: [topicOp(ctx.brainDir, id, next)], message: `topic copy ${id}${discussion ? ' (operator approved)' : ''} by ${ctx.thread}` });
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
    const write = brainWrite(ctx, { internal: true, ops: [topicOp(ctx.brainDir, id, next)], message: `topic implement ${id}: class ${cls}, model ${model} by ${ctx.thread}` });
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
