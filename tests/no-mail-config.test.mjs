// ttl: 2026-12-18
// flow-public#103: a brain without <brain>/local/comms.json sent every mail call to instance default without a key, and
// nothing said so. Session start names it with the fix; a brain with the config, or mail turned off, gets no line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noMailConfigLine } from '../scripts/comms.mjs';
import { dataPath } from '../scripts/layout.mjs';

test('a brain without local/comms.json gets the line with project.mjs mail; with the config or comms off none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomail-'));
  const brain = path.join(root, 'brain'); const project = path.join(root, 'proj');
  fs.mkdirSync(brain); fs.mkdirSync(project);
  const client = path.join(root, 'comms.mjs'); fs.writeFileSync(client, '');
  const ctx = { brainDir: brain, projectDir: project, config: { comms: { client } } };
  assert.match(noMailConfigLine(ctx), /mail: NOT set up for this brain .*project\.mjs mail .*proj/);
  const cfg = dataPath(brain, 'local', 'comms.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, '{}');
  assert.equal(noMailConfigLine(ctx), null);
  fs.rmSync(cfg);
  assert.equal(noMailConfigLine({ ...ctx, config: { comms: false } }), null);
});
