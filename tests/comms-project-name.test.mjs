// 3b/3c review C: a project with its own mail project name (`comms.project` in the workflow configuration) is addressed
// by it everywhere: the client settings, the report intake (its notices) and the issue records (the ring's address).
// One shared function (comms.mjs commsProjectName), not a copy of the expression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commsProjectName, commsSettings, mailProjectName } from '../scripts/comms.mjs';
import { fixture as intakeFixture, fakeT3 } from './fixtures/intake-fx.mjs';
import { fixture as watchFixture } from './fixtures/issue-watch-fx.mjs';

test('commsProjectName: comms.project, else the mail name; the client settings use it', () => {
  const ctx = { projectName: 'agent-p1', persona: 'p1', projectDir: '/nonexistent-project', brainDir: null, config: {} };
  assert.equal(commsProjectName(ctx), mailProjectName(ctx));
  assert.equal(commsProjectName(ctx), 'p1');
  const own = { ...ctx, config: { comms: { project: 'mailname' } } };
  assert.equal(commsProjectName(own), 'mailname');
  assert.equal(commsSettings(own).project, 'mailname');
});

test('intake: the notices of the configured mail project are taken, not those of the folder name', () => {
  const fx = intakeFixture({ config: { comms: { project: 'elsewhere' } } });
  try {
    const t3 = fakeT3(fx);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /report-89abcdef: message m-3 delivered to thread mcp:launch:rt1 \(created\)/);
    assert.ok(!fx.exists('topics/report-0123abcd/topic.json'), 'the folder name\'s notice is not ours');
    assert.deepEqual(fx.calls().filter((c) => c[0] === 'decide').map((c) => c[2]), ['n-3']);
    assert.match(t3.calls()[0].input, /témy elsewhere\/report-89abcdef/);
  } finally { fx.cleanup(); }
});

test('issue record: the ring goes to the configured mail project', async () => {
  const fx = await watchFixture({ config: { comms: { project: 'mailname' } } });
  try {
    assert.equal(fx.rec().mail_project, 'mailname');
    fx.gh.comment(7);
    const r = await fx.watch();
    assert.equal(r.status, 0, r.out);
    const [s] = fx.sends();
    assert.ok(s, fx.watchLog());
    assert.deepEqual(s.argv.slice(5, 9), ['--project', 'mailname', '--topic', 'work-a']);
  } finally { await fx.cleanup(); }
});
