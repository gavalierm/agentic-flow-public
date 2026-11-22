// keep: guarded
// A turn a message started stays that for all of it (P-047: its locks). A compaction inside the turn runs SessionStart,
// which set the source back to the operator (audit 2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('the source of a turn outlives a compaction; a new session starts as the operator\'s', () => {
  const fx = setup({ thread: 'a1' });
  try {
    const source = () => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8')).turn_source;
    fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic project/alpha' });
    assert.equal(source(), 'wake');
    fx.hook('session-start.mjs', { source: 'compact' });
    assert.equal(source(), 'wake');
    assert.match(fx.run('project.mjs', ['root', '/tmp/x']).out, /P-047/);
    fx.hook('session-start.mjs', { source: 'clear' });
    assert.equal(source(), 'operator');
  } finally { fx.cleanup(); }
});
