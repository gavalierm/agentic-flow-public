// Deterministic checks of brain content (P-040 pre-commit, P-011, P-032, P-035, P-049). Used by brain writer and the pre-commit script.
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { hasDiacritics } from './keys.mjs';
import { layoutFor, ROLE_BRAIN } from './layout.mjs';

// P-011 (flow v2 kap. 9): six sections. Ďalší krok, Otvorené otázky and Úlohy pre operátora are lists of items, the facts
// of the topic's state (spec 10.2, scripts/topic-state.mjs); a handover without one of the six is invalid (checkHandover).
export const NEXT_SECTION = '## Ďalší krok';
export const QUESTIONS_SECTION = '## Otvorené otázky';
export const TASKS_SECTION = '## Úlohy pre operátora';
export const HANDOVER_SECTIONS = ['## Zadanie', '## Hotové', NEXT_SECTION, '## Súbory', QUESTIONS_SECTION, TASKS_SECTION];
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
    TASKS_SECTION,
    '-',
  ].join('\n') + '\n';
}

/** A handover from its fields (save handover): done, next, files, questions and tasks are lists ("a; b", lines or arrays). */
export function renderHandover({ task, done, next, files, questions, tasks, reports }) {
  const list = (v) => {
    const items = (Array.isArray(v) ? v : String(v ?? '').split(/\s*;\s*|\n/)).map((s) => String(s).trim()).filter((s) => s && !/^-+$/.test(s));
    return items.length ? items.map((s) => `- ${s}`) : ['-'];
  };
  return [
    '## Zadanie',
    String(task ?? '').trim() || '-',
    '## Hotové',
    ...list(done),
    NEXT_SECTION,
    ...list(next),
    '## Súbory',
    ...list(files),
    QUESTIONS_SECTION,
    ...list(questions),
    TASKS_SECTION,
    ...list(tasks),
    ...(Array.isArray(reports) && reports.length ? [REPORTS_SECTION, ...reports] : []),
  ].join('\n') + '\n';
}

const HANDOVER_KEYS = [['task', '## Zadanie'], ['done', '## Hotové'], ['next', NEXT_SECTION], ['files', '## Súbory'], ['questions', QUESTIONS_SECTION], ['tasks', TASKS_SECTION]];

/** heading → body lines of each `## ` section of a handover (in order; trailing blank lines dropped). */
export function handoverBodies(text) {
  const out = new Map();
  let cur = null;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^## /.test(line.trim())) { cur = line.trim(); out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  for (const [k, v] of out) { while (v.length && !v.at(-1).trim()) v.pop(); out.set(k, v); }
  return out;
}

/**
 * A handover from the fields given (save handover without --file) over the current one: a section whose option is not
 * given keeps its current text; sections outside the six (except the generated reports) stay after them. Returns
 * { text, kept, added } (headings kept from the current handover). Cause (report 20261117T195322961Z, P-018):
 * `save.mjs handover <topic> --questions "a; b"` wrote '-' into Zadanie, Hotové, Ďalší krok and Súbory (11.6 kB -> 413 B).
 * Hotové is the history of the topic: --done adds its items after the current ones (an item already there is not added
 * twice); `--done ""` empties it; --done-replace (fields.replaceDone) or --file rewrites it. The other sections are the current state and are replaced.
 * Cause (thread parametre-produktov, 2026-11-17): `--done "<new item>"` replaced the 56 items of Hotové again and again;
 * the agent restored them from git each time. `added` is the number of items --done added.
 */
export function mergeHandover(current, fields) {
  const now = current ? handoverBodies(current) : new Map();
  const given = (k) => typeof fields[k] === 'string' || Array.isArray(fields[k]);
  const kept = [];
  const lines = [];
  let added = null;
  const items = (body) => (body || []).filter((l) => l.trim() && !/^-+$/.test(l.trim()));
  for (const [k, heading] of HANDOVER_KEYS) {
    let body;
    if (k === 'done' && given(k) && !fields.replaceDone && items(now.get(heading)).length) {
      const fresh = items(handoverBodies(renderHandover({ done: fields.done })).get(heading));
      if (!fresh.length) body = ['-'];
      else {
        const old = items(now.get(heading));
        const have = new Set(old.map((l) => l.trim()));
        const extra = fresh.filter((l) => !have.has(l.trim()));
        added = extra.length;
        body = [...old, ...extra];
      }
    } else if (given(k)) body = handoverBodies(renderHandover({ [k]: fields[k] })).get(heading);
    else if (now.has(heading) && now.get(heading).some((l) => l.trim())) { body = now.get(heading); kept.push(heading.slice(3)); }
    else body = ['-'];
    lines.push(heading, ...body);
  }
  const six = new Set([...HANDOVER_KEYS.map(([, h]) => h), REPORTS_SECTION]);
  for (const [heading, body] of now) if (!six.has(heading)) { lines.push(heading, ...body); kept.push(heading.slice(3)); }
  return { text: `${lines.join('\n')}\n`, kept, added };
}

/** Lines of a generated section in a handover (heading included); 0 without it. */
function sectionLines(lines, heading) {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return 0;
  const end = lines.findIndex((l, j) => j > i && /^## /.test(l.trim()));
  return (end === -1 ? lines.length : end) - i;
}
const reportsSectionLines = (lines) => sectionLines(lines, REPORTS_SECTION);

/**
 * The reports section of `text` set to `reports` (lines `- <url> (stav: …)`): replaced, added after "## Úlohy pre
 * operátora", or removed when there are none (the confirmed issue leaves the handover, 3c.3).
 */
export function withReports(text, reports = []) {
  if (!reports.length && !String(text).split(/\r?\n/).some((l) => l.trim() === REPORTS_SECTION)) return text;
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const i = lines.findIndex((l) => l.trim() === REPORTS_SECTION);
  if (i !== -1) lines.splice(i, reportsSectionLines(lines));
  if (reports.length) {
    const q = lines.findIndex((l) => l.trim() === TASKS_SECTION);
    const next = q === -1 ? -1 : lines.findIndex((l, j) => j > q && /^## /.test(l.trim()));
    lines.splice(next === -1 ? lines.length : next, 0, REPORTS_SECTION, ...reports);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The structure of a handover (P-011): its six sections. No line limit (agent-alice/D-0094, P-076): the line limit was refused
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

// "No item" written as a word is not an item (pilot 2026-11-02: `--next "žiadny"` blocked the Stop, P-026).
const NO_ITEM_RE = /^(-+|—|–|žiadn[yeaýé]|nič|nic|ziadny|ziadne|none|n\/a|nothing)?[.!]?$/i;
const ITEM_MARK = /^(?:[-*•]|\d+[.)])(?:\s+|$)/;

/**
 * Items of a section of a handover: each line starting with a mark (`- `, `* `, `1. `, `1) `) begins one, a line
 * without a mark continues the item before it (after a blank line or as the first line it begins one); "-" or "žiadny"
 * is no item. null when the
 * handover has no such section: such a handover is invalid (checkHandover), it is not read as an empty section.
 */
export function sectionItems(text, heading) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return null;
  const items = [];
  let open = false;
  for (let j = i + 1; j < lines.length && !/^## /.test(lines[j].trim()); j++) {
    const line = lines[j].trim();
    if (!line) { open = false; continue; }
    if (ITEM_MARK.test(line) || !open) items.push(line.replace(ITEM_MARK, '').trim());
    else items[items.length - 1] = `${items[items.length - 1]} ${line}`;
    open = true;
  }
  return items.filter((s) => !NO_ITEM_RE.test(s));
}

/** Items of Ďalší krok (spec 9 P-011: one or more), [] without a step; null for a handover without the section. */
export function handoverNextStep(text) {
  return sectionItems(text, NEXT_SECTION);
}

/** Items of Otvorené otázky; null for a handover without the section. */
export const handoverQuestions = (text) => sectionItems(text, QUESTIONS_SECTION);
/** Items of Úlohy pre operátora; null for a handover without the section. */
export const handoverTasks = (text) => sectionItems(text, TASKS_SECTION);

/**
 * Counts of the items of the handover (Stop hook, spec 10.3 item 1: the blocks Otázky and Úlohy have as many items as the
 * sections): { next, questions, tasks }; a count is null when its section is missing (an invalid handover).
 */
export function handoverCounts(text) {
  const n = (items) => (items === null ? null : items.length);
  return { next: n(handoverNextStep(text)), questions: n(handoverQuestions(text)), tasks: n(handoverTasks(text)) };
}

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
// path only, no brain root, so the caller names the version of the brain (default 1) and the role of the repo (the
// knowledge of a project repo in layout 3 is in .brain/, scripts/repo-knowledge.mjs).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AGENTIC_OWNER = 'agentic';
const CHECKS = new Map();
function checksFor(version = 1, role = ROLE_BRAIN) {
  const key = `${version}/${role}`;
  if (CHECKS.has(key)) return CHECKS.get(key);
  const map = layoutFor(version, role);
  const L = Object.fromEntries(['local', 'topics', 'handover', 'skills', 'exceptions', 'memory', 'decisions'].map((n) => [n, esc(map[n])]));
  const c = {
    map,
    HANDOVER_PATH: new RegExp(`^${L.topics}/[^/]+/${L.handover}$`),
    AGENTIC_SKILL_PATH: new RegExp(`^${L.skills}/${AGENTIC_OWNER}/[^/]+/SKILL\\.md$`),
    SKILL_PATH: new RegExp(`^${L.skills}/[^/]+/[^/]+/SKILL\\.md$`),
    EXCEPTION_PATH: new RegExp(`^${L.exceptions}/[^/]+\\.md$`),
    RECORD_PATH: new RegExp(`^(${L.memory}|${L.decisions})/[^/]+\\.md$`),
  };
  CHECKS.set(key, c);
  return c;
}

/** Check one brain file (relative posix path + content) of a brain in layout `version`. Returns list of error strings. */
export function checkBrainFile(relPath, content, { policy, hasOrigin = true, version = 1, role = ROLE_BRAIN } = {}) {
  const errors = [];
  const rel = relPath.replace(/\\/g, '/');
  const { map, HANDOVER_PATH, AGENTIC_SKILL_PATH, SKILL_PATH, EXCEPTION_PATH, RECORD_PATH } = checksFor(version, role);
  if (rel.startsWith(`${map.local}/`) || rel === map.local) errors.push(`${rel}: files in ${map.local}/ are never committed (P-018, P-039)`);
  // P-049 names the records the workflow names itself; documents and outside material (docs, materialy) keep any name
  // (operator 2026-11-15: a file of a person or from outside is not forced into a fixed form).
  const freeName = [map.docs, map.materialy].some((d) => d && rel.startsWith(`${d}/`));
  if (!freeName && (hasDiacritics(rel) || /[A-Z\s]/.test(rel.replace(/^[A-Z]:/, '')))) {
    // INDEX.md in the root of a repo of a layout that has one (2, 3) is generated by the workflow (scripts/data-index.mjs).
    if (!/^(README|SKILL|AGENTS)\.md$/.test(path.posix.basename(rel)) && !/\/(SKILL|README)\.md$/.test(rel) && !(map.index && rel === map.index)) {
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
