#!/usr/bin/env node
// Single writer CLI for brain (P-040).
//   brain.mjs write <path> --message "..." (--content "..." | --file <src> | --stdin)
//   brain.mjs remove <path> --message "..."
//   brain.mjs sync | status
//   brain.mjs pin <vX.Y.Z|latest> [--all]   set policy workflow_version (one install per machine: --all pins every brain it knows)
//   brain.mjs resolve <file> --keep local|remote   settle a disagreement on one file (this machine's version or origin's)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readStdin, fail } from '../scripts/util.mjs';
import { loadContext, loadPolicy, foreignProjectCwd } from '../scripts/config.mjs';
import { pinValue, knownBrains } from '../scripts/update.mjs';
import { brainWrite, brainSync, unpushedCount, formatWriteResult, conflictText } from '../scripts/brain.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, target] = args._;

try {
  const ctx = loadContext({ project: args.project });
  // write and remove from another project's dir or brain would land in the session's brain (exported WORKFLOW_PROJECT_DIR).
  const foreign = (cmd === 'write' || cmd === 'remove') ? foreignProjectCwd(ctx, args.project) : null;
  if (foreign) fail(foreign);
  if (cmd === 'write') {
    if (!target) fail('usage: brain.mjs write <path> --message "..." --content "..."');
    let content = args.content;
    if (args.file) content = fs.readFileSync(args.file, 'utf8');
    if (args.stdin) content = readStdin();
    if (content === undefined || content === true) fail('content required (--content, --file or --stdin)');
    const res = brainWrite(ctx, { ops: [{ path: target, content: String(content) }], message: args.message, internal: !!args.internal && process.env.WORKFLOW_INTERNAL === '1' });
    process.stdout.write(formatWriteResult(res, [target]) + '\n');
  } else if (cmd === 'remove') {
    if (!target) fail('usage: brain.mjs remove <path> --message "..."');
    const res = brainWrite(ctx, { ops: [{ path: target, remove: true }], message: args.message });
    process.stdout.write(formatWriteResult(res, [target]) + '\n');
  } else if (cmd === 'sync' || cmd === 'resolve') {
    // Sides chosen for several files are kept until the sync goes through (one resolve per file, any order).
    const store = path.join(ctx.brainDir, 'local', 'resolutions.json');
    let resolutions = {};
    if (cmd === 'resolve') {
      if (!target || !['local', 'remote'].includes(args.keep)) fail('usage: brain.mjs resolve <file> --keep local|remote');
      try { resolutions = JSON.parse(fs.readFileSync(store, 'utf8')); } catch { resolutions = {}; }
      resolutions[target.replace(/^\.\//, '')] = args.keep;
    }
    const res = brainSync(ctx.brainDir, { resolutions });
    for (const n of res.notices || []) process.stdout.write(`${n}\n`);
    if (cmd === 'resolve') {
      if (res.conflict) { fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, JSON.stringify(resolutions, null, 2) + '\n'); }
      else fs.rmSync(store, { force: true });
    }
    if (res.conflict) fail(`${conflictText(res.conflict)}${cmd === 'resolve' ? ` (chosen so far: ${Object.entries(resolutions).map(([f, k]) => `${f} ${k}`).join(', ')})` : ''}`);
    process.stdout.write(`${res.pushed ? 'pushed' : 'not pushed'}; unpushed: ${res.unpushed}${res.error ? ` (${res.error})` : ''}\n`);
  } else if (cmd === 'pin') {
    // flow-public#7: a hand edit of policy.json is refused by the brain pre-commit (P-040) and, left uncommitted,
    // blocks the brain update from origin. The pin goes through the brain writer, in every brain of this machine with --all.
    const version = target ?? (typeof args.all === 'string' ? args.all : undefined); // `pin --all v1.2.3`
    const { want, error } = pinValue(version ?? '');
    if (!version || error) fail(error && version ? error : 'usage: brain.mjs pin <vX.Y.Z|latest> [--all]');
    const real = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const brains = [...new Set([ctx.brainDir, ...(args.all ? knownBrains() : [])].filter(Boolean).map(real))];
    if (!brains.length) fail('brain unavailable');
    let failed = 0;
    for (const brainDir of brains) {
      const file = path.join(brainDir, 'policy.json');
      let policy = {};
      try { if (fs.existsSync(file)) policy = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
      catch (err) { failed++; process.stdout.write(`${brainDir}: policy.json is not valid JSON (${err.message}); fix it first\n`); continue; }
      try {
        const res = brainWrite({ brainDir, thread: ctx.thread, policy: loadPolicy(brainDir) }, {
          ops: [{ path: 'policy.json', content: `${JSON.stringify({ ...policy, workflow_version: want }, null, 2)}\n` }],
          message: `pin workflow ${want}`,
        });
        process.stdout.write(`${brainDir}: ${formatWriteResult(res, ['policy.json'])}\n`);
      } catch (err) { failed++; process.stdout.write(`${brainDir}: ${err.message}\n`); }
    }
    process.stdout.write(`workflow_version ${want}: the install switches at the next session start (or /clear)${args.all ? '' : '; other brains on this machine: brain.mjs pin --all'}\n`);
    if (failed) process.exit(1);
  } else if (cmd === 'status') {
    process.stdout.write(`brain ${ctx.brainDir}\nunpushed: ${unpushedCount(ctx.brainDir)}\n`);
  } else {
    fail('usage: brain.mjs write|remove|sync|resolve|pin|status');
  }
} catch (err) {
  fail(err.message);
}
