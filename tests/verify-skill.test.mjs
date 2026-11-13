import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');

// flow-public#39: an agent wrote a closed day into a business profile because the provider's editor offered it as a
// public holiday; the day was no longer one after a change of the law. The verify skill covered only what a tool can
// do, so a fact a tool offers counted as an observation (P-019: "výstup nástroja").
test('verify skill: a fact a tool offers is a third-party claim, checked in the current authoritative source before a write to an external service (flow-public#39)', () => {
  const skill = read('skills/verify/SKILL.md');
  const desc = /^description: (.*)$/m.exec(skill)?.[1] || '';
  assert.match(desc, /fakt sveta/, 'the trigger covers a fact of the world');
  assert.match(desc, /zápis do externej služby/, 'the trigger covers a write to an external service');
  assert.match(desc, /ponúkol nástroj/, 'the trigger covers a value a tool offered');
  assert.ok(desc.length <= 300, `description within the skill-check limit: ${desc.length}`);
  assert.match(skill, /tvrdenie tretej strany, nie pozorovanie faktu/);
  assert.match(skill, /aktuálnom autoritatívnom zdroji/);
  assert.match(skill, /zdroj, jeho dátum a istotu daj do otázky na súhlas/);
  assert.match(skill, /^nie údaj z ponuky nástroja ako overený fakt, lebo .*flow-public#39/m);
  const p019 = read('docs/principles/P-019.md');
  assert.match(p019, /fakty sveta, o ktoré sa opiera rozhodnutie alebo zápis do externej služby, vedie spoločný skill `verify`/);
});

// flow-public#40: an agent tried three of four signed-in browser accounts, said no account had access and switched
// to the browser of another computer. A claim that something is not there holds only after every candidate.
test('verify skill: a negative claim only after every candidate, else how many of how many; another device only after consent (flow-public#40)', () => {
  const skill = read('skills/verify/SKILL.md');
  const desc = /^description: (.*)$/m.exec(skill)?.[1] || '';
  assert.match(desc, /že niečo nie je \(účet, prístup, súbor\)/, 'the trigger covers a claim that something is not there');
  assert.ok(desc.length <= 300, `description within the skill-check limit: ${desc.length}`);
  assert.match(skill, /až po vyskúšaní všetkých kandidátov/);
  assert.match(skill, /koľko z koľkých si vyskúšal/);
  assert.match(skill, /iné zariadenie, prehliadač iného počítača, iný účet\) navrhni a urob až po súhlase operátora \(P-002\)/);
  assert.match(skill, /^nie „žiadny účet nemá prístup“ po skúške časti účtov, lebo .*flow-public#40/m);
});

// report-4a4caced: an agent reported a site's search positions from one live SERP snapshot as verified; Search
// Console over 12 months refuted three of them. One sample of a variable measure is a snapshot, not a verified state.
test('verify skill: a measure from one snapshot (SERP position, traffic) is a sample, verified only from own aggregated data (report-4a4caced)', () => {
  const skill = read('skills/verify/SKILL.md');
  const desc = /^description: (.*)$/m.exec(skill)?.[1] || '';
  assert.match(desc, /meranie z jednej snímky/, 'the trigger covers a measure from one snapshot');
  assert.ok(desc.length <= 300, `description within the skill-check limit: ${desc.length}`);
  assert.match(skill, /je to vzorka, nie overený stav/);
  assert.match(skill, /vlastných agregovaných dát za obdobie/);
  assert.match(skill, /obmedzením „jedna vzorka“/);
  assert.match(skill, /^nie pozícia z jednej snímky SERP ako overená, lebo .*report-4a4caced/m);
});
