// keep: core
// P-040, P-037, P-025: brain writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { setup, memoryRecord } from './helpers.mjs';
import { setup3 } from './layout-2-helpers.mjs';
import { PLUGIN_ROOT } from '../scripts/util.mjs';

// flow-public#49: semicolons inside the sentences of items made the handover too long twice; the refusal names the items per option.
test('write commits with the script tag and pushes to origin', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/operator-operator.md', '--message', 'test write', '--content', memoryRecord('operator-operator', 'name: X')]);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] test write$/);
    assert.match(fx.git(fx.origin, 'log', '-1', '--format=%s'), /^\[brain-script\] test write$/);
    assert.doesNotMatch(r.stdout, /unpushed/);
  } finally { fx.cleanup(); }
});

test('write into a topic by a thread that is not the holder is refused', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Test topic', '--class', 'ops']).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'topics/t1/handover.md', '--message', 'x', '--content', '## Zadanie\nx\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /held by thread a1/);
  } finally { fx.cleanup(); }
});

test('write in a subagent is refused', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/operator-operator.md', '--message', 'x', '--content', memoryRecord('operator-operator')], { env: { WORKFLOW_AGENT_ID: 'sub1' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /subagent/);
  } finally { fx.cleanup(); }
});

test('record with a diacritic key or a file in local/ is refused', () => {
  const fx = setup();
  try {
    const r = fx.run('brain.mjs', ['write', 'memory/sluzba-x.md', '--message', 'x', '--content', '---\nkey: služba-x\norigin: operator\n---\nx\n']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /diacritics/);
    const r2 = fx.run('brain.mjs', ['write', 'local/index/memory.md', '--message', 'x', '--content', 'x']);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /local\//);
  } finally { fx.cleanup(); }
});

test('same file changed on both sides is a disagreement: not merged, reported with the exact resolve command; resolve --keep local settles it and pushes', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('brain.mjs', ['write', 'memory/service-x.md', '--message', 'a', '--content', memoryRecord('service-x', 'from A')]).status, 0);
    const r = fx.runB('brain.mjs', ['write', 'memory/service-x.md', '--message', 'b', '--content', memoryRecord('service-x', 'from B')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /conflict: memory\/service-x\.md/);
    assert.match(r.stdout, /unpushed: 1/);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from A/);
    assert.match(r.stdout, /settle each file: node \S+\/bin\/brain\.mjs resolve memory\/service-x\.md --keep local\|remote/);
    const s = fx.runB('brain.mjs', ['resolve', 'memory/service-x.md', '--keep', 'local']);
    assert.equal(s.status, 0, s.out);
    assert.match(s.stdout, /this machine's version kept/);
    assert.match(s.stdout, /^pushed; unpushed: 0/m);
    assert.match(fx.git(fx.origin, 'show', 'main:memory/service-x.md'), /from B/);
  } finally { fx.cleanup(); }
});

test('handover changed on two machines: both versions kept with a notice, pushed', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Ho', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'x', '--next', 'base']).status, 0);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    assert.equal(fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'x', '--next', 'next from A']).status, 0);
    fs.writeFileSync(path.join(fx.brainB, 'topics/ho/handover.md'), fx.read('topics/ho/handover.md', fx.brainB).replace('base', 'next from B'));
    fx.git(fx.brainB, 'commit', '-q', '--no-verify', '-am', 'b handover');
    const r = fx.runB('brain.mjs', ['sync']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /topic ho: handover changed on two machines, both versions kept/);
    const merged = fx.git(fx.origin, 'show', 'main:topics/ho/handover.md');
    assert.match(merged, /next from A[\s\S]*handover conflict[\s\S]*next from B/);
  } finally { fx.cleanup(); }
});

// flow-public#7: a hand edit of policy.json is refused by the pre-commit and blocks the update from origin.
test('layout 3: a write into memory/ of the brain root commits and pushes; a topic in topics/ is written only by its holder', () => {
  const fx = setup3({ thread: 'b3' });
  try {
    let r = fx.run('brain.mjs', ['write', 'memory/project-site.md', '--message', 'test write', '--content', memoryRecord('project-site', 'Web.')]);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(fx.origin, 'log', '-1', '--format=%s'), /^\[brain-script\] test write$/);
    assert.ok(fx.exists('memory/project-site.md'));
    assert.equal(fx.run('topic.mjs', ['create', 't3', '--subject', 'Test topic', '--class', 'discussion']).status, 0);
    assert.ok(fx.exists('topics/t3/.tema.json') && fx.exists('topics/t3/handover.md'));
    r = fx.run('brain.mjs', ['write', 'topics/t3/handover.md', '--message', 'x', '--content', '## Zadanie\nx\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n'], { env: { WORKFLOW_THREAD_ID: 'other' } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /held by thread b3/);
  } finally { fx.cleanup(); }
});

// Spec 4.1 last row, plan B8 (O8): the project repo and the operator repo are written through the own clone of the workflow
// with a local lock: pull, write, commit, push; a refused push pulls again and retries; INDEX.md is generated again on a
// conflict, a conflict in another file is a question to the operator and writes nothing.
const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};

/** <root>/repo.git (bare) and <root>/repo, its checkout on main with notes/ and INDEX.md (the list of notes). */
function cloneFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-clone-'));
  const origin = path.join(root, 'repo.git');
  const repo = path.join(root, 'repo');
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(root, 'init', '-q', '-b', 'main', repo);
  gitIn(repo, 'config', 'user.name', 't'); gitIn(repo, 'config', 'user.email', 't@t');
  fs.mkdirSync(path.join(repo, 'notes'));
  fs.writeFileSync(path.join(repo, 'notes', 'base.md'), 'base\n');
  fs.writeFileSync(path.join(repo, 'INDEX.md'), '- notes/base.md\n');
  gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-q', '-m', 'init');
  gitIn(repo, 'remote', 'add', 'origin', origin); gitIn(repo, 'push', '-q', '-u', 'origin', 'main');
  return { root, origin, repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A script that writes one note through the own clone (INDEX.md generated from notes/), prints the result as JSON. */
const WRITER = `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { cloneWrite } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts', 'own-clone.mjs'))};
const [repo, name, text] = process.argv.slice(2);
const index = (dir) => { fs.writeFileSync(path.join(dir, 'INDEX.md'), fs.readdirSync(path.join(dir, 'notes')).sort().map((f) => '- notes/' + f).join('\\n') + '\\n'); spawnSync('git', ['add', 'INDEX.md'], { cwd: dir }); };
try { const r = cloneWrite(repo, { branch: 'main', message: 'note ' + name, ops: [{ path: 'notes/' + name + '.md', content: text + '\\n' }], index, indexFiles: ['INDEX.md'] }); console.log(JSON.stringify(r)); }
catch (err) { console.error(err.message); process.exit(1); }`;

function writer(fx, name, text = name) {
  const file = path.join(fx.root, 'writer.mjs');
  if (!fs.existsSync(file)) fs.writeFileSync(file, WRITER);
  return [process.execPath, [file, fx.repo, name, text], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' }];
}
const runWriter = (fx, name, text) => { const r = spawnSync(...writer(fx, name, text)); return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr }; };
const runWriterAsync = (fx, name) => new Promise((resolve) => {
  const [cmd, args, opts] = writer(fx, name);
  const child = spawn(cmd, args, { env: opts.env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.on('close', (status) => resolve({ status, out }));
});

/** A post-commit hook of the repo (the own clone runs the repo's hooks) that, once, pushes a commit of another writer first. */
function competitor(fx, script) {
  const hook = path.join(fx.repo, '.git', 'hooks', 'post-commit');
  const other = path.join(fx.root, 'other');
  fs.writeFileSync(hook, `#!/bin/sh\n[ -e "${fx.root}/raced" ] && exit 0\ncase "$(git rev-parse --show-toplevel)" in */.clone) ;; *) exit 0 ;; esac\ntouch "${fx.root}/raced"\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ngit clone -q "${fx.origin}" "${other}" && cd "${other}" && ${script} && git -c user.name=o -c user.email=o@o commit -qam other && git push -q origin HEAD:main\n`);
  fs.chmodSync(hook, 0o755);
}

test('own clone: two writes at once both land on origin, in a row by the clone lock; the checkout is fast-forwarded', async () => {
  const fx = cloneFixture();
  try {
    const [a, b] = await Promise.all([runWriterAsync(fx, 'alpha'), runWriterAsync(fx, 'beta')]);
    assert.equal(a.status, 0, a.out); assert.equal(b.status, 0, b.out);
    assert.deepEqual(gitIn(fx.origin, 'ls-tree', '--name-only', 'main', 'notes/').split('\n').sort(), ['notes/alpha.md', 'notes/base.md', 'notes/beta.md']);
    assert.equal(gitIn(fx.origin, 'show', 'main:INDEX.md'), '- notes/alpha.md\n- notes/base.md\n- notes/beta.md');
    assert.ok(fs.existsSync(path.join(fx.root, '.worktrees', 'repo', '.clone', '.git')), 'clone beside the repo in .worktrees/<repo>/.clone');
    assert.equal(gitIn(fx.repo, 'rev-parse', 'HEAD'), gitIn(fx.origin, 'rev-parse', 'main'), 'clean checkout on the branch is fast-forwarded');
    assert.equal(gitIn(fx.repo, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});

test('own clone: a push refused by a newer commit pulls again and retries; INDEX.md in conflict is generated again', () => {
  const fx = cloneFixture();
  try {
    competitor(fx, `printf 'gamma\\n' > notes/gamma.md && printf 'hand-made index\\n' > INDEX.md && git add -A`);
    const r = runWriter(fx, 'alpha');
    assert.equal(r.status, 0, r.out);
    const res = JSON.parse(r.stdout);
    assert.equal(res.pushed, true);
    assert.ok(res.notes.some((n) => /INDEX\.md: conflict with origin, generated again/.test(n)), r.stdout);
    assert.deepEqual(gitIn(fx.origin, 'log', '--format=%s', 'main').split('\n'), ['note alpha', 'other', 'init'], 'our commit on top of the other one');
    assert.equal(gitIn(fx.origin, 'show', 'main:INDEX.md'), '- notes/alpha.md\n- notes/base.md\n- notes/gamma.md');
  } finally { fx.cleanup(); }
});

test('own clone: the same file changed on origin meanwhile is not merged: question to the operator, nothing written', () => {
  const fx = cloneFixture();
  try {
    competitor(fx, `printf 'from the other writer\\n' > notes/alpha.md && git add -A`);
    const r = runWriter(fx, 'alpha', 'from us');
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /notes\/alpha\.md changed on origin meanwhile as well; save does not merge another file \(spec 4\.1\): ask the operator which version holds/);
    assert.equal(gitIn(fx.origin, 'show', 'main:notes/alpha.md'), 'from the other writer');
    assert.equal(gitIn(fx.origin, 'log', '-1', '--format=%s', 'main'), 'other');
    const clone = path.join(fx.root, '.worktrees', 'repo', '.clone');
    assert.equal(gitIn(clone, 'status', '--porcelain'), '', 'the clone is left clean');
    assert.equal(gitIn(clone, 'rev-parse', 'HEAD'), gitIn(fx.origin, 'rev-parse', 'main'));
  } finally { fx.cleanup(); }
});

test('own clone: a repo without origin is refused with the command, nothing written', () => {
  const fx = cloneFixture();
  try {
    gitIn(fx.repo, 'remote', 'remove', 'origin');
    const r = runWriter(fx, 'alpha');
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /repo: no remote origin; save writes into a repo through the own clone of the workflow .*remote add origin <url>\); nothing written/);
  } finally { fx.cleanup(); }
});

test('the removal of a closed topic that a stopped close left uncommitted is committed by the sync; a topic with a file left is not touched', () => {
  // doma-pc 2026-11-22: the thread held no topic any more, so no write of the workflow could commit or restore
  // the removal, and every update from origin was refused for good.
  const fx = setup3({ thread: 'b4' });
  try {
    for (const id of ['t1', 't2']) assert.equal(fx.run('topic.mjs', ['create', id, '--subject', `Topic ${id}`, '--class', 'discussion']).status, 0);
    // Another machine pushed: the sync must rebase, and a rebase refuses uncommitted changes.
    const other = path.join(fx.root, 'other');
    fx.git(fx.root, 'clone', '-q', fx.origin, other);
    fs.writeFileSync(path.join(other, 'other.txt'), 'x\n');
    fx.git(other, 'add', '-A');
    fx.git(other, '-c', 'user.name=o', '-c', 'user.email=o@example.com', 'commit', '-q', '--no-verify', '-m', 'other machine');
    fx.git(other, 'push', '-q', 'origin', 'HEAD');
    fs.rmSync(path.join(fx.brain, 'topics', 't1'), { recursive: true });
    fs.rmSync(path.join(fx.brain, 'topics', 't2', 'handover.md'));
    const r = fx.run('brain.mjs', ['sync']);
    assert.match(r.stdout, /topic t1: its removal, left uncommitted by a close that stopped, is committed/, r.out);
    assert.match(r.stdout, /uncommitted changes in brain block the update from origin: topics\/t2\/handover\.md/, r.out);
    assert.ok(!fx.git(fx.brain, 'ls-tree', '-r', '--name-only', 'HEAD').includes('topics/t1/'), 't1 is removed in git');
    assert.ok(fx.git(fx.brain, 'ls-tree', '-r', '--name-only', 'HEAD').includes('topics/t2/handover.md'), 't2 is as it was');
    fx.git(fx.brain, 'checkout', 'HEAD', '--', 'topics/t2/handover.md');
    assert.match(fx.run('brain.mjs', ['sync']).stdout, /^pushed; unpushed: 0/m);
    const origin = fx.git(fx.origin, 'ls-tree', '-r', '--name-only', 'main');
    assert.ok(!origin.includes('topics/t1/') && origin.includes('other.txt') && origin.includes('topics/t2/handover.md'), origin);
  } finally { fx.cleanup(); }
});
