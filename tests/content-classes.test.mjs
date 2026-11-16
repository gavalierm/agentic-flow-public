// ttl: 2026-12-14
// Sorting of a topic's content (D-0059): done --topic needs --knowledge in every layout. The triage of layout 2 (classes
// dokument, zdroj, stav, pomocne, the hidden archive, save.mjs promote) is gone (flow v2 plan B12, binding reading: no
// layout 2 branches beyond the migration); the triage by type of layout 3 is tests/done-layout3.core.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { persona2 } from './layout-2-helpers.mjs';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

function personaFx() {
  const p = persona2();
  const at = (rel) => path.join(p.dir, ...rel.split('/'));
  const fx = { ...p, thread: 'p1', brain: p.dir, project: p.dir, read: (rel) => fs.readFileSync(at(rel), 'utf8'), json: (rel) => JSON.parse(fs.readFileSync(at(rel), 'utf8')), exists: (rel) => fs.existsSync(at(rel)) };
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  fx.stub = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  fx.stub({});
  return fx;
}

test('done --topic without --knowledge is refused with the reason, in layout 1 and layout 2', () => {
  const fx1 = setup();
  try {
    assert.equal(fx1.run('topic.mjs', ['create', 'k1', '--subject', 'S', '--class', 'discussion']).status, 0);
    for (const extra of [[], ['--knowledge'], ['--knowledge', ' ']]) {
      const r = fx1.run('done.mjs', ['--topic', '--verified', 'observed', ...extra]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /needs --knowledge .*save/);
    }
    const r = fx1.run('done.mjs', ['--topic', '--verified', 'observed', '--knowledge', 'nic nové']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /knowledge: nic nové/);
  } finally { fx1.cleanup(); }
  const fx = personaFx();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'k2', '--subject', 'S', '--class', 'discussion']).status, 0);
    const r = fx.run('done.mjs', ['--topic', '--verified', 'observed']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /needs --knowledge/);
  } finally { fx.cleanup(); }
});
