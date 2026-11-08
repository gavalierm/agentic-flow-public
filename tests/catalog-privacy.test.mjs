// Catalog (MVP): privacy. Values of personal columns never reach the index, the human overview, find/show output or
// the boot text; the catalog directory is ignored by git and nothing of it goes to the brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { catalogFixture } from './catalog-helpers.mjs';

const SECRETS = [`jan.novak${'@'}firma.example`, // address composed: the release leak scan
  '+421 900 111 222', 'Novák', 'SK31 1200 0000 1987 4263 7541', 'Ulica 12, Bratislava'];

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') out.push(...walkFiles(p)); } else out.push(p);
  }
  return out;
}

function csvWithPii() {
  return 'id;E-mail;Telefón;Priezvisko;IBAN;Adresa;mesto;suma\n'
    + `1;${SECRETS[0]};${SECRETS[1]};${SECRETS[2]};${SECRETS[3]};${SECRETS[4]};Bratislava;10\n`
    + `2;${SECRETS[0]};${SECRETS[1]};${SECRETS[2]};${SECRETS[3]};${SECRETS[4]};Košice;20\n`;
}

function prepare(extra) {
  const fx = catalogFixture({ files: false, extra });
  fx.write('klienti/zoznam.csv', csvWithPii());
  const boot = fx.hook('session-start.mjs', { source: 'startup' });
  assert.equal(boot.status, 0, boot.stderr);
  const prof = fx.catalog(['profile']);
  assert.equal(prof.status, 0, prof.out);
  return { fx, boot };
}

const catalogOutputs = (fx) => [
  ['scan', fx.catalog(['scan']).out],
  ['find mesto', fx.catalog(['find', 'zoznam']).out],
  ['find hodnota', fx.catalog(['find', 'bratislava']).out],
  ['find json', fx.catalog(['find', 'zoznam', '--json']).out],
  ['show', fx.catalog(['show', 'klienti/zoznam.csv']).out],
  ['show json', fx.catalog(['show', 'klienti/zoznam.csv', '--json']).out],
  ['overview', fx.catalog(['overview']).out],
  ['status', fx.catalog(['status']).out],
  ['status json', fx.catalog(['status', '--json']).out],
  ['find.mjs', fx.run('find.mjs', ['zoznam']).out],
];

test('PII values (e-mail, phone, surname, IBAN, address) are in no file of the catalog and in no command output', () => {
  const { fx, boot } = prepare();
  try {
    const row = fx.indexRows().find((r) => r.path === 'klienti/zoznam.csv');
    assert.equal(row.status, 'profiled');
    const cols = Object.fromEntries(row.profile.columns.map((c) => [c.name, c]));
    for (const name of ['E-mail', 'Telefón', 'Priezvisko', 'IBAN', 'Adresa']) assert.equal(cols[name]?.pii, true, `${name} is a personal column`);
    assert.deepEqual(cols['mesto'].values.sort(), ['Bratislava', 'Košice'], 'an ordinary column keeps its values');
    for (const file of walkFiles(path.join(fx.project, 'local', 'catalog'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const s of SECRETS) assert.ok(!text.includes(s), `${path.relative(fx.project, file)} contains ${s}`);
    }
    for (const [name, out] of [...catalogOutputs(fx), ['boot', boot.context]]) {
      for (const s of SECRETS) assert.ok(!out.includes(s), `${name} contains ${s}`);
    }
    // sample rows carry the mask, not the value
    assert.ok(row.profile.sample.every((r) => r.includes('***')));
  } finally { fx.cleanup(); }
});

test('csv.pii_columns replaces the default list: a custom column is masked, a default name is then plain', () => {
  const fx = catalogFixture({ files: false, extra: { csv: { pii_columns: ['rodne cislo', 'poznamka'] } } });
  try {
    fx.write('a.csv', `id;Rodné číslo;poznámka;email\n1;900101/1234;tajne;x${'@'}y.example\n2;850505/4321;iné;z${'@'}y.example\n`);
    assert.equal(fx.catalog(['scan']).status, 0);
    assert.equal(fx.catalog(['profile']).status, 0);
    const cols = Object.fromEntries(fx.indexRows().find((r) => r.path === 'a.csv').profile.columns.map((c) => [c.name, c]));
    assert.equal(cols['Rodné číslo'].pii, true);
    assert.equal(cols['poznámka'].pii, true);
    assert.ok(!cols['email'].pii, 'the default list is replaced, not extended');
    const index = fs.readFileSync(path.join(fx.project, 'local', 'catalog', 'index', 'data.jsonl'), 'utf8');
    for (const s of ['900101/1234', '850505/4321', 'tajne']) assert.ok(!index.includes(s), s);
  } finally { fx.cleanup(); }
});

test('column name variants: E-mail, e_mail, Telefón, TEL, Phone Number are all recognised as personal', () => {
  const fx = catalogFixture({ files: false });
  try {
    fx.write('v.csv', `E-mail;e_mail;Telefón;TEL;Phone Number;kod\na${'@'}b.example;c${'@'}d.example;111;222;333;K1\n`);
    fx.catalog(['scan']);
    fx.catalog(['profile']);
    const cols = Object.fromEntries(fx.indexRows().find((r) => r.path === 'v.csv').profile.columns.map((c) => [c.name, c]));
    for (const name of ['E-mail', 'e_mail', 'Telefón', 'TEL', 'Phone Number']) assert.equal(cols[name].pii, true, name);
    assert.ok(!cols['kod'].pii);
  } finally { fx.cleanup(); }
});

test('git: local/catalog is ignored in the project, nothing of the catalog is in the brain, boot text has no file names', () => {
  const { fx, boot } = prepare();
  try {
    const ignored = spawnSync('git', ['check-ignore', '-q', 'local/catalog/index/data.jsonl'], { cwd: fx.project });
    assert.equal(ignored.status, 0, 'local/catalog is ignored');
    const status = fx.git(fx.project, 'status', '--porcelain', '--', 'local/catalog');
    assert.equal(status.trim(), '', 'git sees no catalog file');
    for (const file of walkFiles(fx.brain)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const s of [...SECRETS, 'zoznam.csv', 'klienti/']) assert.ok(!text.includes(s), `${path.relative(fx.brain, file)} contains ${s}`);
    }
    assert.doesNotMatch(boot.context.split('\n').filter((l) => l.startsWith('katalóg')).join('\n'), /zoznam|klienti/);
  } finally { fx.cleanup(); }
});
