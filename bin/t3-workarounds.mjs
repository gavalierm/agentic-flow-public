#!/usr/bin/env node
// T3 workarounds (PLAN decision 35): registry docs/t3-workarounds.json, checked after every T3 upgrade.
//   t3-workarounds.mjs list
//   t3-workarounds.mjs check [--t3-home <dir>] [--t3 <bin>] [--thread <id>] [--since <iso>] [--no-upstream] [--json]
// check exits 1 when a check FAILs (a T3 dependency of a workaround changed), else 0.
// check first waits (up to 30 s) for a T3 server that just started: an upgrade runs it right after the start of the service.
import { parseArgs, fail } from '../scripts/util.mjs';
import { readRegistry, checkAll, formatResults } from '../scripts/t3-workarounds.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'list') {
  for (const w of readRegistry()) {
    const up = w.upstream ? ` (${w.upstream.repo}#${w.upstream.issue}${w.upstream.fix_pr ? `, fix #${w.upstream.fix_pr}` : ''})` : '';
    process.stdout.write(`${w.id}${up}: ${w.title}\n  files: ${w.files.join(', ')}\n  remove when: ${w.remove_when}\n`);
  }
} else if (cmd === 'check') {
  const r = await checkAll({
    t3Home: typeof args['t3-home'] === 'string' ? args['t3-home'] : undefined,
    t3Bin: typeof args.t3 === 'string' ? args.t3 : undefined,
    thread: typeof args.thread === 'string' ? args.thread : undefined,
    since: typeof args.since === 'string' ? args.since : undefined,
    upstream: !args['no-upstream'],
  });
  process.stdout.write((args.json ? JSON.stringify(r) : formatResults(r)) + '\n');
  process.exitCode = r.results.some((x) => x.status === 'FAIL') ? 1 : 0;
} else {
  fail('usage: t3-workarounds.mjs list | check [--t3-home <dir>] [--t3 <bin>] [--thread <id>] [--since <iso>] [--no-upstream] [--json]');
}
