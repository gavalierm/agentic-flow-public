// The one directory lock of the flow (mkdir is atomic) with a stale limit: the brain, the own clone, the catalog and the
// thread state serialize their writers with it. Each caller sets how long it waits and when a lock of a dead holder is stale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

// Who wrote a lock or a note, and whether that process still runs. A pid alone does not say: after a restart, and on
// Windows within minutes, it belongs to another program (audit 2026-11-22: a note with a pid that lived again was never
// settled). So the writer also notes the minute the machine started and its own time; the process that holds the pid
// now is the writer only when it is older than the note.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const bootMinute = () => Math.round((Date.now() - os.uptime() * 1000) / 60000);
const NOTE_LIVE_MS = 10 * 60 * 1000;
export const stamp = () => ({ pid: process.pid, boot: bootMinute(), at: new Date().toISOString() });
// The start of a pid does not change while it lives: asked once per process (Windows asks PowerShell, about half a second).
const starts = new Map();
/** When the process with this pid started (ms), or null when the system does not say. */
function startedAt(pid) {
  if (starts.has(pid)) return starts.get(pid);
  let at = null;
  try {
    if (process.platform === 'linux') {
      // Field 22 of /proc/<pid>/stat: the start in ticks (100 a second) after the boot. The boot comes from the uptime:
      // btime of /proc/stat is cut to a second, which made a process of up to a second after the note look older.
      const ticks = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[19]);
      at = Number.isFinite(ticks) ? Date.now() - os.uptime() * 1000 + ticks * 10 : null;
    } else {
      const r = process.platform === 'win32'
        ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
        : spawnSync('ps', ['-p', String(Number(pid)), '-o', 'lstart='], { encoding: 'utf8', timeout: 8000 });
      const t = Date.parse(String(r.stdout || '').trim());
      at = Number.isNaN(t) ? null : t;
    }
  } catch { at = null; }
  starts.set(pid, at);
  return at;
}
/**
 * The writer of a note ({ pid, boot, at } of `stamp`) still runs. Where the system does not tell the start of the
 * process, a young note counts as live.
 */
export function live(note) {
  if (!note || !Number.isInteger(note.pid)) return false;
  if (!alive(note.pid)) { starts.delete(note.pid); return false; }
  if (Math.abs((note.boot ?? bootMinute()) - bootMinute()) > 1) return false;
  const at = Date.parse(note.at || 0);
  const start = startedAt(note.pid);
  return start === null ? Date.now() - at < NOTE_LIVE_MS : start <= at;
}

/** The owner note of a lock folder, or null (none, or a holder killed before it wrote it). */
function ownerOf(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim();
    if (text.startsWith('{')) return JSON.parse(text);
    // The form before 2.0.78: "<pid> <time>".
    const [pid, at] = text.split(' ');
    return Number(pid) ? { pid: Number(pid), at } : null;
  } catch { return null; }
}

/**
 * Takes a lock away from a holder that is gone: `dead` (its owner note, the process does not run) or a lock older than
 * staleMs. Only the process that made the gate folder removes, and it looks again inside the gate: two waiters that both
 * saw the dead holder otherwise removed each other's new lock (the second removal hit the lock the first one had just
 * taken) and both held it. A gate of a process killed inside it (a few calls) goes after 10 s.
 * Returns null (not taken over) or { orphan }: the owner note of a holder that died while it held the lock, else null.
 */
function takeOver(dir, dead, staleMs) {
  const gate = `${dir}.takeover`;
  try { fs.mkdirSync(gate); } catch {
    try { if (Date.now() - fs.statSync(gate).mtimeMs > 10000) fs.rmdirSync(gate); } catch { /* another process settles it */ }
    return null;
  }
  try {
    const now = ownerOf(dir);
    const same = !!dead && !!now && now.pid === dead.pid && now.at === dead.at;
    let age = 0;
    try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { return null; }
    if (!same && age <= staleMs) return null;
    return remove(dir) ? { orphan: same ? dead : null } : null;
  } finally {
    try { fs.rmdirSync(gate); } catch { /* goes after 10 s */ }
  }
}

/**
 * Runs the synchronous `fn` under the lock `dir`; throws LockBusy when it could not be taken within waitMs (`busy(dir, ageMs)`
 * gives the message). Re-entrant in one process. `sleepMs` is the base of the pause between attempts (with jitter up to
 * as much again): a lock held for a moment (the thread state) takes a short one. `owner: false` skips the informative
 * owner file, one write less for a lock nobody inspects. A lock whose holder died (the process of its owner note does not
 * run) is taken at once, not after staleMs: the brain lock of a killed hook blocked every other script for 120 s (audit
 * 2026-11-22). `fn` gets { orphan }: the owner note of that dead holder, so the caller can settle what it left.
 */
export function withLock(dir, { waitMs = 1000, staleMs = 10 * 60 * 1000, sleepMs = 30, owner = true, busy = null } = {}, fn) {
  if (held.get(dir) > 0) {
    held.set(dir, held.get(dir) + 1);
    try { return fn(); } finally { held.set(dir, held.get(dir) - 1); }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const started = Date.now();
  let orphan = null;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      if (owner) { try { fs.writeFileSync(path.join(dir, 'owner'), `${JSON.stringify(stamp())}\n`); } catch { /* a lock without the note goes stale by its age */ } }
      break;
    } catch (err) {
      if (!taken(err)) throw err;
      let age = null;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { /* released meanwhile */ }
      if (age !== null) {
        const note = owner ? ownerOf(dir) : null;
        const dead = note && !live(note) ? note : null;
        const took = dead || age > staleMs ? takeOver(dir, dead, staleMs) : null;
        if (took) { orphan = took.orphan || orphan; continue; }
      }
      if (Date.now() - started >= waitMs) throw new LockBusy(dir, age ?? 0, busy ? busy(dir, age ?? 0) : undefined);
      // Released between the two calls: take it at once. Windows (EPERM, the folder is still going away) waits a moment.
      if (age === null && err.code === 'EEXIST') continue;
      Atomics.wait(sleeper, 0, 0, sleepMs + Math.floor(Math.random() * sleepMs));
    }
  }
  held.set(dir, 1);
  try {
    return fn({ orphan });
  } finally {
    held.set(dir, 0);
    remove(dir);
  }
}

/**
 * One try for the lock `dir`, for a caller whose work is asynchronous (withLock runs a synchronous function): a release
 * function, or null while a live process holds it. The lock of a holder that is gone is taken over as in withLock.
 */
export function tryLock(dir, { staleMs = 10 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(dir);
      try { fs.writeFileSync(path.join(dir, 'owner'), `${JSON.stringify(stamp())}\n`); } catch { /* a lock without the note goes stale by its age */ }
      return () => { remove(dir); };
    } catch (err) {
      if (!taken(err)) throw err;
      let age;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; } // released meanwhile
      const note = ownerOf(dir);
      const dead = note && !live(note) ? note : null;
      if (!(dead || age > staleMs) || !takeOver(dir, dead, staleMs)) return null;
    }
  }
  return null;
}

// Windows reports a folder that another process is just removing (delete pending) as EPERM or EACCES, not EEXIST: for
// the next writer it is a held lock, not an error (a hook must not fail on it).
const taken = (err) => err.code === 'EEXIST' || (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES'));

/** Removes the lock folder; false when the system refuses (Windows: another process looks at it): it then goes stale. */
function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }); return true; } catch { return false; }
}
