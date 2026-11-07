#!/usr/bin/env node
// Support script for skill consolidate (P-010, P-003, P-009): deterministic report of limits, stale derived records,
// duplicate subjects and mergeable agentic skills. The subagent reviews, the main agent writes via save.
//   consolidate.mjs report [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { readMemory, readSkills } from '../scripts/records.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { tokens } from '../scripts/keys.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { checkProject } from '../scripts/skill-check.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(s + '\n');

function fingerprint(projectDir, sources) {
  const h = createHash('sha1');
  for (const s of sources) {
    const file = path.resolve(projectDir, s);
    h.update(s + '\n');
    h.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('missing'));
  }
  return h.digest('hex').slice(0, 12);
}

export function report(ctx) {
  const idx = buildIndexes(ctx.brainDir, ctx.policy);
  const memory = readMemory(ctx.brainDir);
  const stale = memory.filter((r) => r.origin === 'derived' && r.data.fingerprint && fingerprint(ctx.projectDir, r.data.sources || []) !== r.data.fingerprint).map((r) => r.path);
  const groups = new Map();
  for (const r of memory) {
    for (const t of tokens(String(r.key).replace(/^[a-z]+-/, ''))) {
      const g = `${r.type || r.key.split('-')[0]}:${t}`;
      groups.set(g, [...(groups.get(g) || []), r.path]);
    }
  }
  const duplicates = [...groups.entries()].filter(([, v]) => new Set(v).size > 1).map(([g, v]) => ({ token: g, paths: [...new Set(v)] }));
  const agentic = readSkills(ctx.brainDir).filter((s) => s.owner === 'agentic');
  const skillGroups = new Map();
  for (const s of agentic) {
    for (const t of tokens(`${s.skillName} ${s.description}`).filter((t) => t.length > 3)) skillGroups.set(t, [...(skillGroups.get(t) || []), s.path]);
  }
  const mergeable = [...skillGroups.entries()].filter(([, v]) => new Set(v).size > 1).map(([t, v]) => ({ token: t, paths: [...new Set(v)] }));
  const byOrigin = { operator: [], derived: [], observed: [], unknown: [] };
  for (const r of memory) (byOrigin[r.origin] || byOrigin.unknown).push(r.path);
  // P-022: assembled rules (core + project) against the limit, with the project rules the agent may condense.
  const assembled = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code' });
  const rulesDir = path.join(ctx.brainDir, 'rules');
  const projectRules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => ({ name: f.replace(/\.md$/, ''), chars: fs.readFileSync(path.join(rulesDir, f), 'utf8').length })).sort((a, b) => b.chars - a.chars) : [];
  const rules = { chars: assembled.chars, lines: assembled.lines, over: assembled.overLimit, project: projectRules };
  const health = checkProject(ctx).filter((r) => r.findings.length).map((r) => ({ name: r.name, errors: r.findings.filter((f) => f.level === 'error').length, warns: r.findings.filter((f) => f.level === 'warn').length }));
  return { limits: [...idx.warnings, ...assembled.overLimit], counts: idx.counts, stale, duplicates, mergeable, byOrigin, rules, health };
}

try {
  const ctx = loadContext({ project: args.project });
  const r = report(ctx);
  if (args.json) {
    out(JSON.stringify(r, null, 2));
  } else {
    out(`counts: memory ${r.counts.memory}, decisions ${r.counts.decisions}, skills ${r.counts.skills}`);
    out(r.limits.length ? `over limit: ${r.limits.join('; ')}` : 'within limits');
    out(`rules: ${r.rules.chars} chars, ${r.rules.lines} lines; project rules (condense, merge, remove those a core principle covers): ${r.rules.project.length ? r.rules.project.map((p) => `${p.name} ${p.chars}`).join(', ') : 'none'}`);
    out(`stale derived (fingerprint changed, re-derive or delete): ${r.stale.length ? r.stale.join(', ') : 'none'}`);
    out(`possible duplicate subjects (merge): ${r.duplicates.length ? r.duplicates.map((d) => `${d.token}: ${d.paths.join(' + ')}`).join('; ') : 'none'}`);
    out(`agentic skills sharing a tool/work token (merge only same tool): ${r.mergeable.length ? r.mergeable.map((m) => `${m.token}: ${m.paths.join(' + ')}`).join('; ') : 'none'}`);
    out(`skill health (skill-check.mjs <name> for details, skill workflow:skill-check): ${r.health.length ? r.health.map((h) => `${h.name} ${h.errors}e/${h.warns}w`).join(', ') : 'all ok'}`);
    out(`operator records (never deleted by the agent, only proposed): ${r.byOrigin.operator.length}`);
    out(`observed records (verify cheaply or delete): ${r.byOrigin.observed.length ? r.byOrigin.observed.join(', ') : 'none'}`);
  }
} catch (err) {
  fail(err.message);
}
