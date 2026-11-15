// ttl: 2026-12-15
// report-d718bc1f: `save.mjs handover --topic <id>` (option from memory) got only the usage line; the refusal names the replacement
// (the topic is the first argument) like comms send names --level for --category, and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('handover --topic: refused with the replacement named, the current handover stays', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Ho', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'a', '--next', 'old']).status, 0);
    const before = fx.read('topics/ho/handover.md');
    for (const argv of [['handover', '--topic', 'ho', '--next', 'new'], ['handover', 'ho', '--topic', 'ho', '--next', 'new']]) {
      const r = fx.run('save.mjs', argv);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /--topic \(the topic is the first argument: save\.mjs handover ho \.\.\.\)/);
      assert.match(r.stderr, /nothing written/);
      assert.equal(fx.read('topics/ho/handover.md'), before);
    }
  } finally { fx.cleanup(); }
});
