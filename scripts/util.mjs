// Shared helpers: filesystem, JSON, git process execution. No harness dependency (P-017, P-034).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A closed pipe (e.g. `| head`) must not crash a script.
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && (err.code === 'ENOENT' || err instanceof SyntaxError)) return fallback;
    throw err;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function exists(file) {
  return fs.existsSync(file);
}

export function listFiles(dir, filter = () => true, { recursive = true } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(full, filter, { recursive }));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Convert an OS path into a '/'-separated relative path. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function relPosix(from, to) {
  return toPosix(path.relative(from, to));
}

function lexicallyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Real path of p: realpath of its nearest existing ancestor plus the missing tail (a file about to be written). */
export function realPathLoose(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail); } catch { /* missing: go up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    tail.unshift(path.basename(cur));
    cur = up;
  }
}

/**
 * True when child lies in parent. Lexically first; on a miss, compared by real paths, so a symlinked folder
 * (~/agentic/alice -> Alice after the domain rename) and its target are the same place: a session started on the old
 * path had a write to <Alice>/agent-alice/scratch denied as a brain write (brain matched, scratch on the old path did not).
 */
export function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (lexicallyInside(p, c)) return true;
  return lexicallyInside(realPathLoose(p), realPathLoose(c));
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * A time for a human (agent text the operator reads): the machine's local time with its zone, "2026-11-14 00:30 CET".
 * Stored data (state JSON, mail, logs) stays ISO UTC; only text changes. Takes an ISO string, ms or Date; anything
 * unparsable comes back as given. `timeZone` overrides the process zone (tests).
 */
export function localTime(value, { timeZone } = {}) {
  if (value === null || value === undefined || value === '') return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** Run git synchronously. Returns { status, stdout, stderr, ok }. */
export function git(args, { cwd, env, input } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    input,
  });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    ok: res.status === 0,
    error: res.error,
  };
}

/** Retry a git call while it fails on index.lock (P-040 item 4). Synchronous with a short random wait. */
export function gitRetry(args, opts = {}, attempts = 6) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = git(args, opts);
    if (res.ok || !/index\.lock/.test(res.stderr)) return res;
    const wait = 50 + Math.floor(Math.random() * 250);
    const end = Date.now() + wait;
    while (Date.now() < end) { /* busy wait, keep synchronous */ }
  }
  return res;
}

// Remote failures that pass on a later try (flaky ssh auth or network): retried with a short wait.
const TRANSIENT_REMOTE = /Permission denied \(publickey\)|Could not read from remote|Connection (reset|closed|refused|timed out)|kex_exchange_identification|ssh_exchange_identification|Could not resolve host|Operation timed out|early EOF|remote end hung up/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** git fetch/push: retries transient remote failures (ssh auth, network) after short waits. */
export function gitRemote(args, opts = {}, waits = [500, 1500, 3000]) {
  let res = gitRetry(args, opts);
  for (const wait of waits) {
    if (res.ok || !TRANSIENT_REMOTE.test(res.stderr)) return res;
    sleepSync(wait);
    res = gitRetry(args, opts);
  }
  return res;
}

/** Short ssh diagnosis for an auth failure: what the agent can check, not only "unpushed". */
export function remoteDiagnosis(stderr, env = process.env) {
  if (!/publickey|Could not read from remote/i.test(String(stderr || ''))) return '';
  const home = env.HOME;
  const sshDir = home ? path.join(home, '.ssh') : null;
  const config = !!sshDir && fs.existsSync(path.join(sshDir, 'config'));
  let keys = 0;
  try { keys = fs.readdirSync(sshDir).filter((f) => /^id_/.test(f) && !f.endsWith('.pub')).length; } catch { /* no ssh dir */ }
  return `ssh: HOME ${home ? 'set' : 'unset'}, ssh config ${config ? 'present' : 'missing'}, default keys ${keys}, agent socket ${env.SSH_AUTH_SOCK ? 'set' : 'unset'}; failed after retries, check with ssh -vT <remote host>`;
}

export function gitToplevel(dir) {
  const res = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  return res.ok ? path.resolve(res.stdout) : null;
}

export function shortSha(dir) {
  const res = git(['rev-parse', '--short', 'HEAD'], { cwd: dir });
  return res.ok ? res.stdout : 'unknown';
}

export function fail(message, code = 1) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

/** Minimal argv parser: positionals and --flag value / --flag (boolean). */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--[a-z]/i.test(a)) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !/^--[a-z]/i.test(next)) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function copyDir(src, dest, { filter = () => true } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (!filter(s)) continue;
    if (entry.isDirectory()) copyDir(s, d, { filter });
    else fs.copyFileSync(s, d);
  }
}
