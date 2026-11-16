// keep: core
// Spec 7.4 and 7.5 (plan B15): an error report is never a public issue. It is mailed once; without pickup (error.mjs
// report --from after no reply / undelivered) it goes into Úlohy pre operátora and is not sent again. Mail that cannot
// be sent leaves a draft in the folder of the held topic (in git) and an operator task with its path; the operator files
// an issue if they see fit. Comms client and gh are stubs: gh must never be called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

function stubbed(state) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const ghLog = path.join(fx.root, 'gh-log.txt');
  const gh = path.join(fx.root, 'gh-stub.mjs');
  // Stub gh (skill stub-prikaz): logs its argv and prints an issue URL; a call is the failure this test guards against.
  fs.writeFileSync(gh, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write('https://github.com/example/flow/issues/999\\n');\n`, { mode: 0o755 });
  Object.assign(fx.env, {
    WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl'),
    WORKFLOW_GH_CLI: gh, WORKFLOW_GITHUB_TOKEN_FILE: path.join(fx.root, 'no-token'),
  });
  fs.writeFileSync(stateFile, JSON.stringify({ sends: [], ...state }));
  fx.sends = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends;
  fx.ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  fx.report = (args) => fx.run('error.mjs', ['report', ...args]);
  return fx;
}

test('no pickup: the report goes into the operator tasks, it is not sent again and never an issue', () => {
  const fx = stubbed({ send_id: 'm-rep' });
  try {
    const r1 = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r1.status, 0, r1.out);
    assert.match(r1.out, /reported: mail m-rep -> maintainer\/report-[0-9a-f]{8}; sent once/);
    assert.equal(fx.sends().length, 1);
    const r2 = fx.report(['--from', 'm-rep']);
    assert.equal(r2.status, 0, r2.out);
    assert.match(r2.out, /sent once and never again/);
    assert.match(r2.out, /task for the operator \(Úlohy pre operátora\): hlásenie chyby workflow nebolo prevzaté: skript zlyhal \(m-rep -> maintainer\/report-[0-9a-f]{8}\)/);
    assert.match(r2.out, /save\.mjs handover .* --tasks "hlásenie chyby workflow nebolo prevzaté/);
    assert.equal(fx.sends().length, 1, 'no resend');
    assert.deepEqual(fx.ghCalls(), [], 'no GitHub issue');
  } finally { fx.cleanup(); }
});

test('maintainer not on this mail server: a draft in the held topic and an operator task, the held copy withdrawn, no issue', () => {
  const fx = stubbed({ send_held: true, notices: [{ id: 'n-1', kind: 'unregistered-topic', state: 'open', project: 'alice', topic: 'report-x', message_id: 'm-held' }] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'work', '--subject', 'Work', '--class', 'discussion', '--here']).status, 0);
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT reported: maintainer topic maintainer\/workflow-dev not on this mail server/);
    assert.match(r.out, /held mail copy discarded \(notice n-1\)/);
    const draft = /koncept (\S+?\.md)/.exec(r.out)?.[1];
    assert.ok(draft, r.out);
    assert.match(draft, /topics\/work\/error-report-[^/]+\.md$/, r.out);
    assert.ok(fs.existsSync(draft), 'draft written');
    assert.match(fs.readFileSync(draft, 'utf8'), /chyba: x/);
    assert.equal(fx.git(fx.brain, 'ls-files', '--', path.relative(fx.brain, draft)), path.relative(fx.brain, draft).split(path.sep).join('/'), 'the draft is in git');
    assert.match(r.out, /task for the operator \(Úlohy pre operátora\): hlásenie chyby workflow sa nedalo odoslať \(skript zlyhal\): koncept .*; issue v \S+\/agentic-flow-public založ, ak uznáš/);
    assert.match(r.out, /save\.mjs handover work --tasks/);
    assert.deepEqual(fx.ghCalls(), [], 'no GitHub issue');
  } finally { fx.cleanup(); }
});

test('mail unavailable (queued): not reported, a draft and an operator task, no issue', () => {
  const fx = stubbed({ send_queued: true });
  try {
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT reported: mail unavailable \(queued in the outbox\)/);
    assert.match(r.out, /task for the operator .*koncept \S+error-report-/);
    assert.doesNotMatch(r.out, /reported: issue/);
    assert.deepEqual(fx.ghCalls(), []);
  } finally { fx.cleanup(); }
});
