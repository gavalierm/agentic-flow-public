// ttl: 2026-12-15
// The move 1 -> 2 left scratch/ (outside git) beside an empty temy/main/tmp/ (report-42a2a5ae): scratch/ was a triage
// item `bez navrhu`, so the TSV of the preview had nothing to confirm and the apply said nothing about it. The preview
// proposes temy/main/tmp/ for scratch/, a confirmed row moves it there, and an apply that leaves it says so in a note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2 } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

function commitFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `${BRAIN_COMMIT_TAG} fixture`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

function project(fx, name) {
  const web = path.join(fx.root, name);
  initProject(web);
  commitFiles(web, { '.gitignore': 'scratch/\n', 'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n' });
  for (const [rel, text] of Object.entries({ 'scratch/notes.txt': 'n\n', 'scratch/run/out.log': 'o\n' })) {
    fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true });
    fs.writeFileSync(path.join(web, rel), text);
  }
  return web;
}

test('the preview proposes temy/main/tmp/ for scratch/ and a confirmed triage TSV moves it there', () => {
  const fx = setup2({ thread: 'st1' });
  try {
    const web = project(fx, 'web');
    const tsv = path.join(fx.root, 'triage.tsv');
    const p = fx.run('migrate.mjs', [web, '--write-triage', tsv]);
    assert.equal(p.status, 0, p.out);
    assert.match(fs.readFileSync(tsv, 'utf8'), /^scratch\/\ttemy\/main\/tmp\/\t/m);
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.equal(a.status, 0, a.out);
    assert.ok(!fs.existsSync(path.join(web, 'scratch')), a.out);
    assert.equal(fs.readFileSync(path.join(web, 'temy', 'main', 'tmp', 'notes.txt'), 'utf8'), 'n\n');
    assert.ok(fs.existsSync(path.join(web, 'temy', 'main', 'tmp', 'run', 'out.log')));
    assert.doesNotMatch(a.stdout, /note: scratch\/ stays/);
  } finally { fx.cleanup(); }
});

test('an apply without a confirmed row for scratch/ leaves it and says so', () => {
  const fx = setup2({ thread: 'st2' });
  try {
    const web = project(fx, 'web2');
    const a = fx.run('migrate.mjs', [web, '--apply']);
    assert.equal(a.status, 0, a.out);
    assert.ok(fs.existsSync(path.join(web, 'scratch', 'notes.txt')));
    assert.match(a.stdout, /note: scratch\/ stays \(outside git, not confirmed\).*temy\/main\/tmp\//);
  } finally { fx.cleanup(); }
});
