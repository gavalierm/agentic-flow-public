// ttl: 2026-12-14
// materialy.mjs add took one file per call (one commit each: 42 commits in the pilot), --as only a bare name and the
// project only from the session. A folder is added in one commit under zdroje/<tema>/<name>/ with names normalized by the
// rule of names (mapping printed); --as takes a subpath; --project names the project repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup2, gitq } from './layout-2-helpers.mjs';

test('add <folder> --project: one commit, normalized names with mapping, sources.json for each file', () => {
  const fx = setup2({ thread: 'mf1', projectLayout: 2 });
  try {
    const src = path.join(fx.root, 'in', 'Audit SEO');
    fs.mkdirSync(path.join(src, 'Dáta'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Správa 1.txt'), 'a\n');
    fs.writeFileSync(path.join(src, 'Dáta', 'stránky.csv'), 'b\n');
    fs.writeFileSync(path.join(src, 'ok.txt'), 'c\n');
    const before = Number(gitq(fx.project, 'rev-list', '--count', 'HEAD'));
    const r = fx.run('materialy.mjs', ['add', src, '--topic', 'seo', '--project', fx.project, '--description', 'audit'], { cwd: fx.root });
    assert.equal(r.status, 0, r.out);
    assert.equal(Number(gitq(fx.project, 'rev-list', '--count', 'HEAD')), before + 1, 'one commit');
    for (const rel of ['zdroje/seo/audit-seo/sprava-1.txt', 'zdroje/seo/audit-seo/data/stranky.csv', 'zdroje/seo/audit-seo/ok.txt']) {
      assert.ok(fs.existsSync(path.join(fx.project, rel)), `${rel}\n${r.out}`);
    }
    assert.match(r.stdout, /Správa 1\.txt -> sprava-1\.txt/);
    assert.match(r.stdout, /Dáta\/stránky\.csv -> data\/stranky\.csv/);
    assert.doesNotMatch(r.stdout, /ok\.txt ->/);
    const sources = JSON.parse(fs.readFileSync(path.join(fx.project, '.brain', 'sources.json'), 'utf8'));
    assert.equal(sources['zdroje/seo/audit-seo/data/stranky.csv'].description, 'audit');
    assert.match(fs.readFileSync(path.join(fx.project, 'INDEX.md'), 'utf8'), /zdroje\/seo\/audit-seo\/ok\.txt/);
  } finally { fx.cleanup(); }
});

test('add <file> --as with a subpath; a bad subpath is refused', () => {
  const fx = setup2({ thread: 'mf2', projectLayout: 2 });
  try {
    const f = path.join(fx.root, 'report.txt');
    fs.writeFileSync(f, 'x\n');
    const r = fx.run('materialy.mjs', ['add', f, '--topic', 'seo', '--as', 'web/report.txt', '--project', fx.project], { cwd: fx.root });
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(fx.project, 'zdroje', 'seo', 'web', 'report.txt')), r.out);
    const bad = fx.run('materialy.mjs', ['add', f, '--topic', 'seo', '--as', '../x.txt', '--project', fx.project], { cwd: fx.root });
    assert.notEqual(bad.status, 0);
  } finally { fx.cleanup(); }
});
