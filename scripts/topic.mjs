// Topics: create, claim, release, list (P-036, P-037, P-045, P-047).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { git, readJson, nowIso, relPosix } from './util.mjs';
import { isWakeTurn, machineName, sameMachine, inSubagent, readThreadState, writeThreadState, mainCheckout, WORKTREES_DIR } from './config.mjs';
import { brainWrite, brainSync, readHolder, currentBranch, withBrainLock, isHolderOf } from './brain.mjs';
import { freeHandover, renderHandover, checkHandover } from './brain-checks.mjs';
import { pendingBuffers, flushBuffer } from './logs.mjs';
import { readTopics } from './records.mjs';
import { isValidId } from './keys.mjs';
import { registerTopic, mailCount, mailLines, isMainTopic, MAIN_TOPIC, runClient, commsConfigured } from './comms.mjs';

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
 * Where a code topic works. In a domain (v3, D-0002): a git worktree `<domain>/.worktrees/<repo>/<topic>/` of the
 * project's main checkout, inside the write boundary and sharing the repo's objects. Without a domain (not migrated
 * yet): the legacy clone `../<project>-topics/<topic>/`.
 */
export function codeCopyPath(ctx, id) {
  if (ctx.domain) return path.join(ctx.domain.root, WORKTREES_DIR, path.basename(mainCheckout(ctx.projectDir)), id);
  return path.resolve(ctx.projectDir, '..', `${ctx.projectName}-topics`, id);
}

function guardThread(ctx, action, { allowWake = false } = {}) {
  if (inSubagent()) throw new Error(`topic ${action} refused in subagent (P-025)`);
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

function createTopicUnlocked(ctx, { id, subject, kind = 'discussion', mode, claim = true, copy = true, forThread = null, newThread = false, task = null, explicitProject = false }) {
  if (!isValidId(id)) throw new Error(`topic id "${id}" must be lowercase letters, digits and hyphens (P-036)`);
  if (id === MAIN_TOPIC) throw new Error('topic id "main" is reserved for the persona main thread: use topic.mjs main (P-045)');
  if (!subject || !String(subject).trim()) throw new Error('topic needs --subject "<one sentence>" (P-045)');
  if (!['code', 'discussion'].includes(kind)) throw new Error('kind must be code or discussion');
  // A persona has no project code (P-025): a code topic from its session without --project went to the persona repo
  // instead of the managed project (bob 2026-11-03, t3-workarounds-check in bob, not the managed project).
  if (kind === 'code' && !explicitProject && isPersonaProject(ctx)) throw new Error(`code topic ${id} would be created in persona project ${path.basename(ctx.projectDir)}: a persona has no project code (P-025). Pass --project <managed project dir> (or --project ${ctx.projectDir} if the persona repo itself is the code)`);
  guardThread(ctx, 'create');
  if (topicExists(ctx.brainDir, id) || fs.existsSync(path.join(ctx.brainDir, 'topics', 'archive', id))) throw new Error(`topic ${id} already exists`);
  const topic = { id, subject: String(subject).trim(), kind, state: 'working', created: nowIso() };
  // The creating thread may clean up its own topic (test, mistake) without operator approval (P-018).
  if (ctx.thread) topic.created_by = ctx.thread;
  if (kind === 'code') {
    topic.copy = relPosix(ctx.projectDir, codeCopyPath(ctx, id));
    topic.repo = path.basename(mainCheckout(ctx.projectDir)); // the repo the topic changes (v3: one domain, several repos)
  }
  const res = brainWrite(ctx, {
    internal: true,
    ops: [
      { path: `topics/${id}/topic.json`, content: JSON.stringify(topic, null, 2) + '\n' },
      { path: `topics/${id}/holder.json`, content: '{}\n' },
      { path: `topics/${id}/handover.md`, content: freeHandover() },
    ],
    message: `topic create ${id}`,
  });
  const out = { topic, write: res, claim: null, copy: null, thread: null };
  if (newThread && !forThread) {
    // P-036: a new topic gets its own T3 thread titled by the topic; its first message shows what the topic holds, so the
    // operator does not have to prompt it (alice 2026-11-02). Failure keeps the topic free and says why.
    const started = startTopicThread(ctx, topic, undefined, { task });
    if (!started.ok) { out.claim = { ok: false, reason: `topic ${id} created, but no thread was started (${started.reason}); ${started.fallback}; or claim it here with topic.mjs claim ${id}` }; return out; }
    out.thread = started.thread;
    forThread = started.thread;
  }
  if (forThread) {
    // Topic for a new thread (P-037): the new thread holds it from its first turn, so its status block shows the topic
    // instead of `Téma: žiadna` (Bob 2026-11-01: topic beszel created for a new thread that then asked for a topic).
    out.claim = assignTopic(ctx, id, String(forThread), { mode });
    if (kind === 'code' && copy) out.copy = ensureCodeCopy(ctx, id);
    return out;
  }
  if (claim) {
    out.claim = claimTopic(ctx, id, { mode });
    if (!out.claim.ok) return out;
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
    `Téma ${topic.id} (${topic.kind}) je pridelená tomuto vláknu.`,
    `Predmet: ${topic.subject}`,
    ...(topic.copy ? [`Kópia kódu: ${topic.copy}`] : []),
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

/** T3-WORKAROUND(t3-cli-title) Start a T3 thread for the topic via `topics.thread_start_command` (default `t3 thread start --json`); returns its id. */
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
  const t = spawnTarget(cmd[0], [...cmd.slice(1), '--title', topic.id, ctx.projectDir, '-'], { platform });
  const r = run(t.file, t.args, { encoding: 'utf8', input, timeout: 30000, shell: t.shell });
  if (r.error || r.status !== 0) return failed((r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]);
  let thread = null;
  try {
    const d = JSON.parse(r.stdout);
    thread = d?.threadId ?? d?.thread?.threadId ?? d?.thread?.id ?? d?.id ?? null;
  } catch { thread = String(r.stdout || '').trim().split(/\s+/)[0] || null; }
  if (!thread || !/^[A-Za-z0-9._:-]{1,200}$/.test(thread)) return failed(`no thread id in output of ${cmd.join(' ')}`);
  return { ok: true, thread };
}

/**
 * New T3 thread for an existing topic nobody holds (P-036): the persona's main thread could not start the work of a topic
 * whose own thread never claimed it; mail has no address without a holder and t3_thread_send is not for other agents'
 * work (Bob 2026-11-03: thread of tracker-remote-verify stood on a question). A held topic is refused (takeover is P-037).
 */
export function startThreadForTopic(ctx, id, { task = null, mode, run, forThread = null } = {}) {
  guardThread(ctx, 'thread');
  if (!topicExists(ctx.brainDir, id)) throw new Error(`topic ${id} does not exist (archived or never created)`);
  const holder = readHolder(ctx.brainDir, id);
  if (holder.thread) return { ok: false, reason: `topic ${id} ${heldBy(holder)}; a new thread needs a free topic: write to the holder (comms send --to ${id}) or ask the operator about a takeover (P-037)` };
  // --for-thread: the thread was started by the T3 tool (fallback of a failed CLI start); it only gets the topic.
  if (forThread) return { ok: true, thread: String(forThread), claim: assignTopic(ctx, id, String(forThread), { mode }) };
  const topic = readTopic(ctx.brainDir, id);
  const started = startTopicThread(ctx, topic, run, { task });
  if (!started.ok) return { ok: false, reason: `no thread was started (${started.reason}); ${started.fallback}` };
  const claim = assignTopic(ctx, id, started.thread, { mode });
  return { ok: true, thread: started.thread, claim };
}

/** Holder of a just-created topic is another (new) thread; the topic has no holder yet, so no takeover is possible. */
function assignTopic(ctx, id, thread, { mode } = {}) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(thread)) throw new Error(`--for-thread "${thread}" is not a thread id`);
  const policyMode = ctx.policy?.topics?.default_holder_mode || 'operator';
  const holder = { thread, machine: machineName(), mode: mode || policyMode, since: nowIso(), assigned_by: ctx.thread };
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
        : git(['worktree', 'add', '--quiet', '-b', branch, copy], { cwd: repo });
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

export function listTopics(brainDir) {
  return readTopics(brainDir);
}

export function heldTopics(brainDir, thread) {
  if (!thread) return [];
  // Work topics first: the main topic (P-045) is the fallback, so a main thread working on a topic shows that topic.
  const held = readTopics(brainDir).filter((t) => isHolderOf(t.holder, thread));
  return [...held.filter((t) => !isMainTopic(t)), ...held.filter(isMainTopic)];
}
