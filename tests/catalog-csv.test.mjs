// Catalog (MVP): profiles without an LLM: CSV (stream, delimiter, encoding, types, PII, append-only), zip, image, pdf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalogFixture, png, zip, fakeTool } from './catalog-helpers.mjs';
import { scanAll } from '../scripts/catalog/scan.mjs';
import { profileAll } from '../scripts/catalog/profiles.mjs';
import { writeIndex } from '../scripts/catalog/index.mjs';
import { CsvParser, profileCsv } from '../scripts/catalog/profile-csv.mjs';

const cfgCsv = { sample_rows: 3, low_cardinality: 4, profile_max_mb: 100, partial_mb: 100, engine: 'auto', pii_columns: ['email', 'telefon', 'meno'] };

function profileOf(fx, rel) {
  scanAll(fx.cfg());
  profileAll(fx.cfg());
  return fx.indexRows().find((r) => r.path === rel);
}

test('CSV parser: quoted delimiters, doubled quotes, newlines inside quotes, CRLF, a record split over chunks', () => {
  const rows = [];
  const p = new CsvParser(';', (r) => rows.push(r));
  const text = 'a;"b;c";"d ""q"" e"\r\n"x\ny";2;3\r\n7;8;9';
  for (let i = 0; i < text.length; i += 5) p.feed(text.slice(i, i + 5));
  p.end();
  assert.deepEqual(rows, [['a', 'b;c', 'd "q" e'], ['x\ny', '2', '3'], ['7', '8', '9']]);
});

test('CSV profile: delimiter, header, types (decimal comma, ISO and dotted dates), min/max, nulls, low cardinality, PII masked', () => {
  const fx = catalogFixture({ files: false, extra: { csv: { low_cardinality: 4 } } });
  try {
    const lines = ['id;zakaznik;email;suma;datum;aktivny;poznamka'];
    for (let i = 1; i <= 8; i++) lines.push(`${i};Firma ${i};f${i}@klient.example;${i},5;${String(i).padStart(2, '0')}.03.2026;${i % 2 ? 'true' : 'false'};${i % 3 ? 'ok' : ''}`);
    fx.write('o.csv', lines.join('\n') + '\n');
    const row = profileOf(fx, 'o.csv');
    assert.equal(row.status, 'profiled');
    assert.equal(row.kind, 'csv');
    const p = row.profile;
    assert.equal(p.delimiter, ';');
    assert.equal(p.has_header, true);
    assert.equal(p.rows, 8);
    const by = Object.fromEntries(p.columns.map((c) => [c.name, c]));
    assert.equal(by.id.type, 'integer');
    assert.deepEqual([by.id.min, by.id.max], [1, 8]);
    assert.equal(by.suma.type, 'number');
    assert.deepEqual([by.suma.min, by.suma.max], [1.5, 8.5]);
    assert.equal(by.datum.type, 'date');
    assert.deepEqual([by.datum.min, by.datum.max], ['2026-03-01', '2026-03-08']);
    assert.equal(by.aktivny.type, 'boolean');
    assert.equal(by.poznamka.nulls, 2);
    assert.equal(by.zakaznik.distinct, '>4', 'above the low-cardinality limit only the marker stays');
    assert.equal(by.email.pii, true);
    assert.equal(by.email.values, '***');
    assert.ok(p.sample.length <= 5);
    assert.ok(p.sample.every((s) => !s.some((v) => /klient\.example/.test(v))), 'PII cells of the sample are masked');
    assert.match(row.desc, /8 riadkov/);
    assert.match(row.desc, /id, zakaznik/);
    assert.equal(row.described_by, 'profile');
  } finally { fx.cleanup(); }
});

test('CSV profile: other delimiters, a file without a header, cp1250 encoding, ragged rows counted', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('tab.tsv', 'a\tb\n1\t2\n3\t4\n');
    fx.write('pipe.csv', 'k|v\nx|1\ny|2\n');
    fx.write('nohead.csv', '1,2,3\n4,5,6\n7,8,9\n');
    // cp1250 bytes of "názov;žltý" written by hand (á=E1, ž=9E, ý=FD, č=E8, š=9A)
    fs.writeFileSync(path.join(fx.data, 'cp.csv'), Buffer.from([...Buffer.from('kod;n'), 0xe1, ...Buffer.from('zov\n1;'), 0x9e, ...Buffer.from('lt'), 0xfd, ...Buffer.from('\n2;'), 0xe8, ...Buffer.from('ere'), 0x9a, ...Buffer.from('a\n')]));
    fx.write('ragged.csv', 'a,b,c\n1,2,3\n4,5\n6,7,8,9\n');
    scanAll(fx.cfg());
    profileAll(fx.cfg());
    const rows = Object.fromEntries(fx.indexRows().map((r) => [r.path, r]));
    assert.equal(rows['tab.tsv'].profile.delimiter, '\t');
    assert.equal(rows['pipe.csv'].profile.delimiter, '|');
    assert.equal(rows['nohead.csv'].profile.has_header, false);
    assert.equal(rows['nohead.csv'].profile.rows, 3);
    assert.equal(rows['cp.csv'].profile.encoding, 'windows-1250');
    assert.deepEqual(rows['cp.csv'].profile.columns.map((c) => c.name), ['kod', 'názov']);
    assert.deepEqual(rows['cp.csv'].profile.columns[1].values, ['čereša', 'žltý'], 'cp1250 text is decoded');
    assert.ok(rows['ragged.csv'].profile.ragged_rows >= 1);
  } finally { fx.cleanup(); }
});

test('CSV append-only growth keeps an existing description; another header makes it stale (profile alone is simply recomputed)', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('log.csv', 'id;hodnota\n1;10\n2;20\n');
    const first = profileOf(fx, 'log.csv');
    assert.equal(first.profile.rows, 2);
    // a description written by a later stage (outside the MVP) must survive growth of the same table
    const rows = fx.indexRows().map((r) => ({ ...r, status: 'described', described_by: 'llm', desc: 'Merania' }));
    writeIndex(fx.cfg().dir, 'data', rows);
    fx.write('log.csv', 'id;hodnota\n1;10\n2;20\n3;30\n4;40\n');
    scanAll(fx.cfg());
    assert.equal(fx.indexRows()[0].status, 'stale', 'the scan marks the changed file stale');
    profileAll(fx.cfg());
    const grown = fx.indexRows()[0];
    assert.equal(grown.profile.rows, 4);
    assert.equal(grown.profile.columns_hash, first.profile.columns_hash);
    assert.notEqual(grown.hash, first.hash);
    assert.equal(grown.status, 'described', 'append-only: the description stays valid');
    assert.equal(grown.desc, 'Merania');
    fx.write('log.csv', 'id;iny\n1;10\n');
    scanAll(fx.cfg());
    profileAll(fx.cfg());
    const changed = fx.indexRows()[0];
    assert.notEqual(changed.profile.columns_hash, first.profile.columns_hash);
    assert.equal(changed.status, 'stale', 'another header: the old description no longer applies');
  } finally { fx.cleanup(); }
});

test('CSV profile stops at the deadline instead of hanging and leaves the row pending', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('big.csv', 'a;b\n' + Array.from({ length: 2000 }, (_, i) => `${i};${i}`).join('\n') + '\n');
    scanAll(fx.cfg());
    const row = fx.indexRows()[0];
    const res = profileCsv(path.join(fx.data, 'big.csv'), row.size, cfgCsv, { deadline: Date.now() - 1 });
    assert.equal(res?.aborted, true);
    const out = profileAll(fx.cfg(), { deadline: Date.now() - 1 });
    assert.equal(out[0].aborted, true);
    assert.equal(fx.indexRows()[0].status, 'pending');
  } finally { fx.cleanup(); }
});

test('zip lists entries from the central directory, an image gets its size from the header, a damaged one stays without', () => {
  const fx = catalogFixture({ files: false });
  try {
    fs.writeFileSync(path.join(fx.data, 'a.zip'), zip(['faktura-1.pdf', 'sub/zoznam.csv']));
    fs.writeFileSync(path.join(fx.data, 'f.png'), png(40, 30));
    fs.writeFileSync(path.join(fx.data, 'bad.png'), 'not a png');
    scanAll(fx.cfg());
    profileAll(fx.cfg());
    const rows = Object.fromEntries(fx.indexRows().map((r) => [r.path, r]));
    assert.equal(rows['a.zip'].profile.entries, 2);
    assert.ok(JSON.stringify(rows['a.zip'].profile.listing).includes('sub/zoznam.csv'), 'entry names are listed');
    assert.match(rows['a.zip'].desc, /ZIP, 2 položiek/);
    assert.deepEqual([rows['f.png'].profile.width, rows['f.png'].profile.height], [40, 30]);
    assert.match(rows['f.png'].desc, /40.30/);
    assert.equal(rows['bad.png'].profile?.width ?? null, null);
  } finally { fx.cleanup(); }
});

test('PDF: pages from pdfinfo and the text layer from pdftotext; no text means pdf_scan; without pdfinfo the row stays pending', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('text.pdf', '%PDF-1.4 text\n');
    fx.write('sken.pdf', '%PDF-1.4 sken\n');
    scanAll(fx.cfg());
    const bin = path.join(fx.root, 'bin');
    const withTools = fakeTool(bin, 'pdfinfo', 'echo "Producer:   Fake 1.0"; echo "Pages:          7"');
    fakeTool(bin, 'pdftotext', 'case "$*" in *sken*) echo "" ;; *) i=0; while [ $i -lt 60 ]; do echo "dostatok textu na prvej strane dokumentu"; i=$((i+1)); done ;; esac');
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-dir';
    try { profileAll(fx.cfg()); } finally { process.env.PATH = saved; }
    assert.deepEqual(fx.indexRows().map((r) => r.status), ['pending', 'pending'], 'no pdfinfo: nothing is invented');
    process.env.PATH = withTools;
    try { profileAll(fx.cfg()); } finally { process.env.PATH = saved; }
    const rows = Object.fromEntries(fx.indexRows().map((r) => [r.path, r]));
    assert.equal(rows['text.pdf'].profile.pages, 7);
    assert.equal(rows['text.pdf'].kind, 'pdf_text');
    assert.equal(rows['sken.pdf'].kind, 'pdf_scan');
    assert.match(rows['text.pdf'].desc, /7 strán/);
  } finally { fx.cleanup(); }
});
