// P-024 persona (repository = brain, "brain": "."), P-052 work files in scratch/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, setup } from './helpers.mjs';
import { resolveBrain, ensureWorkflowConfig, expandBrainPath, BRAIN_ENTRIES } from '../scripts/config.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function persona() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-persona-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'bob');
  const env = cleanEnv({ WORKFLOW_THREAD_ID: 'p1' });
  const run = (bin, args, cwd = dir) => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', bin), ...args], { cwd, env, encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  let r = run('brain-init.mjs', [dir, '--remote', origin], root);
  if (r.status !== 0) throw new Error(r.out);
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t');
  const hook = (input) => {
    const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.mjs')], { cwd: dir, env: { ...env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: dir, ...input }) });
    return JSON.parse(res.stdout.trim() || '{}');
  };
  return { root, origin, dir, run, hook, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('persona: "." resolves to the main checkout, also from a worktree; other config keys survive', () => {
  const p = persona();
  try {
    fs.writeFileSync(path.join(p.dir, '.workflow.json'), JSON.stringify({ brain: '.', comms: { instance: 'prod' } }));
    const info = resolveBrain(p.dir);
    assert.equal(info.persona, true);
    assert.equal(info.brain, fs.realpathSync(p.dir));
    const wt = path.join(p.root, 'wt');
    git(p.dir, 'worktree', 'add', '-q', wt);
    fs.writeFileSync(path.join(wt, '.workflow.json'), JSON.stringify({ brain: '.' }));
    assert.equal(resolveBrain(wt).brain, fs.realpathSync(p.dir), 'a worktree never becomes a second brain');
    ensureWorkflowConfig(p.dir, '.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, '.workflow.json'), 'utf8')), { brain: '.', comms: { instance: 'prod' } });
  } finally { p.cleanup(); }
});

test('persona: deny patterns cover the template entries; a normal project keeps <brainRel>/**', () => {
  assert.deepEqual(expandBrainPath('<brain>/**', '.'), BRAIN_ENTRIES);
  assert.ok(!BRAIN_ENTRIES.some((e) => e.startsWith('scratch') || e.startsWith('local')));
  assert.deepEqual(expandBrainPath('<brain>/**', '../x-brain'), ['../x-brain/**']);
  assert.deepEqual(expandBrainPath('~/.claude/**', '.'), ['~/.claude/**']);
});

test('persona: adapter writes settings, scratch/ and commits generated files through the brain script', () => {
  const p = persona();
  try {
    const r = p.run('adapter.mjs', ['claude-code', '--brain', '.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /persona: generated files committed/);
    assert.equal(git(p.dir, 'status', '--porcelain'), '', 'nothing left uncommitted');
    const msg = git(p.dir, 'log', '-1', '--format=%s');
    assert.match(msg, /^\[brain-script\] adapter/);
    const settings = JSON.parse(fs.readFileSync(path.join(p.dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.deny.includes('Edit(memory/**)'));
    assert.ok(!settings.permissions.deny.some((d) => d.includes('scratch')));
    assert.ok(fs.existsSync(path.join(p.dir, 'scratch')));
    assert.match(fs.readFileSync(path.join(p.dir, '.gitignore'), 'utf8'), /^scratch\/$/m);
    assert.equal(git(p.origin, 'log', '-1', '--format=%s', 'main'), msg, 'pushed');
  } finally { p.cleanup(); }
});

test('persona: brain files denied, scratch/ writable, README is not project data', () => {
  const p = persona();
  try {
    assert.equal(p.run('adapter.mjs', ['claude-code', '--brain', '.']).status, 0);
    let out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'memory', 'x.md'), content: 'x' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'notes.md'), content: 'x' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /managed projects \(P-024\)/);
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'scratch', 'try.txt'), content: 'x' } });
    assert.deepEqual(out, {});
    fs.writeFileSync(path.join(p.dir, 'scratch', 'try.txt'), 'old\n');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.dir, 'scratch', 'try.txt'), content: 'new' } });
    assert.deepEqual(out, {}, 'scratch content is disposable, no P-018 confirmation');
    out = p.hook({ tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(p.dir, 'scratch', 'b.txt')}` } });
    assert.deepEqual(out, {});
    // Stray untracked output in the persona root is not brain data: removing it is P-018 (ask), not a P-013 deny.
    fs.writeFileSync(path.join(p.dir, '0'), 'x\n');
    out = p.hook({ tool_name: 'Bash', tool_input: { command: 'rm 0' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /not recoverable from git: 0/);
    // An empty dir (left by a removed skill) holds no data: rmdir passes.
    fs.mkdirSync(path.join(p.dir, 'skills', 'agentic', 'gone'), { recursive: true });
    out = p.hook({ tool_name: 'Bash', tool_input: { command: `rmdir ${path.join(p.dir, 'skills', 'agentic', 'gone')}` } });
    assert.deepEqual(out, {}, JSON.stringify(out));
    out = p.hook({ tool_name: 'Bash', tool_input: { command: `rm ${path.join(p.dir, 'memory', 'x.md')}` } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', 'brain data still denied');
  } finally { p.cleanup(); }
});

test('P-052: write outside the project is denied with the scratch route (operator 2026-11-04); topic copies next to the project pass', () => {
  const fx = setup();
  try {
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'elsewhere.txt'), content: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /outside the project; .*work files and tool output go to \/.+\/scratch\/ \(gitignored, no confirmation, P-052\)/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'claude-x', 'scratchpad', 'a.txt'), content: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'project-topics', 't1', 'new.js'), content: 'x' } });
    assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'ask');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'a.txt'), content: 'x' } });
    assert.deepEqual(r.json, {});
  } finally { fx.cleanup(); }
});

test('P-052: temp dir named by a variable or a PowerShell cmdlet is denied (Windows agent, alice 2026-11-07)', () => {
  const fx = setup();
  try {
    for (const [tool, command] of [['Bash', 'echo x > $TMPDIR/a.mjs'], ['PowerShell', 'Set-Content -Path $env:TEMP\\a.ps1 -Value x'], ['Bash', 'f=$(mktemp); echo x > $f']]) {
      const r = fx.hook('pre-tool-use.mjs', { tool_name: tool, tool_input: { command } });
      assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny', command);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /outside the project/, command);
    }
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'PowerShell', tool_input: { command: 'Set-Content -Path scratch\\a.ps1 -Value x' } });
    assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'deny', 'scratch in the project passes');
  } finally { fx.cleanup(); }
});

test('P-052: a temp-dir target is denied with the scratch path (no operator question); a hand-made worker brief is denied', () => {
  const fx = setup();
  try {
    const tmp = { env: { WORKFLOW_TEMP_DIRS: fx.root } };
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'subagent', 'p8.py'), content: 'x' } }, tmp);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /\(system temp dir\); .*go to \/.+\/scratch\/ \(gitignored/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'p8.py'), content: 'x' } }, tmp);
    assert.deepEqual(r.json, {}, 'scratch in the project passes');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'workflow:worker', description: 'x', prompt: 'Implement it; put patches anywhere.' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /delegate\.mjs prepare/);
    const brief = fx.run('delegate.mjs', ['prepare', '--task', 'Implement it']);
    assert.equal(brief.status, 0, brief.out);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'workflow:worker', description: 'x', prompt: brief.stdout } });
    assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'deny', 'brief from prepare passes');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: 'x', prompt: 'find x' } });
    assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'deny', 'other agents pass');
  } finally { fx.cleanup(); }
});

test('persona: writes into a managed sibling project and its topic copies pass; other places outside are denied', () => {
  const p = persona();
  try {
    assert.equal(p.run('adapter.mjs', ['claude-code', '--brain', '.']).status, 0);
    const managed = path.join(p.root, 'srv');
    fs.mkdirSync(managed); fs.writeFileSync(path.join(managed, '.workflow.json'), '{"brain":"../srv-brain"}');
    git(managed, 'init', '-q');
    let out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(managed, 'new.sh'), content: 'x' } });
    assert.notEqual(out.hookSpecificOutput?.permissionDecision, 'ask');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.root, 'srv-topics', 't1', 'new.sh'), content: 'x' } });
    assert.notEqual(out.hookSpecificOutput?.permissionDecision, 'ask');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(p.root, 'plain', 'x.txt'), content: 'x' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    out = p.hook({ tool_name: 'Bash', tool_input: { command: `cd ${managed} && echo x > notes.txt` } });
    assert.deepEqual(out, {}, 'cd into the managed project: the relative target is not in the persona brain');
  } finally { p.cleanup(); }
});

test('persona: a managed project without brain (no .workflow.json, plugin in settings) is not outside (alice 2026-11-03: 5 Edit asks in agentic-flow)', () => {
  const p = persona();
  try {
    assert.equal(p.run('adapter.mjs', ['claude-code', '--brain', '.']).status, 0);
    const flow = path.join(p.root, 'flow');
    fs.mkdirSync(path.join(flow, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(flow, '.claude', 'settings.json'), '{"enabledPlugins":{"workflow@skills-dir":true}}');
    git(flow, 'init', '-q');
    let out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(flow, 'hooks', 'new.mjs'), content: 'x' } });
    assert.notEqual(out.hookSpecificOutput?.permissionDecision, 'ask');
    const other = path.join(p.root, 'other');
    fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(other, '.claude', 'settings.json'), '{"enabledPlugins":{"x@y":true}}');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(other, 'x.txt'), content: 'x' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', 'a repo without the workflow plugin is outside');
    const pilot = path.join(p.root, 'pilot', 'project-a', 'pilot-1');
    fs.mkdirSync(pilot, { recursive: true }); fs.writeFileSync(path.join(pilot, '.workflow.json'), '{"brain":"../brain-1"}');
    git(pilot, 'init', '-q');
    out = p.hook({ tool_name: 'Write', tool_input: { file_path: path.join(pilot, 'scratch', 'x.txt'), content: 'x' } });
    assert.notEqual(out.hookSpecificOutput?.permissionDecision, 'ask', 'nested workflow project (pilot)');
  } finally { p.cleanup(); }
});

test('persona: lasting documents go to docs/ (written directly, committed by save docs); scratch stays a work dir (alice 2026-11-03)', () => {
  const p = persona();
  try {
    assert.equal(p.run('adapter.mjs', ['claude-code', '--brain', '.']).status, 0);
    const doc = path.join(p.dir, 'docs', 'ai-news', 'reports', '2026-11-04.md');
    let out = p.hook({ tool_name: 'Write', tool_input: { file_path: doc, content: '# Report\n' } });
    assert.deepEqual(out.hookSpecificOutput?.permissionDecision, undefined, JSON.stringify(out));
    out = p.hook({ tool_name: 'Bash', tool_input: { command: `mkdir -p docs/ai-news && echo x > docs/ai-news/brief.md` } });
    assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, JSON.stringify(out));
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, '# Report\n');
    const r = p.run('save.mjs', ['docs', '--message', 'ai-news report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /written: docs\/ai-news\/reports\/2026-11-04\.md/);
    assert.match(git(p.dir, 'log', '-1', '--format=%s'), /\[brain-script\] docs: ai-news report/);
    assert.equal(git(p.dir, 'status', '--porcelain'), '');
    assert.match(p.run('save.mjs', ['docs']).out, /nothing to commit/);
  } finally { p.cleanup(); }
});

test('persona: session on a symlinked domain path writes scratch/ via the real path (domain rename, 2026-11-07)', () => {
  const p = persona();
  try {
    assert.equal(p.run('adapter.mjs', ['claude-code', '--brain', '.']).status, 0);
    // ~/agentic/alice -> Alice: the session keeps the old path, the agent writes via the new one (or back).
    const link = path.join(p.root, 'link');
    fs.symlinkSync(p.dir, link);
    const env = cleanEnv({ WORKFLOW_THREAD_ID: 'p1', CLAUDE_PROJECT_DIR: link });
    const hook = (input) => {
      const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.mjs')], { cwd: link, env, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: link, ...input }) });
      return JSON.parse(res.stdout.trim() || '{}');
    };
    const real = fs.realpathSync(p.dir);
    let out = hook({ tool_name: 'Write', tool_input: { file_path: path.join(real, 'scratch', 'x.sh'), content: 'x' } });
    assert.deepEqual(out, {}, JSON.stringify(out));
    out = hook({ tool_name: 'Write', tool_input: { file_path: path.join(link, 'scratch', 'y.sh'), content: 'x' } });
    assert.deepEqual(out, {}, JSON.stringify(out));
    out = hook({ tool_name: 'Write', tool_input: { file_path: path.join(real, 'memory', 'x.md'), content: 'x' } });
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', 'brain data stays denied on both paths');
    out = hook({ tool_name: 'Write', tool_input: { file_path: path.join(link, 'memory', 'x.md'), content: 'x' } });
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { p.cleanup(); }
});
