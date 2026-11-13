// 3c review H: a wake started with --config (COMMS_CONFIG) reads its jobs from that file's `wake.jobs` and ignores
// wake.json. Where the mail config of the project is such a file (no instance, no data dir, e.g. a remote url and a key,
// or a file with its own wake section), wake.json is not written; the line carries the job's JSON for that list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIssueWatchJob, issueWatchCommand, wakeFile } from '../scripts/wake-job.mjs';

const POLICY = { issue_watch: { interval_s: 900 } };
const JOB = () => ({ name: 'issue-watch', command: issueWatchCommand(), interval_ms: 900000 });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-wake-cfg-'));
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg'), COMMS_BASE_DIR: path.join(root, 'comms') };
  // A wake of instance default ran on this machine: without the config mode the job would go to its wake.json.
  const state = path.join(env.COMMS_BASE_DIR, 'default', 'client', 'wake', 'wake-state.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, '{}');
  const brain = path.join(root, 'brain');
  fs.mkdirSync(path.join(brain, 'local'), { recursive: true });
  const cfgFile = path.join(brain, 'local', 'comms.json');
  const ctx = { projectDir: path.join(root, 'project'), brainDir: brain, config: {}, policy: POLICY };
  const wakeJson = path.join(env.COMMS_BASE_DIR, 'default', 'wake.json');
  return { root, env, brain, cfgFile, ctx, wakeJson, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const jobOf = (line) => JSON.parse(line.slice(line.indexOf('{"name"')));

test('the brain\'s mail config is a url and a key: no wake.json, the line names the job for its wake.jobs', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.cfgFile, JSON.stringify({ url: 'http://127.0.0.1:9', key: 'k' }));
    const bytes = fs.readFileSync(sb.cfgFile, 'utf8');
    let r = ensureIssueWatchJob(sb.ctx, { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, false, r.line);
    assert.match(r.line, /^wake job issue-watch: the mail config is the file .*brain\/local\/comms\.json \(a wake started with --config reads its "wake": \{"jobs": \[\.\.\.\]\}, not wake\.json\): nothing written; add this job in that list and restart wake: /);
    assert.deepEqual(jobOf(r.line), JOB());
    assert.ok(!fs.existsSync(sb.wakeJson), 'no wake.json written');
    assert.equal(fs.readFileSync(sb.cfgFile, 'utf8'), bytes, 'the config file is not touched');
    // The job is in its wake.jobs: nothing to do.
    fs.writeFileSync(sb.cfgFile, JSON.stringify({ url: 'http://127.0.0.1:9', key: 'k', wake: { jobs: [JOB()] } }));
    r = ensureIssueWatchJob(sb.ctx, { env: sb.env, platform: 'linux' });
    assert.match(r.line, /^wake job issue-watch: already in .*comms\.json \(wake\.jobs\)$/);
    // An old job of that name whose script is gone: replace it there.
    fs.writeFileSync(sb.cfgFile, JSON.stringify({ url: 'http://127.0.0.1:9', key: 'k', wake: { jobs: [{ ...JOB(), command: issueWatchCommand(path.join(sb.root, 'gone')) }] } }));
    r = ensureIssueWatchJob(sb.ctx, { env: sb.env, platform: 'linux' });
    assert.match(r.line, /nothing written; replace the job of that name with this job in that list and restart wake: /);
    assert.ok(!fs.existsSync(sb.wakeJson));
  } finally { sb.done(); }
});

test('COMMS_CONFIG of the environment names the config file: no wake.json either', () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.root, 'remote.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:9', key: 'k' }));
    const ctx = { ...sb.ctx, brainDir: null };
    assert.equal(wakeFile(ctx, { ...sb.env, COMMS_CONFIG: file }).configFile, file);
    const r = ensureIssueWatchJob(ctx, { env: { ...sb.env, COMMS_CONFIG: file }, platform: 'linux' });
    assert.equal(r.changed, false, r.line);
    assert.match(r.line, /the mail config is the file .*remote\.json/);
    assert.deepEqual(jobOf(r.line), JOB());
    assert.ok(!fs.existsSync(sb.wakeJson));
  } finally { sb.done(); }
});

test('a config file naming its instance (the standard local/comms.json) still writes that instance\'s wake.json', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.cfgFile, JSON.stringify({ instance: 'default' }));
    assert.equal(wakeFile(sb.ctx, sb.env).configFile, null);
    const r = ensureIssueWatchJob(sb.ctx, { env: sb.env, platform: 'linux' });
    assert.equal(r.changed, true, r.line);
    assert.match(r.line, /added to .*comms\/default\/wake\.json/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sb.wakeJson, 'utf8')).jobs, [JOB()]);
    // The same file with its own wake section: that section is where the wake reads its jobs.
    fs.rmSync(sb.wakeJson);
    fs.writeFileSync(sb.cfgFile, JSON.stringify({ instance: 'default', wake: { jobs: [] } }));
    const c = ensureIssueWatchJob(sb.ctx, { env: sb.env, platform: 'linux' });
    assert.match(c.line, /the mail config is the file .*comms\.json/);
    assert.ok(!fs.existsSync(sb.wakeJson));
  } finally { sb.done(); }
});
