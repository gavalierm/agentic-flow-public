#!/usr/bin/env node
// Project wizard script (skill workflow:project). Repositories live under the operator's GitHub account, or under
// another owner (--owner) where the operator is a collaborator.
//   project.mjs probe <stem> [--owner <account|org>] [--root <dir> ...] [--no-github] [--json]   find the project on disk and on GitHub (name match ignores case, spaces, dashes)
//   project.mjs restore <name> [--domain "<folder>"] [--root <dir>]   pull the repositories and brain when clean, attach the brain
//     (as brain-init.mjs --attach), regenerate settings, issue the mail key (as project.mjs mail; not possible: a line with the command)
//   project.mjs connect <name> [--owner <account|org>] [--repo <repo>] [--brain <repo>] [--rename-brain] [--adopt] [--brain-branch <b>] [--set-aside [<folder>,...]] [--domain "<folder>"] [--root <dir>]
//     --owner: the repositories of that account or organization the operator's token reaches (as a collaborator too); the
//     brain is the owner's <name>-brain when it has one, else one in the operator's account; the agent account gets push
//     access by an invitation only an owner or admin can give: otherwise a NOT line names the step, connect goes on
//   project.mjs create <name> [--repo <repo>] --purpose "<one sentence>" [--domain "<folder>"] [--root <dir>]
// Layout: ~/agentic/<Name>/<repo> (code repositories, each a T3 project) and ~/agentic/<Name>/<name>-brain;
// the project folder (domain) is the folder name the operator chose (--domain, spaces allowed), by default the project
// name with an upper case first letter; repositories stay lower case.
//   project.mjs root [<dir>]                                         show the projects root of this machine, or save it
//     (~/.config/agentic-flow/projects-root); the first explicit --root of restore, connect or create saves it too
//   project.mjs mail <dir>                                         sender key and <brain>/local/comms.json of a project
//     whose brain has no mail config (connect and create do it themselves)
//   project.mjs inventory <dir> [--json]                             files of a repository by group, with dead paths
//   project.mjs tidy --project <dir> --plan <file.json>              apply the agreed removals and moves in the brain
//   project.mjs wizard start <name> | end                           open (2 h) or close the window of the wizard (T3 setup left is named at the end)
//   project.mjs t3 <dir> [--name <project>] [--no-welcome] [--adopt] | t3 <dir> --registered   trust, T3 project and welcome thread of a
//     repository folder (restore, connect and create do it themselves; --no-t3 skips it); --registered: the steps left
//     for the T3 tools (no `t3` CLI) were done; --adopt (connect --adopt too): the welcome thread starts at `wizard end`
// Plan for tidy: { "remove": ["RULES.md", ...], "move": [{ "from": "artifacts/x", "to": "docs/x" }],
//   "write": [{ "path": "decisions/D0001.md", "file": "<file with the new content>" }], "reason": "..." }
// write: a record in the workflow format, e.g. an older decision rewritten (a decision with a key is never deleted,
// P-008; an older one without a key may be removed when its rewrite is written).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, toPosix, readJson, PLUGIN_ROOT } from '../scripts/util.mjs';
import { loadContext, loadPolicy, inSubagent, isWakeTurn, readThreadState, writeThreadState, WORKFLOW_CONFIG } from '../scripts/config.mjs';
import { setupT3, startWelcome, pendingT3Line } from '../scripts/t3-setup.mjs';
import { brainWrite, formatWriteResult } from '../scripts/brain.mjs';
import { setWizard } from '../scripts/wizard.mjs';
import { probe, restore, connect, create, issueMailKey, inventory, formatInventory, projectRoots, machineRoot, setMachineRoot, rootFile } from '../scripts/project.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, target] = args._;
// Roots: every --root, WORKFLOW_PROJECTS_ROOT, the saved root of this machine, ~/agentic when it exists, the root of the
// session project; new projects go to the first.
const session = (() => { try { const c = loadContext({ requireBrain: false }); return { projectDir: c.projectDir, brainDir: c.brainDir }; } catch { return {}; } })();
const explicit = process.argv.slice(2).flatMap((a, i, all) => (a === '--root' && all[i + 1] ? [all[i + 1]] : a.startsWith('--root=') ? [a.slice(7)] : []));
const roots = projectRoots({ explicit, ...session });
const root = roots[0];
const gh = { apiUrl: process.env.GITHUB_API_URL || undefined, tokenFile: args['token-file'] || undefined };
for (const k of Object.keys(gh)) if (gh[k] === undefined) delete gh[k];
const out = (s) => process.stdout.write(`${s}\n`);

/** The operator's choice of root is kept for this machine: the first explicit --root of a write is saved (carol 2026-11-09). */
function rememberRoot() {
  if (!explicit.length || machineRoot()) return [];
  try { return [`projects root ${setMachineRoot(explicit[0])} saved for this machine (${rootFile()}); change it with project.mjs root <dir>`]; } catch { return []; }
}

function guardWrite() {
  if (inSubagent()) fail('project changes are refused in a subagent (P-025)');
  const ctx = loadContext({ requireBrain: false });
  if (ctx.brainDir && ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('project changes are refused: this turn was started by a message, not the operator (P-047)');
}

function formatProbe(p) {
  const lines = [`branch: ${p.branch ?? 'unknown (nothing on disk, GitHub not reachable)'}`];
  lines.push(`disk (${p.roots.map(toPosix).join(', ')}):${p.local.length ? '' : ' nothing'}`);
  for (const l of p.local) lines.push(`- ${toPosix(l.dir)}: ${l.kind}${l.brain ? `, brain ${l.brain}` : ''}${l.remote ? `, origin ${l.remote}` : l.repo ? ', no origin' : ', not a repository'}`);
  if (p.githubError) lines.push(`github: ${p.githubError}${p.local.length ? ' (branch from disk; GitHub access is needed only for connect/create: ask for it then, not now)' : ''}`);
  else {
    lines.push(`github (${p.owner}):${p.github.length ? '' : ' nothing'}`);
    for (const r of p.github) lines.push(`- ${r.full}: ${r.kind}, ${r.private ? 'private' : 'public'}${r.archived ? ', archived' : ''}${r.access ? `, access ${r.access}` : ''}, default ${r.branch}, last push ${String(r.pushed || '-').slice(0, 10)}${r.description ? `, "${r.description}"` : ''}`);
  }
  return lines.join('\n');
}

/** Pending T3 steps per folder in the session thread state (null steps: done); the Stop hook and `wizard end` name them. */
function recordPending(update) {
  const ctx = loadContext({ requireBrain: false });
  if (!ctx.brainDir || !ctx.thread) return;
  const state = readThreadState(ctx.brainDir, ctx.thread);
  const next = { ...(state.t3_pending || {}) };
  for (const [dir, steps] of Object.entries(update)) { if (steps?.length) next[dir] = steps; else delete next[dir]; }
  if (Object.keys(next).length) state.t3_pending = next; else delete state.t3_pending;
  writeThreadState(ctx.brainDir, ctx.thread, state);
}

/** Composed policy of a project (D-0025: domain brain, then its project layer), else the policy of its brain. */
function policyOf(dir) {
  try { return loadContext({ project: dir, requireBrain: false }).policy; } catch { return loadPolicy(brainOf(dir)); }
}

function brainOf(dir) {
  const rel = readJson(path.join(dir, WORKFLOW_CONFIG), {})?.brain;
  return rel ? path.resolve(dir, rel) : null;
}

/** Trust, T3 project and welcome thread of each repository folder (the skill step agents skipped, 2026-11-08). */
// --adopt: the welcome thread waits for `wizard end` (welcome_deferred in the thread state); started with connect it
// proposed the adoption's own tidying while the adoption topic did it (alice 2026-11-11).
function t3Step(dirs, name) {
  if (args['no-t3']) return ['t3: skipped (--no-t3): trust, T3 project and welcome thread were not set up'];
  const lines = []; const update = {}; const deferred = {};
  for (const dir of dirs) {
    // wakeJob: the issue check job in this machine's wake.json (D-0024), idempotent for every project of the machine.
    let wakeJob = null;
    try { wakeJob = loadContext({ project: dir, requireBrain: false }); } catch { /* no context: no job line */ }
    const r = setupT3(dir, { name, policy: wakeJob?.policy || policyOf(dir), welcome: !args['no-welcome'], deferWelcome: !!args.adopt, wakeJob });
    lines.push(...r.lines.map((l) => `${path.basename(dir)}: ${l}`));
    update[dir] = r.pending;
    if (r.deferred) deferred[dir] = name;
  }
  recordPending(update);
  if (Object.keys(deferred).length) {
    const ctx = loadContext({ requireBrain: false });
    if (ctx.brainDir && ctx.thread) {
      const state = readThreadState(ctx.brainDir, ctx.thread);
      state.welcome_deferred = { ...(state.welcome_deferred || {}), ...deferred };
      writeThreadState(ctx.brainDir, ctx.thread, state);
    }
  }
  return lines;
}

/** Welcome threads of adopted projects, started at `wizard end`; one that cannot start is left for the T3 tools. */
function startDeferredWelcome(ctx) {
  const state = readThreadState(ctx.brainDir, ctx.thread);
  const deferred = state.welcome_deferred || {};
  if (!Object.keys(deferred).length) return [];
  delete state.welcome_deferred;
  writeThreadState(ctx.brainDir, ctx.thread, state);
  const lines = []; const update = {};
  for (const [dir, name] of Object.entries(deferred)) {
    const r = startWelcome(dir, { name, policy: policyOf(dir), adopted: true }); // wizard end needs the T3 project set up
    lines.push(...r.lines.map((l) => `${path.basename(dir)}: ${l}`));
    if (r.pending.length) update[dir] = r.pending;
  }
  if (Object.keys(update).length) recordPending(update);
  return lines;
}

const list = (lines) => lines.map((l) => `- ${l}`).join('\n');
const mailStep = (r) => [issueMailKey({ projectDir: r.projectDir, brainDir: r.brainDir, sessionBrain: session.brainDir })];
/** restore: the mail key of each separate brain, as `project.mjs mail`; one not set up is a line with the command for later. */
const restoreMail = (r) => r.brains.map(({ brainDir, projectDir }) => {
  let line;
  try { line = issueMailKey({ projectDir, brainDir, sessionBrain: session.brainDir }); } catch (err) { line = `mail: NOT set up (${err.message.split('\n')[0]})`; }
  const later = line.startsWith('mail: NOT') ? `; later, when mail runs: node ${toPosix(path.join(PLUGIN_ROOT, 'bin', 'project.mjs'))} mail ${toPosix(projectDir)}` : '';
  return `${path.basename(brainDir)}: ${line}${later}`;
});
/** --owner <account|org>: a value, never a bare flag. */
function ownerArg(usage) {
  if (args.owner === undefined) return null;
  if (typeof args.owner !== 'string') fail(`usage: ${usage} (--owner takes a GitHub account or organization)`);
  return args.owner;
}

try {
  if (cmd === 'probe') {
    if (!target) fail('usage: project.mjs probe <stem> [--owner <account|org>]');
    const p = await probe(target, { roots, github: !args['no-github'], owner: ownerArg('project.mjs probe <stem> --owner <account|org>'), ...gh });
    out(args.json ? JSON.stringify(p, null, 2) : formatProbe(p));
  } else if (cmd === 'restore') {
    if (!target) fail('usage: project.mjs restore <name>');
    guardWrite();
    const r = restore(target, { root, domain: typeof args.domain === 'string' ? args.domain : null });
    out(`restored ${r.projectDirs.join(', ')}\n${list([...r.lines, ...restoreMail(r), ...t3Step(r.projectDirs, target), ...rememberRoot()])}`);
  } else if (cmd === 'connect') {
    if (!target) fail('usage: project.mjs connect <name> [--owner <account|org>] [--repo <repo>] [--brain <repo>] [--rename-brain] [--adopt] [--brain-branch <b>] [--set-aside] [--domain "<folder>"]');
    guardWrite();
    const r = await connect({ project: target, owner: ownerArg('project.mjs connect <name> --owner <account|org>'), repo: args.repo || null, brain: args.brain || null, renameBrain: !!args['rename-brain'], adopt: !!args.adopt, brainBranch: args['brain-branch'] || null, setAside: typeof args['set-aside'] === 'string' ? args['set-aside'] : !!args['set-aside'], domain: typeof args.domain === 'string' ? args.domain : null, root, ...gh });
    out(`connected ${r.projectDir} (brain ${r.brainDir})\n${list([...r.lines, ...mailStep(r), ...t3Step([r.projectDir], target), ...rememberRoot()])}`);
  } else if (cmd === 'create') {
    if (!target) fail('usage: project.mjs create <name> [--repo <repo>] --purpose "<one sentence>"');
    guardWrite();
    const r = await create({ name: target, repo: args.repo || null, purpose: args.purpose, domain: typeof args.domain === 'string' ? args.domain : null, root, ...gh });
    out(`created ${r.projectDir} (brain ${r.brainDir})\n${list([...r.lines, ...mailStep(r), ...t3Step([r.projectDir], target), ...rememberRoot()])}`);
  } else if (cmd === 'root') {
    if (!target) {
      const saved = machineRoot();
      out(`projects root: ${root}${saved && path.resolve(saved) === path.resolve(root) ? ` (saved in ${rootFile()})` : saved ? ` (saved ${saved}, overridden by --root or WORKFLOW_PROJECTS_ROOT)` : ' (not saved for this machine: project.mjs root <dir>)'}`);
    } else {
      guardWrite();
      try { out(`projects root ${setMachineRoot(target)} saved for this machine (${rootFile()})`); } catch (err) { fail(err.message); }
    }
  } else if (cmd === 't3') {
    if (!target) fail('usage: project.mjs t3 <dir> [--name <project>] [--no-welcome] [--adopt] | t3 <dir> --registered');
    guardWrite();
    const dir = path.resolve(target);
    if (!fs.existsSync(path.join(dir, WORKFLOW_CONFIG))) fail(`${dir} is not a workflow project (no ${WORKFLOW_CONFIG})`);
    if (args.registered) { recordPending({ [dir]: null }); out(`t3: ${dir} recorded as set up in T3`); }
    else out(list(t3Step([dir], typeof args.name === 'string' ? args.name : path.basename(path.dirname(dir)))));
  } else if (cmd === 'mail') {
    if (!target) fail('usage: project.mjs mail <dir>');
    guardWrite();
    const dir = path.resolve(target);
    const brainDir = brainOf(dir);
    if (!brainDir) fail(`${dir} is not a workflow project (no ${WORKFLOW_CONFIG} with a brain)`);
    out(`- ${issueMailKey({ projectDir: dir, brainDir, sessionBrain: session.brainDir })}`);
  } else if (cmd === 'inventory') {
    if (!target) fail('usage: project.mjs inventory <dir>');
    const inv = inventory(path.resolve(target));
    out(args.json ? JSON.stringify(inv, null, 2) : formatInventory(inv));
  } else if (cmd === 'tidy') {
    if (!args.project || !args.plan) fail('usage: project.mjs tidy --project <dir> --plan <file.json>');
    guardWrite();
    const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
    const ctx = loadContext({ project: path.resolve(args.project) });
    const ops = [
      ...(plan.remove || []).map((p) => ({ path: p, remove: true })),
      ...(plan.move || []).map((m) => ({ from: m.from, to: m.to })),
      ...(plan.write || []).map((w) => ({ path: w.path, content: fs.readFileSync(path.resolve(path.dirname(args.plan), w.file), 'utf8') })),
    ];
    if (!ops.length) fail('plan has nothing to remove, move or write');
    if (!String(plan.reason || '').trim()) fail('plan needs "reason": what the operator agreed to');
    const res = brainWrite(ctx, { ops, message: `adopt: tidy the older setup (${String(plan.reason).slice(0, 80)})` });
    out(formatWriteResult(res, ops.map((o) => (o.from ? `${o.from} -> ${o.to}` : o.remove ? `-${o.path}` : o.path))));
  } else if (cmd === 'wizard') {
    guardWrite();
    const ctx = loadContext({ requireBrain: false });
    if (target === 'start') {
      const name = args._[2];
      if (!name) fail('usage: project.mjs wizard start <name>');
      const w = setWizard(ctx.brainDir, ctx.thread, name);
      out(`wizard open for ${name} until ${w.until}`);
    } else if (target === 'end') {
      const left = pendingT3Line(readThreadState(ctx.brainDir, ctx.thread).t3_pending);
      if (left) fail(`wizard not closed: ${left}`);
      setWizard(ctx.brainDir, ctx.thread, null);
      out(['wizard closed', ...startDeferredWelcome(ctx).map((l) => `- ${l}`)].join('\n'));
    } else fail('usage: project.mjs wizard start <name> | end');
  } else {
    fail('usage: project.mjs probe|restore|connect|create|t3|mail|inventory|tidy|wizard ... (see the header of bin/project.mjs)');
  }
} catch (err) {
  fail(err.message);
}
