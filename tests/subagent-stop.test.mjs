// P-028, issue #28: a worker result must carry a Failures section (the hook blocks without it), and its Failures body
// is written to failures.log, where error.mjs list reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hasFailuresSection, failuresText } from '../hooks/subagent-stop.mjs';
import { loadPolicy } from '../scripts/config.mjs';
import { checkResult } from '../bin/delegate.mjs';
import { setup } from './helpers.mjs';

const policy = loadPolicy(null);

test('P-028: missing Failures blocks the subagent; present section, exempt agents and stop_hook_active pass', () => {
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
  // The length limit of the policy is enforced by the hook, not by a manual check (audit M4 2026-11-11).
  const long = run({ agent_type: 'workflow:worker', last_assistant_message: 'x'.repeat(3001) + '\nFailures: none' }, policy);
  assert.equal(long.decision, 'block');
  assert.match(long.reason, /3016 chars, the limit is 3000/);
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'x'.repeat(2900) + '\nFailures: none' }, policy), {});
});

test('P-028: delegate check enforces the Failures section and the char limit', () => {
  assert.deepEqual(checkResult('result\nFailures: none', 2000), []);
  assert.equal(checkResult('result', 2000).length, 1);
  assert.equal(checkResult('x'.repeat(2001) + '\nFailures: none', 2000).length, 1);
});

test('failuresText returns the section body, and nothing for "none" or a missing section', () => {
  assert.equal(failuresText('Hotovo.\n\nFailures: none'), '');
  assert.equal(failuresText('Hotovo.\n\n**Failures:** none.'), '');
  assert.equal(failuresText('Hotovo.'), '');
  assert.equal(failuresText('Hotovo.\n\nFailures: curl bez hlavičky -> 401'), 'curl bez hlavičky -> 401');
  assert.equal(failuresText('x\n## Failures\n- curl -> 401\n- ok s X'), '- curl -> 401\n- ok s X');
});

test('P-028: a worker result with Failures is logged for error list; "none" and other agents are not', () => {
  const fx = setup();
  try {
    const worker = (session, agent, msg) => fx.hook('subagent-stop.mjs', { session_id: session, agent_id: agent, agent_type: 'workflow:worker', last_assistant_message: msg });
    assert.deepEqual(worker('w1', 'sub7', 'Hotovo.\n\nFailures: curl bez hlavičky X -> 401; funguje s X').json, {});
    assert.match(fx.run('error.mjs', ['list']).stdout, /1\. \S+ sub7 w1 worker-result :: curl bez hlavičky X -> 401; funguje s X/);
    worker('w2', 'sub8', 'Hotovo.\n\nFailures: none');
    assert.doesNotMatch(fx.run('error.mjs', ['list']).stdout, /sub8/);
    fx.hook('subagent-stop.mjs', { session_id: 'w3', agent_id: 'sub9', agent_type: 'Explore', last_assistant_message: 'Failures: something' });
    assert.doesNotMatch(fx.run('error.mjs', ['list']).stdout, /sub9/);
  } finally { fx.cleanup(); }
});
