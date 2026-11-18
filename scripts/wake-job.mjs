// Job `issue-watch` in the wake configuration of this machine (D-0024): the reporter's issue check runs from the wake
// module of the mail (`<data-dir>/wake.json`, key `jobs`), written by the installation (adapter.mjs claude-code,
// project.mjs t3), never by hand. One job checks all projects of the machine (index of brains, issue-watch.mjs).
// Nothing is written where wake is not installed: the file is only read by a running wake. A wake started with --config
// (COMMS_CONFIG) reads the jobs from that file's `wake.jobs` and ignores wake.json: where the mail config of this
// project is such a file (no instance, no data dir), nothing is written and the line names the job to add there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commsSettings, machineMailFile } from './comms.mjs';
import { JOB_NAME } from './issue-watch.mjs';
import { overviewIntervalMs } from './overview.mjs';
import { PLUGIN_ROOT, readJson, toPosix } from './util.mjs';
import { machineName } from './config.mjs';

const DEFAULT_INTERVAL_S = 900;

/** Base dir of the mail instances, as the mail client resolves it (agentic-comms src/common/paths.mjs). */
function commsBaseDir(env, platform = process.platform) {
  if (env.COMMS_BASE_DIR) return env.COMMS_BASE_DIR;
  const home = env.HOME || os.homedir();
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'comms');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'comms');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'comms');
}

/**
 * wake.json of the instance this project's mail client uses: instance from workflow.json comms.instance, else
 * COMMS_INSTANCE, else the comms config file; data dir from COMMS_DATA_DIR, else the config file, else <base>/<instance>.
 * `WORKFLOW_WAKE_FILE` names the file directly (tests).
 */
export function wakeFile(ctx, env = process.env) {
  if (env.WORKFLOW_WAKE_FILE) return { file: env.WORKFLOW_WAKE_FILE, instance: null, configFile: null };
  const s = commsSettings(ctx);
  // The mail config file the client gets: the project's (--config), else COMMS_CONFIG of the environment.
  const cfgPath = s.configFile || (env.COMMS_CONFIG ? path.resolve(env.COMMS_CONFIG) : null);
  const cfg = cfgPath ? readJson(cfgPath, {}) || {} : {};
  const named = s.instance || env.COMMS_INSTANCE || cfg.instance;
  const dataDirSet = env.COMMS_DATA_DIR || cfg.data_dir;
  const instance = named || 'default';
  const dataDir = dataDirSet || path.join(commsBaseDir(env), instance);
  // Config mode: the file names no instance and no data dir (a remote url and a key), or holds a wake section itself;
  // a wake for it runs with --config and reads its `wake.jobs`, never wake.json.
  const configMode = !!cfgPath && fs.existsSync(cfgPath) && ((!named && !dataDirSet) || (cfg.wake && typeof cfg.wake === 'object'));
  return { file: path.join(path.resolve(dataDir), 'wake.json'), instance, configFile: configMode ? cfgPath : null, config: configMode ? cfg : null };
}

/** Script path of a job command (`"<node>" "<script>"` or plain words): the first word ending .mjs/.js, else the second. */
export function jobScript(command) {
  const words = [...String(command || '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return words.find((w) => /\.(m|c)?js$/.test(w)) || words[1] || null;
}

/**
 * What to do with job `job` among `jobs`: 'add', 'same' (equal), 'kept' (another job of that name whose script exists:
 * another plugin clone of this machine installed it; left as it is, interval too), 'update' (its script is gone).
 */
function jobPlan(jobs, job) {
  const i = jobs.findIndex((j) => j && j.name === job.name);
  if (i === -1) return { i, what: 'add' };
  const cur = jobs[i];
  if (cur.command === job.command && cur.interval_ms === job.interval_ms) return { i, what: 'same' };
  const script = jobScript(cur.command);
  if (script && path.isAbsolute(script) && fs.existsSync(script)) return { i, what: 'kept', script, cur };
  return { i, what: 'update' };
}

/** Wake runs (or ran) for this instance: its wake.json, its state file, or its systemd unit / LaunchAgent. */
function wakeInstalled(file, instance, env, platform = process.platform) {
  const dir = path.dirname(file);
  if (fs.existsSync(file) || fs.existsSync(path.join(dir, 'client', 'wake', 'wake-state.json'))) return true;
  if (!instance || env.WORKFLOW_WAKE_FILE) return false;
  const home = env.HOME || os.homedir();
  if (platform === 'linux') return fs.existsSync(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `agentic-wake-${instance}.service`));
  if (platform === 'darwin') return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `com.agentic-comms.wake.${instance}.plist`));
  return false;
}

export function issueWatchCommand(pluginRoot = PLUGIN_ROOT) {
  return `"${toPosix(process.execPath)}" "${toPosix(path.join(pluginRoot, 'bin', 'issue-watch.mjs'))}"`;
}

/**
 * Merge job `issue-watch` into wake.json by name: other keys (keepalive) and other jobs stay, an equal job is left
 * alone, a job of that name whose script exists is kept as it is (line `kept`); only a job whose script is gone is
 * replaced. A mail config file without instance and data dir: nothing written, the line carries the job's JSON for its
 * `wake.jobs`. Returns { changed, line }; line says what happened, also "wake not installed" (nothing written).
 */
export function ensureIssueWatchJob(ctx, { env = process.env, pluginRoot = PLUGIN_ROOT, platform = process.platform } = {}) {
  const intervalS = Number(ctx.policy?.issue_watch?.interval_s) || DEFAULT_INTERVAL_S;
  return ensureJob(ctx, { name: JOB_NAME, command: issueWatchCommand(pluginRoot), interval_ms: intervalS * 1000 }, { env, platform });
}

/** Job `timer-check` (bin/timer-check.mjs): conditional thread timers checked before their ring, every policy
 * timer.check_interval_s (default 60 s, below the lead of the check: scripts/waker.mjs TIMER_CHECK_LEAD_MS). */
export const TIMER_CHECK_JOB = 'timer-check';
export function ensureTimerCheckJob(ctx, { env = process.env, pluginRoot = PLUGIN_ROOT, platform = process.platform } = {}) {
  const intervalS = Number(ctx.policy?.timer?.check_interval_s) || 60;
  const command = `"${toPosix(process.execPath)}" "${toPosix(path.join(pluginRoot, 'bin', 'timer-check.mjs'))}"`;
  return ensureJob(ctx, { name: TIMER_CHECK_JOB, command, interval_ms: intervalS * 1000 }, { env, platform });
}

/** Job `overview` (bin/overview.mjs wake, flow v2 spec 3.9, plan B6): the supervisor's overview without an agent, every
 * policy overview.interval_min (default 30 min); it mails the supervisor only when a finding is new. One job for the
 * machine: the project that installs it first sends the mail (its key), another clone's job of that name stays. */
export const OVERVIEW_JOB = 'overview';
export function ensureOverviewJob(ctx, { env = process.env, pluginRoot = PLUGIN_ROOT, platform = process.platform } = {}) {
  const command = `"${toPosix(process.execPath)}" "${toPosix(path.join(pluginRoot, 'bin', 'overview.mjs'))}" wake --project "${toPosix(ctx.projectDir)}"`;
  return ensureJob(ctx, { name: OVERVIEW_JOB, command, interval_ms: overviewIntervalMs(ctx.policy) }, { env, platform });
}

/** Machine name as the mail normalizes it (agentic-comms normalizeMachine): wake.json `machine` is compared in this form. */
export const mailMachine = (name) => (name == null || name === '' ? null : String(name).trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || null);

/**
 * Mail model 3: the wake of this machine has the machine of the workflow (machineName(), the one source; the client gets
 * it as COMMS_MACHINE), so the topic records, the turns and the wake name the same machine. Null: `machine` is right.
 */
function wakeMachineFix(wake, env) {
  const want = machineName(env);
  return mailMachine(wake?.machine) === mailMachine(want) ? null : want;
}

/** Merge `job` into the wake configuration of this machine (see ensureIssueWatchJob); it also sets `machine` (model 3). */
export function ensureJob(ctx, job, { env = process.env, platform = process.platform } = {}) {
  const { file, instance, configFile, config } = wakeFile(ctx, env);
  const home = toPosix(env.HOME || os.homedir());
  const shown = toPosix(file).replace(home, '~');
  const intervalS = Math.round(job.interval_ms / 1000);
  if (configFile) {
    // The wake of this mail config reads the jobs from this file; it is the operator's (key, url): never written here.
    const cfgShown = toPosix(configFile).replace(home, '~');
    const p = jobPlan(Array.isArray(config?.wake?.jobs) ? config.wake.jobs : [], job);
    const own = path.resolve(configFile) === path.resolve(machineMailFile(env));
    const machine = own ? wakeMachineFix(config?.wake, env) : null;
    if (p.what === 'same' && !machine) return { changed: false, line: `wake job ${job.name}: already in ${cfgShown} (wake.jobs)` };
    if (p.what === 'kept' && !machine) return { changed: false, line: `wake job ${job.name}: kept in ${cfgShown} (wake.jobs; its script ${toPosix(p.script).replace(home, '~')} exists)` };
    // The machine config is the workflow's own file (project.mjs mail-machine): its wake.jobs are written here, one job
    // per name for the machine (doma-pc 2026-11-18: written by hand, and overview-<project> per project collided).
    if (own) {
      const wake = config?.wake && typeof config.wake === 'object' ? config.wake : {};
      const jobs = Array.isArray(wake.jobs) ? wake.jobs : [];
      const merged = p.what === 'same' || p.what === 'kept' ? jobs : p.i === -1 ? [...jobs, job] : jobs.map((j, k) => (k === p.i ? { ...j, ...job } : j));
      const next = { ...config, wake: { ...wake, ...(machine ? { machine } : {}), jobs: merged } };
      const tmp = `${configFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
      fs.renameSync(tmp, configFile);
      const what = p.what === 'same' || p.what === 'kept' ? `machine ${machine} set in` : `${p.i === -1 ? 'added to' : 'updated in'}`;
      return { changed: true, line: `wake job ${job.name}: ${what} ${cfgShown} (wake.jobs, every ${intervalS} s${machine ? `; wake.machine ${machine}` : ''}); the wake reads the jobs at its start: restart it (wake.mjs install --config ${cfgShown})` };
    }
    return { changed: false, line: `wake job ${job.name}: the mail config is the file ${cfgShown} (a wake started with --config reads its "wake": {"jobs": [...]}, not wake.json): nothing written; ${p.what === 'add' ? 'add' : 'replace the job of that name with'} this job in that list and restart wake: ${JSON.stringify(job)}` };
  }
  if (!wakeInstalled(file, instance, env, platform)) return { changed: false, line: `wake job ${job.name}: wake not installed on this machine (${shown} missing), nothing written; after comms wake install run this again` };
  let data = {};
  if (fs.existsSync(file)) {
    data = readJson(file, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { changed: false, line: `wake job ${job.name}: ${shown} is not a JSON object, left as it is; fix it and run this again` };
  }
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const { i, what, script, cur } = jobPlan(jobs, job);
  const machine = wakeMachineFix(data, env);
  if (what === 'same' && !machine) return { changed: false, line: `wake job ${job.name}: already in ${shown}` };
  // Another plugin clone of this machine (stable, a dev clone) put its job there: one job checks all projects, so it stays.
  if (what === 'kept' && !machine) return { changed: false, line: `wake job ${job.name}: kept in ${shown} (its script ${toPosix(script).replace(home, '~')} exists; every ${Math.round(Number(cur.interval_ms) / 1000) || '?'} s)` };
  const merged = what === 'same' || what === 'kept' ? jobs : i === -1 ? [...jobs, job] : jobs.map((j, k) => (k === i ? { ...j, ...job } : j));
  const next = { ...data, ...(machine ? { machine } : {}), jobs: merged };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // The rename puts a new file in place: keep the permission bits of the old one (the instance's wake.json is 0600),
  // a new file is 0600 too; without this the umask default (0644) replaced 0600 on the first write.
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  const done = what === 'same' || what === 'kept' ? `machine ${machine} set in` : i === -1 ? 'added to' : 'updated in';
  return { changed: true, line: `wake job ${job.name}: ${done} ${shown} (every ${intervalS} s${machine ? `; machine ${machine}` : ''}; wake restarts on the change)` };
}
