// ttl: 2026-12-15
// Target branch of a repo (flow v2 spec 4.6, 4.1; plan B11, O12, O14, O18): `target_branch` in .workflow.json, default
// main (knowledge_branch is not read any more); `target_protected: true` sends non-code content to topic/<t>--obsah of the
// own clone. save.mjs source writes a source at once into zdroje/<topic>/ of the main target repo of the topic (the
// default repo of the domain when the topic names none), on the target branch, or on topic/<t>--obsah when protected;
// save --repo knowledge follows the same branch. A merge request goes through gh when it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { domain3, gitq } from './layout-2-helpers.mjs';
import { targetBranch, targetProtected, contentTarget, targetRepos, mergeRequest, DEFAULT_TARGET_BRANCH } from '../scripts/target.mjs';

const config = (fx, dir, cfg) => {
  fs.writeFileSync(path.join(dir, '.workflow.json'), JSON.stringify({ brain: '../brain', ...cfg }) + '\n');
  gitq(dir, 'commit', '-qam', 'config'); gitq(dir, 'push', '-q', 'origin', 'HEAD');
};

test('target branch: main by default, target_branch when set, knowledge_branch not read; protected -> topic/<t>--obsah', () => {
  const fx = domain3({ web: false });
  try {
    assert.equal(DEFAULT_TARGET_BRANCH, 'main');
    assert.equal(targetBranch(fx.project), 'main');
    assert.equal(targetProtected(fx.project), false);
    fs.writeFileSync(path.join(fx.project, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'dev' }) + '\n');
    assert.equal(targetBranch(fx.project), 'main', 'the old key is gone (O12)');
    fs.writeFileSync(path.join(fx.project, '.workflow.json'), JSON.stringify({ brain: '../brain', target_branch: 'dev', target_protected: true }) + '\n');
    assert.equal(targetBranch(fx.project), 'dev');
    assert.deepEqual(contentTarget(fx.project, 't1'), { branch: 'topic/t1--obsah', target: 'dev', protected: true });
    assert.throws(() => contentTarget(fx.project, null), /protected/);
  } finally { fx.cleanup(); }
});

test('target repos: the list of .tema.json, else default_repo of the domain brain, else none', () => {
  const fx = domain3({ web: false, defaultRepo: 'project' });
  try {
    const ctx = { brainDir: fx.brain, domain: { brain: fx.brain, root: fx.root } };
    assert.deepEqual(targetRepos(ctx, { repos: { main: 'web', list: ['project', 'web'] } }), { main: 'web', list: ['project', 'web'], from: 'topic' });
    assert.deepEqual(targetRepos(ctx, { repos: { main: null, list: [] } }), { main: 'project', list: ['project'], from: 'default' });
    const bare = { brainDir: fx.project };
    assert.deepEqual(targetRepos(bare, { repos: { main: null, list: [] } }), { main: null, list: [], from: 'none' });
  } finally { fx.cleanup(); }
});

test('save.mjs source: zdroje/<topic>/ of the main target repo on its target branch through the own clone; a topic without a target repo is refused', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 's1', '--subject', 'Zdroje', '--class', 'ops']).status, 0);
    const src = path.join(fx.root, 'in', 'Export 1.csv');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'a,b\n');
    let r = fx.run('save.mjs', ['source', src]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /has no target repo/);
    const policy = path.join(fx.brain, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({ ...JSON.parse(fs.readFileSync(policy, 'utf8')), default_repo: 'project' }) + '\n');
    gitq(fx.brain, 'commit', '-qam', 'default repo', '--no-verify'); gitq(fx.brain, 'push', '-q', 'origin', 'HEAD');
    r = fx.run('save.mjs', ['source', src, '--description', 'export klienta', '--from', 'operátor']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /main, pushed from the own clone/);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'main').includes('zdroje/s1/Export 1.csv'), r.out);
    assert.equal(JSON.parse(fx.showOrigin(fx.projectOrigin, 'main:.brain/sources.json'))['zdroje/s1/Export 1.csv'].description, 'export klienta');
    assert.match(fx.showOrigin(fx.projectOrigin, 'main:INDEX.md'), /zdroje\/s1\/Export 1\.csv \| export klienta/);
    r = fx.run('save.mjs', ['source', src]);
    assert.equal(r.status, 1, 'an existing source is not changed');
    // A file over the limit: only its record goes to git; --check lists the sources over the limit.
    r = fx.run('save.mjs', ['source', '--record', src, '--from', 'https://example.test/export']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.showOrigin(fx.projectOrigin, 'main:zdroje/s1/Export 1.csv.zaznam.json')).from, 'https://example.test/export');
    assert.equal(fx.run('save.mjs', ['source', '--check']).status, 0);
    // target_branch dev: the next source lands on dev, not on main.
    gitq(fx.project, 'checkout', '-q', '-b', 'dev'); gitq(fx.project, 'push', '-q', 'origin', 'dev');
    config(fx, fx.project, { target_branch: 'dev' });
    r = fx.run('save.mjs', ['source', src, '--as', 'druhy.csv']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'dev').includes('zdroje/s1/druhy.csv'));
    assert.ok(!fx.onOrigin(fx.projectOrigin, 'main').includes('zdroje/s1/druhy.csv'));
  } finally { fx.cleanup(); }
});

test('protected target branch: save.mjs source and save --repo knowledge go to topic/<t>--obsah, the target branch stays untouched', () => {
  const fx = domain3({ web: false, defaultRepo: 'project' });
  try {
    config(fx, fx.project, { target_protected: true });
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 's2', '--subject', 'Chránené', '--class', 'ops']).status, 0);
    const src = path.join(fx.root, 'brief.txt');
    fs.writeFileSync(src, 'brief\n');
    let r = fx.run('save.mjs', ['source', src]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /topic\/s2--obsah, pushed from the own clone.*protected/);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'topic/s2--obsah').includes('zdroje/s2/brief.txt'));
    assert.ok(!fx.onOrigin(fx.projectOrigin, 'main').includes('zdroje/s2/brief.txt'));
    r = fx.run('save.mjs', ['memory', 'tool', 'alpha', '--content', 'Build tool of project.', '--repo', 'project']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'topic/s2--obsah').some((f) => /memory\/tool-alpha\.md$/.test(f)), r.out);
    assert.ok(!fx.onOrigin(fx.projectOrigin, 'main').some((f) => /memory\/tool-alpha\.md$/.test(f)));
  } finally { fx.cleanup(); }
});

test('merge request (O14): through gh when it runs (an open one reused), else the exact command', () => {
  const fx = domain3({ web: false });
  try {
    const log = path.join(fx.root, 'gh.log');
    const gh = path.join(fx.root, 'gh-stub.sh');
    fs.writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${log}\ncase "$1" in --version) echo gh 2.0;; pr) [ "$2" = create ] && echo https://example.test/pull/7 || exit 1;; esac\n`);
    fs.chmodSync(gh, 0o755);
    const prev = process.env.WORKFLOW_GH_CLI;
    process.env.WORKFLOW_GH_CLI = gh;
    try {
      const r = mergeRequest(fx.project, { head: 'topic/x', base: 'main', title: 't', body: 'b' });
      assert.equal(r.url, 'https://example.test/pull/7');
      assert.match(fs.readFileSync(log, 'utf8'), /pr create --head topic\/x --base main/);
      process.env.WORKFLOW_GH_CLI = path.join(fx.root, 'no-gh');
      const none = mergeRequest(fx.project, { head: 'topic/x', base: 'main', title: 't "q"', body: 'b' });
      assert.equal(none.url, null);
      assert.match(none.command, /gh pr create --head topic\/x --base main --title "t \\"q\\""/);
    } finally { if (prev === undefined) delete process.env.WORKFLOW_GH_CLI; else process.env.WORKFLOW_GH_CLI = prev; }
  } finally { fx.cleanup(); }
});
