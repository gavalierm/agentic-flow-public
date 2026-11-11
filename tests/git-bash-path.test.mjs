// Issue #28: Git Bash on Windows gives /d/<projekt>/... ; the write check must see D:/... (P-052).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as hook from '../hooks/pre-tool-use.mjs';

test('Git Bash /<drive>/ paths become <DRIVE>:/ on win32 only', () => {
  assert.equal(hook.gitBashPath('/d/proj/scratch/x.md', 'win32'), 'D:/proj/scratch/x.md');
  assert.equal(hook.gitBashPath('/c', 'win32'), 'C:/');
  assert.equal(hook.gitBashPath('/d/proj/scratch/x.md', 'linux'), '/d/proj/scratch/x.md', 'a POSIX path is unchanged off Windows');
  assert.equal(hook.gitBashPath('/home/u/x', 'win32'), '/home/u/x', 'a longer first segment is not a drive');
  assert.equal(hook.gitBashPath('D:\\proj\\x', 'win32'), 'D:\\proj\\x');
});

test('a Git Bash scratch path resolves inside the project scratch on win32', () => {
  const abs = path.win32.resolve('C:\\Users\\u\\cwd', hook.gitBashPath('/d/proj/scratch/x.md', 'win32'));
  assert.equal(abs, 'D:\\proj\\scratch\\x.md');
});

test('a Bash write to a Git Bash /d/ path is checked as D:/ on win32 (shellWriteTargets, bashTargets)', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const w = hook.shellWriteTargets('echo x > /d/proj/scratch/a.md', 'D:/proj').map((t) => t.path);
    assert.ok(w.some((p) => p.includes('D:/proj/scratch/a.md')), JSON.stringify(w));
    assert.ok(!w.some((p) => p.startsWith('/d/')), 'no Git Bash form left');
  } finally { Object.defineProperty(process, 'platform', real); }
});
