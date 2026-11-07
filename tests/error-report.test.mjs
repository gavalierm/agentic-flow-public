// P-003 step 5: error.mjs report decides whether the maintainer got the report (mail delivered, else issue, else draft).
// Operator 2026-11-07: an instance without the maintainer topic said "reported" while the mail stayed held on its server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { scrub, repoSlug, maintainerOf, MAINTAINER } from '../scripts/report.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
// Fake token built at run time: a literal one in a source file is (rightly) refused as a secret.
const FAKE_TOKEN = ['gh', 'p_', 'a'.repeat(30)].join('');

function fixture(state = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const ghLog = path.join(fx.root, 'gh-body.txt');
  const fakeGh = path.join(fx.root, 'gh');
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ')+'\\n'+fs.readFileSync(0,'utf8'));console.log('https://github.com/o/r/issues/42');\n`);
  fs.chmodSync(fakeGh, 0o755);
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, WORKFLOW_GITHUB_TOKEN_FILE: path.join(fx.root, 'no-token'), WORKFLOW_GH_CLI: fakeGh });
  fx.ghBody = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8') : null);
  fx.reports = () => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'error-reports.json'), 'utf8'));
  return fx;
}

test('delivered mail is reported and recorded; a no-reply bell for it routes to the issue fallback', () => {
  const fx = fixture({ send_id: 'm-20261107-1' });
  try {
    let r = fx.run('error.mjs', ['report', '--title', 'grep -h', '--text', 'chyba: x; príčina: y; uložené: z']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^reported: mail m-20261107-1/);
    assert.equal(fx.reports()['m-20261107-1'].text, 'chyba: x; príčina: y; uložené: z');
    assert.equal(fx.ghBody(), null, 'no issue when the mail was delivered');
    const h = fx.hook('user-prompt-submit.mjs', { prompt: 'no reply m-20261107-1' });
    assert.match(h.context, /error report to the workflow maintainer; run node .*error\.mjs report --from m-20261107-1/);
    r = fx.run('error.mjs', ['report', '--from', 'm-20261107-1']);
    assert.match(r.stdout, /^reported: issue https:\/\/github\.com\/o\/r\/issues\/42 \(mail m-20261107-1 not picked up/);
    assert.ok(fx.ghBody().startsWith(`issue create -R ${repoSlug(MAINTAINER.repo)} --title grep -h`), fx.ghBody());
    r = fx.run('error.mjs', ['report', '--from', 'm-20261107-1']);
    assert.match(r.stdout, /already reported: https:\/\/github\.com\/o\/r\/issues\/42/);
  } finally { fx.cleanup(); }
});

test('held mail (maintainer topic not on this server) becomes an issue with scrubbed text', () => {
  const fx = fixture({ send_held: true });
  try {
    const r = fx.run('error.mjs', ['report', '--text', `chyba: ${fx.project}/src/a.js zlyhal pre a@example.test; príčina: ${fx.brain}/x`]);
    assert.match(r.stdout, /^reported: issue .*maintainer topic maintainer\/workflow-dev not on this mail server \(message held, notice n-1\)/);
    const body = fx.ghBody();
    assert.ok(!body.includes(fx.project) && !body.includes(fx.brain) && !body.includes('a@example.test'), body);
    assert.match(body, /<project>\/src\/a\.js/);
    assert.match(body, /<brain>\/x/);
  } finally { fx.cleanup(); }
});

test('no mail and no GitHub: NOT reported, draft for the operator', () => {
  const fx = fixture({ down: true });
  try {
    const r = fx.run('error.mjs', ['report', '--text', 'chyba: x'], { env: { WORKFLOW_GH_CLI: path.join(fx.root, 'missing-gh') } });
    assert.match(r.stdout, /^NOT reported: mail .*; no GitHub access .* give them .*scratch\/error-report-.*\.md/);
    const file = /give them (\S+\.md)/.exec(r.stdout)[1];
    assert.match(fs.readFileSync(file, 'utf8'), /chyba: x/);
  } finally { fx.cleanup(); }
});

test('scrub, repo slug and maintainer override', () => {
  const ctx = { projectDir: '/srv/u/work/shopapp', brainDir: '/srv/u/work/shopapp-brain' };
  const text = `in /srv/u/work/shopapp/a and shopapp-brain, C:\\Users\\jan\\x, ${FAKE_TOKEN} 10.0.0.1`;
  assert.equal(scrub(text, ctx, { HOME: '/srv/u' }), 'in <project>/a and <project>, ~\\x, <secret> <ip>');
  assert.equal(repoSlug('https://github.com/o/r.git'), 'o/r');
  assert.deepEqual(maintainerOf({ maintainer: { comms: 'me/dev' } }), { comms: 'me/dev', repo: MAINTAINER.repo });
});
