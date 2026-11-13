// 3c review G: job issue-watch installed by another plugin clone of this machine (stable, a dev clone) stays as it is,
// interval too, while its script exists (one job checks all projects); only a job whose script is gone is replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIssueWatchJob, issueWatchCommand } from '../scripts/wake-job.mjs';

const ctx = (extra = {}) => ({ projectDir: '/nonexistent-project', brainDir: null, config: {}, policy: { issue_watch: { interval_s: 900 } }, ...extra });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-wake-keep-'));
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg'), COMMS_BASE_DIR: path.join(root, 'comms') };
  const file = path.join(env.COMMS_BASE_DIR, 'default', 'wake.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { root, env, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a job whose script exists is kept, interval too: nothing written, line `kept`', () => {
  const sb = sandbox();
  try {
    const other = path.join(sb.root, 'other-clone');
    fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(other, 'bin', 'issue-watch.mjs'), '');
    const theirs = { name: 'issue-watch', command: issueWatchCommand(other), interval_ms: 300000 };
    fs.writeFileSync(sb.file, JSON.stringify({ keepalive: { enabled: true }, jobs: [theirs] }));
    const bytes = fs.readFileSync(sb.file, 'utf8');
    let r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, false, r.line);
    assert.match(r.line, /^wake job issue-watch: kept in .*wake\.json \(its script .*other-clone\/bin\/issue-watch\.mjs exists; every 300 s\)$/);
    assert.equal(fs.readFileSync(sb.file, 'utf8'), bytes, 'unchanged');
    // This clone's own job with another interval in the policy: kept as well (the job's interval is not overwritten).
    fs.writeFileSync(sb.file, JSON.stringify({ jobs: [{ name: 'issue-watch', command: issueWatchCommand(), interval_ms: 900000 }] }));
    const own = fs.readFileSync(sb.file, 'utf8');
    r = ensureIssueWatchJob(ctx({ policy: { issue_watch: { interval_s: 60 } } }), { env: sb.env, platform: 'linux' });
    assert.match(r.line, /kept in .*every 900 s/);
    assert.equal(fs.readFileSync(sb.file, 'utf8'), own);
  } finally { sb.done(); }
});

test('a job whose script is gone is replaced by this clone\'s job', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.file, JSON.stringify({ jobs: [{ name: 'other', command: 'true', interval_ms: 60000 }, { name: 'issue-watch', command: issueWatchCommand(path.join(sb.root, 'removed-clone')), interval_ms: 300000, extra: 1 }] }));
    const r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, true, r.line);
    assert.match(r.line, /updated in .*wake\.json \(every 900 s; wake restarts on the change\)/);
    const data = JSON.parse(fs.readFileSync(sb.file, 'utf8'));
    assert.deepEqual(data.jobs, [{ name: 'other', command: 'true', interval_ms: 60000 }, { name: 'issue-watch', command: issueWatchCommand(), interval_ms: 900000, extra: 1 }]);
  } finally { sb.done(); }
});
