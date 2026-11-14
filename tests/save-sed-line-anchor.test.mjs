// report-fb996133: save skill --sed with a pattern starting with ^ reported "pattern not found" for a line inside
// the body, because the regex had no m flag; sed is line-oriented, so ^ and $ must match at every line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('save skill --sed anchors ^ and $ at line boundaries like sed', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'sed-anchor', '--description', 'Použi, keď skúšaš sed.', '--content', 'Úvod.\n- Krok jeden\n- Krok dva', '--origin', 'routine']);
    assert.equal(r.status, 0, r.out + r.stderr);
    r = fx.run('save.mjs', ['skill', 'sed-anchor', '--origin', 'error', '--sed', 's/^- Krok dva$/- Krok dva (upravený)/']);
    assert.equal(r.status, 0, r.out + r.stderr);
    const body = parseFrontmatter(fx.read('skills/agentic/sed-anchor/SKILL.md')).body;
    assert.match(body, /^- Krok dva \(upravený\)$/m);
    assert.match(body, /^- Krok jeden$/m);
  } finally { fx.cleanup(); }
});
