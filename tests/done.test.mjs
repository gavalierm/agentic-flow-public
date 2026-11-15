// keep: core
// P-005, P-006, P-011, P-020, P-036: done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, startComms, commsClient } from './helpers.mjs';
import { readLog } from '../scripts/logs.mjs';
const logView = (fx, name) => { const l = readLog(fx.brain, name, { rotationDays: 30 }); return l.length ? l.join('\n') + '\n' : ''; };

// Commits what the test wrote into the topic's code copy (a separate clone next to the project).
const commitCopy = (copy, message) => {
  for (const args of [['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['add', '-A'], ['commit', '-q', '-m', message]]) spawnSync('git', args, { cwd: copy });
};

test('done --topic merges the code copy into the main branch, archives the topic, removes the copy', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'feature\n');
    commitCopy(copy, 'feat');
    // main moves on in parallel; no conflict
    fs.writeFileSync(path.join(fx.project, 'other.txt'), 'other\n');
    fx.git(fx.project, 'add', '-A'); fx.git(fx.project, 'commit', '-q', '-m', 'other');
    let r = fx.run('done.mjs', ['--topic']);
    assert.equal(r.status, 1); assert.match(r.stderr, /verified/);
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(fx.project, 'feature.txt')));
    assert.ok(fs.existsSync(path.join(fx.project, 'other.txt')));
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/feat/);
    assert.ok(!fs.existsSync(copy));
    assert.ok(!fx.exists('topics/feat'));
    assert.ok(fx.exists('topics/archive/feat/topic.json'));
    assert.equal(JSON.parse(fx.read('topics/archive/feat/topic.json')).state, 'closed');
    assert.equal(fx.run('topic.mjs', ['list']).stdout.trim(), 'no open topics');
    assert.ok(fx.git(fx.origin, 'ls-tree', '-r', '--name-only', 'main').includes('topics/archive/feat/topic.json'));
  } finally { fx.cleanup(); }
});

test('done (unit) of a code topic merges the verified copy into the main branch, keeps the copy and the topic held (D-0011)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'feature\n');
    commitCopy(copy, 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'not verified yet\n');
    let r = fx.run('done.mjs', ['--verified', 'feature.txt present']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /uncommitted changes/);
    assert.ok(!fs.existsSync(path.join(fx.project, 'feature.txt')), 'a refused unit merges nothing');
    spawnSync('git', ['checkout', '--', 'feature.txt'], { cwd: copy });
    r = fx.run('done.mjs', ['--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'feature.txt'), 'utf8'), 'feature\n');
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/feat \(done feat\)/);
    assert.ok(fs.existsSync(copy), 'the copy stays for the next unit');
    assert.match(r.stdout, /topic feat stays held by a1/);
    assert.equal(JSON.parse(fx.read('topics/feat/holder.json')).thread, 'a1');
  } finally { fx.cleanup(); }
});

test('done --topic: uncommitted files of the main checkout equal to the topic branch do not block the merge (adopt, Windows instance 2026-11-07)', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.project, 'settings.txt'), 'v1\n');
    fs.writeFileSync(path.join(fx.project, 'mine.txt'), 'a\n');
    fx.git(fx.project, 'add', '-A'); fx.git(fx.project, 'commit', '-q', '-m', 'base');
    assert.equal(fx.run('topic.mjs', ['create', 'tidy', '--subject', 'Tidy', '--class', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'tidy');
    fs.writeFileSync(path.join(copy, 'settings.txt'), 'v2\n');
    fs.writeFileSync(path.join(copy, 'gen.json'), '{}\n');
    commitCopy(copy, 'tidy');
    // connect generated the same files in the main checkout, uncommitted; one other change is the operator's own
    fs.writeFileSync(path.join(fx.project, 'settings.txt'), 'v2\n');
    fs.writeFileSync(path.join(fx.project, 'gen.json'), '{}\n');
    fs.writeFileSync(path.join(fx.project, 'mine.txt'), 'b\n');
    let r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /uncommitted changes; commit or stash them before merging topic\/tidy: mine\.txt$/m);
    assert.equal(fs.readFileSync(path.join(fx.project, 'mine.txt'), 'utf8'), 'b\n', 'a different change is kept');
    fx.git(fx.project, 'checkout', '--', 'mine.txt');
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'settings.txt'), 'utf8'), 'v2\n');
    assert.equal(fs.readFileSync(path.join(fx.project, 'gen.json'), 'utf8'), '{}\n');
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/tidy/);
    assert.equal(fx.git(fx.project, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});

test('done --topic is refused in a wake turn and for a non-holder', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'discussion']).status, 0);
    let r = fx.runB('done.mjs', ['--topic', '--knowledge', 'nic nové', '--topic-id', 'd', '--verified', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /held by a1/);
    fs.mkdirSync(path.join(fx.brain, 'local', 'threads'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ turn_source: 'wake' }));
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /P-047/); assert.match(r.stderr, /continuation is set in 1 min/);
    assert.ok(fx.exists('topics/d/topic.json'));
    // An answer of the operator in a dialog of this turn is the instruction (D-0011); an answer from an earlier turn is not.
    const state = (s) => fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ turn_source: 'wake', ...s }));
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    state({ turn_started_at: iso(now), dialog_answered_at: iso(now - 60_000) });
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'x']);
    assert.equal(r.status, 1, 'a dialog answered before this turn'); assert.match(r.stderr, /P-047/);
    state({ turn_started_at: iso(now - 60_000), dialog_answered_at: iso(now) });
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('topics/archive/d/topic.json'));
  } finally { fx.cleanup(); }
});

// alice 2026-11-02: done --topic closes the topic in the mail service (new mail 410, waiting mail bounces to the sender);
// a thread that also holds main is not archived; archived topics from before are closed at the next session start.
const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
