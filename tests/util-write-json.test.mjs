// ttl: 2026-12-21
// writeJson is atomic (2026-11-21): hooks of one thread run at the same time, and a reader that met the truncated
// file reset the whole thread state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeJson, readJson } from '../scripts/util.mjs';
import { readThreadState, updateThreadState, threadStateFile } from '../scripts/config.mjs';

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

// 2026-11-22: a change of the thread state is a read and a write; hooks of parallel tool calls lost each other's change.
test('updateThreadState: writers of one thread at the same time lose no change; a lock of a killed process is taken over', async () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const config = pathToFileURL(path.resolve('scripts/config.mjs')).href;
  const code = `const { updateThreadState } = await import(${JSON.stringify(config)}); for (let i = 0; i < 25; i++) updateThreadState(process.argv[1], 't1', (s) => ({ ...s, n: (s.n || 0) + 1, list: [...(s.list || []), process.argv[2] + ':' + i] }));`;
  const codes = await Promise.all(['a', 'b', 'c', 'd'].map((w) => new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', code, brain, w], { stdio: 'inherit' }).on('exit', resolve))));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const state = readThreadState(brain, 't1');
  assert.equal(state.n, 100);
  assert.equal(new Set(state.list).size, 100);
  // A lock left by a killed process (older than the stale limit) does not hold the next writer.
  const lock = `${threadStateFile(brain, 't1')}.lock`;
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const started = Date.now();
  assert.equal(updateThreadState(brain, 't1', (s) => ({ ...s, n: s.n + 1 })).n, 101);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['t1.json']);
  fs.rmSync(brain, { recursive: true, force: true });
});
