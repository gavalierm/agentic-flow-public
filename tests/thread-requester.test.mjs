// ttl: 2026-12-15
// Spec 3.4 (plan B7): a new thread starts only on the explicit request of the operator or the supervisor, and the record
// names who asked. A thread that holds a topic no longer gets a new thread with an orchestrator by default: it claims the
// topic itself. A thread the supervisor asked for gets the supervisor introduced and its task as the Zadanie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { readTopicRecord } from '../scripts/topic-files.mjs';
import { topicThreadMessage } from '../scripts/topic.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';

function threadStub(fx) {
  const input = path.join(fx.root, 'first-message.txt');
  const stub = path.join(fx.root, 'fake-t3.sh');
  fs.writeFileSync(stub, `#!/bin/sh\ncat > '${input}'\necho '{"threadId":"t-new"}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${stub} --json` }, supervisor: { persona: 'alice', comms: '@alice/main' } }));
  return input;
}

test('a thread holding a topic claims a new topic itself; --new-thread needs --requested-by and records it', () => {
  const fx = setup();
  try {
    const input = threadStub(fx);
    const env = { env: { T3CODE_THREAD_ID: fx.thread } };
    assert.equal(fx.run('topic.mjs', ['create', 'first', '--subject', 'First', '--class', 'discussion'], env).status, 0);
    // no orchestrator, no new thread: this thread holds both
    let r = fx.run('topic.mjs', ['create', 'second', '--subject', 'Second', '--class', 'discussion'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /claimed by /);
    assert.ok(!fs.existsSync(input), 'no thread started');
    assert.equal(readTopicRecord(fx.brain, 'second').orchestrator, undefined);
    assert.equal(readTopicRecord(fx.brain, 'second').thread_requested_by, undefined);
    // a new thread without a requester is refused, nothing created
    r = fx.run('topic.mjs', ['create', 'third', '--subject', 'Third', '--class', 'discussion', '--new-thread'], env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /explicit request of the operator or the supervisor \(spec 3\.4\): pass --requested-by operator\|supervisor/);
    assert.equal(readTopicRecord(fx.brain, 'third'), null);
    // the supervisor asked for it: recorded, the first message introduces the supervisor and carries its task
    r = fx.run('topic.mjs', ['create', 'third', '--subject', 'Third', '--class', 'discussion', '--new-thread', '--requested-by', 'supervisor', '--task', 'sprav tretiu vec'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /thread t-new started with title "Third"/);
    assert.equal(readTopicRecord(fx.brain, 'third').thread_requested_by, 'supervisor');
    const first = fs.readFileSync(input, 'utf8');
    assert.match(first, /Vlákno založil supervisor \(alice, pošta @alice\/main\)/);
    assert.match(first, /Zadanie supervisora:\nsprav tretiu vec/);
    assert.doesNotMatch(first, /Orchestrátor/);
    // thread <id> for a free topic needs a requester too
    assert.equal(fx.run('topic.mjs', ['create', 'free', '--subject', 'Free', '--class', 'discussion', '--no-claim'], env).status, 0);
    r = fx.run('topic.mjs', ['thread', 'free'], env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--requested-by operator\|supervisor/);
    r = fx.run('topic.mjs', ['thread', 'free', '--requested-by', 'operator'], env);
    assert.equal(r.status, 0, r.out);
    assert.equal(readTopicRecord(fx.brain, 'free').thread_requested_by, 'operator');
  } finally { fx.cleanup(); }
});

test('the first message of an operator thread names no supervisor', () => {
  const msg = topicThreadMessage({ id: 'x', kind: 'discussion', subject: 'S', thread_requested_by: 'operator' }, { task: 'do x', supervisor: { persona: 'alice', comms: '@alice/main' } });
  assert.match(msg, /Zadanie operátora:\ndo x/);
  assert.doesNotMatch(msg, /supervisor/);
});

// operator 2026-11-19: "založ novú tému" in a thread with a topic means a new thread with the discussed work; a thread
// claimed the topic and worked on it in place, filling its context with a second subject.
test('the operator asks for a new topic: claiming it here is refused, the new thread needs the discussed work', () => {
  const fx = setup();
  try {
    const input = threadStub(fx);
    const env = { env: { T3CODE_THREAD_ID: fx.thread } };
    assert.equal(fx.run('topic.mjs', ['create', 'first', '--subject', 'First', '--class', 'discussion'], env).status, 0);
    writeThreadState(fx.brain, fx.thread, { ...readThreadState(fx.brain, fx.thread), turn_source: 'operator', operator_prompts: ['Zaloz novu temu na upravu kategorie produktov'] });
    let r = fx.run('topic.mjs', ['create', 'kat', '--subject', 'Kategórie', '--class', 'discussion'], env);
    assert.equal(r.status, 1, r.out); assert.match(r.out, /means a new thread[\s\S]*--new-thread --requested-by operator/);
    assert.equal(readTopicRecord(fx.brain, 'kat'), null);
    r = fx.run('topic.mjs', ['create', 'kat', '--subject', 'Kategórie', '--class', 'discussion', '--new-thread', '--requested-by', 'operator'], env);
    assert.equal(r.status, 1, r.out); assert.match(r.out, /--task/);
    r = fx.run('topic.mjs', ['create', 'kat', '--subject', 'Kategórie', '--class', 'discussion', '--new-thread', '--requested-by', 'operator', '--task', 'skill kategórií: dohodnuté X'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(fs.readFileSync(input, 'utf8'), /dohodnuté X/);
    // the operator said to work on it here: --here passes
    assert.equal(fx.run('topic.mjs', ['create', 'tu', '--subject', 'Tu', '--class', 'discussion', '--here'], env).status, 0);
  } finally { fx.cleanup(); }
});
