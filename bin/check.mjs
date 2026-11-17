#!/usr/bin/env node
// check.mjs --loaded <sha> [--harness claude-code|codex]
// Suspected workflow malfunction: first update a release install to the newest release tag of its major version (a new
// major version is only announced, P-066), then compare the version
// loaded in this session (boot line `workflow <sha>`) with the installed plugin clone. Newer clone: print the current
// rules (they replace the loaded ones).
// Same version: the problem must be reported to the workflow maintainer.
import { parseArgs, fail, shortSha, git, PLUGIN_ROOT } from '../scripts/util.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { updateClone, pinClone, newerReleases, upgradeNote } from '../scripts/update.mjs';

const args = parseArgs(process.argv.slice(2));
// The version this session loaded comes from the thread state of its start (SessionStart, boot_plugin_sha), not from the
// agent: an agent that passed the sha installed meanwhile got "up to date" right after "updated" and told the operator
// nothing changed (operator 2026-11-17). --loaded is the fallback without a brain or a thread.
let boot = null;
try { const c = loadContext({ requireBrain: false }); if (c.brainDir && c.thread) { const st = readThreadState(c.brainDir, c.thread); if (st.boot_plugin_sha) boot = { sha: st.boot_plugin_sha, version: st.boot_plugin_version || null }; } } catch { /* no state: --loaded */ }
const loaded = boot?.sha || (typeof args.loaded === 'string' ? args.loaded.trim() : '');
if (!loaded) fail('usage: check.mjs --loaded <sha from the boot line "workflow <sha>">');
const vlabel = (version, sha) => (version ? `v${version} (${sha})` : sha);

const out = (s) => process.stdout.write(s + '\n');
// A brain pinned to a release (policy workflow_version, P-040) keeps every machine on it: no update past the pin.
let pin = null;
try { pin = loadContext({ requireBrain: false }).policy?.workflow_version || null; } catch { /* no context: newest release */ }
const up = pin ? pinClone(PLUGIN_ROOT, pin) : updateClone(PLUGIN_ROOT);
if (up.status === 'updated') out(`updated: workflow ${up.from} -> ${up.to}${pin ? ' (brain policy workflow_version)' : ''}`);
else if (up.status === 'current') out(pin && pin !== 'latest' && !/^v?\d+$/.test(String(pin)) ? `release ${up.to} is the version pinned by the brain policy (workflow_version)` : `release ${up.to} is the newest of its major version`);
else out(`not updated: ${up.reason}${up.status === 'failed' ? ' (report it with the output)' : ''}`);
// A fixed pin behind the newest release is no "up to date": the problem may be fixed in a release the pin holds back.
// A new major version is an upgrade: announced, never done here (D-0050, P-066).
const newer = up.status === 'updated' || up.status === 'current' ? newerReleases(PLUGIN_ROOT, up.to) : null;
const held = newer?.update || null;
if (held) out(`held back: the brain policy pins ${up.to}, the newest release of this major version is ${held}; tell the operator that the pin holds this machine back (every release of this major version from now on: brain.mjs pin latest; one release: brain.mjs pin ${held}) before reporting the problem`);
if (newer?.upgrade) out(`upgrade available: ${upgradeNote(up.to, newer.upgrade)}`);
const installed = shortSha(PLUGIN_ROOT);
const tag = git(['describe', '--tags', '--exact-match'], { cwd: PLUGIN_ROOT }).stdout || 'untagged';
// Updated in this run: the session runs the older version by definition, whatever --loaded says.
const same = up.status !== 'updated' && (installed.startsWith(loaded) || loaded.startsWith(installed));
out(`loaded: workflow ${boot ? vlabel(boot.version, loaded) : loaded}${boot ? ' (session start)' : ''}; installed: workflow ${installed} (${tag})`);
// One line the reply states first (operator 2026-11-17: "check always reports nothing to change, even when it updated").
const result = up.status === 'updated'
  ? `result: updated now: ${up.from} -> ${up.to}; tell the operator this first`
  : !same ? `result: updated during this session: ${boot ? vlabel(boot.version, loaded) : loaded} -> ${tag} (${installed}); tell the operator this first`
    : held ? `result: not updated: the brain pins ${up.to}, the newest is ${held}`
      : up.status === 'current' ? `result: no update: ${tag} is the newest release; the session runs it` : `result: not updated: ${up.reason}`;
if (same && held) {
  out(`pinned: the loaded workflow is the pinned ${up.to}, not the newest release ${held}; do not call it up to date; after the operator moves the pin, a new session (or /clear) loads it and the problem is checked again`);
} else if (same) {
  out('up to date: no newer workflow is installed; report the problem to the workflow maintainer (node <plugin>/bin/error.mjs report --title ... --text ...: mail, else an issue; only "reported: ..." means reported), with what you expected, what happened and the command');
} else {
  try {
    const ctx = loadContext({ requireBrain: false });
    const res = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: args.harness || 'claude-code', layers: ctx.layers });
    out('newer workflow installed: the rules below replace the rules loaded at session start; skills and hooks change only in a new session or after /clear (tell the operator)');
    out('');
    process.stdout.write(res.text.endsWith('\n') ? res.text : res.text + '\n');
  } catch (err) {
    fail(err.message);
  }
}
out(result);
