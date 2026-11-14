#!/usr/bin/env node
// Close a unit of work or a whole topic (P-029, P-005, P-006, P-011, P-020, P-036, P-044).
//   done.mjs [--topic-id <id>] --verified "<observation>" [--procedures a,b] [--derivations k1,k2]
//   done.mjs --list                       existing names in procedures.log / derivations.log
//   done.mjs --topic [--topic-id <id>] --verified "<observation>" [--keep-copy]
// A unit (no --topic) keeps the topic held by the thread; in a code topic it merges the topic branch into the main branch
// and keeps the copy (D-0011). --topic in a turn started by a message needs an answer of the operator in a dialog of it.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, git, nowIso } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, dialogAnsweredInTurn, inSubagent, foreignProjectCwd } from '../scripts/config.mjs';
import { brainWrite, brainSync, formatWriteResult, readHolder, isHolderOf } from '../scripts/brain.mjs';
import { freeHandover } from '../scripts/brain-checks.mjs';
import { recordNames, existingNames } from '../scripts/logs.mjs';
import { rejectedProposal } from '../scripts/find.mjs';
import { heldTopics, readTopic, freePointMail, hasCodeCopy, codeCopyPath } from '../scripts/topic.mjs';
import { registerTopic } from '../scripts/comms.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { asList } from '../scripts/frontmatter.mjs';
import { PROJECT_KNOWLEDGE, REPO_HANDOVER } from '../scripts/repo-knowledge.mjs';
import { scratchReminder, citedScratch, RESULTS_FILE } from '../scripts/materialy.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(s + '\n');

/** Since when files in scratch/ belong to this unit: the last done of the topic, else the claim (P-062). */
function unitStart(ctx, id, topic) {
  const t = Date.parse(topic?.last_done || readHolder(ctx.brainDir, id)?.since || '');
  return Number.isFinite(t) ? t : NaN;
}

function pickTopic(ctx) {
  if (args['topic-id']) return args['topic-id'];
  const all = heldTopics(ctx.brainDir, ctx.thread);
  // The persona main topic (P-045) is chosen only when the thread holds nothing else.
  const held = all.some((t) => t.kind !== 'main') ? all.filter((t) => t.kind !== 'main') : all;
  if (held.length === 1) return held[0].id;
  if (!held.length) {
    // A unit of work done in a thread without a topic is still closed (operator 2026-11-02: done kept bouncing back).
    if (!args.topic) return null;
    fail('this thread holds no topic: nothing to close with done --topic. Do not claim a topic (least of all main) just to close it; close the unit with done without --topic (P-026, P-037, P-045)');
  }
  fail(`this thread holds several topics (${held.map((t) => t.id).join(', ')}); pass --topic-id`);
}

function guard(ctx, id) {
  if (inSubagent()) fail('done refused in subagent (P-025)');
  if (!ctx.thread) fail('done needs a stable thread id (P-038)');
  brainSync(ctx.brainDir);
  const holder = readHolder(ctx.brainDir, id);
  if (!isHolderOf(holder, ctx.thread)) fail(`topic ${id} is held by ${holder.thread || 'nobody'}; only the holder closes it (P-037)`);
  if (!args.verified || args.verified === true) fail('state how the result was verified: --verified "<one observation>" (P-020)');
}

function guardThread(ctx) {
  if (inSubagent()) fail('done refused in subagent (P-025)');
  if (!ctx.thread) fail('done needs a stable thread id (P-038)');
  if (!args.verified || args.verified === true) fail('state how the result was verified: --verified "<one observation>" (P-020)');
}

// P-036: the closed thread leaves the active list. `settle` applies when the turn ends; `archive` of the own thread
// ends the provider stream at once and the turn fails (flow-public#6, seen on Windows and Linux).
const SETTLE_THREAD = 'thread: as the last step of this turn settle this thread (tool t3_thread_organize, action settle, no threadId); do not archive it, archiving the own thread fails the running turn (P-036)';

function doneUnit(ctx, id) {
  if (!id && !args.verified && !args.procedures && !args.derivations) {
    // Thread without a topic and without work in this context (e.g. after /clear): done just closes the thread,
    // nothing is recorded and nothing needs verifying (operator 2026-11-02: done after /clear asked what to close).
    if (inSubagent()) fail('done refused in subagent (P-025)');
    out('thread closed: no topic and no recorded work in this thread, nothing to write. Do not ask the operator what to close (P-059).');
    if (process.env.T3CODE_THREAD_ID) out(SETTLE_THREAD);
    return;
  }
  if (id) guard(ctx, id);
  else guardThread(ctx);
  const ops = [];
  const notes = [];
  const procedures = asList(args.procedures);
  const derivations = asList(args.derivations);
  const p = recordNames(ctx, 'procedures.log', procedures, { thread: ctx.thread });
  const d = recordNames(ctx, 'derivations.log', derivations, { thread: ctx.thread });
  ops.push(p.op, d.op);
  for (const [name, n] of p.counts) {
    if (n >= ctx.policy.thresholds.procedure_repeats && procedures.includes(name)) {
      notes.push(rejectedProposal(ctx.brainDir, name)
        ? `procedure ${name} ${n}x: skill was rejected earlier, no new proposal (P-005)`
        : `procedure ${name} ${n}x: create the skill yourself, no operator approval (name, trigger, steps, script): save skill <name> --origin routine --from-procedure ${name} (P-005)`);
    }
  }
  for (const [key, n] of d.counts) {
    if (n >= ctx.policy.thresholds.derivation_repeats && derivations.includes(key)) {
      notes.push(`derivation ${key} ${n}x: save the conclusion (save memory ... --origin derived --sources ...) and the log lines will be removed (P-006)`);
    }
  }
  if (!id) {
    // No topic: nothing to hand over; the logs still count procedures and derivations (P-005, P-006).
    const res = brainWrite(ctx, { ops, message: `done: unit of work done without a topic (verified: ${String(args.verified).slice(0, 60)})` });
    out(formatWriteResult(res, []));
    out('unit closed: this thread held no topic, so there is no handover. The next unit of work starts in a new session with its own topic (skill workflow:topic, P-026).');
    if (process.env.T3CODE_THREAD_ID) out(SETTLE_THREAD);
    for (const n of notes) out(n);
    return;
  }
  ops.push({ path: `topics/${id}/handover.md`, content: freeHandover() });
  // The topic stays held by this thread (D-0011: 22 of 27 web topics were micro-topics, their topic cycle was 44 % of the
  // calls); topic main is never free anyway (P-045). No state change, no free point; done --topic closes the topic.
  const topic = readTopic(ctx.brainDir, id);
  const main = topic?.kind === 'main';
  notes.unshift(scratchReminder(ctx.projectDir, unitStart(ctx, id, topic), id));
  // The verified code of the unit goes into the main branch before anything is written, so a failed merge writes nothing
  // (D-0011: 5 questions "may I merge?", each answered with the recommended option, 5 887 s of waiting).
  const merge = hasCodeCopy(topic) ? mergeCode(ctx, id, topic, { keepCopy: true, label: `done ${id}` }) : null;
  if (topic) ops.push({ path: `topics/${id}/topic.json`, content: JSON.stringify({ ...topic, last_done: nowIso() }, null, 2) + '\n' });
  const res = brainWrite(ctx, { ops, message: `done ${id}: unit of work done (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [`topics/${id}/handover.md`, `topics/${id}/topic.json`]));
  if (merge) out(merge.note);
  if (main) out(`topic main stays held by ${ctx.thread} (persona main thread, never free, P-045); handover reset.`);
  else out(`topic ${id} stays held by ${ctx.thread}; handover reset. A follow-up on the same work (a remark, a fix) is the next unit in this topic, not a new topic; done --topic closes it (D-0011).`);
  const mail = freePointMail(ctx, id, { record: false });
  if (mail) out(mail);
  for (const n of notes.filter(Boolean)) out(n);
  for (const w of buildIndexes(ctx.brainDir, ctx.policy).warnings) out(`limit: ${w}`);
}

/**
 * Uncommitted files of the main checkout that the topic branch brings with the same content: the settings that connect
 * generated in the checkout and the topic committed (.workflow.json untracked, .gitignore and settings modified) blocked
 * the merge (Windows instance 2026-11-07, adopt). Same blob as in the branch: set back, the merge writes it again.
 * Anything else stays and is reported.
 */
function setBackSameAsBranch(dir, branch) {
  if (!git(['rev-parse', '--verify', '--quiet', branch], { cwd: dir }).ok) return [];
  const inBranch = new Set(git(['diff', '--name-only', 'HEAD', branch], { cwd: dir }).stdout.split('\n').filter(Boolean));
  const tracked = git(['diff', '--name-only', 'HEAD'], { cwd: dir }).stdout.split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], { cwd: dir }).stdout.split('\n').filter(Boolean);
  const done = [];
  for (const f of [...new Set([...tracked, ...untracked])]) {
    if (!inBranch.has(f) || !fs.existsSync(path.join(dir, f))) continue;
    const want = git(['rev-parse', '--verify', '--quiet', `${branch}:${f}`], { cwd: dir });
    const have = git(['hash-object', '--', f], { cwd: dir });
    if (!want.ok || !have.ok || want.stdout !== have.stdout) continue;
    if (git(['cat-file', '-e', `HEAD:${f}`], { cwd: dir }).ok) git(['checkout', 'HEAD', '--', f], { cwd: dir });
    else { git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', f], { cwd: dir }); fs.rmSync(path.join(dir, f), { force: true }); }
    done.push(f);
  }
  return done;
}

function mergeCode(ctx, id, topic, { keepCopy = !!args['keep-copy'], label = `done --topic ${id}` } = {}) {
  // A copy that claim made (topic created without one, e.g. a report intake) has no recorded path: the path claim used.
  const copy = topic.copy ? path.resolve(ctx.projectDir, topic.copy) : codeCopyPath(ctx, id);
  const branch = `topic/${id}`;
  if (!fs.existsSync(path.join(copy, '.git'))) return { merged: false, note: `no code copy at ${copy}; nothing to merge` };
  const dirtyCopy = git(['status', '--porcelain', '--untracked-files=no'], { cwd: copy }).stdout;
  if (dirtyCopy) fail(`code copy ${copy} has uncommitted changes; commit or discard them in the copy first`);
  const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.projectDir }).stdout || 'main';
  // A legacy clone copy: its branch is fetched first, so the comparison sees what the merge brings.
  const isWorktree = fs.statSync(path.join(copy, '.git')).isFile();
  const ref = isWorktree ? branch : (git(['fetch', '--quiet', copy, branch], { cwd: ctx.projectDir }).ok ? 'FETCH_HEAD' : null);
  const setBack = ref ? setBackSameAsBranch(ctx.projectDir, ref) : [];
  if (setBack.length) out(`project checkout: ${setBack.length} uncommitted file(s) equal to ${branch} set back for the merge: ${setBack.slice(0, 5).join(', ')}${setBack.length > 5 ? ', …' : ''}`);
  const dirtyProject = git(['status', '--porcelain', '--untracked-files=no'], { cwd: ctx.projectDir }).stdout;
  if (dirtyProject) fail(`project checkout has uncommitted changes; commit or stash them before merging ${branch}: ${git(['diff', '--name-only', 'HEAD'], { cwd: ctx.projectDir }).stdout.split('\n').slice(0, 5).join(', ')}`);
  if (git(['remote', 'get-url', 'origin'], { cwd: ctx.projectDir }).ok) {
    const pull = git(['pull', '--ff-only', '--quiet', 'origin', mainBranch], { cwd: ctx.projectDir });
    if (!pull.ok) out(`note: project pull from origin failed (${pull.stderr.split('\n')[0]}); merging into local ${mainBranch}`);
  }
  // A worktree (v3) shares the repo: it merges the local main branch directly; a legacy clone fetches it from its origin.
  const worktree = fs.statSync(path.join(copy, '.git')).isFile();
  if (!worktree) {
    const fetch = git(['fetch', '--quiet', 'origin', mainBranch], { cwd: copy });
    if (!fetch.ok) fail(`fetch of ${mainBranch} into the copy failed: ${fetch.stderr}`);
  }
  const merge = git(['merge', '--quiet', '--no-edit', worktree ? mainBranch : 'FETCH_HEAD'], { cwd: copy });
  if (!merge.ok) {
    const files = git(['diff', '--name-only', '--diff-filter=U'], { cwd: copy }).stdout;
    git(['merge', '--abort'], { cwd: copy });
    fail(`merge of ${mainBranch} into ${branch} has conflicts in the copy: ${files.split('\n').join(', ')}; resolve them in ${copy}, verify, commit, then rerun`);
  }
  if (!worktree) {
    const fetchBranch = git(['fetch', '--quiet', copy, branch], { cwd: ctx.projectDir });
    if (!fetchBranch.ok) fail(`fetch of ${branch} from copy failed: ${fetchBranch.stderr}`);
  }
  // The repo HANDOVER is the project state (D-0002): a code topic that leaves it untouched is reported, not refused.
  const handoverRel = `${PROJECT_KNOWLEDGE}/${REPO_HANDOVER}`;
  const handoverDiff = git(['diff', '--name-only', `${mainBranch}...${worktree ? branch : 'FETCH_HEAD'}`, '--', handoverRel], { cwd: ctx.projectDir });
  if (handoverDiff.ok && !handoverDiff.stdout) out(`note: ${handoverRel} did not change in ${branch}; if the project state moved, update it (save.mjs handover --repo ${ctx.projectName} --file <file>, D-0002)`);
  const mergeMain = git(['merge', '--no-ff', '--quiet', '-m', `Merge ${branch} (${label})`, worktree ? branch : 'FETCH_HEAD'], { cwd: ctx.projectDir });
  if (!mergeMain.ok) {
    git(['merge', '--abort'], { cwd: ctx.projectDir });
    fail(`merge of ${branch} into ${mainBranch} failed: ${mergeMain.stderr}`);
  }
  if (!keepCopy) {
    // A worktree (v3) is removed through git, so the repo forgets it; its merged branch goes too. A legacy clone is a dir.
    if (worktree) {
      const rm = git(['worktree', 'remove', '--force', copy], { cwd: ctx.projectDir });
      // Windows: a shell standing in the copy holds it (EPERM, Windows instance 2026-11-07); the merge is done, rerun closes.
      if (!rm.ok) fail(`git worktree remove ${copy} failed: ${rm.stderr}${/EPERM|EBUSY|Permission denied|being used|Invalid argument/i.test(rm.stderr) ? `; a process has its working directory or a file open in the copy (a shell: cd ${ctx.projectDir}), then rerun done --topic ${id} (the merge is already done)` : ''}`);
      git(['branch', '-d', branch], { cwd: ctx.projectDir });
      try { fs.rmdirSync(path.dirname(copy)); } catch { /* other topics of the repo remain */ }
    } else fs.rmSync(copy, { recursive: true, force: true });
  }
  return { merged: true, note: `${branch} merged into ${mainBranch}${keepCopy ? '' : `; copy ${copy} removed`}` };
}

/** Reminder of scratch/ paths cited in the topic's worker results that still exist only there (D-0032 B1), or null. */
function citedResults(ctx, id) {
  let text = '';
  try { text = fs.readFileSync(path.join(ctx.brainDir, 'topics', 'archive', id, RESULTS_FILE), 'utf8'); } catch { return null; }
  const cited = ctx.projectDir ? citedScratch(ctx.projectDir, text) : [];
  if (!cited.length) return null;
  const shown = cited.slice(0, 5).join(', ') + (cited.length > 5 ? `, … (+${cited.length - 5})` : '');
  return `results: ${cited.length} scratch/ path(s) cited in worker results of ${id} exist only in scratch/ (not in git): ${shown}. Move data that cannot be fetched again to materialy/${id}/ (skill workflow:materialy); the rest may stay (D-0032)`;
}

/**
 * Threads that held the topic before a takeover (claim --force): `took_over_from` of holder.json and, from the claim
 * history (commits of topics/<id>/holder.json), the holder before each forced claim. Never this thread.
 */
function previousHolders(ctx, id, holder = {}) {
  const found = [];
  if (holder?.took_over_from) found.push(String(holder.took_over_from).split(' on ')[0]);
  const log = git(['log', '--reverse', '--format=%s', '--', `topics/${id}/holder.json`], { cwd: ctx.brainDir });
  let current = null;
  const claim = new RegExp(`^topic claim ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} by (\\S+)( \\(force)?`);
  for (const line of log.ok ? log.stdout.split('\n') : []) {
    const m = claim.exec(line);
    if (!m) continue;
    if (m[2] && current && current !== m[1]) found.push(current);
    current = m[1];
  }
  return [...new Set(found)].filter((t) => t && t !== ctx.thread);
}

function doneTopic(ctx, id) {
  guard(ctx, id);
  // An answer of the operator in a dialog of this turn is the operator's instruction, the message never is (P-047; D-0011:
  // the topic stayed open after 2 questions and 1 599 s).
  if (isWakeTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread)) fail('done --topic refused: this turn was started by a message, not the operator, and the operator answered no dialog in it: ask the operator with AskUserQuestion whether to close the topic (P-047, D-0011)');
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) fail(`topic ${id} does not exist`);
  if (topic.kind === 'main') fail('topic main is the persona main thread: it is never closed or archived (P-045)');
  const holder = readHolder(ctx.brainDir, id);
  let merge = { merged: false, note: 'discussion topic, no code' };
  if (hasCodeCopy(topic)) merge = mergeCode(ctx, id, topic);
  const closed = { ...topic, state: 'closed', closed: nowIso(), closed_by: ctx.thread, verified: String(args.verified), merged: merge.merged };
  const ops = [
    { from: `topics/${id}`, to: `topics/archive/${id}` },
    { path: `topics/archive/${id}/topic.json`, content: JSON.stringify(closed, null, 2) + '\n' },
    { path: `topics/archive/${id}/holder.json`, content: '{}\n' },
  ];
  const res = brainWrite(ctx, { ops, internal: true, message: `done --topic ${id}: archived (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [`topics/archive/${id}/`]));
  out(merge.note);
  out(`topic ${id} closed and archived. Start a new session for the next topic (P-026).`);
  const scratch = scratchReminder(ctx.projectDir, unitStart(ctx, id, topic), id);
  if (scratch) out(scratch);
  const cited = citedResults(ctx, id);
  if (cited) out(cited);
  // The mail closes the topic too: new mail gets 410 at once, waiting mail bounces to its senders (alice 2026-11-02).
  const comms = registerTopic(ctx, id, { close: true });
  if (comms.ok) out(`mail: topic ${id} closed in the mail service (new mail refused, waiting mail returned to the senders)`);
  else if (!comms.skipped) out(`mail: closing ${id} in the mail service failed (${comms.reason}); the next session start retries`);
  // P-036: the topic's T3 thread is settled with the topic (only inside T3). A thread that also holds the persona main
  // topic is never settled or archived (P-045; alice 2026-11-02: main stayed held by an archived thread and @alice/main went unread).
  // The thread is settled only when it holds no other open topic after this one.
  const held = heldTopics(ctx.brainDir, ctx.thread);
  const holdsMain = held.some((t) => t.kind === 'main');
  if (holdsMain) out('thread: this thread holds the persona main topic, so it stays open: do not settle or archive it (P-045)');
  else if (held.length) out(`thread: this thread still holds topic ${held.map((t) => t.id).join(', ')}, so it stays open: do not settle or archive it (P-036)`);
  else if (process.env.T3CODE_THREAD_ID) out(SETTLE_THREAD);
  // A topic taken over (claim --force) leaves the previous holder's thread open in T3: settle it too. The t3 CLI has no
  // settle (t3 thread: list, start, send, show), so done names the step.
  for (const prev of previousHolders(ctx, id, holder)) out(`thread: settle the previous holder thread ${prev} (t3_thread_organize action settle threadId ${prev}; an archived thread first unarchive)`);
  for (const w of buildIndexes(ctx.brainDir, ctx.policy).warnings) out(`limit: ${w}`);
}

try {
  const ctx = loadContext({ project: args.project });
  const foreign = foreignProjectCwd(ctx, args.project);
  if (foreign) fail(foreign);
  if (args.list) {
    const p = existingNames(ctx.brainDir, 'procedures.log');
    const d = existingNames(ctx.brainDir, 'derivations.log');
    out(`procedures: ${p.length ? p.map((n) => `${n.name} ${n.count}x`).join(', ') : 'none'}`);
    out(`derivations: ${d.length ? d.map((n) => `${n.name} ${n.count}x`).join(', ') : 'none'}`);
  } else {
    const id = pickTopic(ctx);
    if (args.topic) doneTopic(ctx, id);
    else doneUnit(ctx, id);
  }
} catch (err) {
  fail(err.message);
}
