// keep: core
// P-013, P-007, P-031, P-009, P-008, P-032, P-035: save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('memory: fixed format with key/origin; same subject overwrites; similar key refused unless --new', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['memory', 'operator', 'operator', '--content', 'name: Anna', '--aliases', 'me']);
    assert.equal(r.status, 0, r.out);
    let rec = parseFrontmatter(fx.read('memory/operator-operator.md'));
    assert.equal(rec.data.key, 'operator-operator'); assert.equal(rec.data.origin, 'operator'); assert.deepEqual(rec.data.aliases, ['me']);
    assert.equal(rec.body.trim(), 'name: Anna');
    r = fx.run('save.mjs', ['memory', 'operator', 'operator', '--content', 'name: Beta']);
    assert.equal(r.status, 0, r.out);
    rec = parseFrontmatter(fx.read('memory/operator-operator.md'));
    assert.equal(rec.body.trim(), 'name: Beta');
    assert.deepEqual(rec.data.aliases, ['me'], 'aliases kept');
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1, 'one record per subject');
    // alias hit -> overwrite the same file
    assert.equal(fx.run('save.mjs', ['memory', 'operator', 'me', '--content', 'name: Gamma']).status, 0);
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1);
    // similar key
    assert.equal(fx.run('save.mjs', ['memory', 'service', 'x service', '--content', 'tokens', '--aliases', 'xs']).status, 0);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging']);
    assert.equal(r.status, 1); assert.match(r.stderr, /similar key exists.*service-x-service/);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging', '--new']);
    assert.equal(r.status, 0, r.out);
    // derived needs sources; diacritics normalized in key
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived']);
    assert.equal(r.status, 1); assert.match(r.stderr, /sources/);
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived', '--sources', 'README.md']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('memory/service-posta.md'));
    assert.match(fx.read('memory/service-posta.md'), /fingerprint: [0-9a-f]{12}/);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] save memory service-posta/);
  } finally { fx.cleanup(); }
});

test('decision gets a sequential ID, needs relates_to, supersedes marks the old one', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X']);
    assert.equal(r.status, 1); assert.match(r.stderr, /relates-to/);
    r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X', '--relates-to', 'src/app.js']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /decision D-0001/);
    r = fx.run('save.mjs', ['decision', 'Library C', '--what', 'C', '--reason', 'faster', '--relates-to', 'src/app.js', '--supersedes', 'D-0001']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /D-0002/);
    const old = parseFrontmatter(fx.read('decisions/d-0001-library-a.md'));
    assert.equal(old.data.status, 'superseded-by D-0002');
    assert.match(fx.run('find.mjs', ['--relates-to', 'src/app.js']).stdout, /d-0002-library-c/);
  } finally { fx.cleanup(); }
});

// Pilot of v0.9.73 (2026-11-12): `save.mjs handover <topic> --help` wrote an empty handover over the topic's one.
test('handover: an unknown option or no content is refused and the current handover stays', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'hh', '--subject', 'H', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'hh', '--task', 'Task', '--next', 'step two']).status, 0);
    const before = fx.read('topics/hh/handover.md');
    let r = fx.run('save.mjs', ['handover', 'hh', '--help']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /unknown option --help; nothing written/);
    r = fx.run('save.mjs', ['handover', 'hh', '--task', 'Task', '--nxt', 'typo']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /unknown option --nxt/);
    r = fx.run('save.mjs', ['handover', 'hh']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /no content/);
    assert.equal(fx.read('topics/hh/handover.md'), before);
  } finally { fx.cleanup(); }
});

const HAS_WORDS = fs.existsSync('/usr/share/dict/words');
test('save from inside another workflow project refuses: the session project would get the write (alice 2026-11-04)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    let r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cwd is in project .* with its own brain.*--project/s);
    r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y', '--project', fx.project], { cwd: fx.projectB, env });
    assert.equal(r.status, 0, r.stderr);
    r = fx.run('topic.mjs', ['list'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1, 'topic refuses too');
  } finally { fx.cleanup(); }
});

test('brain.mjs write/remove from another brain or project refuses; --project writes there (alice 2026-11-07)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    const src = path.join(fx.root, 'note.md');
    fs.writeFileSync(src, 'x\n');
    const headA = () => spawnSync('git', ['-C', fx.brain, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const before = headA();
    for (const cwd of [fx.brainB, fx.projectB]) {
      const r = fx.run('brain.mjs', ['write', 'docs/note.md', '--file', src, '--message', 'm'], { cwd, env });
      assert.equal(r.status, 1, `write from ${cwd} must refuse: ${r.stdout}`);
      assert.match(r.stderr, /cwd is in (brain|project) .*--project/s);
    }
    let r = fx.run('brain.mjs', ['remove', 'docs/note.md', '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 1, 'remove refuses too');
    assert.equal(headA(), before, 'nothing landed in the session brain');
    r = fx.run('brain.mjs', ['write', 'docs/note.md', '--project', fx.projectB, '--file', src, '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, r.stderr + r.stdout + (r.out || ''));
    assert.ok(fs.existsSync(path.join(fx.brainB, 'docs', 'note.md')), 'written into brain-b');
    assert.equal(headA(), before);
    r = fx.run('brain.mjs', ['status'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, 'read-only commands are not refused');
  } finally { fx.cleanup(); }
});
