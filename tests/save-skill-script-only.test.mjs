// report-dffad7fe: save skill --script alone updates the script of an existing skill and keeps its body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('skill --script alone: existing skill keeps its body, the script is updated; a new skill still needs --content', () => {
  const fx = setup();
  try {
    const src = path.join(fx.root, 'release.mjs');
    fs.writeFileSync(src, '#!/usr/bin/env node\nconsole.log("v1");\n');
    let r = fx.run('save.mjs', ['skill', 'release-x', '--description', 'Použi, keď vydávaš', '--content', 'node <skill>/release.mjs', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 0, r.out);
    const before = parseFrontmatter(fx.read('skills/agentic/release-x/SKILL.md')).body;
    fs.writeFileSync(src, '#!/usr/bin/env node\nconsole.log("v2");\n');
    r = fx.run('save.mjs', ['skill', 'release-x', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 0, r.out + r.stderr);
    assert.match(fx.read('skills/agentic/release-x/release.mjs'), /v2/);
    assert.equal(parseFrontmatter(fx.read('skills/agentic/release-x/SKILL.md')).body, before, 'body unchanged');
    r = fx.run('save.mjs', ['skill', 'other-x', '--description', 'Použi, keď', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 1); assert.match(r.stderr, /does not exist; a new skill needs --content/);
  } finally { fx.cleanup(); }
});
