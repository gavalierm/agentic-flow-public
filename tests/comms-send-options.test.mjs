// report-66bf5f76: `comms send` with options from memory (--category, --body) dropped them silently and the error named only
// the missing --level; an unknown option is refused before anything is sent and names the right one.
// Comms client: tests/fixtures/comms-stub.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

function stubbed() {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const logFile = path.join(fx.root, 'stub-log.jsonl');
  fs.writeFileSync(stateFile, '{}');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: logFile });
  fx.sends = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'send') : []);
  return fx;
}

test('comms send refuses unknown options, names their replacement and sends nothing', () => {
  const fx = stubbed();
  const r = fx.run('comms.mjs', ['send', '--level', 'assist', '--category', 'assist', '--to', 'project/alpha', '--body', 'hi']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /unknown option --category \(use --level\), --body \(use --text\); nothing sent/);
  assert.equal(fx.sends().length, 0);
});

test('comms send keeps accepting its own options (the level check still runs)', () => {
  const fx = stubbed();
  const r = fx.run('comms.mjs', ['send', '--to', 'project/alpha', '--text', 'hi']);
  assert.notEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /unknown option/);
  assert.match(r.out, /--level is required/);
});
