// report-46e5fd4c: save skill --sed promises sed syntax, but handed the replacement to String.replace,
// so `\1` landed in the skill verbatim and the clause matched by the group was lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('save skill --sed honours sed group references \\1 (like $1); & and $HOME stay literal', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'sed-x', '--description', 'Použi, keď skúšaš sed.', '--content', 'Krok A (pozn. B). Koniec.', '--origin', 'routine']);
    assert.equal(r.status, 0, r.out + r.stderr);
    r = fx.run('save.mjs', ['skill', 'sed-x', '--origin', 'error', '--sed', 's/(Krok A \\(pozn\\. B\\)\\.)/\\1 Nová veta $HOME [&]./']);
    assert.equal(r.status, 0, r.out + r.stderr);
    const body = parseFrontmatter(fx.read('skills/agentic/sed-x/SKILL.md')).body;
    assert.match(body, /Krok A \(pozn\. B\)\. Nová veta \$HOME \[&\]\. Koniec\./);
    assert.doesNotMatch(body, /\\1/);
    r = fx.run('save.mjs', ['skill', 'sed-x', '--origin', 'error', '--sed', 's/Koniec/\\2/']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /names a group the pattern does not have/);
  } finally { fx.cleanup(); }
});
