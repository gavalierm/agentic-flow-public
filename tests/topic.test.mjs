// keep: core
// P-036, P-037, P-038, P-047: topics and holder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('two clones claim the same topic at once: exactly one wins, loser sees the holder', async () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'race', '--subject', 'Race', '--no-claim', '--class', 'discussion']).status, 0);
    const [a, b] = await Promise.all([fx.runAsync('topic.mjs', ['claim', 'race']), fx.runAsyncB('topic.mjs', ['claim', 'race'])]);
    const winners = [a, b].filter((r) => r.status === 0);
    assert.equal(winners.length, 1, a.out + b.out);
    const loser = a.status === 0 ? b : a;
    assert.match(loser.out, /held by thread (a1|b2)/);
    const holder = JSON.parse(fx.git(fx.origin, 'show', 'main:topics/race/holder.json'));
    assert.ok(['a1', 'b2'].includes(holder.thread));
    assert.equal(holder.mode, 'operator');
  } finally { fx.cleanup(); }
});

test('takeover needs --force and --operator-approved; idle time never takes over', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'T1', '--class', 'ops']).status, 0);
    let r = fx.runB('topic.mjs', ['claim', 't1']);
    assert.equal(r.status, 1); assert.match(r.out, /held by thread a1/);
    // Pilot 2026-11-02: the refusal must not read as permission; a claim instruction is not a takeover instruction.
    assert.match(r.out, /not an instruction to take it over/); assert.match(r.out, /ask \(blocker/);
    r = fx.runB('topic.mjs', ['claim', 't1', '--force']);
    assert.equal(r.status, 1); assert.match(r.out, /operator-approved/);
    assert.equal(fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--done', 'časť A; časť B', '--next', 'y']).status, 0);
    r = fx.runB('topic.mjs', ['claim', 't1', '--force', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.git(fx.origin, 'show', 'main:topics/t1/holder.json')).thread, 'b2');
    // Spec 4.2.3 (plan B5): the takeover lists "Hotové" beside the pushed branches (a topic without a repo has none).
    assert.match(r.stdout, /^takeover check \(spec 4\.2\.3\): compare "Hotové" of the handover with the files and with the pushed branches below; when they differ, ask the operator/m);
    assert.match(r.stdout, /^Hotové: časť A; časť B$/m);
    assert.match(r.stdout, /^pushed branches: topic t1 has no target repo/m);
    // original holder notices on next write
    r = fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--next', 'y']);
    assert.equal(r.status, 1); assert.match(r.out, /held by thread b2/);
  } finally { fx.cleanup(); }
});

// Several PCs on one brain (alice/main 2026-11-05): a lost claim race ran `git reset --hard origin/<branch>` and threw
// away uncommitted changes and unpushed commits of the losing clone.
test('lost claim race drops only the claim commit: uncommitted changes of the clone survive', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'race', '--subject', 'Race', '--no-claim', '--class', 'discussion']).status, 0);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    // After A's claim commit (before its push), B claims first: A's push then loses the race.
    const marker = path.join(fx.root, 'raced');
    const hook = path.join(fx.brain, '.githooks', 'post-commit');
    fs.writeFileSync(hook, `#!/bin/sh\n[ -e "${marker}" ] && exit 0\ntouch "${marker}"\ncd "${fx.brainB}" && printf '{"thread":"b2","mode":"operator"}\\n' > topics/race/holder.json && git commit -q --no-verify -am "b claims race" && git push -q origin HEAD:main\n`);
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(fx.brain, '.gitattributes'), '# local edit, not committed\n');
    const r = fx.run('topic.mjs', ['claim', 'race']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /held by thread b2 \(claimed first\)/);
    assert.match(fx.read('.gitattributes'), /# local edit, not committed/);
    assert.doesNotMatch(fx.git(fx.brain, 'log', '--format=%s', '-3'), /topic claim race by a1/);
  } finally { fx.cleanup(); }
});

// Flow v2 (plan B1, O1, spec 10.6, 13): the record carries mode, repos and turn; the fields of before stay.
test('topic create: record carries mode (class discussion -> discussion, else off), repos and turn; old fields stay', () => {
  const fx = setup();
  try {
    let r = fx.run('topic.mjs', ['create', 'talk', '--subject', 'Talk', '--class', 'discussion']);
    assert.equal(r.status, 0, r.out);
    let t = JSON.parse(fx.read('topics/talk/topic.json'));
    assert.equal(t.mode, 'discussion');
    assert.deepEqual(t.repos, { main: null, list: [] });
    assert.deepEqual(t.turn, { state: 'hotovo', alarm_at: null });
    for (const [k, v] of Object.entries({ id: 'talk', subject: 'Talk', class: 'discussion', kind: 'discussion', state: 'working', created_by: 'a1' })) assert.equal(t[k], v, k);
    assert.ok(t.created);
    r = fx.run('topic.mjs', ['create', 'app-fix', '--subject', 'Fix', '--class', 'code', '--no-copy', '--here']);
    assert.equal(r.status, 0, r.out);
    t = JSON.parse(fx.read('topics/app-fix/topic.json'));
    assert.equal(t.mode, 'off');
    assert.equal(t.kind, 'code');
    assert.equal(t.state, 'working');
    assert.ok(t.repo, 'repo stays');
    assert.deepEqual(t.repos, { main: t.repo, list: [t.repo] });
    assert.deepEqual(t.turn, { state: 'hotovo', alarm_at: null });
    // The free handover has the six sections (P-011), Úlohy pre operátora included.
    assert.match(fx.read('topics/talk/handover.md'), /## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n$/);
  } finally { fx.cleanup(); }
});
