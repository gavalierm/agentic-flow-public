// keep: core
// D-0022 (report 2026-11-17): a turn the operator started (a discussion) showed `mail: 0` while a steer and two assists
// waited; two carried the operator's own remarks. The status line now passes the steer and names the held assists once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { discussionMail, formatMail, heldMailLine } from '../scripts/comms.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

test('discussion mail passes a steer and names the held assists', () => {
  const mail = { count: 3, blockers: 0, steers: 1, items: [{ id: 'm1', level: 'assist' }, { id: 'm2', level: 'assist' }, { id: 'm3', level: 'steer' }] };
  const d = discussionMail(mail);
  assert.equal(d.count, 1);
  assert.deepEqual(d.items.map((it) => it.id), ['m3']);
  assert.equal(d.held_back, 2);
  assert.match(formatMail(d), /^mail: 1 \(1 steer\) \(\+2 held for the discussion\)/);
  assert.match(heldMailLine(d), /^mail held for the discussion with the operator: 2 \(m1 assist, m2 assist\); do not read them now; say in your reply/);
});

test('an operator turn names the held mail once, the steer in the waiting line', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  fs.writeFileSync(stateFile, JSON.stringify({}));
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'poďme to prebrať' });
    fs.writeFileSync(stateFile, JSON.stringify({ messages: [{ id: 'm-as1', level: 'assist', topic: 'alpha' }, { id: 'm-st1', level: 'steer', topic: 'alpha' }] }));
    const ctx = fx.hook('user-prompt-submit.mjs', { prompt: 'a ešte toto' }).context;
    assert.match(ctx, /mail: 1 \(1 steer\) \(\+1 held for the discussion\)/, ctx);
    assert.match(ctx, /mail: 1 waiting: m-st1 steer/, ctx);
    assert.match(ctx, /mail held for the discussion with the operator: 1 \(m-as1 assist\)/, ctx);
    const again = fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }).context || '';
    assert.doesNotMatch(again, /mail held for the discussion/, 'once per change');
  } finally { fx.cleanup(); }
});
