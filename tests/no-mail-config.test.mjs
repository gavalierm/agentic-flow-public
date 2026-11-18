// ttl: 2026-12-18
// flow-public#103, operator 2026-11-18: a brain without <brain>/local/comms.json sent every mail call to instance default
// without a key, nothing said so, and a report that fell back to an issue was taken quietly. Session start names a brain
// without mail; a machine config serves every brain without its own; a failed mail to the maintainer stays said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { noMailConfigLine, commsSettings, markMaintainerMail, maintainerMailLine } from '../scripts/comms.mjs';
import { issueMailKey } from '../scripts/project.mjs';
import { dataPath } from '../scripts/layout.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomail-'));
process.env.WORKFLOW_MACHINE_COMMS = path.join(root, 'machine', 'comms.json');
process.env.WORKFLOW_MAINTAINER_MAIL = path.join(root, 'machine', 'maintainer-mail.json');

test('a brain without local/comms.json gets the line; the brain config or the machine config serves it; comms off none', () => {
  const brain = path.join(root, 'brain'); const project = path.join(root, 'proj');
  fs.mkdirSync(brain); fs.mkdirSync(project);
  const client = path.join(root, 'comms.mjs'); fs.writeFileSync(client, '');
  const ctx = { brainDir: brain, projectDir: project, config: { comms: { client } } };
  assert.match(noMailConfigLine(ctx), /mail: NOT set up for this brain .*project\.mjs mail .*proj.*mail-machine --url/);
  // The machine config (a tunnel) serves the brain: no line, settings use it, install issues no brain key.
  fs.mkdirSync(path.dirname(process.env.WORKFLOW_MACHINE_COMMS), { recursive: true });
  fs.writeFileSync(process.env.WORKFLOW_MACHINE_COMMS, '{"url":"https://posta.example/","key":"k","instance_id":"i1"}');
  assert.equal(noMailConfigLine(ctx), null);
  assert.equal(commsSettings(ctx).configFile, process.env.WORKFLOW_MACHINE_COMMS);
  assert.match(issueMailKey({ projectDir: project, brainDir: brain, sessionBrain: null }), /the machine's config serves this brain/);
  // The brain's own config wins over the machine's.
  const cfg = dataPath(brain, 'local', 'comms.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, '{}');
  assert.equal(commsSettings(ctx).configFile, cfg);
  fs.rmSync(cfg); fs.rmSync(process.env.WORKFLOW_MACHINE_COMMS);
  assert.equal(noMailConfigLine({ ...ctx, config: { comms: false } }), null);
});

test('a failed mail to the maintainer is said at every session start until a report is mailed again', () => {
  assert.equal(maintainerMailLine(), null);
  markMaintainerMail('no maintainer thread on this mail server (404)');
  assert.match(maintainerMailLine(), /mail to the maintainer does NOT work since .*no maintainer thread.*Úlohy pre operátora.*mail-machine/);
  markMaintainerMail(null);
  assert.equal(maintainerMailLine(), null);
});

test('a wake job of a brain served by the machine config goes into its wake.jobs, once per name (doma-pc 2026-11-18)', async () => {
  const { ensureJob } = await import('../scripts/wake-job.mjs');
  const brain = path.join(root, 'brain-w'); const project = path.join(root, 'proj-w');
  fs.mkdirSync(brain); fs.mkdirSync(project);
  const client = path.join(root, 'comms-w.mjs'); fs.writeFileSync(client, '');
  const file = process.env.WORKFLOW_MACHINE_COMMS;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"url":"https://posta.example/","key":"k","instance_id":"i1"}');
  const ctx = { brainDir: brain, projectDir: project, config: { comms: { client } } };
  const job = { name: 'overview', command: 'node /x/overview.mjs wake', interval_ms: 60000 };
  const r = ensureJob(ctx, job);
  assert.equal(r.changed, true, r.line);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.wake.jobs, [job]);
  assert.equal(cfg.key, 'k', 'the key and url stay');
  assert.equal(ensureJob(ctx, job).changed, false, 'the same job is not written twice');
  fs.rmSync(file);
});

test('the key of a brain is issued with the brain\'s name, not the name of the project that set the mail up', () => {
  const brain = path.join(root, 'shared-brain'); const project = path.join(root, 'second-project'); const session = path.join(root, 'session-brain');
  for (const d of [brain, project]) fs.mkdirSync(d, { recursive: true });
  const src = dataPath(session, 'local', 'comms.json');
  fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, '{"instance":"prod","instance_id":"i1"}');
  const client = path.join(root, 'client.mjs'); fs.writeFileSync(client, '');
  const calls = [];
  const run = (_node, argv) => { calls.push(argv); return argv[1] === 'key' ? { status: 0, stdout: '{"key":"k1"}' } : { status: 0, stdout: '{"instance_id":"i1"}' }; };
  assert.match(issueMailKey({ projectDir: project, brainDir: brain, sessionBrain: session, client, run }), /key issued for sender shared-brain/);
  assert.deepEqual(calls[0].slice(1), ['key', 'add', '--instance', 'prod', '--sender', 'shared-brain']);
});

test('a session without a brain of its own signs with WORKFLOW_COMMS_CONFIG, not with the key of the brain it reads mail through', () => {
  const home = path.join(root, 'home-brain'); const own = path.join(root, 'own', 'comms.json');
  const cfg = dataPath(home, 'local', 'comms.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, '{}');
  fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, '{}');
  const client = path.join(root, 'c2.mjs'); fs.writeFileSync(client, '');
  const ctx = { brainDir: null, mailBrainDir: home, projectDir: root, config: { comms: { client } } };
  assert.equal(commsSettings(ctx).configFile, cfg);
  process.env.WORKFLOW_COMMS_CONFIG = own;
  try { assert.equal(commsSettings(ctx).configFile, own); } finally { delete process.env.WORKFLOW_COMMS_CONFIG; }
});

test('a thread without a brain on a machine with only the machine config reads its mail (not refused for want of a brain)', () => {
  const dir = path.join(root, 'bare'); fs.mkdirSync(dir, { recursive: true });
  const machine = path.join(root, 'only-machine', 'comms.json');
  fs.mkdirSync(path.dirname(machine), { recursive: true }); fs.writeFileSync(machine, '{"url":"http://127.0.0.1:9/","key":"k","instance_id":"i"}');
  const env = { ...process.env, WORKFLOW_MACHINE_COMMS: machine, WORKFLOW_THREAD_ID: 't-bare', WORKFLOW_PIN_FILE: path.join(root, 'no-pin.json'), WORKFLOW_ROOT_FILE: path.join(root, 'no-root') };
  delete env.WORKFLOW_COMMS_CONFIG;
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'comms.mjs'), 'list'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(r.stderr, /with the machine's config .*only-machine\/comms\.json/);
  assert.doesNotMatch(r.stderr, /no brain on this machine has mail settings/);
});
