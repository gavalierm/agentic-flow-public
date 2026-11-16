// ttl: 2026-12-15
// migrate --check after the move of a domain (reports of the domain migration): a tracked name with diacritics was
// reported "tracked before the move, missing in .brain/migrate-1-2.tsv", because git printed it quoted under
// core.quotepath ("\304\276"); and in a fresh clone every untracked file the move put outside git was reported "moved
// outside git to temy/main/tmp/..., not there", though outside git such files exist only on the machine that ran the move.
// A clone of another machine not pulled after the move of its domain to layout 3 (spec 11.10, plan B16): the session start
// refuses work in it until the pull.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, setup3, makeLayout2Repo, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

function commitFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `${BRAIN_COMMIT_TAG} fixture`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

/** A layout 1 project repo with a tracked name with diacritics and untracked work files in scratch/. */
function project(fx, name) {
  const web = path.join(fx.root, name);
  initProject(web);
  gitq(web, 'config', 'core.quotepath', 'true');
  commitFiles(web, { '.gitignore': 'scratch/\n', 'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n', 'podklady/cenník-ľúbivý.txt': 'c\n' });
  for (const [rel, text] of Object.entries({ 'scratch/notes.txt': 'n\n', 'scratch/run/out.log': 'o\n' })) {
    fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true });
    fs.writeFileSync(path.join(web, rel), text);
  }
  return web;
}

test('a tracked name with diacritics is in the move record: --check reports nothing missing', () => {
  const fx = setup2({ thread: 'mc1' });
  try {
    const web = project(fx, 'web');
    const a = fx.run('migrate.mjs', [web, '--apply']);
    assert.equal(a.status, 0, a.out);
    assert.ok(fs.existsSync(path.join(web, 'podklady', 'cenník-ľúbivý.txt')), a.out);
    const c = fx.run('migrate.mjs', [web, '--check']);
    assert.doesNotMatch(c.out, /tracked before the move, missing/, c.out);
    assert.doesNotMatch(c.out, /\\30[0-9]/, c.out);
    assert.equal(c.status, 0, c.out);
  } finally { fx.cleanup(); }
});

test('a fresh clone after the move: files moved outside git are a note, not a problem; on the apply they are checked', () => {
  const fx = setup2({ thread: 'mc2' });
  try {
    const web = project(fx, 'web2');
    const tsv = path.join(fx.root, 'triage.tsv');
    assert.equal(fx.run('migrate.mjs', [web, '--write-triage', tsv]).status, 0);
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.equal(a.status, 0, a.out);
    assert.match(a.stdout, /check: ok/, a.out);
    assert.ok(fs.existsSync(path.join(web, 'temy', 'main', 'tmp', 'notes.txt')), a.out);
    // The machine that ran the move: the check sees the files and says nothing about them.
    const here = fx.run('migrate.mjs', [web, '--check']);
    assert.equal(here.status, 0, here.out);
    assert.doesNotMatch(here.out, /moved outside git|put outside git/, here.out);
    // A fresh clone has no untracked files by design.
    fs.mkdirSync(path.join(fx.root, 'other'));
    const clone = path.join(fx.root, 'other', 'web2');
    gitq(path.join(fx.root, 'other'), 'clone', '-q', web, clone);
    const c = fx.run('migrate.mjs', [clone, '--check']);
    assert.doesNotMatch(c.out, /moved outside git to .*not there/, c.out);
    assert.match(c.out, /note: 2 file\(s\) the move put outside git are not here \(temy\/main\/tmp\/notes\.txt, temy\/main\/tmp\/run\/out\.log\)/, c.out);
    assert.equal(c.status, 0, c.out);
  } finally { fx.cleanup(); }
});

test('a clone not pulled after the domain moved to layout 3: the session start refuses it until git pull, then starts', () => {
  const fx = setup3({ thread: 'mc3', projectLayout: 2 });
  try {
    const clone = path.join(fx.root, 'project-b');
    gitq(fx.root, 'clone', '-q', fx.project, clone);
    makeLayout2Repo(fx.project, 3);
    const opts = { cwd: clone, projectDir: clone };
    let h = fx.hook('session-start.mjs', { source: 'startup' }, opts);
    assert.match(h.context, /STOP, work refused: data layout of repo .*project-b is 2, the brain of its domain .* has 3/, h.context);
    assert.match(h.context, /git -C \S*project-b pull/);
    gitq(clone, 'pull', '-q');
    h = fx.hook('session-start.mjs', { source: 'startup' }, opts);
    assert.doesNotMatch(h.context, /STOP/, h.context);
    assert.match(h.context, /Tvar dát tohto repa \(verzia 3;/);
  } finally { fx.cleanup(); }
});
