// Directory lock (mkdir is atomic) with a stale limit; a hook waits briefly and gives up, the CLI waits longer.
import fs from 'node:fs';
import path from 'node:path';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const held = new Map();

export class LockBusy extends Error {
  constructor(dir) {
    super(`katalóg je zaneprázdnený (zámok ${dir})`);
    this.code = 'LOCK_BUSY';
  }
}

/** Runs fn under the lock `dir`; throws LockBusy when it could not be taken within waitMs. Re-entrant in one process. */
export function withLock(dir, { waitMs = 1000, staleMs = 10 * 60 * 1000 } = {}, fn) {
  if (held.get(dir) > 0) {
    held.set(dir, held.get(dir) + 1);
    try { return fn(); } finally { held.set(dir, held.get(dir) - 1); }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      try { fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${new Date().toISOString()}\n`); } catch { /* owner is informative */ }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if (age > staleMs) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= waitMs) throw new LockBusy(dir);
      Atomics.wait(sleeper, 0, 0, 30 + Math.floor(Math.random() * 40));
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
