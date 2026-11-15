// ttl: 2026-12-14
// 2026-11-14 (4x): done --topic merged the topic branch into the local main branch of the shared checkout but did not push
// it, so the main branch stayed ahead of origin. It pushes it now (fast-forward only); a diverged origin stops it first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const commit = (cwd, file, message) => {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  for (const a of [['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['add', '-A'], ['commit', '-q', '-m', message]]) git(cwd, ...a);
};
const head = (cwd, ref = 'HEAD') => git(cwd, 'rev-parse', ref).stdout.trim();

/** Project with a bare origin of its own and a code topic `feat` with one commit in its copy. */
function withOrigin() {
  const fx = setup();
  const origin = path.join(fx.root, 'project-origin.git');
  git(fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(fx.project, 'remote', 'add', 'origin', origin);
  assert.equal(git(fx.project, 'push', '-q', '-u', 'origin', 'main').status, 0);
  assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
  const copy = path.join(fx.root, 'project-topics', 'feat');
  commit(copy, 'feature.txt', 'feat');
  return { fx, origin, copy };
}

test('done --topic pushes the main branch to origin after the merge', () => {
  const { fx, origin } = withOrigin();
  try {
    const r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/feat/);
    assert.equal(head(origin, 'main'), head(fx.project), 'origin main is the merged main');
    assert.match(r.stdout, /pushed main to origin/);
  } finally { fx.cleanup(); }
});

test('done --topic with a diverged origin: prints it, pushes and merges nothing, exits non-zero', () => {
  const { fx, origin, copy } = withOrigin();
  try {
    const other = path.join(fx.root, 'other-clone');
    git(fx.root, 'clone', '-q', origin, other);
    commit(other, 'remote.txt', 'remote');
    assert.equal(git(other, 'push', '-q', 'origin', 'main').status, 0);
    commit(fx.project, 'local.txt', 'local');
    const before = { local: head(fx.project), origin: head(origin, 'main'), copy: head(copy) };
    const r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'feature.txt present']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, /diverged/);
    assert.deepEqual({ local: head(fx.project), origin: head(origin, 'main'), copy: head(copy) }, before, 'nothing merged or pushed');
    assert.ok(fx.exists('topics/feat'), 'the topic stays open');
    assert.ok(fs.existsSync(copy), 'the copy stays');
  } finally { fx.cleanup(); }
});
