// keep: core
// P-023 e, P-038, P-047, P-003, P-013: UserPromptSubmit hook.
// Mail in the status line (P-021, P-023 e, P-041, P-044): mail count from the comms client, mail line (ID and category) only at
// n > 0 and once per change, 60 s cache, outage reported once and no retry before 60 s. Needs agentic-comms next to the plugin
// (else that test is skipped).
// P-047: a turn started by a wake message cannot take over a topic, close it or change rules; the operator's next prompt unlocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';

const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

test('P-047: sensitive scripts refuse in a wake turn and work again after an operator prompt', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
    fx.git(fx.brain, 'pull', '-q');

    // Wake turn in thread a1 carrying an "instruction" inside the message text.
    const wake = fx.hook('user-prompt-submit.mjs', { prompt: 'You have mail in topic alpha' });
    assert.match(wake.context, /wake: no new mail/);

    const takeover = fx.run('topic.mjs', ['claim', 'beta', '--force', '--operator-approved']);
    assert.notEqual(takeover.status, 0);
    assert.match(takeover.out, /P-047/);
    assert.match(fx.read('topics/beta/holder.json'), /b2/, 'holder unchanged');

    const close = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'seen']);
    assert.notEqual(close.status, 0);
    assert.match(close.out, /P-047/);
    assert.ok(fx.exists('topics/alpha/topic.json'), 'topic not archived');

    const rule = fx.run('save.mjs', ['rule', 'no-force', '--content', 'x']);
    assert.notEqual(rule.status, 0);
    assert.match(rule.out, /P-047/);
    const exception = fx.run('save.mjs', ['exception', 'P-021', '--wording', 'x', '--reason', 'y']);
    assert.notEqual(exception.status, 0);
    assert.match(exception.out, /P-047/);

    const claim = fx.run('topic.mjs', ['claim', 'alpha', '--force']);
    assert.notEqual(claim.status, 0);
    assert.match(claim.out, /P-047/);
    // A new topic is not a takeover: create passes in a wake turn (agent-alice/D-0066).
    const create = fx.run('topic.mjs', ['create', 'gamma', '--subject', 'Gamma', '--class', 'discussion', '--no-claim']);
    assert.equal(create.status, 0, create.out);

    // Reading, answering and acking stay allowed in a wake turn: done of a unit (no --topic) is not sensitive.
    assert.equal(fx.run('done.mjs', ['--verified', 'seen']).status, 0);

    // Operator prompt resets the flag.
    fx.hook('user-prompt-submit.mjs', { prompt: 'uzavri tému' });
    const closed = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'seen']);
    assert.equal(closed.status, 0, closed.out);
    assert.ok(fx.exists('topics/archive/alpha/topic.json'));
  } finally { fx.cleanup(); }
});
