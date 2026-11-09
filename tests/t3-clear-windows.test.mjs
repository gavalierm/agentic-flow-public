// T3 /clear workaround (t3code#24152) on Windows: symlinks need Developer Mode (EPERM otherwise), so the cursor
// transcript becomes a hard link; when the new transcript does not exist yet, it is linked later (never pre-created).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleT3Session, linkLater } from '../scripts/t3-clear.mjs';

const A = '6168aa37-ede5-4546-912e-0f540e534356', B = '4c91917d-9adf-4f4d-8f7d-d67a3813bf79';
const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3clear-'));
  return { dir, tp: (id) => path.join(dir, `${id}.jsonl`), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('symlink refused (EPERM): <cursor>.jsonl becomes a hard link to the new transcript', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.tp(A), 'old\n');
    fs.writeFileSync(fx.tp(B), 'new\n');
    const spawned = [];
    const r = handleT3Session({ source: 'clear', session_id: B, transcript_path: fx.tp(B) }, { t3_cursor: A },
      { thread: 't', symlink: eperm, spawnLater: (...a) => spawned.push(a) });
    assert.match(r.note, /presmerovaný na novú session 4c91917d \(hard link\)/);
    assert.equal(r.state.t3_cleared_to, B);
    const st = fs.lstatSync(fx.tp(A));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.ino, fs.statSync(fx.tp(B)).ino);
    fs.appendFileSync(fx.tp(B), 'turn\n');
    assert.equal(fs.readFileSync(fx.tp(A), 'utf8'), 'new\nturn\n');
    assert.equal(fs.readdirSync(fx.dir).filter((f) => f.includes('.pre-clear-')).length, 1);
    assert.deepEqual(spawned, []);
  } finally { fx.cleanup(); }
});

test('symlink refused and the new transcript not written yet: nothing is pre-created, the link is made once it appears', async () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.tp(A), 'old\n');
    const spawned = [];
    const r = handleT3Session({ source: 'clear', session_id: B, transcript_path: fx.tp(B) }, { t3_cursor: A },
      { thread: 't', symlink: eperm, spawnLater: (...a) => spawned.push(a) });
    assert.match(r.note, /sa presmeruje na novú session 4c91917d hard linkom, keď vznikne jej transkript/);
    assert.deepEqual(spawned, [[fx.dir, A, B]]);
    assert.equal(fs.existsSync(fx.tp(B)), false, 'the new transcript must not be pre-created');
    assert.equal(fs.existsSync(fx.tp(A)), false, 'old transcript moved aside');
    const later = linkLater(fx.dir, A, B, { timeoutMs: 2000, intervalMs: 20 });
    setTimeout(() => fs.writeFileSync(fx.tp(B), 'new\n'), 100);
    assert.equal(await later, 'hardlink');
    assert.equal(fs.statSync(fx.tp(A)).ino, fs.statSync(fx.tp(B)).ino);
    assert.equal(await linkLater(fx.dir, A, B, { timeoutMs: 50, intervalMs: 10 }), null, 'name taken: no second link');
  } finally { fx.cleanup(); }
});
