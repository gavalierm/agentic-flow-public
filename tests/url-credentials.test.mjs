// keep: guarded
// A remote address is printed without its credentials: the origin of a nested clone in the migrate preview (observed
// 2026-11-14: https://x-access-token:<token>@github.com/... in the output) and the origin of a repository in the project
// listing show https://***@host/...; an address without credentials stays unchanged.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nestedState } from '../scripts/migrate.mjs';
import { probeLocal } from '../scripts/project.mjs';

// Made-up token, built from pieces like the scan tests: no real credential in the test.
const TOKEN = 'ghp_' + 'A1b2'.repeat(9);
const AT = '@';
const SECRET_URL = `https://x-access-token:${TOKEN}${AT}github.com/owner/repo.git`;

function repoWithOrigin(url) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'url-cred-'));
  const dir = path.join(root, 'demo-repo');
  fs.mkdirSync(dir);
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', url]]) spawnSync('git', args, { cwd: dir });
  return { root, dir };
}

test('nested clone origin with a token prints as https://***@host', () => {
  const { root, dir } = repoWithOrigin(SECRET_URL);
  try {
    const state = nestedState(dir);
    assert.ok(!state.includes(TOKEN), state);
    assert.ok(state.includes(`origin https://***${AT}github.com/owner/repo.git,`), state);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project listing shows origin without credentials', () => {
  const { root } = repoWithOrigin(SECRET_URL);
  try {
    const [entry] = probeLocal(root, 'demo');
    assert.equal(entry.remote, `https://***${AT}github.com/owner/repo.git`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('redactUrl hides user:password and an https user, keeps addresses without credentials', async () => {
  const { redactUrl } = await import('../scripts/secrets.mjs');
  assert.equal(redactUrl(SECRET_URL), `https://***${AT}github.com/owner/repo.git`);
  assert.equal(redactUrl(`https://${TOKEN}${AT}github.com/o/r`), `https://***${AT}github.com/o/r`);
  assert.equal(redactUrl(`fatal: unable to access 'http://u:p${AT}host/o/r/': x`), `fatal: unable to access 'http://***${AT}host/o/r/': x`);
  assert.equal(redactUrl(`ssh://u:pw${AT}host/o/r`), `ssh://***${AT}host/o/r`);
  for (const plain of ['https://github.com/o/r.git', `ssh://git${AT}github.com/o/r`, `git${AT}github.com:o/r.git`, '/srv/git/r.git', ''])
    assert.equal(redactUrl(plain), plain);
});
