// keep: core
// D-0042 (operator 2026-11-14): the workflow hook never holds the thread with a confirmation window. A step that needs the
// operator's consent (P-018: data git cannot restore) is refused with its reason and the way; leftovers of workflow tests
// (a wf-test-* fixture dir, an orphaned git worktree) are removed without consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NO_ASK_WAY, testLeftover } from '../hooks/pre-tool-use.mjs';

const bash = (fx, command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command }, cwd: fx.project }).json?.hookSpecificOutput || {};

test('D-0042: rm of a target git cannot restore is a deny with the reason and the way, never an ask', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const data = path.join(fx.project, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'export.csv'), 'x\n');
    const out = bash(fx, `rm -rf ${data}`);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /targets not recoverable from git: .*data.*\(P-018\)\. this step needs the operator's consent/);
    assert.ok(out.permissionDecisionReason.endsWith(NO_ASK_WAY), out.permissionDecisionReason);
    assert.ok(fs.existsSync(data), 'the data stays');
    // the deny locks nothing: a later call on the same path is checked by P-018 again, not refused as a bypass (P-054)
    assert.doesNotMatch(bash(fx, `rm -rf ${data}`).permissionDecisionReason || '', /P-054/);
  } finally { fx.cleanup(); }
});

test('D-0042: a subagent gets the deny too and no consent path', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.project, 'notes.txt'), 'x\n');
    const out = fx.hook('pre-tool-use.mjs', { agent_id: 'sub-1', tool_name: 'Bash', tool_input: { command: `rm ${path.join(fx.project, 'notes.txt')}` }, cwd: fx.project }).json?.hookSpecificOutput || {};
    assert.equal(out.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
