#!/usr/bin/env node
// rules.mjs [--harness claude-code|codex] [--machine <name>] [--check]
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { assembleRules } from '../scripts/rules.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: args.project, requireBrain: false });
  const res = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: args.harness || 'claude-code', machine: args.machine, layers: ctx.layers });
  if (args.check) {
    process.stdout.write(`rules: ${res.lines} lines, ${res.chars} chars; exceptions: ${res.applied.length}; refused: ${res.errors.length}\n`);
    for (const e of res.errors) process.stdout.write(`refused: ${e}\n`);
    for (const o of res.overLimit) process.stdout.write(`limit: ${o}\n`);
    if (res.overLimit.length || res.errors.length) process.exit(2);
  } else {
    process.stdout.write(res.text);
    if (res.overLimit.length) process.stderr.write(`limit: ${res.overLimit.join('; ')}\n`);
  }
} catch (err) {
  fail(err.message);
}
