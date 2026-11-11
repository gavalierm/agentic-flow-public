// alice 2026-11-10: the session folder <id>/ (tool-results) was a symlink into another history folder, so Claude Code
// refused to persist the SessionStart context and cut it to 10 000 chars. SessionStart makes the folder real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleT3Session } from '../scripts/t3-clear.mjs';

const A = '6168aa37-ede5-4546-912e-0f540e534356', B = '4c91917d-9adf-4f4d-8f7d-d67a3813bf79';

test('SessionStart: a session folder that is a symlink into another history folder becomes real, the old place links to it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3dir-'));
  try {
    const proj = path.join(root, 'proj'), other = path.join(root, 'domain');
    fs.mkdirSync(path.join(other, A, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(other, A, 'tool-results', 'x.txt'), 'kept\n');
    fs.mkdirSync(proj);
    fs.symlinkSync(path.join(other, A), path.join(proj, A), 'dir');
    fs.writeFileSync(path.join(proj, `${A}.jsonl`), '{}\n');
    const r = handleT3Session({ source: 'resume', session_id: A, transcript_path: path.join(proj, `${A}.jsonl`) }, { t3_cursor: A }, { thread: 't' });
    assert.match(r.note || '', /priečinok session 6168aa37 bol odkaz/);
    assert.equal(fs.lstatSync(path.join(proj, A)).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(proj, A, 'tool-results', 'x.txt'), 'utf8'), 'kept\n');
    assert.equal(fs.lstatSync(path.join(other, A)).isSymbolicLink(), true, 'paths written in transcripts still resolve');
    assert.equal(fs.readFileSync(path.join(other, A, 'tool-results', 'x.txt'), 'utf8'), 'kept\n');
    // A real folder and a missing one are left alone.
    fs.mkdirSync(path.join(proj, B));
    const again = handleT3Session({ source: 'startup', session_id: B, transcript_path: path.join(proj, `${B}.jsonl`) }, { t3_cursor: A }, { thread: 't' });
    assert.equal(again.note, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
