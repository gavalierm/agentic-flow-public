// Update of an installed workflow clone to the newest release tag of its major version (skill check); a new major
// version is an upgrade, only by a deliberate pin (D-0050, P-066). Only a release install is switched:
// HEAD exactly on a tag `v*`, clean working tree. A dev clone (branch) or a dirty one is left alone and said so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './util.mjs';

const semver = (t) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(t) || []).slice(1).map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const major = (t) => semver(t)[0];
/** Major pin "1" / "v1": the newest release of that major version (deliberate upgrade, P-066). */
const majorPin = (v) => { const m = /^v?(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null; };
const releaseTags = (root) => git(['tag', '-l', 'v*'], { cwd: root }).stdout.split('\n').filter((t) => semver(t).length);
/** Newest of `tags` not older than `from` (null: any), optionally within major version `maj`. */
const newest = (tags, from, maj = null) => tags.filter((t) => maj === null || major(t) === maj).reduce((b, t) => (!b || newer(t, b) ? t : b), from);

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

/**
 * Value for `workflow_version`: "latest" (newest release of the installed major version), a major version "N" (newest
 * release of major N: the deliberate upgrade, P-066) or a release tag vX.Y.Z from PIN_MIN; otherwise { error }.
 */
export function pinValue(version, { min = PIN_MIN } = {}) {
  if (String(version) === 'latest') return { want: 'latest' };
  const maj = majorPin(version);
  if (maj !== null) {
    if (maj < major(min)) return { want: String(maj), error: `major ${maj} predates workflow_version (first in ${min}); pin ${major(min)} or newer` };
    return { want: String(maj) };
  }
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
  // "latest": every session start moves the machine to the newest release of origin within its major version (another
  // operator's machine follows each release without editing its pin, operator 2026-11-07; a new major version is an
  // upgrade, never automatic, D-0050 / P-066; a development branch never reaches it).
  if (String(version) === 'latest') return updateClone(root);
  const { want, error } = pinValue(version, { min });
  if (error) return { status: 'failed', to: want, reason: error };
  if (majorPin(want) !== null) return updateClone(root, { major: Number(want) });
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
 * Releases newer than the installed tag, else null: `update` (newest of the same major version; only a fixed pin holds it
 * back) and `upgrade` (newest of a higher major version: announced, never done automatically, D-0050 / P-066). Without
 * this the agent read "pinned and installed" as "up to date" while newer releases existed (operator 2026-11-08).
 */
export function newerReleases(root, tag) {
  const at = /^v/.test(String(tag)) ? String(tag) : `v${tag}`;
  if (!semver(at).length) return null;
  git(['fetch', '--tags', '--quiet', 'origin'], { cwd: root }); // offline: the tags known locally
  const tags = releaseTags(root);
  const update = newest(tags, at, major(at));
  const upgrade = newest(tags.filter((t) => major(t) > major(at)), null);
  const r = { update: update === at ? null : update, upgrade: upgrade || null };
  return r.update || r.upgrade ? r : null;
}

/** Announcement of a new major version: an upgrade the operator does deliberately, never the session start (P-066). */
export function upgradeNote(at, upgrade) {
  return `new major version ${upgrade} exists, this machine runs ${at}: an upgrade, not an update, never done automatically (tell the operator once; deliberate upgrade: brain.mjs pin ${major(upgrade)} --all, newest ${major(upgrade)}.x, or brain.mjs pin ${upgrade}) (P-066)`;
}

/**
 * -> { status: 'updated'|'current'|'skipped'|'failed', from, to, reason }. Newest release within the installed major
 * version, or within `major` (major pin: the deliberate upgrade); never across to another major version on its own.
 */
export function updateClone(root, { major: maj = null } = {}) {
  const inst = releaseInstall(root);
  if (!inst.tag) { const { dev, ...r } = inst; return r; }
  const cur = { stdout: inst.tag };
  const fetch = git(['fetch', '--tags', '--quiet', 'origin'], { cwd: root });
  if (!fetch.ok) return { status: 'failed', from: cur.stdout, reason: `git fetch: ${fetch.stderr.split('\n')[0]}` };
  const tags = releaseTags(root);
  const best = maj === null ? newest(tags, cur.stdout, major(cur.stdout)) : newest(tags, major(cur.stdout) === maj ? cur.stdout : null, maj);
  if (!best) return { status: 'failed', from: cur.stdout, to: String(maj), reason: `no release of major version ${maj} exists` };
  if (best === cur.stdout) return { status: 'current', from: cur.stdout, to: best };
  const co = git(['checkout', '--quiet', best], { cwd: root });
  if (!co.ok) return { status: 'failed', from: cur.stdout, to: best, reason: `git checkout: ${co.stderr.split('\n')[0]}` };
  return { status: 'updated', from: cur.stdout, to: best };
}
