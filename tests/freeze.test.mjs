// ttl: 2026-12-15
// Freeze during a rebuild (P-074, agent-alice/D-0092): threads reacted to reports and issues and rewrote the old, already
// rejected flow while the new version was being built. The freeze is a state of the brain policy, on and off with one
// command (brain.mjs freeze on|off); during it the report intake makes no topic and answers the reporter with a
// rejection (report again in the new version), and topic create refuses a code topic in a frozen repo unless allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { readTopicRecord } from '../scripts/topic-files.mjs';
import { freezeOf, freezeRefusal, frozenRepo } from '../scripts/freeze.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const CRON = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };
const TOPIC = 'report-0123abcd';
const policyOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'policy.json'), 'utf8'));

test('brain.mjs freeze on|off writes the policy state; status shows it', () => {
  const fx = setup({ thread: 'fz1' });
  try {
    assert.equal(fx.run('brain.mjs', ['freeze']).stdout.trim(), 'freeze: off');
    const bad = fx.run('brain.mjs', ['freeze', 'on']);
    assert.notEqual(bad.status, 0, 'until and reason are required');
    const on = fx.run('brain.mjs', ['freeze', 'on', '--until', '1.8.0', '--reason', 'prestavba pošty', '--allow', 'flow-1-8,comms-x', '--repos', 'project']);
    assert.equal(on.status, 0, on.out);
    assert.match(on.stdout, /freeze: on until 1\.8\.0 \(prestavba pošty\); repos project; allowed topics flow-1-8, comms-x/);
    const f = freezeOf(policyOf(fx));
    assert.deepEqual([f.until, f.reason, f.allow, f.repos, f.by], ['1.8.0', 'prestavba pošty', ['flow-1-8', 'comms-x'], ['project'], 'fz1']);
    assert.equal(fx.run('brain.mjs', ['freeze', 'allow', 'pilot-y']).status, 0);
    assert.deepEqual(freezeOf(policyOf(fx)).allow, ['flow-1-8', 'comms-x', 'pilot-y']);
    assert.match(fx.run('brain.mjs', ['status']).stdout, /^freeze: on until 1\.8\.0/m);
    const off = fx.run('brain.mjs', ['freeze', 'off']);
    assert.equal(off.status, 0, off.out);
    assert.match(off.stdout, /freeze: off/);
    assert.equal(policyOf(fx).freeze, undefined);
    assert.doesNotMatch(fx.run('brain.mjs', ['status']).stdout, /freeze/);
  } finally { fx.cleanup(); }
});

test('the freeze covers the workflow and the mail by default, -public mirrors too, and lets allowed topics through', () => {
  const policy = { freeze: { reason: 'r', until: '1.8.0', allow: ['flow-1-8'] } };
  assert.ok(frozenRepo(freezeOf(policy), 'agentic-flow'));
  assert.ok(frozenRepo(freezeOf(policy), 'agentic-comms-public'));
  assert.ok(!frozenRepo(freezeOf(policy), 'web'));
  assert.equal(freezeRefusal(policy, { id: 'flow-1-8', repo: 'agentic-flow' }), null);
  assert.equal(freezeRefusal(policy, { id: 'fix-x', repo: 'web' }), null);
  assert.match(freezeRefusal(policy, { id: 'fix-x', repo: 'agentic-flow' }), /^topic fix-x refused: agentic-flow is frozen until 1\.8\.0 \(r\).*report it again in the new version/);
  assert.equal(freezeOf({ freeze: { on: false, until: 'x' } }), null);
});

test('topic create refuses a code topic in a frozen repo outside the allowed ones; a discussion topic passes', () => {
  const fx = setup({ thread: 'fz2' });
  try {
    assert.equal(fx.run('brain.mjs', ['freeze', 'on', '--until', '1.8.0', '--reason', 'prestavba', '--allow', 'rebuild-a', '--repos', 'project']).status, 0);
    const refused = fx.run('topic.mjs', ['create', 'fix-old', '--subject', 'Oprava starej verzie', '--class', 'code', '--here', '--no-copy']);
    assert.notEqual(refused.status, 0, refused.out);
    assert.match(refused.out, /topic fix-old refused: project is frozen until 1\.8\.0 \(prestavba\)/);
    assert.equal(readTopicRecord(fx.brain, 'fix-old'), null);
    const allowed = fx.run('topic.mjs', ['create', 'rebuild-a', '--subject', 'Prestavba', '--class', 'code', '--here', '--no-copy']);
    assert.equal(allowed.status, 0, allowed.out);
    const talk = fx.run('topic.mjs', ['create', 'talk-a', '--subject', 'Diskusia', '--class', 'discussion', '--here']);
    assert.equal(talk.status, 0, talk.out);
    // An issue (topic.mjs auto, code without a thread) gets no topic and no fallback mail: exit 4 with the rejection text.
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ ...policyOf(fx), topics: { thread_start_command: 'false', auto: { default_project: '../project', orchestrator: 'talk-a' } } }));
    const auto = fx.run('topic.mjs', ['auto', 'issue-old-1', '--subject', 'Issue #1', '--task', 'oprav'], { env: CRON });
    assert.equal(auto.status, 4, auto.out);
    assert.match(auto.stdout, /^reject: Issue issue-old-1 je odmietnuté: workflow a pošta sú zmrazené do verzie 1\.8\.0 \(prestavba\).*nahlás ju znova\.$/m);
    assert.match(auto.stdout, /^frozen: until 1\.8\.0$/m);
    assert.doesNotMatch(auto.out, /^fallback: /m);
    assert.equal(readTopicRecord(fx.brain, 'issue-old-1'), null);
    assert.equal(fx.run('brain.mjs', ['freeze', 'off']).status, 0);
    const after = fx.run('topic.mjs', ['create', 'fix-old', '--subject', 'Oprava', '--class', 'code', '--here', '--no-copy']);
    assert.equal(after.status, 0, after.out);
  } finally { fx.cleanup(); }
});

test('report-intake during the freeze makes no topic: the reporter gets the rejection, the held report is discarded', () => {
  const fx = setup({ thread: 'fz3' });
  try {
    const stateFile = path.join(fx.root, 'stub-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      sends: [],
      notices: [{ id: 'n-1', kind: 'unregistered-topic', state: 'open', project: 'project', topic: TOPIC, message_id: 'm-1' }],
      message: { 'm-1': { id: 'm-1', status: 'held', project: 'project', topic: TOPIC, sender: 'rep', from_project: 'rp', from_topic: 'rt', expires_at: '2999-01-01T00:00:00.000Z', expired_at: null } },
    }));
    const env = { ...CRON, WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') };
    assert.equal(fx.run('brain.mjs', ['freeze', 'on', '--until', '1.8.0', '--reason', 'prestavba pošty']).status, 0);
    const r = fx.run('report-intake.mjs', [], { env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`${TOPIC}: message m-1 rejected: frozen until 1\\.8\\.0, no topic; reply to rp/rt \\(m-sent\\), message discarded`));
    assert.equal(readTopicRecord(fx.brain, TOPIC), null, 'no topic');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.sends.length, 1);
    const argv = st.sends[0].argv;
    assert.deepEqual([argv[argv.indexOf('--level') + 1], argv[argv.indexOf('--project') + 1], argv[argv.indexOf('--topic') + 1]], ['steer', 'rp', 'rt']);
    assert.match(st.sends[0].text, /^Hlásenie m-1 je odmietnuté: workflow a pošta sú zmrazené do verzie 1\.8\.0 \(prestavba pošty\).*nahlás ju znova/);
    assert.equal(st.message['m-1'].status, 'discarded');
    assert.equal(st.notices[0].decision, 'discard');
    // Nothing waits any more: the next run sends nothing again.
    const again = fx.run('report-intake.mjs', [], { env });
    assert.equal(again.status, 0, again.out);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends.length, 1);
  } finally { fx.cleanup(); }
});
