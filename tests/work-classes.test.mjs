// keep: guarded
// Classes of work files (operator 2026-11-19, 13 GB in one domain): the end of a turn empties tmp/_pomocne/ and keeps in a
// backup folder only the first backup and the last three (hardlinked names are one backup); nothing else is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearHelpers, backupFolders, pruneBackups, sizeLine, repoWorkFinding } from '../scripts/work-classes.mjs';
import { layoutFor } from '../scripts/layout.mjs';

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
    // The rotated backups (files directly in a backup folder) are not counted: navrh.md 4 B + zaloha/kontrola/in-sub.csv 3 B.
    assert.equal(sizeLine('t', tmp, 7), null);
    assert.match(sizeLine('main', tmp, 7), /work files of topic main/, 'topic main is never tidied: its backups count');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// operator 2026-11-20: 936 MB of rotated backups of 4 topics were alone over the 500 MB limit of the brain.
test('the work files finding of a brain does not count the backups the flow rotates, topic main counts in full', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-wc-'));
  const write = (rel, n) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'.repeat(n)); };
  try {
    write('topics/alpha/tmp/_zalohy/export-1.csv', 3000);
    write('topics/alpha/tmp/work.csv', 500);
    const map = layoutFor(3);
    assert.equal(repoWorkFinding(dir, map, { limit: 1024 }), null);
    write('topics/alpha/tmp/copy.csv', 600);
    const f = repoWorkFinding(dir, map, { limit: 1024 });
    assert.equal(f.files, 2);
    assert.match(f.text, /2 file\(s\), 1\.1 kB of work files outside git .*largest: topics\/alpha\/tmp\/copy\.csv 600 B, topics\/alpha\/tmp\/work\.csv 500 B; not counted: 2\.9 kB of backups the flow rotates\. Triage/);
    fs.rmSync(path.join(dir, 'topics/alpha/tmp/copy.csv'));
    write('topics/main/tmp/_zalohy/export-1.csv', 3000);
    assert.equal(repoWorkFinding(dir, map, { limit: 1024 }).files, 2, 'main: backup counted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
