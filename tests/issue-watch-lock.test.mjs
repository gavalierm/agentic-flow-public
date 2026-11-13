// 3c review F: error.mjs confirm|reopen take the lock of the check round (the round reads and writes the same records):
// a short wait, then an error with nothing posted; own_comment_ids are written under the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, KEY } from './fixtures/issue-watch-fx.mjs';

test('confirm and reopen wait for a running round, then stop with nothing posted; free, they post under the lock', async () => {
  const fx = await fixture();
  try {
    fs.mkdirSync(path.dirname(fx.index), { recursive: true });
    fs.writeFileSync(`${fx.index}.lock`, '');
    const wait = { WORKFLOW_ISSUE_WATCH_LOCK_WAIT_MS: '400' };
    const calls = fx.gh.calls.length;
    for (const cmd of ['confirm', 'reopen']) {
      const r = await fx.runAsync('error.mjs', [cmd, KEY, '--text', 'overené: funguje'], { env: wait });
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.stderr, new RegExp(`a round of the issue check is running \\(lock .*index\\.json\\.lock, waited 0\\.4 s\\): nothing posted; run error\\.mjs ${cmd} again in a minute`));
    }
    assert.equal(fx.gh.calls.length, calls, 'nothing sent to GitHub');
    assert.equal(fx.gh.issues[7].comments.length, 0);
    assert.equal(fx.rec().status, 'waiting');
    assert.deepEqual(fx.rec().own_comment_ids, []);
    assert.ok(fs.existsSync(`${fx.index}.lock`), 'the round\'s lock is not taken over');
    // The round ends while the answer waits: the answer goes out.
    const pending = fx.runAsync('error.mjs', ['confirm', KEY, '--text', 'overené: funguje'], { env: { WORKFLOW_ISSUE_WATCH_LOCK_WAIT_MS: '10000' } });
    setTimeout(() => fs.rmSync(`${fx.index}.lock`, { force: true }), 500);
    const r = await pending;
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^confirmed: /);
    assert.deepEqual(fx.rec().own_comment_ids, [fx.gh.issues[7].comments[0].id]);
    assert.equal(fx.rec().status, 'confirmed');
    assert.ok(!fs.existsSync(`${fx.index}.lock`), 'the answer releases the lock');
  } finally { await fx.cleanup(); }
});
