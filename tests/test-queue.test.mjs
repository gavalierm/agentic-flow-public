// ttl: 2026-12-17
// P-079 (operator 2026-11-17: several threads ran full suites at once, the machine did not keep up): a full test run of
// the main thread in any project goes through scripts/test-slot.mjs (rewritten in place); a named test file, a run that
// already goes through the queue and a worker's full run (refused, P-071) are not rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotShellRewrite } from '../hooks/pre-tool-use.mjs';
import { setup } from './helpers.mjs';
import { loadPolicy } from '../scripts/config.mjs';

const P = loadPolicy(null).harness.worker_full_test_commands;

test('full runs go through the test queue; named files and queued runs stay', () => {
  const r = slotShellRewrite('cd web && CI=1 npm test 2>&1 | tail -5', P);
  assert.match(r.command, /^cd web && CI=1 node ".*\/scripts\/test-slot\.mjs" -- npm test 2>&1 \| tail -5$/);
  assert.match(slotShellRewrite('pytest -q', P).command, /test-slot\.mjs" -- pytest -q$/);
  assert.equal(slotShellRewrite('node --test tests/x.test.mjs', P), null);
  assert.equal(slotShellRewrite('node scripts/test-slot.mjs -- npm test', P), null);
  assert.equal(slotShellRewrite('ls -la', P), null);
  const fx = setup();
  try {
    const out = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).json.hookSpecificOutput || {};
    assert.match(out.updatedInput?.command || '', /test-slot\.mjs" -- npm test$/);
    assert.match(out.additionalContext || '', /machine's test queue/);
  } finally { fx.cleanup(); }
});
