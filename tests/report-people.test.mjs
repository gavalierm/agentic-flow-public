// D-0009 (operator 2026-11-11): flow-public#27 carried the first name of the instance's operator in a public issue.
// scrub replaces the names of people the brain knows, with their case endings; a generic name stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrub } from '../scripts/report.mjs';

test('scrub: names of known people (memory person/operator, aliases) become <person>, with case endings', () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-'));
  try {
    fs.mkdirSync(path.join(brain, 'memory'));
    fs.writeFileSync(path.join(brain, 'memory', 'person-bohuslav.md'), '---\nkey: person-bohuslav\ntype: person\nname: Bohuslav\naliases: [Hana Malá]\n---\nklient\n');
    fs.writeFileSync(path.join(brain, 'memory', 'operator-operator.md'), '---\nkey: operator-operator\ntype: operator\nname: operator\n---\nx\n');
    fs.writeFileSync(path.join(brain, 'memory', 'tool-gsc.md'), '---\nkey: tool-gsc\ntype: tool\nname: Search Console\n---\nx\n');
    const out = scrub('Bohuslavovi som napísal; Hany sa pýtal operator; Malá; Search Console ostáva', { brainDir: brain }, { HOME: '/srv/u' });
    assert.equal(out, '<person> som napísal; <person> sa pýtal operator; <person>; Search Console ostáva');
  } finally { fs.rmSync(brain, { recursive: true, force: true }); }
});
