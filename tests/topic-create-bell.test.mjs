// ttl: 2026-12-14
// agent-alice/D-0066, P-047 (operator 2026-11-14): an agreed or planned fix is started without asking the operator, also in
// a turn started by a message (bell, wake, timer). topic.mjs create and thread (a new thread for a free topic) pass in such
// a turn; claim --force of a topic another thread holds stays refused, with or without a dialog answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('wake turn: create passes without a dialog, claim --force of another thread\'s topic stays refused', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'other', '--subject', 'Other', '--class', 'discussion']).status, 0);
    const dir = path.join(fx.brain, 'local', 'threads');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const wake = (t, s = {}) => fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify({ turn_source: 'wake', turn_started_at: new Date(now - 60_000).toISOString(), ...s }));
    wake('a1'); wake('b2');
    let r = fx.run('topic.mjs', ['create', 'w1', '--subject', 'W1', '--class', 'discussion']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('topics/w1/topic.json'));
    const b2 = { env: { WORKFLOW_THREAD_ID: 'b2' } };
    r = fx.run('topic.mjs', ['claim', 'other', '--force'], b2);
    assert.equal(r.status, 1, 'claim --force keeps the refusal'); assert.match(r.out, /P-047/);
    wake('b2', { dialog_answered_at: new Date(now).toISOString() });
    r = fx.run('topic.mjs', ['claim', 'other', '--force'], b2);
    assert.equal(r.status, 1, 'a dialog answer does not open claim'); assert.match(r.out, /P-047/);
  } finally { fx.cleanup(); }
});
