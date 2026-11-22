#!/usr/bin/env node
// Entry of every hook in hooks.json: `node run.mjs <hook> [args]` turns on node's compile cache, then runs
// hooks/<hook>.mjs as if it were started itself (P-079: a hook loads ~50 modules, ~750 KB of source, at every tool call;
// with the cache a hook is 11 to 16 ms shorter, measured 2026-11-19). The cache must be on before the hook's modules
// load, so it cannot be turned on inside the hook: its static imports are compiled first. The cache is node's own
// (<tmp>/node-compile-cache, one entry per module, checked against the source); without it the hook runs as before.
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try { module.enableCompileCache?.(); } catch { /* the hook runs without the cache */ }
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), `${process.argv[2]}.mjs`);
if (!/^[a-z][a-z-]*$/.test(process.argv[2] || '') || !fs.existsSync(file)) {
  process.stderr.write(`run.mjs: no hook "${process.argv[2] ?? ''}" (usage: node run.mjs <hook> [args], hooks/<hook>.mjs)\n`);
  process.exit(1);
}
// The harness kills a hook at its timeout (hooks.json), wherever it is: between two writes, inside a git push. So a git
// call of the hook ends itself before that (scripts/util.mjs reads this time) and the hook goes on to its last steps: the
// Stop hook closes the turn in the mail, the state is written. The last fifth of the time (at least 4 s) is for them.
try {
  const text = fs.readFileSync(path.join(path.dirname(file), 'hooks.json'), 'utf8');
  const seconds = Number(new RegExp(`"${process.argv[2]}"[^\\]]*\\][^}]*"timeout":\\s*(\\d+)`).exec(text)?.[1]);
  if (seconds) globalThis.workflowHookDeadline = Date.now() + seconds * 1000 - Math.max(4000, seconds * 200);
} catch { /* no limit: git runs as long as it needs */ }
// The hook sees itself as the entry script (isMain) with its own arguments.
process.argv.splice(1, 2, file);
await import(pathToFileURL(file).href);
