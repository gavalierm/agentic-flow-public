// keep: core
// Leftovers outside git after a move of the data (doma-pc 2026-11-16): junk (__pycache__, *.pyc, .DS_Store) is removed
// with the folders it leaves empty, tracked files and work are never touched; other files of an old folder are grouped per
// entry with size; docs/ of a project repo counts only its junk (a code repo may keep its own build output there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isJunk, leftovers, removeJunk, workFinding } from '../scripts/leftovers.mjs';
import { layoutFor } from '../scripts/layout.mjs';

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
const write = (dir, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test('isJunk: generated files only', () => {
  for (const p of ['a/__pycache__/x.pyc', 'b/tool.pyc', 'c/.DS_Store', 'Thumbs.db', 'd/.pytest_cache/v']) assert.ok(isJunk(p), p);
  for (const p of ['a/export.csv', 'notes.md', 'pycache.md', 'a/b.py']) assert.ok(!isJunk(p), p);
});

test('leftovers and removeJunk: tracked files stay, junk goes, work is reported per entry, docs/ of a repo only by junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-left-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'materialy/kept.md', 'tracked\n');
    write(dir, 'materialy/__pycache__/kept.cpython-312.pyc', 'tracked pyc');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'f');
    write(dir, 'materialy/audit/__pycache__/a.pyc');
    write(dir, 'materialy/audit/.DS_Store');
    write(dir, 'scratch/exports/a.csv', 'aaaa');
    write(dir, 'scratch/exports/b.csv', 'bb');
    write(dir, 'scratch/n.md', 'n');
    write(dir, 'docs/_build/index.html', 'built');
    write(dir, 'docs/x.pyc');
    const found = leftovers(dir, { version: 2, role: 'project' });
    assert.deepEqual(found.junk, ['docs/x.pyc', 'materialy/audit/.DS_Store', 'materialy/audit/__pycache__/']);
    assert.deepEqual(found.other.map((g) => [g.path, g.files, g.bytes]), [['scratch/exports/', 2, 6], ['scratch/n.md', 1, 1]]);
    const res = removeJunk(dir, { version: 2, role: 'project' });
    assert.deepEqual(res.pruned, ['materialy/audit/']);
    assert.ok(fs.existsSync(path.join(dir, 'materialy', '__pycache__', 'kept.cpython-312.pyc')), 'a tracked file is never removed');
    assert.ok(fs.existsSync(path.join(dir, 'docs', '_build', 'index.html')), 'docs/ of a repo: only its junk');
    assert.ok(fs.existsSync(path.join(dir, 'scratch', 'exports', 'a.csv')), 'work is never removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workFinding: over the limit with the largest folders and files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-left-'));
  try {
    write(dir, 'topics/main/tmp/big.csv', 'x'.repeat(3000));
    write(dir, 'topics/alpha/tmp/s.md', 'y');
    const map = layoutFor(3);
    assert.equal(workFinding(dir, map), null);
    const f = workFinding(dir, map, { limit: 1024 });
    assert.equal(f.files, 2);
    assert.match(f.text, /2 file\(s\), 2\.9 kB of work files outside git \(limit 1\.0 kB\): topics\/main\/tmp\/ 2\.9 kB, topics\/alpha\/tmp\/ 1 B; largest: topics\/main\/tmp\/big\.csv 2\.9 kB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
