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

test('adapter targets the directory it runs in, not the session project (CLAUDE_PROJECT_DIR, exported WORKFLOW_PROJECT_DIR)', () => {
  // alice 2026-11-03: run in agentic-flow from the alice session, the adapter regenerated alice.
  const fx = setup();
  try {
    const other = path.join(fx.root, 'other');
    initProject(other);
    fs.rmSync(path.join(other, '.workflow.json'));
    const before = fs.readFileSync(path.join(fx.project, '.workflow.json'), 'utf8');
    const r = fx.run('adapter.mjs', ['claude-code'], { cwd: path.join(other, 'src'), env: { CLAUDE_PROJECT_DIR: fx.project, WORKFLOW_PROJECT_DIR: fx.project } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`generated in ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.ok(fs.existsSync(path.join(other, '.claude', 'settings.json')));
    assert.ok(!fs.existsSync(path.join(fx.project, '.claude', 'settings.json')), 'session project untouched');
    assert.equal(fs.readFileSync(path.join(fx.project, '.workflow.json'), 'utf8'), before);
  } finally { fx.cleanup(); }
});

test('brain optional (P-024): without --brain no .workflow.json, no brain proposal; --brain sets it; absolute path refused', () => {
  // alice 2026-11-03: agentic-flow got a default ../agentic-flow-brain that no session ever used.
  const fx = setup();
  try {
    const p = path.join(fx.root, 'fresh');
    initProject(p);
    fs.rmSync(path.join(p, '.workflow.json'));
    let r = fx.run('adapter.mjs', ['claude-code'], { cwd: p });
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(p, '.workflow.json')), 'no default brain written');
    assert.match(r.stdout, /no brain: project without its own brain \(optional, P-024\)/);
    assert.doesNotMatch(r.stdout, /propose|and \.workflow\.json/);
    const perms = JSON.stringify(JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8')).permissions);
    assert.doesNotMatch(perms, /null|<brain>/);
    r = fx.run('adapter.mjs', ['claude-code', '--brain', '../fresh-brain'], { cwd: p });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p, '.workflow.json'), 'utf8')), { brain: '../fresh-brain' });
    assert.match(r.stdout, /brain not found at \.\.\/fresh-brain/);
    r = fx.run('adapter.mjs', ['claude-code', '--brain', fx.brain], { cwd: p });
    assert.equal(r.status, 1); assert.match(r.stderr, /relative/);
  } finally { fx.cleanup(); }
});

test('brain skill named like a workflow skill is an error', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.brain, 'skills', 'operator', 'save'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'operator', 'save', 'SKILL.md'), '---\nname: save\ndescription: x\n---\nx\n');
    const r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /collide with workflow skills: save/);
    assert.match(fx.run('adapter.mjs', ['--version']).stdout, /^workflow [0-9a-f]{7,}/);
  } finally { fx.cleanup(); }
});

test('channel dev enables the inline plugin and disables skills-dir; regeneration keeps the channel (P-048)', () => {
  const fx = setup();
  try {
    let r = fx.run('adapter.mjs', ['claude-code', '--channel', 'dev']);
    assert.equal(r.status, 0, r.out);
    const file = path.join(fx.project, '.claude', 'settings.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins, { 'workflow@skills-dir': false, 'workflow@inline': true });
    assert.match(r.stdout, /channel dev/);
    r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins, { 'workflow@skills-dir': false, 'workflow@inline': true }, 'channel kept');
    r = fx.run('adapter.mjs', ['claude-code', '--channel', 'stable']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins, { 'workflow@skills-dir': true, 'workflow@inline': false });
    r = fx.run('adapter.mjs', ['claude-code', '--channel', 'beta']);
    assert.notEqual(r.status, 0);
  } finally { fx.cleanup(); }
});

test('devPluginDirs finds only workflow plugins in CLAUDE_CODE_PLUGIN_DIRS', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.deepEqual(devPluginDirs(['/nonexistent', root].join(path.delimiter)), [root]);
  assert.deepEqual(devPluginDirs(''), []);
});

test('P-053: workers default to the cheap model from policy; other env keys are kept; agent definitions match', async () => {
  const { subagentEnv, SUBAGENT_MODEL_ENV } = await import('../bin/adapter.mjs');
  const policy = loadPolicy(null);
  assert.equal(policy.subagents.default_model, 'haiku');
  assert.deepEqual(subagentEnv(policy, { FOO: '1' }), { FOO: '1', [SUBAGENT_MODEL_ENV]: 'haiku' });
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, '.claude'));
    fs.writeFileSync(path.join(fx.project, '.claude', 'settings.json'), JSON.stringify({ env: { KEEP: 'x' } }));
    const r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 0, r.out);
    const settings = JSON.parse(fs.readFileSync(path.join(fx.project, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, { KEEP: 'x', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  } finally { fx.cleanup(); }
  for (const a of ['worker']) {
    const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'agents', `${a}.md`), 'utf8');
    assert.match(text, new RegExp(`^model: ${policy.subagents.default_model}$`, 'm'), `${a}.md model equals policy default`);
  }
});

// Harness audit 2026-11-12: the tracked .claude/settings.json of this repo kept the native deny of v0.8.8 (Edit(~/.claude/**),
// Edit(.claude/skills/**)) after D-0011 removed it from the adapter. Every clone and worktree of the repo inherits the file,
// so the harness refused sed/cp/mkdir/redirects there with "blocked by a deny rule" and no hook decision. The tracked file
// must equal what the adapter generates today. The public copy carries no .claude/ (publish rules): nothing to compare there.
const trackedSettings = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.claude', 'settings.json');
test('tracked .claude/settings.json of the repo carries the permissions the adapter generates (no stale native deny)', { skip: !fs.existsSync(trackedSettings) && 'no .claude/settings.json in this copy' }, () => {
  const file = trackedSettings;
  const tracked = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(tracked.permissions.deny, undefined, 'native deny was removed by D-0011');
  assert.deepEqual(tracked.permissions, claudeSettings(loadPolicy(null), null).permissions);
});
