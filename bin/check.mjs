#!/usr/bin/env node
// check.mjs --loaded <sha> [--harness claude-code|codex]
// Suspected workflow malfunction: first update a release install to the newest release tag, then compare the version
// loaded in this session (boot line `workflow <sha>`) with the installed plugin clone. Newer clone: print the current
// rules (they replace the loaded ones).
// Same version: the problem must be reported to the workflow maintainer.
import { parseArgs, fail, shortSha, git, PLUGIN_ROOT } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { updateClone, pinClone, newerThanPin } from '../scripts/update.mjs';

const args = parseArgs(process.argv.slice(2));
const loaded = typeof args.loaded === 'string' ? args.loaded.trim() : '';
if (!loaded) fail('usage: check.mjs --loaded <sha from the boot line "workflow <sha>">');

const out = (s) => process.stdout.write(s + '\n');
// A brain pinned to a release (policy workflow_version, P-040) keeps every machine on it: no update past the pin.
let pin = null;
try { pin = loadContext({ requireBrain: false }).policy?.workflow_version || null; } catch { /* no context: newest release */ }
const up = pin ? pinClone(PLUGIN_ROOT, pin) : updateClone(PLUGIN_ROOT);
if (up.status === 'updated') out(`updated: workflow ${up.from} -> ${up.to}${pin ? ' (brain policy workflow_version)' : ''}`);
else if (up.status === 'current') out(pin && pin !== 'latest' ? `release ${up.to} is the version pinned by the brain policy (workflow_version)` : `release ${up.to} is the newest`);
else out(`not updated: ${up.reason}${up.status === 'failed' ? ' (report it with the output)' : ''}`);
// A fixed pin behind the newest release is no "up to date": the problem may be fixed in a release the pin holds back.
const held = up.status === 'updated' || up.status === 'current' ? newerThanPin(PLUGIN_ROOT, pin) : null;
if (held) out(`held back: the brain policy pins ${up.to}, the newest release is ${held}; tell the operator that the pin holds this machine back (every release from now on: brain.mjs pin latest; one release: brain.mjs pin ${held}) before reporting the problem`);
const installed = shortSha(PLUGIN_ROOT);
const tag = git(['describe', '--tags', '--exact-match'], { cwd: PLUGIN_ROOT }).stdout || 'untagged';
const same = installed.startsWith(loaded) || loaded.startsWith(installed);
out(`loaded: workflow ${loaded}; installed: workflow ${installed} (${tag})`);
if (same && held) {
  out(`pinned: the loaded workflow is the pinned ${up.to}, not the newest release ${held}; do not call it up to date; after the operator moves the pin, a new session (or /clear) loads it and the problem is checked again`);
} else if (same) {
  out('up to date: no newer workflow is installed; report the problem to the workflow maintainer (node <plugin>/bin/error.mjs report --title ... --text ...: mail, else an issue; only "reported: ..." means reported), with what you expected, what happened and the command');
} else {
  try {
    const ctx = loadContext({ requireBrain: false });
    const res = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: args.harness || 'claude-code' });
    out('newer workflow installed: the rules below replace the rules loaded at session start; skills and hooks change only in a new session or after /clear (tell the operator)');
    out('');
    process.stdout.write(res.text.endsWith('\n') ? res.text : res.text + '\n');
  } catch (err) {
    fail(err.message);
  }
}
