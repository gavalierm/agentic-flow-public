// ttl: 2026-12-14
// D-0065 hotfix (v1.6.0 deploy 2026-11-14): a deployed persona skill kept paths to the old unprefixed skill folders in the
// forms "$H/<repo>/.claude/skills/<name>", "$HOME/...", "~/...", a relative ".claude/skills/<name>" and the persona repo
// under another root, so scripts and cron failed. Every reference to an own skill folder of the persona is rewritten;
// another project's skills and a name that is not an own skill stay. The deploy warns about crontab lines with an old path.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prefixSkillText, crontabSkillWarnings, crontabSkillNotes, syncBrainSkills } from '../scripts/skills-sync.mjs';

const projectDir = '/srv/agents/Team/agent-tst';
const opts = { projectDir, prefix: 'tst-', names: ['issues', 'pilot-sync', 'work-files'] };

test('every form of a path to an own skill folder of the persona gets the prefix', () => {
  const cases = [
    ['SELF=$H/agent-tst/.claude/skills/pilot-sync/pilot.sh', 'SELF=$H/agent-tst/.claude/skills/tst-pilot-sync/pilot.sh'],
    ['node $HOME/agentic/Team/agent-tst/.claude/skills/work-files/print-work-dir.mjs', 'node $HOME/agentic/Team/agent-tst/.claude/skills/tst-work-files/print-work-dir.mjs'],
    ['sh ~/agentic/Team/agent-tst/.claude/skills/issues/watch.sh', 'sh ~/agentic/Team/agent-tst/.claude/skills/tst-issues/watch.sh'],
    ['sh .claude/skills/issues/watch.sh', 'sh .claude/skills/tst-issues/watch.sh'],
    ['sh ./.agents/skills/issues/watch.sh', 'sh ./.agents/skills/tst-issues/watch.sh'],
    ['cd /other/base/agent-tst/.claude/skills/issues && ls', 'cd /other/base/agent-tst/.claude/skills/tst-issues && ls'],
    ['D="$H/agent-tst/.claude/skills/issues"', 'D="$H/agent-tst/.claude/skills/tst-issues"'],
    ["D='.claude/skills/work-files'", "D='.claude/skills/tst-work-files'"],
    ['priečinok `.claude/skills/issues`', 'priečinok `.claude/skills/tst-issues`'],
    [`sh ${projectDir}/.claude/skills/issues/watch.sh`, `sh ${projectDir}/.claude/skills/tst-issues/watch.sh`],
    ['node "$here/../work-files/print-work-dir.mjs"', 'node "$here/../tst-work-files/print-work-dir.mjs"'],
    ['work=$(node "$(cd "$(dirname "$0")/.." && pwd)/work-files/print-work-dir.mjs")', 'work=$(node "$(cd "$(dirname "$0")/.." && pwd)/tst-work-files/print-work-dir.mjs")'],
  ];
  for (const [from, to] of cases) assert.equal(prefixSkillText(from, opts), to, from);
});

test('another project, a name that is not an own skill and a longer name stay unchanged', () => {
  for (const text of [
    'sh $H/agent-bob/.claude/skills/issues/watch.sh',
    'sh /srv/agents/Team/agentic-flow/.claude/skills/issues/watch.sh',
    'sh $H/agent-tst/.claude/skills/beszel-api/x.sh',
    'sh .claude/skills/issues-old/watch.sh',
    'sh lib/.claude/skills/issues/watch.sh',
    'sh $H/not-agent-tst/.claude/skills/issues/watch.sh',
  ]) assert.equal(prefixSkillText(text, opts), text, text);
});

test('crontab lines naming an old skill path of the persona are reported old -> new, others not', () => {
  const crontab = [
    '# m h dom mon dow command',
    `*/5 * * * * sh ${projectDir}/.claude/skills/issues/watch.sh >> log 2>&1`,
    `0 3 * * * sh ${projectDir}/.claude/skills/tst-issues/watch.sh`,
    '0 4 * * * sh /srv/agents/Team/agent-bob/.claude/skills/issues/watch.sh',
  ].join('\n');
  const warnings = crontabSkillWarnings(crontab, opts);
  assert.deepEqual(warnings, [`crontab line 2: ${projectDir}/.claude/skills/issues/ -> ${projectDir}/.claude/skills/tst-issues/ (skill renamed by the persona prefix, D-0065; crontab not changed)`]);
  assert.deepEqual(crontabSkillWarnings(crontab, { ...opts, prefix: '' }), []);
});

test('deploy notes read the OS user crontab and never write it; no crontab gives no note', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: `* * * * * sh ${projectDir}/.claude/skills/issues/watch.sh\n` }; };
  const notes = crontabSkillNotes(projectDir, { prefix: 'tst-', renamed: ['issues'] }, run);
  assert.equal(notes.length, 1); assert.match(notes[0], /skills\/issues\/ -> .*skills\/tst-issues\//);
  assert.deepEqual(calls, [['crontab', '-l']]);
  assert.deepEqual(crontabSkillNotes(projectDir, { prefix: 'tst-', renamed: ['issues'] }, () => ({ status: 1, stdout: '' })), []);
  assert.deepEqual(crontabSkillNotes(projectDir, { prefix: '', renamed: [] }, run), []);
});

// ttl: 2026-12-15
// D-0065 (alice-fix test-clone.sh, spec-check.sh 2026-11-15): a variable holding the skills folder,
// skills=$(dirname "$(dirname "$self")") and "$skills/multi-replace/replace.mjs", kept the unprefixed folder silently.
test('a path through a variable gets the prefix when the file is in that own skill; the GitHub API path stays', () => {
  const files = new Map([['multi-replace', new Set(['replace.mjs'])], ['work-files', new Set(['x.mjs'])], ['issues', new Set(['watch.sh'])]]);
  const o = { ...opts, names: [...opts.names, 'multi-replace'], files };
  for (const [from, to] of [
    ['node "$skills/multi-replace/replace.mjs" a', 'node "$skills/tst-multi-replace/replace.mjs" a'],
    ['node ${skills}/work-files/x.mjs', 'node ${skills}/tst-work-files/x.mjs'],
    ['api "repos/$r/issues/$n/comments"', 'api "repos/$r/issues/$n/comments"'],
    ['api "${repo}/issues/comments"', 'api "${repo}/issues/comments"'],
  ]) assert.equal(prefixSkillText(from, o), to, from);
});

test('deploy warns about a variable path to an unprefixed own skill folder it could not rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psv-'));
  try {
    const persona = path.join(root, 'agent-tst');
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(persona, rel)), { recursive: true }); fs.writeFileSync(path.join(persona, rel), text); };
    put('.workflow.json', JSON.stringify({ brain: '.' }));
    put('.brain/policy.json', JSON.stringify({ data_layout: 2 }));
    put('.brain/skills/agentic/work-files/SKILL.md', '---\nname: work-files\ndescription: Použi pri súboroch.\n---\nx\n');
    put('.brain/skills/agentic/work-files/x.mjs', 'console.log(1)\n');
    put('.brain/skills/agentic/fix/SKILL.md', '---\nname: fix\ndescription: Použi pri oprave.\n---\nx\n');
    put('.brain/skills/agentic/fix/run.sh', '#!/bin/sh\nskills=$(dirname "$(dirname "$0")")\nnode "$skills/work-files/x.mjs"\nnode "$skills"/work-files/x.mjs\n');
    const res = syncBrainSkills({ projectDir: persona, brainDir: persona });
    const run = fs.readFileSync(path.join(persona, '.claude', 'skills', 'tst-fix', 'run.sh'), 'utf8');
    assert.ok(run.includes('"$skills/tst-work-files/x.mjs"'), run);
    assert.deepEqual(res.warnings, ['skill tst-fix: run.sh:4 path $skills"/work-files/x.mjs has no folder (D-0065)']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
