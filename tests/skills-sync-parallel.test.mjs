// ttl: 2026-12-22
// Error report doma-pc 2026-11-22: a brain skill was missing in .claude/skills of the project. The threads of a project
// deploy into one folder at the same time (session start, save.mjs skill); a sync removed every copy and copied all again
// without a lock, so two of them failed in each other's files and a skill did not exist while a sync ran.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBrainSkills } from '../scripts/skills-sync.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `skill-${n}`);

test('syncs of one project at the same time: none fails, every skill stays in place; only a changed skill is deployed again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-'));
  try {
    const brain = path.join(root, 'brain');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    for (const n of NAMES) for (const f of ['SKILL.md', 'run.mjs', 'lib/data.json']) write(path.join(brain, 'skills', 'agentic', n, f), `${n} ${f}\n`);
    const deployed = (n, f = 'SKILL.md') => path.join(project, '.claude', 'skills', n, f);
    syncBrainSkills({ projectDir: project, brainDir: brain });
    const sync = pathToFileURL(path.resolve('scripts/skills-sync.mjs')).href;
    const code = `const { syncBrainSkills } = await import(${JSON.stringify(sync)}); for (let i = 0; i < 8; i++) syncBrainSkills({ projectDir: process.argv[1], brainDir: process.argv[2] });`;
    let absent = 0;
    const reader = setInterval(() => { for (const n of NAMES) if (!fs.existsSync(deployed(n)) || !fs.existsSync(deployed(n, 'lib/data.json'))) absent += 1; }, 1);
    // A change of one source during the syncs, as save.mjs skill of another thread makes it.
    setTimeout(() => fs.writeFileSync(path.join(brain, 'skills', 'agentic', 'skill-c', 'SKILL.md'), 'skill-c changed\n'), 20);
    const codes = await Promise.all([1, 2, 3].map(() => new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', code, project, brain], { stdio: 'inherit' }).on('exit', resolve))));
    clearInterval(reader);
    assert.deepEqual(codes, [0, 0, 0]);
    assert.equal(absent, 0);
    const before = fs.statSync(deployed('skill-a')).ino;
    const res = syncBrainSkills({ projectDir: project, brainDir: brain });
    assert.deepEqual(res.warnings, []);
    assert.equal(fs.readFileSync(deployed('skill-c'), 'utf8'), 'skill-c changed\n');
    assert.equal(fs.statSync(deployed('skill-a')).ino, before); // an unchanged skill is not copied again
    assert.deepEqual(fs.readdirSync(path.join(project, '.claude', 'skills')).sort(), ['.workflow-generated.json', ...NAMES]);
    // A skill removed from the brain leaves; a hand-written folder that gets a brain skill of its name keeps its other files.
    fs.rmSync(path.join(brain, 'skills', 'agentic', 'skill-f'), { recursive: true });
    write(deployed('own', 'notes.txt'), 'mine\n');
    write(path.join(brain, 'skills', 'agentic', 'own', 'SKILL.md'), 'own from brain\n');
    assert.deepEqual(syncBrainSkills({ projectDir: project, brainDir: brain }).removed, ['skill-f']);
    assert.equal(fs.existsSync(deployed('skill-f')), false);
    assert.equal(fs.readFileSync(deployed('own'), 'utf8'), 'own from brain\n');
    assert.equal(fs.readFileSync(deployed('own', 'notes.txt'), 'utf8'), 'mine\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
