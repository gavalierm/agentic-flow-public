// ttl: 2026-12-15
// Spec 4.2.4, plan B5: after a takeover the thread that held the topic writes nothing. Every save of a thread that holds a
// topic pulls first and verifies its locks in the topic record (not only a write into the folder of the topic); the lost
// lock is named with its new holder, nothing reaches the brain or origin. (Stop and the wake bell: another package.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('save after a takeover on another clone: refused with the lost lock and the new holder, nothing written', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'T1', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 't1', '--task', 'T', '--done', 'krok A', '--next', 'krok B']).status, 0);
    // Before the takeover a save of the holder passes (its lock holds after the pull).
    let r = fx.run('save.mjs', ['memory', 'tool', 'editor', '--content', 'name: A']);
    assert.equal(r.status, 0, r.out);
    r = fx.runB('topic.mjs', ['claim', 't1', '--force', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    const before = fx.git(fx.origin, 'rev-parse', 'main');
    // A save that does not touch the topic: still refused, the lock of t1 is gone.
    r = fx.run('save.mjs', ['memory', 'tool', 'linter', '--content', 'name: L']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /^lock lost: topic t1 is now held by thread b2 on \S+ \(taken over\); this thread does not hold it any more, nothing written \(spec 4\.2\.4\)/m);
    assert.match(r.stderr, /Say in the reply that the lock of t1 was lost/);
    assert.ok(!fx.exists('memory/tool-linter.md'), 'nothing in the brain');
    assert.equal(fx.git(fx.origin, 'rev-parse', 'main'), before, 'nothing pushed');
    // The handover of the topic: refused as well (by its holder check after the pull).
    r = fx.run('save.mjs', ['handover', 't1', '--task', 'T', '--next', 'krok C']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /held by thread b2/);
    assert.equal(fx.git(fx.origin, 'rev-parse', 'main'), before);
  } finally { fx.cleanup(); }
});
