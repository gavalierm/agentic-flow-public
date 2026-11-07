#!/usr/bin/env node
// Support script for skill error (P-003, P-028, P-030): list unprocessed failures, check for an existing skill, mark a failure processed.
//   error.mjs list [--agent <id>]
//   error.mjs check <tool-or-work>      -> existing brain skill to extend, or "none"
//   error.mjs resolve <n>               -> remove failure line n after the lesson was saved
//   error.mjs report --title "..." --text "..."   -> report to the maintainer: mail, else public issue, else draft (P-003)
//   error.mjs report --from <message id>          -> a mailed report without pickup (no reply / undelivered) as an issue
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { listFailures, resolveFailureOp } from '../scripts/logs.mjs';
import { find, formatMatches } from '../scripts/find.mjs';
import { readSkills } from '../scripts/records.mjs';
import { tokens } from '../scripts/keys.mjs';
import { brainWrite } from '../scripts/brain.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { report } from '../scripts/report.mjs';

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
    out(lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : 'no unprocessed failures');
    if (lines.length) out('after saving the lesson (save skill ... --origin error): error.mjs resolve <n>');
  } else if (cmd === 'check') {
    if (!arg) fail('usage: error.mjs check <tool-or-work>');
    const exact = find(ctx.brainDir, arg).filter((m) => m.kind === 'skill');
    const want = new Set(tokens(args._.slice(1).join(' ')));
    const fuzzy = readSkills(ctx.brainDir).filter((s) => tokens(`${s.skillName} ${s.description}`).some((t) => want.has(t))).map((s) => ({ path: s.path, description: `${s.skillName} [${s.owner}]: ${s.description}` }));
    const hits = exact.length ? exact : fuzzy;
    out(hits.length ? `existing skill(s) for "${arg}" (extend, do not create):\n${formatMatches(hits)}` : `none: create a new skill with save skill <name> --origin error --description "Použi, keď ..."`);
    // The maintainer's own thread does not mail itself: it fixes the error in workflow-dev directly (error skill, step 5).
    const maintainer = ctx.brainDir && ctx.thread && heldTopics(ctx.brainDir, ctx.thread).some((t) => t.id === 'workflow-dev');
    out(maintainer ? 'this thread holds workflow-dev: do not mail the report to yourself; fix the error here (skill fix) (P-003)' : REPORT_LINE);
  } else if (cmd === 'resolve') {
    const n = Number(arg);
    const r = resolveFailureOp(ctx.brainDir, n);
    brainWrite(ctx, { internal: true, ops: [r.op], message: `error: failure ${n} processed` });
    out(`failure ${n} processed; remaining ${r.remaining}`);
  } else if (cmd === 'report') {
    const maintainer = ctx.brainDir && ctx.thread && heldTopics(ctx.brainDir, ctx.thread).some((t) => t.id === 'workflow-dev');
    if (maintainer) fail('this thread holds workflow-dev: do not report to yourself; fix the error here (skill fix) (P-003)');
    const fromId = args.from && args.from !== true ? String(args.from) : null;
    const text = args.text && args.text !== true ? String(args.text) : null;
    if (!fromId && !text) fail('usage: error.mjs report --title "<short>" --text "chyba: ...; príčina: ...; uložené: ..." | --from <message id>');
    const title = args.title && args.title !== true ? String(args.title) : (text || '').split(/[;\n]/)[0].slice(0, 80);
    const r = await report(ctx, { text, title, fromId });
    out(r.line);
  } else {
    fail('usage: error.mjs list | check <tool> | resolve <n> | report --title ... --text ... | report --from <id>');
  }
} catch (err) {
  fail(err.message);
}
