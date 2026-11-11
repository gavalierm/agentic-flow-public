// Issue #28: delegate.mjs prepare bundles full text only for strong skill matches, within a size limit; the rest is listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as delegate from '../bin/delegate.mjs';

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
