// keep: core
// Data layout 3 (flow v2, spec 4, plan B10 and B16, O11, O18): the map of a brain (topics/, memory/, decisions/, ... in its
// root, no outputs and no sources) and of a project repo (.brain/ as in layout 2, vystupy/<typ>/, zdroje/<téma>/), the work
// files of a topic, a write through save, the brain pre-commit, brain-init without --layout, and the layout guard of the
// session start and of save (a repo whose layout does not fit its brain: pull).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup3, gitq } from './layout-2-helpers.mjs';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';
import { layoutFor, layoutOf, layoutRole, layoutVersions, dataPath, dataRel, isWorkPath, workDirFor, workIgnoreLine, hasScratch, splitRoles, layoutMismatch, ROLE_REPO, NEW_BRAIN_LAYOUT } from '../scripts/layout.mjs';
import { oneTopicFile } from '../scripts/topic-files.mjs';
import { brainEntriesFor } from '../scripts/config.mjs';

test('the map of layout 3: brain records in the root, no outputs; the project repo keeps .brain/ and gets vystupy/<typ>/', () => {
  assert.deepEqual(layoutVersions(), [1, 2, 3]);
  assert.equal(NEW_BRAIN_LAYOUT, 3);
  const B = layoutFor(3);
  for (const n of ['memory', 'decisions', 'rules', 'skills', 'exceptions', 'logs', 'topics']) assert.equal(B[n], n);
  assert.equal(B.policy, 'policy.json');
  assert.equal(B.topicFile, '.tema.json');
  assert.equal(B.holderFile, '.tema.json');
  for (const n of ['docs', 'materialy', 'topicArchive', 'topicHidden', 'scratch', 'outputs']) assert.equal(B[n], null, n);
  const R = layoutFor(3, ROLE_REPO);
  assert.equal(R.policy, '.brain/policy.json');
  assert.equal(R.memory, '.brain/memory');
  assert.equal(R.materialy, 'zdroje');
  assert.equal(R.outputs, 'vystupy');
  assert.equal(splitRoles(3), true);
  assert.equal(splitRoles(2), false);
  assert.deepEqual(Object.keys(B).sort(), Object.keys(layoutFor(1)).sort());
  assert.deepEqual(brainEntriesFor(3).slice(0, 8), ['memory/**', 'decisions/**', 'rules/**', 'skills/**', 'exceptions/**', 'logs/**', 'notes/**', 'policy.json']);
  assert.ok(brainEntriesFor(3).includes('topics/*/.tema.json') && brainEntriesFor(3).includes('topics/*/handover.md'));
});

test('a brain and a project repo of layout 3: paths by role, work files per topic in topics/<topic>/tmp', () => {
  const fx = setup3({ thread: 'l3a' });
  try {
    assert.ok(fx.exists('policy.json') && fx.exists('topics') && !fx.exists('.brain') && !fx.exists('vystupy'));
    assert.equal(layoutRole(fx.brain), 'brain');
    assert.equal(layoutRole(fx.project), 'repo');
    assert.equal(dataRel(fx.brain, 'memory'), 'memory');
    assert.equal(dataRel(fx.project, 'memory'), '.brain/memory');
    assert.equal(dataRel(fx.project, 'outputs', 'audity'), 'vystupy/audity');
    assert.throws(() => dataRel(fx.brain, 'docs'), /does not exist in data 2\.1/);
    assert.equal(layoutOf(fx.brain).index, 'INDEX.md');
    assert.equal(oneTopicFile(fx.brain), true);
    assert.equal(hasScratch(fx.brain), false);
    assert.equal(workDirFor(fx.brain, 'alpha'), path.join(fx.brain, 'topics', 'alpha', 'tmp'));
    assert.equal(workIgnoreLine(fx.brain), 'topics/*/tmp/');
    assert.equal(isWorkPath(fx.brain, dataPath(fx.brain, 'topics', 'alpha', 'tmp', 'a.txt')), true);
    assert.equal(isWorkPath(fx.brain, dataPath(fx.brain, 'topics', 'alpha', 'analyza.md')), true);
    assert.equal(isWorkPath(fx.brain, dataPath(fx.brain, 'topics', 'alpha', '.tema.json')), false);
    assert.equal(isWorkPath(fx.brain, dataPath(fx.brain, 'topics', 'alpha', 'handover.md')), false);
    assert.equal(isWorkPath(fx.brain, dataPath(fx.brain, 'memory', 'x.md')), false);
    assert.equal(layoutMismatch(fx.brain, fx.project), null);
  } finally { fx.cleanup(); }
});

test('save and topic write into a brain of layout 3: records in the root, the topic in topics/<id>/, INDEX.md in the same commit', () => {
  const fx = setup3({ thread: 'l3b' });
  try {
    let r = fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.run('topic.mjs', ['claim', 'alpha']).status, 0);
    assert.equal(fx.json('topics/alpha/.tema.json').holder.thread, 'l3b');
    assert.equal(fx.run('work-dir.mjs').stdout.trim(), path.join(fx.brain, 'topics', 'alpha', 'tmp'));
    r = fx.run('save.mjs', ['memory', 'project', 'site', '--content', 'Web beží na serveri x.']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('memory/project-site.md'), r.out);
    const files = gitq(fx.brain, 'ls-files').split('\n');
    assert.ok(files.includes('memory/project-site.md') && files.includes('topics/alpha/handover.md') && files.includes('INDEX.md'), files.join(' '));
    assert.match(fx.read('INDEX.md'), /\| topics\/alpha\/handover\.md \| Alpha \|/);
    assert.match(gitq(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\]/);
    assert.equal(gitq(fx.brain, 'status', '--porcelain'), '');
    // A brain of layout 3 keeps no documents (spec 4): save docs names where they go instead of a path error.
    r = fx.run('save.mjs', ['docs']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /a brain of data 2\.1 keeps no documents \(spec 4\): .*save\.mjs result.*save\.mjs source/);
  } finally { fx.cleanup(); }
});

test('the brain pre-commit of layout 3 checks the records in the root and the handover in topics/; INDEX.md is a valid name', () => {
  const fx = setup3({ thread: 'l3c' });
  try {
    const env = { ...fx.env, WORKFLOW_BRAIN_SCRIPT: '1' };
    const stage = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(fx.brain, rel)), { recursive: true });
      fs.writeFileSync(path.join(fx.brain, rel), content);
      gitq(fx.brain, 'add', '-f', rel);
    };
    const commit = () => { const c = spawnSync('git', ['commit', '-q', '-m', '[brain-script] x'], { cwd: fx.brain, env, encoding: 'utf8' }); return { status: c.status, out: c.stdout + c.stderr }; };
    stage('memory/no-key.md', '---\norigin: operator\n---\nx\n');
    let r = commit();
    assert.equal(r.status, 1); assert.match(r.out, /record needs frontmatter key/);
    gitq(fx.brain, 'reset', '-q');
    stage('topics/t/handover.md', '## Zadanie\na\n');
    r = commit();
    assert.equal(r.status, 1); assert.match(r.out, /handover missing section/);
    gitq(fx.brain, 'reset', '-q');
    stage('INDEX.md', '# INDEX\n');
    r = commit();
    assert.doesNotMatch(r.out, /INDEX\.md: path must be english/, r.out);
  } finally { fx.cleanup(); }
});

test('brain-init without --layout makes a brain of layout 3 from templates/brain-3', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-l3-init-'));
  try {
    const brain = path.join(root, 'b');
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brain], { env: cleanEnv({}), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // Mail model 3: a new brain has its own random brain_id (scripts/brain-id.mjs).
    const { brain_id: id, ...policy } = JSON.parse(fs.readFileSync(path.join(brain, 'policy.json'), 'utf8'));
    assert.deepEqual(policy, { data_layout: '2.1' });
    assert.match(id, /^[0-9a-f]{12}$/);
    for (const d of ['topics', 'memory', 'decisions', 'rules', 'skills/agentic', 'exceptions', 'logs']) assert.ok(fs.existsSync(path.join(brain, d)), d);
    for (const d of ['.brain', 'vystupy', 'zdroje', 'temy']) assert.ok(!fs.existsSync(path.join(brain, d)), d);
    assert.match(fs.readFileSync(path.join(brain, '.gitignore'), 'utf8'), /^topics\/\*\/tmp\/$/m);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session start and save refuse a project repo whose layout does not fit its brain of data 2.1: pull first', () => {
  const fx = setup3({ thread: 'l3d', projectLayout: 2 });
  try {
    const h = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(h.context, /STOP, work refused: data of repo .*project is 2\.0, the brain of its domain .*brain has 2\.1/);
    assert.match(h.context, new RegExp(`git -C ${fx.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} pull`));
    assert.doesNotMatch(h.context, /Dáta tohto repa/);
    const r = fx.run('save.mjs', ['memory', 'project', 'site', '--content', 'Web beží na serveri x.']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /save\.mjs refused, nothing written: data of repo/);
    assert.ok(!fx.exists('memory/project-site.md'));
  } finally { fx.cleanup(); }
});
