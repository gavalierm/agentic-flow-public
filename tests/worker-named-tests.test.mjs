// ttl: 2026-12-15
// P-071, agent-alice/D-0083: the full test suite runs once per state of the code; a worker (subagent) runs only the tests
// its change touches, the topic thread runs the full suite once before the merge. The PreToolUse hook refuses a command
// of the full suite (policy harness.worker_full_test_commands) in a subagent; the main thread is not limited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const run = (fx, command, sub) => fx.hook('pre-tool-use.mjs', { ...(sub ? { agent_id: 'sub-1', agent_type: 'workflow:worker' } : {}), tool_name: 'Bash', tool_input: { command }, cwd: fx.project }).json?.hookSpecificOutput || {};

test('P-071: a worker running the full suite is refused, a named test file passes, the main thread is not limited', () => {
  const fx = setup();
  try {
    for (const cmd of ['npm test', 'node --test', `cd ${fx.project} && CI=1 npm run test`, 'pnpm test', 'yarn test', 'npx vitest run', 'npx jest', 'pytest -q', 'go test ./...']) {
      const out = run(fx, cmd, true);
      assert.equal(out.permissionDecision, 'deny', cmd);
      assert.match(out.permissionDecisionReason, /run only the tests the change touches \(`node --test <file>`, `pytest <file>`.*the topic thread runs the full suite once before the merge \(P-071\)/, cmd);
    }
    for (const cmd of ['node --test tests/x.test.mjs', 'pytest tests/test_x.py', 'npx jest src/a.test.js', 'go test ./pkg/a']) {
      assert.notEqual(run(fx, cmd, true).permissionDecision, 'deny', cmd);
    }
    assert.notEqual(run(fx, 'npm test', false).permissionDecision, 'deny', 'main thread');
  } finally { fx.cleanup(); }
});
