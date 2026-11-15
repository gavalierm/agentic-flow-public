// keep: core
// P-040, P-037, P-025: brain writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, memoryRecord } from './helpers.mjs';
import { PLUGIN_ROOT } from '../scripts/util.mjs';

// flow-public#49: semicolons inside the sentences of items made the handover too long twice; the refusal names the items per option.
test('write commits with the script tag and pushes to origin', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/operator-operator.md', '--message', 'test write', '--content', memoryRecord('operator-operator', 'name: X')]);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] test write$/);
    assert.match(fx.git(fx.origin, 'log', '-1', '--format=%s'), /^\[brain-script\] test write$/);
    assert.doesNotMatch(r.stdout, /unpushed/);
  } finally { fx.cleanup(); }
});

test('write into a topic by a thread that is not the holder is refused', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Test topic', '--class', 'discussion']).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'topics/t1/handover.md', '--message', 'x', '--content', '## Zadanie\nx\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /held by thread a1/);
  } finally { fx.cleanup(); }
});

test('write in a subagent is refused', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/operator-operator.md', '--message', 'x', '--content', memoryRecord('operator-operator')], { env: { WORKFLOW_AGENT_ID: 'sub1' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /subagent/);
  } finally { fx.cleanup(); }
});

test('record with a diacritic key or a file in local/ is refused', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/sluzba-x.md', '--message', 'x', '--content', '---\nkey: služba-x\norigin: operator\n---\nx\n']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /diacritics/);
    const r2 = fx.run('brain.mjs', ['write', 'local/index/memory.md', '--message', 'x', '--content', 'x']);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /local\//);
  } finally { fx.cleanup(); }
});

test('same file changed on both sides is a disagreement: not merged, reported with the exact resolve command; resolve --keep local settles it and pushes', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-x.md', '--message', 'a', '--content', memoryRecord('service-x', 'from A')]).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'memory/service-x.md', '--message', 'b', '--content', memoryRecord('service-x', 'from B')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /conflict: memory\/service-x\.md/);
    assert.match(r.stdout, /unpushed: 1/);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from A/);
    assert.match(r.stdout, /settle each file: node \S+\/bin\/brain\.mjs resolve memory\/service-x\.md --keep local\|remote/);
    const s = fx.runB('brain.mjs', ['resolve', 'memory/service-x.md', '--keep', 'local']);
    assert.equal(s.status, 0, s.out);
    assert.match(s.stdout, /this machine's version kept/);
    assert.match(s.stdout, /^pushed; unpushed: 0/m);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from B/);
  } finally { fx.cleanup(); }
});

test('handover changed on two machines: both versions kept with a notice, pushed', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Ho', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'x', '--next', 'base']).status, 0);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    assert.equal(fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'x', '--next', 'next from A']).status, 0);
    fs.writeFileSync(path.join(fx.brainB, 'topics/ho/handover.md'), fx.read('topics/ho/handover.md', fx.brainB).replace('base', 'next from B'));
    fx.git(fx.brainB, 'commit', '-q', '--no-verify', '-am', 'b handover');
    const r = fx.runB('brain.mjs', ['sync']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /topic ho: handover changed on two machines, both versions kept/);
    const merged = fx.git(fx.origin, 'show', 'main:topics/ho/handover.md');
    assert.match(merged, /next from A[\s\S]*handover conflict[\s\S]*next from B/);
  } finally { fx.cleanup(); }
});

// flow-public#7: a hand edit of policy.json is refused by the pre-commit and blocks the update from origin.