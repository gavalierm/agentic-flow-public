// issue #64: after a test an agent added a new mandatory rule to an existing skill on its own (a lesson read as a
// permission, P-002). An edit of an existing skill names its basis: error | routine | operator with the operator's
// order in --reason; the basis is in the commit message. A new skill keeps its error | routine origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setup } from './helpers.mjs';

test('save skill: an edit of an existing skill needs its basis (error | routine | operator with --reason)', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'popis-x', '--description', 'Použi, keď prepisuješ popis produktu.', '--content', 'Krok: navrhni text.', '--origin', 'routine']);
    assert.equal(r.status, 0, r.out + r.stderr);
    r = fx.run('save.mjs', ['skill', 'popis-x', '--sed', 's/navrhni text/navrhni text a over ho/']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /names its basis with --origin error/);
    assert.match(fx.read('skills/agentic/popis-x/SKILL.md'), /Krok: navrhni text\.$/m);
    r = fx.run('save.mjs', ['skill', 'popis-x', '--origin', 'operator', '--sed', 's/navrhni text/navrhni text a over ho/']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /--origin operator needs --reason "operator/);
    r = fx.run('save.mjs', ['skill', 'popis-x', '--origin', 'operator', '--reason', 'operator 2026-11-14: over aj údaje', '--sed', 's/navrhni text/navrhni text a over ho/']);
    assert.equal(r.status, 0, r.out + r.stderr);
    assert.match(fx.read('skills/agentic/popis-x/SKILL.md'), /navrhni text a over ho/);
    const msg = execFileSync('git', ['-C', fx.brain, 'log', '-1', '--format=%s'], { encoding: 'utf8' });
    assert.match(msg, /edit, operator: 2026-11-14: over aj údaje/);
    r = fx.run('save.mjs', ['skill', 'popis-x', '--origin', 'error', '--sed', 's/over ho/over ho voči zdroju/']);
    assert.equal(r.status, 0, r.out + r.stderr);
    r = fx.run('save.mjs', ['skill', 'novy-x', '--description', 'Použi, keď x.', '--content', 'y', '--origin', 'operator']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /operator is for an edit of an existing skill/);
  } finally { fx.cleanup(); }
});
