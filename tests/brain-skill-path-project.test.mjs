// ttl: 2026-12-15
// report-117ef1b9: a project on a persona brain (agent-<name>, not the persona itself) deployed the brain's skills with
// paths "<brain repo>/.claude/skills/<name>/..." unchanged, but the persona deploys them as <persona>-<name>, so the copy
// called a script that does not exist. Those paths now name the prefixed folder; relative paths, other repos, a name that
// is not a brain skill and the persona's own deploy stay as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBrainSkills, brainSkillPathText } from '../scripts/skills-sync.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const posix = (p) => p.split(path.sep).join('/');

test('a project on a persona brain points brain skill paths to the prefixed folders the persona deploys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-'));
  try {
    const persona = path.join(root, 'agent-tst');
    const project = path.join(root, 'flow');
    write(path.join(persona, '.workflow.json'), JSON.stringify({ brain: '.' }));
    write(path.join(persona, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
    write(path.join(project, '.workflow.json'), JSON.stringify({ brain: '../agent-tst' }));
    const b = posix(persona);
    write(path.join(persona, '.brain', 'skills', 'agentic', 'issues', 'SKILL.md'),
      `---\nname: issues\ndescription: Použi pri issues.\n---\nSpusti \`sh ${b}/.claude/skills/issues/resolve.sh\`, potom \`sh ${b}/.claude/skills/build/make.sh\`; iné: \`sh .claude/skills/issues/x.sh\`, \`sh $H/agent-bob/.claude/skills/issues/y.sh\`, \`sh ${b}/.claude/skills/other/z.sh\`.\n`);
    write(path.join(persona, '.brain', 'skills', 'agentic', 'issues', 'resolve.sh'), `#!/bin/sh\nsh ${b}/.claude/skills/build/make.sh\n`);
    write(path.join(persona, '.brain', 'skills', 'operator', 'build', 'SKILL.md'), '---\nname: build\ndescription: Použi pri zostavení.\n---\nZostav.\n');
    write(path.join(persona, '.brain', 'skills', 'operator', 'build', 'make.sh'), '#!/bin/sh\necho built\n');

    syncBrainSkills({ projectDir: persona, brainDir: persona });
    const res = syncBrainSkills({ projectDir: project, brainDir: persona });
    assert.deepEqual(res.copied.sort(), ['build', 'issues'], 'project copies keep the plain names');
    const text = fs.readFileSync(path.join(project, '.claude', 'skills', 'issues', 'SKILL.md'), 'utf8');
    assert.match(text, /^name: issues$/m);
    assert.ok(text.includes(`sh ${b}/.claude/skills/tst-issues/resolve.sh`), text);
    assert.ok(text.includes(`sh ${b}/.claude/skills/tst-build/make.sh`), text);
    assert.ok(text.includes('sh .claude/skills/issues/x.sh') && text.includes('$H/agent-bob/.claude/skills/issues/y.sh') && text.includes(`${b}/.claude/skills/other/z.sh`), text);
    const script = fs.readFileSync(path.join(project, '.claude', 'skills', 'issues', 'resolve.sh'), 'utf8');
    assert.ok(script.includes(`${b}/.claude/skills/tst-build/make.sh`), script);
    for (const p of [`${b}/.claude/skills/tst-issues/resolve.sh`, `${b}/.claude/skills/tst-build/make.sh`]) assert.ok(fs.existsSync(p), `path in the project copy exists: ${p}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a brain that is not a persona repo leaves the paths unchanged', () => {
  const text = 'sh /x/brain/.claude/skills/issues/resolve.sh';
  assert.equal(brainSkillPathText(text, { brainDir: '/x/brain', prefix: '', names: ['issues'] }), text);
});
