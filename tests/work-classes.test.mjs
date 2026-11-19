// keep: guarded
// Classes of work files (operator 2026-11-19, 13 GB in one domain): the end of a turn empties tmp/_pomocne/ and keeps in a
// backup folder only the first backup and the last three (hardlinked names are one backup); nothing else is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearHelpers, backupFolders, pruneBackups, sizeLine } from '../scripts/work-classes.mjs';

test('helpers go, backups keep the first and the last 3, the rest of tmp/ stays', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-wc-'));
  try {
    fs.mkdirSync(path.join(tmp, '_pomocne', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_pomocne', 'export.csv'), 'x'.repeat(10));
    fs.writeFileSync(path.join(tmp, '_pomocne', 'sub', 'a.log'), 'y');
    fs.writeFileSync(path.join(tmp, 'navrh.md'), 'keep');
    const z = path.join(tmp, 'pilot', 'zaloha');
    fs.mkdirSync(path.join(z, 'kontrola'), { recursive: true });
    fs.writeFileSync(path.join(z, 'kontrola', 'in-sub.csv'), 'sub');
    for (let i = 0; i < 6; i += 1) {
      const f = path.join(z, `b${i}.csv`);
      fs.writeFileSync(f, `state ${i}`);
      fs.utimesSync(f, 1000 + i, 1000 + i);
    }
    fs.linkSync(path.join(z, 'b5.csv'), path.join(z, 'b5-copy.csv'));
    fs.linkSync(path.join(z, 'b2.csv'), path.join(z, 'b2-copy.csv'));

    assert.deepEqual(clearHelpers(tmp), { files: 2, bytes: 11 });
    assert.deepEqual(fs.readdirSync(path.join(tmp, '_pomocne')), []);
    assert.deepEqual(backupFolders(tmp), [z]);
    assert.deepEqual(pruneBackups(z).map((r) => r.name).sort(), ['b1.csv', 'b2-copy.csv', 'b2.csv']);
    assert.deepEqual(fs.readdirSync(z).sort(), ['b0.csv', 'b3.csv', 'b4.csv', 'b5-copy.csv', 'b5.csv', 'kontrola']);
    assert.deepEqual(pruneBackups(z), []);
    assert.equal(fs.readFileSync(path.join(tmp, 'navrh.md'), 'utf8'), 'keep');
    assert.equal(sizeLine('t', tmp, 1e6), null);
    assert.match(sizeLine('t', tmp, 1), /work files of topic t: .* in tmp\/ .*_pomocne.*_zalohy/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
