// Update of an installed workflow clone to the newest release tag (skill check). Only a release install is switched:
// HEAD exactly on a tag `v*`, clean working tree. A dev clone (branch) or a dirty one is left alone and said so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './util.mjs';

const semver = (t) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(t) || []).slice(1).map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** Release install on a clean tree: { tag } or a skipped result (a development or dirty clone is never switched). */
function releaseInstall(root) {
  if (git(['symbolic-ref', '-q', 'HEAD'], { cwd: root }).ok) return { status: 'skipped', dev: true, reason: 'the clone is on a branch (development clone)' };
  const cur = git(['describe', '--tags', '--exact-match', '--match', 'v*'], { cwd: root });
  if (!cur.ok || !semver(cur.stdout).length) return { status: 'skipped', reason: 'not a release install (HEAD is not on a release tag)' };
  if (git(['status', '--porcelain'], { cwd: root }).stdout) return { status: 'skipped', from: cur.stdout, reason: 'local changes in the clone' };
  return { tag: cur.stdout };
}

/** First release that reads `workflow_version`: an older one would ignore every later change of the pin. */
export const PIN_MIN = 'v0.9.11';

/** Value for `workflow_version`: "latest" or a release tag vX.Y.Z from PIN_MIN; otherwise { error }. */
export function pinValue(version, { min = PIN_MIN } = {}) {
  if (String(version) === 'latest') return { want: 'latest' };
  const want = /^v/.test(String(version)) ? String(version) : `v${version}`;
  if (!semver(want).length) return { want, error: `workflow_version "${version}" is not a release tag vX.Y.Z` };
  if (newer(min, want)) return { want, error: `${want} predates workflow_version (first in ${min}): that release would not follow a later change of the pin; pin ${min} or newer` };
  return { want };
}

/**
 * One install serves every project on the machine, the pin lives in each brain (issue flow-public#2).
 * `~/.config/agentic-flow/pin.json` records which brain set the clone and the pin each brain on this machine had last
 * time (null: no pin); `brain.mjs pin --all` uses the same list.
 */
export function pinFile(env = process.env) {
  return env.WORKFLOW_PIN_FILE || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', 'pin.json');
}

export function readPins(env = process.env) {
  try { return JSON.parse(fs.readFileSync(pinFile(env), 'utf8')) || {}; } catch { return {}; }
}

/** Brains this machine has started a session in (from the pin record), existing ones only. */
export function knownBrains(env = process.env) {
  return Object.keys(readPins(env).brains || {}).filter((b) => fs.existsSync(path.join(b, '.git')));
}

/** Brain policy `workflow_version` (P-040): every machine of the brain runs that release, newer or older (from PIN_MIN). */
export function pinClone(root, version, { min = PIN_MIN } = {}) {
  // "latest": every session start moves the machine to the newest release of origin (another operator's machine
  // follows each release without editing its pin; a development branch never reaches it). Operator 2026-11-07.
  if (String(version) === 'latest') return updateClone(root);
  const { want, error } = pinValue(version, { min });
  if (error) return { status: 'failed', to: want, reason: error };
  const inst = releaseInstall(root);
  if (!inst.tag) return { ...inst, to: want };
  if (inst.tag === want) return { status: 'current', from: inst.tag, to: want };
  const has = () => git(['rev-parse', '--verify', '--quiet', `refs/tags/${want}`], { cwd: root }).ok;
  if (!has()) {
    const fetch = git(['fetch', '--tags', '--quiet', 'origin'], { cwd: root });
    if (!fetch.ok) return { status: 'failed', from: inst.tag, to: want, reason: `git fetch: ${fetch.stderr.split('\n')[0]}` };
    if (!has()) return { status: 'failed', from: inst.tag, to: want, reason: `release ${want} does not exist` };
  }
  const co = git(['checkout', '--quiet', want], { cwd: root });
  if (!co.ok) return { status: 'failed', from: inst.tag, to: want, reason: `git checkout: ${co.stderr.split('\n')[0]}` };
  return { status: 'updated', from: inst.tag, to: want };
}

/**
 * The newest release of origin when it is newer than a fixed pin, else null. A pin to a release keeps the machine there;
 * without this the agent read "pinned and installed" as "up to date" while newer releases existed (operator 2026-11-08).
 */
export function newerThanPin(root, pin) {
  if (!pin || String(pin) === 'latest') return null;
  const want = /^v/.test(String(pin)) ? String(pin) : `v${pin}`;
  if (!semver(want).length) return null;
  git(['fetch', '--tags', '--quiet', 'origin'], { cwd: root }); // offline: the tags known locally
  const tags = git(['tag', '-l', 'v*'], { cwd: root }).stdout.split('\n').filter((t) => semver(t).length);
  const best = tags.reduce((b, t) => (newer(t, b) ? t : b), want);
  return best === want ? null : best;
}

/** -> { status: 'updated'|'current'|'skipped'|'failed', from, to, reason } */
export function updateClone(root) {
  const inst = releaseInstall(root);
  if (!inst.tag) { const { dev, ...r } = inst; return r; }
  const cur = { stdout: inst.tag };
  const fetch = git(['fetch', '--tags', '--quiet', 'origin'], { cwd: root });
  if (!fetch.ok) return { status: 'failed', from: cur.stdout, reason: `git fetch: ${fetch.stderr.split('\n')[0]}` };
  const tags = git(['tag', '-l', 'v*'], { cwd: root }).stdout.split('\n').filter((t) => semver(t).length);
  const best = tags.reduce((b, t) => (newer(t, b) ? t : b), cur.stdout);
  if (best === cur.stdout) return { status: 'current', from: cur.stdout, to: best };
  const co = git(['checkout', '--quiet', best], { cwd: root });
  if (!co.ok) return { status: 'failed', from: cur.stdout, to: best, reason: `git checkout: ${co.stderr.split('\n')[0]}` };
  return { status: 'updated', from: cur.stdout, to: best };
}
