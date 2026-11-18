// ttl: 2026-12-14
// D-0065: a persona (brain ".", repo agent-<name>) deploys its own brain skills as <name>-<skill>: the name: field, the
// absolute paths <project>/.claude/skills/<skill>/ and mentions "skill `<skill>`" of the copy get the prefix, the brain
// keeps the names; old unprefixed copies go with the marker; a project that is not a persona keeps the names.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBrainSkills, deployedSkillName, GENERATED_MARKER } from '../scripts/skills-sync.mjs';
import { checkSkill } from '../scripts/skill-check.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const posix = (p) => p.split(path.sep).join('/');

function brainSkills(brain, project) {
  write(path.join(brain, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
  write(path.join(brain, '.brain', 'skills', 'agentic', 'deploy', 'SKILL.md'),
    `---\nname: deploy\ndescription: Použi pri nasadení.\n---\nSpusti \`sh ${posix(project)}/.claude/skills/deploy/run.sh\`, potom skill \`build\` a skillom build; nie skill builder.\n`);
  write(path.join(brain, '.brain', 'skills', 'agentic', 'deploy', 'run.sh'), `#!/bin/sh\nsh ${posix(project)}/.claude/skills/build/make.sh\n`);
  write(path.join(brain, '.brain', 'skills', 'operator', 'build', 'SKILL.md'), '---\nname: build\ndescription: Použi pri zostavení.\n---\nZostav.\n');
  write(path.join(brain, '.brain', 'skills', 'operator', 'build', 'make.sh'), '#!/bin/sh\necho built\n');
}

test('persona deploys its own skills as <persona>-<name> with rewritten name, paths and mentions; brain keeps the names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-'));
  try {
    const persona = path.join(root, 'agent-tst');
    write(path.join(persona, '.workflow.json'), JSON.stringify({ brain: '.' }));
    brainSkills(persona, persona);
    // an older deploy without the prefix, recorded in the marker
    write(path.join(persona, '.claude', 'skills', 'deploy', 'SKILL.md'), 'old');
    write(path.join(persona, '.claude', 'skills', GENERATED_MARKER), JSON.stringify({ generated: ['deploy', 'build'] }));
    const res = syncBrainSkills({ projectDir: persona, brainDir: persona });
    const skills = path.join(persona, '.claude', 'skills');
    assert.deepEqual(res.copied.sort(), ['tst-build', 'tst-deploy']);
    assert.ok(!fs.existsSync(path.join(skills, 'deploy')), 'old unprefixed copy removed');
    assert.ok(!fs.existsSync(path.join(skills, 'build')));
    const text = fs.readFileSync(path.join(skills, 'tst-deploy', 'SKILL.md'), 'utf8');
    assert.match(text, /^name: tst-deploy$/m);
    assert.ok(text.includes(`${posix(persona)}/.claude/skills/tst-deploy/run.sh`), text);
    assert.ok(text.includes('skill `tst-build`') && text.includes('skillom tst-build'), text);
    assert.ok(text.includes('skill builder'), 'another word is not a mention');
    assert.match(fs.readFileSync(path.join(skills, 'tst-build', 'SKILL.md'), 'utf8'), /^name: tst-build$/m);
    assert.ok(fs.readFileSync(path.join(skills, 'tst-deploy', 'run.sh'), 'utf8').includes(`${posix(persona)}/.claude/skills/tst-build/make.sh`));
    assert.ok(fs.existsSync(path.join(skills, 'tst-build', 'make.sh')), 'script path in the copy exists');
    assert.match(fs.readFileSync(path.join(persona, '.brain', 'skills', 'agentic', 'deploy', 'SKILL.md'), 'utf8'), /^name: deploy$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(skills, GENERATED_MARKER), 'utf8')).generated.sort(), ['tst-build', 'tst-deploy']);
    assert.equal(deployedSkillName(persona, 'deploy'), 'tst-deploy');
    // skill-check of the brain text: the unprefixed path of another skill's script is the deployed prefixed one
    const found = checkSkill({ name: 'deploy', dir: path.join(persona, '.brain', 'skills', 'agentic', 'deploy'), text: fs.readFileSync(path.join(persona, '.brain', 'skills', 'agentic', 'deploy', 'run.sh'), 'utf8').replace(/^/, `---\nname: deploy\ndescription: x\n---\nsh ${posix(persona)}/.claude/skills/build/make.sh\n`), owner: 'agentic', projectDir: persona });
    assert.deepEqual(found.filter((f) => f.level === 'error' && f.code === 'path'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a project that is not a persona keeps the skill names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-'));
  try {
    const project = path.join(root, 'agent-web');
    const brain = path.join(root, 'brain');
    write(path.join(project, '.workflow.json'), JSON.stringify({ brain: '../brain' }));
    brainSkills(brain, project);
    const res = syncBrainSkills({ projectDir: project, brainDir: brain });
    assert.deepEqual(res.copied.sort(), ['build', 'deploy']);
    assert.match(fs.readFileSync(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), 'utf8'), /^name: deploy$/m);
    assert.equal(deployedSkillName(project, 'deploy'), 'deploy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
