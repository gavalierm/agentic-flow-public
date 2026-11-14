// Generated local indexes (P-039, P-010, P-022). Never committed: <brain>/local/index/.
import path from 'node:path';
import { writeText, localTime } from './util.mjs';
import { readMemory, readDecisions, readRules, readSkills, readTopics } from './records.mjs';
import { foreignAuthor, byTag, isOperatorMemory } from './authors.mjs';

export function topicLine(t) {
  const holder = t.holder?.thread || '-';
  const next = t.next ? `, next: ${t.next}` : '';
  const state = t.state === 'paused' && t.paused_until ? `paused until ${localTime(t.paused_until)}` : t.state || 'working';
  return `${t.id} (${state}, ${holder}${next})`;
}

const memoryLine = (r, by = null) => `- ${r.key}: ${r.description}${byTag(by)}`;
const decisionLine = (r, by = null) => `- ${r.id || r.key}: ${r.title || r.description}${r.status && r.status !== 'valid' ? ` [${r.status}]` : ''}${byTag(by)}`;

/**
 * Memory and decision index as the session start shows them (P-021 items 4, 5), with the record authors of
 * scripts/authors.mjs: a record of another operator ends with `[by <name>]`; another operator's own memory (type operator,
 * their preferences) is one count line instead of its lines. The files in local/index/ stay without authors.
 */
export function shownIndexes(records, authors) {
  const memory = [];
  const theirs = [];
  for (const r of records.memory) {
    const by = foreignAuthor(authors, r.path);
    if (by && isOperatorMemory(r)) theirs.push(by);
    else memory.push(memoryLine(r, by));
  }
  if (theirs.length) memory.push(`foreign operator memory (other operators' preferences, not yours): ${theirs.length} [by ${[...new Set(theirs)].sort().join(', ')}]`);
  return { memory: memory.join('\n').trim(), decisions: records.decisions.map((r) => decisionLine(r, foreignAuthor(authors, r.path))).join('\n').trim() };
}

export function buildIndexes(brainDir, policy) {
  const limits = policy?.limits || {};
  const memoryRecords = readMemory(brainDir);
  const decisionRecords = readDecisions(brainDir);
  const memory = memoryRecords.map((r) => memoryLine(r));
  const decisions = decisionRecords.map((r) => decisionLine(r));
  const topics = readTopics(brainDir).map((t) => `- ${topicLine(t)}`);
  const skills = readSkills(brainDir).map((r) => `- ${r.skillName} [${r.owner}]: ${r.description}`);
  const rules = readRules(brainDir).map((r) => `- ${r.path}: ${r.title || r.description}`);
  const text = {
    memory: memory.join('\n') + (memory.length ? '\n' : ''),
    decisions: decisions.join('\n') + (decisions.length ? '\n' : ''),
    topics: topics.join('\n') + (topics.length ? '\n' : ''),
    skills: skills.join('\n') + (skills.length ? '\n' : ''),
    rules: rules.join('\n') + (rules.length ? '\n' : ''),
  };
  const warnings = [];
  if (memory.length > (limits.memory_index_lines ?? 50)) warnings.push(`memory index ${memory.length} lines > ${limits.memory_index_lines} (run consolidate, P-010)`);
  if (decisions.length > (limits.decision_index_lines ?? 50)) warnings.push(`decision index ${decisions.length} lines > ${limits.decision_index_lines} (P-008, P-022)`);
  // The persona main topic (P-045) is permanent and outside the limit.
  const openTopics = readTopics(brainDir).filter((t) => t.kind !== 'main').length;
  if (openTopics > (limits.open_topics_lines ?? 10)) warnings.push(`open topics ${openTopics} > ${limits.open_topics_lines} (P-022)`);
  const skillsChars = skills.join('\n').length;
  if (skillsChars > (limits.skills_list_chars ?? 6000)) warnings.push(`brain skills list ${skillsChars} chars > ${limits.skills_list_chars} (run consolidate, P-003)`);
  const files = {};
  for (const [name, content] of Object.entries(text)) {
    const file = path.join(brainDir, 'local', 'index', `${name}.md`);
    writeText(file, content);
    files[name] = file;
  }
  return { text, files, warnings, records: { memory: memoryRecords, decisions: decisionRecords }, counts: { memory: memory.length, decisions: decisions.length, topics: topics.length, skills: skills.length } };
}
