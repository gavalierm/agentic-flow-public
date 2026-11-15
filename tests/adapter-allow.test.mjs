// ttl: 2026-12-15
// flow-public#96: the operator's own permissions.allow rules survive regeneration of project settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('adapter keeps the operator allow rules in .claude/settings.json and regenerates ask', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, '.claude'));
    const rule = 'mcp__claude-in-chrome__javascript_tool';
    fs.writeFileSync(path.join(fx.project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [rule], ask: ['Bash(stale)'] } }));
    const r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 0, r.out);
    const settings = JSON.parse(fs.readFileSync(path.join(fx.project, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, [rule]);
    assert.ok(!settings.permissions.ask.includes('Bash(stale)'), 'ask is managed by the workflow');
    assert.ok(settings.permissions.ask.length > 0);
  } finally { fx.cleanup(); }
});
