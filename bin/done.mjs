#!/usr/bin/env node
// Close a unit of work or a whole topic (P-029, P-005, P-006, P-011, P-020, P-036, P-044).
//   done.mjs [--topic-id <id>] --verified "<observation>" [--procedures a,b] [--derivations k1,k2]
//   done.mjs --list                       existing names in procedures.log / derivations.log
//   done.mjs --topic [--topic-id <id>] --verified "<observation>" --knowledge "<what of the topic is written with save | nic nové>"
//            [--keep-copy] [--triage <file>]
//     layout 3 (flow v2 spec 5, 4.1, 4.6): a topic with files in topics/<id>/ outside tmp/ is not closed without --triage:
//     done lists them; each gets "<typ> <path>" (an output to vystupy/<typ>/ of the main target repo, the topic in its
//     header), "novy:<typ> <path>" (a new type: the operator approves it in a dialog of the turn), "zanikne <path>" or
//     "nejasne <path>" (a question to the operator; nothing moves). Then the topic branch is merged into the target branch
//     of every target repo in turn (the own clone of the workflow); a failed one leaves the topic open with the step
//     "dokončiť zlúčenie <repo>". A protected target branch is not merged: done asks for the merge of topic/<id> and
//     topic/<id>--obsah (gh pull request, else the exact command), writes it into Úlohy pre operátora and the topic stays
//     open until the merge; then done --topic again. Closed, topics/<id>/ ends (removed in git, no archive).
//   done.mjs --topic --cancel [--topic-id <id>]   layout 3, only on the operator's instruction (spec 5.4): no triage, no
//     merge; topics/<id>/ and the worktrees end, the topic branch stays on origin; sources only on topic/<id>--obsah get a
//     merge request first (the topic stays open until it is merged)
//   A topic in mode discussion is closed only on the operator's instruction (spec 10.6 item 4, 5.2).
//   done.mjs --archive-closed [--project <brain>] [--dry-run]   (layout 2, the hidden archive)
//     layout 2: topics closed before that (state closed in temy/<id>/, only handover.md and .tema.json, no file in tmp/)
//     move to .brain/archive/topics/<id>/ in one commit with INDEX.md; closed topics with other work are only listed.
//     --dry-run lists without moving; --project takes the brain itself (a domain brain) or a project of it.
// A unit (no --topic) keeps the topic held by the thread; in a code topic it merges the topic branch into the main branch
// and keeps the copy (D-0011). --topic in a turn started by a message needs an answer of the operator in a dialog of it,
// unless the message was the supervisor's instruction (plan O7: done within the mandate, spec 5.2).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, nowIso, git, gitRemote } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, supervisorTurn, dialogAnsweredInTurn, inSubagent, foreignProjectCwd, resolveBrain, threadId, loadPolicy, brainScriptEnv } from '../scripts/config.mjs';
import { brainWrite, brainSync, formatWriteResult, readHolder, isHolderOf } from '../scripts/brain.mjs';
import { freeHandover, renderHandover, sectionItems, QUESTIONS_SECTION, TASKS_SECTION } from '../scripts/brain-checks.mjs';
import { mergeWithIndex, INDEX_FILE, refreshIndex } from '../scripts/data-index.mjs';
import { closedTopicsPlan, archiveClosed, formatClosedPlan } from '../scripts/archive-closed.mjs';
import { recordNames, existingNames } from '../scripts/logs.mjs';
import { rejectedProposal } from '../scripts/find.mjs';
import { heldTopics, readTopic, freePointMail, hasCodeCopy, codeCopyPath, topicRel, topicOp, holderOp, closedTopicDir, topicRepoContext, isDiscussionMode, removeTaskCopies } from '../scripts/topic.mjs';
import { dataPath, dataRel, layoutOf, topicHome, topicWorkLabel, hasData } from '../scripts/layout.mjs';
import { registerTopic } from '../scripts/comms.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { bellContinuation } from '../scripts/waker.mjs';
import { asList } from '../scripts/frontmatter.mjs';
import { PROJECT_KNOWLEDGE, REPO_HANDOVER } from '../scripts/repo-knowledge.mjs';
import { scratchReminder, citedScratch, topicResultsLabel } from '../scripts/materialy.mjs';
import { resultsActive, syncResults, citedWork, tmpOwner, savedLine, countFiles } from '../scripts/results.mjs';
import { readTopics } from '../scripts/records.mjs';
import { topicFiles, handoverTask, confirmRefusal, bellRefusal, ownStepRequested, removeTopicTmp, parseTypeTriage, typeTriageListing, UNCLEAR, NEW_TYPE } from '../scripts/triage.mjs';
import { hasTypeTriage, targetRepos, targetRepoDir, targetBranch, targetProtected, topicBranch, contentBranch, contentWrite, contentWhere, outputTypes, withTopicHeader, onOrigin, mergedInto, mergeRequest } from '../scripts/target.mjs';
import { cloneMerge } from '../scripts/own-clone.mjs';
import { mergeRefusal } from '../scripts/topic-branches.mjs';
import { pushBranch } from '../scripts/push-hook.mjs';

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
  ops.push({ path: topicRel(ctx.brainDir, id, 'handover'), content: freeHandover() });
  // The topic stays held by this thread (D-0011: 22 of 27 web topics were micro-topics, their topic cycle was 44 % of the
  // calls); topic main is never free anyway (P-045). No state change, no free point; done --topic closes the topic.
  const topic = readTopic(ctx.brainDir, id);
  const main = topic?.kind === 'main';
  notes.unshift(scratchReminder(ctx.projectDir, unitStart(ctx, id, topic), id, ctx.brainDir));
  // The verified code of the unit goes into the main branch before anything is written, so a failed merge writes nothing
  // (D-0011: 5 questions "may I merge?", each answered with the recommended option, 5 887 s of waiting).
  // Layout 3 (spec 4.1): into the target branch of every target repo through the own clone; the copies stay.
  const merge = !hasCodeCopy(topic) ? null : hasTypeTriage(ctx.brainDir) ? unitMerge3(ctx, id, topic) : mergeCode(ctx, id, topic, { keepCopy: true, label: `done ${id}` });
  if (topic) ops.push(topicOp(ctx.brainDir, id, { ...topic, last_done: nowIso() }));
  const res = brainWrite(ctx, { ops, message: `done ${id}: unit of work done (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [topicRel(ctx.brainDir, id, 'handover'), topicRel(ctx.brainDir, id, 'topicFile')]));
  if (merge) out(merge.note);
  if (main) out(`topic main stays held by ${ctx.thread} (persona main thread, never free, P-045); handover reset.`);
  else out(`topic ${id} stays held by ${ctx.thread}; handover reset. A follow-up on the same work (a remark, a fix) is the next unit in this topic, not a new topic; done --topic closes it (D-0011).`);
  const mail = freePointMail(ctx, id, { record: false });
  if (mail) out(mail);
  for (const n of notes.filter(Boolean)) out(n);
  for (const w of buildIndexes(ctx.brainDir, ctx.policy).warnings) out(`limit: ${w}`);
}

/** done (unit) of a code topic in layout 3: the topic branch of every target repo merged, the copies kept; a failure stops it. */
function unitMerge3(ctx, id, topic) {
  const settled = settleRepos(ctx, id, topic, targetRepos(ctx, topic).list, { unit: true });
  if (settled.failures.length) fail(`done ${id}: nothing written into brain${settled.lines.length ? ` (${settled.lines.join('; ')})` : ''}: ${settled.failures.map((f) => `${f.repo}: ${f.error}`).join('; ')}; settle it and run done again`);
  return { merged: true, note: settled.lines.join('\n') || 'nothing to merge' };
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

/** origin/<branch> and the local branch each have commits the other lacks; false when origin is unreachable. */
function divergedFromOrigin(dir, branch) {
  if (!git(['fetch', '--quiet', 'origin', branch], { cwd: dir }).ok) return false;
  const remote = git(['rev-parse', 'FETCH_HEAD'], { cwd: dir }).stdout;
  const ancestor = (a, b) => git(['merge-base', '--is-ancestor', a, b], { cwd: dir }).ok;
  return !!remote && !ancestor(remote, 'HEAD') && !ancestor('HEAD', remote);
}

function mergeCode(ctx, id, topic, { keepCopy = !!args['keep-copy'], label = `done --topic ${id}`, push = false } = {}) {
  // A copy that claim made (topic created without one, e.g. a report intake) has no recorded path: the path claim used.
  const copy = topic.copy ? path.resolve(ctx.projectDir, topic.copy) : codeCopyPath(ctx, id);
  const branch = `topic/${id}`;
  if (!fs.existsSync(path.join(copy, '.git'))) return { merged: false, note: `no code copy at ${copy}; nothing to merge` };
  const dirtyCopy = git(['status', '--porcelain', '--untracked-files=no'], { cwd: copy }).stdout;
  if (dirtyCopy) fail(`code copy ${copy} has uncommitted changes; commit or discard them in the copy first`);
  const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.projectDir }).stdout || 'main';
  // done --topic pushes the main branch after the merge (2026-11-14: 4 topics left it ahead of origin); a diverged origin
  // is found before anything changes, so the merge and the push wait for the operator's decision.
  const hasOrigin = git(['remote', 'get-url', 'origin'], { cwd: ctx.projectDir }).ok;
  if (push && hasOrigin && divergedFromOrigin(ctx.projectDir, mainBranch)) fail(`origin/${mainBranch} diverged from local ${mainBranch} in ${ctx.projectDir}: nothing merged, ${mainBranch} not pushed, topic ${id} stays open; reconcile ${mainBranch} with origin/${mainBranch}, then rerun done --topic`);
  // A legacy clone copy: its branch is fetched first, so the comparison sees what the merge brings.
  const isWorktree = fs.statSync(path.join(copy, '.git')).isFile();
  const ref = isWorktree ? branch : (git(['fetch', '--quiet', copy, branch], { cwd: ctx.projectDir }).ok ? 'FETCH_HEAD' : null);
  const setBack = ref ? setBackSameAsBranch(ctx.projectDir, ref) : [];
  if (setBack.length) out(`project checkout: ${setBack.length} uncommitted file(s) equal to ${branch} set back for the merge: ${setBack.slice(0, 5).join(', ')}${setBack.length > 5 ? ', …' : ''}`);
  const dirtyProject = git(['status', '--porcelain', '--untracked-files=no'], { cwd: ctx.projectDir }).stdout;
  if (dirtyProject) fail(`project checkout has uncommitted changes; commit or stash them before merging ${branch}: ${git(['diff', '--name-only', 'HEAD'], { cwd: ctx.projectDir }).stdout.split('\n').slice(0, 5).join(', ')}`);
  let pulled = false;
  if (hasOrigin) {
    const pull = git(['pull', '--ff-only', '--quiet', 'origin', mainBranch], { cwd: ctx.projectDir });
    pulled = pull.ok;
    if (!pull.ok) out(`note: project pull from origin failed (${pull.stderr.split('\n')[0]}); merging into local ${mainBranch}${push ? `, ${mainBranch} not pushed` : ''}`);
  }
  // A worktree (v3) shares the repo: it merges the local main branch directly; a legacy clone fetches it from its origin.
  const worktree = fs.statSync(path.join(copy, '.git')).isFile();
  if (!worktree) {
    const fetch = git(['fetch', '--quiet', 'origin', mainBranch], { cwd: copy });
    if (!fetch.ok) fail(`fetch of ${mainBranch} into the copy failed: ${fetch.stderr}`);
  }
  // Layout 2: INDEX.md is written again after the merge, not merged by lines (scripts/data-index.mjs).
  const merge = mergeWithIndex(copy, ['--quiet', '--no-edit', worktree ? mainBranch : 'FETCH_HEAD']);
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
  const handoverRel = dataRel(ctx.projectDir, 'projectKnowledge', dataRel(dataPath(ctx.projectDir, 'projectKnowledge'), 'repoHandover'));
  const handoverDiff = git(['diff', '--name-only', `${mainBranch}...${worktree ? branch : 'FETCH_HEAD'}`, '--', handoverRel], { cwd: ctx.projectDir });
  if (handoverDiff.ok && !handoverDiff.stdout) out(`note: ${handoverRel} did not change in ${branch}; if the project state moved, update it (save.mjs handover --repo ${ctx.projectName} --file <file>, D-0002)`);
  const mergeMain = mergeWithIndex(ctx.projectDir, ['--no-ff', '--quiet', '-m', `Merge ${branch} (${label})`, worktree ? branch : 'FETCH_HEAD']);
  if (!mergeMain.ok) {
    git(['merge', '--abort'], { cwd: ctx.projectDir });
    fail(`merge of ${branch} into ${mainBranch} failed: ${mergeMain.stderr}`);
  }
  let pushNote = '';
  if (push && pulled) {
    // Without --force: git refuses anything but a fast-forward of origin.
    const pushed = git(['push', '--quiet', 'origin', mainBranch], { cwd: ctx.projectDir });
    if (!pushed.ok) fail(`push of ${mainBranch} to origin failed (${pushed.stderr.split('\n')[0]}): ${branch} is merged into local ${mainBranch}, not pushed; topic ${id} stays open; reconcile with origin/${mainBranch}, push, then rerun done --topic`);
    pushNote = `; pushed ${mainBranch} to origin`;
  }
  if (!keepCopy) {
    // The task worktrees and local task branches end with the topic (spec 3.7); pushed ones stay on origin.
    for (const line of removeTaskCopies(worktree ? ctx.projectDir : copy, id)) out(line);
    // A worktree (v3) is removed through git, so the repo forgets it; its merged branch goes too. A legacy clone is a dir.
    if (worktree) {
      const rm = git(['worktree', 'remove', '--force', copy], { cwd: ctx.projectDir });
      // Windows: a shell standing in the copy holds it (EPERM, Windows instance 2026-11-07); the merge is done, rerun closes.
      if (!rm.ok) fail(`git worktree remove ${copy} failed: ${rm.stderr}${/EPERM|EBUSY|Permission denied|being used|Invalid argument/i.test(rm.stderr) ? `; a process has its working directory or a file open in the copy (a shell: cd ${ctx.projectDir}), then rerun done --topic ${id} (the merge is already done)` : ''}`);
      git(['branch', '-d', branch], { cwd: ctx.projectDir });
      try { fs.rmdirSync(path.dirname(copy)); } catch { /* other topics of the repo remain */ }
    } else fs.rmSync(copy, { recursive: true, force: true });
  }
  return { merged: true, note: `${branch} merged into ${mainBranch}${pushNote}${keepCopy ? '' : `; copy ${copy} removed`}` };
}

/**
 * Reminder of work file paths cited in the topic's worker results that still exist only there (D-0032 B1), or null. The
 * work files are in the topic home (a brain in layout 2, D-0056); data from outside goes to the sources of the project
 * repo, a result of the work to the work of the topic.
 */
function citedResults(ctx, id) {
  let text = '';
  try { text = fs.readFileSync(path.join(closedTopicDir(ctx.brainDir, id), layoutOf(ctx.brainDir).results), 'utf8'); } catch { return null; }
  const home = ctx.projectDir ? topicHome(ctx.brainDir, ctx.projectDir) : null;
  const cited = home ? citedScratch(home, text) : [];
  if (!cited.length) return null;
  const shown = cited.slice(0, 5).join(', ') + (cited.length > 5 ? `, … (+${cited.length - 5})` : '');
  const work = topicWorkLabel(ctx.brainDir, ctx.projectDir, id);
  // A brain of layout 3 as its own project keeps no sources (spec 4): only the results of the topic.
  const sources = hasData(ctx.projectDir, 'materialy') ? `${dataRel(ctx.projectDir, 'materialy', id)}/` : null;
  const results = topicResultsLabel(ctx.brainDir, ctx.projectDir, id);
  const where = results === sources || !sources ? results : `${sources} (data from outside, save.mjs source) or ${results} (a result of the work, save.mjs result)`;
  return `results: ${cited.length} ${work} path(s) cited in worker results of ${id} exist only in ${work} (not in git): ${shown}. Move data that cannot be fetched again to ${where} (skill workflow:save); the rest may stay (D-0032)`;
}

/**
 * Threads that held the topic before a takeover (claim --force): `took_over_from` of holder.json and, from the claim
 * history (commits of topics/<id>/holder.json), the holder before each forced claim. Never this thread.
 */
/**
 * P-078 (operator 2026-11-17: "pointa flow je, aby sa dôležité dáta a vedomosti ukladali, aby nedošlo k strate dôležitej
 * práce"): done --topic removes the work files of the topic (outside git). First the results of the topic bound to their
 * work files are synced (a source changed since the last turn) and the work files its handover cites or that were shown to
 * the operator are saved (`own`, not for --cancel); the work files of this topic another open topic cites in its handover
 * are saved into that topic. A cited folder of these work files refuses the close: the agent saves what of it is needed
 * and rewrites the line of the handover. What was saved is written before the refusal.
 */
function saveBeforeClose(ctx, id, { own = true } = {}) {
  if (!resultsActive(ctx.brainDir)) return;
  const mine = (abs) => tmpOwner(ctx.brainDir, abs)?.topic === id;
  const writes = [];
  const dirs = [];
  if (own) {
    const res = syncResults(ctx.brainDir, id, { policy: ctx.policy });
    if (res.ops.length) writes.push({ id, res });
    for (const d of res.dirs.filter(mine)) dirs.push({ by: id, dir: d });
  }
  for (const t of readTopics(ctx.brainDir).filter((x) => x.id !== id && x.state !== 'closed')) {
    const cited = citedWork(ctx.brainDir, t.id, t.handover);
    for (const d of cited.dirs.filter(mine)) dirs.push({ by: t.id, dir: d });
    const files = cited.files.filter(mine);
    if (!files.length) continue;
    const res = syncResults(ctx.brainDir, t.id, { policy: ctx.policy, handover: t.handover, extra: files.map((abs) => ({ abs, via: 'handover' })) });
    if (res.ops.length) writes.push({ id: t.id, res });
  }
  if (writes.length) {
    const res = brainWrite(ctx, { ops: writes.flatMap((w) => w.res.ops), internal: true, message: `done --topic ${id}: results saved from the work files before they end (P-078)` });
    out(formatWriteResult(res, writes.flatMap((w) => w.res.saved.map((s) => topicRel(ctx.brainDir, w.id, null) + '/' + s.name))));
    for (const w of writes) { const line = savedLine(w.id, w.res); if (line) out(line); }
  }
  if (dirs.length) {
    const rel = (abs) => path.relative(ctx.brainDir, abs).split(path.sep).join('/');
    fail(`done --topic ${id} refused: ${dirs.map((d) => `the handover of ${d.by} cites the folder ${rel(d.dir)}/ (${countFiles(d.dir)} file(s))`).join('; ')}. The work files of ${id} end with the topic (outside git): save what of the folder is needed (save.mjs result <file> --topic <that topic>; a file from outside: save.mjs source), then rewrite the line of the handover to the saved files (save.mjs handover), or remove the line when nothing of the folder is needed; then done --topic again (P-078, P-018)`);
  }
}

function previousHolders(ctx, id, holder = {}) {
  const found = [];
  if (holder?.took_over_from) found.push(String(holder.took_over_from).split(' on ')[0]);
  const log = git(['log', '--reverse', '--format=%s', '--', topicRel(ctx.brainDir, id, 'holderFile')], { cwd: ctx.brainDir });
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

/** --knowledge is required: what of the topic is written with save, or "nic nové" (D-0059, both layouts). */
function knowledgeOf() {
  const k = args.knowledge;
  if (k === undefined || k === true || !String(k).trim()) fail('done --topic needs --knowledge "<what of the topic is written with save | nic nové>": knowledge (a fact, decision, procedure, rule) gained in the topic is written with save before the close, it is no file of the triage (D-0059, P-007). Write what is missing with save first, then name it here; "nic nové" when the topic brought no knowledge');
  return String(k).trim();
}

/**
 * Spec 5.2, 5.4, 10.6 item 4: cancelling a topic and closing a topic in mode discussion need the operator's instruction: a turn
 * the operator started, or an answer of the operator in a dialog of this turn. A message (also the supervisor's) is none.
 */
function operatorOnly(ctx, what) {
  if (!isWakeTurn(ctx.brainDir, ctx.thread) || dialogAnsweredInTurn(ctx.brainDir, ctx.thread)) return null;
  return `${what} refused: only on the operator's instruction (spec 5.2, 5.4, 10.6 item 4), and this turn was started by a message; ask the operator, nothing written${bellContinuation(ctx.brainDir, ctx.thread)}`;
}

function doneTopic(ctx, id) {
  const cancel = !!args.cancel;
  if (cancel) {
    if (inSubagent()) fail('done refused in subagent (P-025)');
    if (!ctx.thread) fail('done needs a stable thread id (P-038)');
    brainSync(ctx.brainDir);
    const holder = readHolder(ctx.brainDir, id);
    if (!isHolderOf(holder, ctx.thread)) fail(`topic ${id} is held by ${holder.thread || 'nobody'}; only the holder cancels it (P-037)`);
  } else guard(ctx, id);
  const knowledge = cancel ? null : knowledgeOf();
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) fail(`topic ${id} does not exist`);
  if (topic.kind === 'main') fail('topic main is the persona main thread: it is never closed or archived (P-045)');
  if (cancel || isDiscussionMode(topic)) {
    const refusal = operatorOnly(ctx, cancel ? `done --topic --cancel ${id}` : `done --topic ${id} (mode discussion)`);
    if (refusal) fail(refusal);
  }
  // An answer of the operator in a dialog of this turn is the operator's instruction, the message never is (P-047; D-0011:
  // the topic stayed open after 2 questions and 1 599 s). The close the held topic's own handover or task orders runs too
  // (agent-alice/D-0094: the refusal armed a timer and a new turn for the same step). The supervisor's instruction is no
  // message of another agent: its turn may close the topic within the mandate (plan O7, spec 5.2).
  else if (isWakeTurn(ctx.brainDir, ctx.thread) && !supervisorTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread) && !ownStepRequested(ctx.brainDir, ctx.thread, id, 'done')) fail(`done --topic refused: this turn was started by a message, not the operator, and the operator answered no dialog in it (P-047, D-0011)${bellContinuation(ctx.brainDir, ctx.thread)}`);
  // P-078: before the work files of the topic end, what is worth keeping from them is saved (or the close is refused).
  saveBeforeClose(ctx, id, { own: !cancel });
  if (hasTypeTriage(ctx.brainDir)) return cancel ? cancelTopic3(ctx, id, topic) : doneTopic3(ctx, id, topic, knowledge);
  if (cancel) fail('done --topic --cancel: a brain of data 2.1 only (spec 5.4); this brain is older, migrate it first');
  if (args.triage !== undefined) fail('--triage: a brain of data 2.1 only (spec 5); this brain is older, migrate it first');
  const holder = readHolder(ctx.brainDir, id);
  let merge = { merged: false, note: 'discussion topic, no code' };
  if (hasCodeCopy(topic)) merge = mergeCode(ctx, id, topic, { push: true });
  const closed = { ...topic, state: 'closed', closed: nowIso(), closed_by: ctx.thread, verified: String(args.verified), knowledge, merged: merge.merged };
  const L = layoutOf(ctx.brainDir);
  // Layout 1: the topic folder moves to the archive. Layout 2: the topic stays in temy/<id>/ with state closed and a free
  // holder in its .tema.json (one op: topic and holder merge into one file).
  const inPlace = !L.topicArchive;
  const archived = inPlace ? topicRel(ctx.brainDir, id) : dataRel(ctx.brainDir, 'topicArchive', id);
  const ops = inPlace
    ? [topicOp(ctx.brainDir, id, closed), holderOp(ctx.brainDir, id, {})]
    : [
      { from: topicRel(ctx.brainDir, id), to: archived },
      { path: `${archived}/${L.topicFile}`, content: JSON.stringify(closed, null, 2) + '\n' },
      { path: `${archived}/${L.holderFile}`, content: '{}\n' },
    ];
  const res = brainWrite(ctx, { ops, internal: true, message: `done --topic ${id}: ${inPlace ? 'closed' : 'archived'} (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [inPlace ? topicRel(ctx.brainDir, id, 'topicFile') : `${archived}/`]));
  out(`knowledge: ${knowledge}`);
  for (const dir of removeTopicTmp(ctx.brainDir, ctx.projectDir, id)) out(`tmp: ${dir} removed (outside git, work files of the closed topic)`);
  out(merge.note);
  out(`topic ${id} ${inPlace ? `closed (stays in ${archived}/ with state closed)` : 'closed and archived'}. Start a new session for the next topic (P-026).`);
  const scratch = scratchReminder(ctx.projectDir, unitStart(ctx, id, topic), id, ctx.brainDir);
  if (scratch) out(scratch);
  const cited = citedResults(ctx, id);
  if (cited) out(cited);
  closedTail(ctx, id, holder);
}

/** After a topic closed: the mail service closes it, the thread is settled (P-036, P-045), the previous holders named. */
function closedTail(ctx, id, holder) {
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

// ---------------------------------------------------------------------------------------------------------------------
// Data layout 3 (flow v2 spec 5, 4.1, 4.6; plan B12, O14)

/** The worktree (or legacy clone) of the topic in target repo `name`, or null. */
function copyIn(ctx, id, topic, name) {
  let p = null;
  if (ctx.domain) p = codeCopyPath(ctx, id, name);
  else if (topic.copy && (!topic.repo || topic.repo === name)) p = path.resolve(ctx.projectDir, topic.copy);
  return p && fs.existsSync(path.join(p, '.git')) ? p : null;
}

/** The topic branch of a repo is on origin with all its commits: pushed from its worktree (and from a legacy clone). */
function pushTopicBranch(dir, copy, branch) {
  if (copy) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: copy }).stdout;
    if (dirty) return `code copy ${copy} has uncommitted changes; commit or discard them in the copy first`;
    if (!fs.statSync(path.join(copy, '.git')).isFile()) { const p = pushBranch(copy, branch); if (p) return p; }
  }
  if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir }).ok) return null;
  return pushBranch(dir, branch);
}

/**
 * Per target repo in turn (spec 4.1): the topic branch merged into the target branch in the own clone of the workflow, or
 * for a protected target branch a merge request for topic/<id> and topic/<id>--obsah (O14). contentOnly (cancel, 5.4):
 * only topic/<id>--obsah is asked for, nothing merged. unit (done without --topic): merged where it may, nothing asked for. Returns { lines, failures: [{ repo, error }], requests:
 * [{ repo, head, base, url, command, how }] }.
 */
function settleRepos(ctx, id, topic, names, { contentOnly = false, unit = false } = {}) {
  const lines = [];
  const failures = [];
  const requests = [];
  const branch = topicBranch(id);
  for (const name of names) {
    const dir = targetRepoDir(ctx, name);
    if (!dir) { failures.push({ repo: name, error: 'the repo is not on this machine' }); continue; }
    const copy = copyIn(ctx, id, topic, name);
    const hasOrigin = git(['remote', 'get-url', 'origin'], { cwd: dir }).ok;
    if (!hasOrigin) {
      if (!contentOnly && (copy || git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir }).ok)) failures.push({ repo: name, error: `${name} has no remote origin: the topic branch is merged through the own clone of the workflow (spec 4.1); git -C ${dir} remote add origin <url>` });
      continue;
    }
    if (!contentOnly) {
      const pushed = pushTopicBranch(dir, copy, branch);
      if (pushed) { failures.push({ repo: name, error: pushed }); continue; }
    }
    const fetch = gitRemote(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir });
    if (!fetch.ok) { failures.push({ repo: name, error: `fetch from origin failed: ${fetch.stderr.split('\n')[0]}` }); continue; }
    const target = targetBranch(dir);
    const heads = [...(contentOnly ? [] : [branch]), contentBranch(id)].filter((b) => onOrigin(dir, b) && !mergedInto(dir, b, target));
    if (!heads.length) { lines.push(`${name}: nothing to merge into ${target}${onOrigin(dir, branch) ? ` (${branch} is in it)` : ''}`); continue; }
    // Work on paths of an older data layout (a branch forked before the migration) never merges (a shop repo 2026-11-16).
    const refusal = heads.map((h) => mergeRefusal(dir, `origin/${h}`, `origin/${target}`)).find(Boolean);
    if (refusal) { failures.push({ repo: name, error: refusal }); continue; }
    if (unit && targetProtected(dir)) { lines.push(`${name}: target branch ${target} is protected: done --topic asks for the merge of ${heads.join(', ')} (spec 4.1)`); continue; }
    if (targetProtected(dir) || contentOnly) {
      for (const head of heads) {
        const req = mergeRequest(dir, { head, base: target, title: `${head} -> ${target} (topic ${id})`, body: `Topic ${id}: ${topic.subject || ''}\n\nMerge request of done --topic (flow v2, spec 4.1, 4.6).` });
        requests.push({ repo: name, head, base: target, ...req });
        lines.push(`${name}: ${head} -> ${target}: ${req.url ? `${req.how} ${req.url}` : `${req.how}; the operator runs: ${req.command}`}`);
      }
      continue;
    }
    try {
      const env = brainScriptEnv();
      const m = cloneMerge(dir, { branch: target, from: branch, message: `Merge ${branch} (done --topic ${id})`, env, indexFiles: [INDEX_FILE], index: (c) => refreshIndex(c, env) });
      lines.push(`${name}: ${branch} merged into ${target} (${m.sha}), pushed from the own clone of the workflow${m.notes.length ? `; ${m.notes.join('; ')}` : ''}`);
    } catch (err) { failures.push({ repo: name, error: err.message }); }
  }
  return { lines, failures, requests };
}

/** Items of the handover section, [] when none. */
const itemsOf = (text, heading) => sectionItems(text, heading) || [];

/**
 * The handover of a topic that stays open after done (spec 4.1): Ďalší krok "dokončiť zlúčenie <repo>" per failed repo,
 * the merge requests in Úlohy pre operátora (one item each, an earlier request of the same branch replaced).
 */
function openHandover(ctx, id, { done = [], files = [], failures = [], requests = [] }) {
  let previous = '';
  try { previous = fs.readFileSync(path.join(ctx.brainDir, ...topicRel(ctx.brainDir, id, 'handover').split('/')), 'utf8'); } catch { /* none */ }
  const heads = new Set(requests.map((r) => `${r.repo} ${r.head}`));
  const oldTasks = itemsOf(previous, TASKS_SECTION).filter((t) => !/^zlúčiť topic\//.test(t) || ![...heads].some((h) => t.includes(h.split(' ')[1]) && t.includes(h.split(' ')[0])));
  const task = (r) => `zlúčiť ${r.head} do ${r.base} v repe ${r.repo}: ${r.url ? `žiadosť ${r.url}` : `žiadosť cez gh nevznikla (${r.how}), príkaz: ${r.command}`}; po zlúčení napíš do vlákna, téma dokončí done --topic`;
  return renderHandover({
    task: handoverTask(previous),
    done: [...itemsOf(previous, '## Hotové'), ...done],
    next: failures.map((f) => `dokončiť zlúčenie ${f.repo}: ${String(f.error).split('\n')[0].slice(0, 300)}; potom done --topic znova`),
    files: [...itemsOf(previous, '## Súbory'), ...files],
    questions: itemsOf(previous, QUESTIONS_SECTION),
    tasks: [...oldTasks, ...requests.map(task)],
  });
}

/**
 * Remove the worktrees (and legacy clones) of the topic in its target repos, with its task worktrees and local task branches
 * (spec 3.7); the branches stay on origin.
 */
function removeCopies(ctx, id, topic, names) {
  const lines = [];
  for (const name of names) {
    const dir = targetRepoDir(ctx, name);
    if (dir) lines.push(...removeTaskCopies(dir, id));
    const copy = copyIn(ctx, id, topic, name);
    if (!copy) continue;
    if (fs.statSync(path.join(copy, '.git')).isFile() && dir) {
      const rm = git(['worktree', 'remove', '--force', copy], { cwd: dir });
      if (!rm.ok) { lines.push(`copy ${copy} not removed: ${rm.stderr.split('\n')[0]}${/EPERM|EBUSY|Permission denied|being used|Invalid argument/i.test(rm.stderr) ? ` (a process has its working directory in it: cd ${dir})` : ''}`); continue; }
      git(['branch', '-D', topicBranch(id)], { cwd: dir });
      try { fs.rmdirSync(path.dirname(copy)); } catch { /* other topics of the repo remain */ }
    } else fs.rmSync(copy, { recursive: true, force: true });
    lines.push(`copy ${copy} removed`);
  }
  return lines;
}

/** Triage of layout 3 (spec 5): { listing } | { plan, moves } | { none } ; refusals fail with nothing written. */
function typeTriage(ctx, id, files, main) {
  if (!files.length) {
    if (args.triage !== undefined) fail(`--triage: topic ${id} has no files outside tmp/; run done --topic without --triage`);
    return { none: true, moves: [], drop: [] };
  }
  if (main?.dir && git(['remote', 'get-url', 'origin'], { cwd: main.dir }).ok) gitRemote(['fetch', '--quiet', 'origin'], { cwd: main.dir });
  const types = main?.dir ? outputTypes(main.dir) : [];
  if (args.triage === undefined) return { listing: typeTriageListing(id, files, types, main?.name || null) };
  if (args.triage === true) fail('--triage needs the file with the list: --triage <file>');
  const bell = bellRefusal(ctx.brainDir, ctx.thread, 'done --topic --triage', { topic: id, step: 'done' }, { supervisor: true });
  if (bell) fail(bell);
  let text;
  try { text = fs.readFileSync(path.resolve(String(args.triage)), 'utf8'); } catch (err) { fail(`--triage: cannot read ${args.triage}: ${err.message}`); }
  const plan = parseTypeTriage(text, files, types);
  if (plan.errors.length) fail(`--triage: nothing written:\n${plan.errors.join('\n')}`);
  if (plan.unclear.length) fail(`--triage: ${plan.unclear.length} file(s) marked ${UNCLEAR}, nothing written, the topic stays open: ${plan.unclear.join(', ')}. Ask the operator where each goes (spec 5.3: AskUserQuestion, the type you propose first), write the answer as its line ("<typ> <path>", "${NEW_TYPE}:<typ> <path>" or "zanikne <path>") and run done --topic ... --triage <file> again in the turn of the answer`);
  if (plan.outputs.length && !main?.dir) fail(`--triage: nothing written: ${main?.error || `topic ${id} has no target repo`}; its files can only end ("zanikne <path>")`);
  if (plan.newTypes.length) {
    const refusal = confirmRefusal(ctx.brainDir, ctx.thread, `done --topic --triage (new type ${plan.newTypes.join(', ')})`);
    if (refusal) fail(`${refusal}\nA new type of outputs is the operator's choice (spec 5.3): propose ${plan.newTypes.map((t) => `vystupy/${t}/`).join(', ')} in the dialog; nothing written, nothing moved, the topic stays open`);
  }
  const base = topicRel(ctx.brainDir, id);
  const root = dataRel(main?.dir || ctx.brainDir, 'outputs');
  const targets = new Map();
  const moves = [];
  for (const o of plan.outputs) {
    const to = `${root}/${o.type}/${path.posix.basename(o.rel)}`;
    if (targets.has(to)) fail(`--triage: nothing written: ${o.rel} and ${targets.get(to)} both go to ${to}; rename one in the topic first`);
    targets.set(to, o.rel);
    const raw = fs.readFileSync(path.join(ctx.brainDir, ...base.split('/'), ...o.rel.split('/')));
    const { content, header } = withTopicHeader(o.rel, raw, id);
    moves.push({ rel: o.rel, from: `${base}/${o.rel}`, to, content, header, type: o.type, isNew: o.isNew });
  }
  return { plan, moves, drop: plan.drop };
}

/** Write the outputs of the triage into the main target repo (its target branch, or topic/<id>--obsah when protected). */
function writeOutputs(ctx, id, main, moves) {
  if (!moves.length) return null;
  const res = contentWrite(ctx, main.dir, id, {
    message: `done --topic ${id}: outputs of the topic (${moves.map((m) => m.to).join(', ').slice(0, 200)})`,
    ops: (clone) => moves.flatMap((m) => {
      const abs = path.join(clone, ...m.to.split('/'));
      if (fs.existsSync(abs)) {
        // A rerun (a merge failed before) finds its own output there: unchanged, nothing to write.
        if (Buffer.compare(fs.readFileSync(abs), Buffer.from(m.content)) === 0) return [];
        throw new Error(`${main.name}/${m.to} exists already with other content; rename ${m.from} in the topic, or ask the operator which version holds (a conflict in content, spec 4.1)`);
      }
      return [{ path: m.to, content: m.content }];
    }),
  });
  return res;
}

function doneTopic3(ctx, id, topic, knowledge) {
  const holder = readHolder(ctx.brainDir, id);
  const targets = targetRepos(ctx, topic);
  const mainDir = targets.main ? targetRepoDir(ctx, targets.main) : null;
  const main = targets.main ? (mainDir ? { name: targets.main, dir: mainDir } : { name: targets.main, error: `target repo ${targets.main} is not on this machine` }) : { error: `topic ${id} has no target repo (no repos in .tema.json, no default_repo in the policy of the domain brain, spec 4.5)` };
  const files = topicFiles(ctx.brainDir, id);
  const triage = typeTriage(ctx, id, files, main);
  if (triage.listing) { out(triage.listing); return; }
  const base = topicRel(ctx.brainDir, id);
  // 1. Outputs into the main target repo first: a refused write leaves the brain as it is (the files stay in the topic).
  let written = null;
  try { written = writeOutputs(ctx, id, main, triage.moves); }
  catch (err) { fail(`done --topic ${id}: writing the outputs into ${main.name} failed, nothing written into brain (the topic stays open with its files): ${err.message}`); }
  if (written) out(`outputs: ${triage.moves.map((m) => `${m.from} -> ${main.name}/${m.to}${m.header ? '' : ' (not markdown: no topic header)'}`).join(', ')} [${contentWhere(written)}]`);
  const triageDone = [
    ...triage.moves.map((m) => `triáž: ${m.from} -> ${main.name}/${m.to}${m.isNew ? ` (nový typ ${m.type}, schválil operátor)` : ''}`),
    ...(triage.drop.length ? [`triáž: zanikne ${triage.drop.map((r) => `${base}/${r}`).join(', ')}`] : []),
  ];
  // 2. The topic branches per target repo (spec 4.1).
  const settled = settleRepos(ctx, id, topic, targets.list);
  for (const line of settled.lines) out(line);
  const removals = [...triage.moves.map((m) => ({ path: m.from, remove: true })), ...triage.drop.map((r) => ({ path: `${base}/${r}`, remove: true }))];
  if (settled.failures.length || settled.requests.length) {
    // The topic stays open: the sorted files leave it (they are in the target repo or end), the handover says what is left.
    const handover = { path: topicRel(ctx.brainDir, id, 'handover'), content: openHandover(ctx, id, { done: triageDone, files: triage.moves.map((m) => `${main.name}/${m.to}`), failures: settled.failures, requests: settled.requests }) };
    const res = brainWrite(ctx, { ops: [...removals, handover], internal: true, message: `done --topic ${id}: stays open (${settled.failures.length ? `merge failed in ${settled.failures.map((f) => f.repo).join(', ')}` : `merge requested in ${[...new Set(settled.requests.map((r) => r.repo))].join(', ')}`})` });
    out(formatWriteResult(res, [handover.path, ...removals.map((r) => r.path)]));
    for (const f of settled.failures) out(`merge: ${f.repo} failed: ${f.error}`);
    if (settled.requests.length) out(`topic ${id} stays open (state otázka): the merge request(s) are in Úlohy pre operátora of its handover; once the operator merged them and wrote into this thread, run done --topic again (spec 4.1)`);
    if (settled.failures.length) fail(`done --topic ${id}: the topic stays open with the step "dokončiť zlúčenie ${settled.failures.map((f) => f.repo).join(', ')}" in its handover; the other repos are merged (spec 4.1)`);
    return;
  }
  // 3. Closed: topics/<id>/ ends (removed in git, no archive, spec 5), the worktrees go, the branch stays on origin.
  for (const line of args['keep-copy'] ? [] : removeCopies(ctx, id, topic, targets.list)) out(line);
  const res = brainWrite(ctx, { ops: [{ path: base, remove: true }], internal: true, message: `done --topic ${id}: closed, topic removed (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [`${base}/`]));
  for (const line of triageDone) out(line);
  out(`knowledge: ${knowledge}`);
  for (const dir of removeTopicTmp(ctx.brainDir, ctx.projectDir, id)) out(`tmp: ${dir} removed (outside git, work files of the closed topic)`);
  out(`topic ${id} closed: ${base}/ removed in git (its history keeps it). Start a new session for the next topic (P-026).`);
  closedTail(ctx, id, holder);
}

/**
 * done --topic --cancel (spec 5.4): no triage, no merge; the saved inputs and facts stay, topics/<id>/ and the worktrees end,
 * the topic branch stays on origin. Sources only on topic/<id>--obsah of a target repo get a merge request first and the
 * topic stays open until it is merged.
 */
function cancelTopic3(ctx, id, topic) {
  const holder = readHolder(ctx.brainDir, id);
  const targets = targetRepos(ctx, topic);
  // The topic branch goes to origin before its worktree is removed (it stays there, 5.4).
  for (const name of targets.list) {
    const dir = targetRepoDir(ctx, name);
    const copy = dir ? copyIn(ctx, id, topic, name) : null;
    if (dir && git(['remote', 'get-url', 'origin'], { cwd: dir }).ok) {
      const pushed = pushTopicBranch(dir, copy, topicBranch(id));
      if (pushed) fail(`done --topic --cancel ${id}: ${name}: ${pushed}; nothing removed`);
    }
  }
  const settled = settleRepos(ctx, id, topic, targets.list, { contentOnly: true });
  for (const line of settled.lines.filter((l) => !/nothing to merge/.test(l))) out(line);
  if (settled.failures.length || settled.requests.length) {
    const handover = { path: topicRel(ctx.brainDir, id, 'handover'), content: openHandover(ctx, id, { done: ['zrušenie témy na pokyn operátora: čaká na zlúčenie zdrojov'], failures: settled.failures, requests: settled.requests }) };
    const res = brainWrite(ctx, { ops: [handover], internal: true, message: `done --topic --cancel ${id}: waits for the merge of its sources` });
    out(formatWriteResult(res, [handover.path]));
    for (const f of settled.failures) out(`cancel: ${f.repo}: ${f.error}`);
    out(`topic ${id} stays open until the sources on ${contentBranch(id)} are merged (spec 5.4); then done --topic --cancel again`);
    if (settled.failures.length) process.exitCode = 1;
    return;
  }
  for (const line of removeCopies(ctx, id, topic, targets.list)) out(line);
  const base = topicRel(ctx.brainDir, id);
  const res = brainWrite(ctx, { ops: [{ path: base, remove: true }], internal: true, message: `done --topic --cancel ${id}: cancelled on the operator's instruction, topic removed` });
  out(formatWriteResult(res, [`${base}/`]));
  for (const dir of removeTopicTmp(ctx.brainDir, ctx.projectDir, id)) out(`tmp: ${dir} removed`);
  out(`topic ${id} cancelled (spec 5.4): no triage, no merge; ${base}/ removed in git, ${topicBranch(id)} stays on origin; saved sources and facts stay.`);
  closedTail(ctx, id, holder);
}

/**
 * --archive-closed [--project <brain or project>] [--dry-run]: closed topics with only the handover into the hidden
 * archive (archive-closed.mjs). --project may name the brain itself (a domain brain has no .workflow.json).
 */
function archiveClosedTopics() {
  if (inSubagent()) fail('done refused in subagent (P-025)');
  let brainDir = null;
  const given = typeof args.project === 'string' ? path.resolve(args.project) : null;
  if (given && !resolveBrain(given) && hasData(given, 'topicHidden') && fs.existsSync(dataPath(given, 'topics'))) brainDir = given;
  const ctx = brainDir ? { brainDir, thread: threadId(), policy: loadPolicy(brainDir) } : loadContext({ project: given || undefined });
  const plan = closedTopicsPlan(ctx.brainDir);
  const dry = !!args['dry-run'];
  if (!dry && plan.archive.length) {
    const res = archiveClosed(ctx, plan);
    out(formatClosedPlan(ctx.brainDir, plan));
    out(formatWriteResult(res, [`${plan.archive.length} topic folder(s)`, INDEX_FILE]));
  } else out(formatClosedPlan(ctx.brainDir, plan, { dry }));
}

try {
  if (args['archive-closed']) { archiveClosedTopics(); process.exit(0); }
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
    // The copy of a repo topic merges into the repo of its .tema.json, not into the project of this thread's cwd (D-0035).
    const topicCtx = id && !args.project ? topicRepoContext(ctx, readTopic(ctx.brainDir, id)) : ctx;
    if (args.topic) doneTopic(topicCtx, id);
    else doneUnit(topicCtx, id);
  }
} catch (err) {
  fail(err.message);
}
