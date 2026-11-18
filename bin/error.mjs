#!/usr/bin/env node
// Support script for skill error (P-003, P-028, P-030): list unprocessed failures, check for an existing skill, mark a failure processed.
//   error.mjs list [--agent <id>]
//   error.mjs check <tool-or-work>      -> existing brain skill to extend, or "none"
//   error.mjs resolve <id> [<id> ...]   -> remove the listed failures (stable id from list, not the number) after the lesson was saved
//   error.mjs restore <brain commit>    -> bring back the failure(s) a wrong resolve commit dropped
//   error.mjs report --title "..." --text "..."   -> report to the maintainer's T3 thread (the mail server names it), sent once
//                                                by mail; no maintainer thread: an issue in the public workflow repo; both
//                                                unavailable: a draft in the held topic and a task for the operator (spec 7.3 to 7.5, P-003)
//   error.mjs report --to <[project/]topic> --title "..." --text "..." -> to the thread that did the work; maintainer only if unreachable
//   error.mjs report --from <message id>         -> a mailed report without pickup (no reply / undelivered: the thread is gone):
//                                                an issue in the public workflow repo, never mailed again (spec 7.4)
//   error.mjs confirm <issue url> --text "..."    -> the fix works in the reported scenario: comment, the watch ends (3c)
//   error.mjs reopen <issue url> --text "..."     -> the fix does not work: reopen with the evidence, the watch goes on
//   error.mjs watch [--force]                     -> check the watched issues now; prints the rings without a mail address
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { listFailures, formatFailures, resolveFailuresOp, restoreFailuresOp } from '../scripts/logs.mjs';
import { find, formatMatches } from '../scripts/find.mjs';
import { readSkills } from '../scripts/records.mjs';
import { tokens } from '../scripts/keys.mjs';
import { brainWrite, readHolder } from '../scripts/brain.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { isMainTopic } from '../scripts/comms.mjs';
import { report, scrub } from '../scripts/report.mjs';
import { confirmIssue, reopenIssue, watchIssues, undeliveredIssues, undeliveredFor, updateIssue, baseOf } from '../scripts/issue-watch.mjs';

// P-003 step 5: every error goes to the workflow maintainer, or the lesson stays in one brain.
const REPORT_LINE = 'then report the error to the workflow maintainer: error.mjs report --title "<short>" --text "chyba: ...; príčina: ...; uložené: ..."; only its line "reported: ..." means reported (P-003)';

const args = parseArgs(process.argv.slice(2));
const [cmd, arg] = args._;
const out = (s) => process.stdout.write(s + '\n');

try {
  const ctx = loadContext({ project: args.project });
  if (cmd === 'list') {
    let lines = listFailures(ctx.brainDir);
    if (args.agent) lines = lines.filter((l) => l.split(' ')[1] === args.agent);
    out(lines.length ? formatFailures(lines) : 'no unprocessed failures');
    if (lines.length) out('after saving the lesson (save skill ... --origin error): error.mjs resolve <id> [<id> ...] (the id after the number; numbers shift)');
  } else if (cmd === 'check') {
    if (!arg) fail('usage: error.mjs check <tool-or-work>');
    const exact = find(ctx.brainDir, arg).filter((m) => m.kind === 'skill');
    const want = new Set(tokens(args._.slice(1).join(' ')));
    const fuzzy = readSkills(ctx.brainDir).filter((s) => tokens(`${s.skillName} ${s.description}`).some((t) => want.has(t))).map((s) => ({ path: s.path, description: `${s.skillName} [${s.owner}]: ${s.description}` }));
    const hits = exact.length ? exact : fuzzy;
    out(hits.length ? `existing skill(s) for "${arg}" (merge the lesson into the whole skill with --replace, do not create a new one):\n${formatMatches(hits)}` : `none: create a new skill with save skill <name> --origin error --description "Použi, keď ..."`);
    out(REPORT_LINE);
  } else if (cmd === 'resolve') {
    const r = resolveFailuresOp(ctx.brainDir, args._.slice(1));
    brainWrite(ctx, { internal: true, ops: [r.op], message: `error: failure ${r.ids.join(' ')} processed` });
    out(`failure ${r.ids.join(', ')} processed; remaining ${r.remaining}`);
  } else if (cmd === 'restore') {
    const r = restoreFailuresOp(ctx.brainDir, arg);
    brainWrite(ctx, { internal: true, ops: [r.op], message: `error: failure restored from ${arg}` });
    for (const l of r.lines) out(`restored: ${l}`);
  } else if (cmd === 'report') {
    const to = args.to && args.to !== true ? String(args.to) : null;
    const fromId = args.from && args.from !== true ? String(args.from) : null;
    const text = args.text && args.text !== true ? String(args.text) : null;
    if (!fromId && !text) fail('usage: error.mjs report [--to <[project/]topic>] --title "<short>" --text "chyba: ...; príčina: ...; uložené: ..." | --from <message id>');
    const title = args.title && args.title !== true ? String(args.title) : (text || '').split(/[;\n]/)[0].slice(0, 80);
    const r = await report(ctx, { text, title, fromId, to });
    out(r.line);
  } else if (cmd === 'confirm' || cmd === 'reopen') {
    const text = args.text && args.text !== true ? String(args.text) : null;
    if (!arg || !text) fail(`usage: error.mjs ${cmd} <issue url> --text "${cmd === 'confirm' ? 'overené: <scenár hlásenia> funguje vo <verzia>' : 'stále zlyhá: <scenár, výstup>'}"`);
    const fn = cmd === 'confirm' ? confirmIssue : reopenIssue;
    out(await fn(ctx, arg, text, process.env, (t) => scrub(t, ctx)));
  } else if (cmd === 'watch') {
    // The ring goes out as the instance, never as this thread (the mail client falls back on T3CODE_THREAD_ID).
    delete process.env.WORKFLOW_THREAD_ID;
    delete process.env.T3CODE_THREAD_ID;
    const r = await watchIssues({ force: !!args.force });
    for (const l of r.lines) out(l);
    // Rings without a mail address (project without persona, its topic closed): shown here once, then cleared (3c.2).
    // Only the records of this thread's topics (main: also those whose topic closed); another topic's answers stay for it.
    const base = baseOf(ctx);
    const held = ctx.brainDir && ctx.thread ? heldTopics(ctx.brainDir, ctx.thread) : [];
    const mine = ctx.brainDir && ctx.thread ? undeliveredFor(base, { held, main: held.some(isMainTopic), hasHolder: (id) => !!readHolder(ctx.brainDir, id) }) : undeliveredIssues(base);
    for (const u of mine) {
      out(`undelivered: ${u.url}: comments ${(u.undelivered.comments || []).join(', ') || '-'}, state ${u.undelivered.state || '-'} (${u.undelivered.why}); read it on GitHub, then error.mjs confirm|reopen ${u.url} --text "..."`);
      updateIssue(base, u.key, { undelivered: null });
    }
  } else {
    fail('usage: error.mjs list | check <tool> | resolve <id> [<id> ...] | restore <brain commit> | report [--to <topic>] --title ... --text ... | report --from <id> | confirm|reopen <issue url> --text ... | watch [--force]');
  }
} catch (err) {
  fail(err.message);
}
