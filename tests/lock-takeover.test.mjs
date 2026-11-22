// keep: guarded
// The lock of a holder that died is taken at once and the caller is told (audit 2026-11-22: the brain lock of a killed
// hook blocked every script for 120 s; a pid that another program got counted as the holder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withLock, LockBusy } from '../scripts/lock.mjs';

test('a dead holder gives the lock up at once, a live one keeps it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-lock-'));
  const dir = path.join(root, 'x.lock');
  const hold = (note) => { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify(note)); };
  const opts = { waitMs: 300, staleMs: 120000 };
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    // the process is gone
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    hold({ pid: gone, at: new Date().toISOString() });
    let started = Date.now();
    assert.equal(withLock(dir, opts, (info) => info.orphan.pid), gone);
    assert.ok(Date.now() - started < 250, 'no wait for the stale limit');
    assert.equal(fs.existsSync(dir), false, 'released');
    // the pid lives, but in a process younger than the note: another program got it
    hold({ pid: child.pid, at: new Date(Date.now() - 60000).toISOString() });
    assert.equal(withLock(dir, opts, (info) => info.orphan.pid), child.pid);
    // the holder runs: the lock is busy
    await new Promise((r) => setTimeout(r, 30));
    hold({ pid: child.pid, at: new Date().toISOString() });
    assert.throws(() => withLock(dir, opts, () => 1), LockBusy);
    // a lock without a note (the holder died before it wrote one) goes by its age
    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    assert.throws(() => withLock(dir, opts, () => 1), LockBusy);
    assert.equal(withLock(dir, { waitMs: 300, staleMs: 1 }, (info) => info.orphan), null);
  } finally { child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
});
