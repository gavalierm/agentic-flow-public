// ttl: 2026-12-15
// report-3c65fd98: a topic created from a project whose brain is another repo (a domain brain shared by several projects)
// records the mail project it is registered under (mail model 3: a send to a topic of another brain is the mail's to
// resolve, no guess from the folders of this machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup2 } from './layout-2-helpers.mjs';

const STUB = path.resolve(import.meta.dirname, 'fixtures', 'comms-stub.mjs');

function stubEnv(root) {
  const state = path.join(root, 'stub-state.json');
  fs.writeFileSync(state, JSON.stringify({ messages: [], sends: [] }));
  return { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: state, STUB_COMMS_LOG: path.join(root, 'stub.log') };
}

test('topic create from a project of a domain with a shared domain brain records the session mail project', () => {
  const fx = setup2({ thread: 'm1', brainLayout: 2, projectLayout: 2 });
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  try {
    const env = stubEnv(fx.root);
    const r = fx.run('topic.mjs', ['create', 'audit', '--class', 'discussion', '--subject', 'audit of a skill', '--here'], { env });
    assert.equal(r.status, 0, r.out);
    const rec = fx.json('temy/audit/.tema.json');
    assert.equal(rec.project, 'project', JSON.stringify(rec));
  } finally { fx.cleanup(); }
});

