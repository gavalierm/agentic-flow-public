// D-0043 (operator 2026-11-14): a thread code started for a topic ends settled after done --topic, never with a question
// about a next topic; a thread of the operator without a topic behaves as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const child = { env: { WORKFLOW_THREAD_ID: 'child-1' } };
const NEXT_TOPIC = 'Issue #72 je zavreté a jeho téma uzavretá.\n\n**Otázky na operátora:**\n1. Akú tému má toto vlákno viesť ďalej?\n\n**Handover:** žiadny\n\n**Stav:** otázka';
const NEXT_TOPIC_TEXT = 'Issue #72 je zavreté. Akú tému má toto vlákno viesť ďalej?\n\n**Handover:** žiadny\n\n**Stav:** hotovo';
const DONE = 'Issue #72 je zavreté a téma uzavretá.\n\n**Handover:** žiadny\n\n**Stav:** hotovo';
const ASK = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Akú tému má toto vlákno viesť ďalej po uzavretí témy?', header: 'Téma', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] } };

/** A topic another thread (orch-1, topic lead) created for thread child-1, which claims it and closes it. */
function closedProgrammatic() {
  const fx = setup({ thread: 'orch-1' });
  assert.equal(fx.run('topic.mjs', ['create', 'lead', '--subject', 'Lead', '--class', 'discussion', '--here']).status, 0);
  let r = fx.run('topic.mjs', ['create', 'sub', '--subject', 'Sub', '--class', 'discussion', '--for-thread', 'child-1']);
  assert.equal(r.status, 0, r.out);
  r = fx.run('topic.mjs', ['claim', 'sub'], child);
  assert.equal(r.status, 0, r.out);
  fx.hook('user-prompt-submit.mjs', { prompt: 'urob to' }, child);
  r = fx.run('done.mjs', ['--topic', '--verified', 'x'], child);
  assert.equal(r.status, 0, r.out);
  return { fx, out: r.out };
}

test('D-0043: done --topic of a topic code started for the thread says the thread ends: hotovo and settle, no next topic', () => {
  const { fx, out } = closedProgrammatic();
  try {
    assert.match(out, /code started this thread for topic sub and it ends here \(D-0043\).*\*\*Stav:\*\* hotovo.*t3_thread_organize, action settle/);
    assert.doesNotMatch(out, /Start a new session for the next topic/);
  } finally { fx.cleanup(); }
});

test('D-0043: Stop refuses a question about a next topic in an ended programmatic thread and lets hotovo pass', () => {
  const { fx } = closedProgrammatic();
  try {
    for (const msg of [NEXT_TOPIC, NEXT_TOPIC_TEXT, 'Hotovo.\n\n**Handover:** žiadny\n\n**Stav:** čakám (na nič)']) {
      fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child);
      const res = fx.hook('stop.mjs', { last_assistant_message: msg }, child).json || {};
      assert.equal(res.decision, 'block', msg);
      assert.match(res.reason, /^vlákno spustil kód: skonči Stav: hotovo a nastav vlákno ako vybavené \(D-0043\)/);
    }
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child);
    const ok = fx.hook('stop.mjs', { last_assistant_message: DONE }, child).json || {};
    assert.notEqual(ok.decision, 'block', ok.reason);
    const ask = fx.hook('pre-tool-use.mjs', ASK, child).json?.hookSpecificOutput || {};
    assert.equal(ask.permissionDecision, 'deny');
    assert.match(ask.permissionDecisionReason, /D-0043/);
  } finally { fx.cleanup(); }
});

test('D-0043: the start of an ended programmatic thread shows neither "bez témy" nor the topic question', () => {
  const { fx } = closedProgrammatic();
  try {
    const ctx = JSON.stringify(fx.hook('session-start.mjs', { source: 'startup' }, child).json || {});
    assert.match(ctx, /\/ sub \(uzavretá\)/);
    assert.doesNotMatch(ctx, /bez témy/);
    assert.doesNotMatch(ctx, /Aká bude téma\?/);
    assert.match(ctx, /D-0043/);
  } finally { fx.cleanup(); }
});

test('D-0043: a thread of the operator without a topic is unchanged: done --topic names the next session, the topic question passes', () => {
  const fx = setup({ thread: 'op-1' });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'own', '--subject', 'Own', '--class', 'discussion', '--here']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'urob to' });
    const r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Start a new session for the next topic/);
    assert.doesNotMatch(r.out, /D-0043/);
    const ctx = JSON.stringify(fx.hook('session-start.mjs', { source: 'startup' }).json || {});
    assert.match(ctx, /bez témy/);
    assert.match(ctx, /Aká bude téma\?/);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    const res = fx.hook('stop.mjs', { last_assistant_message: NEXT_TOPIC }).json || {};
    assert.doesNotMatch(String(res.reason || ''), /D-0043/);
  } finally { fx.cleanup(); }
});
