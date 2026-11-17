// keep: core
// P-077, operator 2026-11-17: a proposal for the operator is one HTML page shown in the thread, not a long .md file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('the rule, the proposal skill, the principle and the save skill say a proposal is an HTML page shown in the thread', () => {
  const rule = read('../rules/08-reply.md');
  assert.match(rule, /HTML stránka vo vlákne, nie `\.md` či dlhý text \(P-077, `workflow:proposal`\)/);
  const skill = read('../skills/proposal/SKILL.md');
  assert.match(skill, /^name: proposal$/m);
  assert.match(skill, /html_preview.*html_render/);
  assert.match(skill, /save\.mjs result <súbor> --as navrh-<názov>\.html/);
  assert.ok(skill.match(/^description: (.*)$/m)[1].length <= 300, 'description is a trigger of at most 300 chars (P-022)');
  assert.match(read('../docs/principles/P-077.md'), /MUSÍ byť jedna HTML stránka, nie súbor `\.md`/);
  assert.match(read('../docs/principles/README.md'), /\[P-077\]\(P-077\.md\)/);
  assert.match(read('../skills/save/SKILL.md'), /návrh pre operátora je stránka `\.html`, nie `\.md` \(P-077\)/);
});
