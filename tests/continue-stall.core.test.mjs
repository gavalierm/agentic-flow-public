// keep: core
// Spec 10.2 point 1, plan B4, O2: a next step in the handover closes the turn with the step and resume_at, so the mail
// rings "continue from handover" also with the same step; workflow counts these continuation wakes in .tema.json from the
// last progress of the topic (a commit of its branch or a task branch, a save of any type except the handover, a message
// picked up, the operator's message in the thread). The wake that reaches topics.continue_max is the last: it marks every
// item of Ďalší krok stuck and the next Stop closes the turn without a step. Wakes of a timer or the mail do not count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { setTimer } from '../scripts/waker.mjs';
import { topicFindings } from '../scripts/overview.mjs';

const CONTINUE = 'turn ended with a next step, continue from handover';
const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const END = '**Handover:**\n1. alpha → krok A\n\n**Stav:** čakám (na pokračovanie)';
const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8'));
const turnOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'topics', 'alpha', 'topic.json'), 'utf8')).turn || {};
const stop = (fx) => fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `Pracujem.\n\n${END}`, rawHandover: true }).json;
const wake = (fx) => fx.hook('user-prompt-submit.mjs', { prompt: CONTINUE });

function topic() {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
  assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--next', 'krok A']).status, 0);
  fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
  assert.equal(stop(fx).decision, undefined);
  return fx;
}

test('count, cap and stuck: the third continuation wake is the last, marks the steps stuck, the next Stop sends no step', () => {
  const fx = topic();
  try {
    assert.equal(stateOf(fx).last_close.next, 'krok A');
    assert.ok(stateOf(fx).last_close.resume_at, 'O2: resume_at with the continuation');
    for (const n of [1, 2]) {
      const r = wake(fx);
      assert.equal(turnOf(fx).continues.n, n);
      assert.equal(turnOf(fx).stuck ?? null, null);
      assert.doesNotMatch(r.context, /stuck:/);
      assert.match(r.context, /turn ended with a next step in the handover: do that step now/);
      assert.equal(stop(fx).decision, undefined);
      assert.equal(stateOf(fx).last_close.next, 'krok A', `wake ${n}: the step goes on`);
    }
    const last = wake(fx);
    assert.equal(turnOf(fx).continues.n, 3);
    assert.deepEqual(turnOf(fx).stuck, ['krok A']);
    assert.match(last.context, /stuck: topic alpha reached 3 continuation wakes without progress \(topics\.continue_max 3\); its next steps are marked stuck in \.tema\.json: "krok A"/);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /continue alpha 3\/3 stuck/);
    assert.equal(stop(fx).decision, undefined);
    assert.equal(stateOf(fx).last_close.next, null, 'stuck: the turn closes without a step');
    assert.deepEqual(turnOf(fx).stuck, ['krok A'], 'the mark stays without progress');
    // the overview of the supervisor reads the same list (one format: the step items, spec 10.2)
    const rec = { id: 'alpha', topic: JSON.parse(fs.readFileSync(path.join(fx.brain, 'topics', 'alpha', 'topic.json'), 'utf8')), holder: {} };
    assert.deepEqual(topicFindings(rec).find((x) => x.kind === 'stuck')?.items, ['krok A']);
  } finally { fx.cleanup(); }
});

test('every kind of progress starts the count from zero and clears the stuck mark', () => {
  const fx = topic();
  try {
    const stuckNow = () => { for (let i = 0; i < 3; i++) { wake(fx); stop(fx); } assert.deepEqual(turnOf(fx).stuck, ['krok A']); };
    stuckNow();
    // a save of another type than the handover (PostToolUse of the main thread): Stop clears count and mark, the step goes on
    fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `node ${PLUGIN_ROOT}/bin/save.mjs memory tool x --content y` }, tool_response: { stdout: 'saved' } });
    assert.equal(stop(fx).decision, undefined);
    assert.equal(turnOf(fx).stuck, null);
    assert.equal(turnOf(fx).continues, null);
    assert.equal(stateOf(fx).last_close.next, 'krok A');
    assert.equal((wake(fx), turnOf(fx).continues.n), 1);
    // a save of the handover is no progress
    fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `node ${PLUGIN_ROOT}/bin/save.mjs handover alpha --next "krok A"` }, tool_response: { stdout: 'saved' } });
    stop(fx);
    assert.equal((wake(fx), turnOf(fx).continues.n), 2);
    // the operator's message in the thread
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj s krokom A' });
    stop(fx);
    assert.equal(turnOf(fx).continues, null);
    assert.equal((wake(fx), turnOf(fx).continues.n), 1);
    // a commit of the topic branch or a task branch (the copy of the topic: here the project repo itself)
    const rec = path.join(fx.brain, 'topics', 'alpha', 'topic.json');
    fs.writeFileSync(rec, JSON.stringify({ ...JSON.parse(fs.readFileSync(rec, 'utf8')), copy: '.' }, null, 2) + '\n');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-am', 'copy');
    fx.git(fx.brain, 'push', '-q');
    fx.git(fx.project, 'branch', 'topic/alpha');
    stop(fx);
    wake(fx);
    assert.equal(turnOf(fx).continues.n, 1, 'the first count with a copy records the heads');
    stop(fx);
    wake(fx);
    assert.equal(turnOf(fx).continues.n, 2);
    fx.git(fx.project, 'branch', 'topic/alpha--tests');
    stop(fx);
    assert.equal(turnOf(fx).continues, null, 'a new task branch is progress');
  } finally { fx.cleanup(); }
});

test('a message picked up is progress; wakes of a timer and of the mail are not counted', () => {
  const fx = topic();
  const stateFile = path.join(fx.root, 'stub-state.json');
  try {
    wake(fx);
    assert.equal(turnOf(fx).continues.n, 1);
    stop(fx);
    // the timer rings (a due thread timer): no count
    setTimer(fx.brain, 'a1', { delayMs: 60_000, then: 'skontroluj build' });
    const t = wake(fx);
    assert.match(t.context, /timer fired .*skontroluj build/);
    assert.equal(turnOf(fx).continues.n, 1);
    stop(fx);
    // the mail rings: no count; reading the message is progress
    Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
    fs.writeFileSync(stateFile, JSON.stringify({ messages: [{ id: 'm1', level: 'assist', topic: 'alpha', sender: 'bob', text: 'x' }] }));
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(turnOf(fx).continues.n, 1);
    const got = fx.run('comms.mjs', ['receive']);
    assert.equal(got.status, 0, got.out);
    assert.ok(stateOf(fx).progress_at, 'pickup marks progress');
    stop(fx);
    assert.equal(turnOf(fx).continues, null);
  } finally { fx.cleanup(); }
});
