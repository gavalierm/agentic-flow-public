#!/usr/bin/env node
// Check logic for brain git hooks (P-040). Called by the thin shims in <brain>/.githooks/.
//   brain-precommit.mjs pre-commit        (cwd = brain repo; staged files are checked)
//   brain-precommit.mjs commit-msg <file> (commit message must carry the script tag)
import fs from 'node:fs';
import path from 'node:path';
import { git, readText } from '../scripts/util.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV, loadPolicy } from '../scripts/config.mjs';

export const DECISION_MOVED_ENV = 'WORKFLOW_DECISION_MOVED';
import { checkBrainFile } from '../scripts/brain-checks.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

export function checkStaged(brainDir, { env = process.env } = {}) {
  const errors = [];
  if (env[BRAIN_SCRIPT_ENV] !== '1') {
    errors.push(`commit not made by the brain script (P-040); write through save/topic/done, or as operator: git commit --no-verify`);
  }
  const policy = loadPolicy(brainDir);
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
  for (const rel of staged) {
    const show = git(['show', `:${rel}`], { cwd: brainDir });
    const content = show.ok ? show.stdout + '\n' : readText(path.join(brainDir, rel), '');
    errors.push(...checkBrainFile(rel, content, { policy }));
  }
  const removed = git(['diff', '--cached', '--name-only', '--diff-filter=D'], { cwd: brainDir }).stdout.split('\n').filter(Boolean);
  // save move: a decision of one repo moves into <repo>/agentic/decisions/ (D-0002); it lives on there, not deleted.
  const moved = String(env[DECISION_MOVED_ENV] || '').split(',').filter(Boolean);
  for (const rel of removed) {
    if (!/^decisions\/[^/]+\.md$/.test(rel) || moved.includes(rel)) continue;
    // A file without a record key is not a workflow decision (README, older format replaced when a brain is adopted).
    const before = git(['show', `HEAD:${rel}`], { cwd: brainDir });
    if (!before.ok || parseFrontmatter(before.stdout).data?.key) errors.push(`${rel}: decisions are never deleted, only superseded (P-008)`);
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
