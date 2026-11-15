// keep: core
// v3 domain (D-0002, operator 2026-11-04: "agents must not write to top-level directories, their environment is
import os from 'node:os';
// limited to the project"): a `.agentic-domain` marker bounds where agents write; writes outside are denied, not asked.
// Exceptions only from the domain brain policy `domain.allow_outside` (paths and the word "sudo").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { shellWrites, shellWriteTargets } from '../hooks/pre-tool-use.mjs';
import { resolveDomain, allowOutside, threadStateFile } from '../scripts/config.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

function domainFx(allow) {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  if (allow) {
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ domain: { allow_outside: allow } }));
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy for test');
  }
  const outside = fs.mkdtempSync(path.join(path.dirname(fx.root), 'wf-outside-'));
  return { fx, outside, cleanup: () => { fx.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); } };
}

// alice 2026-11-04: rm -rf .wrangler asked, though the directory was a side effect of the thread's own wrangler run.
// alice 2026-11-12: pilot-test-sender.json waited 3.6 h overnight for an approval of the thread's own file.
// alice 2026-11-07: temp dir variables and PowerShell cmdlets slipped past the write check.
test('code topic in a domain: git worktree <domain>/.worktrees/<repo>/<id> on topic/<id>; done merges it and removes the worktree and branch', async () => {
  const { spawnSync } = await import('node:child_process');
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    const r0 = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']);
    assert.equal(r0.status, 0, r0.out);
    const wt = path.join(fx.root, '.worktrees', 'project', 'feat');
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'a worktree, not a clone');
    assert.equal(fx.git(wt, 'branch', '--show-current'), 'topic/feat');
    const topic = JSON.parse(fx.read('topics/feat/topic.json'));
    assert.equal(topic.repo, 'project');
    assert.equal(topic.copy, '../.worktrees/project/feat');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'feature.txt'), content: 'x' } });
    assert.equal(decision(r), null, 'the worktree is inside the domain');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat']]) spawnSync('git', args, { cwd: wt });
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /note: agentic\/HANDOVER\.md did not change in topic\/feat; .*save\.mjs handover --repo project/, 'the repo HANDOVER is the project state (D-0002)');
    assert.ok(fs.existsSync(path.join(fx.project, 'feature.txt')));
    assert.ok(!fs.existsSync(wt));
    assert.doesNotMatch(fx.git(fx.project, 'worktree', 'list'), /feat/);
    assert.doesNotMatch(fx.git(fx.project, 'branch'), /topic\/feat/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'EnterWorktree', tool_input: {} });
    assert.equal(decision(r), 'deny', 'harness worktrees outside the domain are not used');
  } finally { fx.cleanup(); }
});

// carol 2026-11-09
// hooks review C3: one tokenizer for all write checks.