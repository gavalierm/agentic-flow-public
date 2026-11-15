// ttl: 2026-12-15
// Limit of automatic topics (agent-alice/D-0069, overload 2026-11-15: report-intake made six code topics at once and the
// server ran ten full test suites): report-intake and topic.mjs auto start a new topic with a thread only while fewer than
// topics.auto_max_active code topics with a running thread exist on this machine (every brain of the pin record); else
// nothing is created and the item waits: the report stays held with its notice open, auto exits 3 with `waiting: N active`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { readTopicRecord, readHolderRecord } from '../scripts/topic-files.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
// Cron: no thread id and no harness variables (the tests themselves may run inside an agent's shell).
const CRON = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };
const TOPIC = 'report-0123abcd';

function fixture() {
  const fx = setup();
  const other = setup(); // a second brain of this machine (pin record): its code topics count too
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    notices: [{ id: 'n-1', kind: 'unregistered-topic', state: 'open', project: 'project', topic: TOPIC, message_id: 'm-1' }],
    message: { 'm-1': { id: 'm-1', status: 'held', project: 'project', topic: TOPIC, expires_at: '2999-01-01T00:00:00.000Z', expired_at: null } },
  }));
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  // Fake `t3 thread start`: logs each call and prints a thread id.
  const t3log = path.join(fx.root, 't3-calls.jsonl');
  const t3 = path.join(fx.root, 'fake-t3.mjs');
  fs.writeFileSync(t3, `import fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\nfs.appendFileSync(${JSON.stringify(t3log)}, 'x\\n');\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:rt1' }));\n`);
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${t3}`, auto_max_active: 2 } }));
  const pin = path.join(fx.root, 'pin.json');
  fs.writeFileSync(pin, JSON.stringify({ brains: { [other.brain]: null } }));
  const cron = { ...CRON, WORKFLOW_PIN_FILE: pin };
  return {
    fx, other, cron,
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    calls: () => (fs.existsSync(fx.env.STUB_COMMS_LOG) ? fs.readFileSync(fx.env.STUB_COMMS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    threads: () => (fs.existsSync(t3log) ? fs.readFileSync(t3log, 'utf8').trim().split('\n').length : 0),
    cleanup: () => { fx.cleanup(); other.cleanup(); },
  };
}

test('intake and topic.mjs auto at the limit of active code topics create nothing; the item waits and is taken later', () => {
  const f = fixture();
  const { fx, other, cron } = f;
  try {
    // Two code topics with a running thread on this machine (one in each brain) and a held discussion topic (not counted).
    for (const [x, id, cls] of [[fx, 'busy-a', 'code'], [other, 'busy-b', 'code'], [fx, 'talk', 'discussion']]) {
      const r = x.run('topic.mjs', ['create', id, '--subject', 'S', '--class', cls, '--here', '--no-copy']);
      assert.equal(r.status, 0, r.out);
    }
    const r = fx.run('report-intake.mjs', [], { env: cron });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`${TOPIC}: waiting: 2 active \\(limit 2 [^)]*busy-a, busy-b\\); message m-1 stays held`));
    assert.equal(readTopicRecord(fx.brain, TOPIC), null, 'no topic');
    assert.equal(f.threads(), 0, 'no thread started');
    assert.ok(!f.calls().some((c) => c[0] === 'decide'), 'not delivered');
    assert.equal(f.state().notices[0].state, 'open', 'the notice stays open');
    assert.equal(f.state().message['m-1'].status, 'held', 'the report stays held');
    // A topic finishes: the next run takes the report.
    const rel = fx.run('topic.mjs', ['release', 'busy-a']);
    assert.equal(rel.status, 0, rel.out);
    const again = fx.run('report-intake.mjs', [], { env: cron });
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, new RegExp(`${TOPIC}: message m-1 delivered to thread mcp:launch:rt1 \\(created\\)`));
    assert.equal(readHolderRecord(fx.brain, TOPIC).thread, 'mcp:launch:rt1');
    assert.equal(f.threads(), 1);
    // Full again (busy-b and the report topic): topic.mjs auto creates nothing, exit 3, no fallback.
    const auto = fx.run('topic.mjs', ['auto', 'issue-x-1', '--subject', 'Issue x#1', '--task', 'vybav issue'], { env: cron });
    assert.equal(auto.status, 3, auto.out);
    assert.equal(auto.stdout.trim().split('\n').pop(), 'waiting: 2 active');
    assert.doesNotMatch(auto.out, /^(fallback|mail): /m);
    assert.equal(readTopicRecord(fx.brain, 'issue-x-1'), null, 'no topic');
    assert.equal(f.threads(), 1, 'no thread started');
  } finally { f.cleanup(); }
});
