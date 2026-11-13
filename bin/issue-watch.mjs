#!/usr/bin/env node
// Check of the issues error.mjs report created on this machine (3c, D-0023, D-0024): a new maintainer comment or a
// changed state rings the reporter's topic by mail (steer, link and comment ids only, P-047). Job `issue-watch` of the
// wake module (wake.json, written by adapter.mjs claude-code / project.mjs t3); one job checks all projects of the
// machine through the index of brains with records. Log: local/issue-watch.log of each brain.
//   issue-watch.mjs [--force]      --force ignores a GitHub rate-limit pause
import { parseArgs, fail } from '../scripts/util.mjs';
import { watchIssues } from '../scripts/issue-watch.mjs';

// Code without a thread id: the ring goes out as the instance, never as an inherited thread (mail client fallback).
delete process.env.WORKFLOW_THREAD_ID;
delete process.env.T3CODE_THREAD_ID;

const args = parseArgs(process.argv.slice(2));
try {
  const r = await watchIssues({ force: !!args.force });
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  for (const u of r.undelivered || []) process.stdout.write(`undelivered: ${u} (error.mjs watch in that project shows it)\n`);
} catch (err) {
  fail(`issue-watch: ${err.message}`);
}
