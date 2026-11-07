#!/usr/bin/env node
// Skill health of this project (skill workflow:skill-check, operator 2026-11-07).
//   skill-check.mjs [<name>] [--json]          findings per skill; exit 1 when a skill has an error
//   skill-check.mjs diff <name> --file <new>   what an edit of the skill would change in meaning (cosmetic = none)
import fs from 'node:fs';
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { checkProject, formatFindings, projectSkills, meaningDiff } from '../scripts/skill-check.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(s + '\n');

try {
  const ctx = loadContext({ project: args.project });
  if (args._[0] === 'diff') {
    const name = args._[1];
    const skill = projectSkills(ctx).find((s) => s.name === name);
    if (!skill || !args.file) fail('usage: skill-check.mjs diff <name> --file <new SKILL.md>');
    const diff = meaningDiff(fs.readFileSync(skill.file, 'utf8'), fs.readFileSync(args.file, 'utf8'));
    out(diff.length ? `meaning changes (${diff.length}):\n${diff.map((d) => `  ${d}`).join('\n')}` : 'meaning kept (cosmetic)');
  } else {
    const only = args._[0] || null;
    const results = checkProject(ctx, only);
    if (only && !results.length) fail(`skill ${only} not found in this project`);
    if (args.json) out(JSON.stringify(results.map(({ name, owner, findings }) => ({ name, owner, findings })), null, 2));
    else {
      out(formatFindings(results));
      const bad = results.filter((r) => r.findings.length);
      out(`skills: ${results.length}, with findings: ${bad.length}, with errors: ${results.filter((r) => r.findings.some((f) => f.level === 'error')).length}`);
    }
    if (results.some((r) => r.findings.some((f) => f.level === 'error'))) process.exitCode = 1;
  }
} catch (err) {
  fail(err.message);
}
