#!/usr/bin/env node
// Generate indexes into <brain>/local/index/ and report limits (P-039, P-010).
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { dataPath } from '../scripts/layout.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: args.project });
  const res = buildIndexes(ctx.brainDir, ctx.policy);
  const c = res.counts;
  process.stdout.write(`indexes: memory ${c.memory}, decisions ${c.decisions}, topics ${c.topics}, skills ${c.skills} -> ${dataPath(ctx.brainDir, 'local', 'index')}/\n`);
  for (const w of res.warnings) process.stdout.write(`limit: ${w}\n`);
  if (args.strict && res.warnings.length) process.exit(2);
} catch (err) {
  fail(err.message);
}
