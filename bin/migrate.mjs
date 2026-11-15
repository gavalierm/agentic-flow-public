#!/usr/bin/env node
// Move of one repository (brain or project repo) from data layout 1 to layout 2 (D-0048, phase 3; scripts/migrate.mjs).
//   migrate.mjs [<repo>] [--triage <tsv>] [--all] [--write-triage <tsv>]   preview (default): nothing changes
//   migrate.mjs [<repo>] --apply [--confirmed <tsv> [--triage <tsv>]]  the move, one commit (git revert brings layout 1 back);
//                                                                         --triage alone is refused (proposals only)
//   migrate.mjs [<repo>] --check [--fix]                                  the check of a moved repository; --fix first
//                                                                         adds the internal entries a deploy ignore file misses
//                                                                         and regenerates a missing or stale INDEX.md (commits);
//                                                                         then rewrites the references of the other repos
//                                                                         of the domain to moved paths (a commit per repo)
// <repo>: the repository root (default with an option: the git root of the current folder; no argument at all prints this
// usage, the preview of the current folder is `migrate.mjs .`). --project <dir>: the session project whose
// brain consolidate report reads (default: the current folder). Triage TSV: cesta <TAB> navrh <TAB> tema <TAB> dovod; navrh
// is a class as at done --topic: `dokument` (vystupy/dokumenty/<name>), `zdroj` (zdroje/<tema>/), `stav` (temy/<tema>/, in
// a project repo of its brain, .workflow.json), `pomocne` (a tracked file git rm in the move commit; a file outside git
// deleted only from --confirmed, each one listed), `dokument@brain` / `zdroj@brain` (a project repo: into its brain);
// `ostava` stays; or a path under zdroje/, temy/, vystupy/. An invalid navrh stays with the valid ones listed. A file the
// brain already has on its target with the same content is removed from the project repo (duplicita brainu); another
// content stays with an error. --check (and the apply) reports a tracked file on the path of a folder of layout 2 (e.g. a
// file `vystupy`) and lists references in tracked md, json, html and txt files to paths the move changed (file:line,
// relative and absolute), without rewriting them.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, gitToplevel } from '../scripts/util.mjs';
import { dataLayoutVersion } from '../scripts/layout.mjs';
import { planMigration, formatPlan, readTriage, formatTriageTsv, applyMigration, checkMigration, contentProblems, formatCheck, fixIndex, fixDeployIgnores, fixCrossRefs, formatCrossFix, adapterCommand, FROM_VERSION, TO_VERSION, TRIAGE_HELP } from '../scripts/migrate.mjs';
import { formatDeployIgnores } from '../scripts/data-index.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(`${s}\n`);
// An unknown option ran the preview of the current folder's repository (`migrate.mjs --help`, 2026-11-14): --help prints
// the usage (the header of this file), an unknown option is refused; nothing else runs.
const OPTIONS = ['project', 'check', 'fix', 'apply', 'confirmed', 'triage', 'all', 'write-triage'];
// Without arguments or with --help: the usage, the triage TSV and the values of navrh (the agent looked for them in the
// source, 2026-11-14); the preview of the current folder is `migrate.mjs .`.
if (args.help || !process.argv.slice(2).length) {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
  out(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  out(`\n${TRIAGE_HELP}`);
  process.exit(0);
}
const unknown = Object.keys(args).filter((k) => k !== '_' && !OPTIONS.includes(k));
if (unknown.length) fail(`migrate.mjs: unknown option ${unknown.map((k) => `--${k}`).join(', ')}; nothing done (valid: ${OPTIONS.map((k) => `--${k}`).join(', ')}, --help)`);
const file = (v, name) => {
  if (v === undefined) return null;
  if (v === true || !fs.existsSync(v)) fail(`--${name}: file ${v === true ? '(missing)' : v} not found`);
  return path.resolve(v);
};

try {
  const target = args._[0] ? path.resolve(args._[0]) : gitToplevel(process.cwd()) || process.cwd();
  if (!fs.existsSync(path.join(target, '.git'))) fail(`${target}: not the root of a git repository`);
  const project = typeof args.project === 'string' ? path.resolve(args.project) : null;
  const version = dataLayoutVersion(target);
  if (version !== FROM_VERSION && version !== TO_VERSION) fail(`${target}: data layout ${version}; this tool moves only layout ${FROM_VERSION} to ${TO_VERSION}, refused`);
  if (args.check) {
    if (args.fix) {
      const ignores = fixDeployIgnores(target);
      if (ignores.sha) out(`${formatDeployIgnores(ignores.added)}, committed ${ignores.sha} (not pushed)`);
      const fixed = fixIndex(target);
      out(fixed.sha ? `INDEX.md: regenerated, committed ${fixed.sha} (not pushed)` : 'INDEX.md: current, nothing to fix');
      if (version === TO_VERSION) { const cross = formatCrossFix(fixCrossRefs(target)); if (cross) out(cross); }
    }
    const check = checkMigration(target, { project });
    out(formatCheck(check));
    if (!check.ok) process.exit(1);
  } else if (args.apply) {
    const res = applyMigration(target, { confirmedFile: file(args.confirmed, 'confirmed'), proposalsFile: file(args.triage, 'triage'), project });
    if (!res.ok) fail(`refused: ${res.error}`);
    if (res.nothing) { out(`${target}: ${res.message}`); process.exit(0); }
    out(formatPlan(res.plan));
    out(`committed: ${res.sha} (${res.plan.kind === 'brain' ? 'brain, pushed by the brain writer when origin exists' : 'project repo, not pushed'}); undo: WORKFLOW_BRAIN_SCRIPT=1 git -C ${target} revert ${res.sha}${adapterCommand(target) ? `, then ${adapterCommand(target)}` : ''}`);
    if (res.brainSha) out(`into brain ${res.plan.brainDir}: ${res.brainSha} (temy/ of the brain; undo: WORKFLOW_BRAIN_SCRIPT=1 git -C ${res.plan.brainDir} revert ${res.brainSha})`);
    if (res.note) out(`note: ${res.note}`);
    if (res.deployIgnores?.length) out(formatDeployIgnores(res.deployIgnores));
    if (res.outside.length) out(`moved outside git (not in the commit, a revert does not move them back): ${res.outside.map((m) => `${m.from} -> ${m.to}`).join(', ')}`);
    for (const f of res.deleted || []) out(`deleted (pomocne, outside git, confirmed; git does not restore it): ${f}`);
    if (res.pruned?.removed.length) out(`removed empty folders of layout ${FROM_VERSION}: ${res.pruned.removed.join(', ')}`);
    if (res.pruned?.ignored.length) out(`left in place (ignored by git, not removed): ${res.pruned.ignored.join(', ')}`);
    if (res.scratchLeft) out(`note: ${res.scratchLeft}`);
    if (res.adapter) out(`adapter: ${res.adapter.ok ? 'regenerated' : `failed: ${res.adapter.out}`}`);
    out(formatCheck(res.check));
    if (!res.check.ok) process.exit(1);
  } else {
    const proposals = readTriage(file(args.triage, 'triage'));
    const confirmed = args.confirmed ? readTriage(file(args.confirmed, 'confirmed')) : null;
    const plan = planMigration(target, { proposals, confirmed });
    out(formatPlan(plan, { all: !!args.all }));
    const problems = contentProblems(target, plan);
    if (problems.length) out(`content checks refuse files the move changes (${problems.length}; --apply is refused until they are fixed):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    if (typeof args['write-triage'] === 'string' && version === FROM_VERSION) {
      const dest = path.resolve(args['write-triage']);
      if (dest.startsWith(path.resolve(target) + path.sep)) fail(`--write-triage: write the triage file outside ${target} (the move needs a clean tree)`);
      fs.writeFileSync(dest, formatTriageTsv(plan));
      out(`triage file: ${dest}`);
    }
    if (version === FROM_VERSION) out(`preview only, nothing changed; the move: migrate.mjs ${target} --apply [--confirmed <tsv>]`);
  }
} catch (err) {
  fail(err.message);
}
