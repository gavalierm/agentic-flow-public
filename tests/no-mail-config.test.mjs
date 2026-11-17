// ttl: 2026-12-18
// flow-public#103, operator 2026-11-18: a brain without <brain>/local/comms.json sent every mail call to instance default
// without a key, nothing said so, and a report that fell back to an issue was taken quietly. Session start names a brain
// without mail; a machine config serves every brain without its own; a failed mail to the maintainer stays said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
