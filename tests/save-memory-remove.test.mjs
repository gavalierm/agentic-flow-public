// Removal of a memory record through save (P-013): a duplicate folded into its home record, a tombstone, a stale record.
// save had no way, the brain hook denies the shell, and consolidate kept reporting them (D-0028).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

function save(fx, ...a) {
  const r = fx.run('save.mjs', ['memory', ...a]);
  assert.equal(r.status, 0, r.out);
  return r;
}

test('memory --remove: a reason is required; an operator record goes only on an operator order; removal is committed', () => {
  const fx = setup();
  try {
    save(fx, 'project', 'alpha', '--content', 'Alpha is the web shop.');
    let r = fx.run('save.mjs', ['memory', 'project', 'alpha', '--remove']);
    assert.equal(r.status, 1); assert.match(r.stderr, /--reason/);
    r = fx.run('save.mjs', ['memory', 'project', 'alpha', '--remove', '--reason', 'merged into the domain record']);
    assert.equal(r.status, 1, 'an operator record without an operator order is refused'); assert.match(r.stderr, /operator order/);
    assert.ok(fx.exists('memory/project-alpha.md'));
    r = fx.run('save.mjs', ['memory', 'project', 'nothere', '--remove', '--reason', 'operator 2026-11-13: test']);
    assert.equal(r.status, 1); assert.match(r.stderr, /not found/);
    r = fx.run('save.mjs', ['memory', 'project', 'alpha', '--remove', '--reason', 'operator 2026-11-13: merged into the domain record']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /project-alpha removed; no other record names it/);
    assert.ok(!fx.exists('memory/project-alpha.md'), 'the record file is gone');
    assert.equal(fx.git(fx.brain, 'status', '--porcelain').trim(), '', 'the removal is committed');
    assert.doesNotMatch(fx.read('local/index/memory.md'), /project-alpha/, 'the index no longer lists it');
  } finally { fx.cleanup(); }
});

test('memory --remove: a tombstone and an observed record go without an operator order; records naming the key are listed', () => {
  const fx = setup();
  try {
    save(fx, 'project', 'oldsite', '--content', 'Presunuté do vedomostí repa web.');
    let r = fx.run('save.mjs', ['memory', 'project', 'oldsite', '--remove', '--reason', 'tombstone']);
    assert.equal(r.status, 0, r.out); assert.ok(!fx.exists('memory/project-oldsite.md'));
    save(fx, 'tool', 'scanner', '--content', 'The scanner runs nightly.', '--origin', 'observed');
    save(fx, 'service', 'mailer', '--content', 'Sends the nightly mail of tool-scanner.', '--relates-to', 'tool-scanner');
    r = fx.run('save.mjs', ['memory', 'tool', 'scanner', '--remove', '--reason', 'stale: no longer runs']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /tool-scanner removed; still named in \(change them with save\): .*memory\/service-mailer\.md/);
    assert.ok(fx.exists('memory/service-mailer.md'), 'the record naming it stays');
  } finally { fx.cleanup(); }
});
