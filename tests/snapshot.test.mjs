// ttl: 2027-05-18
// Operator 2026-11-18: skill snapshot saves the state of the topic for a fresh session (/clear) without closing it. The
// snapshot refuses a handover from before this turn, the end of its turn sends no continuation (it would go on in the old
// context), the start after /clear carries the handover, and the next turn continues as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8'));
const stop = (fx, state) => fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `Uložené.\n\n**Handover:**\n1. alpha → krok A\n\n**Stav:** ${state}`, raw: true }).json;

test('snapshot: a handover of this turn, no continuation after it, the handover after /clear, the next turn goes on', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--next', 'krok A']).status, 0);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(fx.brain, 'topics', 'alpha', 'handover.md'), old, old);
    fx.hook('user-prompt-submit.mjs', { prompt: 'sprav si snapshot témy' });
    let r = fx.run('topic.mjs', ['snapshot']);
    assert.notEqual(r.status, 0); assert.match(r.out, /before this turn; save it first/);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--done', 'krok 0 overený']).status, 0);
    r = fx.run('topic.mjs', ['snapshot']);
    assert.equal(r.status, 0, r.out); assert.match(r.out, /snapshot of alpha: .*without a continuation/);
    assert.equal(stop(fx, 'čakám (na /clear operátora)').decision, undefined);
    assert.equal(stateOf(fx).last_close.next, null, 'no continuation after the snapshot');
    assert.match(fx.hook('session-start.mjs', { source: 'clear' }).context, /Po \/clear .*téma alpha ostáva tvoja[\s\S]*krok A/);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(stop(fx, 'čakám (na pokračovanie)').decision, undefined);
    assert.equal(stateOf(fx).last_close.next, 'krok A', 'the next turn continues');
  } finally { fx.cleanup(); }
});
