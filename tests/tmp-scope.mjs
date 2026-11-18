// Every test process works in a temp dir of its own, removed when the process exits (a server report 2026-11-18: the
// tests left mkdtemp dirs in /tmp, ~167 000 inodes in 4 days; tmpfs at 85 % of its inode limit). Import it first: the
// modules after it and the processes a test starts get TMPDIR/TMP/TEMP inside it. A process inside a scoped run
// (WF_TEST_TMP_SCOPED from test-slot or an outer test) keeps the outer dir, which its owner removes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.WF_TEST_TMP_SCOPED || !fs.existsSync(process.env.WF_TEST_TMP_SCOPED)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
  process.env.TMPDIR = dir; process.env.TMP = dir; process.env.TEMP = dir; process.env.WF_TEST_TMP_SCOPED = dir;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}
