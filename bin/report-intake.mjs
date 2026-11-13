#!/usr/bin/env node
// Intake of mailed error reports (3b, D-0022, D-0024): a report held in an unregistered topic `report-<fp>` of this
// project gets its topic (class code, its own thread holds it) and is delivered to that thread. Run by cron every
// minute in the maintainer's project, as code without a thread id (D-0019); log local/report-intake.log.
//   report-intake.mjs [--project <dir>]
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { runIntake, withIntakeLock } from '../scripts/intake.mjs';

// Code without a thread id (D-0019): an inherited thread id would make the topic library and the mail client act as
// that thread (claim, --thread fallback of the client on T3CODE_THREAD_ID).
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
