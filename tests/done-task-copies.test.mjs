// ttl: 2026-12-15
// Spec 3.7, 4.1 (flow v2 task w4b): done --topic removes the task worktrees and the local task branches topic/<t>--<task>
// of the topic; the pushed ones stay on origin. A task worktree with uncommitted changes and a task branch whose commits
// are neither on origin nor in the topic branch stay, each with its line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

function codeDomain() {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const origin = path.join(fx.root, 'project.git');
  fx.git(fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
  fx.git(fx.project, 'remote', 'add', 'origin', origin);
  fx.git(fx.project, 'push', '-q', '-u', 'origin', 'main');
  return { ...fx, projectOrigin: origin };
}
const commit = (dir, file, text, msg, { noHook = false } = {}) => {
  fs.writeFileSync(path.join(dir, file), text);
  const g = (...a) => { const r = spawnSync('git', [...(noHook ? ['-c', 'core.hooksPath=/dev/null'] : []), ...a], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  g('add', '-A');
  g('commit', '-q', '-m', msg);
};
const branches = (fx, dir, pattern) => fx.git(dir, 'for-each-ref', '--format=%(refname:short)', pattern).split('\n').filter(Boolean).sort();

test('done --topic: task worktrees and local task branches end with the topic, pushed ones stay on origin', () => {
  const fx = codeDomain();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    const base = path.join(fx.root, '.worktrees', 'project');
    commit(path.join(base, 'feat'), 'base.txt', 'base\n', 'topic work');
    for (const t of ['a', 'b', 'c']) assert.equal(fx.run('topic.mjs', ['task-copy', t]).status, 0);
    commit(path.join(base, 'feat--a'), 'a.txt', 'a\n', 'task a'); // pushed by the post-commit hook
    commit(path.join(base, 'feat--b'), 'b.txt', 'b\n', 'task b', { noHook: true }); // on this machine only
    fs.writeFileSync(path.join(base, 'feat--c', 'c.txt'), 'c\n'); // uncommitted
    fx.git(fx.project, 'branch', 'topic/feat--d', 'topic/feat'); // no worktree, in the topic branch
    assert.equal(fx.git(fx.projectOrigin, 'rev-parse', '--verify', 'refs/heads/topic/feat--a').length > 0, true);

    const r = fx.run('done.mjs', ['--topic', '--verified', 'test', '--knowledge', 'nic nové']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^task worktree .*feat--a removed$/m);
    assert.match(r.stdout, /^task branch topic\/feat--a removed \(stays on origin\)$/m);
    assert.match(r.stdout, /^task worktree .*feat--b removed$/m);
    assert.match(r.stdout, /^task branch topic\/feat--b kept: its commits are neither on origin nor in topic\/feat; push it \(git -C .* push origin topic\/feat--b\)/m);
    assert.match(r.stdout, /^task worktree .*feat--c kept: uncommitted changes \(c\.txt\)/m);
    assert.match(r.stdout, /^task branch topic\/feat--d removed \(in topic\/feat\)$/m);
    assert.ok(!fs.existsSync(path.join(base, 'feat--a')) && !fs.existsSync(path.join(base, 'feat--b')) && !fs.existsSync(path.join(base, 'feat')));
    assert.ok(fs.existsSync(path.join(base, 'feat--c', 'c.txt')), 'the uncommitted work stays');
    assert.deepEqual(branches(fx, fx.project, 'refs/heads/topic/'), ['topic/feat--b', 'topic/feat--c']);
    assert.ok(branches(fx, fx.projectOrigin, 'refs/heads/topic/').includes('topic/feat--a'), 'origin keeps the pushed task branch');
  } finally { fx.cleanup(); }
});
