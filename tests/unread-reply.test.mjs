// ttl: 2026-12-18
// Report 2026-11-18: a final reply to the thread's own message came during the turn, the tool line did not name it and the
// turn ended "hotovo" without reading it. The tool line names a reply; the end of a turn is refused while one waits unread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchLine } from '../hooks/post-tool-use.mjs';
import { violationOf, UNREAD_REPLY_REASON } from '../hooks/stop.mjs';

test('the tool line names a reply to the own message once, an assist stays silent', () => {
  const items = [{ id: 'r1', level: 'assist', reply_to: 'm1', reply_state: 'hotovo' }, { id: 'a1', level: 'assist' }];
  const res = watchLine(items, []);
  assert.match(res.line, /mail waiting: r1 reply; .*reply to your message: read it and use it before you end the turn/);
  assert.doesNotMatch(res.line, /a1/);
  assert.equal(watchLine(items, res.seen), null);
});

test('the end of a turn is refused while a reply waits unread, before the skeleton checks', () => {
  assert.equal(violationOf({ msg: 'x', reply: {}, work: [], facts: [], alarms: {}, factsState: 'hotovo', turnSource: 'operator', dialog: false, unreadReplies: ['r1'] }), UNREAD_REPLY_REASON(['r1']));
});
