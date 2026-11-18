// ttl: 2026-12-15
// migrate.mjs --apply with --triage and no --confirmed is refused and changes nothing (flow-public#90: the proposals were
// committed as triaz-ostava and the repository marked layout 2).
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'migrate.mjs');
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

test('--apply --triage without --confirmed is refused, nothing committed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mat-'));
  const files = {
    'topics/alpha/topic.json': JSON.stringify({ id: 'alpha', subject: 'Alpha', state: 'working' }) + '\n',
    'decisions/d-0001-first.md': '---\nkey: D-0001\nid: D-0001\ntitle: "First"\nstatus: valid\n---\nText.\n',
    'notes/plan.md': 'plan\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
  const tsv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mat-tsv-')), 'triage.tsv');
  fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\nnotes/plan.md\tstav\talpha\tplan of alpha\n');
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = spawnSync(process.execPath, [BIN, dir, '--apply', '--triage', tsv], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /--confirmed/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(path.join(dir, 'notes/plan.md')));
});
