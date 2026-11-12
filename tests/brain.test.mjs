// P-040, P-037, P-025: brain writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, memoryRecord } from './helpers.mjs';
import { PLUGIN_ROOT } from '../scripts/util.mjs';

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

test('same file changed on both sides is a disagreement: not merged, reported', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-x.md', '--message', 'a', '--content', memoryRecord('service-x', 'from A')]).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'memory/service-x.md', '--message', 'b', '--content', memoryRecord('service-x', 'from B')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /conflict: memory\/service-x\.md/);
    assert.match(r.stdout, /unpushed: 1/);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from A/);
  } finally { fx.cleanup(); }
});

test('logs/*.log changed on both sides merge by union', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'logs/sequences.log', '--message', 'a', '--content', '2026-01-01 git-fetch+npm-test s1\n']).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'logs/sequences.log', '--message', 'b', '--content', '2026-01-02 npm-test+git-push s2\n']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /conflict/);
    const merged = fx.git(fx.origin, 'show', 'main:logs/sequences.log');
    assert.match(merged, /git-fetch\+npm-test/);
    assert.match(merged, /npm-test\+git-push/);
  } finally { fx.cleanup(); }
});

test('write into a topic by a thread that is not the holder is refused', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Test topic']).status, 0);
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

test('git in brain runs with the root of the running plugin, so brain hooks check with the same channel (P-048)', async () => {
  const { brainScriptEnv, BRAIN_SCRIPT_ENV } = await import('../scripts/config.mjs');
  const { PLUGIN_ROOT } = await import('../scripts/util.mjs');
  assert.deepEqual(brainScriptEnv(), { [BRAIN_SCRIPT_ENV]: '1', WORKFLOW_PLUGIN_ROOT: PLUGIN_ROOT });
});

test('attach of a brain with the old .gitattributes line commits the fix: the clone stays clean', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.brain, '.gitattributes'), '* text eol=lf\n');
    fx.git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'old template line');
    fx.git(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
    const clone = path.join(fx.root, 'brain-c');
    fx.git(fx.root, 'clone', '-q', fx.origin, clone);
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), clone, '--attach'], { env: fx.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fx.git(clone, 'status', '--porcelain'), '');
    assert.match(fs.readFileSync(path.join(clone, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
    assert.match(fx.git(clone, 'log', '-1', '--format=%s'), /^\[brain-script\] brain template: \.gitattributes/);
  } finally { fx.cleanup(); }
});

test('uncommitted change blocking the update from origin is reported as such, not as an empty disagreement', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-a.md', '--message', 'a', '--content', memoryRecord('service-a', 'from A')]).status, 0);
    fs.appendFileSync(path.join(fx.brainB, '.gitattributes'), '# local edit\n');
    const r = fx.runB('brain.mjs', ['write', 'memory/service-b.md', '--message', 'b', '--content', memoryRecord('service-b', 'from B')]);
    assert.match(r.out, /uncommitted changes in brain block the update from origin: \.gitattributes/);
    assert.doesNotMatch(r.out, /conflict|disagreement/);
    assert.match(fs.readFileSync(path.join(fx.brainB, '.gitattributes'), 'utf8'), /# local edit/);
  } finally { fx.cleanup(); }
});

test('same change made on two machines is no disagreement', () => {
  const fx = setup({ second: true });
  try {
    const rec = memoryRecord('service-same', 'same');
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-same.md', '--message', 'a', '--content', rec]).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'memory/service-same.md', '--message', 'b', '--content', rec]);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /conflict|unpushed/);
  } finally { fx.cleanup(); }
});

test('disagreement names the exact resolve command; resolve --keep local settles it and pushes', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-x.md', '--message', 'a', '--content', memoryRecord('service-x', 'from A')]).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'memory/service-x.md', '--message', 'b', '--content', memoryRecord('service-x', 'from B')]);
    assert.match(r.stdout, /settle each file: node \S+\/bin\/brain\.mjs resolve memory\/service-x\.md --keep local\|remote/);
    const s = fx.runB('brain.mjs', ['resolve', 'memory/service-x.md', '--keep', 'local']);
    assert.equal(s.status, 0, s.out);
    assert.match(s.stdout, /this machine's version kept/);
    assert.match(s.stdout, /^pushed; unpushed: 0/m);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from B/);
  } finally { fx.cleanup(); }
});

test('several disagreeing files: each resolve keeps the earlier choices until the sync goes through', () => {
  const fx = setup({ second: true });
  try {
    for (const k of ['service-x', 'service-y']) assert.equal(fx.run('brain.mjs', ['write', `memory/${k}.md`, '--message', 'a', '--content', memoryRecord(k, 'from A')]).status, 0);
    fx.git(fx.brainB, 'config', 'remote.origin.pushurl', '/nonexistent-origin.git');
    for (const k of ['service-x', 'service-y']) fx.runB('brain.mjs', ['write', `memory/${k}.md`, '--message', 'b', '--content', memoryRecord(k, 'from B')]);
    fx.git(fx.brainB, 'config', '--unset', 'remote.origin.pushurl');
    let r = fx.runB('brain.mjs', ['resolve', 'memory/service-x.md', '--keep', 'local']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /resolve memory\/service-y\.md --keep local\|remote/); assert.doesNotMatch(r.out, /resolve memory\/service-x\.md/);
    assert.match(r.out, /chosen so far: memory\/service-x\.md local/);
    r = fx.runB('brain.mjs', ['resolve', 'memory/service-y.md', '--keep', 'remote']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from B/);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-y.md'), /from A/);
    assert.ok(!fs.existsSync(path.join(fx.brainB, 'local', 'resolutions.json')));
  } finally { fx.cleanup(); }
});

test('topic.json changed on two machines: merged field by field, later updated time, no disagreement', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'tj', '--subject', 'Tj']).status, 0);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    assert.equal(fx.run('topic.mjs', ['pause', 'tj', '--reason', 'later']).status, 0);
    const file = path.join(fx.brainB, 'topics/tj/topic.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...t, updated: '2999-01-01T00:00:00.000Z' }, null, 2) + '\n');
    fx.git(fx.brainB, 'commit', '-q', '--no-verify', '-am', 'b topic.json');
    const r = fx.runB('brain.mjs', ['sync']);
    assert.equal(r.status, 0, r.out);
    const merged = JSON.parse(fx.git(fx.origin, 'show', 'main:topics/tj/topic.json'));
    assert.equal(merged.updated, '2999-01-01T00:00:00.000Z');
    const paused = JSON.parse(fx.read('topics/tj/topic.json'));
    for (const k of Object.keys(paused)) if (k !== 'updated') assert.deepEqual(merged[k], paused[k], k);
  } finally { fx.cleanup(); }
});

test('handover changed on two machines: both versions kept with a notice, pushed', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Ho']).status, 0);
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
test('pin: workflow_version through the brain writer, --all pins every brain the machine knows, other keys kept', () => {
  const a = setup();
  const b = setup({ thread: 'b2' });
  try {
    const pinFile = path.join(a.root, 'pin.json');
    fs.writeFileSync(pinFile, JSON.stringify({ brains: { [fs.realpathSync(b.brain)]: null, [path.join(a.root, 'gone')]: 'v0.9.12' } }));
    const env = { WORKFLOW_PIN_FILE: pinFile };
    fs.writeFileSync(path.join(a.brain, 'policy.json'), JSON.stringify({ topics: { stale_machine_hours: 6 }, workflow_version: 'v0.9.11' }));
    assert.match(a.run('brain.mjs', ['pin', 'v0.9.1'], { env }).out, /predates workflow_version/);
    assert.match(a.run('brain.mjs', ['pin', 'next'], { env }).out, /not a release tag/);
    const one = a.run('brain.mjs', ['pin', 'v0.9.16'], { env });
    assert.equal(one.status, 0, one.out);
    assert.match(one.stdout, /written: policy\.json/);
    assert.match(one.stdout, /other brains on this machine: brain\.mjs pin --all/);
    assert.deepEqual(JSON.parse(a.read('policy.json')), { topics: { stale_machine_hours: 6 }, workflow_version: 'v0.9.16' });
    assert.equal(a.git(a.brain, 'status', '--porcelain'), '', 'nothing left uncommitted');
    assert.match(a.git(a.origin, 'log', '-1', '--format=%s'), /^\[brain-script\] pin workflow v0\.9\.16$/);
    assert.ok(!b.exists('policy.json') || !/workflow_version/.test(b.read('policy.json')), 'without --all only this brain');
    const all = a.run('brain.mjs', ['pin', '--all', 'latest'], { env });
    assert.equal(all.status, 0, all.out);
    assert.equal(JSON.parse(a.read('policy.json')).workflow_version, 'latest');
    assert.equal(JSON.parse(b.read('policy.json')).workflow_version, 'latest');
    assert.match(b.git(b.origin, 'log', '-1', '--format=%s'), /pin workflow latest/);
    assert.doesNotMatch(all.stdout, /gone/, 'a brain that no longer exists is skipped');
  } finally { a.cleanup(); b.cleanup(); }
});

test('maintainer: policy.maintainer through the brain writer; none turns mail off so a report goes straight to an issue (flow-public#21)', () => {
  const fx = setup();
  try {
    assert.match(fx.run('brain.mjs', ['maintainer']).stdout, /^maintainer comms maintainer\/workflow-dev; repo https:\/\/github\.com\//);
    let r = fx.run('brain.mjs', ['maintainer', '--comms', 'none']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /maintainer comms none; repo https:/);
    const policy = JSON.parse(fx.read('policy.json'));
    assert.equal(policy.maintainer.comms, null);
    assert.equal(String(fx.git(fx.brain, 'status', '--porcelain', '--', 'policy.json')).trim(), '', 'committed');
    r = fx.run('error.mjs', ['report', '--text', 'chyba: x'], { env: { WORKFLOW_GH_CLI: path.join(fx.root, 'missing-gh'), WORKFLOW_GITHUB_TOKEN_FILE: path.join(fx.root, 'no-token') } });
    assert.match(r.stdout, /NOT reported: no maintainer topic configured; no GitHub access/);
    assert.notEqual(fx.run('brain.mjs', ['maintainer', '--comms', 'bad topic']).status, 0);
    assert.notEqual(fx.run('brain.mjs', ['maintainer', '--repo', 'https://example.test/x']).status, 0);
    r = fx.run('brain.mjs', ['maintainer', '--comms', 'me/dev', '--repo', 'https://github.com/o/r']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(fx.read('policy.json')).maintainer, { comms: 'me/dev', repo: 'https://github.com/o/r' });
  } finally { fx.cleanup(); }
});

test('session start pull: a local log commit (Stop leaves it local, audit 2.3a) goes out first, then origin comes in', async () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.runB('brain.mjs', ['write', 'memory/service-y.md', '--message', 'b', '--content', memoryRecord('service-y', 'from B')]).status, 0);
    const { brainWrite, brainPull } = await import('../scripts/brain.mjs');
    const { appendOp } = await import('../scripts/logs.mjs');
    const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policy', 'policy.json'), 'utf8'));
    brainWrite({ brainDir: fx.brain, thread: 'a1', policy }, { ops: [appendOp('sequences.log', ['s1 git status'])], internal: true, sync: false, message: 'logs flush s1' });
    const res = brainPull(fx.brain);
    assert.equal(res.behind, 0, JSON.stringify(res));
    assert.ok(fs.existsSync(path.join(fx.brain, 'memory', 'service-y.md')));
    assert.match(fx.git(fx.origin, 'log', '-3', '--format=%s'), /logs flush s1/);
  } finally { fx.cleanup(); }
});
