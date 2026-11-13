// P-036: a code topic created without a copy (report intake, --no-copy) gets its copy from claim; done --topic merges
// that copy like one made at create, though topic.json records no copy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

test('done --topic merges the code copy claim made for a topic created without one', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    let r = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'web', '--no-claim', '--no-copy']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['claim', 'feat']);
    assert.equal(r.status, 0, r.out);
    const wt = path.join(fx.root, '.worktrees', 'project', 'feat');
    assert.match(r.out, /code copy: .*\.worktrees.project.feat \(branch topic\/feat\)/);
    assert.equal(JSON.parse(fx.read('topics/feat/topic.json')).copy, undefined, 'no copy path recorded at create');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', `user.email=t${'@'}t`, 'commit', '-q', '-m', 'feat']]) spawnSync('git', args, { cwd: wt });
    r = fx.run('done.mjs', ['--topic', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /no code copy/);
    assert.ok(fs.existsSync(path.join(fx.project, 'feature.txt')), 'the copy is merged into the project');
    assert.ok(!fs.existsSync(wt), 'the worktree is removed');
    assert.doesNotMatch(fx.git(fx.project, 'branch'), /topic\/feat/);
  } finally { fx.cleanup(); }
});
