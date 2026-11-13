#!/usr/bin/env node
// find.mjs <query> | --relates-to <path> | --similar <key>   [--json]
// Searches every knowledge store of the machine (D-0028); a match outside the session brain names its store.
// No match in key, name, title, aliases or description: the record bodies, printed as paths only (D-0029).
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { findAll, findWordsAll, findBodyAll, findRelatesToAll, findSimilarAll, formatMatches, withAuthors } from '../scripts/find.mjs';
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
    matches = findRelatesToAll(ctx, args['relates-to']);
    label = `relates-to ${args['relates-to']}`;
  } else if (args.similar) {
    matches = findSimilarAll(ctx, args.similar);
    label = `similar ${args.similar}`;
  } else {
    const q = args._.join(' ');
    if (!q) fail('usage: find.mjs <query> | --relates-to <path> | --similar <key>');
    matches = findAll(ctx, q);
    label = q;
    if (!matches.length) {
      matches = findWordsAll(ctx, q);
      if (matches.length && !args.json) process.stdout.write(`no exact match: ${q}; word matches:\n`);
    }
    if (!matches.length) {
      matches = findBodyAll(ctx, q);
      if (matches.length && !args.json) process.stdout.write(`no match in key, name, aliases or description: ${q}; in the body of:\n`);
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
