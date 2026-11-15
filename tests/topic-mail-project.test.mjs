// ttl: 2026-12-15
// report-3c65fd98: a topic created from a project whose brain is another repo (a domain brain shared by several projects)
// records the mail project it is registered under, and a send to `<that brain repo>/<topic>` names the mail address
// instead of leaving a held "new topic?" notice (the topic was registered as <project>/<topic>).
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

test('send to <brain repo of another domain>/<topic> names the recorded mail address and sends nothing', () => {
  const fx = setup2({ thread: 's1', brainLayout: 2, projectLayout: 2 });
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const other = fs.mkdtempSync(path.join(path.dirname(fx.root), 'wf-otherdom-'));
  try {
    const brain = path.join(other, 'shop-brain');
    fs.mkdirSync(path.join(brain, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.brain', 'policy.json'), '{"data_layout":2}\n');
    fs.mkdirSync(path.join(brain, 'temy', 'audit-x'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'temy', 'audit-x', '.tema.json'), JSON.stringify({ id: 'audit-x', subject: 's', class: 'discussion', kind: 'discussion', state: 'working', project: 'shop-seo' }));
    const env = stubEnv(fx.root);
    const r = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'shop-brain/audit-x', '--text', 'hello'], { env });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /topic audit-x is shop-seo\/audit-x .*send to shop-seo\/audit-x; nothing sent/);
    const sends = JSON.parse(fs.readFileSync(env.STUB_COMMS_STATE, 'utf8')).sends || [];
    assert.equal(sends.length, 0);
  } finally { fx.cleanup(); fs.rmSync(other, { recursive: true, force: true }); }
});
