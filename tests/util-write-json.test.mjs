// ttl: 2026-12-21
// writeJson is atomic (2026-11-21): hooks of one thread run at the same time, and a reader that met the truncated
// file reset the whole thread state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, readJson } from '../scripts/util.mjs';

test('writeJson: a reader that holds the old file still reads all of it; mode kept, no temporary file left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-'));
  const file = path.join(dir, 'state.json');
  writeJson(file, { own_edits: { a: 1 } });
  fs.chmodSync(file, 0o600);
  const fd = fs.openSync(file, 'r'); // a hook that reads while another one writes
  writeJson(file, { own_edits: { a: 1, b: 2 } });
  const seen = fs.readFileSync(fd, 'utf8');
  fs.closeSync(fd);
  assert.deepEqual(JSON.parse(seen), { own_edits: { a: 1 } }); // not '' (the truncated file read as {} before)
  assert.deepEqual(readJson(file), { own_edits: { a: 1, b: 2 } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJson: a symbolic link stays a link and its target gets the data', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-'));
  const target = path.join(dir, 'target.json');
  const link = path.join(dir, 'link.json');
  writeJson(target, { v: 1 });
  fs.symlinkSync(target, link);
  writeJson(link, { v: 2 });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(readJson(target), { v: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});
