// The one directory lock of the flow (mkdir is atomic) with a stale limit: the brain, the own clone, the catalog and the
// thread state serialize their writers with it. Each caller sets how long it waits and when a lock of a dead holder is stale.
import fs from 'node:fs';
import path from 'node:path';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const held = new Map();

export class LockBusy extends Error {
  constructor(dir, ageMs = 0, message = `the lock ${dir} is busy`) {
    super(message);
    this.code = 'LOCK_BUSY';
    this.dir = dir;
    this.age_ms = ageMs;
  }
}

/**
 * Runs the synchronous `fn` under the lock `dir`; throws LockBusy when it could not be taken within waitMs (`busy(dir, ageMs)`
 * gives the message). Re-entrant in one process. `sleepMs` is the base of the pause between attempts (with jitter up to
 * as much again): a lock held for a moment (the thread state) takes a short one. `owner: false` skips the informative
 * owner file, one write less for a lock nobody inspects.
 */
export function withLock(dir, { waitMs = 1000, staleMs = 10 * 60 * 1000, sleepMs = 30, owner = true, busy = null } = {}, fn) {
  if (held.get(dir) > 0) {
    held.set(dir, held.get(dir) + 1);
    try { return fn(); } finally { held.set(dir, held.get(dir) - 1); }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      if (owner) { try { fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`); } catch { /* owner is informative */ } }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if (age > staleMs) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= waitMs) throw new LockBusy(dir, age, busy ? busy(dir, age) : undefined);
      Atomics.wait(sleeper, 0, 0, sleepMs + Math.floor(Math.random() * sleepMs));
    }
  }
  held.set(dir, 1);
  try {
    return fn();
  } finally {
    held.set(dir, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
