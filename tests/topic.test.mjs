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

test('topic create claims in one write: one commit and one push-cycle, holder is already in the create commit', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'one', '--subject', 'One', '--class', 'discussion']).status, 0);
    const log = fx.git(fx.brain, 'log', '--format=%s');
    assert.match(log, /topic create one/);
    assert.doesNotMatch(log, /topic claim one/);
    assert.equal(JSON.parse(fx.git(fx.origin, 'show', 'main:topics/one/holder.json')).thread, 'a1');
    assert.equal(fx.git(fx.brain, 'rev-list', '--count', 'origin/main..HEAD'), '0', 'pushed');
  } finally { fx.cleanup(); }
});

test('takeover needs --force and --operator-approved; idle time never takes over', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'T1', '--class', 'discussion']).status, 0);
    let r = fx.runB('topic.mjs', ['claim', 't1']);
    assert.equal(r.status, 1); assert.match(r.out, /held by thread a1/);
    // Pilot 2026-11-02: the refusal must not read as permission; a claim instruction is not a takeover instruction.
    assert.match(r.out, /not an instruction to take it over/); assert.match(r.out, /ask \(blocker/);
    r = fx.runB('topic.mjs', ['claim', 't1', '--force']);
    assert.equal(r.status, 1); assert.match(r.out, /operator-approved/);
    r = fx.runB('topic.mjs', ['claim', 't1', '--force', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.git(fx.origin, 'show', 'main:topics/t1/holder.json')).thread, 'b2');
    // original holder notices on next write
    r = fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--next', 'y']);
    assert.equal(r.status, 1); assert.match(r.out, /held by thread b2/);
  } finally { fx.cleanup(); }
});

test('a topic this thread created is its own to clean up: takeover and release --force without approval (P-018)', () => {
  const fx = setup({ second: true });
  try {
    // alice 2026-11-03: test topic tt-free went to a new thread; cleaning it up waited for the operator.
    assert.equal(fx.run('topic.mjs', ['create', 'own', '--subject', 'Own test', '--class', 'discussion']).status, 0);
    assert.equal(JSON.parse(fx.git(fx.origin, 'show', 'main:topics/own/topic.json')).created_by, 'a1');
    let r = fx.runB('topic.mjs', ['claim', 'own', '--force', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['claim', 'own', '--force']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.git(fx.origin, 'show', 'main:topics/own/holder.json')).thread, 'a1');
    r = fx.runB('topic.mjs', ['claim', 'own', '--force']);
    assert.equal(r.status, 1); assert.match(r.out, /operator-approved/);
    r = fx.runB('topic.mjs', ['release', 'own', '--force']);
    assert.equal(r.status, 1); assert.match(r.out, /operator-approved/);
  } finally { fx.cleanup(); }
});

test('claim without a stable thread id and claim in a wake turn are refused; subject and id are validated', () => {
  const fx = setup();
  try {
    const env = { ...fx.env }; delete env.WORKFLOW_THREAD_ID;
    let r = fx.run('topic.mjs', ['create', 'noid', '--subject', 'x', '--class', 'discussion'], { env: { WORKFLOW_THREAD_ID: '' } });
    assert.equal(r.status, 1); assert.match(r.out, /stable thread id/);
    r = fx.run('topic.mjs', ['create', 'Bad_ID', '--subject', 'x', '--class', 'discussion']);
    assert.equal(r.status, 1); assert.match(r.out, /lowercase/);
    r = fx.run('topic.mjs', ['create', 'nosubj']);
    assert.equal(r.status, 1); assert.match(r.out, /subject/);
    assert.equal(fx.run('topic.mjs', ['create', 'w1', '--subject', 'W', '--no-claim', '--class', 'discussion']).status, 0);
    fs.mkdirSync(path.join(fx.brain, 'local', 'threads'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ thread: 'a1', turn_source: 'wake' }));
    r = fx.run('topic.mjs', ['claim', 'w1']);
    assert.equal(r.status, 1); assert.match(r.out, /P-047/);
  } finally { fx.cleanup(); }
});

test('code topic gets a separate clone next to the project on branch topic/<id>; list shows one line per topic', () => {
  const fx = setup();
  try {
    const r = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']);
    assert.equal(r.status, 0, r.out);
    const copy = path.join(fx.root, 'project-topics', 'feat');
    assert.ok(fs.existsSync(path.join(copy, '.git')));
    assert.ok(fs.statSync(path.join(copy, '.git')).isDirectory(), 'separate clone, not a worktree');
    assert.equal(fx.git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'topic/feat');
    const list = fx.run('topic.mjs', ['list']);
    assert.equal(list.stdout.trim().split('\n').length, 1);
    assert.match(list.stdout, /^feat \(working, a1\)/);
  } finally { fx.cleanup(); }
});

test('holder changes its own mode with claim --mode; same mode is a no-op', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'm1', '--subject', 'Mode', '--class', 'discussion']).status, 0);
    assert.equal(JSON.parse(fx.read('topics/m1/holder.json')).mode, 'operator');
    const r = fx.run('topic.mjs', ['claim', 'm1', '--mode', 'auto']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /topic m1 mode auto/);
    assert.equal(JSON.parse(fx.read('topics/m1/holder.json')).mode, 'auto');
    assert.match(fx.run('topic.mjs', ['claim', 'm1', '--mode', 'auto']).stdout, /already held/);
  } finally { fx.cleanup(); }
});

test('several threads on one brain clone create and claim topics at once: every write lands, no git lock error', async () => {
  const fx = setup();
  try {
    const ids = ['t1', 't2', 't3', 't4'];
    const res = await Promise.all(ids.map((id, i) => fx.runAsync('topic.mjs', ['create', id, '--subject', id, '--mode', 'auto', '--class', 'discussion'], { env: { WORKFLOW_THREAD_ID: `th${i}` } })));
    res.forEach((r, i) => assert.equal(r.status, 0, `${ids[i]}: ${r.stderr}`));
    for (const [i, id] of ids.entries()) {
      const h = JSON.parse(fx.read(`topics/${id}/holder.json`));
      assert.equal(h.thread, `th${i}`);
      assert.equal(h.mode, 'auto');
    }
    assert.equal(fx.git(fx.brain, 'status', '--porcelain', '--', 'topics'), '', 'nothing left uncommitted');
    const log = fx.git(fx.brain, 'log', '--format=%s');
    for (const id of ids) assert.match(log, new RegExp(`topic create ${id}`));
    assert.ok(!fs.existsSync(path.join(fx.brain, '.git', 'workflow-write.lock')));
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

test('claim is refused while the clone has commits it cannot push; the commits stay', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'off', '--subject', 'Off', '--no-claim', '--class', 'discussion']).status, 0);
    fx.git(fx.brain, 'remote', 'set-url', 'origin', path.join(fx.root, 'missing.git'));
    assert.equal(fx.run('save.mjs', ['memory', 'tool', 'offline', '--content', 'x']).status, 0);
    const head = fx.git(fx.brain, 'rev-parse', 'HEAD');
    const r = fx.run('topic.mjs', ['claim', 'off']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /unpushed commit\(s\) that could not be pushed .*not claimed/);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), head);
    assert.equal(JSON.parse(fx.read('topics/off/holder.json')).thread, undefined);
  } finally { fx.cleanup(); }
});

test('one thread id on two machines is two holders: the other machine is refused and offered a takeover only when idle', () => {
  const fx = setup({ second: true });
  try {
    const A = { WORKFLOW_MACHINE_ID: 'pc-a' };
    const sameIdOnB = { ...fx.envB, WORKFLOW_THREAD_ID: 'a1', WORKFLOW_MACHINE_ID: 'pc-b' };
    assert.equal(fx.run('topic.mjs', ['create', 'mx', '--subject', 'Machines', '--class', 'discussion'], { env: A }).status, 0);
    let r = fx.runB('topic.mjs', ['claim', 'mx'], { env: sameIdOnB });
    assert.equal(r.status, 1, r.out); assert.match(r.out, /held by thread a1 on pc-a/); assert.match(r.out, /not an instruction to take it over/);
    r = fx.runB('save.mjs', ['handover', 'mx', '--task', 'x', '--next', 'y'], { env: sameIdOnB });
    assert.equal(r.status, 1, r.out); assert.match(r.out, /on machine pc-a, not on this machine \(pc-b\)/);
    r = fx.runB('topic.mjs', ['status'], { env: sameIdOnB });
    assert.match(r.out, /holds no topic/);
    // Idle over the policy limit on another machine: the refusal offers the takeover after one operator yes.
    fs.writeFileSync(path.join(fx.brainB, 'policy.json'), JSON.stringify({ topics: { stale_machine_hours: 0 } }));
    fs.appendFileSync(path.join(fx.brainB, '.git', 'info', 'exclude'), 'policy.json\n');
    r = fx.runB('topic.mjs', ['claim', 'mx'], { env: { ...fx.envB, WORKFLOW_MACHINE_ID: 'pc-b' } });
    assert.equal(r.status, 1, r.out); assert.match(r.out, /no activity for 0h on another machine/); assert.match(r.out, /claim mx --force --operator-approved/);
    r = fx.runB('topic.mjs', ['claim', 'mx', '--force', '--operator-approved'], { env: { ...fx.envB, WORKFLOW_MACHINE_ID: 'pc-b' } });
    assert.equal(r.status, 0, r.out); assert.match(r.out, /took over from a1 on pc-a/);
  } finally { fx.cleanup(); }
});

test('handoff to another machine: handover, release and push; the other machine claims without --force', () => {
  const fx = setup({ second: true });
  try {
    const A = { WORKFLOW_MACHINE_ID: 'pc-a' };
    const B = { ...fx.envB, WORKFLOW_MACHINE_ID: 'pc-b' };
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Handoff', '--class', 'discussion'], { env: A }).status, 0);
    let r = fx.runB('topic.mjs', ['handoff', 'ho'], { env: B });
    assert.equal(r.status, 1); assert.match(r.out, /only its holder on this machine hands it off/);
    r = fx.run('topic.mjs', ['handoff', 'ho'], { env: A });
    assert.equal(r.status, 1); assert.match(r.out, /has no handover: give --task, --done and --next/);
    // A message waiting in this machine's outbox (mail down) would stay behind: refused unless --leave-outbox.
    fs.writeFileSync(path.join(fx.brain, 'local', 'outbox', 'm1.json'), '{}\n');
    r = fx.run('topic.mjs', ['handoff', 'ho', '--task', 'T', '--done', 'd1', '--next', 'continue on pc-b'], { env: A });
    assert.equal(r.status, 1); assert.match(r.out, /1 message\(s\) in this machine's mail outbox could not be sent/);
    fs.writeFileSync(path.join(fx.brain, 'local', 'log-buffer', 's9.jsonl'), `${JSON.stringify({ kind: 'fail', agent: 'main', cmd: 'x', error: 'boom', at: new Date().toISOString() })}\n`);
    r = fx.run('topic.mjs', ['handoff', 'ho', '--task', 'T', '--done', 'd1', '--next', 'continue on pc-b', '--leave-outbox'], { env: A });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /logs of session s9 flushed/); assert.match(r.out, /1 message\(s\) left in this machine's outbox/);
    assert.match(r.out, /handed off, pushed: on the other machine run topic.mjs claim ho/);
    const holder = JSON.parse(fx.git(fx.origin, 'show', 'main:topics/ho/holder.json'));
    assert.equal(holder.thread, undefined); assert.equal(holder.handoff_from.machine, 'pc-a');
    assert.match(fx.git(fx.origin, 'show', 'main:topics/ho/handover.md'), /continue on pc-b/);
    assert.ok(fx.git(fx.origin, 'ls-tree', '-r', '--name-only', 'main', 'logs/pc-a').includes('.log'));
    r = fx.runB('topic.mjs', ['claim', 'ho'], { env: B });
    assert.equal(r.status, 0, r.out);
    const now = JSON.parse(fx.git(fx.origin, 'show', 'main:topics/ho/holder.json'));
    assert.equal(now.thread, 'b2'); assert.equal(now.machine, 'pc-b');
    r = fx.runB('save.mjs', ['handover', 'ho', '--task', 'T', '--next', 'n'], { env: B });
    assert.equal(r.status, 0, r.out);
  } finally { fx.cleanup(); }
});

test('topic create in a brain git refuses (dubious ownership): nothing half written, the error and the start give the safe.directory command (agentic-flow-public#23)', () => {
  const fx = setup();
  try {
    const env = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
    let r = fx.run('topic.mjs', ['create', 'dub', '--subject', 'Dubious', '--no-claim', '--class', 'discussion'], { env });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /dubious ownership.*git config --global --add safe\.directory \S*brain/);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'topics', 'dub')), 'a failed create leaves no topic folder');
    const s = fx.hook('session-start.mjs', { source: 'startup' }, { env });
    assert.match(s.context, /git refuses .*safe\.directory/);
    r = fx.run('topic.mjs', ['create', 'dub', '--subject', 'Dubious', '--no-claim', '--class', 'discussion']);
    assert.equal(r.status, 0, r.out);
  } finally { fx.cleanup(); }
});
