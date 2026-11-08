// P-061: an agent that waits arms a waker; foreground waiting is denied (Bob 2026-11-01 waited on the operator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foregroundWait } from '../hooks/pre-tool-use.mjs';
import { setup } from './helpers.mjs';

test('foregroundWait: sleeps, loops and watch in the foreground; data and short pauses pass', () => {
  assert.equal(foregroundWait('sleep 30'), 'sleep 30');
  assert.equal(foregroundWait('sleep 2m && ls'), 'sleep 2m');
  assert.equal(foregroundWait('until [ -s f ]; do sleep 5; done'), 'loop with sleep');
  assert.equal(foregroundWait('watch -n 5 ls'), 'watch');
  assert.equal(foregroundWait("bash -c 'sleep 60'"), 'sleep 60');
  assert.equal(foregroundWait('sleep 3; ls'), null);
  assert.equal(foregroundWait("comms send --text 'sleep 60 is bad'"), null);
  assert.equal(foregroundWait('cat <<EOF\nsleep 99\nEOF'), null);
});

test('pre-tool-use denies a foreground wait, allows it in the background', () => {
  const fx = setup();
  try {
    const hook = (tool_input) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input }).json;
    const deny = hook({ command: 'until [ -s /tmp/x ]; do sleep 30; done' });
    assert.equal(deny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /P-061/);
    assert.notEqual(hook({ command: 'until [ -s /tmp/x ]; do sleep 30; done', run_in_background: true }).hookSpecificOutput?.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
