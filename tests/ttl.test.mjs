// keep: core
// Test headers (D-0061, D-0062): every test file is a core test or carries its ttl; expire removes the expired ones
// with git rm in a commit of their own.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, header, survey, expire } from './ttl.mjs';

test('every test file of the repo has "// keep: core" or "// ttl: YYYY-MM-DD" in its first lines', () => {
  const bad = survey(ROOT).filter((t) => t.error);
  assert.deepEqual(bad.map((t) => `${t.file}: ${t.error}`), []);
});

test('header: keep, ttl, and a clear message for a missing, double or invalid header', () => {
  assert.deepEqual(header('// keep: core\nimport x;\n'), { keep: true });
  assert.deepEqual(header('// keep: guarded\nimport x;\n'), { guarded: true });
  assert.deepEqual(header('// what it tests\n// ttl: 2026-12-14\n'), { ttl: '2026-12-14' });
  assert.match(header('// a test\nimport x;\n').error, /add "\/\/ keep: core".*"\/\/ ttl: YYYY-MM-DD"/);
  assert.match(header('// keep: core\n// ttl: 2026-12-14\n').error, /both/);
  assert.match(header('// ttl: 2026-02-30\n').error, /not a valid date/);
  assert.match(header('\n\n\n\n\n// keep: core\n').error, /no header/);
});

test('expire: git rm of the expired tests in one commit listing them; core and live tests stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-ttl-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env });
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'tests', 'sub'), { recursive: true });
    const files = { 'tests/core.test.mjs': '// keep: core\n', 'tests/old.test.mjs': '// ttl: 2026-11-01\n', 'tests/sub/old2.test.mjs': '// ttl: 2026-11-13\n', 'tests/live.test.mjs': '// ttl: 2026-11-14\n' };
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    git('add', '-A'); git('commit', '-qm', 'init');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    assert.deepEqual(expire(dir, { day: '2026-11-14', dry: true }).map((t) => t.file), ['tests/old.test.mjs', 'tests/sub/old2.test.mjs']);
    assert.equal(git('rev-parse', 'HEAD').stdout.trim(), head, 'dry run commits nothing');
    Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
    expire(dir, { day: '2026-11-14' });
    assert.deepEqual(git('ls-files').stdout.trim().split('\n'), ['tests/core.test.mjs', 'tests/live.test.mjs']);
    const msg = git('log', '-1', '--format=%B').stdout;
    assert.match(msg, /remove 2 test file\(s\) past their ttl/);
    assert.match(msg, /tests\/old\.test\.mjs \(ttl 2026-11-01\)\ntests\/sub\/old2\.test\.mjs \(ttl 2026-11-13\)/);
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '2', 'one commit of its own');
    assert.deepEqual(expire(dir, { day: '2026-11-14' }), [], 'nothing left to expire');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
