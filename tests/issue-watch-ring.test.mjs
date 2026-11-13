// 3c review A: a ring counts only when the message waits in a registered mailbox (send state pending). A held answer (the
// topic is not registered: the copy waits as an operator notice) falls back to the persona main thread like a closed
// topic (410); a queued answer (mail unavailable, the client's outbox) advances nothing, the next round rings again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/issue-watch-fx.mjs';

test('a held ring falls back to the persona main thread; the held copy stays as an operator notice', async () => {
  const fx = await fixture();
  try {
    fx.patchRec({ persona_main: '@p1/main' });
    fx.setState({ send_held_to: ['project/work-a'] });
    const id = fx.gh.comment(7);
    const r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    const sends = fx.sends();
    assert.equal(sends.length, 2, 'the held send, then the persona main thread');
    assert.deepEqual(sends[0].argv.slice(5, 9), ['--project', 'project', '--topic', 'work-a']);
    assert.deepEqual(sends[1].argv.slice(5, 7), ['--persona', 'p1']);
    assert.equal(fx.rec().last_ring.to, '--persona p1');
    assert.equal(fx.rec().last_comment_id, id);
    assert.match(fx.watchLog(), /--project project --topic work-a: held as message m-held-1 \(notice n-held\); the held copy stays as an operator notice/);
    assert.match(fx.watchLog(), /rang --persona p1/);
  } finally { await fx.cleanup(); }
});

test('a held ring without persona is not a ring: the answer waits for the agent (undelivered)', async () => {
  const fx = await fixture();
  try {
    fx.setState({ send_held_to: ['project/work-a'] });
    const id = fx.gh.comment(7);
    const r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /undelivered: /);
    assert.equal(fx.sends().length, 1);
    assert.equal(fx.rec().last_ring, undefined, 'no ring recorded');
    assert.deepEqual(fx.rec().undelivered.comments, [id]);
    assert.match(fx.watchLog(), /not rung \(--project project --topic work-a not registered \(held\), no persona main thread\)/);
  } finally { await fx.cleanup(); }
});

test('a queued ring (mail unavailable) advances nothing; the next round rings again', async () => {
  const fx = await fixture();
  try {
    const before = fx.rec();
    fx.setState({ send_queued: true });
    const id = fx.gh.comment(7);
    fx.gh.issues[7].state = 'closed';
    let r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.sends().length, 1, 'tried once');
    const rec = fx.rec();
    assert.equal(rec.last_comment_id, 0, 'comment not taken as rung');
    assert.equal(rec.state, 'open', 'state not taken as rung');
    assert.equal(rec.last_checked_at, before.last_checked_at, 'check time not advanced');
    assert.equal(rec.last_ring, undefined);
    assert.match(fx.watchLog(), /mail unavailable, queued; next round rings again/);
    fx.setState({ send_queued: false, sends: [] });
    r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.sends().length, 1, 'rung again');
    assert.match(fx.sends()[0].text, new RegExp(`id ${id}\\), stav closed`));
    assert.equal(fx.rec().last_comment_id, id);
    assert.equal(fx.rec().state, 'closed');
  } finally { await fx.cleanup(); }
});
