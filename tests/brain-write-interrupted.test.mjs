// ttl: 2026-12-22
// Error report doma-pc 2026-11-22: done --topic removed the files of a topic in the brain and did not commit (interrupted, or
// Windows refused the folder). The uncommitted removal blocked every sync, the claim of the topic and a second done; no
// thread had a way out through the workflow. A write is whole or not at all, also when its process dies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, memoryRecord } from './helpers.mjs';

const dirty = (fx) => fx.git(fx.brain, 'status', '--porcelain', '--untracked-files=no').trim();
const write = (fx, name) => fx.run('brain.mjs', ['write', `memory/${name}.md`, '--message', `write ${name}`, '--content', memoryRecord(name, 'name: X')]);

test('the write of a dead process is rolled back by the next script; a failed removal leaves nothing half removed', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Test topic', '--class', 'ops']).status, 0);
    const dir = path.join(fx.brain, 'topics', 't1');
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.length >= 2, files.join());
    // 1. a writer died after it removed the files: its note names the paths, its pid is gone
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(path.join(fx.brain, '.git', 'workflow-write.journal'), JSON.stringify({ pid: 2 ** 22 + 12345, message: 'done --topic t1: closed, topic removed', paths: ['topics/t1'] }));
    let r = write(fx, 'operator-a');
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /interrupted brain write was rolled back \(done --topic t1/);
    assert.deepEqual(fs.readdirSync(dir).sort(), files, 'the topic is back');
    assert.equal(dirty(fx), '');
    assert.equal(fs.existsSync(path.join(fx.brain, '.git', 'workflow-write.journal')), false);
    assert.deepEqual(fx.git(fx.brain, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter((f) => f.startsWith('topics/')), [], 'the next commit does not carry the removal');
    // 2. a file of the folder cannot be removed: nothing changes, the error says so
    fs.chmodSync(dir, 0o555);
    r = fx.run('brain.mjs', ['remove', 'topics/t1', '--message', 'remove t1']);
    fs.chmodSync(dir, 0o755);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /topics\/t1: could not be removed .*nothing changed/);
    assert.deepEqual(fs.readdirSync(dir).sort(), files);
    assert.equal(dirty(fx), '');
    // 3. only the emptied folder stays (Windows: a program stands in it): the removal is complete and committed
    fs.chmodSync(path.dirname(dir), 0o555);
    r = fx.run('brain.mjs', ['remove', 'topics/t1', '--message', 'remove t1']);
    fs.chmodSync(path.dirname(dir), 0o755);
    assert.equal(r.status, 0, r.out);
    assert.equal(dirty(fx), '');
    assert.equal(fx.git(fx.brain, 'ls-files', 'topics/t1').trim(), '');
  } finally { fx.cleanup(); }
});
