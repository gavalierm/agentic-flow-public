// Deterministic checks of brain content (P-040 pre-commit, P-011, P-032, P-035, P-049). Used by brain writer and the pre-commit script.
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { hasDiacritics } from './keys.mjs';
import { layoutFor } from './layout.mjs';

export const HANDOVER_SECTIONS = ['## Zadanie', '## Hotové', '## Ďalší krok', '## Súbory', '## Otvorené otázky'];
export const HANDOVER_FREE_TEXT = '(voľná)';
// Optional section after "## Otvorené otázky" (3c.3, D-0023): the reporter's open issues, written by code from
// local/reported-issues.json (save.mjs handover), never by the agent; not in HANDOVER_SECTIONS, old handovers stay valid.
export const REPORTS_SECTION = '## Otvorené hlásenia';

export function freeHandover() {
  return [
    '## Zadanie',
    HANDOVER_FREE_TEXT,
    '## Hotové',
    '-',
    '## Ďalší krok',
    '-',
    '## Súbory',
    '-',
    '## Otvorené otázky',
    '-',
  ].join('\n') + '\n';
}

export function renderHandover({ task, done, next, files, questions, reports }) {
  const list = (v) => {
    const items = Array.isArray(v) ? v : String(v ?? '').split(/\s*;\s*|\n/).map((s) => s.trim()).filter(Boolean);
    return items.length ? items.map((s) => `- ${s}`) : ['-'];
  };
  return [
    '## Zadanie',
    String(task ?? '').trim() || '-',
    '## Hotové',
    ...list(done),
    '## Ďalší krok',
    String(next ?? '').trim() || '-',
    '## Súbory',
    ...list(files),
    '## Otvorené otázky',
    ...list(questions),
    ...(Array.isArray(reports) && reports.length ? [REPORTS_SECTION, ...reports] : []),
  ].join('\n') + '\n';
}

// Optional section after the reports (or after "## Otvorené otázky", agent-alice/D-0082): the live state of the topics this
// topic handed off (scripts/handoff.mjs), written by code at every save handover, never by the agent.
export const HANDOFFS_SECTION = '## Odovzdané';

/** Lines of a generated section in a handover (heading included); 0 without it. */
function sectionLines(lines, heading) {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return 0;
  const end = lines.findIndex((l, j) => j > i && /^## /.test(l.trim()));
  return (end === -1 ? lines.length : end) - i;
}
const reportsSectionLines = (lines) => sectionLines(lines, REPORTS_SECTION);

/**
 * The handoffs section of `text` set to `lines` (agent-alice/D-0082): a section already there (also one the agent wrote) is
 * replaced; placed after the reports section, else after "## Otvorené otázky"; removed when there are no lines.
 */
export function withHandoffs(text, handoffs = []) {
  if (!handoffs.length && !String(text).split(/\r?\n/).some((l) => l.trim() === HANDOFFS_SECTION)) return text;
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const i = lines.findIndex((l) => l.trim() === HANDOFFS_SECTION);
  if (i !== -1) lines.splice(i, sectionLines(lines, HANDOFFS_SECTION));
  if (handoffs.length) {
    const r = lines.findIndex((l) => l.trim() === REPORTS_SECTION);
    const q = r !== -1 ? r : lines.findIndex((l) => l.trim() === '## Otvorené otázky');
    const next = q === -1 ? -1 : lines.findIndex((l, j) => j > q && /^## /.test(l.trim()));
    lines.splice(next === -1 ? lines.length : next, 0, HANDOFFS_SECTION, ...handoffs);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The reports section of `text` set to `reports` (lines `- <url> (stav: …)`): replaced, added after "## Otvorené
 * otázky", or removed when there are none (the confirmed issue leaves the handover, 3c.3).
 */
export function withReports(text, reports = []) {
  if (!reports.length && !String(text).split(/\r?\n/).some((l) => l.trim() === REPORTS_SECTION)) return text;
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const i = lines.findIndex((l) => l.trim() === REPORTS_SECTION);
  if (i !== -1) lines.splice(i, reportsSectionLines(lines));
  if (reports.length) {
    const q = lines.findIndex((l) => l.trim() === '## Otvorené otázky');
    const next = q === -1 ? -1 : lines.findIndex((l, j) => j > q && /^## /.test(l.trim()));
    lines.splice(next === -1 ? lines.length : next, 0, REPORTS_SECTION, ...reports);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The structure of a handover (P-011): its five sections. No line limit (agent-alice/D-0094, P-076): the line limit was refused
 * again and again and every refusal cost a rewrite; brevity is led by skill save (only what the next session needs).
 */
export function checkHandover(text) {
  const errors = [];
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  for (const section of HANDOVER_SECTIONS) {
    if (!lines.some((l) => l.trim() === section)) errors.push(`handover missing section "${section}" (P-011)`);
  }
  return errors;
}

export function handoverNextStep(text) {
  const lines = String(text || '').split('\n');
  const i = lines.findIndex((l) => l.trim() === '## Ďalší krok');
  if (i === -1) return '';
  const next = (lines[i + 1] || '').trim().replace(/^-\s*/, '');
  return NO_NEXT_RE.test(next) ? '' : next;
}

// "No next step" written as a word is not a step (pilot 2026-11-02: `--next "žiadny"` blocked the Stop, P-026).
const NO_NEXT_RE = /^(-+|—|–|žiadn[yeaý]|nič|nic|ziadny|none|n\/a|nothing)?[.!]?$/i;

export function isFreeHandover(text) {
  return String(text || '').includes(HANDOVER_FREE_TEXT);
}

export function checkFrontmatterKeys(text, file) {
  const { data, hasFrontmatter } = parseFrontmatter(text);
  const errors = [];
  if (!hasFrontmatter) return errors;
  for (const key of Object.keys(data)) {
    if (hasDiacritics(key) || !/^[a-z][a-z0-9_-]*$/.test(key)) errors.push(`${file}: frontmatter key "${key}" must be english lowercase (P-049)`);
  }
  if (typeof data.key === 'string' && hasDiacritics(data.key)) errors.push(`${file}: key "${data.key}" contains diacritics (P-049)`);
  return errors;
}

export function checkExceptions(text, file, immutable = []) {
  const errors = [];
  const blocks = String(text).split(/^(?=### )/m).filter((b) => b.startsWith('### '));
  const seen = new Set();
  for (const block of blocks) {
    const head = block.split('\n')[0];
    const m = /^###\s+(P-\d{3})\b/.exec(head);
    if (!m) {
      errors.push(`${file}: exception heading "${head.trim()}" has no principle ID (P-035)`);
      continue;
    }
    const id = m[1];
    if (seen.has(id)) errors.push(`${file}: principle ${id} overridden twice in one file (P-035)`);
    seen.add(id);
    if (immutable.includes(id)) errors.push(`${file}: ${id} is immutable and cannot be overridden (P-035)`);
    if (!/^Znenie:\s*\S/m.test(block)) errors.push(`${file}: exception ${id} has no "Znenie:" line (P-035)`);
    if (!/^Dôvod:\s*\S/m.test(block)) errors.push(`${file}: exception ${id} has no "Dôvod:" line (P-035)`);
  }
  return errors;
}

// Brain paths of the checks below, from the map (layout.mjs) of one layout version (memoized); a check has the relative
// path only, no brain root, so the caller names the version of the brain (default 1).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AGENTIC_OWNER = 'agentic';
const CHECKS = new Map();
function checksFor(version = 1) {
  if (CHECKS.has(version)) return CHECKS.get(version);
  const map = layoutFor(version);
  const L = Object.fromEntries(['local', 'topics', 'handover', 'skills', 'exceptions', 'memory', 'decisions'].map((n) => [n, esc(map[n])]));
  const c = {
    map,
    HANDOVER_PATH: new RegExp(`^${L.topics}/[^/]+/${L.handover}$`),
    AGENTIC_SKILL_PATH: new RegExp(`^${L.skills}/${AGENTIC_OWNER}/[^/]+/SKILL\\.md$`),
    SKILL_PATH: new RegExp(`^${L.skills}/[^/]+/[^/]+/SKILL\\.md$`),
    EXCEPTION_PATH: new RegExp(`^${L.exceptions}/[^/]+\\.md$`),
    RECORD_PATH: new RegExp(`^(${L.memory}|${L.decisions})/[^/]+\\.md$`),
  };
  CHECKS.set(version, c);
  return c;
}

/** Check one brain file (relative posix path + content) of a brain in layout `version`. Returns list of error strings. */
export function checkBrainFile(relPath, content, { policy, hasOrigin = true, version = 1 } = {}) {
  const errors = [];
  const rel = relPath.replace(/\\/g, '/');
  const { map, HANDOVER_PATH, AGENTIC_SKILL_PATH, SKILL_PATH, EXCEPTION_PATH, RECORD_PATH } = checksFor(version);
  if (rel.startsWith(`${map.local}/`) || rel === map.local) errors.push(`${rel}: files in ${map.local}/ are never committed (P-018, P-039)`);
  // P-049 names the records the workflow names itself; documents and outside material (docs, materialy) keep any name
  // (operator 2026-11-15: a file of a person or from outside is not forced into a fixed form).
  const freeName = [map.docs, map.materialy].some((d) => d && rel.startsWith(`${d}/`));
  if (!freeName && (hasDiacritics(rel) || /[A-Z\s]/.test(rel.replace(/^[A-Z]:/, '')))) {
    // INDEX.md in the root of a layout 2 repo is generated by the workflow (scripts/data-index.mjs).
    if (!/^(README|SKILL|AGENTS)\.md$/.test(path.posix.basename(rel)) && !/\/(SKILL|README)\.md$/.test(rel) && !(Number(version) === 2 && rel === 'INDEX.md')) {
      errors.push(`${rel}: path must be english lowercase without spaces (P-049)`);
    }
  }
  if (content === null || content === undefined) return errors;
  if (rel.endsWith('.md')) errors.push(...checkFrontmatterKeys(content, rel));
  if (HANDOVER_PATH.test(rel)) {
    errors.push(...checkHandover(content));
  }
  if (AGENTIC_SKILL_PATH.test(rel)) {
    const { data } = parseFrontmatter(content);
    if (!['error', 'routine'].includes(data.origin)) errors.push(`${rel}: skill in agentic/ needs origin: error | routine (P-032)`);
    if (!data.description) errors.push(`${rel}: skill needs a description trigger (P-003)`);
  }
  if (SKILL_PATH.test(rel)) {
    const { data } = parseFrontmatter(content);
    const limit = policy?.limits?.skill_description_chars ?? 300;
    if (data.description && String(data.description).length > limit) errors.push(`${rel}: description over ${limit} chars (P-022)`);
  }
  if (EXCEPTION_PATH.test(rel)) {
    errors.push(...checkExceptions(content, rel, policy?.immutable_principles ?? []));
  }
  if (RECORD_PATH.test(rel)) {
    const { data } = parseFrontmatter(content);
    if (!data.key) errors.push(`${rel}: record needs frontmatter key (P-031)`);
    if (rel.startsWith(`${map.memory}/`) && !data.origin) errors.push(`${rel}: memory record needs origin (P-009)`);
    if (rel.startsWith(`${map.decisions}/`) && !(Array.isArray(data.relates_to) && data.relates_to.length)) {
      errors.push(`${rel}: decision needs relates_to (P-008, P-031)`);
    }
  }
  return errors;
}
