// keep: guarded
// The test budget (P-079, operator 2026-11-22: tests piled up for the x-th time, the class of a test was its author's
// word): the lasting tests that fit stay, a temporary one lives at most 30 days after its first commit, the newest
// temporary ones that fit stay. The plan removes files of a repo and of a domain skill: a wrong plan deletes the wrong ones.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { plan, commitDays } from '../scripts/test-header.mjs';

const t = (file, head, lines, added, more = {}) => ({ file, text: `${head}\n${'x\n'.repeat(lines - 1)}`, added, ...more });

test('plan: lasting room goes to core, then guarded, the oldest first; the rest is temporary and the newest that fit stay', () => {
  const tests = [
    t('g-old', '// keep: guarded', 40, '2026-11-01'),
    t('core-new', '// keep: core', 40, '2026-11-20'),
    t('g-new', '// keep: guarded', 40, '2026-11-10'),
    t('long', '// ttl: 2027-05-18', 10, '2026-10-01'),
    t('t-old', '// ttl: 2026-12-30', 30, '2026-11-15'),
    t('t-new', '// ttl: 2026-12-30', 30, '2026-11-21'),
    t('named', '// ttl: 2026-01-01', 20, '2025-12-01', { pinned: true }),
    t('saved', '// ttl: 2026-12-30', 30, undefined, { fresh: true }),
    t('none', "import 'node:test';", 5, '2026-11-01', { changed: '2026-11-10' }),
  ];
  const p = plan(tests, { keepLines: 100, tempLines: 70 }, { day: '2026-11-22' });
  const of = (f) => p.rows.find((r) => r.file === f);
  assert.deepEqual(p.rows.filter((r) => r.lasting).map((r) => r.file).sort(), ['core-new', 'g-old', 'named'], 'a named test and the core take room before an older guarded one');
  assert.equal(of('g-new').demoted, true, 'a keep test without room is temporary');
  assert.equal(of('long').expires, '2026-10-31', 'a ttl later than 30 days after the first commit does not count');
  assert.deepEqual(Object.fromEntries(p.rows.filter((r) => r.gone).map((r) => [r.file, r.gone])), { long: 'expired', none: 'expired', 't-old': 'budget', 'g-new': 'budget' });
  assert.equal(of('saved').gone, undefined, 'a file of this save is counted, not removed');
  assert.deepEqual([p.keepUsed, p.tempUsed], [100, 60]);
  // a repo refuses a test without a header, it does not rotate it
  assert.equal(plan(tests, { keepLines: 100, tempLines: 70 }, { day: '2026-11-22', untaggedDays: null }).rows.find((r) => r.file === 'none').gone, undefined);
});

test('commitDays: a rename does not renew a test; a file added again after its removal is a new file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-budget-'));
  const git = (day, ...a) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z` };
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  };
  const commit = (day) => { git(day, 'add', '-A'); git(day, 'commit', '-qm', day); };
  try {
    git('2026-10-01', 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), '// ttl: 2026-10-31\nconst a = 1;\n');
    fs.writeFileSync(path.join(dir, 'c.test.mjs'), '// ttl: 2026-10-31\nconst c = 1;\n');
    commit('2026-10-01');
    fs.renameSync(path.join(dir, 'a.test.mjs'), path.join(dir, 'b.test.mjs'));
    fs.rmSync(path.join(dir, 'c.test.mjs'));
    commit('2026-11-01');
    fs.writeFileSync(path.join(dir, 'c.test.mjs'), '// ttl: 2026-12-20\nconst other = 2;\n');
    commit('2026-11-20');
    const { added, changed } = commitDays(dir);
    assert.deepEqual([added['b.test.mjs'], changed['b.test.mjs'], added['c.test.mjs']], ['2026-10-01', '2026-11-01', '2026-11-20']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
