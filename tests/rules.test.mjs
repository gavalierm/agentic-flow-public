// keep: core
// P-035, P-022: layered rules.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleRules } from '../scripts/rules.mjs';
import { loadPolicy } from '../scripts/config.mjs';

function tmpBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-rules-'));
  fs.mkdirSync(path.join(dir, 'exceptions'));
  fs.mkdirSync(path.join(dir, 'local'));
  return dir;
}

test('layers apply in order harness < machine < project < local; applied exceptions are listed', () => {
  const brain = tmpBrain();
  try {
    fs.writeFileSync(path.join(brain, 'exceptions', 'harness-claude-code.md'), '### P-034: Node\nZnenie: harness wording\nDôvod: h\n');
    fs.writeFileSync(path.join(brain, 'exceptions', 'project.md'), '### P-034: Node\nZnenie: project wording\nDôvod: p\n\n### P-010\nZnenie: limit 30\nDôvod: small project\n');
    fs.writeFileSync(path.join(brain, 'local', 'exceptions.md'), '### P-010\nZnenie: local limit 20\nDôvod: test\n');
    const res = assembleRules({ brainDir: brain, policy: loadPolicy(null), harness: 'claude-code', machine: 'box' });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.applied, [{ id: 'P-034', layer: 'project' }, { id: 'P-010', layer: 'local' }]);
    assert.match(res.text, /### P-010[^\n]*\(výnimka: local\)\nlocal limit 20/);
    assert.doesNotMatch(res.text, /harness wording/);
    assert.match(res.text, /P-034[^\n]*\(výnimka: project\)\nproject wording/);
    assert.match(res.text, /Výnimky: P-034 \(project\), P-010 \(local\)/);
    assert.ok(res.text.indexOf('### P-001') < res.text.indexOf('Výnimky:'));
  } finally { fs.rmSync(brain, { recursive: true, force: true }); }
});

test('immutable principle, missing ID and missing reason are refused and reported', () => {
  const brain = tmpBrain();
  try {
    fs.writeFileSync(path.join(brain, 'exceptions', 'project.md'), '### P-001\nZnenie: read everything\nDôvod: speed\n\n### Something\nZnenie: x\nDôvod: y\n\n### P-034\nZnenie: bash ok\n');
    const res = assembleRules({ brainDir: brain, policy: loadPolicy(null) });
    assert.deepEqual(res.applied, []);
    assert.equal(res.errors.length, 3);
    assert.ok(res.errors.some((e) => /P-001 is immutable/.test(e)));
    assert.ok(res.errors.some((e) => /no principle ID/.test(e)));
    assert.ok(res.errors.some((e) => /Dôvod/.test(e)));
    assert.match(res.text, /Odmietnuté výnimky:/);
    assert.doesNotMatch(res.text, /read everything/);
  } finally { fs.rmSync(brain, { recursive: true, force: true }); }
});

test('core rules stay within limits; exceeding a limit is reported, nothing trimmed', () => {
  const policy = loadPolicy(null);
  const res = assembleRules({ brainDir: null, policy });
  assert.deepEqual(res.overLimit, []);
  assert.ok(res.lines <= policy.limits.rules_lines && res.chars <= policy.limits.rules_chars);
  const tight = { ...policy, limits: { ...policy.limits, rules_lines: 10, rules_chars: 100 } };
  const over = assembleRules({ brainDir: null, policy: tight });
  assert.equal(over.overLimit.length, 2);
  assert.equal(over.text, res.text, 'text is not trimmed');
});

