#!/usr/bin/env node
// Readability of a page for the operator (P-077, WCAG AA): contrast of text and of diagram lines in the light and the
// dark form, and the size of text. Run it on a page before it is shown; the hook refuses a page with a problem.
//   page-check.mjs <page.html> [<page.html> ...]
// Prints one line per problem with the two colours and the place, exit 1; a readable page prints one line, exit 0.
import fs from 'node:fs';
import { fail } from '../scripts/util.mjs';
import { checkPage } from '../scripts/page-check.mjs';

const files = process.argv.slice(2);
if (!files.length) fail('usage: page-check.mjs <page.html> [<page.html> ...]');
let bad = 0;
for (const file of files) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch (err) { fail(`page-check: ${file}: ${err.message}`); }
  const res = checkPage(html);
  if (!res.problems.length) { process.stdout.write(`${file}: readable (${res.judged} texts and lines measured${res.skipped ? `, ${res.skipped} not judged` : ''})\n`); continue; }
  bad += 1;
  process.stdout.write(`${file}: ${res.problems.length} problem(s)\n${res.problems.map((p) => `- ${p.line}${p.count > 1 ? ` (${p.count}×)` : ''}`).join('\n')}\n`);
}
process.exit(bad ? 1 : 0);
