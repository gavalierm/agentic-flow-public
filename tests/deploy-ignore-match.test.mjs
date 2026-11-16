// keep: core
// What a deploy ignore file excludes (gitignore order, the last matching rule wins) and when wrangler deploys the root:
// nothing of the workflow may be deployed (operator 2026-11-16), outside git neither (local/, topics/<t>/tmp/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ignoredBy, deploysRoot, internalEntries, deployIgnoreGaps } from '../scripts/data-index.mjs';
import { LAYOUTS, layoutFor, ROLE_REPO } from '../scripts/layout.mjs';

test('ignoredBy: plain, anchored, folder, glob, allowlist and a path taken back inside', () => {
  assert.equal(ignoredBy('docs\n/vystupy/\n', 'vystupy'), true);
  assert.equal(ignoredBy('.brain/\n', '.brain'), true);
  assert.equal(ignoredBy('*\n!index.html\n', 'zdroje'), true);
  assert.equal(ignoredBy('*\n!zdroje\n', 'zdroje'), false, 'an allowlist that takes it back');
  assert.equal(ignoredBy('*\n!zdroje\nzdroje/\n', 'zdroje'), true, 'the last rule wins');
  assert.equal(ignoredBy('zdroje\n!zdroje/public\n', 'zdroje'), false, 'a path inside taken back');
  assert.equal(ignoredBy('**/tmp\n', 'topics'), false);
  assert.equal(ignoredBy('# zdroje\n', 'zdroje'), false, 'a comment');
  assert.equal(ignoredBy('INDEX.*\n', 'INDEX.md'), true);
});

test('internalEntries: every workflow path of the map, present or not', () => {
  assert.deepEqual(internalEntries(null, layoutFor(3, ROLE_REPO)).sort(), ['.brain', '.claude', '.workflow.json', 'INDEX.md', 'local', 'topics', 'vystupy', 'zdroje'].sort());
  assert.ok(internalEntries(null, LAYOUTS[2]).includes('temy'));
});

test('deploysRoot: wrangler jsonc and toml with the root as assets folder; a subfolder does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
  try {
    fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "x"\n[assets]\ndirectory = "./public"\n');
    assert.equal(deploysRoot(dir), null);
    fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "x"\n[assets]\ndirectory = "."\n');
    assert.equal(deploysRoot(dir), 'wrangler.toml');
    // No .assetsignore: one is needed, with every workflow path.
    const gaps = deployIgnoreGaps(dir, { map: layoutFor(3, ROLE_REPO) });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].file, '.assetsignore');
    assert.equal(gaps[0].created, 'wrangler.toml');
    assert.ok(gaps[0].missing.includes('local') && gaps[0].missing.includes('.brain'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
