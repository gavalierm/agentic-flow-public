// 3c review B: the issue list and the comments are read page by page (Link rel="next", at most MAX_PAGES); a failed page
// is no list: no record of that repo (or that issue) advances, the next round asks again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, SLUG } from './fixtures/issue-watch-fx.mjs';

test('the issue on page 2 and the maintainer comment on page 2 ring', async () => {
  const fx = await fixture();
  try {
    fx.gh.issue(3); // page 1 of the list holds #3, page 2 holds #7
    fx.gh.pageSize = 1;
    const first = fx.gh.comment(7, 'someone');
    const second = fx.gh.comment(7);
    const r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.gh.calls.includes(`GET /repos/${SLUG}/issues page 2`), fx.gh.calls.join('\n'));
    assert.ok(fx.gh.calls.includes(`GET /repos/${SLUG}/issues/7/comments page 2`), fx.gh.calls.join('\n'));
    const [s] = fx.sends();
    assert.ok(s, `rung: ${fx.watchLog()}`);
    assert.match(s.text, new RegExp(`nový komentár správcu \\(id ${first}, ${second}\\)`));
    assert.equal(fx.rec().last_comment_id, second);
  } finally { await fx.cleanup(); }
});

test('a failed page of the issue list advances nothing; a failed page of the comments neither', async () => {
  const fx = await fixture();
  try {
    fx.gh.issue(3);
    fx.gh.pageSize = 1;
    const before = fx.rec();
    fx.gh.failPage = { what: 'issues', page: 2 };
    const id = fx.gh.comment(7);
    fx.gh.comment(7);
    let r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.rec().last_checked_at, before.last_checked_at, 'not checked: the list was not complete');
    assert.equal(fx.sends().length, 0);
    assert.match(fx.watchLog(), /GitHub issues failed \(HTTP 500 on page 2\); nothing advanced/);
    fx.gh.failPage = { what: 'comments', page: 2 };
    r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.rec().last_checked_at, before.last_checked_at);
    assert.equal(fx.rec().last_comment_id, 0);
    assert.equal(fx.sends().length, 0);
    assert.match(fx.watchLog(), /GitHub comments failed \(HTTP 500 on page 2\); nothing advanced/);
    fx.gh.failPage = null;
    r = await fx.watch();
    assert.equal(fx.sends().length, 1);
    assert.equal(fx.rec().last_comment_id, id + 1);
  } finally { await fx.cleanup(); }
});
