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
      if (!taken(err)) throw err;
      let age = null;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { /* released meanwhile */ }
      if (age !== null && age > staleMs && remove(dir)) continue;
      if (Date.now() - started >= waitMs) throw new LockBusy(dir, age ?? 0, busy ? busy(dir, age ?? 0) : undefined);
      // Released between the two calls: take it at once. Windows (EPERM, the folder is still going away) waits a moment.
      if (age === null && err.code === 'EEXIST') continue;
      Atomics.wait(sleeper, 0, 0, sleepMs + Math.floor(Math.random() * sleepMs));
    }
  }
  held.set(dir, 1);
  try {
    return fn();
  } finally {
    held.set(dir, 0);
    remove(dir);
  }
}

// Windows reports a folder that another process is just removing (delete pending) as EPERM or EACCES, not EEXIST: for
// the next writer it is a held lock, not an error (a hook must not fail on it).
const taken = (err) => err.code === 'EEXIST' || (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES'));

/** Removes the lock folder; false when the system refuses (Windows: another process looks at it): it then goes stale. */
function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }); return true; } catch { return false; }
}
