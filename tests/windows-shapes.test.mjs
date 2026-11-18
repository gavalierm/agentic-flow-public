// ttl: 2026-12-17
// Windows shapes of the changes of 2026-11-17 (a domain on Windows, Git Bash and PowerShell; optimistic: checked on any OS):
// a handover cites work files with backslashes and an absolute path with a space (D:\Claude projekty\…), a skill script
// runs with a quoted Windows path or node.exe, a step starts with a quoted cd or Set-Location.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { domain3 } from './layout-2-helpers.mjs';
import { citedWork } from '../scripts/results.mjs';
import { noTopicWork, consentTargets } from '../hooks/pre-tool-use.mjs';

test('handover citations in Windows form resolve to the work files', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'S', '--class', 'ops']).status, 0);
    const a = path.join(fx.brain, 'topics', 't1', 'tmp', 'nazvoslovie', 'navrh.html');
    const b = path.join(fx.brain, 'topics', 't1', 'tmp', 'node-test.out');
    fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'y');
    const text = 'stránka tmp\\nazvoslovie\\navrh.html; záznam je v D:\\Claude projekty\\Shop\\brain\\topics\\t1\\tmp\\node-test.out (gitignorovaný), priečinok tmp\\nazvoslovie\\';
    const c = citedWork(fx.brain, 't1', text);
    assert.deepEqual(c.files.sort(), [a, b].sort());
    assert.deepEqual(c.dirs, [path.dirname(a)]);
  } finally { fx.cleanup(); }
});

test('a skill script in Windows form is work; the workflow scripts are not; a quoted cd names its folder', () => {
  assert.equal(noTopicWork('Bash', { command: 'node "D:\\Claude projekty\\Shop\\shopsk\\.claude\\skills\\nahodenie-produktu\\check-access.mjs" --init' }), 'runs a skill script');
  assert.equal(noTopicWork('PowerShell', { command: '& node.exe D:/Claude/.claude/skills/nahodenie-produktu/publish-batch.mjs d1' }), 'runs a skill script');
  assert.equal(noTopicWork('Bash', { command: `node "C:/${'Users'}/User/.claude/skills/workflow/bin/topic.mjs" claim t1` }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-win cd-'));
  try {
    assert.deepEqual(consentTargets('Bash', { command: `cd "${dir}" && git commit --no-verify -m x` }), [dir]);
    assert.deepEqual(consentTargets('PowerShell', { command: `Set-Location -Path "${dir}"; git commit --no-verify -m x` }), [dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
