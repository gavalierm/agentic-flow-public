// Catalog (MVP): find (catalog.mjs and the block in find.mjs), show, sql wrapper, overview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalogFixture, fakeTool } from './catalog-helpers.mjs';
import { checkSelect } from '../bin/catalog.mjs';

function ready(fx) {
  const r = fx.catalog(['scan']);
  assert.equal(r.status, 0, r.out);
  assert.equal(fx.catalog(['profile']).status, 0);
}

test('find: matches paths and profile text, only paths and one-line descriptions, never content', () => {
  const fx = catalogFixture();
  try {
    ready(fx);
    let r = fx.catalog(['find', 'objednavky']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^katalóg \(data\): 1 zhôd/m);
    assert.match(r.stdout, /data\/export\/objednavky\.csv \[csv, profiled\]: CSV, 3 riadkov, 5 stĺpcov/);
    assert.doesNotMatch(r.stdout, /Acme|acme\.example/, 'no cell values');
    r = fx.catalog(['find', 'zakaznik']);
    assert.match(r.stdout, /objednavky\.csv/, 'column names are searchable');
    assert.match(fx.catalog(['find', 'objedn']).stdout, /objednavky\.csv/, 'prefix match');
    assert.match(fx.catalog(['find', 'neexistuje']).stdout, /bez zhody/);
    assert.match(fx.catalog(['find', 'objednavky', '--kind', 'image']).stdout, /bez zhody/);
    assert.match(fx.catalog(['find', 'objednavky', '--source', 'iny']).stdout, /bez zhody/);
    const json = JSON.parse(fx.catalog(['find', 'objednavky', '--json']).stdout);
    assert.equal(json[0].path, 'export/objednavky.csv');
    // Pilot 2026-11-08: the words after a switch without a value were taken as its value (usage error).
    assert.match(fx.catalog(['find', '--all', 'objednavky']).stdout, /objednavky\.csv/, 'words after --all');
    assert.equal(JSON.parse(fx.catalog(['find', '--json', 'objednavky']).stdout)[0].path, 'export/objednavky.csv', 'words after --json');
    assert.match(fx.catalog(['find', '--all', '--kind', 'csv', 'objednavky']).stdout, /objednavky\.csv/, 'words after --kind <k>');
  } finally { fx.cleanup(); }
});

test('find: at most 20 lines, the rest goes to a file with --all; originals come before duplicates', () => {
  const fx = catalogFixture({ files: false });
  try {
    for (let i = 0; i < 30; i++) fx.write(`faktury/faktura-${String(i).padStart(2, '0')}.txt`, `obsah ${i}\n`);
    fx.write('kopie/faktura-kopia.txt', 'obsah 0\n');
    ready(fx);
    const r = fx.catalog(['find', 'faktura']);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1 + 20, 'header + 20 lines');
    assert.match(lines[0], /31 zhôd.*--all/);
    assert.ok(lines.every((l) => l.length <= 240));
    const all = fx.catalog(['find', 'faktura', '--all']);
    const file = /do (\S+\.txt)/.exec(all.stdout)?.[1];
    assert.ok(file && file.startsWith(path.join(fx.project, 'scratch')), all.stdout);
    const listed = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(listed.length, 31);
    assert.match(listed.at(-1), /faktura-kopia\.txt \[text, duplicate\]/, 'a duplicate is last');
  } finally { fx.cleanup(); }
});

test('bin/find.mjs adds the catalog block after the brain results; --json keeps the array without a catalog', () => {
  const fx = catalogFixture();
  try {
    ready(fx);
    let r = fx.run('find.mjs', ['objednavky']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^no match: objednavky\nkatalóg \(data\): 1 zhôd\ndata\/export\/objednavky\.csv/m);
    const j = JSON.parse(fx.run('find.mjs', ['objednavky', '--json']).stdout);
    assert.deepEqual(Object.keys(j).sort(), ['catalog', 'matches']);
    assert.equal(j.catalog.length, 1);
    fs.rmSync(path.join(fx.project, 'local', 'workflow.json'));
    r = fx.run('find.mjs', ['objednavky']);
    assert.equal(r.stdout.trim(), 'no match: objednavky');
    assert.ok(Array.isArray(JSON.parse(fx.run('find.mjs', ['objednavky', '--json']).stdout)));
  } finally { fx.cleanup(); }
});

test('show prints the whole row (also by a unique tail of the path); an ambiguous or unknown path is an error', () => {
  const fx = catalogFixture();
  try {
    fx.write('a/dup.txt', 'x1\n');
    fx.write('b/dup.txt', 'x2\n');
    ready(fx);
    const row = JSON.parse(fx.catalog(['show', 'data/export/objednavky.csv']).stdout);
    assert.equal(row.profile.columns[0].name, 'id');
    assert.equal(JSON.parse(fx.catalog(['show', 'objednavky.csv']).stdout).path, 'export/objednavky.csv');
    assert.equal(JSON.parse(fx.catalog(['show', path.join(fx.data, 'export', 'objednavky.csv')]).stdout).path, 'export/objednavky.csv', 'also an absolute path');
    const amb = fx.catalog(['show', 'dup.txt']);
    assert.notEqual(amb.status, 0);
    assert.match(amb.out, /nejednoznačné/);
    assert.match(fx.catalog(['show', 'data/nie-je.csv']).out, /v katalógu nie je/);
  } finally { fx.cleanup(); }
});

test('sql: only a read SELECT over table t; duckdb gets an argument array; without duckdb a hint with the delimiter', () => {
  assert.equal(checkSelect('select zakaznik, sum(suma) from t group by 1'), null);
  assert.equal(checkSelect("with x as (select 1) select * from x where a = 'drop;--'"), null, 'text in a string literal is data');
  for (const bad of ['', 'drop table t', 'select * from read_csv(\'/etc/passwd\')', 'select 1; select 2', 'select * from t -- x', "copy t to '/x'", 'select * from t where a = getenv(1)', "select * from 'https://x.example/a.csv'", 'select * from \"/etc/x.csv\"', 'pragma version']) {
    assert.ok(checkSelect(bad), `must be refused: ${bad}`);
  }
  const fx = catalogFixture();
  try {
    ready(fx);
    let r = fx.catalog(['sql', 'objednavky.csv', 'select count(*) from t']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /duckdb nie je v PATH.*awk -F';'/);
    const env = { PATH: fakeTool(path.join(fx.root, 'bin'), 'duckdb', 'for a in "$@"; do echo "[$a]"; done') };
    r = fx.catalog(['sql', 'objednavky.csv', 'select', 'count(*)', 'from t'], { env });
    assert.equal(r.status, 0, r.out);
    const args = r.stdout.trim().split('\n');
    assert.deepEqual(args.slice(0, 3), ['[:memory:]', '[-csv]', '[-c]']);
    assert.match(args[3], /^\[CREATE TABLE t AS SELECT \* FROM read_csv_auto\('.*objednavky\.csv', delim=';', header=true\); SET enable_external_access=false; select count\(\*\) from t\]$/);
    r = fx.catalog(['sql', 'objednavky.csv', "select * from read_csv('/etc/passwd')"], { env });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /zakázaný prvok/);
    assert.match(fx.catalog(['sql', 'readme.txt', 'select 1'], { env }).out, /iba pre CSV/);
  } finally { fx.cleanup(); }
});

test('overview: INDEX.md and by-folder.md with counts, duplicates, biggest files, recent changes; derived, local, not in git', () => {
  const fx = catalogFixture();
  try {
    fx.write('kopia/objednavky-kopia.csv', fs.readFileSync(path.join(fx.data, 'export', 'objednavky.csv')));
    ready(fx);
    const r = fx.catalog(['overview']);
    assert.equal(r.status, 0, r.out);
    const index = fs.readFileSync(path.join(fx.project, 'local', 'catalog', 'human', 'INDEX.md'), 'utf8');
    assert.match(index, /Súborov: 3/);
    assert.match(index, /Duplikáty \(1 skupín/);
    assert.match(index, /Najväčšie súbory/);
    assert.match(index, /Posledné zmeny/);
    assert.match(index, /objednavky-kopia\.csv/);
    const folders = fs.readFileSync(path.join(fx.project, 'local', 'catalog', 'human', 'by-folder.md'), 'utf8');
    assert.match(folders, /export/);
    assert.equal(fx.git(fx.project, 'status', '--porcelain', '--', 'local/catalog').trim(), '');
  } finally { fx.cleanup(); }
});
