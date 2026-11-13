#!/usr/bin/env node
// Support script for skill consolidate (P-010, P-003, P-009): deterministic report of limits, stale derived records,
// duplicate subjects and mergeable agentic skills. The subagent reviews, the main agent writes via save.
//   consolidate.mjs report [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lfBytes } from '../scripts/eol.mjs';
import { parseArgs, fail, toPosix } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { readMemory, readSkills, projectRecords } from '../scripts/records.mjs';
import { domainRepos, REPO_HANDOVER } from '../scripts/repo-knowledge.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { tokens } from '../scripts/keys.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { checkProject } from '../scripts/skill-check.mjs';
import { machineStores, sessionStores, machineRecords, storeRecords, sameStore, subjectMatch, subjectNames, recordType, decisionRefs, refProblem, refFiles, displayPath, isTombstone, SUBJECT_TYPES, ID_LINE } from '../scripts/stores.mjs';

const args = parseArgs(process.argv.slice(2));
const out = (s) => process.stdout.write(s + '\n');

function fingerprint(projectDir, sources) {
  const h = createHash('sha1');
  for (const s of sources) {
    const file = path.resolve(projectDir, s);
    h.update(s + '\n');
    h.update(fs.existsSync(file) ? lfBytes(fs.readFileSync(file)) : Buffer.from('missing'));
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * Repo knowledge of the domain (D-0002): counts per repo, HANDOVER.md over its limit, stale derived records (sources are
 * repo paths) and keys or skill names that live both in brain and in a repo (one subject, one home).
 */
export function repoReport(ctx, brainRecords) {
  if (!ctx.domain) return { repos: [], limits: [], stale: [], both: [] };
  const recs = projectRecords(ctx.domain, ctx.brainDir).filter((r) => !r.topic && (r.kind !== 'skill' || r.path.endsWith('/SKILL.md')));
  const max = ctx.policy?.limits?.repo_handover_lines ?? 150;
  const repos = [];
  const limits = [];
  for (const repo of domainRepos(ctx.domain, ctx.brainDir)) {
    const mine = recs.filter((r) => r.repo === repo.name);
    if (!mine.length) continue;
    const count = (k) => mine.filter((r) => r.kind === k).length;
    repos.push({ repo: repo.name, memory: count('memory'), decisions: count('decision'), runbooks: count('runbook'), skills: count('skill'), handover: mine.some((r) => r.kind === 'handover') });
    const ho = path.join(repo.dir, 'agentic', REPO_HANDOVER);
    if (fs.existsSync(ho)) {
      const lines = fs.readFileSync(ho, 'utf8').split('\n').length;
      if (lines > max) limits.push(`${repo.name}/agentic/${REPO_HANDOVER} ${lines} lines > ${max}`);
    }
  }
  const stale = recs.filter((r) => r.origin === 'derived' && r.data.fingerprint && fingerprint(path.join(ctx.domain.root, r.repo), r.data.sources || []) !== r.data.fingerprint).map((r) => r.path);
  const brainKeys = new Map(brainRecords.map((r) => [`${r.kind}:${r.key}`, r.path]));
  const both = recs.filter((r) => r.kind !== 'handover' && brainKeys.has(`${r.kind}:${r.key}`)).map((r) => `${r.key}: ${brainKeys.get(`${r.kind}:${r.key}`)} + ${r.path}`);
  return { repos, limits, stale, both };
}


/**
 * One subject, one record (D-0028), over the stores of this session (its brain, the domain brain, the domain repos):
 * a project, service, person or tool record whose key, name or alias another store of the machine has too (both
 * paths); tombstones (a memory or decision body under 300 characters that only says where the record went); decision
 * references that do not resolve: a bare D-NNNN its own store lacks, a <store>/D-NNNN the named store lacks (path:line).
 */
export function identityReport(ctx) {
  const stores = machineStores(ctx);
  const mine = sessionStores(ctx);
  const others = machineRecords(ctx).filter((r) => r.kind === 'memory' && !r.topic && SUBJECT_TYPES.includes(recordType(r)));
  const duplicates = [];
  const seen = new Set();
  const tombstones = [];
  const refs = [];
  for (const s of mine) {
    const recs = storeRecords(s, ctx.brainDir).filter((r) => !r.topic);
    for (const r of recs.filter((x) => x.kind === 'memory' && SUBJECT_TYPES.includes(recordType(x)))) {
      for (const o of others) {
        if (sameStore(o.storeOf, s)) continue;
        const how = subjectMatch(o, { key: r.key, names: subjectNames(r) });
        const pair = [displayPath(r), displayPath(o)].sort().join(' + ');
        if (!how || seen.has(pair)) continue;
        seen.add(pair);
        duplicates.push({ key: r.key, how, store: s.name, other: o.storeOf.name, paths: [displayPath(r), displayPath(o)] });
      }
    }
    for (const r of recs.filter((x) => (x.kind === 'memory' || x.kind === 'decision') && isTombstone(x.body))) tombstones.push(displayPath(r));
    for (const f of refFiles(s)) {
      for (const ref of decisionRefs(fs.readFileSync(f, 'utf8'), { skip: ID_LINE })) {
        const problem = refProblem(stores, s, ref, ctx.brainDir);
        if (problem) refs.push(`${toPosix(f)}:${ref.line} ${problem}`);
      }
    }
  }
  return { duplicates, tombstones, refs: [...new Set(refs)] };
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
  const assembled = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code', layers: ctx.layers });
  const rulesDir = path.join(ctx.brainDir, 'rules');
  const projectRules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => ({ name: f.replace(/\.md$/, ''), chars: fs.readFileSync(path.join(rulesDir, f), 'utf8').length })).sort((a, b) => b.chars - a.chars) : [];
  const rules = { chars: assembled.chars, lines: assembled.lines, over: assembled.overLimit, project: projectRules };
  const health = checkProject(ctx).filter((r) => r.findings.length).map((r) => ({ name: r.name, errors: r.findings.filter((f) => f.level === 'error').length, warns: r.findings.filter((f) => f.level === 'warn').length }));
  const repos = repoReport(ctx, [...memory, ...readSkills(ctx.brainDir)]);
  return { limits: [...idx.warnings, ...assembled.overLimit, ...repos.limits], counts: idx.counts, stale: [...stale, ...repos.stale], duplicates, mergeable, byOrigin, rules, health, repos, identity: identityReport(ctx) };
}

try {
  const ctx = loadContext({ project: args.project });
  const r = report(ctx);
  if (args.json) {
    out(JSON.stringify(r, null, 2));
  } else {
    out(`counts: memory ${r.counts.memory}, decisions ${r.counts.decisions}, skills ${r.counts.skills}`);
    out(r.limits.length ? `over limit: ${r.limits.join('; ')}` : 'within limits');
    if (r.repos.repos.length) out(`repo knowledge: ${r.repos.repos.map((x) => `${x.repo} memory ${x.memory}, decisions ${x.decisions}, runbooks ${x.runbooks}, skills ${x.skills}${x.handover ? ', HANDOVER' : ''}`).join('; ')}`);
    out(`in brain and in a repo (keep one home: save.mjs move <path> --repo <repo>, or remove the repo copy with save --repo): ${r.repos.both.length ? r.repos.both.join('; ') : 'none'}`);
    out(`rules: ${r.rules.chars} chars, ${r.rules.lines} lines; project rules (condense, merge, remove those a core principle covers): ${r.rules.project.length ? r.rules.project.map((p) => `${p.name} ${p.chars}`).join(', ') : 'none'}`);
    out(`stale derived (fingerprint changed, re-derive or delete): ${r.stale.length ? r.stale.join(', ') : 'none'}`);
    out(`possible duplicate subjects (merge): ${r.duplicates.length ? r.duplicates.map((d) => `${d.token}: ${d.paths.join(' + ')}`).join('; ') : 'none'}`);
    out(`same subject in another store (one subject, one record: keep one, fold the other into it): ${r.identity.duplicates.length ? r.identity.duplicates.map((d) => `${d.key} (${d.how}, ${d.store} + ${d.other}): ${d.paths.join(' + ')}`).join('; ') : 'none'}`);
    out(`tombstones (short body pointing elsewhere: remove it with save.mjs memory <type> <name> --remove --reason "<why>", the record it names holds the subject): ${r.identity.tombstones.length ? r.identity.tombstones.join(', ') : 'none'}`);
    out(`decision references that do not resolve (a bare D-NNNN is the own store, another store's decision is <store>/D-NNNN): ${r.identity.refs.length ? r.identity.refs.join('; ') : 'none'}`);
    out(`agentic skills sharing a tool/work token (merge only same tool): ${r.mergeable.length ? r.mergeable.map((m) => `${m.token}: ${m.paths.join(' + ')}`).join('; ') : 'none'}`);
    out(`skill health (skill-check.mjs <name> for details, skill workflow:skill-check): ${r.health.length ? r.health.map((h) => `${h.name} ${h.errors}e/${h.warns}w`).join(', ') : 'all ok'}`);
    out(`operator records (never deleted by the agent, only proposed): ${r.byOrigin.operator.length}`);
    out(`observed records (verify cheaply or delete): ${r.byOrigin.observed.length ? r.byOrigin.observed.join(', ') : 'none'}`);
  }
} catch (err) {
  fail(err.message);
}
