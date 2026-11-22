// Test headers and their TTL (D-0061, D-0062, P-079): one parser for the workflow suite (tests/ttl.mjs) and for the tests
// of domain skills (save.mjs skill, skill-check). Every test file names in its first lines what it is:
//   // keep: core          a core test: irreversible damage, data loss, or a base flow; never expires
//   // keep: guarded       a lasting test run only when the code it guards changes; never expires
//   // ttl: YYYY-MM-DD     any other test (a test of one fix): removed after that day
// Operator 2026-11-22: domain skills gathered ~1550 tests in a week that nobody rotated (one worker run: 1309 tests).
// A skill test without a header expires 3 days after its last change (operator 2026-11-22).
//
// The test budget (operator 2026-11-22: "tests, their piling up and their irrelevance: we solve it for the x-th time"). Every
// round before limited only the temporary class, and the class is the author's own word: the core grew from 26 to 42 files
// in three days, six tests took a ttl of six months, and a domain agent marked 117 of 117 skill tests "keep" on the day
// the header became mandatory. So the amount is bound by code, per unit (a repo, a skill), in lines of test code:
//   lasting    keep: core first, then keep: guarded, the oldest first, while they fit KEEP_SHARE of the unit's code lines;
//              a "keep" test that does not fit counts as temporary
//   temporary  lives to its ttl, at most DEFAULT_TTL_DAYS after its first commit (a later date in the header does not
//              count); the newest ones that fit TEMP_SHARE of the code lines stay, the older ones leave
// Nothing asks and nothing is refused: the gate that already rotates (the release, a save of the skill) removes what is over.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { today } from './util.mjs';

export const DEFAULT_TTL_DAYS = 30;
/** Days a skill test without a header lives after its last change (operator 2026-11-22). */
export const UNTAGGED_TTL_DAYS = 3;
const HEAD_LINES = 5;
const KEEP = /^\/\/ keep: (core|guarded)$/;
const TTL = /^\/\/ ttl: (\d{4}-\d{2}-\d{2})$/;
/** A node:test file of a skill (the scripts a skill may hold: .mjs, .js). */
export const TEST_FILE = /\.test\.(mjs|js)$/;
/** A test under another name is a test too (the budget counts what runs node:test, not what the file is called). */
const NODE_TEST = /^\s*import\b[^\n]*['"]node:test['"]|\brequire\(\s*['"]node:test['"]\s*\)/m;
export const isTestFile = (file, text = '') => TEST_FILE.test(file) || (/\.(mjs|js)$/.test(file) && NODE_TEST.test(text));
/** Code a unit holds (its tests are measured against it). */
export const CODE_FILE = /\.(mjs|js|sh|py)$/;
/** Share of the unit's code lines its lasting and its temporary tests may take, and the least a small unit gets. */
export const KEEP_SHARE = 0.2;
export const TEMP_SHARE = 0.1;
export const KEEP_FLOOR = 500;
export const TEMP_FLOOR = 250;
export const lineCount = (text) => { const t = String(text || ''); return t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; };
/** The budget of a unit with `codeLines` of code; `set` gives fixed numbers (a repo whose risk is not its size: the mail). */
export const testBudget = (codeLines, set = {}) => ({
  keepLines: set.keepLines ?? Math.max(KEEP_FLOOR, Math.round(codeLines * KEEP_SHARE)),
  tempLines: set.tempLines ?? Math.max(TEMP_FLOOR, Math.round(codeLines * TEMP_SHARE)),
});

export { today };
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const validDate = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

/** Header of a test file: { keep } or { guarded } or { ttl } or { error } (the text says what to add). */
export function header(text) {
  const lines = String(text).split('\n').slice(0, HEAD_LINES).map((l) => l.trimEnd());
  const kinds = lines.map((l) => KEEP.exec(l)).filter(Boolean).map((m) => m[1]);
  const keep = kinds.length > 0;
  const ttls = lines.map((l) => TTL.exec(l)).filter(Boolean).map((m) => m[1]);
  if (keep && ttls.length) return { error: `has both "// keep: ${kinds[0]}" and "// ttl:"; keep one` };
  if (kinds.length > 1) return { error: 'has more than one "// keep:" line' };
  if (keep) return kinds[0] === 'core' ? { keep: true } : { guarded: true };
  if (ttls.length > 1) return { error: 'has more than one "// ttl:" line' };
  if (ttls.length) return validDate(ttls[0]) ? { ttl: ttls[0] } : { error: `ttl ${ttls[0]} is not a valid date` };
  return { error: `no header: add "// keep: core" (core test), "// keep: guarded" (lasting, run when its code changes) or "// ttl: YYYY-MM-DD" (test of a fix, ${DEFAULT_TTL_DAYS} days from today) in the first ${HEAD_LINES} lines` };
}

/**
 * First and last commit day of each file under dir (names relative to dir), one git log; {} outside git. The first day
 * follows renames (a rename does not renew a test) and stops at a removal (a file added again is a new file).
 */
export function commitDays(dir) {
  const r = spawnSync('git', ['-C', dir, 'log', '-M', '--format=%x00%cs', '--name-status', '--relative', '--', '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const added = {};
  const changed = {};
  if (r.status !== 0) return { added, changed };
  const now = new Map(); // a name in older history -> the name of today
  const closed = new Set(); // names whose older history is another file's
  for (const chunk of r.stdout.split('\0')) {
    const [day, ...rows] = chunk.split('\n').filter(Boolean);
    for (const row of rows) {
      const [st, a, b] = row.split('\t');
      const name = now.get(b || a) || b || a;
      if (closed.has(name)) continue;
      if (st === 'D') { if (name in added) closed.add(name); continue; }
      if (!(name in changed)) changed[name] = day;
      added[name] = day;
      if (st.startsWith('R')) { now.delete(b); now.set(a, name); }
    }
  }
  return { added, changed };
}

const byDayThenName = (a, b) => (a.added || '9999').localeCompare(b.added || '9999') || a.file.localeCompare(b.file);

/**
 * What stays and what leaves. tests: [{ file, text, added, changed, pinned, fresh }] (added, changed: commit days, none for
 * a file not committed yet; pinned: it cannot leave, e.g. the skill text names it, and it takes lasting room first;
 * fresh: a file of this very save, counted but not removed now). untaggedDays: the life of a test without a header
 * after its last change (a skill); null leaves such a test to the caller (a repo refuses it).
 * Returns { rows, budget, keepUsed, tempUsed }; a row: { file, lines, head, lasting, demoted, expires, gone }, gone is
 * 'expired' or 'budget'.
 */
export function plan(tests, budget, { day = today(), untaggedDays = UNTAGGED_TTL_DAYS } = {}) {
  const rows = tests.map((t) => ({ file: t.file, lines: lineCount(t.text), head: header(t.text), added: t.added || null, changed: t.changed || null, pinned: !!t.pinned, fresh: !!t.fresh }));
  const rank = (r) => (r.pinned ? 0 : r.head.keep ? 1 : 2);
  let keepUsed = 0;
  for (const r of rows.filter((x) => x.pinned || x.head.keep || x.head.guarded).sort((a, b) => rank(a) - rank(b) || byDayThenName(a, b))) {
    if (r.pinned || keepUsed + r.lines <= budget.keepLines) { r.lasting = true; keepUsed += r.lines; } else r.demoted = true;
  }
  const temporary = rows.filter((r) => !r.lasting);
  for (const r of temporary) {
    const cap = addDays(r.added || day, DEFAULT_TTL_DAYS);
    if (r.head.error) { if (untaggedDays !== null) r.expires = addDays(r.changed || day, untaggedDays); } else r.expires = r.head.ttl && r.head.ttl < cap ? r.head.ttl : cap;
    if (r.expires && r.expires < day && !r.fresh) r.gone = 'expired';
  }
  let tempUsed = 0;
  for (const r of temporary.filter((x) => !x.gone).sort((a, b) => byDayThenName(b, a))) {
    if (r.fresh || !r.expires || tempUsed + r.lines <= budget.tempLines) tempUsed += r.lines; else r.gone = 'budget';
  }
  return { rows, budget, keepUsed, tempUsed };
}

/** The first names of a long list (61 files of one skill left at once: the line stays readable). */
const some = (names, n = 8) => (names.length > n ? `${names.slice(0, n).join(', ')} and ${names.length - n} more` : names.join(', '));

/** One line of the budget for the author: the use, what leaves, and what a "keep" test that found no room is. */
export function budgetLine(p, gate) {
  const lasting = p.rows.filter((r) => r.lasting);
  const temp = p.rows.filter((r) => !r.lasting && !r.gone);
  const demoted = p.rows.filter((r) => r.demoted);
  const gone = p.rows.filter((r) => r.gone);
  const parts = [`test budget (P-079): lasting ${p.keepUsed} of ${p.budget.keepLines} lines (${lasting.length} file(s)), temporary ${p.tempUsed} of ${p.budget.tempLines} lines (${temp.length} file(s))`];
  if (gone.length) parts.push(`${gone.length} file(s) leave at ${gate}: ${some(gone.map((r) => `${path.posix.basename(r.file)} (${r.gone === 'budget' ? 'over the budget' : `expired ${r.expires}`})`))}`);
  if (demoted.length) parts.push(`${demoted.length} "// keep:" file(s) found no lasting room and count as temporary: ${some(demoted.map((r) => path.posix.basename(r.file)))}; "// keep: core" takes room before "// keep: guarded", then the oldest; to keep another test remove a lasting one`);
  if (gone.length || demoted.length) parts.push('the budget is fixed by the workflow (operator 2026-11-22): do not restore removed tests and do not ask the operator; a removed test is in git');
  return parts.join('; ');
}

/**
 * The plan of one skill folder, or null when it holds no test. pinned(file): the skill text names it; fresh: { name:
 * content } of the files of this save; skip: the files this save removes.
 */
export function skillPlan(dir, { pinned = () => false, fresh = {}, skip = [], day = today() } = {}) {
  const texts = {};
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { /* a new skill */ }
  for (const f of names) {
    if (!CODE_FILE.test(f) || skip.includes(f) || f in fresh) continue;
    try { texts[f] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { /* removed meanwhile */ }
  }
  const all = { ...texts, ...Object.fromEntries(Object.entries(fresh).filter(([f]) => CODE_FILE.test(f))) };
  const tests = Object.keys(all).filter((f) => isTestFile(f, all[f]));
  if (!tests.length) return null;
  const code = Object.keys(all).filter((f) => !tests.includes(f)).reduce((n, f) => n + lineCount(all[f]), 0);
  const days = commitDays(dir);
  return plan(tests.map((file) => ({ file, text: all[file], added: days.added[file], changed: days.changed[file], pinned: pinned(file), fresh: file in fresh })), testBudget(code), { day });
}
