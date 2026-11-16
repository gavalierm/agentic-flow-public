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
//
// Layout 2 -> 3 (flow v2, spec 11; scripts/migrate-3.mjs): the domain moves at once, the brain with every project repo
// of the domain folder that names it, one commit in each repository (nothing pushed); a repository in layout 1 moves to
// layout 2 first (above).
//   migrate.mjs <repo> --to 3 [--confirmed <tsv>] [--approve <tsv>] [--all] [--write-triage <tsv>]   preview of the domain
//   migrate.mjs <repo> --to 3 --apply --confirmed <tsv> [--approve <tsv>]   the move; refused while an item waits
//   migrate.mjs <repo> --to 3 --check [--fix]   the check of layout 3 in every repository of the domain; --fix
//                                                 regenerates a stale INDEX.md (a commit per repository)
//   migrate.mjs <repo> --to 3 --revert-list     the commits a return reverts (the move and every commit after it, 11.7)
// --confirmed: cesta <TAB> navrh <TAB> tema <TAB> dovod for every output (vystupy/<typ>/...) and source (zdroje/...) of the
// brain: navrh <repo>:vystupy/<typ>/ | <repo>:zdroje/<tema>/ | pomocne (removed); tema: topic: in the front matter of an
// output. A row for another item of the brain (temy/<id>/, .brain/skills/agentic/<name>/, .brain/rules/<file>) with
// <repo>:<path> moves it into that repository in layout 3 (a repo of the domain by name, else a path relative to the
// domain folder: the brain of a new domain, 11.12). --approve: cesta <TAB> zmazat | prepisat <TAB> <file>: a rule or skill
// naming P-050, P-055, P-064 or P-075 (a repo's as <repo>:<path>; a folder ends with /), or a fact about a person in
// memory people.mjs collect did not carry into osoby/.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, gitToplevel } from '../scripts/util.mjs';
import { dataLayoutVersion } from '../scripts/layout.mjs';
import { planMigration, formatPlan, readTriage, formatTriageTsv, applyMigration, checkMigration, contentProblems, formatCheck, fixIndex, fixDeployIgnores, fixCrossRefs, formatCrossFix, adapterCommand, FROM_VERSION, TO_VERSION, TRIAGE_HELP } from '../scripts/migrate.mjs';
import { formatDeployIgnores } from '../scripts/data-index.mjs';
import * as m3 from '../scripts/migrate-3.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(`${s}\n`);
// An unknown option ran the preview of the current folder's repository (`migrate.mjs --help`, 2026-11-14): --help prints
// the usage (the header of this file), an unknown option is refused; nothing else runs.
const OPTIONS = ['project', 'check', 'fix', 'apply', 'confirmed', 'triage', 'all', 'write-triage', 'to', 'approve', 'revert-list'];
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
  if (args.to !== undefined) {
    if (String(args.to) !== String(m3.TO)) fail(`--to ${args.to}: only --to ${m3.TO} (layout 2 -> 3); layout 1 -> 2 runs without --to`);
    if (args.triage) fail('--to 3 reads the triage from --confirmed (proposals: --write-triage); --triage refused');
    const brain = m3.domainOf(target).brain;
    if (dataLayoutVersion(brain) === 1 || version === 1) fail(`${version === 1 ? target : brain}: data layout 1; move it to layout 2 first: migrate.mjs ${version === 1 ? target : brain} --apply (then --to 3)`);
    if (args['revert-list']) { out(m3.formatRevert(m3.revertList(target))); process.exit(0); }
    if (args.check) {
      if (args.fix) for (const l of m3.fixIndexes(target)) out(l);
      const check = m3.checkDomain(target);
      out(m3.formatCheck(check));
      process.exit(check.ok ? 0 : 1);
    }
    if (args.apply) {
      const res = m3.applyDomain(target, { confirmedFile: file(args.confirmed, 'confirmed'), approveFile: file(args.approve, 'approve') });
      if (!res.ok) fail(`refused, nothing changed: ${res.error}`);
      if (res.nothing) { out(res.message); process.exit(0); }
      out(m3.formatPlan(res.plan));
      for (const c of res.commits) out(`committed ${c.name}: ${c.sha} (not pushed)`);
      for (const l of res.moved) out(`moved outside git (a revert does not move it back): ${l}`);
      if (res.pruned.length) out(`removed empty folders of layout 2: ${res.pruned.join(', ')}`);
      for (const a of res.adapters) out(`adapter ${a.name}: ${a.res.ok ? 'regenerated' : `failed: ${a.res.out}`}`);
      out(m3.formatCheck(res.check));
      out(`push after the check (spec 11.10: the clones of other machines pull before the threads start): ${res.commits.map((c) => `git -C ${c.dir} push`).join('; ')}`);
      out(`return before the threads start (spec 11.7): migrate.mjs ${target} --to 3 --revert-list`);
      process.exit(res.check.ok ? 0 : 1);
    }
    const plan = m3.planDomain(target, { confirmed: readTriage(file(args.confirmed, 'confirmed')), approve: m3.readApprove(file(args.approve, 'approve')) });
    out(m3.formatPlan(plan, { all: !!args.all }));
    if (plan.version === m3.FROM) {
      const problems = m3.contentProblems(plan);
      if (problems.length) out(`content checks of layout 3 refuse files the move writes (${problems.length}; --apply is refused until they are fixed):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    }
    if (typeof args['write-triage'] === 'string' && plan.version === m3.FROM) {
      const dest = path.resolve(args['write-triage']);
      if ([plan.dom.brain, ...plan.dom.repos].some((d) => dest.startsWith(path.resolve(d) + path.sep))) fail('--write-triage: write the triage file outside the repositories of the domain (the move needs clean trees)');
      fs.writeFileSync(dest, m3.formatTriageTsv(plan));
      out(`triage file: ${dest}`);
    }
    if (plan.version === m3.FROM) out(`preview only, nothing changed; the move: migrate.mjs ${target} --to 3 --apply --confirmed <tsv> [--approve <tsv>]`);
    process.exit(0);
  }
  if (version !== FROM_VERSION && version !== TO_VERSION) fail(`${target}: data layout ${version}; this tool moves only layout ${FROM_VERSION} to ${TO_VERSION}, refused${version === m3.TO ? ' (layout 2 -> 3 and its check: --to 3)' : ''}`);
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
