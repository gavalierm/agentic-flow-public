// A new brain of connect or create gets its sender key and <brain>/local/comms.json: without them the project's topics
// were not registered and its mail stayed in local/outbox (alice 2026-11-11, adoption with a new brain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueMailKey } from '../scripts/project.mjs';

test('issueMailKey issues a key for the project, writes the brain mail config once and checks the service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mailkey-'));
  try {
    const log = path.join(dir, 'client.log');
    const client = path.join(dir, 'comms.mjs');
    fs.writeFileSync(client, `import fs from 'node:fs';\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');\nif (a[0] === 'key') console.log(JSON.stringify({ sender: a[a.indexOf('--sender') + 1], key: 'k-new' }));\nelse console.log(JSON.stringify({ ok: true, instance_id: 'i1' }));\n`);
    const session = path.join(dir, 'session-brain');
    fs.mkdirSync(path.join(session, 'local'), { recursive: true });
    fs.writeFileSync(path.join(session, 'local', 'comms.json'), JSON.stringify({ instance: 'pilot', key: 'k-session', instance_id: 'i1' }));
    const brainDir = path.join(dir, 'Shop', 'shop-brain');
    const projectDir = path.join(dir, 'Shop', 'shop-web');
    fs.mkdirSync(brainDir, { recursive: true });
    let line = issueMailKey({ projectDir, brainDir, sessionBrain: session, client });
    assert.match(line, /mail: key issued for sender shop-web .*service answers/);
    const file = path.join(brainDir, 'local', 'comms.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { instance: 'pilot', key: 'k-new', instance_id: 'i1' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], ['key', 'add', '--instance', 'pilot', '--sender', 'shop-web']);
    assert.doesNotMatch(line, /k-new/, 'the key is never printed');
    line = issueMailKey({ projectDir, brainDir, sessionBrain: session, client });
    assert.match(line, /mail: config exists/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'no second key');
    fs.rmSync(path.join(brainDir, 'local'), { recursive: true });
    line = issueMailKey({ projectDir, brainDir, sessionBrain: path.join(dir, 'none'), client });
    assert.match(line, /mail: NOT set up \(this session has no mail config[^)]*\): issue a key with node .* key add --instance <instance> --sender shop-web/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
