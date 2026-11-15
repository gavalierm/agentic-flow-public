// ttl: 2026-12-14
// P-068: work-dir.mjs prints and creates the work files folder of the thread; save skill and skill-check refuse a fixed
// work files path (scratch/, temy/<concrete topic>/tmp) in a skill body or script of a repo in data layout 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { setup2 } from './layout-2-helpers.mjs';

const SKILL = (body) => ['skill', 'wd-demo', '--description', 'Použi, keď skúšaš priečinok pracovných súborov.', '--origin', 'routine', '--content', body];

test('work-dir.mjs: layout 2 main, then the held topic, --main stays main; layout 1 scratch/', () => {
  const fx = setup2({ thread: 'wd1' });
  try {
    let r = fx.run('work-dir.mjs');
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), path.join(fx.brain, 'temy', 'main', 'tmp'));
    assert.ok(fs.statSync(r.stdout.trim()).isDirectory());
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.run('topic.mjs', ['claim', 'alpha']);
    r = fx.run('work-dir.mjs');
    assert.equal(r.stdout.trim(), path.join(fx.brain, 'temy', 'alpha', 'tmp'), r.out);
    assert.ok(fs.existsSync(r.stdout.trim()));
    assert.equal(fx.run('work-dir.mjs', ['--main']).stdout.trim(), path.join(fx.brain, 'temy', 'main', 'tmp'));
    // Project from WORKFLOW_PROJECT_DIR, not cwd.
    assert.equal(fx.run('work-dir.mjs', ['--main'], { cwd: fx.root, env: { WORKFLOW_PROJECT_DIR: fx.project } }).stdout.trim(), path.join(fx.brain, 'temy', 'main', 'tmp'));
  } finally { fx.cleanup(); }
  const f1 = setup({ thread: 'wd2', remote: false });
  try {
    assert.equal(f1.run('work-dir.mjs').stdout.trim(), path.join(f1.project, 'scratch'));
  } finally { f1.cleanup(); }
});

test('save skill and skill-check refuse a fixed work files path in layout 2', () => {
  const fx = setup2({ thread: 'wd3' });
  try {
    let r = fx.run('save.mjs', SKILL('Výsledok zapíš do scratch/out.md.'));
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /fixed work files path scratch\/.*work-dir\.mjs/);
    r = fx.run('save.mjs', SKILL('Výsledok zapíš do temy/alpha/tmp/out.md.'));
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /temy\/alpha\/tmp/);
    const script = path.join(fx.root, 'write-result.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho x > scratch/out.md\n');
    r = fx.run('save.mjs', [...SKILL('Spusti `sh write-result.sh`; výsledok je v temy/<téma>/tmp/.\nnie scratch/, lebo brain je v tvare 2'), '--script', script]);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /write-result\.sh:2: fixed work files path scratch\//);
    fs.writeFileSync(script, '#!/bin/sh\nD=$(node ~/.claude/skills/workflow/bin/work-dir.mjs)\necho x > "$D/out.md"\n');
    r = fx.run('save.mjs', [...SKILL('Spusti `sh write-result.sh`; výsledok je v temy/<téma>/tmp/.\nnie scratch/, lebo brain je v tvare 2'), '--script', script]);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['skill', 'wd-demo', '--origin', 'routine', '--sed', 's/výsledok je v/výsledok je v scratch\\/ a/']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /fixed work files path scratch\//);
    // A hand-written project skill with a fixed path: skill-check reports it.
    const dir = path.join(fx.project, '.claude', 'skills', 'hand-made');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: hand-made\ndescription: Použi, keď skúšaš.\n---\nKlon do scratch/repo.\n');
    r = fx.run('skill-check.mjs', ['hand-made']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /fixed work files path scratch\//);
  } finally { fx.cleanup(); }
});
