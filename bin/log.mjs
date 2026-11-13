#!/usr/bin/env node
// log.mjs flush --session <id>      write buffered observations to brain logs (one commit per turn)
//         failures [--resolve <id> [<id> ...]]  list unprocessed failures / remove them by stable id (after error skill)
//         names <procedures|derivations>
//         remove --match "<text>" --reason "operator <YYYY-MM-DD>: <why>"   deletes every log line containing the text
//                                   (all machines' day files, old shared logs); only on an explicit operator order
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, dialogAnsweredInTurn } from '../scripts/config.mjs';
import { flushBuffer, listFailures, formatFailures, existingNames, resolveFailuresOp, removeLinesOps } from '../scripts/logs.mjs';
import { brainWrite } from '../scripts/brain.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, arg] = args._;
try {
  const ctx = loadContext({ project: args.project });
  if (cmd === 'flush') {
    const res = flushBuffer(ctx, args.session || 'manual');
    process.stdout.write(`${res.written ? 'flushed' : 'nothing to flush'}${res.sequences ? `; sequences ${res.sequences}` : ''}${res.failures ? `; failures ${res.failures}` : ''}\n`);
    for (const s of res.signals) process.stdout.write(`${s}\n`);
  } else if (cmd === 'failures') {
    const lines = listFailures(ctx.brainDir);
    if (args.resolve) {
      const r = resolveFailuresOp(ctx.brainDir, [args.resolve, ...args._.slice(1)]);
      brainWrite(ctx, { internal: true, ops: [r.op], message: `failure ${r.ids.join(' ')} processed via error skill` });
      process.stdout.write(`resolved failure ${r.ids.join(', ')}; remaining ${r.remaining}\n`);
    } else {
      process.stdout.write(lines.length ? formatFailures(lines) + '\n' : 'no unprocessed failures\n');
    }
  } else if (cmd === 'names') {
    const log = arg === 'derivations' ? 'derivations.log' : 'procedures.log';
    const names = existingNames(ctx.brainDir, log);
    process.stdout.write(names.length ? names.map((n) => `${n.name} ${n.count}x`).join('\n') + '\n' : `no names in ${log}\n`);
  } else if (cmd === 'remove') {
    // Brain logs are written only by scripts (P-013); the shell (sed, git commit) is denied by the brain hook (report-526ff5ce).
    const match = args.match === true ? '' : String(args.match || '');
    if (!match.trim()) fail('usage: log.mjs remove --match "<text>" --reason "operator <YYYY-MM-DD>: <why>"');
    if (!args.reason || !/^operator\b/i.test(String(args.reason))) fail('--reason "operator <YYYY-MM-DD>: <why>" required: log lines are deleted only on an explicit operator order');
    // The operator's answer in a dialog of this turn is the order (D-0011), as in done --topic (report-f52368f8).
    if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread)) fail('log lines cannot be removed in a turn started by a message, and the operator answered no dialog in it: ask the operator with AskUserQuestion (P-047, D-0011)');
    const { ops, removed } = removeLinesOps(ctx.brainDir, match);
    if (!removed) fail(`no log line contains "${match}"`);
    brainWrite(ctx, { internal: true, ops, message: `remove ${removed} log line(s): ${args.reason}` });
    process.stdout.write(`removed ${removed} log line(s) from ${ops.map((o) => o.path).join(', ')}\n`);
  } else {
    fail('usage: log.mjs flush --session <id> | failures [--resolve n] | names procedures|derivations | remove --match "<text>" --reason "operator ..."');
  }
} catch (err) {
  fail(err.message);
}
