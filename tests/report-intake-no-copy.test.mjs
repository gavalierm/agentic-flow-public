// report-228e044c: the intake creates its code topic without a code copy (copy: false), but the topic recorded a copy
// path and the first message of its thread named `Kópia kódu: ../.worktrees/...`, a folder that never existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeT3, TOPIC } from './fixtures/intake-fx.mjs';

test('intake: a code topic without a copy records no copy path and its thread message names none', () => {
  const fx = fixture();
  try {
    const t3 = fakeT3(fx);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    const topic = JSON.parse(fx.read(`topics/${TOPIC}/topic.json`));
    assert.equal(topic.kind, 'code');
    assert.equal(topic.copy, undefined, 'no copy is made, so none is recorded');
    const [call] = t3.calls();
    assert.ok(!call.input.includes('Kópia kódu'), `the thread message names a code copy that does not exist:\n${call.input}`);
  } finally { fx.cleanup(); }
});
