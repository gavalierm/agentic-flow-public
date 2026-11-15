// ttl: 2026-12-15
// Mail model pairing (D-0089, D-0090): the workflow declares its mail model (package.json commsModel); the tests take
// the comms checkout only when its model matches, else its newest tag with the model, and fail loudly when none has it.
// Before: the tests took ../agentic-comms dev of model 2 under workflow 1.7.x (model 1) and the mail tests failed (426).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT } from './helpers.mjs';

const PAIR = path.join(PLUGIN_ROOT, 'scripts', 'comms-pair.mjs');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (repo, ...args) => {
  const r = run('git', ['-C', repo, '-c', 'user.name=t', '-c', `user.email=t${'@'}example.invalid`, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** Comms repo: v0.4.20 and v0.4.21 without MAIL_MODEL (model 1), dev with MAIL_MODEL = 2 in src/server/lifecycle.mjs. */
function commsRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-pair-'));
  const repo = path.join(root, 'agentic-comms');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  git(root, 'init', '-q', '-b', 'dev', repo);
  for (const v of ['0.4.20', '0.4.21']) {
    fs.writeFileSync(path.join(repo, 'bin', 'comms.mjs'), `// comms ${v}\n`);
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', v); git(repo, 'tag', `v${v}`);
  }
  fs.mkdirSync(path.join(repo, 'src', 'server'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'server', 'lifecycle.mjs'), 'export const MAIL_MODEL = 2;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'model 2');
  return { root, repo };
}

test('the workflow declares its mail model in package.json', () => {
  const r = run(process.execPath, [PAIR, 'flow-model', PLUGIN_ROOT]);
  assert.equal(r.status, 0, r.stderr);
  const declared = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).commsModel;
  assert.ok(Number.isInteger(declared), 'package.json commsModel');
  assert.equal(r.stdout.trim(), String(declared));
});

test('dev of another model: the newest tag with the workflow model, exported, with a line naming it', () => {
  const { root, repo } = commsRepo();
  const r = run(process.execPath, [PAIR, 'resolve', repo, '--cache', path.join(root, 'cache'), '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^comms: .* v0\.4\.21 .*mail model 1 = workflow model 1.*is model 2/);
  const dir = r.stdout.trim();
  assert.notEqual(dir, repo);
  assert.equal(fs.readFileSync(path.join(dir, 'bin', 'comms.mjs'), 'utf8'), '// comms 0.4.21\n');
  const p = run(process.execPath, [PAIR, 'pick', repo, '1', '--prefer', 'dev']);
  assert.equal(p.stdout.trim(), 'v0.4.21');
});

test('dev of the workflow model: dev itself', () => {
  const { root, repo } = commsRepo();
  const r = run(process.execPath, [PAIR, 'resolve', repo, '--cache', path.join(root, 'cache'), '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), repo);
  assert.match(r.stderr, /working tree .*mail model 2 = workflow model 2/);
});

test('no revision with the model fails loudly', () => {
  const { root, repo } = commsRepo();
  const r = run(process.execPath, [PAIR, 'resolve', repo, '--cache', path.join(root, 'cache'), '3']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no revision .* with mail model 3/);
});

test('the mail tests refuse a mail dir of another model, not test against it', () => {
  const { repo } = commsRepo();
  const model = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).commsModel ?? 1;
  if (model === 2) fs.writeFileSync(path.join(repo, 'src', 'server', 'lifecycle.mjs'), 'export const MAIL_MODEL = 3;\n');
  const code = `import { commsClient } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'tests', 'helpers.mjs'))};
    try { console.log('client ' + commsClient()); } catch (e) { console.log('refused ' + e.message); }`;
  const r = run(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, AGENTIC_COMMS_DIR: repo } });
  assert.match(r.stdout, /^refused .*mail model/, r.stdout + r.stderr);
});
