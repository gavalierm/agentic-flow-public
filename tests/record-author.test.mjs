// Record author (scripts/authors.mjs): the author of the commit that added the record file; records of another operator are
// marked [by <name>] at session start and in find, their operator memory is one count line and save does not overwrite it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, memoryRecord } from './helpers.mjs';
import { recordAuthors, foreignAuthor, sameIdentity, localIdentity } from '../scripts/authors.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { BOOT_MARKERS } from '../scripts/boot.mjs';

const mail = (name) => `${name}${'@'}example.test`;
const ONE = { name: 'op-one', email: mail('op-one') };
const TWO = { name: 'op-two', email: mail('op-two') };
// Without the env identity of the test helpers (GIT_AUTHOR_*), so `-c user.*` decides the author.
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));
// Runs of the workflow scripts commit as op-one, the identity of this machine.
const asOne = { env: { GIT_AUTHOR_NAME: ONE.name, GIT_AUTHOR_EMAIL: ONE.email, GIT_COMMITTER_NAME: ONE.name, GIT_COMMITTER_EMAIL: ONE.email } };

function git(cwd, args, env = gitEnv()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Write `files` ({ rel: content }) into the brain and commit them as `who`. */
function commitAs(fx, who, files, msg = 'save') {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(fx.brain, rel)), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, rel), content);
  }
  git(fx.brain, ['add', '-A', '--', ...Object.keys(files)]);
  git(fx.brain, ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, 'commit', '-q', '--no-verify', '-m', `[brain-script] ${msg}`]);
}

/** Brain whose machine identity is op-one. */
function sharedBrain() {
  const fx = setup();
  git(fx.brain, ['config', 'user.name', ONE.name]);
  git(fx.brain, ['config', 'user.email', ONE.email]);
  return fx;
}

const rule = (title, body) => `---\nkey: rule-${title}\ntitle: ${title}\nenforced_by: [README.md]\n---\n${body}\n`;
const decision = (id, title) => `---\nkey: ${id}\nid: ${id}\ntitle: ${title}\nstatus: valid\nrelates_to: [src/app.js]\n---\nbody\n`;
const section = (text, marker) => text.split(`${marker}\n`)[1].split('\n\n## ')[0];

test('author = author of the commit that added the file: a later edit keeps it, a moved file has its new addition, an uncommitted file is own', () => {
  const fx = sharedBrain();
  try {
    commitAs(fx, TWO, { 'memory/project-alpha.md': memoryRecord('project-alpha', 'a'), 'memory/service-beta.md': memoryRecord('service-beta', 'b') });
    commitAs(fx, ONE, { 'memory/project-alpha.md': memoryRecord('project-alpha', 'edited by one') }, 'edit');
    git(fx.brain, ['mv', 'memory/service-beta.md', 'memory/service-gamma.md']);
    git(fx.brain, ['-c', `user.name=${ONE.name}`, '-c', `user.email=${ONE.email}`, 'commit', '-q', '--no-verify', '-m', '[brain-script] move']);
    fs.writeFileSync(path.join(fx.brain, 'memory', 'tool-delta.md'), memoryRecord('tool-delta', 'd'));
    const a = recordAuthors(fx.brain);
    assert.deepEqual(a.me, ONE);
    assert.equal(foreignAuthor(a, 'memory/project-alpha.md'), 'op-two', 'the edit by op-one does not change the author');
    assert.equal(foreignAuthor(a, 'memory/service-gamma.md'), null, 'moved by op-one: added by op-one (--no-renames)');
    assert.equal(foreignAuthor(a, 'memory/tool-delta.md'), null, 'not committed: this machine');
    assert.equal(a.files.has('memory/tool-delta.md'), false);
    // narrowed log (save): the same author
    assert.equal(foreignAuthor(recordAuthors(fx.brain, { paths: ['memory/project-alpha.md'] }), 'memory/project-alpha.md'), 'op-two');
  } finally { fx.cleanup(); }
});

test('identity match: the same e-mail when both have one, else the same name; without a local identity nothing is foreign', () => {
  assert.equal(sameIdentity({ name: 'x', email: mail('A') }, { name: 'y', email: mail('a') }), true, 'e-mail wins over the name');
  assert.equal(sameIdentity({ name: 'op-one', email: mail('one') }, { name: 'op-one', email: mail('two') }), false);
  assert.equal(sameIdentity({ name: 'op-one', email: '' }, { name: 'op-one', email: mail('one') }), true, 'name when one side has no e-mail');
  assert.equal(sameIdentity({ name: 'op-one', email: '' }, { name: 'op-two', email: mail('one') }), false);
  const fx = sharedBrain();
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  try {
    commitAs(fx, { name: 'op-one', email: mail('other-box') }, { 'memory/project-alpha.md': memoryRecord('project-alpha') });
    commitAs(fx, TWO, { 'memory/project-beta.md': memoryRecord('project-beta') });
    // same name, another e-mail: foreign while this machine has an e-mail
    assert.equal(foreignAuthor(recordAuthors(fx.brain), 'memory/project-alpha.md'), 'op-one');
    // only a name here: the name decides
    const empty = path.join(fx.root, 'empty-gitconfig');
    fs.writeFileSync(empty, '');
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    git(fx.brain, ['config', '--unset', 'user.email']);
    assert.deepEqual(localIdentity(fx.brain), { name: 'op-one', email: '' });
    let a = recordAuthors(fx.brain);
    assert.equal(foreignAuthor(a, 'memory/project-alpha.md'), null);
    assert.equal(foreignAuthor(a, 'memory/project-beta.md'), 'op-two');
    // no identity at all: nothing is foreign
    git(fx.brain, ['config', '--unset', 'user.name']);
    a = recordAuthors(fx.brain);
    assert.equal(a.me, null);
    assert.equal(foreignAuthor(a, 'memory/project-beta.md'), null);
  } finally {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fx.cleanup();
  }
});

test('session start, one author: the indexes and the rules read as before, no [by]', () => {
  const fx = sharedBrain();
  try {
    commitAs(fx, ONE, {
      'memory/operator-op-one.md': memoryRecord('operator-op-one', 'prefers short replies'),
      'memory/project-alpha.md': memoryRecord('project-alpha', 'alpha'),
      'decisions/d-0001-pick-a.md': decision('D-0001', 'Pick A'),
      'rules/one-rule.md': rule('one-rule', 'MUST keep one'),
    });
    const r = fx.hook('session-start.mjs', { source: 'startup' }, asOne);
    assert.equal(r.status, 0, r.stderr);
    const idx = buildIndexes(fx.brain, {});
    assert.equal(section(r.context, BOOT_MARKERS[2]), idx.text.memory.trim());
    assert.equal(section(r.context, BOOT_MARKERS[3]), idx.text.decisions.trim());
    assert.equal(section(r.context, BOOT_MARKERS[2]), '- operator-op-one: prefers short replies\n- project-alpha: alpha');
    const rules = fx.hook('session-start-rules.mjs', { source: 'startup' }, { ...asOne, args: ['1'] }).context;
    assert.match(rules, /### one-rule\nMUST keep one/);
    assert.doesNotMatch(r.context + rules, /\[by |foreign operator memory/);
  } finally { fx.cleanup(); }
});

test('session start, two authors: foreign operator memory is one line, other foreign records and rules carry [by]', () => {
  const fx = sharedBrain();
  try {
    commitAs(fx, TWO, {
      'memory/operator-op-two.md': memoryRecord('operator-op-two', 'likes long replies'),
      'memory/operator-op-two-tools.md': memoryRecord('operator-op-two-tools', 'uses tool z'),
      'memory/project-beta.md': memoryRecord('project-beta', 'beta'),
      'decisions/d-0001-pick-b.md': decision('D-0001', 'Pick B'),
      'rules/two-rule.md': rule('two-rule', 'MUST keep two'),
    });
    commitAs(fx, ONE, { 'memory/operator-op-one.md': memoryRecord('operator-op-one', 'prefers short replies'), 'rules/one-rule.md': rule('one-rule', 'MUST keep one') });
    const r = fx.hook('session-start.mjs', { source: 'startup' }, asOne);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(section(r.context, BOOT_MARKERS[2]), [
      '- operator-op-one: prefers short replies',
      '- project-beta: beta [by op-two]',
      "foreign operator memory (other operators' preferences, not yours): 2 [by op-two]",
    ].join('\n'));
    assert.doesNotMatch(r.context, /likes long replies|uses tool z/);
    assert.equal(section(r.context, BOOT_MARKERS[3]), '- D-0001: Pick B [by op-two]');
    const rules = [1, 2].map((p) => fx.hook('session-start-rules.mjs', { source: 'startup' }, { ...asOne, args: [String(p)] }).context).join('\n');
    assert.match(rules, /### one-rule\nMUST keep one/);
    assert.match(rules, /### two-rule \[by op-two\]\nMUST keep two/, 'a project rule applies to every operator, marked');
    // The rules hash stays that of the rules without authors: the next prompt injects nothing again.
    const p = fx.hook('user-prompt-submit.mjs', { prompt: 'hello' }, asOne);
    assert.equal(p.status, 0, p.stderr);
    assert.doesNotMatch(p.context, /## Pravidlá/);
  } finally { fx.cleanup(); }
});

test('find marks a record of another operator with [by]; own and uncommitted records are unmarked', () => {
  const fx = sharedBrain();
  try {
    commitAs(fx, TWO, { 'memory/project-beta.md': memoryRecord('project-beta', 'beta') });
    commitAs(fx, ONE, { 'memory/project-alpha.md': memoryRecord('project-alpha', 'alpha') });
    let r = fx.run('find.mjs', ['project-beta'], asOne);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout, 'memory/project-beta.md: beta [by op-two]\n');
    r = fx.run('find.mjs', ['project-alpha'], asOne);
    assert.equal(r.stdout, 'memory/project-alpha.md: alpha\n');
    const json = JSON.parse(fx.run('find.mjs', ['project-beta', '--json'], asOne).stdout);
    assert.equal(json[0].by, 'op-two');
    assert.equal(JSON.parse(fx.run('find.mjs', ['project-alpha', '--json'], asOne).stdout)[0].by, undefined);
  } finally { fx.cleanup(); }
});

test('save: operator memory of another operator is not overwritten; a foreign project record is, with a record by line', () => {
  const fx = sharedBrain();
  try {
    commitAs(fx, TWO, { 'memory/operator-op-two.md': memoryRecord('operator-op-two', 'likes long replies'), 'memory/project-beta.md': memoryRecord('project-beta', 'beta') });
    commitAs(fx, ONE, { 'memory/project-alpha.md': memoryRecord('project-alpha', 'alpha') });
    git(fx.brain, ['push', '-q', 'origin', 'HEAD']);
    let r = fx.run('save.mjs', ['memory', 'operator', 'op-two', '--content', 'likes tables'], asOne);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /operator-op-two is the operator memory of op-two/);
    assert.match(r.stderr, /save memory operator <your-name>/);
    assert.match(fx.read('memory/operator-op-two.md'), /likes long replies/, 'unchanged');
    r = fx.run('save.mjs', ['memory', 'project', 'beta', '--content', 'beta v2'], asOne);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^record by op-two$/m);
    assert.match(fx.read('memory/project-beta.md'), /beta v2/);
    r = fx.run('save.mjs', ['memory', 'project', 'alpha', '--content', 'alpha v2'], asOne);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /record by/);
    r = fx.run('save.mjs', ['memory', 'operator', 'op-one', '--content', 'prefers short replies', '--new'], asOne);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /record by/);
  } finally { fx.cleanup(); }
});
