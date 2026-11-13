// D-0024: the installation (adapter.mjs claude-code, project.mjs t3) puts job `issue-watch` into the wake.json of this
// machine's mail instance; merged by name, idempotent, other keys and jobs kept; nothing written where wake is not
// installed. One round at a time (lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { ensureIssueWatchJob, wakeFile, issueWatchCommand, jobScript } from '../scripts/wake-job.mjs';
import { watchIssues } from '../scripts/issue-watch.mjs';

const ctx = (extra = {}) => ({ projectDir: '/nonexistent-project', brainDir: null, config: {}, policy: { issue_watch: { interval_s: 900 } }, ...extra });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-wake-'));
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg'), COMMS_BASE_DIR: path.join(root, 'comms') };
  return { root, env, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('wake not installed: nothing written, the line says so', () => {
  const sb = sandbox();
  try {
    const r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, false);
    assert.match(r.line, /^wake job issue-watch: wake not installed on this machine \(.*comms\/default\/wake\.json missing\), nothing written/);
    assert.ok(!fs.existsSync(path.join(sb.env.COMMS_BASE_DIR)), 'no directory created');
    const o = ensureIssueWatchJob(ctx(), { env: { WORKFLOW_WAKE_FILE: path.join(sb.root, 'x', 'wake.json') } });
    assert.equal(o.changed, false);
    assert.ok(!fs.existsSync(path.join(sb.root, 'x')));
  } finally { sb.done(); }
});

test('merged by name into wake.json: keepalive and other jobs kept, idempotent, an old command updated', () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.env.COMMS_BASE_DIR, 'default', 'wake.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keepalive: { enabled: true }, jobs: [{ name: 'other', command: 'true', interval_ms: 60000 }] }));
    let r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, true);
    assert.match(r.line, /added to .*wake\.json \(every 900 s; wake restarts on the change\)/);
    let data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(data.keepalive, { enabled: true });
    assert.deepEqual(data.jobs, [{ name: 'other', command: 'true', interval_ms: 60000 }, { name: 'issue-watch', command: issueWatchCommand(), interval_ms: 900000 }]);
    const bytes = fs.readFileSync(file, 'utf8');
    r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, false);
    assert.match(r.line, /already in/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'idempotent');
    // Another clone with another interval: the job's script exists, so it is kept as it is (wake-job-keep.test.mjs).
    r = ensureIssueWatchJob(ctx({ policy: { issue_watch: { interval_s: 60 } } }), { env: sb.env, platform: 'linux', pluginRoot: '/elsewhere/plugin' });
    assert.match(r.line, /kept in/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    // A job whose script is gone (a removed clone) is updated in place.
    data.jobs[1].command = issueWatchCommand('/elsewhere/plugin');
    fs.writeFileSync(file, JSON.stringify(data));
    r = ensureIssueWatchJob(ctx({ policy: { issue_watch: { interval_s: 60 } } }), { env: sb.env, platform: 'linux' });
    assert.match(r.line, /updated in/);
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.jobs.length, 2);
    assert.equal(data.jobs[1].interval_ms, 60000);
    assert.equal(data.jobs[1].command, issueWatchCommand());
    // Not a JSON object: left alone.
    fs.writeFileSync(file, '[1]');
    r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.match(r.line, /not a JSON object, left as it is/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[1]');
  } finally { sb.done(); }
});

test('the write keeps the permission bits of wake.json (0600 stays 0600), a created file is 0600', { skip: process.platform === 'win32' }, () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.env.COMMS_BASE_DIR, 'default', 'wake.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keepalive: { enabled: true } }));
    fs.chmodSync(file, 0o600);
    const r = ensureIssueWatchJob(ctx(), { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, true, r.line);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    const state = path.join(sb.env.COMMS_BASE_DIR, 'pilot', 'client', 'wake', 'wake-state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    const c = ctx({ config: { comms: { instance: 'pilot' } } });
    assert.equal(ensureIssueWatchJob(c, { env: sb.env, platform: 'linux' }).changed, true);
    assert.equal((fs.statSync(path.join(sb.env.COMMS_BASE_DIR, 'pilot', 'wake.json')).mode & 0o777).toString(8), '600');
  } finally { sb.done(); }
});

test('installed wake without wake.json (state file or systemd unit): the file is created; instance from the project config', () => {
  const sb = sandbox();
  try {
    const c = ctx({ config: { comms: { instance: 'pilot' } } });
    assert.equal(wakeFile(c, sb.env).file, path.join(sb.env.COMMS_BASE_DIR, 'pilot', 'wake.json'));
    const state = path.join(sb.env.COMMS_BASE_DIR, 'pilot', 'client', 'wake', 'wake-state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    let r = ensureIssueWatchJob(c, { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, true, r.line);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.env.COMMS_BASE_DIR, 'pilot', 'wake.json'), 'utf8')).jobs[0].name, 'issue-watch');
    // Systemd unit of instance prod, no data yet.
    const unit = path.join(sb.env.XDG_CONFIG_HOME, 'systemd', 'user', 'agentic-wake-prod.service');
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]\n');
    r = ensureIssueWatchJob(ctx(), { env: { ...sb.env, COMMS_INSTANCE: 'prod' }, platform: 'linux' });
    assert.equal(r.changed, true, r.line);
    assert.ok(fs.existsSync(path.join(sb.env.COMMS_BASE_DIR, 'prod', 'wake.json')));
    // COMMS_DATA_DIR wins.
    assert.equal(wakeFile(c, { ...sb.env, COMMS_DATA_DIR: path.join(sb.root, 'd') }).file, path.join(sb.root, 'd', 'wake.json'));
  } finally { sb.done(); }
});

test('adapter.mjs claude-code names the wake job; without wake nothing is written', () => {
  const fx = setup();
  try {
    const r = fx.run('adapter.mjs', ['claude-code']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /note: wake job issue-watch: wake not installed on this machine/);
    assert.ok(!fs.existsSync('/nonexistent-machine-dir'));
  } finally { fx.cleanup(); }
});

test('jobScript: the script of a job command (an existing job of another clone is kept while it exists)', () => {
  assert.equal(jobScript('"/usr/bin/node" "/a b/bin/issue-watch.mjs"'), '/a b/bin/issue-watch.mjs');
  assert.equal(jobScript('node /p/bin/issue-watch.mjs --x'), '/p/bin/issue-watch.mjs');
  assert.equal(jobScript('/usr/local/bin/watch run'), 'run');
  assert.equal(jobScript(''), null);
});

test('one round at a time: a running round makes the next one stop', async () => {
  const sb = sandbox();
  try {
    const index = path.join(sb.root, 'idx', 'index.json');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(`${index}.lock`, '');
    const r = await watchIssues({ env: { ...sb.env, WORKFLOW_ISSUE_WATCH_INDEX: index } });
    assert.equal(r.busy, true);
    assert.deepEqual(r.lines, ['issue-watch: another round is running']);
    fs.rmSync(`${index}.lock`);
    const free = await watchIssues({ env: { ...sb.env, WORKFLOW_ISSUE_WATCH_INDEX: index } });
    assert.deepEqual(free.lines, ['issue-watch: no records on this machine']);
    assert.ok(!fs.existsSync(`${index}.lock`), 'the lock is released');
  } finally { sb.done(); }
});
