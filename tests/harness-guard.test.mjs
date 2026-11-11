// D-0011 (R3): Claude Code settings carry no native deny; the PreToolUse hook guards brain (P-013), the generated project
// skills (P-017) and the global paths of the harness (P-014) for every tool, also in place edits and redirects in a shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision;
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const bash = (fx, command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });

test('shell writes into brain are refused: sed -i, tee and redirects; a new file in local/ and a read of brain pass', () => {
  const fx = setup();
  try {
    const tracked = path.join(fx.brain, fx.git(fx.brain, 'ls-files').split('\n').find((f) => f.endsWith('.md')));
    // A read first: after a refusal the same target stays closed for the turn (P-054).
    fs.mkdirSync(path.join(fx.project, 'scratch'), { recursive: true });
    const read = bash(fx, `cat ${tracked} > ${path.join(fx.project, 'scratch', 'copy.md')}`);
    assert.notEqual(decision(read), 'deny', reason(read));
    for (const cmd of [`sed -i 's/a/b/' ${tracked}`, `echo x | tee ${tracked}`, `echo x > ${path.join(fx.brain, 'memory', 'new.md')}`]) {
      const r = bash(fx, cmd);
      assert.equal(decision(r), 'deny', cmd);
      assert.match(reason(r), /shell write into brain/, cmd);
    }
    assert.doesNotMatch(reason(bash(fx, `echo x > ${path.join(fx.brain, 'local', 'new-state.json')}`)), /shell write into brain/, 'local/ is ignored, no brain data');
  } finally { fx.cleanup(); }
});

test('a shell write into .claude/skills/ of the project is refused: the skills are generated from brain (P-017)', () => {
  const fx = setup();
  try {
    const r = bash(fx, `mkdir -p .claude/skills/x && echo x > ${path.join(fx.project, '.claude', 'skills', 'x', 'SKILL.md')}`);
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /generated from brain at session start/);
  } finally { fx.cleanup(); }
});

test('no tool writes into ~/.claude, the global path of the harness (P-014)', () => {
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  // One fixture per call: after a refusal the same target stays closed for the turn with a P-054 reason.
  for (const input of [{ tool_name: 'Write', tool_input: { file_path: settings, content: '{}' } }, { tool_name: 'Bash', tool_input: { command: `sed -i 's/a/b/' ${settings}` } }]) {
    const fx = setup();
    try {
      const r = fx.hook('pre-tool-use.mjs', input);
      assert.equal(decision(r), 'deny', input.tool_name);
      assert.match(reason(r), /P-014/, input.tool_name);
    } finally { fx.cleanup(); }
  }
});
