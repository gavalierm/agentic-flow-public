// ttl: 2026-12-15
// flow-1-8-1 (2026-11-15): the limit of automatic topics (topics.auto_max_active, D-0069) counted every holder on this
// machine as a running thread; a topic whose holder thread T3 had archived kept one of the 3 places for good and
// report-intake kept the report waiting ("waiting: 3 active ..."). A topic whose holder T3 reports archived or gone does
// not count; a state T3 does not give (no answer, no CLI, no thread object) counts (the safe side). T3 is a stub here
// (`t3 thread show --json <thread>`, policy thread_title.command), never the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { readHolderRecord } from '../scripts/topic-files.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const CRON = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };
const TOPIC = 'report-0123abcd';

test('a code topic whose holder thread T3 reports archived or gone takes no place of the limit; an unknown state counts', () => {
  const fx = setup();
  const other = setup(); // a second brain of this machine (pin record)
  try {
    const stateFile = path.join(fx.root, 'stub-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      notices: [{ id: 'n-1', kind: 'unregistered-topic', state: 'open', project: 'project', topic: TOPIC, message_id: 'm-1' }],
      message: { 'm-1': { id: 'm-1', status: 'held', project: 'project', topic: TOPIC, expires_at: '2999-01-01T00:00:00.000Z', expired_at: null } },
    }));
    Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
    // Fake `t3 thread start` (the report topic's new thread) and fake `t3 thread show --json <thread>` (state per thread).
    const start = path.join(fx.root, 'fake-t3-start.mjs');
    fs.writeFileSync(start, `import fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:rt1' }));\n`);
    const showLog = path.join(fx.root, 't3-show.jsonl');
    const show = path.join(fx.root, 'fake-t3-show.mjs');
    const answers = {
      'mcp:archived': { out: { thread: { id: 'mcp:archived', status: 'completed', archived: true, activeRunId: null } } },
      'mcp:gone': { code: 1, stderr: 'Error: Thread mcp:gone not found' },
      'mcp:silent': { code: 1, stderr: 'Error: connect ECONNREFUSED 127.0.0.1:3773' },
      'mcp:noshow': { out: {} },
    };
    fs.writeFileSync(show, `import fs from 'node:fs';\nconst argv = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(showLog)}, JSON.stringify(argv) + '\\n');\nconst id = argv[argv.length - 1];\nconst s = (${JSON.stringify(answers)})[id] || { out: { thread: { id, status: 'running', archived: false, activeRunId: 'r1' } } };\nif (s.stderr) process.stderr.write(s.stderr + '\\n');\nif (s.out) process.stdout.write(JSON.stringify(s.out) + '\\n');\nprocess.exit(s.code || 0);\n`);
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${start}`, auto_max_active: 3 }, thread_title: { command: `${process.execPath} ${show} thread show --json` } }));
    const pin = path.join(fx.root, 'pin.json');
    fs.writeFileSync(pin, JSON.stringify({ brains: { [other.brain]: null } }));

    // Five code topics held on this machine: a live thread, an archived one (other brain), a gone one, one T3 does not
    // answer about and one without a thread object in the answer.
    for (const [x, id, thread] of [[fx, 'live-a', 'mcp:live'], [other, 'arch-b', 'mcp:archived'], [fx, 'gone-c', 'mcp:gone'], [fx, 'silent-d', 'mcp:silent'], [fx, 'noshow-e', 'mcp:noshow']]) {
      const r = x.run('topic.mjs', ['create', id, '--subject', 'S', '--class', 'code', '--here', '--no-copy'], { env: { WORKFLOW_THREAD_ID: thread } });
      assert.equal(r.status, 0, r.out);
    }

    // Without T3 (the test env has no T3 CLI): no state, every holder counts (the safe side).
    const blind = fx.run('report-intake.mjs', [], { env: { ...CRON, WORKFLOW_PIN_FILE: pin } });
    assert.equal(blind.status, 0, blind.out);
    assert.match(blind.stdout, new RegExp(`${TOPIC}: waiting: 5 active \\(limit 3 [^)]*\\); message m-1 stays held`));
    assert.equal(fs.existsSync(showLog), false, 'the stub is not the command yet');

    // T3 answers through the policy command: archived and gone do not count, unknown states do (3 of 5 → still full).
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${start}`, auto_max_active: 4 }, thread_title: { command: `${process.execPath} ${show} thread show --json` } }));
    const cron = { ...CRON, WORKFLOW_PIN_FILE: pin, WORKFLOW_T3_SHOW_COMMAND: '' };
    const r = fx.run('report-intake.mjs', [], { env: cron });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /waiting:/);
    assert.match(r.stdout, new RegExp(`${TOPIC}: message m-1 delivered to thread mcp:launch:rt1 \\(created\\)`));
    assert.equal(readHolderRecord(fx.brain, TOPIC).thread, 'mcp:launch:rt1');
    const asked = fs.readFileSync(showLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([...new Set(asked.map((a) => a.join(' ')))].sort(), ['mcp:archived', 'mcp:gone', 'mcp:live', 'mcp:noshow', 'mcp:silent'].map((t) => `thread show --json ${t}`));
    assert.equal(asked.length, 5, 'each holder thread asked once in a run');
    // Now 4 counted (live, silent, noshow, the new report topic): full at 4, a further item waits, the archived one still out.
    const auto = fx.run('topic.mjs', ['auto', 'issue-x-1', '--subject', 'Issue x#1', '--task', 'vybav issue'], { env: cron });
    assert.equal(auto.status, 3, auto.out);
    assert.equal(auto.stdout.trim().split('\n').pop(), 'waiting: 4 active');
    const reason = auto.stdout.split('\n').find((l) => l.startsWith('topic issue-x-1 not created; waiting: 4 active')) || '';
    for (const id of ['live-a', 'silent-d', 'noshow-e', TOPIC]) assert.ok(reason.includes(id), `${id} counted: ${reason}`);
    assert.doesNotMatch(reason, /arch-b|gone-c/);
  } finally { fx.cleanup(); other.cleanup(); }
});
