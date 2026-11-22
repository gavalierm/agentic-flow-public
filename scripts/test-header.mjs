// Test headers and their TTL (D-0061, D-0062, P-079): one parser for the workflow suite (tests/ttl.mjs) and for the tests
// of domain skills (save.mjs skill, skill-check). Every test file names in its first lines what it is:
//   // keep: core          a core test: irreversible damage, data loss, or a base flow; never expires
//   // keep: guarded       a lasting test run only when the code it guards changes; never expires
//   // ttl: YYYY-MM-DD     any other test (a test of one fix): removed after that day
// Operator 2026-11-22: domain skills gathered ~1550 tests in a week that nobody rotated (one worker run: 1309 tests).
// A skill test without a header expires 3 days after its last change (operator 2026-11-22).
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

/** Last commit day of each file under dir (names relative to dir), one git log for all; {} outside git. */
function lastChanges(dir) {
  const r = spawnSync('git', ['-C', dir, 'log', '--format=%x00%cs', '--name-only', '--relative', '--', '.'], { encoding: 'utf8' });
  const out = {};
  if (r.status !== 0) return out;
  for (const chunk of r.stdout.split('\0')) {
    const [day, ...files] = chunk.split('\n').filter(Boolean);
    for (const f of files) if (!(f in out)) out[f] = day;
  }
  return out;
}

/**
 * Tests of one skill folder: [{ file, expires }] with expires = the ttl, or for a file without a valid header its last
 * commit + UNTAGGED_TTL_DAYS (an uncommitted file counts from today); tests with "// keep:" are left out. read(file): its content.
 */
export function skillTests(dir, files, read) {
  const tests = files.filter((f) => TEST_FILE.test(f));
  if (!tests.length) return [];
  const changed = lastChanges(dir);
  return tests.flatMap((file) => {
    const h = header(read(file));
    if (h.keep || h.guarded) return [];
    return [{ file, expires: h.ttl || addDays(changed[path.posix.basename(file)] || today(), UNTAGGED_TTL_DAYS), untagged: !h.ttl }];
  });
}
