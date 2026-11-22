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
    fx.hook('user-prompt-submit.mjs', { prompt: 'sprav si snapshot témy' });
    // The commit of the handover says when it was saved (git keeps seconds): the turn starts after it.
    const file = path.join(fx.brain, 'local', 'threads', 'a1.json');
    const state = stateOf(fx);
    fs.writeFileSync(file, JSON.stringify({ ...state, turn_started_at: new Date(Date.now() + 2000).toISOString() }));
    let r = fx.run('topic.mjs', ['snapshot']);
    assert.notEqual(r.status, 0); assert.match(r.out, /before this turn; save it first/);
    fs.writeFileSync(file, JSON.stringify(state));
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--done', 'krok 0 overený']).status, 0);
    // A save that did not reach its commit left a new file: not a saved handover (the next brain write puts the old one back).
    const handover = path.join(fx.brain, 'topics', 'alpha', 'handover.md');
    const saved = fs.readFileSync(handover);
    fs.appendFileSync(handover, '\nnot committed\n');
    r = fx.run('topic.mjs', ['snapshot']);
    assert.notEqual(r.status, 0); assert.match(r.out, /its last save did not finish/);
    fs.writeFileSync(handover, saved);
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
