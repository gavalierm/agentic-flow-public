// D-0035: a code topic created with --project for another repo of the same brain (a persona creates a topic of the
// workflow repo) records that repo's mail project, its orchestrator by mail name, and starts its worktree on origin/<branch>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, initProject } from './helpers.mjs';

const topicJson = (fx, id) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'topics', id, 'topic.json'), 'utf8'));

test('D-0035: topic create --project records the mail project of the repo and the orchestrator by mail name', () => {
  const fx = setup({ thread: 'orch-1' });
  try {
    const repo = path.join(fx.root, 'code-repo');
    initProject(repo, { brainRel: '../brain' });
    assert.equal(fx.run('topic.mjs', ['create', 'lead', '--subject', 'Lead', '--class', 'discussion', '--here']).status, 0);
    const r = fx.run('topic.mjs', ['create', 'sub', '--subject', 'Sub', '--class', 'discussion', '--project', repo, '--for-thread', 'child-1']);
    assert.equal(r.status, 0, r.out);
    const t = topicJson(fx, 'sub');
    assert.equal(t.project, 'code-repo');
    assert.deepEqual(t.orchestrator, { topic: 'lead', thread: 'orch-1', project: 'project' });
    assert.equal(topicJson(fx, 'lead').project, undefined, 'a topic of the own project records none');
  } finally { fx.cleanup(); }
});

test('D-0035: a new topic branch starts on origin/<branch> when the checkout lags it', async () => {
  const { newBranchBase } = await import('../scripts/topic.mjs');
  const fx = setup({ thread: 'orch-1' });
  try {
    const bare = path.join(fx.root, 'code.git');
    fx.git(fx.root, 'init', '-q', '--bare', '-b', 'main', bare);
    const repo = path.join(fx.root, 'code-repo');
    initProject(repo, { brainRel: '../brain', remote: bare });
    const other = path.join(fx.root, 'other');
    fx.git(fx.root, 'clone', '-q', bare, other);
    fx.git(other, 'config', 'user.name', 't'); fx.git(other, 'config', 'user.email', 't@t');
    fs.writeFileSync(path.join(other, 'new.txt'), 'x\n');
    fx.git(other, 'add', '-A'); fx.git(other, 'commit', '-q', '-m', 'ahead'); fx.git(other, 'push', '-q', 'origin', 'main');
    fx.git(repo, 'fetch', '-q', 'origin');
    assert.equal(newBranchBase(repo), 'origin/main');
    fs.writeFileSync(path.join(repo, 'local.txt'), 'y\n');
    fx.git(repo, 'add', '-A'); fx.git(repo, 'commit', '-q', '-m', 'local only');
    assert.equal(newBranchBase(repo), null, 'local commits not on origin: HEAD keeps them');
  } finally { fx.cleanup(); }
});
