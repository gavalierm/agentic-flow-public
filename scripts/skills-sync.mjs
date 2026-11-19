// Copy brain skills into the project's generated skills directory (P-017, P-032). No symlinks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, copyDir, readJson, writeJson, readText, writeText } from './util.mjs';
import { dataPath, dataRel } from './layout.mjs';
import { resolveBrain } from './config.mjs';
import { PERSONA_REPO_RE, PERSONA_PREFIX } from './persona-name.mjs';
import { forkOf, excludeLocal } from './fork.mjs';

export const GENERATED_MARKER = '.workflow-generated.json';
export const PROJECT_SKILLS_DIR = path.join('.claude', 'skills');
export const CODEX_SKILLS_DIR = path.join('.agents', 'skills');

/** Generated skills directory of a harness (relative to the project) and whether workflow skills are copied too. */
export function harnessSkills(harness = 'claude-code') {
  // Codex has no plugin loader: workflow skills are copied next to the brain skills (P-017, Codex).
  if (harness === 'codex') return { dir: CODEX_SKILLS_DIR, gitignore: '.agents/skills/', withWorkflowSkills: true };
  return { dir: PROJECT_SKILLS_DIR, gitignore: '.claude/skills/', withWorkflowSkills: false };
}

export function workflowSkillNames() {
  const dir = path.join(PLUGIN_ROOT, 'skills');
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export function brainSkillDirs(brainDir) {
  const out = [];
  for (const owner of ['operator', 'agentic']) {
    const dir = dataPath(brainDir, 'skills', owner);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) out.push({ name: e.name, owner, dir: path.join(dir, e.name) });
    }
  }
  return out;
}

/** Skills of repo knowledge folders (`<repo>/agentic/skills/<name>/SKILL.md`); agentic only (P-032). */
export function repoSkillDirs(sources = []) {
  const out = [];
  for (const src of sources) {
    const dir = dataPath(src.dir, 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) out.push({ name: e.name, owner: 'agentic', repo: src.repo, dir: path.join(dir, e.name) });
    }
  }
  return out;
}

export function ensureGitignore(projectDir, entries) {
  // A fork: .gitignore is the upstream's file, the lines go to info/exclude (scripts/fork.mjs).
  if (forkOf(projectDir)) { excludeLocal(projectDir, entries); return false; }
  const file = path.join(projectDir, '.gitignore');
  const current = readText(file, '');
  const lines = current.split('\n');
  const missing = entries.filter((e) => !lines.some((l) => l.trim() === e || l.trim() === e.replace(/\/$/, '') || l.trim() === '/' + e));
  if (!missing.length) return false;
  const next = current.replace(/\s*$/, '') + (current.trim() ? '\n' : '') + missing.join('\n') + '\n';
  writeText(file, next);
  return true;
}

/** Replace the Claude Code plugin variable in copied skill texts with the real clone path (local copies only, P-017). */
function substitutePluginRoot(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) substitutePluginRoot(p);
    else if (e.name.endsWith('.md')) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT.split(path.sep).join('/')));
  }
}

/**
 * Name prefix of the persona's own brain skills in the deployed copies (D-0065): "<persona>-" in a persona (a project whose
 * brain is ".", P-024) whose repository is agent-<persona> (the same name as its mail name), else "". The name comes from
 * the project configuration, never from a guess: a persona repo not named agent-<name> gets no prefix.
 */
export function personaSkillPrefix(projectDir) {
  const info = projectDir ? resolveBrain(projectDir) : null;
  if (!info?.persona || !info.brain) return '';
  const repo = path.basename(info.brain);
  return PERSONA_REPO_RE.test(repo) ? `${repo.slice(PERSONA_PREFIX.length)}-` : '';
}

/** Deployed name of a skill of the persona's own brain (D-0065); other skills keep their name. */
export function deployedSkillName(projectDir, name) {
  return personaSkillPrefix(projectDir) + name;
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Paths to an own skill folder of the persona (D-0065): .claude/skills/<name> or .agents/skills/<name> whose segment before
 * .claude is the persona repo folder (any root: literal, $H, $HOME, ~), or that is relative (starts the path token, also
 * ./), followed by "/", the end of the token or a quote. Group 1: the path through "skills/", group 2: the name. A path
 * into another project's skills (another segment before .claude) does not match.
 */
export function skillPathRe(projectDir, names) {
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const repo = escapeRe(path.basename(String(projectDir).replace(/[\\/]+$/, '')));
  const edge = '(?:^|[^\\w./\\-])';
  const start = `(?:${edge}(?:\\./|${repo}/)?|/${repo}/)`;
  return new RegExp(`(?<=${start})(\\.(?:claude|agents)/skills/)(${alt})(?![\\w-]|\\.\\w)`, 'g');
}

/**
 * Deploy references outside skills (D-0065): a warning per crontab line that names a path to an own skill folder of the
 * persona under its old (unprefixed) name, old -> new. The crontab is never changed.
 */
export function crontabSkillWarnings(crontab, { projectDir, prefix, names }) {
  if (!prefix || !names?.length) return [];
  const out = [];
  String(crontab || '').split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const token = new RegExp(`[^\\s"'\`=;|&()]*?${skillPathRe(projectDir, names).source}`, 'g');
    for (const m of line.matchAll(token)) {
      const old = `${m[0]}/`;
      out.push(`crontab line ${i + 1}: ${old} -> ${m[0].slice(0, -m[2].length)}${prefix}${m[2]}/ (skill renamed by the persona prefix, D-0065; crontab not changed)`);
    }
  });
  return out;
}

/** Warnings of crontabSkillWarnings for the OS user's crontab (`crontab -l`; none when it has no crontab) after a sync. */
export function crontabSkillNotes(projectDir, sync, run = spawnSync) {
  if (!sync?.prefix || !sync.renamed?.length) return [];
  const r = run('crontab', ['-l'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return [];
  return crontabSkillWarnings(r.stdout, { projectDir, prefix: sync.prefix, names: sync.renamed });
}

const VAR_RE = '\\$(?:\\{[A-Za-z_]\\w*\\}|[A-Za-z_]\\w*)';
const FILE_RE = '[\\w.\\-]+(?:/[\\w.\\-]+)*';
const hasSkillFile = (files, name, file) => {
  const list = files instanceof Map ? files.get(name) : files[name];
  return Boolean(list && (list instanceof Set ? list.has(file) : list.includes(file)));
};

/** Relative paths (posix) of the files in a skill folder. */
export function skillFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...skillFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Paths a deployed copy still names under an unprefixed own skill folder (D-0065): "$<var>/<name>/<file>" (also
 * "${<var>}", a quote before "/") where the target has no folder <name> but has <prefix><name>/<file>, a form
 * prefixSkillText did not cover. One line per hit: "skill <deployed>: <file>:<line> path <path> has no folder (D-0065)".
 */
export function unprefixedPathWarnings(dir, { target, prefix, names, deployed }) {
  if (!prefix || !names?.length) return [];
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`${VAR_RE}["']?/(${alt})/(${FILE_RE})`, 'g');
  const out = [];
  for (const rel of skillFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        if (fs.existsSync(path.join(target, m[1])) || !fs.existsSync(path.join(target, prefix + m[1], m[2]))) continue;
        out.push(`skill ${deployed}: ${rel}:${i + 1} path ${m[0]} has no folder (D-0065)`);
      }
    });
  }
  return out;
}

/**
 * Text of a deployed copy of a persona's own skill (D-0065): the name: field (self), every path to an own skill folder
 * (skillPathRe), a path "$<var>/<name>/<file>" or "${<var>}/<name>/<file>" whose <file> is in the brain source of that
 * skill (files: name -> relative paths, however the variable is assigned) and mentions "skill `<name>`" or "skill <name>"
 * (Slovak endings too) of the persona's own skills get the prefix. The brain keeps the names without it.
 */
export function prefixSkillText(text, { projectDir, prefix, names, self = null, files = null }) {
  if (!prefix || !names?.length) return String(text);
  let out = String(text);
  if (self) {
    out = out.replace(/^(---\r?\n[\s\S]*?^name:[ \t]*)(["']?)([^"'\r\n]+?)\2[ \t]*$/m, (m, head, q, n) => (n === self ? `${head}${q}${prefix}${n}${q}` : m));
  }
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  out = out.replace(skillPathRe(projectDir, names), (m, dir, name) => `${dir}${prefix}${name}`);
  // A sibling skill folder from a script of a skill: "$here/../<name>/", "$(cd "$(dirname "$0")/.." && pwd)/<name>/"
  // (alice-fix old-code-test.sh 2026-11-14).
  out = out.replace(new RegExp(`(?<=(?:(?:^|[^\\w.])\\.\\.|/\\.\\.["']?\\s*&&\\s*pwd\\))/)(${alt})(?=/)`, 'g'), `${prefix}$1`);
  // A variable holding the skills folder (alice-fix test-clone.sh 2026-11-15); only when <file> is in that skill, so
  // "repos/$r/issues/$n" of the GitHub API stays.
  if (files) {
    out = out.replace(new RegExp(`(${VAR_RE}/)(${alt})/(${FILE_RE})`, 'g'), (m, v, name, file) => (hasSkillFile(files, name, file) ? `${v}${prefix}${name}/${file}` : m));
  }
  out = out.replace(new RegExp(`(\\bskill(?:om|u|y|ov|och|mi|e)?\\s+)(\`?)(${alt})\\2(?![\\w-])`, 'gi'), (m, w, q, n) => `${w}${q}${prefix}${n}${q}`);
  return out;
}

/** Prefix of the skills a persona brain deploys in its own repo (D-0065): "<persona>-" for a brain repo agent-<persona>, else "". */
export function brainRepoSkillPrefix(brainDir) {
  const repo = brainDir ? path.basename(String(brainDir).replace(/[\\/]+$/, '')) : '';
  return PERSONA_REPO_RE.test(repo) ? `${repo.slice(PERSONA_PREFIX.length)}-` : '';
}

/**
 * Text of a copy of a persona brain's skill deployed in another project (not the persona, whose copies keep the plain
 * name): a path into the brain repo's skills, "<brain repo>/.claude/skills/<name>" (any root), names the folder the
 * persona deploys there, <persona>-<name> (D-0065); without it the copy called a script in a folder that does not exist
 * (report-117ef1b9). Relative paths and paths into other repos stay.
 */
export function brainSkillPathText(text, { brainDir, prefix, names }) {
  if (!prefix || !names?.length || !brainDir) return String(text);
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const repo = escapeRe(path.basename(String(brainDir).replace(/[\\/]+$/, '')));
  const re = new RegExp(`(?<=(?:^|[^\\w.\\-]|/)${repo}/)(\\.(?:claude|agents)/skills/)(${alt})(?![\\w-]|\\.\\w)`, 'g');
  return String(text).replace(re, (m, dir, name) => `${dir}${prefix}${name}`);
}

/** Rewrite the text files of a deployed copy (rewrite(text, isTopSkillMd)); binary files (a NUL byte) stay as copied. */
function rewriteSkillDir(dir, rewrite, top = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { rewriteSkillDir(p, rewrite, top); continue; }
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    const next = rewrite(text, e.name === 'SKILL.md' && dir === top);
    if (next !== text) fs.writeFileSync(p, next);
  }
}

/** Rewrite the text files of a deployed copy of a persona's own skill (prefixSkillText). */
function prefixSkillDir(dir, opts) {
  rewriteSkillDir(dir, (text, top) => prefixSkillText(text, { ...opts, self: top ? opts.self : null }));
}

/**
 * Copy brain skills (and, for Codex, workflow skills) into the generated skills directory of the harness. Layers in order
 * (D-0025): workflow, the domain brain (domainBrainDir, when the project has another brain of its own), the project brain,
 * the repos; one name has one home, a collision throws. In a persona its own brain skills are deployed as
 * <persona>-<name> (D-0065, personaSkillPrefix); the collision checks use the brain names, and the old unprefixed copies
 * go with the marker's previous list.
 * Returns { copied: [names], removed: [names], conflicts: [names] }. Throws on name conflict with workflow skills (P-024).
 */
export function syncBrainSkills({ projectDir, brainDir, harness = 'claude-code', repoSources = [], domainBrainDir = null }) {
  const h = harnessSkills(harness);
  const target = path.join(projectDir, h.dir);
  const marker = path.join(target, GENERATED_MARKER);
  const previous = readJson(marker, { generated: [] }).generated || [];
  const domainSkills = domainBrainDir && path.resolve(domainBrainDir) !== path.resolve(brainDir || '') ? brainSkillDirs(domainBrainDir) : [];
  const own = brainDir ? brainSkillDirs(brainDir) : [];
  const workflowNames = workflowSkillNames();
  const conflicts = [...domainSkills, ...own].filter((s) => workflowNames.includes(s.name)).map((s) => s.name);
  if (conflicts.length) throw new Error(`brain skill name(s) collide with workflow skills: ${conflicts.join(', ')} (rename in brain, P-024)`);
  const seen = new Set();
  const twice = (list) => list.filter((s) => (seen.has(s.name) ? true : (seen.add(s.name), false))).map((s) => s.name);
  const duplicates = twice(domainSkills);
  if (duplicates.length) throw new Error(`same skill name in skills/operator and skills/agentic of the domain brain: ${duplicates.join(', ')} (P-032)`);
  const inDomain = new Set(seen);
  const ownTwice = twice(own);
  const overDomain = ownTwice.filter((n) => inDomain.has(n));
  if (overDomain.length) throw new Error(`project brain skill name(s) collide with domain brain skills: ${[...new Set(overDomain)].join(', ')}; one name per domain, keep one (rename or --remove, D-0025)`);
  if (ownTwice.length) throw new Error(`same skill name in skills/operator and skills/agentic: ${ownTwice.join(', ')} (P-032)`);
  const prefix = personaSkillPrefix(projectDir);
  const ownNames = own.map((s) => s.name);
  const skills = [...domainSkills, ...own.map((s) => (prefix ? { ...s, deployed: prefix + s.name } : s))];
  const deployedOwn = new Set(skills.filter((s) => s.deployed).map((s) => s.deployed));
  // Skills of the session repo and of held code-topic worktrees (D-0002); one name has one home.
  const fromRepos = repoSkillDirs(repoSources);
  const clash = fromRepos.filter((s) => workflowNames.includes(s.name) || seen.has(s.name) || deployedOwn.has(s.name)).map((s) => `${s.repo}/${s.name}`);
  const repoSeen = new Map();
  for (const s of fromRepos) {
    if (repoSeen.has(s.name) && repoSeen.get(s.name) !== s.repo) clash.push(`${s.repo}/${s.name} (also ${repoSeen.get(s.name)})`);
    repoSeen.set(s.name, s.repo);
  }
  if (clash.length) throw new Error(`repo skill name(s) collide with brain, workflow or another repo skill: ${[...new Set(clash)].join(', ')}; keep one (save.mjs move or --remove, D-0002)`);
  const unique = new Set();
  skills.push(...fromRepos.filter((s) => (unique.has(s.name) ? false : (unique.add(s.name), true))));
  for (const name of previous) fs.rmSync(path.join(target, name), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  // Another project on a persona brain: paths into the brain repo's skills point to its prefixed copies (report-117ef1b9).
  const brainPrefix = prefix ? '' : brainRepoSkillPrefix(brainDir);
  const ownFiles = prefix ? new Map(own.map((s) => [s.name, new Set(skillFiles(s.dir))])) : null;
  for (const s of skills) {
    const dest = path.join(target, s.deployed || s.name);
    copyDir(s.dir, dest);
    if (s.deployed) prefixSkillDir(dest, { projectDir, prefix, names: ownNames, self: s.name, files: ownFiles });
    else if (brainPrefix && own.includes(s)) {
      rewriteSkillDir(dest, (text) => brainSkillPathText(text, { brainDir, prefix: brainPrefix, names: ownNames }));
    }
  }
  // All copies in place: a path the prefix did not reach names a folder that does not exist (alice-fix 2026-11-15).
  const warnings = skills.filter((s) => s.deployed).flatMap((s) => unprefixedPathWarnings(path.join(target, s.deployed), { target, prefix, names: ownNames, deployed: s.deployed }));
  const generated = skills.map((s) => s.deployed || s.name);
  if (h.withWorkflowSkills) {
    for (const name of workflowNames) {
      copyDir(path.join(PLUGIN_ROOT, 'skills', name), path.join(target, name));
      substitutePluginRoot(path.join(target, name));
      generated.push(name);
    }
  }
  writeJson(marker, { generated, note: 'generated from brain skills at session start; do not edit' });
  ensureGitignore(projectDir, [h.gitignore, `${dataRel(projectDir, 'local')}/`]);
  return { copied: generated, removed: previous.filter((p) => !generated.includes(p)), conflicts: [], prefix, renamed: prefix ? ownNames : [], warnings };
}
