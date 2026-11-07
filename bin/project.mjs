#!/usr/bin/env node
// Project wizard script (skill workflow:project). Repositories live under the operator's GitHub account.
//   project.mjs probe <stem> [--root <dir> ...] [--no-github] [--json]   find the project on disk and on GitHub (name match ignores case, spaces, dashes)
//   project.mjs restore <name> [--root <dir>]                        pull the repositories and brain when clean, regenerate settings
//   project.mjs connect <name> [--repo <repo>] [--brain <repo>] [--rename-brain] [--adopt] [--brain-branch <b>] [--root <dir>]
//   project.mjs create <name> [--repo <repo>] --purpose "<one sentence>" [--root <dir>]
// Layout: ~/agentic/<name>/<repo> (code repositories, each a T3 project) and ~/agentic/<name>/<name>-brain.
//   project.mjs inventory <dir> [--json]                             files of a repository by group, with dead paths
//   project.mjs tidy --project <dir> --plan <file.json>              apply the agreed removals and moves in the brain
//   project.mjs wizard start <name> | end                           open (2 h) or close the window in which the wizard asks in a dialog
// Plan for tidy: { "remove": ["RULES.md", ...], "move": [{ "from": "artifacts/x", "to": "docs/x" }],
//   "write": [{ "path": "decisions/D0001.md", "file": "<file with the new content>" }], "reason": "..." }
// write: a record in the workflow format, e.g. an older decision rewritten (a decision with a key is never deleted,
// P-008; an older one without a key may be removed when its rewrite is written).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, toPosix } from '../scripts/util.mjs';
import { loadContext, inSubagent, isWakeTurn } from '../scripts/config.mjs';
import { brainWrite, formatWriteResult } from '../scripts/brain.mjs';
import { setWizard } from '../scripts/wizard.mjs';
import { probe, restore, connect, create, inventory, formatInventory, projectRoots } from '../scripts/project.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, target] = args._;
// Roots: every --root, WORKFLOW_PROJECTS_ROOT, ~/agentic when it exists, the root of the session project; new projects go to the first.
const session = (() => { try { const c = loadContext({ requireBrain: false }); return { projectDir: c.projectDir, brainDir: c.brainDir }; } catch { return {}; } })();
const explicit = process.argv.slice(2).flatMap((a, i, all) => (a === '--root' && all[i + 1] ? [all[i + 1]] : a.startsWith('--root=') ? [a.slice(7)] : []));
const roots = projectRoots({ explicit, ...session });
const root = roots[0];
const gh = { apiUrl: process.env.GITHUB_API_URL || undefined, tokenFile: args['token-file'] || undefined };
for (const k of Object.keys(gh)) if (gh[k] === undefined) delete gh[k];
const out = (s) => process.stdout.write(`${s}\n`);

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
    for (const r of p.github) lines.push(`- ${r.full}: ${r.kind}, ${r.private ? 'private' : 'public'}${r.archived ? ', archived' : ''}, default ${r.branch}, last push ${String(r.pushed || '-').slice(0, 10)}${r.description ? `, "${r.description}"` : ''}`);
  }
  return lines.join('\n');
}

try {
  if (cmd === 'probe') {
    if (!target) fail('usage: project.mjs probe <stem>');
    const p = await probe(target, { roots, github: !args['no-github'], ...gh });
    out(args.json ? JSON.stringify(p, null, 2) : formatProbe(p));
  } else if (cmd === 'restore') {
    if (!target) fail('usage: project.mjs restore <name>');
    guardWrite();
    const r = restore(target, { root });
    out(`restored ${r.projectDirs.join(', ')}\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
  } else if (cmd === 'connect') {
    if (!target) fail('usage: project.mjs connect <name> [--repo <repo>] [--brain <repo>] [--rename-brain] [--adopt] [--brain-branch <b>]');
    guardWrite();
    const r = await connect({ project: target, repo: args.repo || null, brain: args.brain || null, renameBrain: !!args['rename-brain'], adopt: !!args.adopt, brainBranch: args['brain-branch'] || null, root, ...gh });
    out(`connected ${r.projectDir} (brain ${r.brainDir})\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
  } else if (cmd === 'create') {
    if (!target) fail('usage: project.mjs create <name> [--repo <repo>] --purpose "<one sentence>"');
    guardWrite();
    const r = await create({ name: target, repo: args.repo || null, purpose: args.purpose, root, ...gh });
    out(`created ${r.projectDir} (brain ${r.brainDir})\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
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
      out(`wizard open for ${name} until ${w.until}: questions to the operator go in a dialog (AskUserQuestion)`);
    } else if (target === 'end') {
      setWizard(ctx.brainDir, ctx.thread, null);
      out('wizard closed: questions go as text under **Pre teba:** again (P-056)');
    } else fail('usage: project.mjs wizard start <name> | end');
  } else {
    fail('usage: project.mjs probe|restore|connect|create|inventory|tidy|wizard ... (see the header of bin/project.mjs)');
  }
} catch (err) {
  fail(err.message);
}
