// ttl: 2026-12-15
// P-030 signals only a really repeated procedure, not a chance match of common commands: an interpreter sequence is
// keyed by the script it runs, an interpreter without a script file (node -e, python3 -, heredoc, sh -c) is left out,
// workflow and skill scripts are left out also through a relative or variable path, and waiting or clock commands
// (sleep, date …) are common commands that never form a sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCommand, isReadonly, sequencesFrom, sessionsByName, newProposals } from '../scripts/logs.mjs';
import { PLUGIN_ROOT } from './helpers.mjs';

const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policy', 'policy.json'), 'utf8'));

/** The sequence names a flush of these sessions (one shell command line each, run in order) signals, as flushBuffer counts them. */
function signals(sessions) {
  const lines = [];
  sessions.forEach((cmds, i) => {
    const run = cmds.flatMap((c) => normalizeCommand(c, policy)).filter((c) => !isReadonly(c, policy));
    for (const s of sequencesFrom(run, { min: policy.logs.sequence_min_length, max: policy.logs.sequence_max_length })) lines.push(`2026-11-15 ${s} s${i}`);
  });
  const names = lines.map((l) => l.split(' ')[1]);
  return newProposals(new Map(), sessionsByName(lines), names, policy.thresholds.sequence_repeats);
}

test('different scripts of one interpreter are different sequences: two sessions of a.mjs/b.mjs and one of c.mjs/d.mjs give no signal', () => {
  assert.deepEqual(signals([['node "$D/a.mjs"', 'node "$D/b.mjs"'], ['node "$D/a.mjs"', 'node "$D/b.mjs"'], ['node "$D/c.mjs"', 'node "$D/d.mjs"']]), []);
});

test('the same scripts in three sessions give the signal, the argument values do not matter', () => {
  assert.deepEqual(signals([['sh x.sh one', 'node y.mjs 1'], ['sh x.sh two', 'node y.mjs 2'], ['sh x.sh 3', 'node y.mjs 3']]), ['sh-x.sh+node-y.mjs']);
});

test('sleep and date in three sessions give no signal', () => {
  assert.deepEqual(signals([['sleep 5', 'date'], ['sleep 10', 'date +%s'], ['sleep 1', 'date -u']]), []);
});

test('an interpreter without a script file is not part of a sequence', () => {
  for (const c of ['node -e "console.log(1)"', "python3 - <<'PY'\nprint(1)\nPY", 'sh -c "ls; pwd"', 'python3 <<EOF\nx\nEOF', 'node --input-type=module -e "x"']) {
    assert.deepEqual(normalizeCommand(c, policy), [], c);
  }
});

test('workflow and skill scripts are left out also through a variable, quoted or relative path', () => {
  for (const c of [
    'node "$HOME/.claude/skills/workflow/bin/save.mjs" handover x',
    'node $HOME/.claude/skills/workflow/bin/save.mjs handover x',
    'node $P/bin/save.mjs x',
    'node "${P}/bin/comms.mjs" receive',
    'node ../agentic-flow/bin/timer.mjs 60',
    'node bin/done.mjs',
    'sh /srv/agent-x/.claude/skills/alice-fix/prove-commit.sh w t',
  ]) assert.deepEqual(normalizeCommand(c, policy), [], c);
  assert.deepEqual(normalizeCommand('node "$P/tools/own.mjs" x', policy), ['node own.mjs']);
});
