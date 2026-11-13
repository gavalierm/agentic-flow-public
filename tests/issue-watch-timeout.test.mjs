// 3c review E: a GitHub call has a time limit (30 s, WORKFLOW_GITHUB_TIMEOUT_MS): a GitHub that never answers ends the
// round with a log line, nothing advances and the lock of the round is released (the wake job does not hang).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './fixtures/issue-watch-fx.mjs';

test('a GitHub that never answers: the round ends after the time limit, logs it, advances nothing, frees the lock', async () => {
  const fx = await fixture();
  try {
    const before = fx.rec();
    fx.gh.comment(7);
    fx.gh.hang = true;
    const r = await fx.watchKilled({ WORKFLOW_GITHUB_TIMEOUT_MS: '300' }, 8000);
    assert.equal(r.signal, null, `the round hung and was killed after ${r.ms} ms`);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.watchLog(), /GitHub issues failed \(GitHub GET \/repos\/[^ ]+\/issues: no answer within 0\.3 s\); nothing advanced/);
    assert.deepEqual(fx.rec(), before, 'the record is unchanged');
    assert.equal(fx.sends().length, 0);
    assert.ok(!fs.existsSync(`${fx.index}.lock`), 'the lock is released');
    fx.gh.hang = false;
    const again = await fx.watch();
    assert.equal(again.status, 0, again.out);
    assert.equal(fx.sends().length, 1, 'the next round rings');
  } finally { await fx.cleanup(); }
});
