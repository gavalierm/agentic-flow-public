// ttl: 2026-12-15
// A temporary test runs only when the code it guards changes (agent-alice/D-0085): npm test -- --since <ref> runs the core
// tests always, a temporary test when its guarded file (outside tests/ and *.md of the commit that added it, or a direct
// relative import) or the test itself changed in <ref>..HEAD or uncommitted, and everything when tests/helpers.mjs changed.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectSince, guarded } from './ttl.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-scope-'));
  const git = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  const commit = (files, msg) => { for (const [f, t] of Object.entries(files)) write(f, t); git('add', '-A'); git('commit', '-qm', msg); };
  git('init', '-q');
  commit({ 'src/a.mjs': '1\n', 'src/b.mjs': '1\n', 'src/other.mjs': '1\n', 'tests/helpers.mjs': '\n', 'tests/core.test.mjs': '// keep: core\n' }, 'base');
  commit({ 'tests/a.test.mjs': '// ttl: 2026-12-15\n', 'src/a.mjs': '2\n', 'docs/a.md': 'x\n', 'tests/helpers.mjs': '//\n' }, 'fix a');
  // b is a lasting guarded test (keep: guarded): picked as a temporary one, never expires.
  commit({ 'tests/b.test.mjs': "// keep: guarded\nimport { x } from '../src/b.mjs';\n" }, 'test b');
  git('tag', 'base');
  return { dir, git, write, commit };
}

const picked = (dir) => selectSince(dir, 'base').picked;

test('guarded files: the add commit outside tests/ and *.md, plus direct relative imports', () => {
  const { dir } = fixture();
  try {
    const g = guarded(dir, ['tests/a.test.mjs', 'tests/b.test.mjs']);
    assert.deepEqual([...g.get('tests/a.test.mjs')], ['src/a.mjs']);
    assert.deepEqual([...g.get('tests/b.test.mjs')], ['src/b.mjs']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a change of a guarded file selects its test, committed or not; another file selects none; core runs always', () => {
  const { dir, write, commit } = fixture();
  try {
    assert.deepEqual(picked(dir), [], 'nothing changed');
    assert.deepEqual(selectSince(dir, 'base').files, ['tests/core.test.mjs'], 'core runs always');
    commit({ 'src/other.mjs': '2\n', 'docs/a.md': 'y\n' }, 'other');
    assert.deepEqual(picked(dir), [], 'a file no test guards selects none');
    write('src/a.mjs', '3\n');
    assert.deepEqual(picked(dir), ['tests/a.test.mjs'], 'uncommitted change of the add-commit file');
    commit({ 'src/b.mjs': '2\n' }, 'b');
    assert.deepEqual(picked(dir), ['tests/a.test.mjs', 'tests/b.test.mjs'], 'committed change of an imported file');
    const s = selectSince(dir, 'base');
    assert.deepEqual(s.files, ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/core.test.mjs']);
    assert.deepEqual(s.core, ['tests/core.test.mjs']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a changed or renamed test selects itself and keeps its guarded files; a change of tests/helpers.mjs selects all', () => {
  const { dir, git, write, commit } = fixture();
  try {
    write('tests/b.test.mjs', "// ttl: 2026-12-15\nimport { x } from '../src/b.mjs';\n// more\n");
    assert.deepEqual(picked(dir), ['tests/b.test.mjs']);
    git('checkout', '-q', '--', 'tests/b.test.mjs');
    git('mv', 'tests/a.test.mjs', 'tests/a2.test.mjs');
    commit({}, 'rename');
    git('tag', '-f', 'base');
    write('src/a.mjs', '9\n');
    assert.deepEqual(picked(dir), ['tests/a2.test.mjs'], 'the rename is followed to the add commit');
    git('checkout', '-q', '--', 'src/a.mjs');
    write('tests/helpers.mjs', '// changed\n');
    const s = selectSince(dir, 'base');
    assert.deepEqual(s.shared, ['tests/helpers.mjs']);
    assert.deepEqual(s.picked, ['tests/a2.test.mjs', 'tests/b.test.mjs']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
