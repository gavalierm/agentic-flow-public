// ttl: 2026-12-14
// The triage TSV took only the items of the plan: a part of scratch/ (scratch/clone/) with its own navrh was ignored, so
// the pilot cleaned scratch/ by hand. A row for a part of a folder item is an item of its own; migrate.mjs without
// arguments prints the usage with the TSV format and the values of navrh (the agent looked for them in the source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
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

test('a TSV row for a part of scratch/ gets its own navrh; the rest of scratch/ stays', () => {
  const fx = setup2({ thread: 'ms1' });
  try {
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, { '.gitignore': 'scratch/\n', 'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n' });
    for (const [rel, text] of Object.entries({ 'scratch/clone/a.txt': 'a\n', 'scratch/clone/sub/b.txt': 'b\n', 'scratch/audit/data.csv': 'x\n', 'scratch/notes.txt': 'n\n' })) {
      fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true });
      fs.writeFileSync(path.join(web, rel), text);
    }
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\nscratch/clone/\tpomocne\t\tclone\nscratch/audit/\tzdroj\tseo\taudit\n');
    const p = fx.run('migrate.mjs', [web, '--confirmed', tsv]);
    assert.equal(p.status, 0, p.out);
    assert.match(p.stdout, /scratch\/clone\/\tpomocne\t.*-> removed \(pomocne\) \(2 file\(s\)\)/, p.out);
    assert.match(p.stdout, /scratch\/audit\/\tzdroj\tseo\t.*-> zdroje\/seo\/audit\/ \(1 file\(s\)\)/);
    assert.match(p.stdout, /scratch\/\ttemy\/main\/tmp\/\t.*stays \(1 file\(s\)\)/);
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    // scratch/notes.txt was not confirmed: it stays and the check names it.
    assert.equal(a.status, 1, a.out);
    assert.match(a.out, /scratch\/notes\.txt \(1 file\(s\)/);
    assert.ok(!fs.existsSync(path.join(web, 'scratch', 'clone', 'a.txt')) && !fs.existsSync(path.join(web, 'scratch', 'clone', 'sub', 'b.txt')), a.out);
    assert.ok(fs.existsSync(path.join(web, 'zdroje', 'seo', 'audit', 'data.csv')));
    assert.ok(fs.existsSync(path.join(web, 'scratch', 'notes.txt')));
    assert.equal(gitq(web, 'ls-files', 'scratch'), '');
  } finally { fx.cleanup(); }
});

test('migrate.mjs without arguments prints the TSV format and the values of navrh, no preview', () => {
  const fx = setup2({ thread: 'ms2' });
  try {
    const r = fx.run('migrate.mjs', []);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /cesta <TAB> navrh <TAB> tema <TAB> dovod/);
    assert.match(r.stdout, /dokument@brain/);
    assert.match(r.stdout, /pomocne/);
    assert.doesNotMatch(r.stdout, /repository: /);
  } finally { fx.cleanup(); }
});
