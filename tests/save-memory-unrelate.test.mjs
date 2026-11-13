// A memory rewrite keeps the links the record had (--relates-to adds); a link that no longer holds (a decision of
// another store named bare, a removed record) had no way out, and consolidate kept reporting it (D-0028).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('memory --unrelate drops a link; an unknown link is refused and nothing is saved', () => {
  const fx = setup();
  try {
    for (const n of ['alpha', 'beta', 'gamma']) assert.equal(fx.run('save.mjs', ['memory', 'tool', n, '--content', `Tool ${n}.`]).status, 0);
    let r = fx.run('save.mjs', ['memory', 'service', 'notify', '--content', 'Sends a mail on arrival.', '--relates-to', 'tool-alpha,tool-beta']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['memory', 'service', 'notify', '--content', 'Sends a mail on arrival.', '--unrelate', 'tool-alpha', '--relates-to', 'tool-gamma']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('memory/service-notify.md'), /^relates_to: \[tool-beta, tool-gamma\]$/m);
    const before = fx.read('memory/service-notify.md');
    r = fx.run('save.mjs', ['memory', 'service', 'notify', '--content', 'Changed text.', '--unrelate', 'tool-zeta']);
    assert.equal(r.status, 1, 'a link the record lacks is refused');
    assert.match(r.stderr, /--unrelate tool-zeta: not in relates_to of service-notify \(tool-beta, tool-gamma\), nothing saved/);
    assert.equal(fx.read('memory/service-notify.md'), before, 'nothing saved');
  } finally { fx.cleanup(); }
});
