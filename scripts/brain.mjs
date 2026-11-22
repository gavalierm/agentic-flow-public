// Single writer for the brain repository (P-040, P-037, P-025, P-013).
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRetry, gitRemote, remoteDiagnosis, readJson, toPosix, removeTree, dropStaleGitLocks, gitLockHint, PLUGIN_ROOT } from './util.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV, brainScriptEnv, inSubagent, machineName, sameMachine } from './config.mjs';
import { checkBrainFile } from './brain-checks.mjs';
import { withLock as dirLock, stamp, live } from './lock.mjs';
import { dataRel, dataLayoutVersion, layoutFor } from './layout.mjs';
import { readHolderRecord, mergeTopicOps, splitTema, listTopicRecords } from './topic-files.mjs';
import { INDEX_FILE, hasDataIndex, refreshIndex, commitIndexAfterMerge, indexWriteError, refreshDeployIgnores, formatDeployIgnores } from './data-index.mjs';

/**
 * Serializes brain mutations of all processes on this machine that share one brain clone (several threads of one
 * project, P-040): git index and HEAD are single-writer. Lock = directory in .git (atomic mkdir), reentrant within a
 * process, stale after LOCK_STALE_MS (crashed holder). Waits up to LOCK_WAIT_MS, then fails with a clear error.
 */
const LOCK_WAIT_MS = 60000;
const LOCK_STALE_MS = 120000;

export function brainLockPath(brainDir) {
  return path.join(brainDir, '.git', 'workflow-write.lock');
}

export function withBrainLock(brainDir, fn) {
  if (!brainDir || !fs.existsSync(path.join(brainDir, '.git'))) return fn();
  // Only the outermost entry settles what a dead process left: a nested one is inside our own write or rebase.
  return withLock(brainLockPath(brainDir), (info) => {
    if (!lockDepth) recoverWrite(brainDir, info?.orphan);
    lockDepth += 1;
    try { return fn(); } finally { lockDepth -= 1; }
  }, 'brain is busy');
}
let lockDepth = 0;

// A write that died between its file changes and its commit (the turn was interrupted, the process was killed) left the
// brain with uncommitted changes: the files of a topic removed by done --topic and never committed blocked every sync,
// the claim of the topic and its own second done (doma-pc 2026-11-22; the operator finished the removal by hand).
// So a removal cannot be half done (operator 2026-11-22): it is committed first (git rm --cached, the files stay), and
// the files leave the disk after the commit. The commit is the truth: before it nothing changed, after it the topic is
// closed whatever happens to the files. The writer notes its paths before it changes anything; the next script that
// takes the brain lock makes the paths of a dead writer what the last commit says (a committed removal is finished, an
// uncommitted change is undone). A file a program still holds after the commit waits in a list and goes at a later lock.
const journalPath = (brainDir) => path.join(brainDir, '.git', 'workflow-write.journal');
const cleanupPath = (brainDir) => path.join(brainDir, '.git', 'workflow-write.cleanup');
const syncNotePath = (brainDir) => path.join(brainDir, '.git', 'workflow-sync.note');
// A git lock file younger than this may belong to a git child that outlived its killed parent: the recovery waits for it.
const GIT_LOCK_MS = 10000;

/**
 * A file put back gets the time it had before the write: the time says which of a work file and its saved result is
 * newer (scripts/results.mjs). With the time of the put-back the old result looked newer than the work file for good,
 * was never saved, and done --topic then removed the work file: the only copy (audit 2026-11-22).
 */
function keepTime(brainDir, rel, ms) {
  if (!ms) return;
  try { fs.utimesSync(path.join(brainDir, rel), new Date(ms), new Date(ms)); } catch { /* a folder, or gone */ }
}
const timesOf = (brainDir, rels) => Object.fromEntries(rels.map((rel) => { try { const st = fs.statSync(path.join(brainDir, rel)); return st.isFile() ? [rel, st.mtimeMs] : null; } catch { return null; } }).filter(Boolean));

/**
 * Makes paths what HEAD says, the index too: a tracked one is restored (a removed file comes back), one HEAD does not
 * hold goes. Returns the paths whose files a program still holds.
 */
function backToHead(brainDir, rels, mtimes = {}) {
  const all = [...new Set(rels)];
  const held = [];
  // In chunks: a path list of a thousand files is over the limit of a command line (Windows: 32 k characters).
  const chunks = (list) => Array.from({ length: Math.ceil(list.length / 200) }, (_, i) => list.slice(i * 200, i * 200 + 200));
  const inHead = new Set(chunks(all).flatMap((part) => git(['ls-tree', '-r', '--name-only', 'HEAD', '--', ...part], { cwd: brainDir }).stdout.split('\n').filter(Boolean)));
  const tracked = all.filter((rel) => inHead.has(rel) || [...inHead].some((f) => f.startsWith(`${rel}/`)));
  const other = all.filter((rel) => !tracked.includes(rel));
  for (const part of chunks(tracked)) git(['checkout', '--quiet', 'HEAD', '--', ...part], { cwd: brainDir });
  for (const rel of tracked) keepTime(brainDir, rel, mtimes[rel]);
  for (const part of chunks(other)) git(['rm', '-r', '--quiet', '--cached', '--ignore-unmatch', '--', ...part], { cwd: brainDir });
  for (const rel of other) if (removeTree(path.join(brainDir, rel))) held.push(rel);
  return held;
}

/** Paths removed in git whose files a program held: tried again at every lock, dropped once gone (or committed anew). */
function later(brainDir, rels) {
  const file = cleanupPath(brainDir);
  const all = [...new Set([...(readJson(file, []) || []), ...rels])].filter((rel) => !git(['cat-file', '-e', `HEAD:${rel}`], { cwd: brainDir }).ok && removeTree(path.join(brainDir, rel)));
  if (all.length) fs.writeFileSync(file, JSON.stringify(all)); else fs.rmSync(file, { force: true });
  return all;
}

/**
 * Under the lock, before the holder works: what a dead workflow process left is settled, and only that. The lock is
 * also taken on a code checkout (save.mjs of a repo decision, a project repo of data 1 and 2), where a person's own
 * rebase or git lock must stay (audit 2026-11-22: the first version aborted a person's rebase there). So every step
 * needs a note the workflow wrote: the sync note (a rebase left in progress is aborted: the brain stood on a detached
 * HEAD, every write failed and `sync` said "pushed"; the commits are intact, the sync rebases again) or the write
 * journal (its paths become what the last commit says; a path whose file the writer did not change, a document the
 * agent wrote in place, is only taken out of the index, its file is the only copy). With a note of a dead process, or
 * the lock of a holder that died (`orphan`, scripts/lock.mjs tells it), the lock files its git left go too.
 */
function recoverWrite(brainDir, orphan = null) {
  const say = (text) => process.stderr.write(`workflow: ${text}\n`);
  const notes = [syncNotePath(brainDir), journalPath(brainDir)].filter((file) => fs.existsSync(file)).map((file) => ({ file, note: readJson(file, null) }));
  // Our own note (the lock is re-entrant) or a live writer under a lock taken over as stale: left alone.
  if (notes.some((n) => n.note?.pid === process.pid || live(n.note))) return;
  if (orphan || notes.length) {
    // The lock files of the dead process's git, not older ones (a person's commit with its editor open in a code checkout).
    const since = Math.min(...[orphan, ...notes.map((n) => n.note)].map((n) => Date.parse(n?.at || '')).filter(Number.isFinite), Date.now()) - 2000;
    const gone = dropStaleGitLocks(brainDir, { staleMs: GIT_LOCK_MS, since, wait: true });
    if (gone.length) say(`the git lock(s) a killed git left were removed: ${gone.join(', ')}`);
  }
  for (const { file, note } of notes) {
    if (file === syncNotePath(brainDir)) {
      if (['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(brainDir, '.git', d)))) {
        const abort = git(['rebase', '--abort'], { cwd: brainDir });
        say(abort.ok ? 'a brain update from origin a killed process left half done was reset; the next sync runs it again' : `a rebase is left in the brain and could not be aborted: ${firstLine(abort.stderr)}`);
        // The note stays with the rebase: the next lock holder tries again.
        if (!abort.ok) continue;
      }
      if (note?.forward) undoHalfForward(brainDir, note.forward, say);
    } else if (note && Array.isArray(note.paths) && note.paths.length) {
      const keep = Array.isArray(note.keep) ? note.keep : [];
      if (git(['status', '--porcelain', '--', ...note.paths], { cwd: brainDir }).stdout.trim()) {
        later(brainDir, backToHead(brainDir, note.paths.filter((rel) => !keep.includes(rel)), note.mtimes || {}));
        if (keep.length) git(['reset', '--quiet', '--', ...keep], { cwd: brainDir });
        say(`an interrupted brain write was settled (${String(note.message).slice(0, 120)}; ${note.paths.slice(0, 3).join(', ')}${note.paths.length > 3 ? ', …' : ''}): its paths are as the last commit says${keep.length ? `, the file(s) written in place stay as they are (${keep.slice(0, 3).join(', ')})` : ''}; a step that did not finish runs again`);
      }
    }
    fs.rmSync(file, { force: true });
  }
  if (fs.existsSync(cleanupPath(brainDir))) later(brainDir, []);
}

/**
 * A fast-forward that was killed while git wrote the files (brainPull at the session start): HEAD did not move, some
 * files are of the new commit already and the new ones lie there untracked; every later update failed on them
 * ("untracked working tree files would be overwritten"). The fast-forward started from a clean tree, so a path of its
 * diff that holds the new commit's content (or the start of it), or is gone, goes back to HEAD, and a new file of that
 * commit goes; the next update runs it again. A path with other content (an edit made since) stays.
 */
function undoHalfForward(brainDir, { from, to }, say) {
  if (!from || !to || git(['rev-parse', 'HEAD'], { cwd: brainDir }).stdout !== from) return;
  const tree = (ref) => new Map(git(['ls-tree', '-r', ref], { cwd: brainDir }).stdout.split('\n').filter(Boolean).map((line) => { const [meta, rel] = line.split('\t'); return [rel, meta.split(' ')[2]]; }));
  const old = tree(from);
  const next = tree(to);
  const paths = [...new Set([...old.keys(), ...next.keys()])].filter((rel) => old.get(rel) !== next.get(rel));
  const there = paths.filter((rel) => fs.existsSync(path.join(brainDir, rel)));
  const hashes = there.length ? git(['hash-object', '--stdin-paths'], { cwd: brainDir, input: `${there.join('\n')}\n` }).stdout.split('\n') : [];
  const now = new Map(there.map((rel, i) => [rel, hashes[i]]));
  // The file git was writing when it died holds the start of the new content.
  const cutShort = (rel) => { try { return git(['cat-file', 'blob', next.get(rel)], { cwd: brainDir }).stdout.startsWith(fs.readFileSync(path.join(brainDir, rel), 'utf8').trimEnd()); } catch { return false; } };
  const back = paths.filter((rel) => {
    if (!old.has(rel)) return now.has(rel);
    if (!now.has(rel)) return true;
    if (now.get(rel) === old.get(rel)) return false;
    return next.has(rel) && (now.get(rel) === next.get(rel) || cutShort(rel));
  });
  if (!back.length) return;
  backToHead(brainDir, back);
  say(`a brain update from origin a killed process left half written was reset (${back.length} file(s)); the next sync runs it again`);
}

/**
 * A rebase the recovery left: no note of the workflow, so a person (or a workflow before the note) started it. The repo
 * stands on a detached HEAD: a write failed with a git hint and `sync` said "pushed". Returns the way out, or null.
 */
function leftRebase(brainDir) {
  if (!['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(brainDir, '.git', d)))) return null;
  const dir = toPosix(brainDir);
  if (fs.existsSync(syncNotePath(brainDir))) return `an update of ${dir} from origin that a killed workflow process left half done could not be reset yet; run the step again. If it stays, the operator drops it: git -C ${dir} rebase --abort (the commits stay)`;
  return `a git rebase is in progress in ${dir} and the workflow did not start it: no write and no sync runs until it ends. The operator finishes it (git -C ${dir} rebase --continue) or drops it (git -C ${dir} rebase --abort; the commits stay)`;
}

/**
 * The same lock on any path (scripts/lock.mjs): the own clone of a repo (spec 4.1, scripts/own-clone.mjs) serializes the
 * writes of the threads of this machine with it. `busy` starts the error after LOCK_WAIT_MS.
 */
export function withLock(lock, fn, busy = 'busy') {
  return dirLock(lock, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, sleepMs: 50, busy: (dir, age) => `${busy} (another workflow script holds ${dir} for ${Math.round(age / 1000)} s); retry` }, fn);
}

/** Regex source of a literal path part (the map in layout.mjs), for the brain path patterns below. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Brain path patterns of one layout version (memoized). Layout 1: holder.json beside topic.json; layout 2: one .tema.json
 * is the topic file and carries the holder, so there is no separate holder file pattern (holderFile null).
 */
const PATTERNS = new Map();
export function patternsFor(version = 1) {
  if (PATTERNS.has(version)) return PATTERNS.get(version);
  const L = layoutFor(version);
  const topics = esc(L.topics);
  const logs = esc(L.logs);
  const holderFile = L.holderFile === L.topicFile ? null : new RegExp(`^${topics}/([^/]+)/${esc(L.holderFile)}$`);
  const p = {
    oneFile: !holderFile,
    topics: L.topics,
    archive: L.topicArchive,
    topicPath: new RegExp(`^${topics}/([^/]+)/(.+)$`),
    holderFile,
    handoverFile: new RegExp(`^${topics}/([^/]+)/${esc(L.handover)}$`),
    topicFile: new RegExp(`^${topics}/([^/]+)/${esc(L.topicFile)}$`),
    // Files that may change on both sides without being a disagreement (P-037, P-030).
    syncExceptions: [holderFile, new RegExp(`^${logs}/[^/]+\\.log$`), new RegExp(`^${logs}/[^/]+/[^/]+\\.log$`)].filter(Boolean),
  };
  PATTERNS.set(version, p);
  return p;
}
const patternsOf = (brainDir) => patternsFor(dataLayoutVersion(brainDir));

/** Files that may change on both sides without being a disagreement (P-037, P-030), layout 1; patternsFor(v) per version. */
export const SYNC_EXCEPTIONS = patternsFor(1).syncExceptions;

export function currentBranch(brainDir) {
  const res = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: brainDir });
  return res.ok && res.stdout !== 'HEAD' ? res.stdout : 'main';
}

export function hasRemote(brainDir) {
  return git(['remote', 'get-url', 'origin'], { cwd: brainDir }).ok;
}

/** Age in ms of the oldest commit not on origin (0 when everything is pushed). */
export function oldestUnpushedAgeMs(brainDir) {
  if (!unpushedCount(brainDir)) return 0;
  const branch = currentBranch(brainDir);
  const range = git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: brainDir }).ok ? `origin/${branch}..HEAD` : 'HEAD';
  const times = git(['log', '--format=%ct', range], { cwd: brainDir }).stdout.split('\n').filter(Boolean).map(Number);
  return times.length ? Math.max(0, Date.now() - Math.min(...times) * 1000) : 0;
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

function isException(file, P) {
  return P.syncExceptions.some((re) => re.test(file));
}

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
  const P = patternsOf(brainDir);
  if (how === 'remote' || how === 'local') {
    return take(how === 'remote' ? 2 : 3) ? `${file}: ${how === 'remote' ? "origin's" : "this machine's"} version kept (brain.mjs resolve)` : null;
  }
  const holderNote = (id, local, remote) => `topic ${id}: holder changed on origin, origin's holder kept: ${holderLabel(remote)}${local.thread && local.thread !== remote.thread ? ` (this machine had ${holderLabel(local)})` : ''} (P-037)`;
  if (P.holderFile && (m = P.holderFile.exec(file))) {
    const local = parseJson(stage(3).stdout);
    const remote = parseJson(stage(2).stdout);
    if (!take(2)) return null;
    return holderNote(m[1], local, remote);
  }
  if ((m = P.topicFile.exec(file))) {
    const [base, remote, local] = [1, 2, 3].map((n) => stage(n));
    if (!remote.ok || !local.ok) return null;
    // Layout 2: .tema.json carries the holder; the topic fields merge as topic.json, the holder is origin's (a claim pushed
    // first stands) and a new holder is reported as for holder.json.
    const [b, r, l] = [base, remote, local].map((s) => (P.oneFile ? splitTema(parseJson(s.stdout)) : { topic: parseJson(s.stdout), holder: null }));
    const { merged, clash } = mergeTopicJson(b.topic, r.topic, l.topic);
    fs.writeFileSync(path.join(brainDir, file), JSON.stringify(P.oneFile ? { ...merged, holder: r.holder } : merged, null, 2) + '\n');
    if (!git(['add', '--', file], { cwd: brainDir }).ok) return null;
    const notes = [];
    if (clash.length) notes.push(`topic ${m[1]}: ${path.posix.basename(file)} changed on two machines; merged, origin's value kept for ${clash.join(', ')} (P-040)`);
    if (P.oneFile && JSON.stringify(r.holder) !== JSON.stringify(l.holder) && JSON.stringify(r.holder) !== JSON.stringify(b.holder)) notes.push(holderNote(m[1], l.holder, r.holder));
    return notes.join('\n');
  }
  // Layout 2: INDEX.md is not merged by lines; it is written again from the files of the commit (resolved before it).
  if (file === INDEX_FILE && hasDataIndex(brainDir)) {
    refreshIndex(brainDir, brainScriptEnv());
    return '';
  }
  if ((m = P.handoverFile.exec(file))) {
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

/**
 * The sync with its note: a rebase found later in this repo is the workflow's own (recoverWrite). Every caller has it
 * (brainPull at the session start had none: a hook killed in its rebase left a detached HEAD that nothing settled,
 * audit 2026-11-22). A rebase that is there before the note is not ours: checked first. A nested sync keeps the outer note.
 */
function brainSyncUnlocked(brainDir, opts = {}) {
  const left = leftRebase(brainDir);
  if (left) return { pushed: false, unpushed: 0, conflict: null, error: left, remoteAhead: false, notices: [] };
  const file = syncNotePath(brainDir);
  const own = !fs.existsSync(file);
  if (own) { try { fs.writeFileSync(file, JSON.stringify(stamp())); } catch { /* a read-only repo: no rebase either */ } }
  // A rebase this sync could not abort keeps the note: the next lock holder settles it once this process is gone.
  try { return syncSteps(brainDir, opts); } finally { if (own && !['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(brainDir, '.git', d)))) fs.rmSync(file, { force: true }); }
}

function syncSteps(brainDir, { attempts = 3, resolutions = {} } = {}) {
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
        const P = patternsOf(brainDir);
        const settled = (f) => isException(f, P) || P.handoverFile.test(f) || P.topicFile.test(f) || resolutions[f] || (f === INDEX_FILE && hasDataIndex(brainDir));
        const both = localChanged.filter((f) => remoteChanged.includes(f) && !settled(f) && !git(['diff', '--quiet', 'HEAD', remoteHead, '--', f], { cwd: brainDir }).ok);
        if (both.length) {
          result.conflict = both;
          result.unpushed = unpushedCount(brainDir);
          return result;
        }
        // Uncommitted changes make the rebase refuse; that is not a disagreement with origin (it read as "disagreement: ").
        const dirty = git(['diff', '--name-only', 'HEAD'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
        if (dirty.length) {
          result.error = `uncommitted changes in brain block the update from origin: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}; a hand edit, not a workflow write (an interrupted one is rolled back by itself): save it through the workflow (brain.mjs write) or the operator restores it (git -C <brain> checkout HEAD -- <file>) (P-040)`;
          result.unpushed = unpushedCount(brainDir);
          return result;
        }
        const env = { ...brainScriptEnv(), GIT_EDITOR: 'true' };
        let rebase = gitRetry(['rebase', '--quiet', `origin/${branch}`], { cwd: brainDir, env });
        for (let step = 0; !rebase.ok && step < 100; step++) {
          // INDEX.md last: it is generated from the other files of the commit once they are resolved.
          const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { cwd: brainDir }).stdout.split('\n').filter(Boolean)
            .sort((a, b) => (a === INDEX_FILE) - (b === INDEX_FILE));
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
        // A rebase that merged INDEX.md by lines without a conflict: written again from the merged files.
        try { commitIndexAfterMerge(brainDir, { env, message: `${BRAIN_COMMIT_TAG} regenerate ${INDEX_FILE} after sync` }); }
        catch (err) { result.notices.push(`${INDEX_FILE} not regenerated after the sync: ${err.message}`); }
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
    // Local commits (the log commit Stop leaves local, audit 2.3a) go out first: rebase onto origin and push, so the
    // session does not start behind origin.
    if (unpushed > 0 && !dirty.length) {
      const sync = brainSyncUnlocked(brainDir);
      if (sync.pushed) { result.pulled = result.behind; result.behind = 0; return result; }
      result.reason = `${unpushed} unpushed commit(s)${sync.conflict ? ` (conflict: ${[].concat(sync.conflict).join(', ')})` : sync.error ? ` (${sync.error})` : ''}`;
      return result;
    }
    if (unpushed > 0) { result.reason = `${unpushed} unpushed commit(s)`; return result; }
    if (dirty.length) { result.reason = `uncommitted changes: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}`; return result; }
    // The note says what a killed fast-forward left (undoHalfForward).
    const note = syncNotePath(brainDir);
    try { fs.writeFileSync(note, JSON.stringify({ ...stamp(), forward: { from: git(['rev-parse', 'HEAD'], { cwd: brainDir }).stdout, to: git(['rev-parse', `origin/${branch}`], { cwd: brainDir }).stdout } })); } catch { /* a read-only repo: no fast-forward either */ }
    const ff = git(['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: brainDir, env: brainScriptEnv() });
    fs.rmSync(note, { force: true });
    if (!ff.ok) { result.error = `fast-forward failed: ${firstLine(ff.stderr)}${gitLockHint(ff.stderr)}`; return result; }
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
  return readHolderRecord(brainDir, topicId);
}

/** Topic a brain-relative path lies in (topics/<id>/...; not the archive of layout 1), by the layout of brainDir. */
export function topicOfPath(rel, brainDir = null) {
  const P = patternsOf(brainDir);
  const m = P.topicPath.exec(rel);
  if (!m || (P.archive && `${P.topics}/${m[1]}` === P.archive)) return null;
  return m[1];
}

/** Holder check for writes into topics/<id>/ (P-037, P-040 item 5). */
export function checkHolder(brainDir, rel, thread) {
  const topic = topicOfPath(rel, brainDir);
  if (!topic) return null;
  if (!thread) return `write into ${dataRel(brainDir, 'topics', topic)}/ requires a stable thread id (P-038)`;
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
  if (topicOfPath(rel, brainDir) && hasRemote(brainDir)) brainSync(brainDir);
  return checkHolder(brainDir, rel, thread);
}

/** Ids of the open topics the thread holds on this machine by the brain as it is now (no fetch). */
export function topicsHeldBy(brainDir, thread) {
  if (!brainDir || !thread) return [];
  return listTopicRecords(brainDir).filter((t) => isHolderOf(t.holder, thread)).map((t) => t.id);
}

/**
 * Spec 4.2.4 (plan B5): before any write of a thread that holds a topic, pull and verify the lock in the topic record. A
 * thread whose topic another thread took over (or closed) meanwhile writes nothing and says so in its reply. Returns
 * { lost: [{ id, holder }], checked: [ids], sync } (lost empty = every lock holds). A pull that fails leaves the local record
 * to decide (sync.error tells why); the push of the write then fails as well when origin moved on.
 */
export function verifyHeldLocks(brainDir, thread) {
  const checked = topicsHeldBy(brainDir, thread);
  if (!checked.length) return { lost: [], checked, sync: null };
  const sync = hasRemote(brainDir) ? brainSync(brainDir) : null;
  const lost = checked.map((id) => ({ id, holder: readHolder(brainDir, id) })).filter((x) => !isHolderOf(x.holder, thread));
  return { lost, checked, sync };
}

/** The refusal of a write after a lost lock (spec 4.2.4): who holds each topic now; nothing written. */
export function lockLostText(lost) {
  return lost.map(({ id, holder }) => `lock lost: topic ${id} is ${holder?.thread ? `now held by thread ${holder.thread}${holder.machine ? ` on ${holder.machine}` : ''}${holder.took_over_from ? ' (taken over)' : ''}` : 'no longer held by this thread (released or closed)'}; this thread does not hold it any more, nothing written (spec 4.2.4). Say in the reply that the lock of ${id} was lost; its work goes on with its holder, not here`).join('\n');
}

/**
 * Write files into brain and commit with the script tag; then sync.
 * ops: [{ path, content }, { path, remove: true }, { from, to }]
 * Returns { committed, sha, sync, unpushed, warnings }.
 */
/**
 * Git refuses a repo owned by another user than the process (dubious ownership): no brain write can commit. Returns the
 * fix with the exact command, or null when git works (agentic-flow-public#23: topic create left half a topic on Windows).
 * `r`: the result of a git call already made in `dir` (session start: the record author log), so the check costs no call.
 */
export function gitAccessProblem(dir, r = git(['rev-parse', '--git-dir'], { cwd: dir })) {
  if (r.ok || !/dubious ownership|safe\.directory/i.test(r.stderr)) return null;
  const home = process.env.HOME || process.env.USERPROFILE || '?';
  // git names both users (Windows: DOMAIN/user; elsewhere the uid): the operator sees whose repo it is.
  const owner = /is owned by:\s*\n?\s*'?([^'\n]+?)'?\s*(?:\(|\n|$)/i.exec(r.stderr)?.[1]?.trim();
  const me = /current user is:\s*\n?\s*'?([^'\n]+?)'?\s*(?:\(|\n|$)/i.exec(r.stderr)?.[1]?.trim();
  const who = owner || me ? ` (owner ${owner || '?'}, this process runs as ${me || '?'})` : '';
  const chown = process.platform === 'win32'
    ? `as administrator: icacls "${path.resolve(dir)}" /setowner "${me || '<this user>'}" /T /C`
    : `sudo chown -R ${me || '<this user>'} ${toPosix(dir)}`;
  return `git refuses ${toPosix(dir)} (dubious ownership: the repo belongs to another user than this process${who}); every git command there fails. Fix one way: make this user the owner (${chown}), or trust it: git config --global --add safe.directory ${toPosix(dir)} (global config of this process: HOME=${toPosix(home)}; a hook that still fails runs with another HOME, add it there too)`;
}

/** Files and new folders a write touches, as they were before it: a failed write restores them (nothing half written). */
function snapshot(brainDir, ops) {
  const files = new Map();
  const dirs = new Set();
  for (const op of ops) {
    if (op.from || op.remove || files.has(op.path)) continue;
    const file = path.join(brainDir, op.path);
    files.set(op.path, fs.existsSync(file) ? { data: fs.readFileSync(file), ms: fs.statSync(file).mtimeMs } : null);
    let top = null;
    for (let d = path.dirname(file); d.length > brainDir.length && !fs.existsSync(d); d = path.dirname(d)) top = d;
    if (top) dirs.add(top);
  }
  return () => {
    for (const [rel, was] of files) {
      const file = path.join(brainDir, rel);
      if (was === null) fs.rmSync(file, { force: true });
      else { fs.writeFileSync(file, was.data); keepTime(brainDir, rel, was.ms); }
    }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  };
}

export function brainWrite(ctx, opts) {
  return withBrainLock(ctx.brainDir, () => brainWriteUnlocked(ctx, opts));
}

// presynced: the caller fetched just before (syncAndCheckHolder), the pre-write sync is skipped.
function brainWriteUnlocked(ctx, { ops, message, internal = false, sync = true, presynced = false, agentId = null, env: extraEnv = {} }) {
  const { brainDir, thread, policy } = ctx;
  if (!brainDir) throw new Error('brain unavailable');
  if (agentId || inSubagent()) throw new Error('brain write refused in subagent; return the result to the main agent (P-025)');
  if (!message || !String(message).trim()) throw new Error('commit message required');
  const errors = [];
  const touched = [];
  const rels = ops.flatMap((op) => (op.from ? [op.from, op.to] : [op.path])).map((t) => toPosix(t).replace(/^\.\//, ''));
  // ctx.presynced: save pulled at its start to verify the held locks (verifyHeldLocks, spec 4.2.4).
  if (!internal && !presynced && !ctx.presynced && rels.some((r) => topicOfPath(r, brainDir)) && hasRemote(brainDir)) brainSync(brainDir);
  // Layout 2: a topic op and a holder op of one .tema.json become one write, merged with the file as it is now (after the sync).
  ops = mergeTopicOps(brainDir, ops);
  for (const op of ops) {
    const targets = op.from ? [op.from, op.to] : [op.path];
    for (const t of targets) {
      const rel = toPosix(t).replace(/^\.\//, '');
      if (rel.split('/').includes('..') || path.isAbsolute(rel)) errors.push(`${rel}: path must be relative inside brain`);
      const indexError = indexWriteError(brainDir, rel);
      if (indexError) errors.push(indexError);
      if (!internal) {
        const holderError = checkHolder(brainDir, rel, thread);
        if (holderError) errors.push(holderError);
      }
      // Removing or moving away a file that breaks the path rules (an older setup) fixes it; check only what stays.
      const leaving = op.remove || op.from === t;
      errors.push(...checkBrainFile(rel, leaving ? null : op.content ?? op.append ?? null, { policy, version: dataLayoutVersion(brainDir) }).filter((e) => !leaving || !e.includes('(P-049)')));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const access = gitAccessProblem(brainDir) || leftRebase(brainDir);
  if (access) throw new Error(access);

  const restore = snapshot(brainDir, ops);
  // A failed write leaves nothing behind: removed and moved paths come back from HEAD, written files from the snapshot.
  const undo = () => { backToHead(brainDir, ops.filter((op) => op.remove || op.from).flatMap((op) => (op.from ? [op.from, op.to] : [op.path]))); restore(); };
  const journal = journalPath(brainDir);
  // A path whose file already holds the content (save.mjs docs, a result in place: the agent wrote it by hand and the op
  // only commits it) is the only copy of that content: no failure and no recovery removes it or puts it back to HEAD.
  const inPlace = (op) => { try { return !op.remove && !op.from && op.content !== undefined && fs.readFileSync(path.join(brainDir, op.path)).equals(Buffer.from(op.content)); } catch { return false; } };
  const keep = ops.filter(inPlace).map((op) => toPosix(op.path).replace(/^\.\//, ''));
  const mtimes = timesOf(brainDir, rels);
  const note = (paths) => fs.writeFileSync(journal, JSON.stringify({ ...stamp(), message, paths: [...new Set(paths)], keep, mtimes }));
  // A note the recovery left belongs to a writer that still runs (this lock was taken over as stale): its staged
  // changes must not go into this commit and its note must not be lost.
  const other = readJson(journal, null);
  if (other && other.pid !== process.pid) throw new Error(`another brain write is in progress (pid ${other.pid}, since ${other.at}: ${String(other.message).slice(0, 80)}); run the step again in a moment`);
  note([...rels, ...(hasDataIndex(brainDir) ? [INDEX_FILE] : [])]);
  try {
    return applyWrite(ctx, { ops, message, sync, extraEnv, touched, undo, note, keep, journal, mtimes });
  } finally {
    // Through (committed, or put back): no note. A killed process leaves it for the next lock holder (recoverWrite).
    fs.rmSync(journal, { force: true });
  }
}

function applyWrite(ctx, { ops, message, sync, extraEnv, touched, undo, note, keep, journal, mtimes }) {
  const { brainDir } = ctx;
  // A removal no other op writes into is committed first and its files go after the commit (see journalPath).
  const inside = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
  const deferred = ops.filter((op) => op.remove && !ops.some((o) => o !== op && [o.path, o.from, o.to].some((p) => p && inside(toPosix(p), toPosix(op.path))))).map((op) => op.path);
  try { applyOps(brainDir, ops, touched, deferred); } catch (err) { undo(); throw err; }
  const env = { ...brainScriptEnv(), ...extraEnv };
  const now = touched.filter((rel) => !deferred.includes(rel));
  const add = now.length ? gitRetry(['add', '-A', '--', ...now], { cwd: brainDir, env }) : { ok: true };
  const drop = add.ok && deferred.length ? gitRetry(['rm', '-r', '--quiet', '--cached', '--ignore-unmatch', '--', ...deferred], { cwd: brainDir, env }) : { ok: true };
  if (!add.ok || !drop.ok) {
    undo();
    throw new Error(`git add failed: ${firstLine((add.ok ? drop : add).stderr)}${gitLockHint((add.ok ? drop : add).stderr)}`);
  }
  // Layout 2: INDEX.md of the staged files goes into the same commit.
  // Deploy ignore files of the repository (.assetsignore ...) get the internal folders and INDEX.md in the same commit.
  let deployIgnores = [];
  try {
    if (refreshIndex(brainDir, env)) touched.push(INDEX_FILE);
    deployIgnores = refreshDeployIgnores(brainDir, env);
    if (deployIgnores.length) { touched.push(...deployIgnores.map((x) => x.file)); note(touched); }
  } catch (err) { undo(); throw err; }
  return commitWrite(ctx, { message, sync, env, touched, deployIgnores, deferred, keep, journal, mtimes });
}

function applyOps(brainDir, ops, touched, deferred) {
  for (const op of ops) {
    if (op.from) {
      const from = path.join(brainDir, op.from);
      const to = path.join(brainDir, op.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      touched.push(op.from, op.to);
    } else if (op.remove) {
      touched.push(op.path);
      if (deferred.includes(op.path)) continue;
      const abs = path.join(brainDir, op.path);
      // Windows refuses to remove a file or a folder a program holds (the shell stands in it, a viewer shows it): a moment
      // later it often goes. A folder that stays without a file is no change for git: the removal is complete.
      try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
      catch (err) { if (removeTree(abs)) throw new Error(`${op.path}: could not be removed (${err.code || err.message}: a program holds a file of it open); nothing changed, close it and run the step again`); }
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
}

function commitWrite(ctx, { message, sync, env, touched, deployIgnores, deferred, keep, journal, mtimes }) {
  const { brainDir } = ctx;
  const staged = git(['diff', '--cached', '--quiet'], { cwd: brainDir });
  const result = { committed: false, sha: null, sync: null, unpushed: unpushedCount(brainDir), warnings: [], deployIgnores };
  if (deployIgnores.length) result.warnings.push(formatDeployIgnores(deployIgnores));
  if (!staged.ok) {
    const commit = gitRetry(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} ${message}`], { cwd: brainDir, env });
    if (!commit.ok) {
      // A refused commit (pre-commit check) leaves nothing behind: the touched paths go back to HEAD; a file written in
      // place only leaves the index.
      backToHead(brainDir, touched.filter((rel) => !keep.includes(rel)), mtimes);
      if (keep.length) git(['reset', '--quiet', '--', ...keep], { cwd: brainDir });
      throw new Error(`commit failed: ${String(commit.stderr || commit.stdout).trim().split('\n').slice(0, 6).join('\n')}${gitLockHint(commit.stderr)}`);
    }
    result.committed = true;
    result.sha = git(['rev-parse', '--short', 'HEAD'], { cwd: brainDir }).stdout;
  }
  // The removal is in git (or the path never was): its files leave the disk now. What a program holds goes later.
  const held = deferred.length ? later(brainDir, deferred) : [];
  // The write is through before the network: a slow push must not look like an interrupted write to a later lock holder.
  fs.rmSync(journal, { force: true });
  if (held.length) result.warnings.push(`removed in git, but a program holds file(s) of ${held.join(', ')} open on this machine: they go at a later brain write, nothing to do`);
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
