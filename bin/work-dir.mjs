#!/usr/bin/env node
// Work files folder of this thread (P-052, P-068).
//   work-dir.mjs [--main] [--project <dir>]
// Prints the folder and creates it: a brain in data layout 2 temy/<topic this thread holds, else main>/tmp, layout 1
// scratch/ of the project. --main: the folder of topic main, for a file several topics read (a loop log). Project and
// brain from --project, WORKFLOW_PROJECT_DIR or cwd; thread from WORKFLOW_THREAD_ID or T3CODE_THREAD_ID. Skill scripts
// call it instead of a fixed path (operator 2026-11-14: scripts and skills stay maintainable only without fixed paths).
import fs from 'node:fs';
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { workDir } from '../scripts/topic-files.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: typeof args.project === 'string' ? args.project : undefined, requireBrain: false });
  const dir = workDir({ projectDir: ctx.projectDir, brainDir: ctx.brainDir, thread: args.main ? null : ctx.thread });
  if (!dir) fail(`work-dir: no work files folder for ${ctx.projectDir}`);
  fs.mkdirSync(dir, { recursive: true });
  process.stdout.write(`${dir}\n`);
} catch (err) {
  fail(err.message);
}
