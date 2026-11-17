// keep: guarded
// Spec 7.4 and 7.5 (operator 2026-11-16): the workflow maintainer is one T3 thread outside the workflow; the mail server
// names it (instance.json maintainer.thread) and error.mjs report mails it once (comms send --maintainer). Without a
// maintainer thread on the server, or when the thread is gone (no reply / undelivered -> report --from), the report goes
// to an issue in the public workflow repo; only when that fails too, a draft in the held topic and an operator task.
// Comms client and gh are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

function stubbed(state, { ghFails = false } = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const ghLog = path.join(fx.root, 'gh-log.txt');
  const gh = path.join(fx.root, 'gh-stub.mjs');
  // Stub gh (skill stub-prikaz): logs its argv and prints an issue URL, or fails.
  fs.writeFileSync(gh, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ') + '\\n');\n${ghFails ? "process.stderr.write('HTTP 401\\n'); process.exit(1);" : "process.stdout.write('https://github.com/example/flow/issues/999\\n');"}\n`, { mode: 0o755 });
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

test('a report is mailed once straight to the maintainer thread, no issue', () => {
  const fx = stubbed({ send_id: 'm-rep', maintainer_thread: 'thread-m1' });
  try {
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /reported: mail m-rep -> thread thread-m1 \(the maintainer thread\); sent once/);
    const sends = fx.sends();
    assert.equal(sends.length, 1);
    assert.ok(sends[0].argv.includes('--maintainer'), JSON.stringify(sends[0].argv));
    assert.ok(!sends[0].argv.includes('--project') && !sends[0].argv.includes('--topic'), 'no project/topic address');
    assert.match(sends[0].argv[sends[0].argv.indexOf('--supersede-key') + 1], /^report-[0-9a-f]{8}$/);
    assert.match(sends[0].text, /chyba: x/);
    assert.deepEqual(fx.ghCalls(), [], 'no GitHub issue');
  } finally { fx.cleanup(); }
});

test('no pickup (the thread is gone): report --from files the issue, never mails again, and only once', () => {
  const fx = stubbed({ send_id: 'm-rep' });
  try {
    assert.equal(fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']).status, 0);
    const r = fx.report(['--from', 'm-rep']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /reported: issue https:\/\/github\.com\/example\/flow\/issues\/999 \(mail m-rep -> thread thread-maint not picked up/);
    assert.equal(fx.sends().length, 1, 'no resend by mail');
    const gh = fx.ghCalls();
    assert.equal(gh.length, 1);
    assert.match(gh[0], /issue create -R \S+\/agentic-flow-public --title skript zlyhal/);
    const again = fx.report(['--from', 'm-rep']);
    assert.match(again.out, /already reported: https:\/\/github\.com\/example\/flow\/issues\/999/);
    assert.equal(fx.ghCalls().length, 1, 'one issue');
  } finally { fx.cleanup(); }
});

test('no maintainer thread on the mail server: the report goes to a public issue', () => {
  const fx = stubbed({ no_maintainer: true });
  try {
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /reported: issue https:\/\/github\.com\/example\/flow\/issues\/999 \(no maintainer thread on this mail server/);
    assert.equal(fx.ghCalls().length, 1);
  } finally { fx.cleanup(); }
});

test('no maintainer thread and no issue: a draft in the held topic and an operator task', () => {
  const fx = stubbed({ no_maintainer: true }, { ghFails: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'work', '--subject', 'Work', '--class', 'discussion', '--here']).status, 0);
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT reported: no maintainer thread on this mail server .*gh issue create in \S+\/agentic-flow-public failed/);
    const draft = /koncept (\S+?\.md)/.exec(r.out)?.[1];
    assert.ok(draft, r.out);
    assert.match(draft, /topics\/work\/error-report-[^/]+\.md$/, r.out);
    assert.ok(fs.existsSync(draft), 'draft written');
    assert.match(fs.readFileSync(draft, 'utf8'), /chyba: x/);
    assert.equal(fx.git(fx.brain, 'ls-files', '--', path.relative(fx.brain, draft)), path.relative(fx.brain, draft).split(path.sep).join('/'), 'the draft is in git');
    assert.match(r.out, /task for the operator \(Úlohy pre operátora\): hlásenie chyby workflow sa nedalo odoslať ani založiť ako issue \(skript zlyhal\)/);
    assert.match(r.out, /save\.mjs handover work --tasks/);
  } finally { fx.cleanup(); }
});

test('mail unavailable (queued): not delivered to the thread, the report goes to an issue', () => {
  const fx = stubbed({ send_queued: true });
  try {
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /reported: issue \S+ \(mail unavailable \(queued in the outbox\)/);
    assert.equal(fx.ghCalls().length, 1);
  } finally { fx.cleanup(); }
});
