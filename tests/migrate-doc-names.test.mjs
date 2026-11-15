// ttl: 2026-12-15
// The move of a project repo (layout 1 -> 2) refused --apply for a document with capitals in its name when the move
// rewrote a reference in it ("path must be english lowercase without spaces (P-049)"). P-049 names the records the
// workflow names itself; documents and outside material keep any name; a record of the brain is checked as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2 } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';
import { checkBrainFile } from '../scripts/brain-checks.mjs';

function commitFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '--no-verify', '-m', `${BRAIN_COMMIT_TAG} fixture`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

test('project repo move: a document with capitals whose reference the move rewrites is not refused by P-049', () => {
  const fx = setup2({ thread: 'dn1' });
  try {
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, {
      'docs/x/KONTROLA.md': '# Kontrola\nPozri docs/x/plan.md.\n',
      'docs/x/plan.md': '# Plan\n',
    });
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/x/KONTROLA.md\tdokument\t\t\ndocs/x/plan.md\tdokument\t\t\n');
    const r = fx.run('migrate.mjs', [web, '--confirmed', tsv]);
    assert.ok(r.stdout.includes('docs/x/KONTROLA.md'), r.out);
    assert.doesNotMatch(r.out, /content checks refuse/);
    assert.doesNotMatch(r.out, /P-049/);
  } finally { fx.cleanup(); }
});

test('P-049 path check: documents and sources keep any name, records of the brain are checked', () => {
  const p049 = (rel, version) => checkBrainFile(rel, null, { version }).filter((e) => e.includes('(P-049)'));
  assert.deepEqual(p049('vystupy/dokumenty/x/KONTROLA.md', 2), []);
  assert.deepEqual(p049('zdroje/x/Manual A.pdf', 2), []);
  assert.deepEqual(p049('docs/BRANA.md', 1), []);
  assert.equal(p049('.brain/memory/Operator.md', 2).length, 1);
  assert.equal(p049('temy/x/ODPOVEDE.md', 2).length, 1);
  assert.equal(p049('vystupy/rozhodnutia/D-interne.md', 2).length, 1);
});
