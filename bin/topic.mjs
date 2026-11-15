#!/usr/bin/env node
// topic.mjs create <id> --subject "..." --class web|code|ops|discussion [--task "<operator's task>"] [--no-claim] [--no-copy] [--for-thread <new thread id>] [--here | --new-thread]
//                        [--not "<out of scope>"] [--distinct "<how it differs from an overlapping topic>"]   for another thread:
//                        a handoff record in the held topic; an overlap with an open topic is refused (agent-alice/D-0082)
//           claim <id> [--force --operator-approved] [--mode operator|auto]
//           release <id> [--force --operator-approved]
//           handoff <id> [--task ".." --done ".." --next ".." --files ".." --questions ".."] [--leave-outbox]
//                        to another machine: flush logs, send outbox, handover, release, push (P-040)
//           main [--force --operator-approved]   persona main thread (topic main, P-045)
//           thread <id> [--task ".."] [--not ".."] [--distinct ".."] [--mode operator|auto] [--for-thread <id>]   new T3 thread for a free topic (P-036)
//           auto <id> --subject ".." [--repo <name>] [--task ".."] [--persona <name>]   code without a thread (cron): topic
//                        with its own thread in the repo's project by policy topics.auto (D-0035); prints `mail: <addr>`;
//                        at the limit of active code topics (topics.auto_max_active, D-0069): `waiting: <n> active`, exit 3;
//                        a frozen repo (policy freeze, P-074): `reject: <text>` and `frozen: until <version>`, exit 4
//           pause <id> [--until <ISO | <n>d | <n>h>] [--reason ".."]   snooze: no bells until resumed or until
//           resume <id>
//           list | status
//           closed <id>   exit 0 once the topic is no longer open (condition of timer.mjs --topic)
//           stalled <id>  exit 0 when an open topic stands: no running turn, the last ended over topics.stall_check_minutes
//                        ago, no timer or continuation, no reply awaited, no mail waiting (stall check of a handoff, D-0084)
//           consent <id> --tool <tool> --target "<exact call>" | --target-file <file> [--reason ".."]   the orchestrator grants one
//                        exact call of the topic's thread that a hook left to a confirmation (P-064)
//           consent <id> --fix yes|no [--reason ".."]   the orchestrator's answer to the fix of a topic from a report or an
//                        issue (P-075): yes = áno, relevantné (the fix starts), no = nie, pracuje sa na novej verzii
//           copy <id> [--operator-approved]   code copy (branch topic/<id>); a discussion topic gets one only after the
//                        operator approved its implementation (D-0020), recorded in topics/<id>/topic.json; done merges it
import { parseArgs, fail, localTime, gitToplevel } from '../scripts/util.mjs';
import { loadContext, foreignProjectCwd, resolveDomain, mainCheckout } from '../scripts/config.mjs';
import { domainRepos } from '../scripts/repo-knowledge.mjs';
import os from 'node:os';
import path from 'node:path';
import { createTopic, CLASS_HELP, startThreadForTopic, claimTopic, claimMain, releaseTopic, handoffTopic, listTopics, heldTopics, ensureCodeCopy, copyTopic, readTopic, pauseTopic, resumeTopic, grantConsent, topicRel, topicMailProject } from '../scripts/topic.mjs';
import fs from 'node:fs';
import { topicLine } from '../scripts/index.mjs';
import { ensureWorkTopic, autoFallback } from '../scripts/intake.mjs';
import { checkOverlap, topicScopeText } from '../scripts/handoff.mjs';
import { topicStalled, stallCheckMs } from '../scripts/waker.mjs';
import { commsSettings, readObligations } from '../scripts/comms.mjs';
import { readHolder } from '../scripts/brain.mjs';
import { grantFix, FIX_ANSWERS } from '../scripts/fix-gate.mjs';
import { freezeRejectText } from '../scripts/freeze.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, id] = args._;
const out = (s) => process.stdout.write(s + '\n');
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const originContext = (ctx) => { try { const o = loadContext({ requireBrain: false }); return o.brainDir ? o : ctx; } catch { return ctx; } };

// A thread started with an empty task has no instructions (observed 2026-11-14: --task "$(cat <missing file>)" gave an
// empty string and create started the topic and its thread anyway): refuse before anything is created.
if (['create', 'thread', 'auto'].includes(cmd) && 'task' in args && (typeof args.task !== 'string' || !args.task.trim())) {
  fail(`topic.mjs ${cmd}: --task is empty or only whitespace; give the operator's task text (--task "<task>"; with --task "$(cat <file>)" check that the file exists and is not empty); nothing created (no topic, thread or worktree)`);
}

// --project <name> without a slash that is no folder under cwd names a repo of the domain (a sibling of the persona
// brain, <domain>/<name>); a bare name used to resolve from cwd (maintainer/workflow-dev 2026-11-14: --project agentic-flow from
// the persona brain gave agentic-alice/agentic-flow and "brain unavailable").
function projectArg(value) {
  if (typeof value !== 'string' || !value || /[\\/]/.test(value) || value === '.' || value === '..') return value;
  if (fs.existsSync(path.resolve(value))) return value;
  const cwd = gitToplevel(process.cwd()) || process.cwd();
  const domain = resolveDomain(cwd, os.homedir(), { field: false });
  const repos = domainRepos(domain);
  const hit = repos.find((r) => r.name === value);
  if (hit) return hit.dir;
  const where = domain ? `domain ${domain.root}` : `no domain above ${cwd}`;
  fail(`--project ${value}: expected the name of a repo in the domain or a path to it; ${value} is neither a folder under ${process.cwd()} nor a repo of the ${where}${repos.length ? ` (repos: ${repos.map((r) => r.name).join(', ')})` : ''}`);
}

try {
  if (args.project) args.project = projectArg(args.project);
  const ctx = loadContext({ project: args.project });
  const foreign = foreignProjectCwd(ctx, args.project);
  if (foreign) fail(foreign);
  if (cmd === 'create') {
    if (!id) fail(`usage: topic.mjs create <id> --subject "..." --class web|code|ops|discussion [--task "..."] [--here | --new-thread]\n${CLASS_HELP}`);
    // The class decides the kind (D-0021): web and code get a code copy, ops and discussion do not.
    const res = createTopic(ctx, { id, subject: args.subject, class: args.class, kind: typeof args.kind === 'string' ? args.kind : null, mode: args.mode, claim: !args['no-claim'], copy: !args['no-copy'], forThread: args['for-thread'] || null, task: args.task || null, explicitProject: !!args.project, not: str(args.not), distinct: str(args.distinct),
      // Layout 2 (D-0044): topic create from a thread is a topic the operator gave; from code without a thread it is technical.
      assignedBy: ctx.thread ? 'operator' : 'technical',
      // D-0031: with --project the orchestrator topic is the one this thread holds in its own project.
      origin: args.project ? originContext(ctx) : ctx,
      // In T3 a new topic gets its own thread (P-036) when this thread already works on a topic (or --new-thread); a
      // thread without a topic takes it itself: the operator gave the task here (alice 2026-11-03: a duplicate thread).
      // --new-thread also from code without a thread id (cron, D-0019): the new thread holds the topic.
      newThread: !args.here && !args['no-claim'] && !args['for-thread'] && (!!process.env.T3CODE_THREAD_ID || !ctx.thread) && (!!args['new-thread'] || heldTopics(ctx.brainDir, ctx.thread).length > 0) });
    for (const l of res.overlap || []) out(l);
    out(`topic ${id} created (class ${res.topic.class}, ${res.topic.kind})`);
    if (res.handoff) out(`handoff: recorded in topic ${res.handoff} (its handover shows the live state in "## Odovzdané", agent-alice/D-0082)`);
    if (res.thread) out(`thread ${res.thread} started with title ${id}; it holds the topic (this thread does not)`);
    if (res.effortNote) out(res.effortNote);
    if (res.claim) out(res.claim.ok ? `${res.claim.assigned ? `assigned to ${res.claim.holder.thread}` : `claimed by ${ctx.thread}`}${res.claim.pushed ? ', pushed' : ''}` : res.claim.reason);
    if (res.claim?.comms && !res.claim.comms.ok && !res.claim.comms.skipped) out(`comms: topic not registered (${res.claim.comms.reason})`);
    if (res.copy) out(`code copy: ${res.copy.path} (branch ${res.copy.branch})`);
    if (res.write.unpushed) out(`unpushed: ${res.write.unpushed}`);
    if (res.claim && !res.claim.ok) process.exit(1);
  } else if (cmd === 'auto') {
    // Code without a thread (cron: issue watch of a persona, D-0019): the topic of an automatic input with its own thread,
    // in the project of --repo by policy topics.auto (D-0035). Prints `mail: <project>/<topic>` (where its mail goes);
    // on failure `fallback: <address>` (the policy orchestrator, else the persona main thread) and exit 1.
    if (!id) fail('usage: topic.mjs auto <id> --subject "..." [--repo <repo name>] [--task ".."] [--class code] [--persona <name>]');
    ctx.thread = null;
    // agent-alice/D-0082 (point 3): code never refuses for an overlap, it prints `overlap: <id> (<how>)` for its log.
    const autoClass = typeof args.class === 'string' ? args.class : 'code';
    const autoRepo = ['code', 'web'].includes(autoClass) ? (typeof args.repo === 'string' ? args.repo : path.basename(mainCheckout(ctx.projectDir))) : null;
    for (const l of checkOverlap(ctx, { scope: topicScopeText(str(args.subject), str(args.task)), repo: autoRepo, exclude: [id] }).lines) out(l);
    const res = ensureWorkTopic(ctx, { id, subject: args.subject, task: typeof args.task === 'string' ? args.task : null, class: typeof args.class === 'string' ? args.class : 'code', repo: typeof args.repo === 'string' ? args.repo : null });
    // D-0069: the limit of active code topics on this machine is full; nothing is created, no fallback (it would go round
    // the limit): exit 3, the caller logs it and a later run takes the item. The last line is the reason.
    if (res.step === 'waiting') {
      out(`topic ${id} not created; ${res.reason}; a later run takes it`);
      out(`waiting: ${res.active} active`);
      process.exit(3);
    }
    // P-074: frozen repo: nothing is created and nobody gets a fallback (it would come every run); exit 4, the caller
    // rejects the issue with the reason (`reject:` is the text for it) and asks to report it again in the new version.
    if (res.step === 'frozen') {
      out(`topic ${id} not created; ${res.reason}`);
      out(`reject: ${freezeRejectText(res.freeze, id, 'Issue')}`);
      out(`frozen: until ${res.freeze?.until || 'the new version'}`);
      process.exit(4);
    }
    if (res.mail) out(`mail: ${res.mail}`);
    if (res.copy) out(`code copy: ${res.copy}`);
    if (res.ok) out(`topic ${id} ${res.step}, thread ${res.thread}`);
    else {
      const fb = autoFallback(ctx, typeof args.persona === 'string' ? args.persona : null);
      if (fb) out(`fallback: ${fb}`);
      out(`topic ${id} (${res.step}): ${res.reason}`);
      process.exit(1);
    }
  } else if (cmd === 'thread') {
    if (!id) fail('usage: topic.mjs thread <id> [--task ".."] [--mode operator|auto] [--for-thread <id started by t3_thread_launch>]');
    const res = startThreadForTopic(ctx, id, { task: args.task || null, mode: args.mode, forThread: typeof args['for-thread'] === 'string' ? args['for-thread'] : null, not: str(args.not), distinct: str(args.distinct) });
    if (!res.ok) fail(res.reason);
    for (const l of res.overlap || []) out(l);
    if (res.handoff) out(`handoff: recorded in topic ${res.handoff} (agent-alice/D-0082)`);
    if (res.handoffError) out(`handoff: not recorded (${res.handoffError})`);
    out(`thread ${res.thread} ${args['for-thread'] ? 'assigned' : `started with title ${id}`}; it holds the topic${res.claim.pushed ? ', pushed' : ''}`);
    if (res.effortNote) out(res.effortNote);
    if (res.claim.comms && !res.claim.comms.ok && !res.claim.comms.skipped) out(`comms: topic not registered (${res.claim.comms.reason})`);
  } else if (cmd === 'claim') {
    if (!id) fail('usage: topic.mjs claim <id> [--force --operator-approved]');
    const res = claimTopic(ctx, id, { force: !!args.force, operatorApproved: !!args['operator-approved'], mode: args.mode });
    if (!res.ok) fail(res.reason);
    out(res.modeChanged ? `topic ${id} mode ${res.holder.mode}${res.comms?.ok ? ', comms updated' : ''}` : res.already ? `topic ${id} already held by ${ctx.thread}${res.comms?.ok ? ', comms registered' : ''}` : `topic ${id} claimed by ${ctx.thread}${res.holder?.took_over_from ? ` (took over from ${res.holder.took_over_from})` : ''}${res.pushed ? ', pushed' : ''}`);
    if (res.warning) out(res.warning);
    if (res.comms && !res.comms.ok && !res.comms.skipped) out(`comms: topic not registered (${res.comms.reason})`);
    const topic = readTopic(ctx.brainDir, id);
    if (topic?.kind === 'code' && !args['no-copy']) {
      const copy = ensureCodeCopy(ctx, id);
      out(`code copy: ${copy.path} (branch ${copy.branch})`);
    }
  } else if (cmd === 'main') {
    const res = claimMain(ctx, { mode: args.mode, force: !!args.force, operatorApproved: !!args['operator-approved'] });
    if (!res.ok) fail(res.reason);
    out(res.already ? `topic main already held by ${ctx.thread}${res.comms?.ok ? ', comms registered' : ''}` : `topic main claimed by ${ctx.thread}${res.holder?.took_over_from ? ` (took over from ${res.holder.took_over_from})` : ''}${res.pushed ? ', pushed' : ''}`);
    if (res.warning) out(res.warning);
    if (res.comms && !res.comms.ok && !res.comms.skipped) out(`comms: main thread not registered (${res.comms.reason})`);
  } else if (cmd === 'release') {
    if (!id) fail('usage: topic.mjs release <id>');
    const res = releaseTopic(ctx, id, { force: !!args.force, operatorApproved: !!args['operator-approved'] });
    out(res.already ? `topic ${id} has no holder` : `topic ${id} released`);
    if (res.comms && !res.comms.ok && !res.comms.skipped) out(`comms: topic not registered as free (${res.comms.reason})`);
    if (res.mail) out(res.mail);
  } else if (cmd === 'handoff') {
    if (!id) fail('usage: topic.mjs handoff <id> [--task ".." --done ".." --next ".." --files ".." --questions ".."] [--leave-outbox]');
    const handover = args.task || args.done || args.next ? { task: args.task, done: args.done, next: args.next, files: args.files, questions: args.questions } : null;
    const res = handoffTopic(ctx, id, { handover, leaveOutbox: !!args['leave-outbox'] });
    for (const step of res.steps || []) out(step);
    for (const n of res.notices || []) out(n);
    if (!res.ok) fail(res.reason);
    out(`topic ${id} handed off${res.pushed ? ', pushed' : ''}: on the other machine run topic.mjs claim ${id} (it pulls first)`);
    if (res.comms && !res.comms.ok && !res.comms.skipped) out(`comms: topic not registered as free (${res.comms.reason})`);
  } else if (cmd === 'pause') {
    if (!id) fail('usage: topic.mjs pause <id> [--until <ISO | <n>d | <n>h>] [--reason ".."]');
    const rel = /^(\d+)\s*([dh])$/i.exec(String(args.until || ''));
    const until = rel ? new Date(Date.now() + Number(rel[1]) * (rel[2].toLowerCase() === 'd' ? 86400_000 : 3600_000)).toISOString() : args.until || null;
    const res = pauseTopic(ctx, id, { until, reason: args.reason || null });
    out(`topic ${id} paused${res.topic.paused_until ? ` until ${localTime(res.topic.paused_until)}` : ''}`);
  } else if (cmd === 'resume') {
    if (!id) fail('usage: topic.mjs resume <id>');
    const res = resumeTopic(ctx, id);
    out(res.already ? `topic ${id} is not paused` : `topic ${id} resumed`);
  } else if (cmd === 'list') {
    const topics = listTopics(ctx.brainDir);
    out(topics.length ? topics.map((t) => topicLine(t)).join('\n') : 'no open topics');
  } else if (cmd === 'closed') {
    // Condition of a timer waiting for another topic (timer.mjs --topic): exit 0 once the topic is no longer open.
    if (!id) fail('usage: topic.mjs closed <id>');
    const open = !!readTopic(ctx.brainDir, id);
    out(open ? `topic ${id} open` : `topic ${id} closed`);
    process.exitCode = open ? 1 : 0;
  } else if (cmd === 'stalled') {
    // Condition of the stall check of a handed-off topic (agent-alice/D-0084, scripts/waker.mjs topicStalled): exit 0 = it stands.
    if (!id) fail('usage: topic.mjs stalled <id>');
    // The topic's view in the mail (P-072): its mailbox and its holder's thread, not this (the giver's) thread. One
    // obligations call: the inbox (mail waits for the topic) and awaiting (it waits for an answer the mail checks later);
    // during an outage the client's backup.
    const s = commsSettings(ctx);
    let view;
    const obligations = (tid) => {
      if (view === undefined) {
        const res = s.enabled ? readObligations(ctx, { topics: [`${topicMailProject(ctx.brainDir, tid) || s.project}/${tid}`], thread: readHolder(ctx.brainDir, tid).thread || null }) : null;
        view = res?.ok ? res.data || {} : {};
      }
      return view;
    };
    const mailWaiting = (tid) => (obligations(tid).inbox?.n || 0) > 0;
    const awaitingReply = (tid, now) => (obligations(tid).awaiting || []).some((a) => a.wait_due_at && Date.parse(a.wait_due_at) > now);
    const r = topicStalled(ctx.brainDir, id, { quietMs: stallCheckMs(ctx.policy), mailWaiting, awaitingReply, ...(typeof args.now === 'string' ? { now: Date.parse(args.now) } : {}) });
    out(r.stalled ? `topic ${id} stands since ${localTime(r.since)}; next: ${r.next || '-'}` : `topic ${id} does not stand: ${r.why}`);
    process.exitCode = r.stalled ? 0 : 1;
  } else if (cmd === 'status') {
    const held = heldTopics(ctx.brainDir, ctx.thread);
    out(`thread ${ctx.thread || '-'}`);
    out(held.length ? held.map((t) => `holds ${topicLine(t)}`).join('\n') : 'holds no topic');
  } else if (cmd === 'consent') {
    // P-064: the orchestrator grants one exact call of the thread of topic <id> (a step a hook leaves to a confirmation).
    if (!id) fail('usage: topic.mjs consent <id> --tool <Bash|Write|Edit|…> --target "<exact command or path>" | --target-file <file> [--reason ".."] | --fix yes|no');
    if (args.fix !== undefined) {
      // P-075: the answer to the fix of a topic from a report or an issue; the thread's hook lets its writes pass after yes.
      const c = grantFix(ctx, id, String(args.fix), { reason: typeof args.reason === 'string' ? args.reason : null, origin: args.project ? originContext(ctx) : ctx });
      out(`fix of topic ${id}: ${FIX_ANSWERS[c.target]} (consent ${c.id}); tell its thread by mail: comms send --reply-to <its question> --state hotovo --fix ${c.target}`);
      process.exit(0);
    }
    const target = typeof args['target-file'] === 'string' ? fs.readFileSync(args['target-file'], 'utf8') : args.target;
    const res = grantConsent(ctx, id, { tool: args.tool, target: typeof target === 'string' ? target : '', reason: typeof args.reason === 'string' ? args.reason : null, origin: args.project ? originContext(ctx) : ctx });
    out(`consent ${res.consent.id} for topic ${id}: ${res.consent.tool} ${JSON.stringify(res.consent.target).slice(0, 200)}${res.write?.sync?.pushed ? ', pushed' : ''}`);
  } else if (cmd === 'copy') {
    if (!id) fail('usage: topic.mjs copy <id> [--operator-approved]');
    const copy = copyTopic(ctx, id, { operatorApproved: !!args['operator-approved'], explicitProject: !!args.project });
    out(`code copy: ${copy.path} (branch ${copy.branch})${copy.created ? '' : ' (existing)'}${copy.recorded ? `; recorded in ${topicRel(ctx.brainDir, id, 'topicFile')}` : ''}`);
    if (copy.write?.unpushed) out(`unpushed: ${copy.write.unpushed}`);
    if (readTopic(ctx.brainDir, id)?.kind !== 'code') out(`next: delegate.mjs prepare --implement${readTopic(ctx.brainDir, id)?.class === 'ops' ? '' : ' web|code|ops'} --task-file <file> (the worker changes the copy; commit, merge and release stay in this thread, D-0020)`);
  } else {
    fail('usage: topic.mjs create|claim|main|release|handoff|pause|resume|list|status|closed|stalled|copy|consent|auto');
  }
} catch (err) {
  fail(err.message);
}
