// keep: core
// P-013, P-007, P-031, P-009, P-008, P-032, P-035: save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { domain2 } from './layout-2-helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('memory: fixed format with key/origin; same subject overwrites; similar key refused unless --new', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['memory', 'tool', 'editor', '--content', 'name: Anna', '--aliases', 'ed']);
    assert.equal(r.status, 0, r.out);
    let rec = parseFrontmatter(fx.read('memory/tool-editor.md'));
    assert.equal(rec.data.key, 'tool-editor'); assert.equal(rec.data.origin, 'operator'); assert.deepEqual(rec.data.aliases, ['ed']);
    assert.equal(rec.body.trim(), 'name: Anna');
    r = fx.run('save.mjs', ['memory', 'tool', 'editor', '--content', 'name: Beta']);
    assert.equal(r.status, 0, r.out);
    rec = parseFrontmatter(fx.read('memory/tool-editor.md'));
    assert.equal(rec.body.trim(), 'name: Beta');
    assert.deepEqual(rec.data.aliases, ['ed'], 'aliases kept');
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1, 'one record per subject');
    // alias hit -> overwrite the same file
    assert.equal(fx.run('save.mjs', ['memory', 'tool', 'ed', '--content', 'name: Gamma']).status, 0);
    // spec 4.3, 11.4: a person or the operator goes to osoby/ of the operator repo; save refuses and names the command.
    for (const [type, name] of [['person', 'Alice'], ['operator', 'operator']]) {
      r = fx.run('save.mjs', ['memory', type, name, '--content', 'likes tea']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, new RegExp(`${type} records are not written to memory any more: .*osoby/ of the operator repo.*people\\.mjs (find|new)`));
      assert.ok(!fx.exists(`memory/${type}-${name.toLowerCase()}.md`));
    }
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1);
    // similar key
    assert.equal(fx.run('save.mjs', ['memory', 'service', 'x service', '--content', 'tokens', '--aliases', 'xs']).status, 0);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging']);
    assert.equal(r.status, 1); assert.match(r.stderr, /similar key exists.*service-x-service/);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging', '--new']);
    assert.equal(r.status, 0, r.out);
    // derived needs sources; diacritics normalized in key
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived']);
    assert.equal(r.status, 1); assert.match(r.stderr, /sources/);
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived', '--sources', 'README.md']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('memory/service-posta.md'));
    assert.match(fx.read('memory/service-posta.md'), /fingerprint: [0-9a-f]{12}/);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] save memory service-posta/);
  } finally { fx.cleanup(); }
});

test('decision gets a sequential ID, needs relates_to, supersedes marks the old one', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X']);
    assert.equal(r.status, 1); assert.match(r.stderr, /relates-to/);
    r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X', '--relates-to', 'src/app.js']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /decision D-0001/);
    r = fx.run('save.mjs', ['decision', 'Library C', '--what', 'C', '--reason', 'faster', '--relates-to', 'src/app.js', '--supersedes', 'D-0001']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /D-0002/);
    const old = parseFrontmatter(fx.read('decisions/d-0001-library-a.md'));
    assert.equal(old.data.status, 'superseded-by D-0002');
    assert.match(fx.run('find.mjs', ['--relates-to', 'src/app.js']).stdout, /d-0002-library-c/);
  } finally { fx.cleanup(); }
});

// Pilot of v0.9.73 (2026-11-12): `save.mjs handover <topic> --help` wrote an empty handover over the topic's one.
test('handover: an unknown option or no content is refused and the current handover stays', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'hh', '--subject', 'H', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'hh', '--task', 'Task', '--next', 'step two']).status, 0);
    const before = fx.read('topics/hh/handover.md');
    let r = fx.run('save.mjs', ['handover', 'hh', '--help']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /unknown option --help; nothing written/);
    r = fx.run('save.mjs', ['handover', 'hh', '--task', 'Task', '--nxt', 'typo']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /unknown option --nxt/);
    r = fx.run('save.mjs', ['handover', 'hh']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /no content/);
    assert.equal(fx.read('topics/hh/handover.md'), before);
  } finally { fx.cleanup(); }
});

const HAS_WORDS = fs.existsSync('/usr/share/dict/words');
test('save from inside another workflow project refuses: the session project would get the write (alice 2026-11-04)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    let r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cwd is in project .* with its own brain.*--project/s);
    r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y', '--project', fx.project], { cwd: fx.projectB, env });
    assert.equal(r.status, 0, r.stderr);
    r = fx.run('topic.mjs', ['list'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1, 'topic refuses too');
  } finally { fx.cleanup(); }
});

test('brain.mjs write/remove from another brain or project refuses; --project writes there (alice 2026-11-07)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    const src = path.join(fx.root, 'note.md');
    fs.writeFileSync(src, 'x\n');
    const headA = () => spawnSync('git', ['-C', fx.brain, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const before = headA();
    for (const cwd of [fx.brainB, fx.projectB]) {
      const r = fx.run('brain.mjs', ['write', 'docs/note.md', '--file', src, '--message', 'm'], { cwd, env });
      assert.equal(r.status, 1, `write from ${cwd} must refuse: ${r.stdout}`);
      assert.match(r.stderr, /cwd is in (brain|project) .*--project/s);
    }
    let r = fx.run('brain.mjs', ['remove', 'docs/note.md', '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 1, 'remove refuses too');
    assert.equal(headA(), before, 'nothing landed in the session brain');
    r = fx.run('brain.mjs', ['write', 'docs/note.md', '--project', fx.projectB, '--file', src, '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, r.stderr + r.stdout + (r.out || ''));
    assert.ok(fs.existsSync(path.join(fx.brainB, 'docs', 'note.md')), 'written into brain-b');
    assert.equal(headA(), before);
    r = fx.run('brain.mjs', ['status'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, 'read-only commands are not refused');
  } finally { fx.cleanup(); }
});

// Flow v2 (plan B2, spec 9 P-011, 10.6): six sections, Úlohy pre operátora from --tasks; Ďalší krok has items; a handover
// without the sixth section is refused (not read as empty); a step is refused in mode discussion; no check of words in
// the step (O4: a step naming a time or a reminder is saved).
test('handover: six sections with --tasks, steps as items, no sixth section refused, --next refused in mode discussion', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'six', '--subject', 'Six', '--class', 'ops']).status, 0);
    let r = fx.run('save.mjs', ['handover', 'six', '--task', 'T', '--done', 'a', '--next', 'krok jedna; zajtra o 10:00 pripomenúť deploy', '--questions', 'Ktorá verzia?', '--tasks', 'Schváľ zverejnenie; Pridaj token']);
    assert.equal(r.status, 0, r.out);
    const text = fx.read('topics/six/handover.md');
    assert.match(text, /## Ďalší krok\n- krok jedna\n- zajtra o 10:00 pripomenúť deploy\n/);
    assert.match(text, /## Otvorené otázky\n- Ktorá verzia\?\n## Úlohy pre operátora\n- Schváľ zverejnenie\n- Pridaj token\n/);
    // --file without the sixth section: refused, the handover stays.
    const old = path.join(fx.root, 'old.md');
    fs.writeFileSync(old, '## Zadanie\nT\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n');
    r = fx.run('save.mjs', ['handover', 'six', '--file', old]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /handover missing section "## Úlohy pre operátora"/);
    assert.equal(fx.read('topics/six/handover.md'), text);
    // Mode discussion: a step is refused (also over --file), a handover without one is saved.
    assert.equal(fx.run('topic.mjs', ['create', 'talk', '--subject', 'Talk', '--class', 'discussion']).status, 0);
    r = fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--next', 'pokračovať v diskusii']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /topic talk is in mode discussion \(spec 10\.6\)/);
    assert.match(r.stderr, /topic\.mjs mode talk off/);
    const withStep = path.join(fx.root, 'step.md');
    fs.writeFileSync(withStep, '## Zadanie\nT\n## Hotové\n-\n## Ďalší krok\n1. spusti testy\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n');
    r = fx.run('save.mjs', ['handover', 'talk', '--file', withStep]);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /mode discussion/);
    r = fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--done', 'stav diskusie', '--tasks', 'Súhlas s nasadením']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('topics/talk/handover.md'), /## Ďalší krok\n-\n[\s\S]*## Úlohy pre operátora\n- Súhlas s nasadením\n/);
  } finally { fx.cleanup(); }
});

// Spec 4.1 last row, plan B8: --repo writes through the own clone of the workflow (pull, write, push on the knowledge
// branch), not in the checkout of the repo; the clean checkout on that branch is fast-forwarded afterwards.
test('memory --repo: written in the own clone and pushed to the origin of the repo; the checkout follows', () => {
  const fx = domain2();
  try {
    const origin = path.join(fx.root, 'srv.git');
    fx.git(fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
    fx.git(fx.srv, 'remote', 'add', 'origin', origin);
    fx.git(fx.srv, 'push', '-q', '-u', 'origin', 'main');
    const r = fx.run('save.mjs', ['memory', 'tool', 'alpha', '--content', 'Build tool of srv.', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^written: srv\/\.brain\/memory\/tool-alpha\.md \(srv \w+\) \[main, pushed from the own clone of the workflow\]$/m);
    assert.match(fx.git(origin, 'show', 'main:.brain/memory/tool-alpha.md'), /Build tool of srv\./);
    assert.match(fx.git(origin, 'log', '-1', '--format=%s', 'main'), /^\[brain-script\] save memory tool-alpha$/);
    assert.ok(fs.existsSync(path.join(fx.root, '.worktrees', 'srv', '.clone', '.git')));
    assert.ok(fs.existsSync(path.join(fx.srv, '.brain', 'memory', 'tool-alpha.md')), 'checkout fast-forwarded');
    assert.equal(fx.git(fx.srv, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});

// Spec 4.3, 6 (plan B8): save person writes osoby/ of the operator repo through its own clone; memory person stays refused.
test('person: a new person with --name, a change of the one match, no match without --name refused', () => {
  const fx = setup();
  try {
    const op = path.join(fx.root, 'operator');
    const origin = path.join(fx.root, 'operator.git');
    fx.git(fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
    fx.git(fx.root, 'init', '-q', '-b', 'main', op);
    fs.writeFileSync(path.join(op, 'README.md'), 'operator\n');
    fx.git(op, 'add', '-A'); fx.git(op, 'commit', '-q', '-m', 'init');
    fx.git(op, 'remote', 'add', 'origin', origin); fx.git(op, 'push', '-q', '-u', 'origin', 'main');
    const config = path.join(fx.root, 'install.json');
    fs.writeFileSync(config, JSON.stringify({ operator_repo: op }));
    const env = { WORKFLOW_INSTALL_CONFIG: config };
    let r = fx.run('save.mjs', ['person', 'jana', '--content', 'Účtovníčka.'], { env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /no person "jana": ask the operator who it is/);
    r = fx.run('save.mjs', ['person', 'jana', '--name', 'Jana Nová', '--aliases', 'janka', '--content', 'Účtovníčka.'], { env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^pushed$/m); assert.match(r.stdout, /person osoby\/jana\.md/);
    r = fx.run('save.mjs', ['person', 'janka', '--content', 'Účtovníčka, posiela faktúry v piatok.'], { env });
    assert.equal(r.status, 0, r.out);
    assert.match(fx.git(origin, 'show', 'main:osoby/jana.md'), /posiela faktúry v piatok/);
    assert.match(fx.git(origin, 'show', 'main:INDEX.md'), /^- janka → osoby\/jana\.md$/m);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'memory', 'person-jana.md')), 'nothing in memory');
  } finally { fx.cleanup(); }
});
