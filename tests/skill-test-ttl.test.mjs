// keep: guarded
// P-079 (operator 2026-11-22): a skill test needs a header at save; a save of the skill removes its tests past their day
// (ttl, or last change + 3 days without a header) and keeps "// keep:" tests. The rotation deletes domain files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

test('skill tests: header required at save, expired ones removed by the next save, keep stays', () => {
  const fx = setup({ thread: 'tt1', remote: false });
  try {
    const w = (f, t) => { fs.writeFileSync(path.join(fx.root, f), t); return path.join(fx.root, f); };
    const save = (...a) => fx.run('save.mjs', ['skill', 'tt-demo', '--origin', 'routine', ...a]);
    const base = ['--description', 'Použi, keď skúšaš rotáciu testov.', '--content', 'Spusti `node x.mjs`.\n\nnie ručne, lebo sa zabudne krok'];
    let r = save(...base, '--script', w('a.test.mjs', "import 'node:test';\n"));
    assert.notEqual(r.status, 0);
    assert.match(r.out, /a\.test\.mjs: no header.*\/\/ ttl: \d{4}-\d{2}-\d{2}/);
    r = save(...base, '--script', w('a.test.mjs', "// ttl: 2020-01-01\nimport 'node:test';\n"));
    assert.notEqual(r.status, 0);
    assert.match(r.out, /ttl 2020-01-01 is past/);
    r = save(...base, '--script', `${w('keep.test.mjs', "// keep: core\nimport 'node:test';\n")},${w('fix.test.mjs', "// ttl: 2999-01-01\nimport 'node:test';\n")}`);
    assert.equal(r.status, 0, r.out);
    const dir = path.dirname(path.join(fx.brain, fs.readdirSync(fx.brain, { recursive: true }).map(String).find((f) => f.endsWith(path.join('tt-demo', 'SKILL.md')))));
    // an old test without a header (last change 2020) and a test whose ttl passed
    fs.writeFileSync(path.join(dir, 'legacy.test.mjs'), "import 'node:test';\n");
    fs.writeFileSync(path.join(dir, 'fix.test.mjs'), "// ttl: 2020-01-01\nimport 'node:test';\n");
    const env = { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
    for (const a of [['add', '-A'], ['commit', '-qm', 'old tests', '--no-verify']]) { const g = spawnSync('git', ['-C', fx.brain, ...a], { env, encoding: 'utf8' }); assert.equal(g.status, 0, g.stderr + g.stdout); }
    r = save('--description', 'Použi, keď skúšaš rotáciu testov znova.');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /removed 2 expired test file\(s\)/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')), ['keep.test.mjs']);
  } finally { fx.cleanup?.(); }
});
