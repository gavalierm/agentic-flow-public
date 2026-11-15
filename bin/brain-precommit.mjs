#!/usr/bin/env node
// Check logic for brain git hooks (P-040). Called by the thin shims in <brain>/.githooks/.
//   brain-precommit.mjs pre-commit        (cwd = brain repo; staged files are checked)
//   brain-precommit.mjs commit-msg <file> (commit message must carry the script tag)
import fs from 'node:fs';
import path from 'node:path';
import { git, readText } from '../scripts/util.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV, MIGRATE_MOVE_ENV, loadPolicy } from '../scripts/config.mjs';
import { dataRel, dataLayoutVersion } from '../scripts/layout.mjs';

export const DECISION_MOVED_ENV = 'WORKFLOW_DECISION_MOVED';
// save decision --remove on an explicit operator order (P-008): the only deletion of a decision besides save move.
export const DECISION_REMOVED_ENV = 'WORKFLOW_DECISION_REMOVED';
import { checkBrainFile } from '../scripts/brain-checks.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

/** Staged added paths whose blob equals the blob of a path the same commit removes (a move without a change). */
function movedUnchanged(brainDir) {
  const raw = git(['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--diff-filter=AD'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
  const removed = new Set();
  const added = [];
  for (const line of raw) {
    const [meta, rel] = line.split('\t');
    const [, , oldSha, newSha, st] = meta.split(' ');
    if (st === 'D') removed.add(oldSha);
    else if (st === 'A') added.push([rel, newSha]);
  }
  return new Set(added.filter(([, sha]) => removed.has(sha)).map(([rel]) => rel));
}

export function checkStaged(brainDir, { env = process.env } = {}) {
  const errors = [];
  if (env[BRAIN_SCRIPT_ENV] !== '1') {
    errors.push(`commit not made by the brain script (P-040); write through save/topic/done, or as operator: git commit --no-verify`);
  }
  const policy = loadPolicy(brainDir);
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
  const unchanged = env[MIGRATE_MOVE_ENV] === '1' ? movedUnchanged(brainDir) : new Set();
  for (const rel of staged) {
    // The commit of migrate.mjs: a file it only moves (same blob as a file the commit removes) keeps the content it had;
    // the content checks are for what the move writes (rewritten paths, .tema.json, policy, .gitignore, INDEX.md).
    if (unchanged.has(rel)) {
      errors.push(...checkBrainFile(rel, null, { policy, version: dataLayoutVersion(brainDir) }));
      continue;
    }
    const show = git(['show', `:${rel}`], { cwd: brainDir });
    const content = show.ok ? show.stdout + '\n' : readText(path.join(brainDir, rel), '');
    errors.push(...checkBrainFile(rel, content, { policy, version: dataLayoutVersion(brainDir) }));
  }
  const removed = git(['diff', '--cached', '--name-only', '--diff-filter=D'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
  // save move: a decision of one repo moves into <repo>/agentic/decisions/ (D-0002); it lives on there, not deleted.
  const moved = [DECISION_MOVED_ENV, DECISION_REMOVED_ENV].flatMap((k) => String(env[k] || '').split(',')).filter(Boolean);
  for (const rel of removed) {
    if (path.posix.dirname(rel) !== dataRel(brainDir, 'decisions') || !rel.endsWith('.md') || moved.includes(rel)) continue;
    // A file without a record key is not a workflow decision (README, older format replaced when a brain is adopted).
    const before = git(['show', `HEAD:${rel}`], { cwd: brainDir });
    if (!before.ok || parseFrontmatter(before.stdout).data?.key) errors.push(`${rel}: decisions are never deleted, only superseded, except on an explicit operator order through save.mjs decision --remove D-XXXX --reason "operator ..." (P-008)`);
  }
  return errors;
}

export function checkMessage(message) {
  const first = String(message || '').split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
  return first.includes(BRAIN_COMMIT_TAG) ? [] : [`commit message lacks the brain script tag ${BRAIN_COMMIT_TAG} (P-040)`];
}

if (process.argv[1]?.endsWith('brain-precommit.mjs')) {
  const [mode, msgFile] = process.argv.slice(2);
  const brainDir = process.cwd();
  let errors = [];
  if (mode === 'commit-msg') {
    errors = checkMessage(fs.readFileSync(msgFile, 'utf8'));
  } else {
    errors = checkStaged(brainDir);
  }
  if (errors.length) {
    process.stderr.write(`brain ${mode || 'pre-commit'} rejected:\n${errors.map((e) => `- ${e}`).join('\n')}\n`);
    process.exit(1);
  }
}
