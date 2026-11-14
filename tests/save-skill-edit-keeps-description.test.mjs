// report-5d6c4ce2: the usage of save skill names the edit forms of an existing skill, which keep its description
// without --description (an agent read the new-skill usage as "required" and overwrote the description with 'x').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('save skill usage names the edit forms; --sed with --script without --description keeps the description', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /existing skill: keeps its description/);
    assert.match(r.stderr, /--sed/);
    const src = path.join(fx.root, 'take-over.sh');
    fs.writeFileSync(src, '#!/bin/sh\necho v1\n');
    const desc = 'Použi, keď opravuješ chybu workflow.';
    r = fx.run('save.mjs', ['skill', 'fix-x', '--description', desc, '--content', 'Krok: sh <skill>/take-over.sh old', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 0, r.out + r.stderr);
    fs.writeFileSync(src, '#!/bin/sh\necho v2\n');
    r = fx.run('save.mjs', ['skill', 'fix-x', '--origin', 'routine', '--script', src, '--sed', 's/old/new/']);
    assert.equal(r.status, 0, r.out + r.stderr);
    const parsed = parseFrontmatter(fx.read('skills/agentic/fix-x/SKILL.md'));
    assert.equal(parsed.data.description, desc);
    assert.match(parsed.body, /take-over\.sh new/);
    assert.match(fx.read('skills/agentic/fix-x/take-over.sh'), /v2/);
  } finally { fx.cleanup(); }
});
