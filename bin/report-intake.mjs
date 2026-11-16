#!/usr/bin/env node
// Intake of mailed error reports (spec 7.3, plan B15): a report held under the key `report-<fp>` of this project is
// delivered to the maintainer topic (policy maintainer comms); no topic or thread per report. Run by cron every minute
// in the maintainer's project, as code without a thread id (D-0019); log local/report-intake.log.
//   report-intake.mjs [--project <dir>]
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { runIntake, withIntakeLock } from '../scripts/intake.mjs';

// Code without a thread id (D-0019): an inherited thread id would make the mail client act as that thread (--thread
// fallback of the client on T3CODE_THREAD_ID).
delete process.env.WORKFLOW_THREAD_ID;
delete process.env.T3CODE_THREAD_ID;

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: args.project && args.project !== true ? String(args.project) : undefined });
  ctx.thread = null;
  const lines = withIntakeLock(ctx, () => runIntake(ctx));
  if (lines === null) process.stdout.write('report-intake: previous run still going\n');
  else for (const l of lines) process.stdout.write(`${l}\n`);
} catch (err) {
  fail(`report-intake: ${err.message}`);
}
