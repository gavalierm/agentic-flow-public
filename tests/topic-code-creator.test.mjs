// D-0019: topic threads are started by code (cron, e.g. a persona's issues/watch.sh), which has no thread id. topic create
// --new-thread and topic thread start a T3 thread that holds the topic; created_by stays unset. Without a thread id, a
// create that this process would claim, an agent session (Claude Code, Codex) and a subagent are still refused (P-038, P-025).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

/** Fake `t3 thread start`: logs argv and stdin, prints a thread id. */
function fakeT3(fx) {
  const log = path.join(fx.root, 't3-calls.json');
  const file = path.join(fx.root, 'fake-t3.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }));\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:cc1' }));\n`);
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${file}` } }));
  return { call: () => JSON.parse(fs.readFileSync(log, 'utf8')), clear: () => fs.rmSync(log, { force: true }) };
}

// A cron job: no thread id and no harness variables (the tests themselves may run inside an agent's shell).
const CODE = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };

test('code without a thread id: topic create --new-thread and topic thread start a thread that holds the topic', () => {
  const fx = setup();
  try {
    const t3 = fakeT3(fx);
    const r = fx.run('topic.mjs', ['create', 'issue-x-1', '--subject', 'repo#1 https://example.invalid/1', '--class', 'code', '--new-thread', '--no-copy', '--task', 'Answer the issue'], { env: CODE });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /thread mcp:launch:cc1 started with title issue-x-1; it holds the topic/);
    assert.deepEqual(t3.call().argv.slice(0, 2), ['--title', 'issue-x-1']);
    assert.match(t3.call().input, /Answer the issue/);
    assert.equal(JSON.parse(fx.read('topics/issue-x-1/holder.json')).thread, 'mcp:launch:cc1');
    assert.equal(JSON.parse(fx.read('topics/issue-x-1/topic.json')).created_by, undefined);
    // A free topic (its thread was not started) gets a thread from code too.
    t3.clear();
    assert.equal(fx.run('topic.mjs', ['create', 'issue-x-2', '--subject', 'S', '--class', 'code', '--no-claim', '--no-copy']).status, 0);
    const th = fx.run('topic.mjs', ['thread', 'issue-x-2', '--task', 'Answer'], { env: CODE });
    assert.equal(th.status, 0, th.out);
    assert.equal(JSON.parse(fx.read('topics/issue-x-2/holder.json')).thread, 'mcp:launch:cc1');
  } finally { fx.cleanup(); }
});

test('without a thread id: a create this process would claim, an agent session and a subagent are refused', () => {
  const fx = setup();
  try {
    const t3 = fakeT3(fx);
    const plain = fx.run('topic.mjs', ['create', 'plain-x', '--subject', 'S', '--class', 'ops'], { env: CODE });
    assert.equal(plain.status, 1, plain.out);
    assert.match(plain.out, /needs a stable thread id/);
    for (const [k, v] of [['CLAUDECODE', '1'], ['CODEX_THREAD_ID', 'c1']]) {
      const agent = fx.run('topic.mjs', ['create', 'agent-x', '--subject', 'S', '--class', 'ops', '--new-thread'], { env: { ...CODE, [k]: v } });
      assert.equal(agent.status, 1, `${k}: ${agent.out}`);
      assert.match(agent.out, /needs a stable thread id/, k);
    }
    const sub = fx.run('topic.mjs', ['create', 'sub-x', '--subject', 'S', '--class', 'ops', '--new-thread'], { env: { ...CODE, WORKFLOW_AGENT_ID: 'w1' } });
    assert.equal(sub.status, 1, sub.out);
    assert.match(sub.out, /refused in subagent/);
    assert.equal(fx.run('topic.mjs', ['create', 'free-x', '--subject', 'S', '--class', 'ops', '--no-claim']).status, 0);
    const th = fx.run('topic.mjs', ['thread', 'free-x'], { env: { ...CODE, CLAUDECODE: '1' } });
    assert.equal(th.status, 1, th.out);
    assert.match(th.out, /needs a stable thread id/);
    for (const id of ['plain-x', 'agent-x', 'sub-x']) assert.equal(fs.existsSync(path.join(fx.brain, 'topics', id)), false, id);
    assert.equal(fs.existsSync(path.join(fx.root, 't3-calls.json')), false, 'no thread was started');
    assert.deepEqual(JSON.parse(fx.read('topics/free-x/holder.json')), {});
    t3.clear();
  } finally { fx.cleanup(); }
});
