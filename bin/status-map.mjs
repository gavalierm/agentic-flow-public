#!/usr/bin/env node
// Status map of the skill proposal (P-077): the page that shows what is done and what is not, as a tree.
//   status-map.mjs <data.json> [--out <page.html>]
// Writes the page next to the data (<data>.html) and prints its path; faulty data (unknown state, empty item) are
// refused with the place of the fault and nothing is written. The data format is in scripts/status-map.mjs and in the
// skill. The page is one document of a work: change the data and run this again, do not write a page by hand.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail } from '../scripts/util.mjs';
import { statusMapPage } from '../scripts/status-map.mjs';

const args = parseArgs(process.argv.slice(2));
const src = args._[0];
if (!src) fail('usage: status-map.mjs <data.json> [--out <page.html>]');
try {
  const out = typeof args.out === 'string' ? args.out : src.replace(/\.json$/i, '') + '.html';
  const page = statusMapPage(JSON.parse(fs.readFileSync(src, 'utf8')));
  fs.writeFileSync(out, page);
  process.stdout.write(`${path.resolve(out)}\n`);
} catch (err) {
  fail(`status-map: ${src}: ${err.message}`);
}
