// ttl: 2026-12-14
// migrate.mjs triage by the classes of done --topic (D-0059, D-0060): dokument, zdroj, stav, pomocne, @brain; a duplicate
// in the brain is removed from the project repo; pomocne outside git is deleted only from the confirmed list; the check
// lists references to the changed paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';
import { dataLayoutVersion } from '../scripts/layout.mjs';

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

test('project repo: classes as targets, duplicate in the brain removed, pomocne outside git only when confirmed, references listed', () => {
  const fx = setup2({ thread: 'mc1' });
  try {
    const prj = fx.project;
    commitFiles(fx.brain, { 'temy/pilot/analyza.md': '# Analýza\n', 'temy/kopia/x.md': 'brain\n' });
    commitFiles(prj, {
      'materialy/pilot/analyza.md': '# Analýza\n',
      'materialy/pilot/plan.md': '# Plán\n',
      'materialy/kopia/x.md': 'projekt\n',
      'materialy/log.txt': 'log\n',
      'materialy/zz.md': 'zz\n',
      'docs/guide.md': '# Návod\n',
      'README.md': `hello\nplán v materialy/pilot/plan.md\nnávod ${prj}/docs/guide.md\n`,
    });
    fs.mkdirSync(path.join(prj, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(prj, 'scratch', 'tmp.md'), 't\n');
    fs.appendFileSync(path.join(prj, '.git', 'info', 'exclude'), 'scratch/\n');
    const tsv = path.join(fx.root, 'triage.tsv');
    fs.writeFileSync(tsv, [
      'cesta\tnavrh\ttema\tdovod',
      'materialy/pilot/\tstav\tpilot\tpráca témy',
      'materialy/kopia/\tstav\tkopia\tpráca témy',
      'materialy/log.txt\tpomocne\t\tlog',
      'materialy/zz.md\ttemy\tpilot\tstarý návrh',
      'docs/guide.md\tdokument\t\tnávod',
      'scratch/\tpomocne\t\tpracovné',
    ].join('\n') + '\n');
    // Proposals only (not confirmed): nothing is deleted, nothing moves.
    const p = fx.run('migrate.mjs', [prj, '--triage', tsv]);
    assert.equal(p.status, 0, p.out);
    assert.ok(fs.existsSync(path.join(prj, 'scratch', 'tmp.md')));
    assert.doesNotMatch(p.stdout, /deleted/);
    const a = fx.run('migrate.mjs', [prj, '--apply', '--confirmed', tsv]);
    assert.equal(dataLayoutVersion(prj), 2, a.out);
    const out = a.stdout;
    assert.match(out, /materialy\/pilot\/analyza\.md: duplicita brainu brain:temy\/pilot\/analyza\.md/);
    assert.match(out, /materialy\/pilot\/plan\.md -> brain:temy\/pilot\/plan\.md \(triage, confirmed, into the brain\)/);
    assert.match(out, /materialy\/kopia\/\tstav\tkopia\t.*stays \(target temy\/kopia\/x\.md exists in brain brain with another content\)/);
    assert.match(out, /materialy\/zz\.md\ttemy\t.*stays \(navrh temy is not valid; valid navrh: dokument/);
    assert.match(out, /docs\/guide\.md -> vystupy\/dokumenty\/guide\.md \(triage, confirmed\)/);
    assert.match(out, /materialy\/log\.txt -> removed \(triage, confirmed, pomocne: git rm in the move commit\)/);
    assert.match(out, /^deleted \(pomocne, outside git, confirmed; git does not restore it\): scratch\/tmp\.md$/m);
    assert.match(out, /README\.md:2: materialy\/pilot\/plan\.md -> brain:temy\/pilot\/plan\.md/);
    assert.match(out, /README\.md:3: absolute docs\/guide\.md -> vystupy\/dokumenty\/guide\.md/);
    assert.ok(!fs.existsSync(path.join(prj, 'scratch', 'tmp.md')));
    const tracked = gitq(prj, 'ls-files').split('\n');
    for (const gone of ['materialy/pilot/analyza.md', 'materialy/pilot/plan.md', 'materialy/log.txt', 'docs/guide.md']) assert.ok(!tracked.includes(gone), gone);
    assert.ok(tracked.includes('materialy/kopia/x.md') && tracked.includes('materialy/zz.md') && tracked.includes('vystupy/dokumenty/guide.md'));
    assert.equal(gitq(prj, 'show', 'HEAD~1:materialy/log.txt'), 'log', 'git restores a removed pomocne file');
    assert.equal(fx.read('temy/pilot/plan.md'), '# Plán\n');
    assert.match(fx.read('README.md', prj), /materialy\/pilot\/plan\.md/, 'references are not rewritten');
  } finally { fx.cleanup(); }
});
