// ttl: 2026-12-15
// Fix gate (P-075, agent-alice/D-0093): threads of topics from reports and issues fixed and released the old version while
// the new one was being built. A topic from a report or an issue (code without a thread, its orchestrator in topic.json)
// starts its fix only after the orchestrator answered "áno, relevantné"; the thread asks by mail first (its first message
// says so), the hook is only the safety net: a write into the topic's code copy without the yes is refused with the way to
// ask, after "nie, pracuje sa na novej verzii" with the way to reject the report. The orchestrator answers in one step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { readTopicRecord } from '../scripts/topic-files.mjs';
import { fixGated, FIX_ANSWERS } from '../scripts/fix-gate.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const CRON = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };
const ID = 'issue-x-1';
const TOPIC_THREAD = 'mcp:launch:rt1';

function fixture() {
  const fx = setup({ thread: 'orch-t' });
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ resolves: [], message: { 'q-1': { id: 'q-1', status: 'picked', level: 'assist', project: 'project', topic: 'orch', from_project: 'project', from_topic: ID } } }));
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  const t3 = path.join(fx.root, 'fake-t3.mjs');
  const firstMessage = path.join(fx.root, 't3-message.txt');
  fs.writeFileSync(t3, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(firstMessage)}, fs.readFileSync(0, 'utf8'));\nconsole.log(JSON.stringify({ threadId: ${JSON.stringify(TOPIC_THREAD)} }));\n`);
  const orch = fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrátor', '--class', 'discussion', '--here']);
  assert.equal(orch.status, 0, orch.out);
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${t3}`, auto: { default_project: '../project', orchestrator: 'orch' } } }));
  const copy = path.join(fx.root, 'project-topics', ID);
  const write = (thread = TOPIC_THREAD, file = path.join(copy, 'src', 'fix.js')) => fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: file, content: 'x\n' } }, { env: { WORKFLOW_THREAD_ID: thread } });
  return { fx, copy, write, firstMessage, stub: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
}

const decisionOf = (r) => r.json.hookSpecificOutput?.permissionDecision;
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

test('an automatic topic records the fix gate; its copy is written only after the orchestrator answered yes', () => {
  const { fx, copy, write, firstMessage, stub } = fixture();
  try {
    const auto = fx.run('topic.mjs', ['auto', ID, '--subject', 'Issue x#1', '--task', 'vybav issue'], { env: CRON });
    assert.equal(auto.status, 0, auto.out);
    const topic = readTopicRecord(fx.brain, ID);
    assert.equal(topic.fix_gate, true, JSON.stringify(topic));
    assert.ok(fs.existsSync(copy), auto.out);
    assert.match(fs.readFileSync(firstMessage, 'utf8'), /Oprava \(P-075\): pred prvou zmenou kódu sa spýtaj orchestrátora \(comms send --level assist --to orch/);
    // The safety net: no yes yet, the write into the copy is refused with the way to ask.
    const before = write();
    assert.equal(decisionOf(before), 'deny', JSON.stringify(before.json));
    assert.match(reasonOf(before), /^topic issue-x-1 comes from a report or an issue: the fix starts only after its orchestrator \(orch\) agrees.*comms send --level assist --to orch --text "fix issue-x-1: .*after yes the same write passes \(P-075\)$/);
    // A worker's shell write into the copy meets the same net.
    const shell = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', agent_type: 'workflow:worker', tool_input: { command: `echo x > ${path.join(copy, 'src', 'b.js')}` } }, { env: { WORKFLOW_THREAD_ID: TOPIC_THREAD } });
    assert.equal(decisionOf(shell), 'deny', JSON.stringify(shell.json));
    assert.match(reasonOf(shell), /^topic issue-x-1 comes from a report or an issue/);
    // A thread that is not the orchestrator cannot agree.
    const foreign = fx.run('topic.mjs', ['consent', ID, '--fix', 'yes'], { env: { WORKFLOW_THREAD_ID: 'other-t' } });
    assert.notEqual(foreign.status, 0, foreign.out);
    assert.match(foreign.out, /only the orchestrator of topic issue-x-1/);
    assert.equal(decisionOf(write()), 'deny');
    // The orchestrator answers the question q-1 of the topic in one step: recorded and replied.
    const yes = fx.run('comms.mjs', ['send', '--reply-to', 'q-1', '--state', 'hotovo', '--fix', 'yes', '--text', 'oprava pre 1.8.0']);
    assert.equal(yes.status, 0, yes.out);
    assert.match(yes.stdout, /fix of topic issue-x-1: áno, relevantné \(consent c-/);
    const sent = stub().resolves.at(-1);
    assert.equal(sent.text, `${FIX_ANSWERS.yes}: oprava pre 1.8.0`);
    assert.equal(sent.argv[sent.argv.indexOf('--state') + 1], 'hotovo');
    const after = write();
    assert.notEqual(decisionOf(after), 'deny', reasonOf(after));
    // A later no stops the fix again and names the rejection.
    const no = fx.run('topic.mjs', ['consent', ID, '--fix', 'no']);
    assert.equal(no.status, 0, no.out);
    const refused = write();
    assert.equal(decisionOf(refused), 'deny');
    assert.match(reasonOf(refused), /answered "nie, pracuje sa na novej verzii" for topic issue-x-1: no fix of this version\. Reject the report or issue .*report it again in the new version.*\(P-075\)$/);
  } finally { fx.cleanup(); }
});

test('--fix belongs to a final reply and to a topic with the gate; a topic without it is not gated', () => {
  const { fx, write } = fixture();
  try {
    const noReply = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'orch', '--fix', 'yes', '--text', 'x']);
    assert.notEqual(noReply.status, 0);
    assert.match(noReply.out, /--fix answers a fix question/);
    const interim = fx.run('comms.mjs', ['send', '--reply-to', 'q-1', '--state', 'otázka', '--fix', 'yes']);
    assert.notEqual(interim.status, 0);
    assert.match(interim.out, /--fix is the final answer: --state hotovo/);
    // A code topic a thread created for itself has no gate: its copy is written as before, and --fix is refused.
    const own = fx.run('topic.mjs', ['create', ID, '--subject', 'Vlastná práca', '--class', 'code', '--here']);
    assert.equal(own.status, 0, own.out);
    assert.equal(readTopicRecord(fx.brain, ID).fix_gate, undefined);
    assert.notEqual(decisionOf(write('orch-t')), 'deny');
    const fix = fx.run('comms.mjs', ['send', '--reply-to', 'q-1', '--state', 'hotovo', '--fix', 'yes']);
    assert.notEqual(fix.status, 0, fix.out);
    assert.match(fix.out, /topic issue-x-1 has no fix gate .*nothing sent/);
  } finally { fx.cleanup(); }
});

test('fixGated: the recorded field wins; a code topic from before it that code created with an orchestrator is gated', () => {
  assert.equal(fixGated({ kind: 'code', fix_gate: true }), true);
  assert.equal(fixGated({ kind: 'code', fix_gate: false, orchestrator: { topic: 'o' } }), false);
  assert.equal(fixGated({ kind: 'code', orchestrator: { topic: 'o' } }), true);
  assert.equal(fixGated({ kind: 'code', orchestrator: { topic: 'o', thread: 't' }, created_by: 't' }), false);
  assert.equal(fixGated({ kind: 'discussion', orchestrator: { topic: 'o' } }), false);
});
