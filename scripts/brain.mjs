// Single writer for the brain repository (P-040, P-037, P-025, P-013).
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRetry, gitRemote, remoteDiagnosis, readJson, toPosix, PLUGIN_ROOT } from './util.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV, brainScriptEnv, inSubagent, machineName, sameMachine } from './config.mjs';
import { checkBrainFile } from './brain-checks.mjs';

/**
 * Serializes brain mutations of all processes on this machine that share one brain clone (several threads of one
 * project, P-040): git index and HEAD are single-writer. Lock = directory in .git (atomic mkdir), reentrant within a
 * process, stale after LOCK_STALE_MS (crashed holder). Waits up to LOCK_WAIT_MS, then fails with a clear error.
 */
const LOCK_WAIT_MS = 60000;
const LOCK_STALE_MS = 120000;
const lockDepth = new Map();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function brainLockPath(brainDir) {
  return path.join(brainDir, '.git', 'workflow-write.lock');
}

export function withBrainLock(brainDir, fn) {
  if (!brainDir || !fs.existsSync(path.join(brainDir, '.git'))) return fn();
  const lock = brainLockPath(brainDir);
  const depth = lockDepth.get(lock) || 0;
  if (depth > 0) {
    lockDepth.set(lock, depth + 1);
    try { return fn(); } finally { lockDepth.set(lock, lockDepth.get(lock) - 1); }
  }
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`brain is busy (another workflow script holds ${lock} for ${Math.round(age / 1000)} s); retry`);
      Atomics.wait(sleeper, 0, 0, 50 + Math.floor(Math.random() * 100));
    }
  }
  lockDepth.set(lock, 1);
  try {
    return fn();
  } finally {
    lockDepth.set(lock, 0);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Files that may change on both sides without being a disagreement (P-037, P-030). */
export const SYNC_EXCEPTIONS = [/^topics\/[^/]+\/holder\.json$/, /^logs\/[^/]+\.log$/, /^logs\/[^/]+\/[^/]+\.log$/];

export function currentBranch(brainDir) {
  const res = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: brainDir });
  return res.ok && res.stdout !== 'HEAD' ? res.stdout : 'main';
}

export function hasRemote(brainDir) {
  return git(['remote', 'get-url', 'origin'], { cwd: brainDir }).ok;
}

export function unpushedCount(brainDir) {
  const branch = currentBranch(brainDir);
  if (!hasRemote(brainDir)) return 0;
  const remoteRef = git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: brainDir });
  if (!remoteRef.ok) {
    const all = git(['rev-list', '--count', 'HEAD'], { cwd: brainDir });
    return all.ok ? Number(all.stdout) : 0;
  }
  const res = git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: brainDir });
  return res.ok ? Number(res.stdout) : 0;
}

function isException(file) {
  return SYNC_EXCEPTIONS.some((re) => re.test(file));
}

const HOLDER_FILE = /^topics\/([^/]+)\/holder\.json$/;
const HANDOVER_FILE = /^topics\/([^/]+)\/handover\.md$/;
const TOPIC_FILE = /^topics\/([^/]+)\/topic\.json$/;

/**
 * topic.json changed on two machines (state, updated, paused_until): field by field against the common base, the side
 * that changed a field wins; a field changed on both sides keeps origin's value, `updated` the later time.
 */
function mergeTopicJson(base, remote, local) {
  const out = {};
  const clash = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])) {
    const v = same(local[k], base[k]) ? remote[k] : same(remote[k], base[k]) ? local[k] : k === 'updated' ? [remote[k], local[k]].sort().at(-1) : remote[k];
    if (!same(local[k], base[k]) && !same(remote[k], base[k]) && !same(local[k], remote[k]) && k !== 'updated') clash.push(k);
    if (v !== undefined) out[k] = v;
  }
  return { merged: out, clash };
}

/** The exact command that settles a disagreement on one file (P-040): this machine's version or origin's. */
export function resolveCommand(file) {
  return `node ${PLUGIN_ROOT}/bin/brain.mjs resolve ${file} --keep local|remote`;
}

const holderLabel = (h) => (h && h.thread ? `thread ${h.thread}${h.machine ? ` on ${h.machine}` : ''}` : 'nobody');
const parseJson = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

/**
 * One conflicted file during the rebase onto origin. In a rebase stage 2 is origin's side, stage 3 this machine's commit.
 * holder.json: origin wins (a claim pushed first stands), the new holder is reported. handover.md: both versions are
 * kept, origin's first, with a notice for the holder. A file in `resolutions` takes the chosen side. Else null.
 */
function resolveConflict(brainDir, file, how) {
  const stage = (n) => git(['show', `:${n}:${file}`], { cwd: brainDir });
  const take = (n) => {
    const side = stage(n);
    if (!side.ok) return git(['rm', '--quiet', '--', file], { cwd: brainDir }).ok;
    fs.writeFileSync(path.join(brainDir, file), side.stdout + (side.stdout.endsWith('\n') ? '' : '\n'));
    return git(['add', '--', file], { cwd: brainDir }).ok;
  };
  let m;
  if (how === 'remote' || how === 'local') {
    return take(how === 'remote' ? 2 : 3) ? `${file}: ${how === 'remote' ? "origin's" : "this machine's"} version kept (brain.mjs resolve)` : null;
  }
  if ((m = HOLDER_FILE.exec(file))) {
    const local = parseJson(stage(3).stdout);
    const remote = parseJson(stage(2).stdout);
    if (!take(2)) return null;
    return `topic ${m[1]}: holder changed on origin, origin's holder kept: ${holderLabel(remote)}${local.thread && local.thread !== remote.thread ? ` (this machine had ${holderLabel(local)})` : ''} (P-037)`;
  }
  if ((m = TOPIC_FILE.exec(file))) {
    const [base, remote, local] = [1, 2, 3].map((n) => stage(n));
    if (!remote.ok || !local.ok) return null;
    const { merged, clash } = mergeTopicJson(parseJson(base.stdout), parseJson(remote.stdout), parseJson(local.stdout));
    fs.writeFileSync(path.join(brainDir, file), JSON.stringify(merged, null, 2) + '\n');
    if (!git(['add', '--', file], { cwd: brainDir }).ok) return null;
    return clash.length ? `topic ${m[1]}: topic.json changed on two machines; merged, origin's value kept for ${clash.join(', ')} (P-040)` : '';
  }
  if ((m = HANDOVER_FILE.exec(file))) {
    const remote = stage(2).stdout;
    const local = stage(3).stdout;
    const merged = `${remote.trimEnd()}\n\n<!-- handover conflict: origin's version above, this machine's version (${machineName()}) below; the holder merges them into one handover (P-026) -->\n\n${local.trimEnd()}\n`;
    fs.writeFileSync(path.join(brainDir, file), merged);
    if (!git(['add', '--', file], { cwd: brainDir }).ok) return null;
    return `topic ${m[1]}: handover changed on two machines, both versions kept in ${file}; the holder merges them into one (save handover, P-026)`;
  }
  return null;
}

/**
 * Fetch, detect disagreement, rebase, push (P-040 items 2-4).
 * Returns { pushed, unpushed, conflict: string[] | null, error: string | null, remoteAhead, notices: string[] }.
 * opts.resolutions: { <file>: 'local' | 'remote' } settles a disagreement the operator chose (brain.mjs resolve).
 */
export function brainSync(brainDir, opts = {}) {
  return withBrainLock(brainDir, () => brainSyncUnlocked(brainDir, opts));
}

function brainSyncUnlocked(brainDir, { attempts = 3, resolutions = {} } = {}) {
  const branch = currentBranch(brainDir);
  const result = { pushed: false, unpushed: 0, conflict: null, error: null, remoteAhead: false, notices: [] };
  if (!hasRemote(brainDir)) {
    result.error = 'no remote origin';
    return result;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const fetch = gitRemote(['fetch', '--quiet', 'origin'], { cwd: brainDir });
    if (!fetch.ok) {
      result.error = withDiagnosis(`fetch failed: ${firstLine(fetch.stderr)}`, fetch.stderr);
      result.unpushed = unpushedCount(brainDir);
      return result;
    }
    const remoteRef = git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: brainDir });
    if (remoteRef.ok) {
      const base = git(['merge-base', 'HEAD', `origin/${branch}`], { cwd: brainDir }).stdout;
      const remoteHead = remoteRef.stdout;
      if (base !== remoteHead) {
        result.remoteAhead = true;
        const localChanged = git(['diff', '--name-only', base, 'HEAD'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
        const remoteChanged = git(['diff', '--name-only', base, remoteHead], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
        // The same change made on two machines (e.g. one template migration) is no disagreement; a handover and a file
        // with a chosen side are settled in the rebase.
        const settled = (f) => isException(f) || HANDOVER_FILE.test(f) || TOPIC_FILE.test(f) || resolutions[f];
        const both = localChanged.filter((f) => remoteChanged.includes(f) && !settled(f) && !git(['diff', '--quiet', 'HEAD', remoteHead, '--', f], { cwd: brainDir }).ok);
        if (both.length) {
          result.conflict = both;
          result.unpushed = unpushedCount(brainDir);
          return result;
        }
        // Uncommitted changes make the rebase refuse; that is not a disagreement with origin (it read as "disagreement: ").
        const dirty = git(['diff', '--name-only', 'HEAD'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
        if (dirty.length) {
          result.error = `uncommitted changes in brain block the update from origin: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}; commit them through the workflow or restore them (P-040)`;
          result.unpushed = unpushedCount(brainDir);
          return result;
        }
        const env = { ...brainScriptEnv(), GIT_EDITOR: 'true' };
        let rebase = gitRetry(['rebase', '--quiet', `origin/${branch}`], { cwd: brainDir, env });
        for (let step = 0; !rebase.ok && step < 100; step++) {
          const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
          const notes = unmerged.map((f) => resolveConflict(brainDir, f, resolutions[f]));
          if (!unmerged.length || notes.some((n) => n === null)) {
            git(['rebase', '--abort'], { cwd: brainDir });
            const open = unmerged.filter((_, i) => notes[i] === null);
            const overlap = open.length ? open : localChanged.filter((f) => remoteChanged.includes(f) && !settled(f));
            if (overlap.length) result.conflict = overlap;
            else result.error = `rebase onto origin failed: ${firstLine(rebase.stderr)}`;
            result.notices = [];
            result.unpushed = unpushedCount(brainDir);
            return result;
          }
          result.notices.push(...notes.filter(Boolean));
          // A commit that became empty (our claim replaced by origin's holder) is dropped, not committed empty.
          const empty = git(['diff', '--cached', '--quiet'], { cwd: brainDir }).ok;
          rebase = gitRetry(['rebase', empty ? '--skip' : '--continue'], { cwd: brainDir, env });
        }
        if (!rebase.ok) {
          git(['rebase', '--abort'], { cwd: brainDir });
          result.error = `rebase onto origin failed: ${firstLine(rebase.stderr)}`;
          result.notices = [];
          result.unpushed = unpushedCount(brainDir);
          return result;
        }
      }
    }
    if (unpushedCount(brainDir) === 0 && remoteRef.ok) {
      result.pushed = true;
      return result;
    }
    const push = gitRemote(['push', '--quiet', '-u', 'origin', `HEAD:${branch}`], { cwd: brainDir });
    if (push.ok) {
      result.pushed = true;
      result.unpushed = 0;
      return result;
    }
    if (!/rejected|fetch first|non-fast-forward|failed to push/.test(push.stderr)) {
      result.error = withDiagnosis(`push failed: ${firstLine(push.stderr)}`, push.stderr);
      result.unpushed = unpushedCount(brainDir);
      return result;
    }
  }
  result.error = 'push rejected repeatedly';
  result.unpushed = unpushedCount(brainDir);
  return result;
}

/**
 * SessionStart on one of several machines sharing a brain (P-040): bring the clone up to date before boot reads rules,
 * indexes and holders. Fast-forward only, and only when the clone has nothing of its own (no unpushed commit, no
 * uncommitted change to a tracked file); otherwise it reports how far behind it is and leaves the clone as it is.
 * Fetch is not retried: a session start must not wait on the network.
 * Returns { pulled, behind, reason, error }.
 */
export function brainPull(brainDir) {
  return withBrainLock(brainDir, () => {
    const result = { pulled: 0, behind: 0, reason: null, error: null };
    if (!hasRemote(brainDir)) return result;
    const branch = currentBranch(brainDir);
    const fetch = gitRemote(['fetch', '--quiet', 'origin'], { cwd: brainDir }, []);
    if (!fetch.ok) {
      result.error = withDiagnosis(`fetch failed: ${firstLine(fetch.stderr)}`, fetch.stderr);
      return result;
    }
    if (!git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: brainDir }).ok) return result;
    const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: brainDir });
    result.behind = behind.ok ? Number(behind.stdout) : 0;
    if (!result.behind) return result;
    const unpushed = unpushedCount(brainDir);
    const dirty = git(['diff', '--name-only', 'HEAD'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
    if (unpushed > 0) { result.reason = `${unpushed} unpushed commit(s)`; return result; }
    if (dirty.length) { result.reason = `uncommitted changes: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}`; return result; }
    const ff = git(['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: brainDir, env: brainScriptEnv() });
    if (!ff.ok) { result.error = `fast-forward failed: ${firstLine(ff.stderr)}`; return result; }
    result.pulled = result.behind;
    result.behind = 0;
    return result;
  });
}

/** One status line for the boot (P-040), or null when the clone is up to date. */
export function brainPullNote(res) {
  if (!res) return null;
  if (res.error) return `brain: not updated from origin (${res.error}); this machine may not see the latest holders and handovers`;
  if (res.pulled) return `brain: updated from origin (${res.pulled} commit(s) from another machine or thread)`;
  if (res.behind) return `brain: ${res.behind} commit(s) behind origin, not updated (${res.reason}); run node <plugin>/bin/brain.mjs sync after committing, before claiming a topic (P-040)`;
  return null;
}

function withDiagnosis(msg, stderr) {
  const d = remoteDiagnosis(stderr);
  return d ? `${msg}; ${d}` : msg;
}

function firstLine(s) {
  return String(s || '').split('\n')[0];
}

export function readHolder(brainDir, topicId) {
  return readJson(path.join(brainDir, 'topics', topicId, 'holder.json'), {}) || {};
}

export function topicOfPath(rel) {
  const m = /^topics\/([^/]+)\/(.+)$/.exec(rel);
  if (!m || m[1] === 'archive') return null;
  return m[1];
}

/** Holder check for writes into topics/<id>/ (P-037, P-040 item 5). */
export function checkHolder(brainDir, rel, thread) {
  const topic = topicOfPath(rel);
  if (!topic) return null;
  if (!thread) return `write into topics/${topic}/ requires a stable thread id (P-038)`;
  const holder = readHolder(brainDir, topic);
  if (!holder.thread) return `topic ${topic} has no holder; claim it first (P-037)`;
  if (holder.thread !== thread) return `topic ${topic} held by thread ${holder.thread}; this thread (${thread}) is not the holder (P-037)`;
  if (!sameMachine(holder.machine)) return `topic ${topic} held by thread ${holder.thread} on machine ${holder.machine}, not on this machine (${machineName()}); hand it off there (topic.mjs handoff) and claim it here (P-037)`;
  return null;
}

/** The thread holds the topic on this machine: one thread id on two machines is two holders (P-037, P-040). */
export function isHolderOf(holder, thread) {
  return !!holder?.thread && holder.thread === thread && sameMachine(holder.machine);
}

/** Holder decisions need the latest remote state (P-037): fetch first, then read holder.json. */
export function syncAndCheckHolder(brainDir, rel, thread) {
  if (topicOfPath(rel) && hasRemote(brainDir)) brainSync(brainDir);
  return checkHolder(brainDir, rel, thread);
}

/**
 * Write files into brain and commit with the script tag; then sync.
 * ops: [{ path, content }, { path, remove: true }, { from, to }]
 * Returns { committed, sha, sync, unpushed, warnings }.
 */
export function brainWrite(ctx, opts) {
  return withBrainLock(ctx.brainDir, () => brainWriteUnlocked(ctx, opts));
}

function brainWriteUnlocked(ctx, { ops, message, internal = false, sync = true, agentId = null, env: extraEnv = {} }) {
  const { brainDir, thread, policy } = ctx;
  if (!brainDir) throw new Error('brain unavailable');
  if (agentId || inSubagent()) throw new Error('brain write refused in subagent; return the result to the main agent (P-025)');
  if (!message || !String(message).trim()) throw new Error('commit message required');
  const errors = [];
  const touched = [];
  const rels = ops.flatMap((op) => (op.from ? [op.from, op.to] : [op.path])).map((t) => toPosix(t).replace(/^\.\//, ''));
  if (!internal && rels.some((r) => topicOfPath(r)) && hasRemote(brainDir)) brainSync(brainDir);
  for (const op of ops) {
    const targets = op.from ? [op.from, op.to] : [op.path];
    for (const t of targets) {
      const rel = toPosix(t).replace(/^\.\//, '');
      if (rel.split('/').includes('..') || path.isAbsolute(rel)) errors.push(`${rel}: path must be relative inside brain`);
      if (!internal) {
        const holderError = checkHolder(brainDir, rel, thread);
        if (holderError) errors.push(holderError);
      }
      // Removing or moving away a file that breaks the path rules (an older setup) fixes it; check only what stays.
      const leaving = op.remove || op.from === t;
      errors.push(...checkBrainFile(rel, leaving ? null : op.content ?? op.append ?? null, { policy }).filter((e) => !leaving || !e.includes('(P-049)')));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));

  for (const op of ops) {
    if (op.from) {
      const from = path.join(brainDir, op.from);
      const to = path.join(brainDir, op.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      touched.push(op.from, op.to);
    } else if (op.remove) {
      fs.rmSync(path.join(brainDir, op.path), { recursive: true, force: true });
      touched.push(op.path);
    } else if (op.append !== undefined) {
      // Append-only files (logs/<machine>/<date>.log): only this machine writes them, so a sync never conflicts.
      const file = path.join(brainDir, op.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, op.append);
      touched.push(op.path);
    } else {
      const file = path.join(brainDir, op.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, op.content);
      touched.push(op.path);
    }
  }
  const env = { ...brainScriptEnv(), ...extraEnv };
  const add = gitRetry(['add', '-A', '--', ...touched], { cwd: brainDir, env });
  if (!add.ok) throw new Error(`git add failed: ${firstLine(add.stderr)}`);
  const staged = git(['diff', '--cached', '--quiet'], { cwd: brainDir });
  const result = { committed: false, sha: null, sync: null, unpushed: unpushedCount(brainDir), warnings: [] };
  if (!staged.ok) {
    const commit = gitRetry(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} ${message}`], { cwd: brainDir, env });
    if (!commit.ok) {
      // A refused commit (pre-commit check) leaves nothing behind: the touched paths go back to HEAD.
      for (const rel of new Set(touched)) {
        if (git(['cat-file', '-e', `HEAD:${rel}`], { cwd: brainDir }).ok) git(['checkout', '--quiet', 'HEAD', '--', rel], { cwd: brainDir });
        else { git(['rm', '-r', '--quiet', '--cached', '--ignore-unmatch', '--', rel], { cwd: brainDir }); fs.rmSync(path.join(brainDir, rel), { recursive: true, force: true }); }
      }
      throw new Error(`commit failed: ${String(commit.stderr || commit.stdout).trim().split('\n').slice(0, 6).join('\n')}`);
    }
    result.committed = true;
    result.sha = git(['rev-parse', '--short', 'HEAD'], { cwd: brainDir }).stdout;
  }
  if (sync) {
    result.sync = brainSync(brainDir);
    result.unpushed = result.sync.unpushed ?? unpushedCount(brainDir);
    result.warnings.push(...(result.sync.notices || []));
    if (result.sync.conflict) result.warnings.push(conflictText(result.sync.conflict));
    else if (result.sync.error && result.sync.error !== 'no remote origin') result.warnings.push(`unpushed: ${result.unpushed} (${result.sync.error})`);
  } else {
    result.unpushed = unpushedCount(brainDir);
  }
  return result;
}

/** Disagreement report with the exact command per file (P-040). */
export function conflictText(files) {
  return `conflict: ${files.join(', ')} (changed on both sides; not merged, P-040); settle each file: ${files.map(resolveCommand).join('; ')}`;
}

export function formatWriteResult(res, paths) {
  const lines = [];
  lines.push(`${res.committed ? 'written' : 'unchanged'}: ${paths.join(', ')}${res.sha ? ` (${res.sha})` : ''}`);
  if (res.unpushed > 0) lines.push(`unpushed: ${res.unpushed}`);
  lines.push(...res.warnings);
  return lines.join('\n');
}
