#!/usr/bin/env node
// Close a unit of work or a whole topic (P-029, P-005, P-006, P-011, P-020, P-036, P-044).
//   done.mjs [--topic-id <id>] --verified "<observation>" [--procedures a,b] [--derivations k1,k2]
//   done.mjs --list                       existing names in procedures.log / derivations.log
//   done.mjs --topic [--topic-id <id>] --verified "<observation>" --knowledge "<what of the topic is written with save | nic nové>"
//            [--keep-copy] [--triage <file> [--confirmed-by <id of the orchestrator's reply>]]
//     layout 2: a topic with work files outside tmp/ (whoever gave it) is not closed without --triage: done lists the
//     files; the agent gives each its class (dokument, zdroj, stav, pomocne; nejasne when it cannot), --triage applies the
//     list. Unclear files are confirmed by the operator: a dialog of a thread that may ask, else the orchestrator's reply
//     (--confirmed-by); without a confirmation nothing is removed and the topic stays open (D-0058, D-0059, D-0060).
//     A topic left with only handover.md and .tema.json goes to the hidden archive .brain/archive/topics/<id>/.
//   done.mjs --archive-closed [--project <brain>] [--dry-run]
//     layout 2: topics closed before that (state closed in temy/<id>/, only handover.md and .tema.json, no file in tmp/)
//     move to .brain/archive/topics/<id>/ in one commit with INDEX.md; closed topics with other work are only listed.
//     --dry-run lists without moving; --project takes the brain itself (a domain brain) or a project of it.
// A unit (no --topic) keeps the topic held by the thread; in a code topic it merges the topic branch into the main branch
// and keeps the copy (D-0011). --topic in a turn started by a message needs an answer of the operator in a dialog of it.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, git, nowIso } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, dialogAnsweredInTurn, inSubagent, foreignProjectCwd, readThreadState, resolveBrain, threadId, loadPolicy } from '../scripts/config.mjs';
import { brainWrite, brainSync, formatWriteResult, readHolder, isHolderOf } from '../scripts/brain.mjs';
import { freeHandover, renderHandover } from '../scripts/brain-checks.mjs';
import { mergeWithIndex, hasDataIndex, INDEX_FILE } from '../scripts/data-index.mjs';
import { closedTopicsPlan, archiveClosed, formatClosedPlan } from '../scripts/archive-closed.mjs';
import { recordNames, existingNames } from '../scripts/logs.mjs';
import { rejectedProposal } from '../scripts/find.mjs';
import { heldTopics, readTopic, freePointMail, hasCodeCopy, codeCopyPath, topicOrchestrator, markProgrammaticClosed, topicRel, topicOp, holderOp, closedTopicDir, topicRepoContext } from '../scripts/topic.mjs';
import { dataPath, dataRel, layoutOf, topicHome, topicWorkLabel, dataLayoutVersion, layoutFor } from '../scripts/layout.mjs';
import { registerTopic, runClient, commsProjectName } from '../scripts/comms.mjs';
import { hiddenTopicDir } from '../scripts/topic-files.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { bellContinuation } from '../scripts/waker.mjs';
import { asList } from '../scripts/frontmatter.mjs';
import { PROJECT_KNOWLEDGE, REPO_HANDOVER } from '../scripts/repo-knowledge.mjs';
import { scratchReminder, citedScratch, topicResultsLabel, RESULTS_FILE } from '../scripts/materialy.mjs';
import { hasTriage, topicFiles, triageListing, parseTriage, triageOps, recordOps, triageSummary, handoverTask, confirmRefusal, bellRefusal, ownStepRequested, removeTopicTmp, outputRepo, exportOutputs, docsLabel, leavingFiles, UNCLEAR } from '../scripts/triage.mjs';

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
const PROGRAMMATIC_END =(id) => `thread: code started this thread for topic ${id} and it ends here (D-0043): end the reply with the result, "**Handover:** žiadny" and "**Stav:** hotovo", and as the last step of this turn settle this thread (tool t3_thread_organize, action settle, no threadId; do not archive it). No next step and no question to the operator, least of all about a next topic`;
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
  const merge = hasCodeCopy(topic) ? mergeCode(ctx, id, topic, { keepCopy: true, label: `done ${id}` }) : null;
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
  const sources = `${dataRel(ctx.projectDir, 'materialy', id)}/`;
  const results = topicResultsLabel(ctx.brainDir, ctx.projectDir, id);
  const where = results === sources ? sources : `${sources} (data from outside, materialy.mjs add) or ${results} (a result of the work, materialy.mjs add --result)`;
  return `results: ${cited.length} ${work} path(s) cited in worker results of ${id} exist only in ${work} (not in git): ${shown}. Move data that cannot be fetched again to ${where} (skill workflow:materialy); the rest may stay (D-0032)`;
}

/**
 * Threads that held the topic before a takeover (claim --force): `took_over_from` of holder.json and, from the claim
 * history (commits of topics/<id>/holder.json), the holder before each forced claim. Never this thread.
 */
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

/**
 * The orchestrator's reply `msgId` confirms the unclear files of topic `id` (D-0058, D-0031): a final reply this thread
 * received (comms receive keeps its sender, mail_replies), sent by the orchestrator topic of the topic, to a request this
 * topic sent to that orchestrator. Returns null when it holds, else the reason.
 */
function confirmedByRefusal(ctx, id, orch, msgId) {
  const what = `--confirmed-by ${msgId}`;
  const got = readThreadState(ctx.brainDir, ctx.thread).mail_replies?.[msgId];
  if (!got) return `${what}: this thread did not receive that message as a reply (read it first with comms receive --id ${msgId}); nothing written, the topic stays open`;
  if (got.reply_state && got.reply_state !== 'hotovo') return `${what}: the reply is interim (${got.reply_state}), not the confirmed list; wait for the final reply of the orchestrator`;
  const orchProject = orch.project || commsProjectName(ctx);
  const fromOrch = got.from_topic ? got.from_topic === orch.topic && (!got.from_project || got.from_project === orchProject) : !!orch.thread && got.thread_id === orch.thread;
  if (!fromOrch) return `${what}: the reply is not from the orchestrator of topic ${id} (${orch.to}), it came from ${got.from_project && got.from_topic ? `${got.from_project}/${got.from_topic}` : got.thread_id ? `thread ${got.thread_id}` : got.sender || '?'}; nothing written, the topic stays open`;
  if (got.topic && got.topic !== id) return `${what}: the reply came to topic ${got.topic}, not to ${id}; nothing written, the topic stays open`;
  const req = runClient(ctx, ['message', '--id', String(got.reply_to)]);
  if (!req.ok) return `${what}: the request ${got.reply_to} it answers cannot be checked (${req.error}); nothing written, the topic stays open, run it again when the mail answers`;
  const q = req.data || {};
  if (q.topic !== orch.topic || (q.project && q.project !== orchProject)) return `${what}: it answers ${got.reply_to}, which was not sent to the orchestrator ${orch.to}; nothing written, the topic stays open`;
  return null;
}

/**
 * Who confirms the unclear files (D-0058): a thread whose topic has no orchestrator asks the operator in a dialog of this
 * turn; a topic from an orchestrator (or a thread code started) asks the orchestrator by mail (D-0031), and its reply is
 * the confirmation (--confirmed-by). Returns null when confirmed, else the reason.
 */
function confirmation(ctx, id, topic) {
  const orch = topicOrchestrator(ctx.brainDir, topic, ctx.thread);
  if (!orch) return confirmRefusal(ctx.brainDir, ctx.thread, `done --topic --triage (${UNCLEAR}:<class>)`);
  const msgId = args['confirmed-by'];
  if (!msgId || msgId === true) return `done --topic --triage (${UNCLEAR}:<class>) refused: topic ${id} has the orchestrator ${orch.to}, this thread does not ask the operator (D-0031); the confirmation is the orchestrator's reply: pass --confirmed-by <id of its reply>`;
  return confirmedByRefusal(ctx, id, orch, String(msgId));
}

/** How the agent gets the unclear files confirmed: the dialog, or mail to the orchestrator (nothing is written now). */
function unclearRequest(ctx, id, topic, plan) {
  const base = topicRel(ctx.brainDir, id);
  const list = plan.unclear.map((r) => `${base}/${r}`).join(', ');
  const orch = topicOrchestrator(ctx.brainDir, topic, ctx.thread);
  const how = orch
    ? `ask the orchestrator: comms send --to ${orch.to} --level assist with the unclear files, the class you propose for each and the classes of the other files; it asks the operator in its dialog and returns the confirmed list as a reply (--reply-to). Save the step (save handover --next "done --topic with the confirmed triage"), and in a later turn (not the turn of the bell, P-047) write each confirmed file as "${UNCLEAR}:<class> <path>" and run done --topic ... --triage <file> --confirmed-by <id of the reply>`
    : `ask the operator with AskUserQuestion (the class you propose for each first), write each confirmed file as "${UNCLEAR}:<class> <path>" and run done --topic ... --triage <file> again in the turn of the answer`;
  return `--triage: ${plan.unclear.length} file(s) marked ${UNCLEAR}, nothing written, the topic stays open: ${list}. The operator confirms them (D-0058): ${how}`;
}

/**
 * Triage at done --topic (layout 2, D-0059). null: no triage (layout 1). { listing }: the files to give a class, the topic
 * is not closed. { note, hide }: no work files. { plan, ops, record, hide }: the list applied. `hide`: after the triage
 * only handover.md and .tema.json are left, the topic goes to the hidden archive (D-0060).
 */
function triagePlan(ctx, id, topic) {
  if (!hasTriage(ctx.brainDir)) {
    if (args.triage !== undefined) fail('--triage: this brain is in data layout 1, which has no triage (only layout 2)');
    return null;
  }
  const files = topicFiles(ctx.brainDir, id);
  const base = topicRel(ctx.brainDir, id);
  if (!files.length) {
    if (args.triage !== undefined) fail(`--triage: topic ${id} has no work files outside tmp/; run done --topic without --triage`);
    return { note: 'triage: no work files outside tmp/, skipped', hide: true };
  }
  // D-0056: documents and sources of a topic with a project repo beside the brain go to that repo.
  const repo = outputRepo(ctx);
  if (args.triage === undefined) return { listing: triageListing(ctx.brainDir, id, files, repo) };
  if (args.triage === true) fail('--triage needs the file with the list: --triage <file>');
  const bell = bellRefusal(ctx.brainDir, ctx.thread, 'done --topic --triage', { topic: id, step: 'done' });
  if (bell) fail(bell);
  let text;
  try { text = fs.readFileSync(path.resolve(String(args.triage)), 'utf8'); } catch (err) { fail(`--triage: cannot read ${args.triage}: ${err.message}`); }
  const plan = parseTriage(text, files);
  if (plan.errors.length) fail(`--triage: nothing written:\n${plan.errors.join('\n')}`);
  if (plan.unclear.length) fail(unclearRequest(ctx, id, topic, plan));
  // A triage without unclear files runs without a question (D-0060); confirmed ones need the operator's confirmation.
  if (plan.confirmed.length) {
    const refusal = confirmation(ctx, id, topic);
    if (refusal) fail(`${refusal}\nnothing written, nothing removed; the topic stays open`);
  }
  const { ops, exports, moved, errors } = triageOps(ctx.brainDir, id, plan, repo);
  if (errors.length) fail(`--triage: nothing written:\n${errors.join('\n')}`);
  const record = recordOps(ctx.brainDir, leavingFiles(plan).map((r) => `${base}/${r}`));
  return { plan, ops, exports, moved, repo, record, hide: !plan.stav.length };
}

/** --knowledge is required: what of the topic is written with save, or "nic nové" (D-0059, both layouts). */
function knowledgeOf() {
  const k = args.knowledge;
  if (k === undefined || k === true || !String(k).trim()) fail('done --topic needs --knowledge "<what of the topic is written with save | nic nové>": knowledge (a fact, decision, procedure, rule) gained in the topic is written with save before the close, it is no file of the triage (D-0059, P-007). Write what is missing with save first, then name it here; "nic nové" when the topic brought no knowledge');
  return String(k).trim();
}

function doneTopic(ctx, id) {
  guard(ctx, id);
  const knowledge = knowledgeOf();
  // An answer of the operator in a dialog of this turn is the operator's instruction, the message never is (P-047; D-0011:
  // the topic stayed open after 2 questions and 1 599 s). The close the held topic's own handover or task orders runs too
  // (agent-alice/D-0094: the refusal armed a timer and a new turn for the same step).
  if (isWakeTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread) && !ownStepRequested(ctx.brainDir, ctx.thread, id, 'done')) fail(`done --topic refused: this turn was started by a message, not the operator, and the operator answered no dialog in it (P-047, D-0011)${bellContinuation(ctx.brainDir, ctx.thread)}`);
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) fail(`topic ${id} does not exist`);
  if (topic.kind === 'main') fail('topic main is the persona main thread: it is never closed or archived (P-045)');
  // Layout 2 (D-0044): a topic the operator gave is triaged before it closes; nothing is merged or written before the
  // operator confirmed the list. A technical topic and a topic without files close without triage (files stay).
  const triage = triagePlan(ctx, id, topic);
  if (triage?.listing) { out(triage.listing); return; }
  const holder = readHolder(ctx.brainDir, id);
  let merge = { merged: false, note: 'discussion topic, no code' };
  if (hasCodeCopy(topic)) merge = mergeCode(ctx, id, topic, { push: true });
  // D-0056: outputs for the project repo are committed there first (with its INDEX.md); a refused write leaves the brain
  // as it is (no record, no close), so the topic stays open with its files.
  if (triage?.exports?.length) {
    let exp;
    try { exp = exportOutputs(ctx, triage.repo, triage.exports, `done --topic ${id}: outputs of the topic from brain`); }
    catch (err) { fail(`done --topic ${id}: writing the outputs into ${docsLabel(ctx.brainDir, triage.repo)} failed, nothing written into brain (topic stays open, its files stay): ${err.message}`); }
    out(`project ${path.basename(triage.repo)}: ${formatWriteResult(exp, [...triage.exports.map((e) => e.to), ...(hasDataIndex(triage.repo) ? ['INDEX.md'] : [])])}`);
  }
  if (triage?.record?.length) {
    const rec = brainWrite(ctx, { ops: triage.record, internal: true, message: `done --topic ${id}: topic files recorded before the triage` });
    out(formatWriteResult(rec, triage.record.map((op) => op.path)));
  }
  const closed = { ...topic, state: 'closed', closed: nowIso(), closed_by: ctx.thread, verified: String(args.verified), knowledge, merged: merge.merged };
  const L = layoutOf(ctx.brainDir);
  // Layout 1: the topic folder moves to the archive. Layout 2: the topic stays in temy/<id>/ with state closed and a free
  // holder in its .tema.json (one op: topic and holder merge into one file); a topic left with only handover.md and
  // .tema.json after the triage goes to the hidden archive .brain/archive/topics/<id>/ (outside INDEX.md, D-0060).
  const hide = !!triage?.hide && !hiddenTopicDir(ctx.brainDir, id);
  const inPlace = !L.topicArchive && !hide;
  const archived = inPlace ? topicRel(ctx.brainDir, id) : hide ? dataRel(ctx.brainDir, 'topicHidden', id) : dataRel(ctx.brainDir, 'topicArchive', id);
  const ops = inPlace
    ? [topicOp(ctx.brainDir, id, closed), holderOp(ctx.brainDir, id, {})]
    : hide
      ? [
        { from: topicRel(ctx.brainDir, id), to: archived },
        { path: `${archived}/${L.topicFile}`, content: JSON.stringify({ ...closed, holder: {} }, null, 2) + '\n' },
      ]
      : [
        { from: topicRel(ctx.brainDir, id), to: archived },
        { path: `${archived}/${L.topicFile}`, content: JSON.stringify(closed, null, 2) + '\n' },
        { path: `${archived}/${L.holderFile}`, content: '{}\n' },
      ];
  // tmp/ of the topic (outside git) is removed before a move of the topic folder, so it never goes into the archive.
  const tmpRemoved = hide ? removeTopicTmp(ctx.brainDir, ctx.projectDir, id) : [];
  if (triage?.plan) {
    // The moves, removals, the closing handover (what went where) and INDEX.md in the commit of the close.
    const handoverRel = topicRel(ctx.brainDir, id, 'handover');
    let previous = '';
    try { previous = fs.readFileSync(path.join(ctx.brainDir, ...handoverRel.split('/')), 'utf8'); } catch { /* none */ }
    ops.unshift(...triage.ops);
    const handover = { path: inPlace ? handoverRel : `${archived}/${L.handover}`, content: renderHandover({ task: handoverTask(previous), done: triageSummary(ctx.brainDir, id, triage.plan, triage.moved), next: '-', files: triage.moved.map((m) => m.where), questions: '' }) };
    ops.push(handover);
  }
  const res = brainWrite(ctx, { ops, internal: true, message: `done --topic ${id}: ${triage?.plan ? 'triaged and ' : ''}${inPlace ? 'closed' : 'archived'} (verified: ${String(args.verified).slice(0, 60)})` });
  out(formatWriteResult(res, [inPlace ? topicRel(ctx.brainDir, id, 'topicFile') : `${archived}/`]));
  if (triage?.plan) for (const line of triageSummary(ctx.brainDir, id, triage.plan, triage.moved)) out(line);
  else if (triage?.note) out(triage.note);
  out(`knowledge: ${knowledge}`);
  // Layout 2: tmp/ of this topic is outside git and goes with the close; nothing else is removed (D-0044).
  for (const dir of [...tmpRemoved, ...removeTopicTmp(ctx.brainDir, ctx.projectDir, id)]) out(`tmp: ${dir} removed (outside git, work files of the closed topic)`);
  out(merge.note);
  // D-0043: a topic code created for this thread (it has an orchestrator) ends the thread; no next topic is asked for.
  const programmatic = !!topicOrchestrator(ctx.brainDir, topic, ctx.thread) && !heldTopics(ctx.brainDir, ctx.thread).length;
  const how = inPlace ? `closed (stays in ${archived}/ with state closed)` : hide ? `closed and moved to the hidden archive ${archived}/ (only its handover was left; outside INDEX.md, find finds it)` : 'closed and archived';
  out(programmatic ? `topic ${id} ${how}.` : `topic ${id} ${how}. Start a new session for the next topic (P-026).`);
  const scratch = scratchReminder(ctx.projectDir, unitStart(ctx, id, topic), id, ctx.brainDir);
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
  else if (programmatic) {
    // D-0043: code started this thread for the topic; it ends with it. The t3 CLI cannot settle a thread, so done names the step.
    markProgrammaticClosed(ctx.brainDir, ctx.thread, id);
    out(PROGRAMMATIC_END(id));
  } else if (process.env.T3CODE_THREAD_ID) out(SETTLE_THREAD);
  // A topic taken over (claim --force) leaves the previous holder's thread open in T3: settle it too. The t3 CLI has no
  // settle (t3 thread: list, start, send, show), so done names the step.
  for (const prev of previousHolders(ctx, id, holder)) out(`thread: settle the previous holder thread ${prev} (t3_thread_organize action settle threadId ${prev}; an archived thread first unarchive)`);
  for (const w of buildIndexes(ctx.brainDir, ctx.policy).warnings) out(`limit: ${w}`);
}

/**
 * --archive-closed [--project <brain or project>] [--dry-run]: closed topics with only the handover into the hidden
 * archive (archive-closed.mjs). --project may name the brain itself (a domain brain has no .workflow.json).
 */
function archiveClosedTopics() {
  if (inSubagent()) fail('done refused in subagent (P-025)');
  let brainDir = null;
  const given = typeof args.project === 'string' ? path.resolve(args.project) : null;
  if (given && !resolveBrain(given) && dataLayoutVersion(given) === 2 && fs.existsSync(path.join(given, layoutFor(2).topics))) brainDir = given;
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
