#!/usr/bin/env node
// vault.mjs build --out <dir> | publish --out <dir>
// Read-only vault of the knowledge of every store of the machine (D-0028) for Obsidian: wikilinks, README index, Bases
// file. build writes the folder; publish builds, then commits ("vault: rebuild") and pushes when <dir> is a git repo and
// something changed. One line: vault <out>: stores N, files M, links K, unresolved U (publish adds changed|unchanged).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { buildVault, publishVault, summaryLine } from '../scripts/vault.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (!['build', 'publish'].includes(cmd) || typeof args.out !== 'string') fail('usage: vault.mjs build --out <dir> | vault.mjs publish --out <dir>');
  const out = path.resolve(args.out);
  const ctx = loadContext({ project: args.project });
  if (cmd === 'publish' && !fs.existsSync(path.join(out, '.git'))) {
    publishVault(out); // not a git repo: throws with the way to set it up, before anything is written
  }
  const res = buildVault(ctx, out);
  process.stdout.write(`${summaryLine(args.out, res)}\n`);
  if (cmd === 'publish') {
    const pub = publishVault(out);
    process.stdout.write(`${pub.state}${pub.note ? ` (${pub.note})` : ''}\n`);
  }
} catch (err) {
  fail(err.message);
}
