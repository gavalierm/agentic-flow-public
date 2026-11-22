// The thread's own work (P-018, operator 2026-11-03: "cleaning up after yourself must not ask for approval"). Two cases:
// - work files: anything under `scratch/` at the top of a git repo that ignores it (the session project or a repo the
//   thread works in, e.g. ../agentic-flow/scratch/), disposable by definition (P-052);
// - own edits: a tracked file the thread changed from a clean state; while its content still equals what the thread
//   left (hash recorded after each tool call by PostToolUse), its uncommitted changes are the thread's alone, so
//   restoring or overwriting it loses nobody else's work.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lfBytes } from './eol.mjs';
import { readThreadState, updateThreadState, SCRATCH_DIR } from './config.mjs';
import { git } from './util.mjs';
import { dataPath, layoutOf, layoutFor, layoutVersions, hasScratch, ROLE_BRAIN, ROLE_REPO } from './layout.mjs';

const OWN_LIMIT = 500;
const PENDING = 'pending';

/**
 * abs lies under `<repo>/scratch/` and the repo ignores scratch/ (the scratch dir itself is not a work file); in a repo of
 * a layout without scratch/ (2, 3) under the tmp/ of a topic (`<repo>/temy/<topic>/tmp/`, `<repo>/topics/<topic>/tmp/`),
 * which the repo ignores.
 */
const TOPIC_TMP_NAMES = new Set(layoutVersions().flatMap((v) => [layoutFor(v, ROLE_BRAIN), layoutFor(v, ROLE_REPO)]).map((L) => L.topicTmp).filter(Boolean));
export function inWorkScratch(abs) {
  for (let p = path.dirname(path.resolve(abs)); p !== path.dirname(p); p = path.dirname(p)) {
    if (TOPIC_TMP_NAMES.has(path.basename(p))) {
      const top = path.dirname(path.dirname(path.dirname(p)));
      let L = null;
      try { L = fs.existsSync(path.join(top, '.git')) && !hasScratch(top) ? layoutOf(top) : null; } catch { L = null; }
      if (L && path.basename(p) === L.topicTmp && path.relative(top, path.dirname(path.dirname(p))).split(path.sep).join('/') === L.topics) {
        return git(['check-ignore', '-q', '--', path.relative(top, p).split(path.sep).join('/') + '/'], { cwd: top }).ok;
      }
    }
    if (path.basename(p) !== SCRATCH_DIR) continue;
    const repo = path.dirname(p);
    if (!fs.existsSync(path.join(repo, '.git'))) continue;
    return git(['check-ignore', '-q', '--', SCRATCH_DIR], { cwd: repo }).ok;
  }
  return false;
}

export function fileHash(abs) {
  try {
    if (!fs.statSync(abs).isFile()) return null;
    return createHash('sha1').update(lfBytes(fs.readFileSync(abs))).digest('hex');
  } catch {
    return null;
  }
}

function ownEdits(ctx) {
  if (!ctx.brainDir || !ctx.thread) return null;
  return readThreadState(ctx.brainDir, ctx.thread).own_edits || {};
}

/**
 * `state` with `changes` in its own edits (path → hash; null: the file leaves the list). A hook computes the changes
 * before the lock and applies them to the current list inside updateThreadState, so the hooks of parallel tool calls
 * keep each other's files.
 */
function withOwnEdits(state, changes) {
  const edits = { ...(state.own_edits || {}) };
  for (const [abs, h] of Object.entries(changes)) {
    if (h) edits[abs] = h;
    else delete edits[abs];
  }
  const keys = Object.keys(edits);
  return { ...state, own_edits: keys.length > OWN_LIMIT ? Object.fromEntries(keys.slice(-OWN_LIMIT).map((k) => [k, edits[k]])) : edits };
}

const saveOwnEdits = (ctx, changes) => updateThreadState(ctx.brainDir, ctx.thread, (state) => withOwnEdits(state, changes));

/** The current content of abs is exactly what this thread left: its uncommitted changes are the thread's own. */
export function ownedEdit(ctx, abs) {
  const h = ownEdits(ctx)?.[abs];
  return Boolean(h && h !== PENDING && h === fileHash(abs));
}

/** PreToolUse: a tracked clean file the tool is about to change becomes the thread's own edit (hash set after the tool). */
export function claimOwn(ctx, files) {
  const edits = ownEdits(ctx);
  if (!edits || !files.length) return;
  const changes = {};
  for (const abs of files) {
    if (edits[abs] && (edits[abs] === PENDING || edits[abs] === fileHash(abs))) continue;
    changes[abs] = PENDING;
  }
  if (Object.keys(changes).length) saveOwnEdits(ctx, changes);
}

/** PostToolUse: record what the thread left in each own file; a deleted file leaves the list. */
export function settleOwn(ctx, files) {
  const edits = ownEdits(ctx);
  if (!edits) return;
  const changes = {};
  for (const abs of files) if (abs in edits) changes[abs] = fileHash(abs) || null;
  if (Object.keys(changes).length) saveOwnEdits(ctx, changes);
}

/** Files a shell command edits in place (`sed -i`, `perl -i`): not deleted, but changed like an Edit. */
export function inPlaceEdits(words) {
  const prog = words[0]?.split('/').pop();
  if (prog !== 'sed' && prog !== 'perl') return [];
  if (!words.some((w) => /^-(?![MmIdDe])[0-9a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) return [];
  const positional = [];
  let hasScript = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-e' || w === '-f' || w === '--expression' || w === '--file') { hasScript = true; i++; continue; }
    if (w.startsWith('-')) continue;
    positional.push(w);
  }
  return hasScript ? positional : positional.slice(1);
}

// Shell writes the hooks cannot parse (a python or node script, a generator, `git apply`): PreToolUse records which
// tracked files are dirty in the repos the command works in, PostToolUse compares. A file clean before and changed
// after was changed by this command, so it is the thread's own edit like an Edit or `sed -i` (alice 2026-11-03:
// edits by a python heredoc were not own and the later `git restore` asked the operator, P-018).
const SHELL_LIMIT = 20;
const CREATED_LIMIT = 500; // same cap as created_files in pre-tool-use

function dirtyTracked(top) {
  const r = git(['diff', '--name-only', 'HEAD'], { cwd: top });
  return r.ok ? r.stdout.split('\n').filter(Boolean).map((rel) => path.resolve(top, rel)) : null;
}

/**
 * Untracked and ignored entries of a repo (a wholly new directory collapsed to one entry). An entry that appears during
 * a shell command was made by it, also as a program's side effect (`wrangler deploy` makes `.wrangler/`), so removing
 * it later is cleaning up after itself (alice 2026-11-04: `rm -rf .wrangler` after a dry-run asked the operator, P-018).
 */
function strayEntries(top) {
  const r = git(['status', '--porcelain', '--ignored', '-z'], { cwd: top });
  if (!r.ok) return null;
  return r.stdout.split('\0').filter((e) => /^(\?\?|!!) /.test(e)).map((e) => path.resolve(top, e.slice(3).replace(/\/$/, '')));
}

/**
 * PreToolUse (shell): remember the dirty tracked files of each repo under dirs, keyed by the tool call; births are files
 * that do not exist yet and that the command may create outside those repos (thread state of a test sender).
 */
export function snapshotShell(ctx, id, dirs, births = []) {
  const edits = ownEdits(ctx);
  if (!edits || !id) return;
  const tops = [...new Set(dirs.map((d) => fs.existsSync(d) && git(['rev-parse', '--show-toplevel'], { cwd: d })).filter((r) => r && r.ok).map((r) => r.stdout))];
  const dirty = {};
  const strays = [];
  for (const top of tops) {
    for (const abs of dirtyTracked(top) || []) {
      // One hash and the list read above: ownedEdit read the thread state again for every dirty file.
      const h = fileHash(abs);
      dirty[abs] = { h, own: Boolean(h && edits[abs] === h) };
    }
    strays.push(...(strayEntries(top) || []));
  }
  updateThreadState(ctx.brainDir, ctx.thread, (state) => {
    const before = Object.entries(state.shell_before || {}).slice(-(SHELL_LIMIT - 1));
    return { ...state, shell_before: { ...Object.fromEntries(before), [id]: { tops, dirty, strays, births } } };
  });
}

/** PostToolUse (shell): files the command changed from clean, or changed further while own, become own edits. */
export function settleShell(ctx, id) {
  const edits = ownEdits(ctx);
  if (!edits || !id) return;
  const snap = readThreadState(ctx.brainDir, ctx.thread).shell_before?.[id];
  if (!snap) return;
  const changes = {};
  for (const top of snap.tops) {
    for (const abs of dirtyTracked(top) || []) {
      const was = snap.dirty[abs];
      const h = fileHash(abs);
      if (h && (!was || (was.own && was.h !== h))) changes[abs] = h;
    }
  }
  const had = new Set(snap.strays || []);
  const born = [...(snap.strays ? snap.tops.flatMap((top) => strayEntries(top) || []).filter((abs) => !had.has(abs) && !inWorkScratch(abs)) : []),
    ...(snap.births || []).filter((abs) => fs.existsSync(abs))];
  // One change of the current state: the snapshot of this call leaves, its new files and own edits join the lists.
  updateThreadState(ctx.brainDir, ctx.thread, (state) => {
    const { [id]: _, ...rest } = state.shell_before || {};
    const created = [...(state.created_files || []).filter((f) => !born.includes(f)), ...born].slice(-CREATED_LIMIT);
    return withOwnEdits({ ...state, shell_before: rest, created_files: created }, changes);
  });
}

// report-143e7cdb (2026-11-13): `rm -rf scratch/<dir>` of one topic removed drafts another topic had put into the same
// directory; every scratch/ file counted as the remover's own work. Each thread records the scratch files it writes, and a
// removal or overwrite that would hit a file another thread of the same brain recorded asks instead (P-018).
const SCRATCH_LIMIT = 500;

/** PostToolUse: existing files under a work scratch/ the tool wrote become this thread's scratch files. */
export function recordScratch(ctx, files, inScratch = inWorkScratch) {
  if (!ctx.brainDir || !ctx.thread) return;
  const mine = files.map((f) => path.resolve(f)).filter((abs) => inScratch(abs) && fileHash(abs));
  if (!mine.length) return;
  updateThreadState(ctx.brainDir, ctx.thread, (state) => ({ ...state, scratch_files: [...(state.scratch_files || []).filter((f) => !mine.includes(f)), ...mine].slice(-SCRATCH_LIMIT) }));
}

/** Files at or under target that another thread of this brain recorded as its scratch files and that still exist. */
export function foreignScratch(ctx, target) {
  if (!ctx.brainDir || !ctx.thread) return [];
  const dir = dataPath(ctx.brainDir, 'local', 'threads');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const abs = path.resolve(target);
  const out = [];
  for (const n of names) {
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!st || String(st.thread) === String(ctx.thread)) continue;
    for (const f of st.scratch_files || []) {
      if ((f === abs || f.startsWith(abs + path.sep)) && fs.existsSync(f)) out.push({ file: f, thread: String(st.thread) });
    }
  }
  return out;
}
