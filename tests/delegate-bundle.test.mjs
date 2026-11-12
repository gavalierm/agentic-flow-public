// Issue #28: delegate.mjs prepare bundles full text only for strong skill matches, within a size limit; the rest is listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as delegate from '../bin/delegate.mjs';
import { setup } from './helpers.mjs';

test('prepare --task-file reads the brief from a file; a missing file is refused (flow-public#38)', () => {
  const fx = setup();
  try {
    const file = path.join(fx.project, 'scratch', 'brief.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Zisti verziu nástroja X\nv dvoch zdrojoch.\n');
    let r = fx.run('delegate.mjs', ['prepare', '--task-file', file]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /## Zadanie\nZisti verziu nástroja X\nv dvoch zdrojoch\.\n/);
    r = fx.run('delegate.mjs', ['prepare', '--task-file', path.join(fx.project, 'scratch', 'none.md')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task file not found/);
  } finally { fx.cleanup(); }
});

// flow-public#48: the brief forbade reading the project's files and the source list was a file of the project.
test('prepare refuses a brief that forbids reading files and names a file; a ban without a named file or on the rest passes; a failed source is no end (flow-public#48)', () => {
  const fx = setup();
  try {
    let r = fx.run('delegate.mjs', ['prepare', '--task', 'Zober zoznam webov z docs/zdroje.md a zisti ceny. Nečítaj súbory projektu.']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, /forbids reading files[^]*docs\/zdroje\.md[^]*flow-public#48/);
    r = fx.run('delegate.mjs', ['prepare', '--task', 'Zisti ceny z webov výrobcov. Nečítaj súbory projektu.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Zdroj, ktorý zlyhá \(403, timeout, blokovanie\), nie je koniec úlohy/);
    r = fx.run('delegate.mjs', ['prepare', '--task', 'Prečítaj docs/zdroje.md a zisti ceny; iné súbory projektu nečítaj.']);
    assert.equal(r.status, 0, r.out);
    assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'agents/worker.md'), 'utf8'), /nie je koniec úlohy[^]*flow-public#48/);
  } finally { fx.cleanup(); }
});

const skill = (name, description, aliases = []) => ({ skillName: name, description, aliases, path: `skills/operator/${name}/SKILL.md` });

test('one shared word is not a match; a selected skill needs at least two meaningful task words', () => {
  const skills = [
    skill('deploy-prod', 'Nasadenie aplikácie do produkcie cez release skript'),
    skill('pdf-tools', 'Práca s PDF a exportom'),
    skill('logs', 'Čítanie logov nasadenie'),
  ];
  const task = 'Over nasadenie aplikácie na staging a zhrň logy';
  assert.deepEqual(delegate.selectSkills(skills, task).map((s) => s.skillName), ['deploy-prod']);
});

test('bundleSkills puts full text only for strong matches while under the size limit and lists the rest', () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-bundle-'));
  try {
    const skills = [
      skill('alpha', 'nasadenie aplikacie produkcia'),
      skill('beta', 'nasadenie aplikacie staging'),
      skill('gamma', 'nasadenie'),
    ];
    for (const s of skills) {
      fs.mkdirSync(path.join(brain, path.dirname(s.path)), { recursive: true });
      fs.writeFileSync(path.join(brain, s.path), `${s.skillName.toUpperCase()} ${'x'.repeat(500)}\n`);
    }
    const { bundled, listed } = delegate.bundleSkills(brain, skills, 'nasadenie aplikacie produkcia staging', { limit: 600 });
    assert.deepEqual(bundled.map((b) => b.skill.skillName), ['alpha'], 'beta would exceed the limit, gamma has one match');
    assert.match(bundled[0].body, /^ALPHA x+/);
    assert.deepEqual(listed.map((s) => s.skillName), ['beta', 'gamma']);
    const all = delegate.bundleSkills(brain, skills, 'nasadenie aplikacie produkcia staging', { limit: 5000 });
    assert.deepEqual(all.bundled.map((b) => b.skill.skillName), ['alpha', 'beta']);
    assert.deepEqual(all.listed.map((s) => s.skillName), ['gamma']);
  } finally { fs.rmSync(brain, { recursive: true, force: true }); }
});

// flow-public#42: workers wrote extracts by a shell heredoc with an apostrophe in Slovak text (exit 2), a Glob pattern
// in capitals missed lower-case file names and `rg -h` printed the help; the brief only forbade, without a substitute.
test('worker rules: write text with Write, retry Glob in lower case, rg --no-filename; a brief gives a substitute for a ban (flow-public#42)', () => {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
  const worker = read('agents/worker.md');
  assert.match(worker, /zapisuj nástrojom Write, nie heredoc, echo ani printf v shelli/);
  assert.match(worker, /Keď Glob nič nenájde, skús ten istý vzor malými písmenami/);
  assert.match(worker, /V `rg` je `-h` pomocník .*`rg --no-filename`/);
  const skill = read('skills/delegate/SKILL.md');
  assert.match(skill, /Zákaz v zadaní daj s náhradou \(čím to urobiť\).*flow-public#42/);
});
