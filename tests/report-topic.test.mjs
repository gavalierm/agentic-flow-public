// 3b (D-0022, D-0024): a report goes by mail to its own topic `report-<fp>` of the maintainer project; held there with
// `project_known` it waits for the maintainer's intake (no issue, the held copy stays). 3c.1 (D-0023): an issue the
// report created is recorded for the watch (local/reported-issues.json and the machine index).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { reportTopic, repoSlug, scrub, MAINTAINER } from '../scripts/report.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const EMAIL = `a${'@'}example.test`;

function fixture(state = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ sends: [], ...state }));
  const ghLog = path.join(fx.root, 'gh-body.txt');
  const fakeGh = path.join(fx.root, 'gh');
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ')+'\\n'+fs.readFileSync(0,'utf8'));console.log('https://github.com/o/r/issues/42');\n`);
  fs.chmodSync(fakeGh, 0o755);
  Object.assign(fx.env, {
    WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl'),
    WORKFLOW_GITHUB_TOKEN_FILE: path.join(fx.root, 'no-token'), WORKFLOW_GH_CLI: fakeGh, WORKFLOW_ISSUE_WATCH_INDEX: path.join(fx.root, 'index.json'),
  });
  fx.state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fx.calls = () => (fs.existsSync(fx.env.STUB_COMMS_LOG) ? fs.readFileSync(fx.env.STUB_COMMS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  fx.ghBody = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8') : null);
  fx.local = (name) => { const f = path.join(fx.brain, 'local', name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  return fx;
}

test('report topic: report-<8 hex> from the scrubbed lower-case title and the workflow version', () => {
  const a = reportTopic('Grep -H fails', {}, {}, 'v1.0.0');
  assert.match(a, /^report-[0-9a-f]{8}$/);
  assert.equal(reportTopic('  grep -h FAILS ', {}, {}, 'v1.0.0'), a, 'case and outer spaces do not change the topic');
  assert.notEqual(reportTopic('Grep -H fails', {}, {}, 'v1.0.1'), a, 'a release with the fix starts a new topic');
  assert.notEqual(reportTopic('other error', {}, {}, 'v1.0.0'), a);
  // Client data never decides the topic: the same report from two projects lands in one topic.
  const one = reportTopic('/work/alpha/src/a.js fails', { projectDir: '/work/alpha' }, {}, 'v1');
  const two = reportTopic('/work/beta/src/a.js fails', { projectDir: '/work/beta' }, {}, 'v1');
  assert.equal(one, two);
  // The mail path scrubs, the issue path scrubs again: placeholders stay as they are (project named "project").
  const c = { projectDir: '/work/project', brainDir: '/work/brain' };
  const once = scrub(`/work/project/a.js and project and ${EMAIL}`, c, {});
  assert.equal(once, '<project>/a.js and <project> and <email>');
  assert.equal(scrub(once, c, {}), once);
});

test('the mail goes to <maintainer project>/report-<fp> with a title line and scrubbed text', () => {
  const fx = fixture({ send_id: 'm-1' });
  try {
    const r = fx.run('error.mjs', ['report', '--title', `${fx.project}/x fails`, '--text', `chyba: ${fx.project}/src/a.js zlyhal pre ${EMAIL}; príčina: ${fx.brain}/y`]);
    assert.equal(r.status, 0, r.out);
    const send = fx.state().sends[0];
    const topic = send.argv[send.argv.indexOf('--topic') + 1];
    assert.match(topic, /^report-[0-9a-f]{8}$/);
    assert.equal(send.argv[send.argv.indexOf('--project') + 1], MAINTAINER.comms.split('/')[0]);
    assert.match(send.text, /^title: <project>\/x fails\n\nchyba: <project>\/src\/a\.js/);
    for (const secret of [fx.project, fx.brain, EMAIL]) {
      assert.ok(!send.text.includes(secret), `mail text leaks ${secret}`);
      assert.ok(!JSON.stringify(fx.local('error-reports.json')).includes(secret), `record leaks ${secret}`);
    }
    assert.match(r.stdout, new RegExp(`^reported: mail m-1 -> ${MAINTAINER.comms.split('/')[0]}/${topic};`));
  } finally { fx.cleanup(); }
});

test('held with project_known: reported, the held copy stays, nothing remembered as unreachable, no issue', () => {
  const fx = fixture({ send_held: true, project_known: true });
  try {
    const r = fx.run('error.mjs', ['report', '--title', 'grep -h', '--text', 'chyba: x']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`^reported: mail m-held -> ${MAINTAINER.comms.split('/')[0]}/report-[0-9a-f]{8} \\(téma sa zakladá; bez prevzatia do 2026-11-01T12:30:00\\.000Z zvonček povie no reply, potom error\\.mjs report --from m-held\\)`));
    assert.ok(!fx.calls().some((c) => c[0] === 'decide'), 'the held copy is not discarded');
    assert.equal(fx.local('maintainer-unreachable.json'), null, 'the maintainer is reachable');
    assert.equal(fx.ghBody(), null, 'no issue');
    assert.equal(fx.local('error-reports.json')['m-held'].pending_topic, true, 'recorded for a later --from');
    // The next report mails again (nothing remembered).
    const again = fx.run('error.mjs', ['report', '--title', 'grep -h', '--text', 'chyba: x']);
    assert.match(again.stdout, /^reported: mail m-held/);
  } finally { fx.cleanup(); }
});

test('held without project_known (an older mail server): issue, held copy discarded, recorded for the watch', () => {
  const fx = fixture({ send_held: true });
  try {
    const r = fx.run('error.mjs', ['report', '--title', 'grep -h', '--text', 'chyba: x']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^reported: issue https:\/\/github\.com\/o\/r\/issues\/42 .*held mail copy discarded \(notice n-1\); tell the operator the link \(P-003\); watched: /);
    assert.ok(fx.local('maintainer-unreachable.json'), 'remembered as unreachable, as before');
    const key = `${repoSlug(MAINTAINER.repo)}#42`;
    const rec = fx.local('reported-issues.json')[key];
    assert.equal(rec.url, 'https://github.com/o/r/issues/42');
    assert.equal(rec.number, 42);
    assert.equal(rec.status, 'waiting');
    assert.equal(rec.last_comment_id, 0);
    assert.deepEqual(rec.own_comment_ids, []);
    assert.equal(rec.thread, fx.thread);
    assert.equal(rec.topic, null, 'the thread holds no topic');
    assert.equal(rec.persona_main, null, 'not a persona project');
    const idx = JSON.parse(fs.readFileSync(fx.env.WORKFLOW_ISSUE_WATCH_INDEX, 'utf8'));
    assert.equal(idx.brains[fx.brain].project, fx.project);
  } finally { fx.cleanup(); }
});

test('the record names the reporter topic the thread holds', () => {
  const fx = fixture({ send_held: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'work-a', '--subject', 'S', '--class', 'discussion']).status, 0);
    fx.run('error.mjs', ['report', '--title', 'grep -h', '--text', 'chyba: x']);
    const rec = fx.local('reported-issues.json')[`${repoSlug(MAINTAINER.repo)}#42`];
    assert.equal(rec.topic, 'work-a');
    assert.equal(rec.mail_project, 'project');
  } finally { fx.cleanup(); }
});
