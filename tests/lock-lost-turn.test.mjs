// ttl: 2026-12-15
// Spec 4.2.4, plan B5 (the Stop and bell parts): after a takeover the old thread checks the lock after the pull before the
// state of the turn is written and when a bell wakes it. A thread that no longer holds the topic writes nothing into it,
// sends no continuation, ends a bell without a model call and says it in an operator turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const CONTINUE = 'turn ended with a next step, continue from handover';
const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8'));
const onOrigin = (fx, rel) => fx.git(fx.origin, 'show', `main:${rel}`);

function takenOver() {
  const fx = setup({ second: true });
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
  assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--next', 'krok A']).status, 0);
  fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
  // the operator gives the topic to thread b2 (another clone of the brain) while a1 still runs its turn
  const claim = fx.runB('topic.mjs', ['claim', 'alpha', '--force', '--operator-approved']);
  assert.equal(claim.status, 0, claim.out);
  assert.match(onOrigin(fx, 'topics/alpha/holder.json'), /"thread": "b2"/);
  return fx;
}

test('Stop after a takeover: the lock is checked after the pull, nothing is written, no continuation, the loss is queued', () => {
  const fx = takenOver();
  try {
    const before = onOrigin(fx, 'topics/alpha/topic.json');
    const r = fx.hook('stop.mjs', { last_assistant_message: 'Krok rozbehnutý.\n\n**Handover:**\n1. alpha → krok A\n\n**Stav:** čakám (na pokračovanie)', rawHandover: true });
    assert.equal(r.json.decision, undefined, JSON.stringify(r.json));
    assert.equal(onOrigin(fx, 'topics/alpha/topic.json'), before, 'the old holder wrote no state');
    assert.doesNotMatch(fx.read('topics/alpha/topic.json'), /"turn": \{\s*"state": "čakám"/);
    assert.equal(stateOf(fx).last_close.next, null, 'no continuation of a lost topic');
    assert.match((stateOf(fx).pending_signals || []).join(' '), /lock lost: topic alpha \(topic alpha held by thread b2/);
  } finally { fx.cleanup(); }
});

test('a bell of a thread that lost its lock ends without a model call; an operator turn is told', () => {
  const fx = takenOver();
  try {
    const bell = fx.hook('user-prompt-submit.mjs', { prompt: CONTINUE });
    assert.equal(bell.json.decision, 'block', JSON.stringify(bell.json));
    assert.match(bell.json.reason, /^lock lost: topic alpha .*; the bell ended without a model call$/);
    assert.equal(JSON.parse(fx.read('topics/alpha/topic.json')).turn?.continues ?? null, null, 'no count written');
    // an operator prompt runs and carries the line (the pull already moved this clone: a1 holds nothing any more)
    fx.git(fx.brain, 'reset', '-q', '--hard', 'HEAD~1');
    const op = fx.hook('user-prompt-submit.mjs', { prompt: 'ako to ide?' });
    assert.notEqual(op.json.decision, 'block');
    assert.match(op.context, /lock lost: topic alpha .*say so in your reply/);
  } finally { fx.cleanup(); }
});
