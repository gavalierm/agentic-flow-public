// ttl: 2026-12-15
// error.mjs report --to <topic> (report-3fdc7bf3): a report about the work of a thread reachable by mail goes to that
// thread's topic, not to a new report topic and an issue; only an unreachable topic falls back to the maintainer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

// Fake mail client of mail model 2: records each call, a send to `work-topic` or to the maintainer thread (--maintainer) is
// delivered, any other topic is held.
const FAKE = `
const fs = require('node:fs');
const a = process.argv.slice(2);
const input = a.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ a, input }) + '\\n');
const topic = a.includes('--maintainer') ? 'maintainer' : a[a.indexOf('--topic') + 1];
if (a[0] === 'health') process.stdout.write(JSON.stringify({ ok: true, instance_id: 'fake', model: 2 }));
else if (a[0] === 'send') {
  const ok = topic === 'work-topic' || topic === 'maintainer';
  process.stdout.write(JSON.stringify(ok ? { id: 'm-' + topic, status: 'pending' } : { id: 'm-held', status: 'held', notice_id: 'n1' }));
} else process.stdout.write('{}');
`;

function fixture() {
  const fx = setup();
  const client = path.join(fx.root, 'fake-client.cjs');
  fs.writeFileSync(client, FAKE);
  const log = path.join(fx.root, 'calls.jsonl');
  const env = { WORKFLOW_COMMS_CLIENT: client, FAKE_LOG: log };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { fx, env, calls };
}

test('report --to a reachable topic mails that topic and nothing else', () => {
  const { fx, env, calls } = fixture();
  const r = fx.run('error.mjs', ['report', '--to', 'proj/work-topic', '--title', 'scratch left', '--text', 'chyba: scratch ostal'], { env });
  assert.equal(r.status, 0, r.out);
  const sends = calls().filter((c) => c.a[0] === 'send');
  assert.equal(sends.length, 1, JSON.stringify(sends));
  assert.equal(sends[0].a[sends[0].a.indexOf('--topic') + 1], 'work-topic');
  assert.match(sends[0].input, /chyba: scratch ostal/);
  assert.match(r.out, /reported: mail m-work-topic -> proj\/work-topic/);
  assert.doesNotMatch(r.out, /reported: issue/);
});

test('report --to an unreachable topic falls back to the maintainer and withdraws the held copy', () => {
  const { fx, env, calls } = fixture();
  const r = fx.run('error.mjs', ['report', '--to', 'proj/gone', '--title', 'scratch left', '--text', 'chyba: scratch ostal'], { env });
  assert.equal(r.status, 0, r.out);
  const c = calls();
  const sends = c.filter((x) => x.a[0] === 'send');
  assert.equal(sends[0].a[sends[0].a.indexOf('--topic') + 1], 'gone');
  assert.ok(sends[1]?.a.includes('--maintainer'), JSON.stringify(sends[1]?.a));
  assert.ok(c.some((x) => x.a[0] === 'decide' && x.a.includes('n1')), 'held copy discarded');
  assert.match(r.out, /not reachable by mail.*reported: mail m-maintainer -> thread maintainer \(the maintainer thread\)/);
});
