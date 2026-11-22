// Line endings (P-040, operator 2026-11-08: CRLF/LF differences must not happen). Two layers:
// 1. Comparisons by hash (derived-record fingerprints, own edits) read text with LF line endings, so a file that a
//    Windows git (core.autocrlf=true) or editor rewrote with CRLF is not "changed" or "someone else's edit".
// 2. Every workflow repository carries `.gitattributes` with `* text=auto eol=lf` (the brain since P-024, project
//    repositories since 2026-11-08): git stores and checks out LF on every machine, binary files stay as they are.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRemote, exists, readJson } from './util.mjs';
import { forkOf } from './fork.mjs';

export const EOL_RULE = '* text=auto eol=lf';
export const EOL_COMMIT_MSG = 'Normalize line endings to LF (.gitattributes * text=auto eol=lf)';

/** Content for hashing: CRLF -> LF in text; a buffer with a NUL byte is binary (git's test) and stays as it is. */
export function lfBytes(buf) {
  if (!buf.includes(13) || buf.subarray(0, 8000).includes(0)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/** The repository has a line-ending rule for all files (`* ... eol=...` in its root .gitattributes). */
export function hasEolRule(dir) {
  const file = path.join(dir, '.gitattributes');
  if (!exists(file)) return false;
  return /^\*\s+(?=.*\beol=)/m.test(fs.readFileSync(file, 'utf8'));
}

// The normalization has four parts (the rule file, the staged rewrite, the commit, the files on disk). A hook killed
// between them (60 s) left the rewrite of every file staged, or hundreds of files removed, and no later start repaired
// it: the rule in the working tree read as "done" (audit 2026-11-22). The note says how far the run got; the next start
// settles it first. The files on disk are written again a few at a time, so a stop leaves at most those missing.
const notePath = (dir) => path.join(dir, '.git', 'workflow-eol.note');
const chunks = (list, n = 200) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const ruleIn = (text) => /^\*\s+(?=.*\beol=)/m.test(String(text || ''));

/** The files of the normalize commit on disk as git stores them now (LF). A file with a change of its own stays. */
function rewriteFiles(dir, files) {
  const missing = files.filter((rel) => !exists(path.join(dir, rel)));
  for (const part of chunks(missing)) git(['checkout', '--', ...part], { cwd: dir });
  // git counts a CRLF copy as unchanged and writes it again only when it is gone (checkout-index --force skips it too).
  // So a few files at a time: removed, then checked out. A stop in between leaves at most those missing, and the note
  // names them for the next start. A file a program holds (Windows) stays as it is.
  const changed = new Set(git(['diff', '--name-only', '-z'], { cwd: dir }).stdout.split('\0').filter(Boolean));
  for (const part of chunks(files.filter((rel) => !changed.has(rel) && !missing.includes(rel)), 50)) {
    const gone = part.filter((rel) => { try { fs.rmSync(path.join(dir, rel)); return true; } catch { return false; } });
    if (gone.length) git(['checkout', '--', ...gone], { cwd: dir });
  }
}

/** What a run that did not finish left: before the commit the staged rewrite and the rule file go, after it the files are written. */
function settleInterrupted(dir) {
  const file = notePath(dir);
  const note = readJson(file, null);
  if (note && ruleIn(git(['show', 'HEAD:.gitattributes'], { cwd: dir }).stdout)) {
    rewriteFiles(dir, Array.isArray(note.files) ? note.files : git(['ls-files', '--deleted', '-z'], { cwd: dir }).stdout.split('\0').filter(Boolean));
  } else if (note) {
    git(['reset', '--quiet'], { cwd: dir });
    const rule = path.join(dir, '.gitattributes');
    // Only the file this run wrote: the rule in front of what was there.
    if (exists(rule) && fs.readFileSync(rule, 'utf8') === `${EOL_RULE}\n${note.before || ''}`) { if (note.before) fs.writeFileSync(rule, note.before); else fs.rmSync(rule, { force: true }); }
  }
  fs.rmSync(file, { force: true });
}

/**
 * Give a code repository the rule and normalize what it stores: write the rule, `git add --renormalize .`, commit,
 * check the normalized files out again (their CRLF copies stay on disk otherwise) and push when the branch has an
 * upstream. Only a clean main checkout (not a topic worktree) is changed; uncommitted changes are never staged with it.
 * Returns a status line, or null when there is nothing to do.
 */
export function ensureLineEndings(dir, { label = path.basename(dir), push = true } = {}) {
  // A fork keeps the upstream's bytes (its pull requests would carry the rewrite; scripts/fork.mjs).
  if (!dir || !exists(path.join(dir, '.git'))) return null;
  if (exists(notePath(dir))) settleInterrupted(dir);
  if (hasEolRule(dir) || forkOf(dir)) return null;
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: dir }).stdout;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }).stdout;
  if (!gitDir || path.resolve(gitDir) !== path.resolve(common)) return null;
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir }).ok) return null;
  if (git(['status', '--porcelain'], { cwd: dir }).stdout) return `${label}: no line-ending rule in .gitattributes; not normalized (uncommitted changes), runs again at the next session start`;
  const file = path.join(dir, '.gitattributes');
  const before = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const note = notePath(dir);
  const undo = () => {
    git(['reset', '--quiet'], { cwd: dir });
    if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
    fs.rmSync(note, { force: true });
  };
  fs.writeFileSync(note, JSON.stringify({ at: new Date().toISOString(), before }));
  // First line: a later line of .gitattributes wins, so the repository's own rules (`*.csv -text` of a CRLF fixture
  // its tests assert on, a fork of a shop app, 2026-11-19) must come after the rule for all files, not before it.
  fs.writeFileSync(file, `${EOL_RULE}\n${before}`);
  const steps = [['add', '--renormalize', '.'], ['add', '--', '.gitattributes']];
  for (const args of steps) {
    const r = git(args, { cwd: dir });
    if (!r.ok) {
      undo();
      return `${label}: line endings not normalized (git ${args.slice(0, 2).join(' ')} failed: ${r.stderr.split('\n')[0]})`;
    }
  }
  const normalized = git(['diff', '--cached', '--name-only', '-z'], { cwd: dir }).stdout.split('\0').filter((f) => f && f !== '.gitattributes');
  const commit = git(['commit', '--quiet', '-m', EOL_COMMIT_MSG], { cwd: dir });
  if (!commit.ok) {
    undo();
    return `${label}: line endings not normalized (commit failed: ${(commit.stderr || commit.stdout).split('\n')[0]})`;
  }
  // The working tree still holds the CRLF copies (git counts them as unchanged): written again as LF. A file a program
  // holds (Windows) stays as it is; git reads it as unchanged.
  fs.writeFileSync(note, JSON.stringify({ at: new Date().toISOString(), before, files: normalized }));
  rewriteFiles(dir, normalized);
  fs.rmSync(note, { force: true });
  let pushed = 'not pushed (no upstream)';
  if (push && git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: dir }).ok) {
    const r = gitRemote(['push', '--quiet'], { cwd: dir });
    pushed = r.ok ? 'pushed' : `push failed: ${r.stderr.split('\n')[0]}`;
  }
  return `${label}: line endings normalized to LF (.gitattributes ${EOL_RULE}, ${normalized.length} file(s) renormalized, committed, ${pushed})`;
}
