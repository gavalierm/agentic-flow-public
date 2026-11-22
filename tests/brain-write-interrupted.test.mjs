// ttl: 2026-12-22
// Error report doma-pc 2026-11-22: done --topic removed the files of a topic in the brain and did not commit (interrupted, or
// Windows refused the folder). The uncommitted removal blocked every sync, the claim of the topic and a second done; no
// thread had a way out and the operator finished it by hand. A removal is committed first, its files go after the commit;
// the paths of a dead writer become what the last commit says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, memoryRecord } from './helpers.mjs';

const dirty = (fx) => fx.git(fx.brain, 'status', '--porcelain', '--untracked-files=no').trim();
const write = (fx, name) => fx.run('brain.mjs', ['write', `memory/${name}.md`, '--message', `write ${name}`, '--content', memoryRecord(name, 'name: X')]);
const tracked = (fx, id) => fx.git(fx.brain, 'ls-files', `topics/${id}`).trim();
const journal = (fx, id) => fs.writeFileSync(path.join(fx.brain, '.git', 'workflow-write.journal'), JSON.stringify({ pid: 2 ** 22 + 12345, message: `done --topic ${id}: closed, topic removed`, paths: [`topics/${id}`] }));

test('a removal cannot stay half done: a dead writer is settled by the next script, a held file does not stop the commit', () => {
  const fx = setup();
  try {
    const create = (id) => { assert.equal(fx.run('topic.mjs', ['create', id, '--subject', 'Test topic', '--class', 'ops']).status, 0); return path.join(fx.brain, 'topics', id); };
    let dir = create('t1');
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.length >= 2, files.join());
    // 1. files gone, nothing committed (a write of an older version died): the next script brings the topic back
    fs.rmSync(dir, { recursive: true });
    journal(fx, 't1');
    let r = write(fx, 'operator-a');
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /interrupted brain write was settled \(done --topic t1/);
    assert.deepEqual(fs.readdirSync(dir).sort(), files);
    assert.equal(dirty(fx), '');
    assert.equal(fs.existsSync(path.join(fx.brain, '.git', 'workflow-write.journal')), false);
    // 2. a program holds the files (they cannot be removed): the removal is committed all the same, the files go later
    fs.chmodSync(dir, 0o555);
    r = fx.run('brain.mjs', ['remove', 'topics/t1', '--message', 'remove t1']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /removed in git, but a program holds file\(s\) of topics\/t1/);
    assert.equal(tracked(fx, 't1'), '');
    assert.equal(dirty(fx), '');
    assert.deepEqual(fs.readdirSync(dir).sort(), files, 'still on the disk');
    fs.chmodSync(dir, 0o755);
    assert.equal(write(fx, 'operator-b').status, 0);
    assert.equal(fs.existsSync(dir), false, 'gone at the next brain write');
    assert.equal(fs.existsSync(path.join(fx.brain, '.git', 'workflow-write.cleanup')), false);
    // 3. only the emptied folder is held (Windows: a shell stands in it): complete
    dir = create('t2');
    fs.chmodSync(path.dirname(dir), 0o555);
    r = fx.run('brain.mjs', ['remove', 'topics/t2', '--message', 'remove t2']);
    fs.chmodSync(path.dirname(dir), 0o755);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /a program holds/);
    assert.deepEqual([tracked(fx, 't2'), dirty(fx), fs.readdirSync(dir).length], ['', '', 0]);
    fs.rmdirSync(dir);
    // 4. the writer died after its commit, before the files left: the next script finishes the removal
    dir = create('t3');
    fx.git(fx.brain, 'rm', '-r', '-q', '--cached', 'topics/t3');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', '[brain-script] done --topic t3: closed, topic removed');
    journal(fx, 't3');
    r = write(fx, 'operator-c');
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(dirty(fx), '');
  } finally { fx.cleanup(); }
});
