#!/usr/bin/env node
// topic.mjs create <id> --subject "..." --class web|code|ops|discussion [--task "<task>"] [--no-claim] [--no-copy] [--here]
//                        [--new-thread | --for-thread <new thread id>] --requested-by operator|supervisor   a new thread only
//                        on the explicit request of the operator or the supervisor, recorded in topic.json (spec 3.4)
//                        open topics of the same repo or project whose scope overlaps are listed (overlap: lines), nothing refused
//           claim <id> [--force --operator-approved] [--mode operator|auto]   a takeover lists "Hotové" and the pushed branches
//                        topic/<id> and topic/<id>--* to compare (spec 4.2.3)
//           task-copy <task> [--topic <id>]   worktree <topic>--<task> on branch topic/<topic>--<task> from the topic branch
//                        (spec 3.7; task name obsah reserved, 4.6); every commit there is pushed (post-commit hook, O16)
//           task-merge <task> [--topic <id>]   after the check: merge it into topic/<topic>, push, remove worktree and branch
//           release <id> [--force --operator-approved]
//           handoff <id> [--task ".." --done ".." --next ".." --files ".." --questions ".." --tasks ".."] [--leave-outbox]
//                        to another machine: flush logs, send outbox, handover, release, push (P-040)
//           main [--force --operator-approved]   persona main thread (topic main, P-045)
//           thread <id> --requested-by operator|supervisor [--task ".."] [--mode operator|auto] [--for-thread <id>]
//                        new T3 thread for a free topic (P-036, spec 3.4)
//           pause <id> [--until <ISO | <n>d | <n>h>] [--reason ".."]   snooze: no bells until resumed or until
//           resume <id>
//           mode <id> discussion|off   mode of the topic (spec 10.6): discussion only over a handover without a next step,
//                        in it save handover refuses --next; off on an order to work; only the holder; the class stays
//           repos <id> <repo> [<repo> ...] [--main <repo>]   target repos of the topic (spec 4.5): outputs and sources go
//                        to the main one (default the first); a topic with a code copy gets a worktree in each; only the holder
//           snapshot [<id>]   after save.mjs handover in this turn: saves the bound and cited work files, the turn ends
//                        without a continuation and the start after /clear loads the handover; the topic stays open
//           list | status
//           closed <id>   exit 0 once the topic is no longer open (a condition for timer.mjs --until)
//           copy <id> [--operator-approved]   code copy (branch topic/<id>); a discussion topic gets one only after the
//                        operator approved its implementation (D-0020), recorded in topics/<id>/topic.json; done merges it
import { parseArgs, fail, localTime, gitToplevel } from '../scripts/util.mjs';
import { loadContext, foreignProjectCwd, resolveDomain } from '../scripts/config.mjs';
import { domainRepos } from '../scripts/repo-knowledge.mjs';
import os from 'node:os';
import path from 'node:path';
import { createTopic, setTopicMode, setTopicRepos, CLASS_HELP, startThreadForTopic, claimTopic, claimMain, releaseTopic, handoffTopic, listTopics, heldTopics, ensureCodeCopy, copyTopic, readTopic, pauseTopic, resumeTopic, topicRel, topicMailProject, taskCopy, taskMerge, takeoverLines } from '../scripts/topic.mjs';
import fs from 'node:fs';
import { topicLine } from '../scripts/index.mjs';
import { snapshotTopic } from '../scripts/snapshot.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, id] = args._;
const out = (s) => process.stdout.write(s + '\n');
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const originContext = (ctx) => { try { const o = loadContext({ requireBrain: false }); return o.brainDir ? o : ctx; } catch { return ctx; } };

// A thread started with an empty task has no instructions (observed 2026-11-14: --task "$(cat <missing file>)" gave an
// empty string and create started the topic and its thread anyway): refuse before anything is created.
if (['create', 'thread'].includes(cmd) && 'task' in args && (typeof args.task !== 'string' || !args.task.trim())) {
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
    if (!id) fail(`usage: topic.mjs create <id> --subject "..." --class web|code|ops|discussion [--task "..."] [--here | --new-thread --requested-by operator|supervisor]\n${CLASS_HELP}`);
    // The class decides the kind (D-0021): web and code get a code copy, ops and discussion do not.
    const res = createTopic(ctx, { id, subject: args.subject, class: args.class, kind: typeof args.kind === 'string' ? args.kind : null, mode: args.mode, claim: !args['no-claim'], copy: !args['no-copy'], forThread: args['for-thread'] || null, task: args.task || null, explicitProject: !!args.project, requestedBy: str(args['requested-by']),
      // Layout 2 (D-0044): topic create from a thread is a topic the operator gave; from code without a thread it is technical.
      assignedBy: ctx.thread ? 'operator' : 'technical',
      origin: args.project ? originContext(ctx) : ctx,
      // Spec 3.4 (plan B7): a new thread only with --new-thread on the request of the operator or the supervisor
      // (--requested-by); otherwise this thread claims the topic itself, also when it already holds one.
      newThread: !!args['new-thread'] && !args.here && !args['no-claim'] && !args['for-thread'] });
    for (const l of res.overlap || []) out(l);
    out(`topic ${id} created (class ${res.topic.class}, ${res.topic.kind})`);
    if (res.thread) out(`thread ${res.thread} started with title ${id}; it holds the topic (this thread does not)`);
    if (res.effortNote) out(res.effortNote);
    if (res.claim) out(res.claim.ok ? `${res.claim.assigned ? `assigned to ${res.claim.holder.thread}` : `claimed by ${ctx.thread}`}${res.claim.pushed ? ', pushed' : ''}` : res.claim.reason);
    if (res.claim?.comms && !res.claim.comms.ok && !res.claim.comms.skipped) out(`comms: topic not registered (${res.claim.comms.reason})`);
    if (res.copy) out(`code copy: ${res.copy.path} (branch ${res.copy.branch})`);
    if (res.write.unpushed) out(`unpushed: ${res.write.unpushed}`);
    if (res.claim && !res.claim.ok) process.exit(1);
  } else if (cmd === 'thread') {
    if (!id) fail('usage: topic.mjs thread <id> --requested-by operator|supervisor [--task ".."] [--mode operator|auto] [--for-thread <id started by t3_thread_launch>]');
    const res = startThreadForTopic(ctx, id, { task: args.task || null, mode: args.mode, forThread: typeof args['for-thread'] === 'string' ? args['for-thread'] : null, requestedBy: str(args['requested-by']) });
    if (!res.ok) fail(res.reason);
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
    // Spec 4.2.3 (plan B5): a takeover compares "Hotové" with the pushed topic branch and task branches.
    if (res.holder?.took_over_from) for (const l of takeoverLines(ctx, id)) out(l);
    const topic = readTopic(ctx.brainDir, id);
    if (topic?.kind === 'code' && !args['no-copy']) {
      const copy = ensureCodeCopy(ctx, id);
      out(`code copy: ${copy.path} (branch ${copy.branch})`);
    }
  } else if (cmd === 'task-copy') {
    if (!id) fail('usage: topic.mjs task-copy <task> [--topic <id>]');
    const res = taskCopy(ctx, id, { topic: str(args.topic) });
    out(`task copy: ${res.path} (branch ${res.branch} from ${res.base})${res.created ? '' : ' (existing)'}`);
    if (res.hook?.error) out(`push hook not installed (${res.hook.error}): push each commit of ${res.branch} yourself`);
    out(`next: delegate.mjs prepare --implement --task-copy ${id} --task-file <file>; after your check of its changes commit them on ${res.branch} (each commit is pushed), then topic.mjs task-merge ${id}`);
  } else if (cmd === 'task-merge') {
    if (!id) fail('usage: topic.mjs task-merge <task> [--topic <id>]');
    const res = taskMerge(ctx, id, { topic: str(args.topic) });
    for (const l of res.lines) out(l);
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
    if (!id) fail('usage: topic.mjs handoff <id> [--task ".." --done ".." --next ".." --files ".." --questions ".." --tasks ".."] [--leave-outbox]');
    const handover = args.task || args.done || args.next ? { task: args.task, done: args.done, next: args.next, files: args.files, questions: args.questions, tasks: args.tasks } : null;
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
  } else if (cmd === 'snapshot') {
    for (const line of snapshotTopic(ctx, id || null).lines) out(line);
  } else if (cmd === 'mode') {
    const mode = args._[2];
    if (!id || !['discussion', 'off'].includes(mode)) fail('usage: topic.mjs mode <id> discussion|off');
    const res = setTopicMode(ctx, id, mode);
    out(res.already ? `topic ${id} already in mode ${mode}` : `topic ${id} mode ${mode}${res.write?.sync?.pushed ? ', pushed' : ''}`);
  } else if (cmd === 'repos') {
    const names = args._.slice(2);
    if (!id || !names.length) fail('usage: topic.mjs repos <id> <repo> [<repo> ...] [--main <repo>]');
    const res = setTopicRepos(ctx, id, names, { main: typeof args.main === 'string' ? args.main : null });
    out(`topic ${id} target repos: ${res.repos.list.join(', ')} (main ${res.repos.main})${res.write?.sync?.pushed ? ', pushed' : ''}`);
    for (const c of res.copies) out(`code copy ${c.path} (${c.branch}${c.created ? ', created' : ''})`);
  } else if (cmd === 'list') {
    const topics = listTopics(ctx.brainDir);
    out(topics.length ? topics.map((t) => topicLine(t)).join('\n') : 'no open topics');
  } else if (cmd === 'closed') {
    // A condition (timer.mjs --until): exit 0 once the topic is no longer open.
    if (!id) fail('usage: topic.mjs closed <id>');
    const open = !!readTopic(ctx.brainDir, id);
    out(open ? `topic ${id} open` : `topic ${id} closed`);
    process.exitCode = open ? 1 : 0;
  } else if (cmd === 'status') {
    const held = heldTopics(ctx.brainDir, ctx.thread);
    out(`thread ${ctx.thread || '-'}`);
    out(held.length ? held.map((t) => `holds ${topicLine(t)}`).join('\n') : 'holds no topic');
  } else if (cmd === 'copy') {
    if (!id) fail('usage: topic.mjs copy <id> [--operator-approved]');
    const copy = copyTopic(ctx, id, { operatorApproved: !!args['operator-approved'], explicitProject: !!args.project });
    out(`code copy: ${copy.path} (branch ${copy.branch})${copy.created ? '' : ' (existing)'}${copy.recorded ? `; recorded in ${topicRel(ctx.brainDir, id, 'topicFile')}` : ''}`);
    if (copy.write?.unpushed) out(`unpushed: ${copy.write.unpushed}`);
    if (readTopic(ctx.brainDir, id)?.kind !== 'code') out(`next: delegate.mjs prepare --implement${readTopic(ctx.brainDir, id)?.class === 'ops' ? '' : ' web|code|ops'} --task-file <file> (the worker changes the copy; commit, merge and release stay in this thread, D-0020)`);
  } else {
    fail('usage: topic.mjs create|claim|main|release|handoff|snapshot|pause|resume|mode|repos|list|status|closed|copy|task-copy|task-merge|thread');
  }
} catch (err) {
  fail(err.message);
}
