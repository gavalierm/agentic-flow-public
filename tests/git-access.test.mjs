// ttl: 2026-12-16
// A repo git refuses (dubious ownership: cloned through another account) is named with both users and both fixes, in
// every repo a check reads (session start: brain and project; pre-release and migrate: every repo of the domain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitAccessProblem } from '../scripts/brain.mjs';

const stderr = [
  "fatal: detected dubious ownership in repository at 'D:/Root/Dom/app'",
  "'D:/Root/Dom/app' is owned by:",
  '\tPC/sharing (S-1-5-21-1-1002)',
  'but the current user is:',
  '\tPC/Operator Name (S-1-5-21-1-1001)',
  'To add an exception for this directory, call:',
  "\tgit config --global --add safe.directory 'D:/Root/Dom/app'",
].join('\n');

test('dubious ownership: the owner, the user of this process, a change of owner and safe.directory', () => {
  const msg = gitAccessProblem('/r/Dom/app', { ok: false, stderr });
  assert.match(msg, /git refuses \/r\/Dom\/app \(dubious ownership: .*\(owner PC\/sharing, this process runs as PC\/Operator Name\)\); every git command there fails/);
  assert.match(msg, process.platform === 'win32' ? /icacls ".*app" \/setowner "PC\/Operator Name" \/T \/C/ : /sudo chown -R PC\/Operator Name \/r\/Dom\/app/);
  assert.match(msg, /git config --global --add safe\.directory \/r\/Dom\/app/);
  assert.equal(gitAccessProblem('/r/Dom/app', { ok: false, stderr: 'fatal: not a git repository' }), null, 'another git error is not this finding');
  assert.equal(gitAccessProblem('/r/Dom/app', { ok: true, stderr: '' }), null);
});
