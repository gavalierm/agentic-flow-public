#!/usr/bin/env node
// denials.mjs [--days 7] [--json]: hook decisions (deny, ask, block) from <brain>/local/denials.jsonl, grouped by
// principle and event, most frequent first, with the last inputs of each. A group that keeps coming back with inputs
// that should have passed is a false positive of that check: fix the check (skill fix), not the agent.
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { readDenials, summarize, denialsFile } from '../scripts/denials.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: args.project });
  const days = Number(args.days ?? 7);
  if (!Number.isFinite(days) || days <= 0) fail('usage: denials.mjs [--days <n>] [--json]');
  const entries = readDenials(ctx.brainDir, { days });
  const groups = summarize(entries);
  if (args.json) process.stdout.write(JSON.stringify({ file: denialsFile(ctx.brainDir), days, total: entries.length, groups }, null, 2) + '\n');
  else {
    process.stdout.write(`denials: ${entries.length} in ${days} d (${denialsFile(ctx.brainDir)})\n`);
    for (const g of groups) {
      process.stdout.write(`${String(g.n).padStart(4)}  ${g.key}\n`);
      for (const l of g.last) process.stdout.write(`        ${String(l || '').slice(0, 140)}\n`);
    }
  }
} catch (err) {
  fail(err.message);
}
