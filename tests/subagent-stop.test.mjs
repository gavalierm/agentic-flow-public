// P-028: worker result must carry a Failures section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hasFailuresSection } from '../hooks/subagent-stop.mjs';
import { loadPolicy } from '../scripts/config.mjs';
import { checkResult } from '../bin/delegate.mjs';

const policy = loadPolicy(null);

test('missing Failures blocks the subagent; present section, exempt agents and stop_hook_active pass', () => {
  const blocked = run({ agent_id: 'x', agent_type: 'workflow:worker', last_assistant_message: 'All done.', stop_hook_active: false }, policy);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Failures/);
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'Done.\n\nFailures: none', stop_hook_active: false }, policy), {});
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'Done.\n\n## Failures\n- curl without header -> 401; works with header', stop_hook_active: false }, policy), {});
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: '**Failures:** none' }, policy), {});
  assert.deepEqual(run({ agent_type: 'Explore', last_assistant_message: 'found it' }, policy), {});
  assert.deepEqual(run({ agent_type: 'general-purpose', last_assistant_message: 'found it' }, policy), {}, 'only the workflow worker has the result rules');
  assert.deepEqual(run({ agent_type: 'claude-code-guide', last_assistant_message: 'x' }, policy), {});
  assert.equal(run({ agent_type: 'worker', last_assistant_message: 'x' }, policy).decision, 'block');
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'x', stop_hook_active: true }, policy), {});
  assert.equal(hasFailuresSection('no failures were seen'), false, 'word inside a sentence is not a section');
});

test('delegate check enforces the Failures section and the 2 000 char limit', () => {
  assert.deepEqual(checkResult('result\nFailures: none', 2000), []);
  assert.equal(checkResult('result', 2000).length, 1);
  assert.equal(checkResult('x'.repeat(2001) + '\nFailures: none', 2000).length, 1);
});
