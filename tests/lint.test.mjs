// P-004, P-034, P-048, P-049: static checks of workflow files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, repoFiles } from './helpers.mjs';

const WORKFLOW_DIRS = ['rules', 'skills', 'hooks', 'bin', 'scripts', 'templates', 'agents', 'policy', 'adapters', '.claude-plugin'];

// Only the files git sees (tracked, and untracked that are not ignored): the shared checkout holds ignored deployed persona
// skills with .sh scripts in .claude/skills/, local/ and scratch/ (release v0.9.92 stopped on P-034 there; a clean clone passed).
const allFiles = repoFiles(PLUGIN_ROOT);
const workflowFiles = [...allFiles.filter((f) => WORKFLOW_DIRS.includes(path.relative(PLUGIN_ROOT, f).split(path.sep)[0])), path.join(PLUGIN_ROOT, 'README.md')];

test('static checks scan only the files git sees: ignored .claude/skills/*.sh, local/ and scratch/ of a checkout are left out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-files-'));
  try {
    const put = (rel, text = 'x\n') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('.gitignore', '.claude/skills/\nlocal/\nscratch/\n.workflow.json\n');
    put('bin/tool.mjs');
    put('.claude/skills/fix/test-clone.sh', '#!/bin/sh\n');
    put('local/state.json', '{}');
    put('scratch/old-code-test.sh', '#!/bin/sh\n');
    put('.workflow.json', '{"brain":"../agent-alice"}');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['add', '.gitignore', 'bin/tool.mjs'], { cwd: root }).status, 0);
    put('bin/new.sh', '#!/bin/sh\n');
    const rel = repoFiles(root).map((f) => path.relative(root, f)).sort();
    assert.deepEqual(rel, ['.gitignore', 'bin/new.sh', 'bin/tool.mjs'], 'an untracked file that is not ignored is still checked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P-004: no absolute home paths, emails, local hostname or username in workflow files', () => {
  const forbidden = [/\/home\/\w/, /\/Users\/\w/, /[A-Za-z]:\\(Users|home|[A-Za-z]+\\)/, /\/root\/\w/, /[\w.+-]+@[\w-]+\.[\w.]+/];
  const host = os.hostname();
  const user = os.userInfo().username;
  const generic = ['root', 'user', 'admin', 'runner', 'node', 'agent'];
  const hits = [];
  for (const f of workflowFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) if (re.test(text)) hits.push(`${path.relative(PLUGIN_ROOT, f)}: ${re}`);
    if (host.length > 3 && text.includes(host)) hits.push(`${path.relative(PLUGIN_ROOT, f)}: hostname`);
    if (user.length > 3 && !generic.includes(user) && new RegExp(`\\b${user}\\b`).test(text)) hits.push(`${path.relative(PLUGIN_ROOT, f)}: username`);
  }
  assert.deepEqual(hits, []);
});

test('P-034: no shell or python scripts, hook commands start with node', () => {
  const bad = allFiles.filter((f) => /\.(sh|ps1|py|bash|zsh|bat|cmd)$/.test(f)).map((f) => path.relative(PLUGIN_ROOT, f));
  assert.deepEqual(bad, []);
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      assert.equal(h.type, 'command', `${event}: type`);
      assert.ok(h.command === 'node' || h.command.startsWith('node '), `${event}: command must start with node`);
      if (h.args) assert.ok(h.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/'), `${event}: script via CLAUDE_PLUGIN_ROOT`);
    }
  }
});

test('P-048: manifest name workflow, defaultEnabled false, no version field', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'workflow');
  assert.equal(m.defaultEnabled, false);
  assert.equal(m.version, undefined);
});

test('P-049: file and directory names are ascii, lowercase (README/SKILL/PLAN/PRINCIPLES and principles/P-NNN.md allowed), no spaces', () => {
  const bad = allFiles.map((f) => path.relative(PLUGIN_ROOT, f)).filter((rel) => {
    const base = path.basename(rel);
    if (/^((README|SKILL|PLAN|PRINCIPLES|CLAUDE|SNAPSHOT)\.md|LICENSE)$/.test(base)) return false;
    if (/^docs\/principles\/P-\d{3}\.md$/.test(rel)) return false;
    return /[^\x00-\x7F]/.test(rel) || /\s/.test(rel) || /[A-Z]/.test(rel.replace(/\/(README|SKILL)\.md$/, ''));
  });
  assert.deepEqual(bad, []);
});

test('P-049: frontmatter fields of skills and agents are english lowercase; descriptions within limit', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policy', 'policy.json'), 'utf8'));
  const files = allFiles.filter((f) => /(skills\/[^/]+\/SKILL\.md|agents\/[^/]+\.md)$/.test(f) && path.basename(f) !== 'README.md');
  assert.ok(files.length >= 10);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const fm = text.split('\n---')[0];
    for (const line of fm.split('\n').slice(1)) {
      const key = /^([^:\s]+):/.exec(line)?.[1];
      // Harness-defined agent fields are camelCase (omitClaudeMd); our own fields stay lowercase. No diacritics anywhere.
      if (key) assert.match(key, /^[a-z][a-zA-Z0-9-]*$/, `${path.relative(PLUGIN_ROOT, f)}: ${key}`);
    }
    const desc = /^description:\s*(.*)$/m.exec(fm)?.[1] || '';
    assert.ok(desc.length > 0 && desc.length <= policy.limits.skill_description_chars, `${path.relative(PLUGIN_ROOT, f)}: description ${desc.length} chars`);
  }
});

test('P-061: no skill says the hook denies AskUserQuestion (a question to the operator goes in the dialog, operator 2026-11-08)', () => {
  for (const s of fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'))) {
    const f = path.join(PLUGIN_ROOT, 'skills', s, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.includes('AskUserQuestion')) assert.doesNotMatch(line, /zamietne|zakázan/, `skills/${s}/SKILL.md: ${line.slice(0, 120)}`);
    }
  }
});

test('P-029: every base skill has SKILL.md and a script in bin/', () => {
  for (const s of ['save', 'error', 'done', 'consolidate', 'delegate', 'find', 'topic', 'comms', 'check', 'project']) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'skills', s, 'SKILL.md')), `skills/${s}/SKILL.md`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'bin', `${s}.mjs`)), `bin/${s}.mjs`);
  }
});
