// ttl: 2026-12-15
// Flow v2 plan O6: topic create compares the scope of the new topic with the open topics of the same brain and repo or
// project (a cheap judge after a word-stem prefilter) and lists an overlap as `overlap: <id> held by <thread> (<how>)`;
// nothing is refused (the overlap of topics is the supervisor's judgement, spec 3.9.4). An unavailable judge says
// `overlap: not checked (<cause>)`. topic thread no longer checks a scope; the handoff options --not and --distinct are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

function judge(fx, name, body, status = 0) {
  const f = path.join(fx.root, `${name}.sh`);
  fs.writeFileSync(f, `cat > ${JSON.stringify(path.join(fx.root, `${name}.prompt`))}\necho '${body}'\nexit ${status}\n`);
  return { WORKFLOW_OVERLAP_JUDGE: '', WORKFLOW_OVERLAP_JUDGE_CMD: `sh ${f}` };
}
const OVERLAP = '{"overlaps":[{"id":"domain-migrate","how":"tie isté domény Beta"}]}';

test('create with an overlapping scope lists the overlap with its holder and creates the topic; a failing judge says not checked', () => {
  const fx = setup();
  try {
    const yes = judge(fx, 'yes', OVERLAP);
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    let r = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta na nový server', '--requested-by', 'operator', '--for-thread', 't2'], { env: yes });
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['create', 'dm2', '--subject', 'Domény Beta', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server', '--requested-by', 'operator', '--for-thread', 't3'], { env: yes });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^overlap: domain-migrate held by t2 \(tie isté domény Beta\)$/m);
    assert.match(r.stdout, /topic dm2 created/);
    assert.ok(fx.exists('topics/dm2'), 'created despite the overlap');
    assert.match(fs.readFileSync(path.join(fx.root, 'yes.prompt'), 'utf8'), /domain-migrate/);
    // no handoff record and no section of handed-off topics in the creating thread's topic
    assert.ok(!fx.exists('topics/orch/handoffs.json'));
    assert.doesNotMatch(fx.read('topics/orch/handover.md'), /Odovzdané/);
    // the judge fails: nothing refused, the line says so
    r = fx.run('topic.mjs', ['create', 'dm3', '--subject', 'Domény Beta tri', '--class', 'discussion', '--task', 'migrácia domén Beta na nový server', '--requested-by', 'operator', '--for-thread', 't4'], { env: judge(fx, 'broken', 'x', 1) });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /overlap: not checked \(/);
    // topic thread with an overlapping task: no check, no line
    assert.equal(fx.run('topic.mjs', ['create', 'dm5', '--subject', 'Faktúry', '--class', 'discussion', '--task', 'tlač faktúr', '--no-claim'], { env: judge(fx, 'no', '{"overlaps":[]}') }).status, 0);
    r = fx.run('topic.mjs', ['thread', 'dm5', '--requested-by', 'operator', '--task', 'migrácia domén Beta na nový server', '--for-thread', 't5'], { env: yes });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /overlap/);
  } finally { fx.cleanup(); }
});

test('no shared words: the judge is not asked', () => {
  const fx = setup();
  try {
    const yes = judge(fx, 'yes', OVERLAP);
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta na nový server', '--requested-by', 'operator', '--for-thread', 't2'], { env: yes }).status, 0);
    fs.rmSync(path.join(fx.root, 'yes.prompt'), { force: true });
    const r = fx.run('topic.mjs', ['create', 'other', '--subject', 'Tlač', '--class', 'discussion', '--task', 'tlačiareň v kancelárii', '--requested-by', 'operator', '--for-thread', 't3'], { env: yes });
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(fx.root, 'yes.prompt')), 'judge not called without shared word stems');
  } finally { fx.cleanup(); }
});
