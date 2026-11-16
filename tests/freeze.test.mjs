// ttl: 2026-12-15
// Freeze during a rebuild (P-074, agent-alice/D-0092): threads reacted to reports and issues and rewrote the old, already
// rejected flow while the new version was being built. The freeze is a state of the brain policy, on and off with one
// command (brain.mjs freeze on|off); during it topic create refuses a code topic in a frozen repo unless allowed, and error
// reports still go to the maintainer thread (spec 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { readTopicRecord } from '../scripts/topic-files.mjs';
import { freezeOf, freezeRefusal, frozenRepo } from '../scripts/freeze.mjs';

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
  assert.match(freezeRefusal(policy, { id: 'fix-x', repo: 'agentic-flow' }), /^topic fix-x refused: agentic-flow is frozen until 1\.8\.0 \(r\).*a fix of the old version is not made/);
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
    assert.equal(fx.run('brain.mjs', ['freeze', 'off']).status, 0);
    const after = fx.run('topic.mjs', ['create', 'fix-old', '--subject', 'Oprava', '--class', 'code', '--here', '--no-copy']);
    assert.equal(after.status, 0, after.out);
  } finally { fx.cleanup(); }
});
