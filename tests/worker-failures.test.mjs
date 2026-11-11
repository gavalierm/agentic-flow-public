// Issue #28: a worker result's Failures section is written to failures.log, where error.mjs list reads it (P-028).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as stop from '../hooks/subagent-stop.mjs';
import { setup } from './helpers.mjs';

test('failuresText returns the section body, and nothing for "none" or a missing section', () => {
  assert.equal(stop.failuresText('Hotovo.\n\nFailures: none'), '');
  assert.equal(stop.failuresText('Hotovo.\n\n**Failures:** none.'), '');
  assert.equal(stop.failuresText('Hotovo.'), '');
  assert.equal(stop.failuresText('Hotovo.\n\nFailures: curl bez hlavičky -> 401'), 'curl bez hlavičky -> 401');
  assert.equal(stop.failuresText('x\n## Failures\n- curl -> 401\n- ok s X'), '- curl -> 401\n- ok s X');
});

test('a worker result with Failures is logged for error list; "none" and other agents are not', () => {
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
