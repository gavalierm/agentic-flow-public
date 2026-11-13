// Deterministic checks of brain content (P-040 pre-commit, P-011, P-032, P-035, P-049). Used by brain writer and the pre-commit script.
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { hasDiacritics } from './keys.mjs';

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

/** Lines of the reports section in a handover (heading included); 0 without it. */
function reportsSectionLines(lines) {
  const i = lines.findIndex((l) => l.trim() === REPORTS_SECTION);
  if (i === -1) return 0;
  const end = lines.findIndex((l, j) => j > i && /^## /.test(l.trim()));
  return (end === -1 ? lines.length : end) - i;
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

export function checkHandover(text, limitLines = 15) {
  const errors = [];
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  // The budget in the refusal: a handover rewritten without it was refused again (flow-public#12).
  const reports = reportsSectionLines(lines);
  const fixed = HANDOVER_SECTIONS.length + 2 + reports;
  const reportsNote = reports ? `, the section "${REPORTS_SECTION}" (${reports - 1} open issue(s), written by code until error.mjs confirm) ${reports}` : '';
  if (lines.length > limitLines) errors.push(`handover has ${lines.length} lines, limit ${limitLines} (P-011): the ${HANDOVER_SECTIONS.length} headings, --task and --next take ${HANDOVER_SECTIONS.length + 2}${reportsNote}, so --done, --files and --questions together hold at most ${limitLines - fixed} items (each "; " item is one line, an empty list one "-"); cut ${lines.length - limitLines}: merge items, keep only what the next session needs, durable knowledge goes through save (P-007)`);
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

/** Check one brain file (relative posix path + content). Returns list of error strings. */
export function checkBrainFile(relPath, content, { policy, hasOrigin = true } = {}) {
  const errors = [];
  const rel = relPath.replace(/\\/g, '/');
  if (rel.startsWith('local/') || rel === 'local') errors.push(`${rel}: files in local/ are never committed (P-018, P-039)`);
  if (hasDiacritics(rel) || /[A-Z\s]/.test(rel.replace(/^[A-Z]:/, ''))) {
    if (!/^(README|SKILL|AGENTS)\.md$/.test(path.posix.basename(rel)) && !/\/(SKILL|README)\.md$/.test(rel)) {
      errors.push(`${rel}: path must be english lowercase without spaces (P-049)`);
    }
  }
  if (content === null || content === undefined) return errors;
  if (rel.endsWith('.md')) errors.push(...checkFrontmatterKeys(content, rel));
  if (/^topics\/[^/]+\/handover\.md$/.test(rel)) {
    errors.push(...checkHandover(content, policy?.limits?.handover_lines ?? 15));
  }
  if (/^skills\/agentic\/[^/]+\/SKILL\.md$/.test(rel)) {
    const { data } = parseFrontmatter(content);
    if (!['error', 'routine'].includes(data.origin)) errors.push(`${rel}: skill in agentic/ needs origin: error | routine (P-032)`);
    if (!data.description) errors.push(`${rel}: skill needs a description trigger (P-003)`);
  }
  if (/^skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(rel)) {
    const { data } = parseFrontmatter(content);
    const limit = policy?.limits?.skill_description_chars ?? 300;
    if (data.description && String(data.description).length > limit) errors.push(`${rel}: description over ${limit} chars (P-022)`);
  }
  if (/^exceptions\/[^/]+\.md$/.test(rel)) {
    errors.push(...checkExceptions(content, rel, policy?.immutable_principles ?? []));
  }
  if (/^(memory|decisions)\/[^/]+\.md$/.test(rel)) {
    const { data } = parseFrontmatter(content);
    if (!data.key) errors.push(`${rel}: record needs frontmatter key (P-031)`);
    if (rel.startsWith('memory/') && !data.origin) errors.push(`${rel}: memory record needs origin (P-009)`);
    if (rel.startsWith('decisions/') && !(Array.isArray(data.relates_to) && data.relates_to.length)) {
      errors.push(`${rel}: decision needs relates_to (P-008, P-031)`);
    }
  }
  return errors;
}
