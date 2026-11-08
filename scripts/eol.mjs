// Line endings (P-040, operator 2026-11-08: CRLF/LF differences must not happen). Two layers:
// 1. Comparisons by hash (derived-record fingerprints, own edits) read text with LF line endings, so a file that a
//    Windows git (core.autocrlf=true) or editor rewrote with CRLF is not "changed" or "someone else's edit".
// 2. Every workflow repository carries `.gitattributes` with `* text=auto eol=lf` (the brain since P-024, project
//    repositories since 2026-11-08): git stores and checks out LF on every machine, binary files stay as they are.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitRemote, exists } from './util.mjs';

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

/**
 * Give a code repository the rule and normalize what it stores: write the rule, `git add --renormalize .`, commit,
 * check the normalized files out again (their CRLF copies stay on disk otherwise) and push when the branch has an
 * upstream. Only a clean main checkout (not a topic worktree) is changed; uncommitted changes are never staged with it.
 * Returns a status line, or null when there is nothing to do.
 */
export function ensureLineEndings(dir, { label = path.basename(dir), push = true } = {}) {
  if (!dir || !exists(path.join(dir, '.git')) || hasEolRule(dir)) return null;
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: dir }).stdout;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir }).stdout;
  if (!gitDir || path.resolve(gitDir) !== path.resolve(common)) return null;
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir }).ok) return null;
  if (git(['status', '--porcelain'], { cwd: dir }).stdout) return `${label}: no line-ending rule in .gitattributes; not normalized (uncommitted changes), runs again at the next session start`;
  const file = path.join(dir, '.gitattributes');
  const before = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${EOL_RULE}\n`);
  const steps = [['add', '--renormalize', '.'], ['add', '--', '.gitattributes']];
  for (const args of steps) {
    const r = git(args, { cwd: dir });
    if (!r.ok) {
      git(['reset', '--quiet'], { cwd: dir });
      if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
      return `${label}: line endings not normalized (git ${args.slice(0, 2).join(' ')} failed: ${r.stderr.split('\n')[0]})`;
    }
  }
  const normalized = git(['diff', '--cached', '--name-only', '-z'], { cwd: dir }).stdout.split('\0').filter((f) => f && f !== '.gitattributes');
  const commit = git(['commit', '--quiet', '-m', EOL_COMMIT_MSG], { cwd: dir });
  if (!commit.ok) {
    git(['reset', '--quiet'], { cwd: dir });
    if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
    return `${label}: line endings not normalized (commit failed: ${(commit.stderr || commit.stdout).split('\n')[0]})`;
  }
  // The working tree still holds the CRLF copies (git counts them as unchanged): check them out again as LF.
  for (const rel of normalized) fs.rmSync(path.join(dir, rel), { force: true });
  for (let i = 0; i < normalized.length; i += 200) git(['checkout', '--', ...normalized.slice(i, i + 200)], { cwd: dir });
  let pushed = 'not pushed (no upstream)';
  if (push && git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: dir }).ok) {
    const r = gitRemote(['push', '--quiet'], { cwd: dir });
    pushed = r.ok ? 'pushed' : `push failed: ${r.stderr.split('\n')[0]}`;
  }
  return `${label}: line endings normalized to LF (.gitattributes ${EOL_RULE}, ${normalized.length} file(s) renormalized, committed, ${pushed})`;
}
