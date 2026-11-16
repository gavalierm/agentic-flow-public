// keep: core
// P-017, P-015, P-048: Claude Code adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, initProject } from './helpers.mjs';
import { claudeSettings, devPluginDirs } from '../bin/adapter.mjs';
import { loadPolicy } from '../scripts/config.mjs';

test('generated settings.json equals the policy translation; no inert keys; brain skills copied without symlinks', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'x-api'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'x-api', 'SKILL.md'), '---\nname: x-api\ndescription: Použi pri X\norigin: error\n---\nx\n');
    fs.mkdirSync(path.join(fx.project, '.claude'));
    fs.writeFileSync(path.join(fx.project, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, model: 'x' }));
    const r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 0, r.out);
    const settings = JSON.parse(fs.readFileSync(path.join(fx.project, '.claude', 'settings.json'), 'utf8'));
    const expected = claudeSettings(loadPolicy(fx.brain), '../brain');
    assert.deepEqual(settings.enabledPlugins, { 'workflow@skills-dir': true, 'workflow@inline': false });
    assert.equal(settings.autoMemoryEnabled, false);
    assert.equal(settings.autoCompactWindow, 200000);
    assert.deepEqual(settings.permissions, expected.permissions);
    assert.equal(settings.permissions.deny, undefined, 'no native deny: the PreToolUse hook guards brain, skills and ~/.claude (D-0011)');
    assert.ok(settings.permissions.ask.some((a) => a.startsWith('Bash(git reset --hard')));
    assert.ok(!settings.permissions.ask.some((a) => a.startsWith('Bash(git checkout --')), 'restore of own edits is decided by the hook, a native rule would always ask');
    assert.equal(settings.permissions.defaultMode, undefined);
    assert.equal(settings.model, 'x', 'unmanaged keys preserved');
    assert.match(r.stdout, /removed permissions.defaultMode/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.project, '.workflow.json'), 'utf8')), { brain: '../brain' });
    const gi = fs.readFileSync(path.join(fx.project, '.gitignore'), 'utf8');
    assert.match(gi, /^\.claude\/skills\/$/m); assert.match(gi, /^local\/$/m);
    const copied = path.join(fx.project, '.claude', 'skills', 'x-api');
    assert.ok(fs.existsSync(path.join(copied, 'SKILL.md')));
    assert.ok(!fs.lstatSync(copied).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(fx.project, 'local')));
  } finally { fx.cleanup(); }
});
