// 3b review D: the intake does not take a report that expires within 5 minutes (the topic, the thread and the deliver
// may not make it); a report that expired between the topic and the deliver (decide 409 with expired_at) leaves its new
// topic's thread a steer from the instance (key report-expired-<topic>, no text of the report) to close the topic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeT3, TOPIC } from './fixtures/intake-fx.mjs';

test('a report with less than 5 minutes left is skipped (once in the log): no topic, no thread, no deliver', () => {
  const fx = fixture({ expires: new Date(Date.now() + 2 * 60000).toISOString() });
  try {
    const t3 = fakeT3(fx);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /report-0123abcd: message m-1 skipped \(held, expires in under 5 min \(.*\)\); the notice stays with the operator/);
    assert.ok(!fx.exists(`topics/${TOPIC}/topic.json`), 'no topic');
    assert.equal(t3.calls().length, 0, 'no thread');
    assert.ok(!fx.calls().some((c) => c[0] === 'decide'), 'no deliver');
    fx.intake();
    assert.equal((fx.log().match(/skipped/g) || []).length, 1, 'logged once');
  } finally { fx.cleanup(); }
});

test('deliver refused as expired (409) after the topic was made: a steer to the topic, no report text; retried until sent', () => {
  const fx = fixture({ expires: new Date(Date.now() + 10 * 60000).toISOString() });
  try {
    fakeT3(fx);
    fx.setState({ decide_expired: true, sends: [], send_fail: true });
    let r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists(`topics/${TOPIC}/topic.json`), 'the topic was made');
    assert.match(r.stdout, /report-0123abcd: message m-1 expired before delivery \(.*\); steer to the topic failed \(stub send failed\); next run tries again/);
    // The message is expired now: the next run skips it and only sends the steer that did not go out.
    const st = fx.state();
    st.message['m-1'].expires_at = '2020-01-01T00:00:00.000Z';
    fx.setState({ message: st.message, send_fail: false, sends: [] });
    r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /report-0123abcd: message m-1 expired before delivery; steer to the topic sent \(pending\)/);
    const [s] = fx.state().sends;
    assert.ok(s, r.out);
    assert.deepEqual(s.argv.slice(0, 9), ['send', '--text', '-', '--level', 'steer', '--project', 'project', '--topic', TOPIC]);
    assert.equal(s.argv[s.argv.indexOf('--supersede-key') + 1], `report-expired-${TOPIC}`);
    assert.ok(!s.argv.includes('--thread'), 'sent as the instance');
    assert.match(s.text, /Hlásenie m-1 vypršalo pred doručením/);
    assert.match(s.text, /podá ako issue \(vybaví ho sledovanie issues\)/);
    assert.match(s.text, new RegExp(`done\\.mjs --topic --topic-id ${TOPIC}`));
    assert.ok(!s.text.includes('tajný obsah'), 'no text of the report');
    r = fx.intake();
    assert.equal(fx.state().sends.length, 1, 'sent once');
  } finally { fx.cleanup(); }
});

test('deliver refused as expired at once: the steer goes out in the same run', () => {
  const fx = fixture({ expires: new Date(Date.now() + 10 * 60000).toISOString() });
  try {
    fakeT3(fx);
    fx.setState({ decide_expired: true, sends: [] });
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /report-0123abcd: message m-1 expired before delivery \(2026-11-01T12:30:00\.000Z\); steer to the topic sent \(pending\), its thread closes the topic/);
    assert.match(fx.log(), /expired before delivery/);
    const sends = fx.state().sends;
    assert.equal(sends.length, 1);
    assert.equal(sends[0].argv[sends[0].argv.indexOf('--supersede-key') + 1], `report-expired-${TOPIC}`);
  } finally { fx.cleanup(); }
});
