// PreToolUse in code, not in text (operator 2026-11-02: "rules are unreliable, solve it in code"): the domain brain, not a
// topic, gives the right to write its projects (D-0014), secrets only in local/ (P-018, P-052), an ignored leftover in a persona asks (P-018).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

function owned(value = 'dev-work') {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}'); // the owned repo is in the same domain (v3, D-0002)
  const repo = path.join(fx.root, 'owned');
  fs.mkdirSync(repo);
  fx.git(repo, 'init', '-q', '-b', 'dev');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fx.git(repo, 'add', '-A');
  fx.git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topic_owned: { '../owned': value } }));
  fx.git(fx.brain, 'add', '-A');
  fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy for test');
  const r = fx.run('topic.mjs', ['create', 'dev-work', '--subject', 'dev', '--here', '--no-copy', '--class', 'discussion']);
  if (r.status !== 0) throw new Error(r.out);
  return { fx, repo };
}

test('D-0014: every thread of the domain writes and commits in a repo of the domain, whatever topic it holds; a left-over policy topic_owned is ignored', () => {
  const { fx, repo } = owned(['dev-work', 'issues']);
  try {
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.txt'), old_string: 'a', new_string: 'b' } };
    for (const thread of ['a1', 'b2']) {
      const as = { env: { WORKFLOW_THREAD_ID: thread } };
      let r = fx.hook('pre-tool-use.mjs', edit, as);
      assert.notEqual(decision(r), 'deny', `thread ${thread} edits: ${reason(r)}`);
      for (const command of [`git -C ${repo} commit -m x`, `cd ${repo} && git commit -am x`, `git -C ${repo} push origin dev`, `echo x > ${path.join(repo, 'b.txt')}`, `git -C ${repo} tag v1`, `sed -i 's/a/b/' ${path.join(repo, 'a.txt')}`]) {
        r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }, as);
        assert.notEqual(decision(r), 'deny', `${thread}: ${command}: ${reason(r)}`);
      }
    }
  } finally { fx.cleanup(); }
});

test('secrets: a token or credential written outside local/ is denied with the local/ route; placeholders and local/ pass', () => {
  const fx = setup();
  try {
    const token = 'ghp_' + 'A1b2'.repeat(9);
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'notes.md'), content: `use ${token}\n` } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /secret \(token\).*scratch\/notes\.md.*local\//);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(fx.project, 'README.md'), old_string: 'x', new_string: 'password = "' + 'S3cr3tValue99xx' + '"' } });
    assert.equal(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo ${token} > scratch/t.txt` } });
    assert.equal(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'local', 'gh.env'), content: `GH_TOKEN=${token}\n` } });
    assert.notEqual(decision(r), 'deny', 'local/ is the place for secrets');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'how.md'), content: 'tok' + 'en = "<your-token-here>"\napi' + '_key: "${API_KEY}"\n' } });
    assert.notEqual(decision(r), 'deny', 'placeholders are not secrets');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: token ${token}" https://api.github.com/user` } });
    assert.notEqual(decision(r), 'deny', 'a command that writes no file is not stopped');
  } finally { fx.cleanup(); }
});

// Carol 2026-11-02: .scratch/ left after a migration was denied as brain data instead of asking.
test('P-018: persona: removing an ignored leftover (.scratch/) asks instead of the brain deny', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-owned-'));
  try {
    const dir = path.join(root, 'carol');
    const env = cleanEnv({ WORKFLOW_THREAD_ID: 'p1' });
    const origin = path.join(root, 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), dir, '--remote', origin], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    fs.writeFileSync(path.join(dir, '.workflow.json'), JSON.stringify({ brain: '.' }));
    fs.appendFileSync(path.join(dir, '.gitignore'), '.scratch/\n');
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'persona'], { encoding: 'utf8' });
    fs.mkdirSync(path.join(dir, '.scratch'));
    fs.writeFileSync(path.join(dir, '.scratch', 'old.md'), 'x\n');
    const hook = (command) => JSON.parse(spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.mjs')], { cwd: dir, env: { ...env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command } }) }).stdout.trim() || '{}');
    let out = hook('rm -rf .scratch');
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\.scratch/);
    out = hook('rm -rf decisions');
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', 'tracked brain data stays denied');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
