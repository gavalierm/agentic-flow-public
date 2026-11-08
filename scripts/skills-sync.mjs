// Copy brain skills into the project's generated skills directory (P-017, P-032). No symlinks.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, copyDir, readJson, writeJson, readText, writeText } from './util.mjs';

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
    const dir = path.join(brainDir, 'skills', owner);
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
    const dir = path.join(src.dir, 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) out.push({ name: e.name, owner: 'agentic', repo: src.repo, dir: path.join(dir, e.name) });
    }
  }
  return out;
}

export function ensureGitignore(projectDir, entries) {
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
 * Copy brain skills (and, for Codex, workflow skills) into the generated skills directory of the harness.
 * Returns { copied: [names], removed: [names], conflicts: [names] }. Throws on name conflict with workflow skills (P-024).
 */
export function syncBrainSkills({ projectDir, brainDir, harness = 'claude-code', repoSources = [] }) {
  const h = harnessSkills(harness);
  const target = path.join(projectDir, h.dir);
  const marker = path.join(target, GENERATED_MARKER);
  const previous = readJson(marker, { generated: [] }).generated || [];
  const skills = brainDir ? brainSkillDirs(brainDir) : [];
  const workflowNames = workflowSkillNames();
  const conflicts = skills.filter((s) => workflowNames.includes(s.name)).map((s) => s.name);
  if (conflicts.length) throw new Error(`brain skill name(s) collide with workflow skills: ${conflicts.join(', ')} (rename in brain, P-024)`);
  const seen = new Set();
  const duplicates = skills.filter((s) => (seen.has(s.name) ? true : (seen.add(s.name), false))).map((s) => s.name);
  if (duplicates.length) throw new Error(`same skill name in skills/operator and skills/agentic: ${duplicates.join(', ')} (P-032)`);
  // Skills of the session repo and of held code-topic worktrees (D-0002); one name has one home.
  const fromRepos = repoSkillDirs(repoSources);
  const clash = fromRepos.filter((s) => workflowNames.includes(s.name) || seen.has(s.name)).map((s) => `${s.repo}/${s.name}`);
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
  for (const s of skills) copyDir(s.dir, path.join(target, s.name));
  const generated = skills.map((s) => s.name);
  if (h.withWorkflowSkills) {
    for (const name of workflowNames) {
      copyDir(path.join(PLUGIN_ROOT, 'skills', name), path.join(target, name));
      substitutePluginRoot(path.join(target, name));
      generated.push(name);
    }
  }
  writeJson(marker, { generated, note: 'generated from brain skills at session start; do not edit' });
  ensureGitignore(projectDir, [h.gitignore, 'local/']);
  return { copied: generated, removed: previous.filter((p) => !generated.includes(p)), conflicts: [] };
}
