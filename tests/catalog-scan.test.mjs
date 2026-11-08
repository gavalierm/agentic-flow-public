// Catalog (MVP): configuration, scan, changes, duplicates, budgets, lock, unavailable source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { catalogFixture } from './catalog-helpers.mjs';
import { catalogConfig } from '../scripts/catalog/config.mjs';
import { scanAll } from '../scripts/catalog/scan.mjs';

test('without a source the catalog is off: nothing is created, the CLI says how to enable it, boot has no catalog line', () => {
  const fx = setup({ remote: false });
  try {
    assert.equal(catalogConfig(fx.project).enabled, false);
    const r = fx.run('catalog.mjs', ['scan']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /katalóg je vypnutý/);
    assert.equal(fs.existsSync(path.join(fx.project, 'local', 'catalog')), false);
    const boot = fx.hook('session-start.mjs', { source: 'startup' });
    assert.doesNotMatch(boot.context, /katalóg/);
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), '{"catalog":{"sources":{"bad name":{"path":"/x"},"nopath":{}}}}');
    assert.equal(catalogConfig(fx.project).enabled, false, 'invalid sources do not enable it');
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), '{broken');
    assert.equal(catalogConfig(fx.project).enabled, false, 'a broken file never throws');
  } finally { fx.cleanup(); }
});

test('scan indexes files with kind, size, hash; ignores globs and node_modules; adds local/catalog/ to .gitignore', () => {
  const fx = catalogFixture({ extra: { ignore: ['**/skip/**', '**/node_modules/**'] } });
  try {
    fx.write('skip/x.csv', 'a\n1\n');
    fx.write('node_modules/m.js', 'x');
    fs.symlinkSync(path.join(fx.data, 'notes', 'readme.txt'), path.join(fx.data, 'link.txt'));
    const res = scanAll(fx.cfg());
    assert.equal(res.errors.length, 0);
    const rows = fx.indexRows();
    assert.deepEqual(rows.map((r) => r.path), ['export/objednavky.csv', 'link.txt', 'notes/readme.txt']);
    const csv = rows.find((r) => r.path === 'export/objednavky.csv');
    assert.equal(csv.kind, 'csv');
    assert.equal(csv.status, 'pending');
    assert.match(csv.hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(csv.size, fs.statSync(path.join(fx.data, 'export', 'objednavky.csv')).size);
    assert.equal(rows.find((r) => r.path === 'link.txt').kind, 'symlink', 'a symlink is not followed');
    assert.match(fs.readFileSync(path.join(fx.project, '.gitignore'), 'utf8'), /^local\/catalog\/$/m);
    assert.equal(fx.git(fx.project, 'status', '--porcelain', '--', 'local/catalog').trim(), '', 'nothing of the catalog is visible to git');
    const names = fs.readdirSync(path.join(fx.project, 'local', 'catalog', 'index'));
    assert.deepEqual(names, ['data.jsonl'], 'no temporary files after an atomic write');
    // a second scan changes nothing
    const again = scanAll(fx.cfg());
    assert.deepEqual([again.sources[0].new, again.sources[0].changed, again.sources[0].moved, again.sources[0].removed], [0, 0, 0, 0]);
    assert.equal((fs.readFileSync(path.join(fx.project, '.gitignore'), 'utf8').match(/local\/catalog\//g) || []).length, 1);
  } finally { fx.cleanup(); }
});

test('changes: modified file is rehashed, renamed file keeps its identity as moved_from, deleted file disappears, new file appears', () => {
  const fx = catalogFixture();
  try {
    scanAll(fx.cfg());
    const before = fx.indexRows().find((r) => r.path === 'notes/readme.txt');
    fx.write('export/objednavky.csv', 'id;zakaznik\n1;Acme\n');
    fs.renameSync(path.join(fx.data, 'notes', 'readme.txt'), path.join(fx.data, 'notes', 'precitaj.txt'));
    fx.write('new.txt', 'novy\n');
    const res = scanAll(fx.cfg()).sources[0];
    assert.equal(res.new, 1);
    assert.equal(res.changed, 1);
    assert.equal(res.moved, 1);
    const rows = fx.indexRows();
    const moved = rows.find((r) => r.path === 'notes/precitaj.txt');
    assert.equal(moved.moved_from, 'notes/readme.txt');
    assert.equal(moved.hash, before.hash);
    assert.equal(rows.some((r) => r.path === 'notes/readme.txt'), false);
    assert.ok(rows.find((r) => r.path === 'new.txt'));
    const csv = rows.find((r) => r.path === 'export/objednavky.csv');
    assert.notEqual(csv.hash, before.hash);
    fs.rmSync(path.join(fx.data, 'new.txt'));
    assert.equal(scanAll(fx.cfg()).sources[0].removed, 1);
    assert.equal(fx.indexRows().some((r) => r.path === 'new.txt'), false);
  } finally { fx.cleanup(); }
});

test('duplicates by content hash: the later path is marked duplicate of the first; removing the copy restores the original', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('a/doc.txt', 'rovnaky obsah\n');
    fx.write('b/doc-kopia.txt', 'rovnaky obsah\n');
    fx.write('c/ina.txt', 'iny obsah\n');
    scanAll(fx.cfg());
    let rows = fx.indexRows();
    const copy = rows.find((r) => r.path === 'b/doc-kopia.txt');
    assert.equal(copy.status, 'duplicate');
    assert.equal(copy.dup_of, 'a/doc.txt');
    assert.notEqual(rows.find((r) => r.path === 'a/doc.txt').status, 'duplicate');
    scanAll(fx.cfg());
    assert.equal(fx.indexRows().find((r) => r.path === 'b/doc-kopia.txt').status, 'duplicate', 'idempotent');
    fs.rmSync(path.join(fx.data, 'b', 'doc-kopia.txt'));
    scanAll(fx.cfg());
    rows = fx.indexRows();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status !== 'duplicate'));
  } finally { fx.cleanup(); }
});

test('hash budget: a scan over budget still hashes at least one file and the next scans finish the rest', () => {
  const fx = catalogFixture({ files: false, extra: { scan: { hash_budget_ms: 0 } } });
  try {
    for (let i = 0; i < 6; i++) fx.write(`f${i}.txt`, `obsah ${i}\n`);
    const pending = [];
    for (let i = 0; i < 10; i++) {
      const s = scanAll(fx.cfg()).sources[0];
      assert.equal(s.total, 6, 'every file is listed even before it is hashed');
      pending.push(s.hash_pending);
      if (!s.hash_pending) break;
    }
    assert.ok(pending[0] < 6, `at least one hash per scan: ${pending}`);
    assert.equal(pending.at(-1), 0, `converges: ${pending}`);
    assert.ok(fx.indexRows().every((r) => /^sha256:/.test(r.hash)));
  } finally { fx.cleanup(); }
});

test('unavailable or emptied source keeps the index; a busy lock skips the scan without error', () => {
  const fx = catalogFixture();
  try {
    scanAll(fx.cfg());
    const before = fx.indexRows();
    const moved = `${fx.data}-offline`;
    fs.renameSync(fx.data, moved);
    const off = scanAll(fx.cfg());
    assert.equal(off.sources[0].available, false);
    assert.deepEqual(fx.indexRows(), before, 'a missing disk does not delete the index');
    fs.mkdirSync(fx.data);
    const empty = scanAll(fx.cfg());
    assert.equal(empty.sources[0].available, false, 'an empty directory looks like an unmounted disk');
    assert.deepEqual(fx.indexRows(), before);
    fs.rmSync(fx.data, { recursive: true });
    fs.renameSync(moved, fx.data);
    assert.equal(scanAll(fx.cfg()).sources[0].available, true);
    fs.mkdirSync(path.join(fx.project, 'local', 'catalog', '.lock'));
    const busy = scanAll(fx.cfg(), { waitMs: 0 });
    assert.equal(busy.skipped_busy, true);
    assert.deepEqual(busy.errors, []);
  } finally { fx.cleanup(); }
});

test('catalog.mjs scan and status through the CLI write the overview', () => {
  const fx = catalogFixture();
  try {
    let r = fx.catalog(['scan']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /data: 2 súborov \(csv 1, text 1\); nové 2/);
    r = fx.catalog(['status']);
    assert.match(r.stdout, /data \(ro\) .*: 2 súborov/);
    r = fx.catalog(['status', '--json']);
    assert.equal(JSON.parse(r.stdout).sources[0].indexed, 2);
    assert.ok(fs.existsSync(path.join(fx.project, 'local', 'catalog', 'human', 'INDEX.md')));
    assert.equal(fx.catalog(['bogus']).status, 1);
  } finally { fx.cleanup(); }
});
