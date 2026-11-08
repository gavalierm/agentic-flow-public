// P-004, P-034, P-048, P-049: static checks of workflow files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'local']);
const WORKFLOW_DIRS = ['rules', 'skills', 'hooks', 'bin', 'scripts', 'templates', 'agents', 'policy', 'adapters', '.claude-plugin'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const allFiles = walk(PLUGIN_ROOT);
const workflowFiles = [...WORKFLOW_DIRS.flatMap((d) => (fs.existsSync(path.join(PLUGIN_ROOT, d)) ? walk(path.join(PLUGIN_ROOT, d)) : [])), path.join(PLUGIN_ROOT, 'README.md')];

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
