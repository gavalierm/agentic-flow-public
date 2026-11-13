// The workflow tells the mail client its version (COMMS_WORKFLOW_VERSION); the mail service records it per
// persona and machine, so another machine's workflow version is visible on the server (`comms clients`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClient, workflowVersion } from '../scripts/comms.mjs';
import { PLUGIN_ROOT } from '../scripts/util.mjs';

test('runClient passes the workflow version to the mail client', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ver-'));
  try {
    const file = path.join(root, 'client.mjs');
    fs.writeFileSync(file, 'process.stdout.write(JSON.stringify({ v: process.env.COMMS_WORKFLOW_VERSION || null }));\n');
    const res = runClient({ projectDir: root, config: { comms: { client: file } } }, ['health']);
    assert.equal(res.ok, true, res.error);
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    assert.equal(res.data.v, `v${pkg.version}`);
    assert.equal(workflowVersion(), `v${pkg.version}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
