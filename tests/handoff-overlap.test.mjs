// ttl: 2026-12-15
// agent-alice/D-0082, point 3: topics worked over each other because their tasks overlapped. topic.mjs create|thread (and
// comms send --handoff) compare the new scope with the open topics of the same brain and repo or project: a cheap judge
// after a word-stem prefilter. An overlap is refused with the topic, its holder and scope and the three ways out; topic.mjs
// auto only prints `overlap:`; an unavailable judge refuses nothing and says `overlap: not checked (<cause>)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const noThreadStart = (fx) => fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: 'false' } }));
import { setup } from './helpers.mjs';

function judge(fx, name, body, status = 0) {
  const f = path.join(fx.root, `${name}.sh`);
  fs.writeFileSync(f, `cat > ${JSON.stringify(path.join(fx.root, `${name}.prompt`))}\necho '${body}'\nexit ${status}\n`);
  return { WORKFLOW_OVERLAP_JUDGE: '', WORKFLOW_OVERLAP_JUDGE_CMD: `sh ${f}` };
}
const OVERLAP = '{"overlaps":[{"id":"domain-migrate","how":"tie isté domény Beta"}]}';

test('create and thread with an overlapping scope are refused with the holder and the ways out; --distinct passes', () => {
  const fx = setup();
  try {
    const yes = judge(fx, 'yes', OVERLAP);
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    let r = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta na nový server', '--for-thread', 't2'], { env: yes });
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['create', 'dm2', '--subject', 'Domény Beta', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server', '--for-thread', 't3'], { env: yes });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /overlaps open topic domain-migrate/);
    assert.match(r.stderr, /held by t2/);
    assert.match(r.stderr, /migrácia domén Alfa a Beta na nový server/);
    assert.match(r.stderr, /comms send --to domain-migrate/);
    assert.match(r.stderr, /--not/);
    assert.match(r.stderr, /--distinct/);
    assert.ok(!fx.exists('topics/dm2'), 'nothing created');
    assert.match(fs.readFileSync(path.join(fx.root, 'yes.prompt'), 'utf8'), /domain-migrate/);
    r = fx.run('topic.mjs', ['create', 'dm2', '--subject', 'Domény Beta', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server', '--distinct', 'iba DNS záznamy, nie presun webu', '--for-thread', 't3'], { env: yes });
    assert.equal(r.status, 0, r.out);
    // the judge fails: nothing refused, the line says so
    const broken = judge(fx, 'broken', 'x', 1);
    r = fx.run('topic.mjs', ['create', 'dm3', '--subject', 'Domény Beta tri', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server', '--for-thread', 't4'], { env: broken });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /overlap: not checked \(/);
    // thread with a task that overlaps
    assert.equal(fx.run('topic.mjs', ['create', 'dm5', '--subject', 'Faktúry', '--class', 'discussion', '--task', 'tlač faktúr', '--no-claim'], { env: judge(fx, 'no', '{"overlaps":[]}') }).status, 0);
    r = fx.run('topic.mjs', ['thread', 'dm5', '--task', 'migrácia domén Beta na nový server', '--for-thread', 't5'], { env: yes });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /overlaps open topic domain-migrate/);
  } finally { fx.cleanup(); }
});

test('no shared words: the judge is not asked; auto prints overlap lines and never refuses for them', () => {
  const fx = setup();
  try {
    const yes = judge(fx, 'yes', OVERLAP);
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta na nový server', '--for-thread', 't2'], { env: yes }).status, 0);
    fs.rmSync(path.join(fx.root, 'yes.prompt'), { force: true });
    const r = fx.run('topic.mjs', ['create', 'other', '--subject', 'Tlač', '--class', 'discussion', '--task', 'tlačiareň v kancelárii', '--for-thread', 't3'], { env: yes });
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(fx.root, 'yes.prompt')), 'judge not called without shared word stems');
    noThreadStart(fx);
    const a = fx.run('topic.mjs', ['auto', 'auto-dm', '--subject', 'Migrácia domén Beta', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server'], { env: yes });
    assert.match(a.out, /^overlap: domain-migrate \(tie isté domény Beta\)$/m);
    assert.doesNotMatch(a.out, /overlaps open topic/);
  } finally { fx.cleanup(); }
});
