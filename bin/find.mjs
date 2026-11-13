#!/usr/bin/env node
// find.mjs <query> | --relates-to <path> | --similar <key>   [--json]
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { find, findWords, findRelatesTo, findSimilar, formatMatches, withAuthors } from '../scripts/find.mjs';
import { recordAuthors } from '../scripts/authors.mjs';
import { catalogConfig } from '../scripts/catalog/config.mjs';
import { findCatalog, formatCatalogBlock } from '../scripts/catalog/find.mjs';

const args = parseArgs(process.argv.slice(2));
try {
  const ctx = loadContext({ project: args.project });
  let matches;
  let label;
  let catalog = null; // data catalog block (only for a text query and a repo with a source)
  if (args['relates-to']) {
    matches = findRelatesTo(ctx.brainDir, args['relates-to'], { domain: ctx.domain });
    label = `relates-to ${args['relates-to']}`;
  } else if (args.similar) {
    matches = findSimilar(ctx.brainDir, args.similar);
    label = `similar ${args.similar}`;
  } else {
    const q = args._.join(' ');
    if (!q) fail('usage: find.mjs <query> | --relates-to <path> | --similar <key>');
    matches = find(ctx.brainDir, q, ctx.domain);
    label = q;
    if (!matches.length) {
      matches = findWords(ctx.brainDir, q, ctx.domain);
      if (matches.length && !args.json) process.stdout.write(`no exact match: ${q}; word matches:\n`);
    }
    try {
      const cfg = catalogConfig(ctx.projectDir);
      if (cfg.enabled) catalog = { cfg, res: findCatalog(cfg, q, { limit: ctx.policy?.limits?.catalog_find_lines ?? cfg.find.max_lines }) };
    } catch { /* the catalog never breaks the brain search */ }
  }
  // A record of another operator carries their name (scripts/authors.mjs); a brain of one author prints as before.
  if (matches.length && ctx.brainDir) matches = withAuthors(matches, recordAuthors(ctx.brainDir));
  if (args.json) {
    // without a catalog the output is the same array as before; with one, a catalog key joins it
    process.stdout.write(JSON.stringify(catalog ? { matches, catalog: catalog.res.matches } : matches) + '\n');
  } else {
    process.stdout.write((matches.length ? formatMatches(matches) : `no match: ${label}`) + '\n');
    if (catalog && catalog.res.total) process.stdout.write(formatCatalogBlock(catalog.res, catalog.cfg) + '\n');
  }
} catch (err) {
  fail(err.message);
}
