#!/usr/bin/env node
// Move a domain (persona or project folder) under the projects root of this machine (carol 2026-11-09).
//   domain-move.mjs <domain dir> [--to <root>] [--dry]   plan (--dry) or move; the root is project.mjs root by default
//   domain-move.mjs finish <old domain path>             after the T3 server restart: history swap (old path stays a symlink)
// The move writes outside the domain of the session (P-052): the write hook asks the operator before it runs.
import { fail, parseArgs, toPosix } from '../scripts/util.mjs';
import { planMove, moveDomain, finishMove } from '../scripts/domain-move.mjs';

const args = parseArgs(process.argv.slice(2));
const [first, second] = args._;
const out = (s) => process.stdout.write(`${s}\n`);
const list = (lines) => lines.map((l) => `- ${l}`).join('\n');
try {
  if (first === 'finish') {
    if (!second) fail('usage: domain-move.mjs finish <old domain path>');
    out(list(finishMove(second)));
  } else {
    if (!first) fail('usage: domain-move.mjs <domain dir> [--to <root>] [--dry] | finish <old domain path>');
    const opts = typeof args.to === 'string' ? { root: args.to } : {};
    if (args.dry) {
      const p = planMove(first, opts);
      out(`plan: ${toPosix(p.src)} -> ${toPosix(p.dest)}\n${list([
        ...p.projects.map((x) => `project ${toPosix(x.dir)}${x.brainRel ? ` (brain ${x.brainRel})` : ''}: adapter, T3 workspaceRoot`),
        ...p.history.map((h) => `history ${h.to} -> ${h.from}`),
        'trust entries copied, absolute paths in the brains rewritten (logs and decisions stay)',
      ])}`);
    } else {
      const r = moveDomain(first, opts);
      out(`${list(r.lines)}\nT3 (the agent does these with the T3 tool now):\n${list(r.steps)}\nafter the T3 server restart: node ${toPosix(process.argv[1])} finish ${toPosix(r.src)}`);
    }
  }
} catch (err) {
  fail(err.message);
}
