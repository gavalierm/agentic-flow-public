// ttl: 2026-12-15
// Bug 2026-11-15 (D-0065 follow-up): the persona brain is also the skill source of domain repos that are not personas
// (agentic-flow, agentic-comms). Their copies kept absolute paths <persona project>/.claude/skills/<name>/ while the persona
// deploys that skill as <persona>-<name>/, so `resolve.sh: No such file`. No copy may point to a missing skill folder.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBrainSkills } from '../scripts/skills-sync.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const posix = (p) => p.split(path.sep).join('/');

function personaBrain(persona) {
  const p = posix(persona);
  write(path.join(persona, '.workflow.json'), JSON.stringify({ brain: '.' }));
  write(path.join(persona, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
  const skill = path.join(persona, '.brain', 'skills', 'agentic');
  write(path.join(skill, 'issues', 'SKILL.md'), [
    '---', 'name: issues', 'description: Použi pri issues.', '---',
    `1. Spusti \`sh ${p}/.claude/skills/issues/resolve.sh\`.`,
    '2. Alebo `sh $H/agent-tst/.claude/skills/issues/resolve.sh`, `sh $HOME/x/agent-tst/.claude/skills/issues/resolve.sh`, `sh ~/x/agent-tst/.agents/skills/issues/resolve.sh`.',
    '3. Potom skill `fix`.', '',
  ].join('\n'));
  write(path.join(skill, 'issues', 'resolve.sh'), '#!/bin/sh\necho ok\n');
  write(path.join(skill, 'fix', 'SKILL.md'), `---\nname: fix\ndescription: Použi pri oprave.\n---\nSpusti \`sh ${p}/.claude/skills/fix/run.sh\`.\n`);
  write(path.join(skill, 'fix', 'run.sh'), `#!/bin/sh\nsh "${p}/.claude/skills/issues/resolve.sh"\n`);
}

/** Every path to a skill folder in the copies: the persona repo segment (any root) or a literal absolute path. */
function skillPaths(dir, persona) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name.startsWith('.')) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/([^\s"'`]*?)\/\.(claude|agents)\/skills\/([\w-]+)\//g)) {
        const base = m[1].endsWith('/agent-tst') ? posix(persona) : m[1];
        out.push({ file: f, ref: m[0], folder: `${base}/.${m[2]}/skills/${m[3]}` });
      }
    }
  };
  walk(dir);
  return out;
}

test('copies of persona skills in the persona project and in a non-persona domain project point to existing skill folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-'));
  try {
    const persona = path.join(root, 'Dom', 'agent-tst');
    const domain = path.join(root, 'Dom', 'agentic-flow');
    personaBrain(persona);
    write(path.join(domain, '.workflow.json'), JSON.stringify({ brain: '../agent-tst', domain: '..' }));
    syncBrainSkills({ projectDir: persona, brainDir: persona });
    // the persona also has a Codex copy (.agents/skills) so the ~ form has a target in the persona project
    syncBrainSkills({ projectDir: persona, brainDir: persona, harness: 'codex' });
    const res = syncBrainSkills({ projectDir: domain, brainDir: persona });
    assert.deepEqual(res.copied.sort(), ['fix', 'issues']);
    for (const [project, dir] of [[persona, '.claude/skills'], [domain, '.claude/skills']]) {
      const refs = skillPaths(path.join(project, dir), persona);
      assert.ok(refs.length >= 5, `${project}: ${refs.length} paths found`);
      for (const r of refs) assert.ok(fs.existsSync(r.folder), `${r.file}: ${r.ref} -> missing ${r.folder}`);
    }
    const issues = fs.readFileSync(path.join(domain, '.claude', 'skills', 'issues', 'SKILL.md'), 'utf8');
    // names stay plain in the domain project; paths into the persona repo name the folder the persona deploys
    assert.ok(issues.includes(`sh ${posix(persona)}/.claude/skills/tst-issues/resolve.sh`), issues);
    assert.ok(issues.includes('$H/agent-tst/.claude/skills/tst-issues/') && issues.includes('~/x/agent-tst/.agents/skills/tst-issues/'), issues);
    assert.ok(issues.includes('skill `fix`'), 'a mention keeps the name deployed in this project');
    assert.match(issues, /^name: issues$/m);
    assert.ok(fs.readFileSync(path.join(domain, '.claude', 'skills', 'fix', 'run.sh'), 'utf8').includes(`"${posix(persona)}/.claude/skills/tst-issues/resolve.sh"`));
    // the brain keeps its text
    assert.ok(fs.readFileSync(path.join(persona, '.brain', 'skills', 'agentic', 'issues', 'SKILL.md'), 'utf8').includes(`${posix(persona)}/.claude/skills/issues/resolve.sh`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
