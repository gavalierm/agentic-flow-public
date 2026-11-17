// keep: core
// T3 0.1.10 (pilot 2026-11-17): T3 resumes the session /clear started (t3code#35054), so the /clear redirect is off from
// that version; `t3 thread start` still has no --effort (t3code#29863 closed as not planned), checked from --help.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleT3Session, versionAtLeast, T3_CLEAR_FIXED } from '../scripts/t3-clear.mjs';
import { checkCliEffort, checkCliGone, checkFixedIn, readRegistry } from '../scripts/t3-workarounds.mjs';

test('versionAtLeast compares dotted versions numerically; unknown is false', () => {
  assert.equal(versionAtLeast('0.1.10', '0.1.9'), true);
  assert.equal(versionAtLeast('0.1.9', '0.1.10'), false);
  assert.equal(versionAtLeast('v0.1.10', '0.1.10'), true);
  assert.equal(versionAtLeast('0.2.0', '0.1.10'), true);
  assert.equal(versionAtLeast(null, '0.1.10'), false);
});

test('t3-clear: /clear is left alone on a fixed T3 and redirected on an older one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-t3clear-'));
  try {
    const cursor = '11111111-1111-4111-8111-111111111111';
    const sid = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(path.join(dir, `${cursor}.jsonl`), 'old\n');
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), 'new\n');
    const input = { source: 'clear', session_id: sid, transcript_path: path.join(dir, `${sid}.jsonl`) };
    const state = { t3_cursor: cursor };
    const fixed = handleT3Session(input, state, { t3Version: T3_CLEAR_FIXED });
    assert.equal(fixed.state, state);
    assert.equal(fixed.note, null);
    assert.equal(fs.lstatSync(path.join(dir, `${cursor}.jsonl`)).isSymbolicLink(), false);
    const old = handleT3Session(input, state, { t3Version: '0.1.9', spawnLater: () => {} });
    assert.equal(old.state.t3_cleared_to, sid);
    assert.equal(fs.readFileSync(path.join(dir, `${cursor}.jsonl`), 'utf8'), 'new\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic checks: --effort from help, a missing thread named gone, the fixed version', () => {
  const help = (extra) => () => ({ status: 0, stdout: `FLAGS\n  --title string\n  --provider string\n  --model string\n${extra}`, stderr: '' });
  assert.equal(checkCliEffort('t3', help(''))[0], 'OK');
  assert.equal(checkCliEffort('t3', help('  --effort string\n'))[0], 'REMOVE');
  assert.equal(checkCliEffort('t3', () => ({ status: 0, stdout: '--title', stderr: '' }))[0], 'FAIL');
  assert.equal(checkCliGone('t3', () => ({ status: 1, stdout: 'Thread x is no longer available.\n', stderr: '' }))[0], 'OK');
  assert.equal(checkCliGone('t3', () => ({ status: 0, stdout: '{"thread":{}}', stderr: '' }))[0], 'FAIL');
  const w = readRegistry().find((x) => x.id === 't3-clear-cursor');
  assert.equal(w.fixed_in, T3_CLEAR_FIXED);
  assert.match(checkFixedIn(w, '0.1.10')[1], /workaround is off here/);
  assert.match(checkFixedIn(w, '0.1.9')[1], /stays active/);
  assert.equal(checkFixedIn(w, null)[0], 'PENDING');
});
