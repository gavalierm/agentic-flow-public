// ttl: 2026-12-17
// flow-public#100: migrate refused the uncommitted tree for an untracked comms/ in the brain root without saying it is the
// mail client; the agent removed it and the mail stopped. The refusal names the client and the way that keeps it.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readyForMove } from '../scripts/migrate.mjs';

test('an untracked mail client in the tree: named, with .gitignore as the way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-mig100-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'comms', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'comms', 'bin', 'comms.mjs'), '');
    const r = readyForMove(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /comms\/ is the mail client \(bin\/comms\.mjs\), never remove it: add \/comms\/ to \.gitignore/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
