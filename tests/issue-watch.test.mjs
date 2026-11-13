// 3c (D-0023, D-0024): the reporter watches its own issue. issue-watch.mjs (wake job, all brains of the machine) rings the
// reporter's topic by mail (steer, key issue-<repo>#<n>) on a new maintainer comment or a changed state, with the link,
// the comment ids and the state only (P-047); error.mjs confirm|reopen answer on the issue. Fake GitHub, fake mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, SLUG, KEY, FOREIGN } from './fixtures/issue-watch-fx.mjs';

test('a maintainer comment rings the topic once (steer, key, link and ids only); closing rings once more', async () => {
  const fx = await fixture();
  try {
    let r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.sends().length, 0, 'nothing new yet');
    const id = fx.gh.comment(7);
    r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    const [s] = fx.sends();
    assert.deepEqual(s.argv.slice(0, 9), ['send', '--text', '-', '--level', 'steer', '--project', 'project', '--topic', 'work-a']);
    assert.equal(s.argv[s.argv.indexOf('--supersede-key') + 1], `issue-${KEY}`);
    assert.ok(!s.argv.includes('--thread'), 'sent as the instance, not a thread');
    assert.match(s.text, new RegExp(`https://github\\.com/${SLUG}/issues/7: nový komentár správcu \\(id ${id}\\)`));
    assert.match(s.text, /error\.mjs confirm .* error\.mjs reopen/);
    assert.ok(!s.text.includes(FOREIGN), 'no text from GitHub in the message (P-047)');
    assert.equal(fx.rec().last_comment_id, id);
    r = await fx.watch();
    assert.equal(fx.sends().length, 1, 'the same comment does not ring again');
    fx.gh.issues[7].state = 'closed';
    r = await fx.watch();
    assert.equal(fx.sends().length, 2);
    assert.match(fx.sends()[1].text, /stav closed/);
    r = await fx.watch();
    assert.equal(fx.sends().length, 2, 'closing rings once');
  } finally { await fx.cleanup(); }
});

test('confirm and reopen post own comments that never ring; confirm ends the watch', async () => {
  const fx = await fixture();
  try {
    let r = await fx.runAsync('error.mjs', ['reopen', `https://github.com/${SLUG}/issues/7`, '--text', `stále zlyhá v ${fx.project}`]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^reopened: /);
    assert.equal(fx.gh.issues[7].state, 'open');
    const own = fx.gh.issues[7].comments[0];
    assert.ok(!own.body.includes(fx.project), 'the answer is scrubbed');
    assert.deepEqual(fx.rec().own_comment_ids, [own.id]);
    r = await fx.watch();
    assert.equal(fx.sends().length, 0, 'own comment does not ring');
    r = await fx.runAsync('error.mjs', ['confirm', KEY, '--text', 'overené: funguje']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^confirmed: .*Otvorené hlásenia/);
    assert.equal(fx.rec().status, 'confirmed');
    fx.gh.issues[7].state = 'closed';
    fx.gh.comment(7);
    r = await fx.watch();
    assert.equal(fx.sends().length, 0, 'a confirmed issue rings nobody');
    // Confirmed and closed: dropped after keep_days.
    fx.patchRec({ confirmed_at: '2020-01-01T00:00:00.000Z' });
    r = await fx.watch();
    assert.equal(fx.rec(), undefined);
  } finally { await fx.cleanup(); }
});

test('a failed mail does not advance: the next round rings', async () => {
  const fx = await fixture();
  try {
    fx.setState({ send_fail: true });
    const id = fx.gh.comment(7);
    await fx.watch();
    assert.equal(fx.rec().last_comment_id, 0);
    assert.match(fx.watchLog(), /mail failed/);
    fx.setState({ send_fail: false, sends: [] });
    await fx.watch();
    assert.equal(fx.sends().filter((s) => !s.argv.includes('--reply-to')).length >= 1, true);
    assert.equal(fx.rec().last_comment_id, id);
  } finally { await fx.cleanup(); }
});

test('a closed topic (410) rings the persona main thread; without persona the answer waits in the log and status line', async () => {
  const fx = await fixture();
  try {
    fx.patchRec({ persona_main: '@p1/main' });
    fx.setState({ send_closed_topic: ['project/work-a'] });
    fx.gh.comment(7);
    await fx.watch();
    const sends = fx.sends();
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1].argv.slice(5, 7), ['--persona', 'p1']);
    assert.equal(fx.rec().last_ring.to, '--persona p1');
    // No persona: nothing to ring; logged, named in the status line, shown by error.mjs watch.
    fx.patchRec({ persona_main: null });
    fx.setState({ sends: [] });
    fx.gh.comment(7);
    const r = await fx.watch();
    assert.match(r.stdout, /undelivered: /);
    assert.equal(fx.sends().length, 1, 'only the refused send');
    assert.ok(fx.rec().undelivered, 'kept for the agent');
    assert.match(fx.watchLog(), /not rung \(topic work-a closed \(410\), no persona main thread\)/);
    const h = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(h.context, /issues: 1 answer\(s\) not rung \(error\.mjs watch\)/);
    const w = await fx.runAsync('error.mjs', ['watch']);
    assert.match(w.stdout, new RegExp(`undelivered: https://github\\.com/${SLUG}/issues/7: comments \\d+`));
    assert.equal(fx.rec().undelivered, null, 'shown once');
  } finally { await fx.cleanup(); }
});

test('rate limit (403, remaining 0) pauses the rounds; no token ends the round with a log line', async () => {
  const fx = await fixture();
  try {
    fx.gh.limited = true;
    let r = await fx.watch();
    assert.match(r.stdout, /rate limit until 2100-01-01/);
    fx.gh.limited = false;
    const calls = fx.gh.calls.length;
    r = await fx.watch();
    assert.match(r.stdout, /paused until 2100-01-01/);
    assert.equal(fx.gh.calls.length, calls, 'no request during the pause');
    r = await fx.watch(['--force']);
    assert.ok(fx.gh.calls.length > calls, '--force checks anyway');
    fs.rmSync(fx.env.WORKFLOW_GITHUB_TOKEN_FILE);
    r = await fx.watch(['--force']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /no GitHub token .*nothing checked/);
    assert.match(fx.watchLog(), /no GitHub token/);
  } finally { await fx.cleanup(); }
});
