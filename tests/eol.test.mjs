// Line endings (operator 2026-11-08: CRLF/LF differences must not happen): hashes compare LF text, and a project
// repository without a line-ending rule gets `* text=auto eol=lf` and is normalized once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './helpers.mjs';
import { fileHash } from '../scripts/own-files.mjs';
import { lfBytes, ensureLineEndings, hasEolRule, EOL_RULE } from '../scripts/eol.mjs';

const clean = cleanEnv();
const run = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...clean, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x0d, 0x0a]);

function crlfRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eol-'));
  run(dir, 'init', '--quiet', '-b', 'main');
  run(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'one\r\ntwo\r\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), PNG);
  run(dir, 'add', '.');
  run(dir, 'commit', '--quiet', '-m', 'start');
  return dir;
}

test('hash of a file is the same with CRLF and LF line endings; binary content is hashed as it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eol-'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.md'), 'one\r\ntwo\r\n');
  assert.equal(fileHash(path.join(dir, 'b.md')), fileHash(path.join(dir, 'a.md')));
  assert.deepEqual(lfBytes(PNG), PNG);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a repository without a line-ending rule gets .gitattributes eol=lf; CRLF files are stored and checked out as LF', () => {
  const dir = crlfRepo();
  const line = ensureLineEndings(dir, { push: false });
  assert.match(line, /normalized to LF/);
  assert.ok(hasEolRule(dir));
  assert.match(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), new RegExp(`^\\${EOL_RULE}$`, 'm'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'one\ntwo\n');
  assert.equal(run(dir, 'show', 'HEAD:notes.md').stdout, 'one\ntwo\n');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'logo.png')), PNG, 'binary files keep their bytes');
  assert.equal(run(dir, 'status', '--porcelain').stdout, '');
  assert.equal(ensureLineEndings(dir, { push: false }), null, 'once only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uncommitted changes are never staged with the normalization: the repository stays as it is', () => {
  const dir = crlfRepo();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'one\r\ntwo\r\nthree\r\n');
  assert.match(ensureLineEndings(dir, { push: false }), /not normalized \(uncommitted changes\)/);
  assert.ok(!fs.existsSync(path.join(dir, '.gitattributes')));
  assert.equal(run(dir, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
  fs.rmSync(dir, { recursive: true, force: true });
});
