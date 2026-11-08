// P-007: CLAUDE.md is loaded unchecked into every session and goes stale; project knowledge lives in brain
// (operator 2026-11-03: an agent took an outdated address from a project CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('PreToolUse: writing CLAUDE.md in a workflow project is denied; deleting it passes', () => {
  const fx = setup();
  try {
    const file = path.join(fx.project, 'CLAUDE.md');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: file, content: '# x\nadresa 10.0.0.1\n' } }).json;
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /goes to brain through workflow:save/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo x >> ${file}` } }).json;
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git rm CLAUDE.md' } }).json;
    assert.notEqual(r.hookSpecificOutput?.permissionDecision, 'deny');
    // A clone of a foreign repo in scratch/ keeps its own CLAUDE.md: no workflow session loads it (2026-11-08).
    const clone = path.join(fx.project, 'scratch', 'lib', 'CLAUDE.md');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: clone, content: '# lib\n' } }).json;
    assert.notEqual(r.hookSpecificOutput?.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'web', 'CLAUDE.md'), content: '# x\n' } }).json;
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny', 'a nested CLAUDE.md in the project is loaded too');
  } finally { fx.cleanup(); }
});

test('SessionStart: a CLAUDE.md in the project is reported once per session with the move to brain', () => {
  const fx = setup();
  try {
    assert.doesNotMatch(fx.hook('session-start.mjs', { source: 'startup' }).context, /CLAUDE\.md in the project/);
    fs.writeFileSync(path.join(fx.project, 'CLAUDE.md'), '# stale\n');
    assert.match(fx.hook('session-start.mjs', { source: 'startup' }).context, /CLAUDE\.md in the project: loaded into every session unchecked/);
  } finally { fx.cleanup(); }
});
