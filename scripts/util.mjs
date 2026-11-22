// Shared helpers: filesystem, JSON, git process execution. No harness dependency (P-017, P-034).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Folder of the machine files of the workflow (projects root, pins, mail of the machine, timer and watch indexes). */
export const machineConfigDir = (env = process.env) => path.join(env.HOME || os.homedir(), '.config', 'agentic-flow');

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

/**
 * Atomic: the JSON goes to a temporary file and a rename puts it in place, so a reader never meets a truncated file.
 * The hooks of one thread run at the same time (parallel tool calls; every call of a Code Mode script): a hook that read
 * the thread state while another one wrote it got `{}` from readJson and wrote that back, which reset the whole state
 * (own_edits, refusals, wakers; reproduced 2026-11-21). The new file keeps the permission bits of the one it replaces.
 * Two writers that read the same state still lose one update: that needs a lock around read and write, not this.
 */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  let old = null;
  try { old = fs.lstatSync(file); } catch { /* a new file */ }
  // A link stays a link: the write goes through it to its target, a rename would put a file in its place.
  if (old?.isSymbolicLink()) return fs.writeFileSync(file, text);
  const tmp = `${file}.${process.pid}.tmp`;
  // The copy beside the file must be complete before anything touches the file: a full disk (or a size limit) that
  // refused the copy went on to the direct write, which cut the file to nothing first and left the thread state as
  // invalid JSON (audit 2026-11-22). Now it fails and the file stays as it was.
  try {
    fs.writeFileSync(tmp, text);
    if (old) fs.chmodSync(tmp, old.mode & 0o777);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // The system refused the rename (Windows: the target is open elsewhere): the direct write, as before.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text);
  }
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

/**
 * Paths as they are, never quoted: under core.quotepath (git's default) a name with diacritics comes as
 * "Detsk\303\251 …" and every caller that reads paths took it literally (doma-pc 2026-11-16: project.mjs inventory, ENOENT).
 */
export const GIT_NO_QUOTE = Object.freeze(['-c', 'core.quotepath=false']);

/** Run git synchronously. Returns { status, stdout, stderr, ok }. Paths in the output are never quoted (GIT_NO_QUOTE). */
// P-079 (speed): one brain write ran 49 git commands, ~8 ms each; the same queries came 5-6 times (remote get-url,
// rev-parse of HEAD's branch, top level, git dir). Their answers stay the same while this process changes nothing of the
// repo: kept per cwd until a command that can change them (checkout, remote, commit, config ...) runs through here.
const GIT_STABLE = [['remote', 'get-url'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-dir'], ['rev-parse', '--git-common-dir'], ['rev-parse', '--path-format=absolute', '--git-common-dir'], ['rev-parse', '--abbrev-ref', 'HEAD']];
const GIT_CHANGES = new Set(['remote', 'checkout', 'switch', 'init', 'clone', 'worktree', 'commit', 'branch', 'symbolic-ref', 'config', 'merge', 'rebase', 'reset', 'pull', 'stash']);
const gitMemo = new Map();
const stableQuery = (args) => GIT_STABLE.some((q) => (q[0] === 'remote' ? args.length === 3 : args.length === q.length) && q.every((a, i) => args[i] === a));

export function git(args, { cwd, env, input } = {}) {
  const memo = !env && input === undefined && stableQuery(args) ? `${path.resolve(cwd || process.cwd())}\0${args.join('\0')}` : null;
  if (memo && gitMemo.has(memo)) return { ...gitMemo.get(memo) };
  if (GIT_CHANGES.has(args[0])) gitMemo.clear();
  const res = spawnSync('git', [...GIT_NO_QUOTE, ...args], {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    input,
    // In a hook (hooks/run.mjs): git ends before the harness kills the hook; git removes its lock files when it is ended.
    timeout: globalThis.workflowHookDeadline ? Math.max(1000, globalThis.workflowHookDeadline - Date.now()) : undefined,
  });
  const out = {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: res.error?.code === 'ETIMEDOUT' ? `git ${args[0]} was stopped: the hook ran out of its time` : (res.stderr || '').trim(),
    ok: res.status === 0,
    error: res.error,
  };
  if (memo && out.ok) gitMemo.set(memo, out);
  return out;
}

/**
 * Removes the files under a path and the folders that let go; never throws, returns the files left. Windows refuses a
 * file or a folder a program holds (a shell stands in it, a viewer shows it); a folder that stays without a file is
 * nothing to git and nothing to the workflow, so the removal is complete when this returns 0.
 */
export function removeTree(abs) {
  try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); return 0; } catch { /* file by file below */ }
  let st;
  try { st = fs.lstatSync(abs); } catch { return 0; }
  if (!st.isDirectory()) return 1;
  let left = 0;
  let names = [];
  try { names = fs.readdirSync(abs); } catch { return 1; }
  for (const e of names) left += removeTree(path.join(abs, e));
  if (!left) { try { fs.rmdirSync(abs); } catch { /* held open: an empty folder stays */ } }
  return left;
}

/** The file `rel` of `dir` holds only the start of the blob `ref`: git was writing it when it died. */
export function cutShort(dir, ref, rel) {
  try { return git(['cat-file', 'blob', ref], { cwd: dir }).stdout.startsWith(fs.readFileSync(path.join(dir, rel), 'utf8').trimEnd()); } catch { return false; }
}

/**
 * Removes the lock files a killed git left in `dir` (index.lock, HEAD.lock, packed-refs.lock, a ref lock: git fails on
 * each of them for good, "Unable to create '….lock': File exists"). Only files older than staleMs: a git that runs holds
 * its lock for a moment, and a git child outlives its killed parent for that moment. `since`: files older than this
 * time are not the caller's (a person's commit with its editor open). `wait`: stay until every younger lock is gone or
 * old enough, at most staleMs (a write that went on at once failed on the young lock and left more behind). The caller
 * knows that the workflow's own process died in this repo (a note in .git, the lock of a dead holder, the own clone);
 * a checkout without such a sign is not touched. Returns the names removed.
 */
export function dropStaleGitLocks(dir, { staleMs = 60000, since = 0, wait = false } = {}) {
  const gitDir = path.join(dir, '.git');
  const gone = [];
  const files = [];
  const list = (folder, deep) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (deep) list(path.join(folder, e.name), true); } else if (e.isFile() && e.name.endsWith('.lock')) files.push(path.join(folder, e.name));
    }
  };
  for (;;) {
    files.length = 0;
    list(gitDir, false);
    list(path.join(gitDir, 'refs'), true);
    let young = 0;
    for (const abs of files) {
      try {
        const ms = fs.statSync(abs).mtimeMs;
        if (ms < since) continue;
        if (Date.now() - ms <= staleMs) { young += 1; continue; }
        fs.rmSync(abs, { force: true });
        gone.push(toPosix(path.relative(gitDir, abs)));
      } catch { /* held or gone meanwhile */ }
    }
    if (!wait || !young) return gone;
    Atomics.wait(lockSleeper, 0, 0, 200);
  }
}
const lockSleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * The way out for a git call that failed on a lock file, or '' for another failure: git only says "File exists", and
 * the step and its repeat failed with it for good.
 */
export function gitLockHint(stderr) {
  const file = /Unable to create '([^']+\.lock)'/.exec(String(stderr || ''))?.[1];
  if (!file) return '';
  let age = null;
  try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { return '; the git lock is gone now: run the step again'; }
  return age > 60000
    ? `; the lock ${toPosix(file)} is ${Math.round(age / 60000)} min old: a git that was killed left it. When no git runs in that repo, remove the file and run the step again`
    : '; another git command runs in that repo, or one was killed a moment ago: run the step again in a minute';
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
