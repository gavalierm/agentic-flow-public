// ttl: 2026-12-22
// Audit of half-done states 2026-11-22: a line-ending normalization killed between its parts was never repaired (a staged
// rewrite of every file, or files removed), and a save into a repo made from a checkout behind origin wrote the old
// record over the newer one and said "written".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureLineEndings, EOL_RULE } from '../scripts/eol.mjs';
import { domain3 } from './layout-2-helpers.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

test('a line-ending normalization that stopped half way is settled by the next start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-eol-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) git(dir, 'config', k, v);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\r\nb\r\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'c\r\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'crlf');
    const note = path.join(dir, '.git', 'workflow-eol.note');
    // stopped after the staged rewrite, before the commit
    fs.writeFileSync(note, JSON.stringify({ before: '' }));
    fs.writeFileSync(path.join(dir, '.gitattributes'), `${EOL_RULE}\n`);
    git(dir, 'add', '--renormalize', '.');
    assert.match(ensureLineEndings(dir, { push: false }), /normalized to LF .*2 file\(s\) renormalized, committed/);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\nb\n');
    assert.equal(fs.existsSync(note), false);
    // stopped after the commit, while the files were written again
    fs.rmSync(path.join(dir, 'a.txt'));
    fs.writeFileSync(note, JSON.stringify({ before: '', files: ['a.txt', 'b.txt'] }));
    assert.equal(ensureLineEndings(dir, { push: false }), null);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\nb\n');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a repo save made from a checkout behind origin is refused; the newer record stays', () => {
  const fx = domain3();
  // outside the domain: a clone inside it would be one more repo of the domain
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-other-'));
  try {
    const save = (...rest) => fx.run('save.mjs', ['memory', 'service', 'api', '--repo', 'web', ...rest]);
    assert.equal(save('--content', 'v1: port 8080').status, 0);
    // another machine saves v2; this checkout does not have it
    git(os.tmpdir(), 'clone', '-q', fx.webOrigin, other);
    const rel = git(other, 'ls-files').split('\n').find((f) => /service-api\.md$/.test(f));
    fs.writeFileSync(path.join(other, rel), fs.readFileSync(path.join(other, rel), 'utf8').replace('v1: port 8080', 'v2: port 8443'));
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'v2', '--no-verify'], { cwd: other });
    git(other, 'push', '-q');
    // a change that keeps the body reads the body from the checkout: v1
    let r = save('--relates-to', 'P-013');
    assert.notEqual(r.status, 0);
    assert.match(`${r.out}${r.stderr}`, /on origin is another version than the one in .*nothing written: the checkout is updated now, then run the save again/);
    assert.match(git(fx.webOrigin, 'show', `main:${rel}`), /v2: port 8443/);
    r = save('--relates-to', 'P-013');
    assert.equal(r.status, 0, r.out);
    assert.match(git(fx.webOrigin, 'show', `main:${rel}`), /v2: port 8443/);
  } finally { fx.cleanup(); fs.rmSync(other, { recursive: true, force: true }); }
});
