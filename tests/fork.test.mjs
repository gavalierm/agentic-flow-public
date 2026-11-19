// ttl: 2026-12-19
// a fork of a shop app, 2026-11-19: connect appended `* text=auto eol=lf` after the repo's `*.csv -text`, so the later rule won
// and a CRLF fixture its tests assert on was rewritten. The rule now goes first. A fork of another developer's repo keeps
// the upstream's bytes and commits no workflow file: ignore lines go to info/exclude, a topic worktree gets a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureLineEndings } from '../scripts/eol.mjs';
import { setupFork, seedWorktree, forkOf } from '../scripts/fork.mjs';
import { ensureGitignore } from '../scripts/skills-sync.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function repo(base) {
  const dir = path.join(base, 'r');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.csv -text -diff\n');
  fs.writeFileSync(path.join(dir, 'a.csv'), 'x;y\r\n1;2\r\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'one\r\ntwo\r\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('line-ending rule goes first: the repo rule for a CRLF fixture still wins', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eol-'));
  try {
    const dir = repo(base);
    assert.match(ensureLineEndings(dir, { push: false }), /normalized/);
    assert.equal(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8').split('\n')[0], '* text=auto eol=lf');
    assert.equal(git(dir, 'show', 'HEAD:a.csv'), 'x;y\r\n1;2', 'fixture bytes kept');
    assert.equal(git(dir, 'show', 'HEAD:b.txt'), 'one\ntwo', 'other text normalized');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('fork: no normalization, ignore lines in info/exclude, workflow files copied into a worktree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fork-'));
  try {
    const dir = repo(base);
    fs.writeFileSync(path.join(dir, '.workflow.json'), '{"brain":"../b"}\n');
    assert.match(setupFork(dir, { upstream: 'up/r', url: null }), /fork of up\/r/);
    assert.equal(forkOf(dir), 'up/r');
    assert.equal(ensureLineEndings(dir, { push: false }), null);
    assert.equal(ensureGitignore(dir, ['.claude/skills/', 'local/']), false);
    assert.ok(!fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8').includes('eol='));
    assert.equal(git(dir, 'status', '--porcelain'), '', 'workflow files ignored, nothing to commit');
    assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /\/\.workflow\.json\n[\s\S]*local\//);
    const wt = path.join(base, 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'topic/x', wt);
    assert.deepEqual(seedWorktree(dir, wt), ['.workflow.json']);
    assert.equal(forkOf(wt), 'up/r');
    assert.equal(git(wt, 'status', '--porcelain'), '');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
