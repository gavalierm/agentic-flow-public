// keep: core
// done in data layout 3 (flow v2 spec 5, 4.1, 4.6, 5.4, 10.6 item 4; plan B12, O14): the triage by type into vystupy/<typ>/ of
// the main target repo with the topic in the header, a new type only with the operator's yes (without it nothing moves),
// topics/<topic>/ removed in git; two target repos merged in turn, one failure leaves the topic open with the step
// "dokončiť zlúčenie <repo>"; a protected target branch is not merged (merge request in Úlohy pre operátora, the topic
// stays open until the merge); done --cancel only on the operator's instruction; a topic in mode discussion likewise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { domain3, gitq } from './layout-2-helpers.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const listFile = (fx, text) => { const f = path.join(fx.root, 'triage.txt'); fs.writeFileSync(f, text); return f; };
const commitIn = (dir, file, text, message) => { write(path.join(dir, file), text); gitq(dir, 'add', '-A'); gitq(dir, 'commit', '-q', '-m', message); };
const DONE = ['--topic', '--verified', 'observed', '--knowledge', 'nic nové'];

/** A result of the topic saved by the manager (save.mjs result, spec 5). */
function result(fx, id, name, text) {
  const src = path.join(fx.root, 'in', name);
  write(src, text);
  const r = fx.run('save.mjs', ['result', src, '--topic', id]);
  assert.equal(r.status, 0, r.out);
}

test('triage by type: the list first; an unknown type and a new type without the operator move nothing; with the yes the output goes to vystupy/<typ>/ with the topic in its header and topics/<topic>/ ends', () => {
  const fx = domain3({ defaultRepo: 'project', web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Audit', '--class', 'ops']).status, 0);
    result(fx, 't1', 'analyza.md', '# Analýza\n\ntext\n');
    result(fx, 't1', 'beh.log', 'log\n');
    assert.ok(fx.exists('topics/t1/analyza.md'));
    let r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /triage: topic t1 has 2 file\(s\)/);
    assert.match(r.out, /^\? analyza\.md$/m);
    assert.ok(fx.exists('topics/t1/.tema.json'), 'not closed without --triage');
    const head = gitq(fx.brain, 'rev-parse', 'HEAD');
    r = fx.run('done.mjs', [...DONE, '--triage', listFile(fx, 'audity analyza.md\nzanikne beh.log\n')]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /no type audity; a new type is "novy:audity analyza\.md"/);
    r = fx.run('done.mjs', [...DONE, '--triage', listFile(fx, 'novy:audity analyza.md\nzanikne beh.log\n')]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /no dialog in this turn/);
    assert.equal(gitq(fx.brain, 'rev-parse', 'HEAD'), head, 'nothing written into the brain');
    assert.deepEqual(fx.onOrigin(fx.projectOrigin, 'main').filter((f) => f.startsWith('vystupy/')), [], 'nothing moved');
    fx.thread({ dialog_answered_at: new Date().toISOString() });
    r = fx.run('done.mjs', [...DONE, '--triage', listFile(fx, 'novy:audity analyza.md\nzanikne beh.log\n')]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'main').includes('vystupy/audity/analyza.md'), r.out);
    assert.match(fx.showOrigin(fx.projectOrigin, 'main:vystupy/audity/analyza.md'), /^---\ntopic: t1\n---\n# Analýza/);
    assert.match(fx.showOrigin(fx.projectOrigin, 'main:INDEX.md'), /vystupy\/audity\/analyza\.md/);
    assert.ok(!fx.exists('topics/t1'), 'topics/t1/ ends');
    assert.ok(!gitq(fx.brain, 'ls-tree', '-r', '--name-only', 'HEAD').includes('topics/t1/handover.md'));
    assert.ok(fs.existsSync(path.join(fx.project, 'vystupy', 'audity', 'analyza.md')), 'the checkout is fast-forwarded');
    // The next output of the type needs no question: the type exists now.
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 't2', '--subject', 'Audit 2', '--class', 'ops']).status, 0);
    result(fx, 't2', 'druhy.md', '---\ntitle: Druhý\n---\n# Druhý\n');
    r = fx.run('done.mjs', [...DONE, '--topic-id', 't2', '--triage', listFile(fx, 'audity druhy.md\n')]);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.showOrigin(fx.projectOrigin, 'main:vystupy/audity/druhy.md'), /^---\ntopic: t2\ntitle: Druhý\n---/);
  } finally { fx.cleanup(); }
});

test('two target repos: merged in turn; a conflict in one leaves the topic open with "dokončiť zlúčenie <repo>", the other is merged; done again closes it', () => {
  const fx = domain3();
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    const r0 = fx.run('topic.mjs', ['repos', 'feat', 'project', 'web']);
    assert.equal(r0.status, 0, r0.out);
    assert.deepEqual(fx.json('topics/feat/.tema.json').repos, { main: 'project', list: ['project', 'web'] });
    const copyP = path.join(fx.root, '.worktrees', 'project', 'feat');
    const copyW = path.join(fx.root, '.worktrees', 'web', 'feat');
    assert.ok(fs.existsSync(path.join(copyW, '.git')), r0.out);
    commitIn(copyP, 'feature.txt', 'feature\n', 'feat p');
    commitIn(copyW, 'README.md', 'topic version\n', 'feat w');
    // web main moves on with another version of the same file: the merge conflicts there
    const other = path.join(fx.root, 'web-other');
    gitq(fx.root, 'clone', '-q', fx.webOrigin, other);
    gitq(other, 'config', 'user.name', 't'); gitq(other, 'config', 'user.email', 't@t');
    commitIn(other, 'README.md', 'main version\n', 'main moves');
    gitq(other, 'push', '-q', 'origin', 'main');
    let r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /project: topic\/feat merged into main/);
    assert.match(r.stderr, /dokončiť zlúčenie web/);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'main').includes('feature.txt'), 'project merged');
    assert.match(fx.read('topics/feat/handover.md'), /## Ďalší krok\n- dokončiť zlúčenie web: .*README\.md/);
    assert.ok(fs.existsSync(copyP) && fs.existsSync(copyW), 'the copies stay while the topic is open');
    // The manager settles the conflict in the worktree of web, then done again.
    gitq(copyW, 'fetch', '-q', 'origin');
    spawnSync('git', ['merge', '-q', '-X', 'ours', '--no-edit', 'origin/main'], { cwd: copyW });
    r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /project: nothing to merge into main/);
    assert.match(r.out, /web: topic\/feat merged into main/);
    assert.equal(fx.showOrigin(fx.webOrigin, 'main:README.md'), 'topic version\n');
    assert.ok(!fx.exists('topics/feat'));
    assert.ok(!fs.existsSync(copyP) && !fs.existsSync(copyW), 'worktrees removed');
    assert.ok(fx.onOrigin(fx.projectOrigin, 'topic/feat').length, 'the topic branch stays on origin');
  } finally { fx.cleanup(); }
});

test('protected target branch: outputs go to topic/<t>--obsah, done asks for the merge in Úlohy pre operátora (exact command without gh) and the topic stays open; after the merge done closes it', () => {
  const fx = domain3({ defaultRepo: 'project', web: false });
  try {
    fs.writeFileSync(path.join(fx.project, '.workflow.json'), JSON.stringify({ brain: '../brain', target_protected: true }) + '\n');
    gitq(fx.project, 'commit', '-qam', 'protected'); gitq(fx.project, 'push', '-q', 'origin', 'main');
    fx.thread({ dialog_answered_at: new Date(Date.now() + 1000).toISOString() });
    assert.equal(fx.run('topic.mjs', ['create', 'p1', '--subject', 'Plán', '--class', 'ops']).status, 0);
    result(fx, 'p1', 'plan.md', '# Plán\n');
    let r = fx.run('done.mjs', [...DONE, '--triage', listFile(fx, 'novy:plany plan.md\n')]);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fx.onOrigin(fx.projectOrigin, 'main').includes('vystupy/plany/plan.md'), 'main untouched');
    assert.ok(fx.onOrigin(fx.projectOrigin, 'topic/p1--obsah').includes('vystupy/plany/plan.md'), r.out);
    const h = fx.read('topics/p1/handover.md');
    assert.match(h, /## Úlohy pre operátora\n- zlúčiť topic\/p1--obsah do main v repe project: žiadosť cez gh nevznikla \(gh not available\), príkaz: cd .*gh pr create --head topic\/p1--obsah --base main/);
    assert.match(r.out, /stays open \(state otázka\)/);
    assert.ok(!fx.exists('topics/p1/plan.md'), 'the sorted file left the topic');
    // The operator merges; done --topic again closes the topic.
    const op = path.join(fx.root, 'operator');
    gitq(fx.root, 'clone', '-q', fx.projectOrigin, op);
    gitq(op, 'config', 'user.name', 'o'); gitq(op, 'config', 'user.email', 'o@o');
    gitq(op, 'merge', '-q', '--no-edit', 'origin/topic/p1--obsah'); gitq(op, 'push', '-q', 'origin', 'main');
    r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fx.exists('topics/p1'));
  } finally { fx.cleanup(); }
});

test('done --cancel: only on the operator\'s instruction; no merge, the topic and its worktree end, the branch stays on origin', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 'c1', '--subject', 'Zrušená', '--class', 'code']).status, 0);
    const copy = path.join(fx.root, '.worktrees', 'project', 'c1');
    commitIn(copy, 'wip.txt', 'wip\n', 'wip');
    fx.thread({ turn_source: 'wake', turn_supervisor: true });
    let r = fx.run('done.mjs', ['--topic', '--cancel']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /only on the operator's instruction/);
    assert.ok(fx.exists('topics/c1/.tema.json'));
    fx.thread();
    r = fx.run('done.mjs', ['--topic', '--cancel']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fx.exists('topics/c1'));
    assert.ok(!fs.existsSync(copy), 'worktree removed');
    assert.ok(!fx.onOrigin(fx.projectOrigin, 'main').includes('wip.txt'), 'nothing merged');
    assert.ok(fx.onOrigin(fx.projectOrigin, 'topic/c1').includes('wip.txt'), 'the branch stays on origin');
  } finally { fx.cleanup(); }
});

test('a topic in mode discussion is closed only on the operator\'s instruction, not on the supervisor\'s', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 'd1', '--subject', 'Diskusia', '--class', 'discussion']).status, 0);
    assert.equal(fx.json('topics/d1/.tema.json').mode, 'discussion');
    fx.thread({ turn_source: 'wake', turn_supervisor: true });
    let r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /mode discussion\) refused: only on the operator's instruction/);
    fx.thread();
    r = fx.run('done.mjs', DONE);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fx.exists('topics/d1'));
  } finally { fx.cleanup(); }
});

test('done (unit) of a code topic merges topic/<t> into the target branch through the own clone and keeps the copy and the topic', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 'u1', '--subject', 'Unit', '--class', 'code']).status, 0);
    const copy = path.join(fx.root, '.worktrees', 'project', 'u1');
    commitIn(copy, 'unit.txt', 'unit\n', 'unit');
    const r = fx.run('done.mjs', ['--verified', 'unit.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /project: topic\/u1 merged into main/);
    assert.ok(fx.onOrigin(fx.projectOrigin, 'main').includes('unit.txt'));
    assert.ok(fs.existsSync(path.join(fx.project, 'unit.txt')), 'the checkout is fast-forwarded');
    assert.ok(fs.existsSync(copy), 'the copy stays');
    assert.ok(fx.exists('topics/u1/.tema.json'), 'the topic stays');
  } finally { fx.cleanup(); }
});
