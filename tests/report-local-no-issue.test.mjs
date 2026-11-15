// keep: core
// D-0067: an error report whose mail this server accepted (the maintainer project is on it) never becomes a public issue;
// on no pickup (error.mjs report --from) it is sent again as blocker to the maintainer topic with a supersede key. A server
// without the maintainer project (another machine) still falls back to an issue. Comms client and gh are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const val = (a, k) => (a.includes(`--${k}`) ? a[a.lastIndexOf(`--${k}`) + 1] : undefined);

function stubbed(state) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const ghLog = path.join(fx.root, 'gh-log.txt');
  const gh = path.join(fx.root, 'gh-stub.mjs');
  // Stub gh (skill stub-prikaz): logs its argv and prints an issue URL; no token file, so issueReport takes the gh path.
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

test('local maintainer: no pickup sends the report again as blocker, never an issue (D-0067)', () => {
  const fx = stubbed({ send_id: 'm-rep' });
  try {
    const r1 = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r1.status, 0, r1.out);
    assert.match(r1.out, /reported: mail m-rep -> maintainer\/report-[0-9a-f]{8}/);
    const r2 = fx.report(['--from', 'm-rep']);
    assert.equal(r2.status, 0, r2.out);
    assert.deepEqual(fx.ghCalls().filter((l) => l.includes('issue')), [], 'no GitHub issue for a local maintainer');
    assert.doesNotMatch(r2.out, /issue https/);
    const resend = fx.sends().map((s) => s.argv).find((a) => val(a, 'level') === 'blocker');
    assert.ok(resend, `blocker resend: ${JSON.stringify(fx.sends())}`);
    assert.equal(`${val(resend, 'project')}/${val(resend, 'topic')}`, 'maintainer/workflow-dev');
    assert.match(val(resend, 'supersede-key') || '', /^error-report:report-[0-9a-f]{8}$/);
    assert.match(r2.out, /sent again as blocker .*maintainer\/workflow-dev.*no issue/);
    // The resend's own no-reply does not loop: it stays in mail.
    const r3 = fx.report(['--from', 'm-rep']);
    assert.match(r3.out, /no issue/);
    assert.deepEqual(fx.ghCalls().filter((l) => l.includes('issue')), []);
  } finally { fx.cleanup(); }
});

test('remote: a --to report not picked up, maintainer not on this server: issue, held copy withdrawn', () => {
  const fx = stubbed({ send_id: 'm-dir' });
  try {
    const r1 = fx.report(['--to', 'alice/some-work', '--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.match(r1.out, /reported: mail m-dir -> alice\/some-work/);
    const sf = fx.env.STUB_COMMS_STATE;
    fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf, 'utf8')), send_held: true, notices: [{ id: 'n-1', kind: 'new_topic', state: 'open', project: 'alice', topic: 'workflow-dev', message_id: 'm-held' }] }));
    const r2 = fx.report(['--from', 'm-dir']);
    assert.equal(r2.status, 0, r2.out);
    assert.match(r2.out, /reported: issue https:\/\/github.com\/example\/flow\/issues\/999/);
    assert.doesNotMatch(r2.out, /sent again as blocker/);
    const n1 = JSON.parse(fs.readFileSync(sf, 'utf8')).notices.find((x) => x.id === 'n-1');
    assert.equal(n1.decision, 'discard', 'held copy withdrawn');
  } finally { fx.cleanup(); }
});

test('remote: a server without the maintainer project still falls back to an issue', () => {
  const fx = stubbed({ send_held: true });
  try {
    const r = fx.report(['--title', 'skript zlyhal', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /reported: issue https:\/\/github.com\/example\/flow\/issues\/999/);
    assert.equal(fx.ghCalls().filter((l) => l.includes('issue create')).length, 1);
  } finally { fx.cleanup(); }
});
