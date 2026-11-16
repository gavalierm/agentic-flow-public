// Reading brain records (memory, decisions, rules, skills, topics) into a uniform shape (P-031, P-039).
import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readJson, readText, relPosix } from './util.mjs';
import { parseFrontmatter, asList } from './frontmatter.mjs';
import { normalizeKey } from './keys.mjs';
import { handoverNextStep } from './brain-checks.mjs';
import { PROJECT_KNOWLEDGE, domainRepos, knowledgeDirs, knowledgeFiles, historyDecisionMax } from './repo-knowledge.mjs';
import { dataPath, dataRel, layoutOf } from './layout.mjs';
import { listTopicRecords } from './topic-files.mjs';

function summary(data, body) {
  const s = data.summary || data.description || data.title;
  if (s) return String(s);
  const line = String(body || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line || '';
}

function record(brainDir, file, kind) {
  const text = readText(file, '');
  const { data, body } = parseFrontmatter(text);
  const rel = relPosix(brainDir, file);
  const name = data.name || data.title || path.basename(file, '.md');
  return {
    path: rel,
    abs: file,
    kind,
    key: String(data.key || (kind === 'skill' ? data.name || path.basename(path.dirname(file)) : path.basename(file, '.md'))),
    type: data.type || null,
    name: String(name),
    aliases: asList(data.aliases).map(String),
    relates_to: asList(data.relates_to).map(String),
    origin: data.origin || null,
    status: data.status || null,
    id: data.id || null,
    title: data.title || null,
    description: summary(data, body).slice(0, 160),
    data,
    body,
  };
}

// base: the folder paths are relative to (default the brain itself; another store's records are read relative to the session brain).
export function readMemory(brainDir, base = brainDir) {
  return listFiles(dataPath(brainDir, 'memory'), (f) => f.endsWith('.md')).map((f) => record(base, f, 'memory'));
}

export function readDecisions(brainDir, base = brainDir) {
  return listFiles(dataPath(brainDir, 'decisions'), (f) => f.endsWith('.md')).map((f) => record(base, f, 'decision'));
}

export function readRules(brainDir, base = brainDir) {
  return listFiles(dataPath(brainDir, 'rules'), (f) => f.endsWith('.md')).map((f) => record(base, f, 'rule'));
}

export function readSkills(brainDir, base = brainDir) {
  const out = [];
  for (const owner of ['operator', 'agentic']) {
    const dir = dataPath(brainDir, 'skills', owner);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const r = record(base, file, 'skill');
      r.owner = owner;
      r.skillName = String(r.data.name || entry.name);
      r.key = r.skillName;
      out.push(r);
    }
  }
  return out;
}

/** Open topics (or the closed ones: `archived: true`; layout 1 the archive, layout 2 state closed) with holder and handover. */
export function readTopics(brainDir, { archived = false } = {}) {
  const L = layoutOf(brainDir);
  return listTopicRecords(brainDir, { closed: archived }).map(({ id, dir, topic, holder }) => {
    const handover = readText(path.join(dir, L.handover), '');
    // `next`: the items of Ďalší krok as one text ('' without a step); the items themselves: handoverNextStep(handover).
    return { id, ...topic, holder, next: (handoverNextStep(handover) || []).join('; '), handover };
  });
}

export function allRecords(brainDir, domain = null) {
  return [...readMemory(brainDir), ...readDecisions(brainDir), ...readRules(brainDir), ...readSkills(brainDir), ...projectRecords(domain, brainDir)];
}

export { PROJECT_KNOWLEDGE };

/**
 * Knowledge kept in the repos of a domain (`<repo>/agentic/`: HANDOVER.md, decisions/, runbooks/, memory/, skills/),
 * so whoever takes the repo over gets it with the code (operator 2026-11-04). Paths are relative to the brain. A topic
 * worktree adds the files it changed (r.topic): its new records count for dedup and D-numbers before done --topic.
 */
export function projectRecords(domain, brainDir) {
  if (!domain?.root || !fs.existsSync(domain.root)) return [];
  return domainRepos(domain, brainDir).flatMap((repo) => repoRecords(domain, repo.name, brainDir || domain.root));
}

/** Records of one repo of a domain: its main checkout's agentic/, then what each topic worktree changed (r.topic). */
export function repoRecords(domain, repoName, base = domain.root) {
  const out = [];
  const [main, ...worktrees] = knowledgeDirs(domain, repoName);
  for (const k of [main, ...worktrees]) {
    if (!fs.existsSync(k.dir)) continue;
    for (const { file: f, rel, kind } of knowledgeFiles(k.dir)) {
      if (k.topic && readText(path.join(main.dir, ...rel.split('/')), null) === readText(f, '')) continue;
      const r = record(base, f, kind);
      r.repo = repoName;
      if (k.topic) r.topic = k.topic;
      if (kind === 'skill') r.key = String(r.data.name || path.basename(path.dirname(f)));
      if (kind === 'handover') { r.key = `${repoName}-handover`; r.aliases.push(`${repoName} handover`); }
      out.push(r);
    }
  }
  return out;
}

export function nextDecisionId(brainDir) {
  let max = historyDecisionMax(brainDir, dataRel(brainDir, 'decisions'));
  for (const d of readDecisions(brainDir)) {
    const m = /^D-(\d+)$/.exec(String(d.id || d.key || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `D-${String(max + 1).padStart(4, '0')}`;
}

export function normalizedNames(r) {
  return new Set([r.key, r.name, r.title, ...r.aliases].filter(Boolean).map((v) => normalizeKey(v)));
}
