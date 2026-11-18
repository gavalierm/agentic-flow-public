// ttl: 2027-05-18
// Mail model 3 (agentic-comms docs/MODEL.md "Identita témy"): a topic is brain + machine + project + topic. The client
// gets the brain and machine of the session (COMMS_BRAIN, COMMS_BRAIN_NAME, COMMS_MACHINE), registerTopic registers under
// the project the topic records (D-0035), a brain-qualified address reaches the client as its --to, and a 409 ambiguous
// names the exact addresses to send again (nothing sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

test('model 3: register sends brain, machine and topic.project; send --to <brain>@<machine>:<p>/<t> reaches the client as --to', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const st = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  const get = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st({ sends: [], registers: [] });
  const env = { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, WORKFLOW_MACHINE_ID: 'Box-1' };
  try {
    const id = JSON.parse(fx.read('policy.json')).brain_id;
    assert.match(id, /^[0-9a-f]{12}$/, 'brain-init writes a random brain_id');
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion'], { env }).status, 0);
    const rec = path.join(fx.brain, 'topics', 'alpha', 'topic.json');
    fs.writeFileSync(rec, JSON.stringify({ ...JSON.parse(fs.readFileSync(rec, 'utf8')), project: 'shop' }));
    st({ sends: [], registers: [] });
    const r = fx.run('comms.mjs', ['register', 'alpha'], { env });
    assert.equal(r.status, 0, r.out);
    const reg = get().registers.at(-1);
    assert.deepEqual(reg.argv.slice(reg.argv.indexOf('--project'), reg.argv.indexOf('--project') + 4), ['--project', 'shop', '--topic', 'alpha']);
    assert.deepEqual(reg.who, { brain: id, brain_name: 'brain', machine: 'box-1' });
    assert.match(r.out, /registered shop\/alpha/);

    const s = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'b0b0b0b0b0b0@box2:shop/beta', '--text', 'x'], { env });
    assert.equal(s.status, 0, s.out);
    const sent = get().sends.at(-1);
    assert.equal(sent.argv[sent.argv.indexOf('--to') + 1], 'b0b0b0b0b0b0@box2:shop/beta');
    assert.ok(!sent.argv.includes('--project') && !sent.argv.includes('--topic'), sent.argv.join(' '));
    assert.equal(sent.who.brain, id);

    st({ sends: [], send_ambiguous: ['x (b1b1b1b1b1b1)@m1', 'y (b2b2b2b2b2b2)@m2'] });
    const a = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'shop/beta', '--text', 'x'], { env });
    assert.equal(a.status, 1, a.out);
    assert.match(a.out, /nothing sent; send again with one of: --to b1b1b1b1b1b1@m1:shop\/beta, --to b2b2b2b2b2b2@m2:shop\/beta/);
  } finally { fx.cleanup(); }
});
