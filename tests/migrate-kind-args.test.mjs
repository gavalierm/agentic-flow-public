// ttl: 2026-12-14
// migrate.mjs: an unknown option is refused and --help prints the usage (both ran the preview of the cwd repository);
// a brain without policy.json in layout 1 is a brain, not a project repo (a domain brain previewed 0 moves).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'migrate.mjs');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mka-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
  return dir;
}

const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

const BRAIN = {
  'topics/alpha/topic.json': JSON.stringify({ id: 'alpha', subject: 'Alpha', state: 'working' }) + '\n',
  'decisions/d-0001-first.md': '---\nkey: D-0001\nid: D-0001\ntitle: "First"\nstatus: valid\n---\nText.\n',
  'logs/errors.log': 'x\n',
};

test('--help prints the usage and runs no preview', () => {
  const dir = repo(BRAIN);
  const r = run(dir, '--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--write-triage/);
  assert.doesNotMatch(r.stdout, /repository: /);
});

test('an unknown option is refused with the valid ones listed', () => {
  const dir = repo(BRAIN);
  const r = run(dir, '--aply');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown option --aply/);
  assert.match(r.stderr, /--project, --check, --fix, --apply, --confirmed, --triage, --all, --write-triage/);
  assert.doesNotMatch(r.stdout, /repository: /);
});

test('a brain without policy.json is previewed as a brain with moves', () => {
  const dir = repo(BRAIN);
  const r = run(dir, '.');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(brain, data layout 1\)/);
  assert.doesNotMatch(r.stdout, /moves \(0\)/);
});

test('a project repo with agentic/ stays a project repo', () => {
  const dir = repo({ 'agentic/topics/alpha/topic.json': '{}\n', 'src/a.js': '1\n' });
  const r = run(dir, '.');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(project, data layout 1\)/);
});
