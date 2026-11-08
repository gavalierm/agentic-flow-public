// agentic-flow-public#15: `git add -f .claude/skills` staged the ignored .workflow-generated.json; a forced add names files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

test('hook: git add -f of a folder with ignored files is denied, a named file and a plain add pass', () => {
  const fx = setup();
  try {
    const p = fx.project;
    if (!fs.existsSync(path.join(p, '.git'))) spawnSync('git', ['init', '-q'], { cwd: p });
    const skills = path.join(p, '.claude', 'skills');
    fs.mkdirSync(path.join(skills, 'a'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'a', 'SKILL.md'), 'x\n');
    fs.writeFileSync(path.join(skills, '.workflow-generated.json'), '{}\n');
    fs.appendFileSync(path.join(p, '.gitignore'), '\n.claude/skills/.workflow-generated.json\n');
    const run = (command) => fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    for (const c of ['git add -f .claude/skills', `git -C ${p} add --force .claude`, 'git add .claude && git add -f .claude/skills']) {
      const r = run(c);
      assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny', `${c}: ${r.stderr}`);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /adds ignored files too \(\.claude\/skills\/\.workflow-generated\.json\)/);
    }
    for (const c of ['git add .claude/skills', 'git add -f .claude/skills/a/SKILL.md']) {
      assert.doesNotMatch(JSON.stringify(run(c).json || {}), /adds ignored files/, c);
    }
  } finally { fx.cleanup(); }
});
