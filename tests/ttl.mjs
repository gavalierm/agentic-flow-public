#!/usr/bin/env node
// Test headers and their TTL (D-0061, D-0062; parser in scripts/test-header.mjs). Every test file names in its first lines what it is:
//   // keep: core          a core test: it guards against irreversible damage or data loss, or checks a base flow
//   // keep: guarded       a lasting test run only when the code it guards changes (operator 2026-11-17, P-079: a costly
//                          test of a rarely changed part, e.g. a migration, ran at every release); never expires
//   // ttl: YYYY-MM-DD     any other test (a test of one fix): it is removed by `expire` after that day
// A new non-core test gets a ttl 30 days after it is written.
// The amount of tests is bound by the test budget of the repo (scripts/test-header.mjs, operator 2026-11-22): the lasting
// tests that fit stay lasting, a temporary test lives at most 30 days after its first commit, and of the temporary ones
// the newest that fit stay. `expire` removes the rest at the release; nobody decides it by hand.
//   node tests/ttl.mjs check                       lists files without a valid header (exit 1), the budget and what leaves
//   node tests/ttl.mjs expire [--dry] [--today D]  git rm of every test past its day or over the budget, one commit
//   --root <dir>                                   another repo (the mail has no copy of this script)
//   node tests/ttl.mjs run [--since <ref>]         the suite through scripts/test-slot.mjs (npm test); with --since only the
//                                                  core tests and the guarded and temporary tests whose guarded code
//                                                  changed (D-0085)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { DEFAULT_TTL_DAYS, header, today } from '../scripts/test-header.mjs';
import { today, plan, testBudget, commitDays, budgetLine, lineCount, CODE_FILE } from '../scripts/test-header.mjs';

/** Test files npm test runs (tests/**\/*.test.mjs), repo-relative, sorted. */
export function testFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.test.mjs')) out.push(r);
    }
  };
  walk('tests');
  return out.sort();
}

/**
 * The budget of the repo: shares of its tracked code lines outside tests/ (scripts/test-header.mjs), or the fixed numbers
 * of package.json "testBudget" { keepLines, tempLines } (the mail: its risk is the delivery, not its size).
 */
export function repoBudget(root = ROOT) {
  let set = {};
  try { set = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).testBudget || {}; } catch { /* no package.json */ }
  if (set.keepLines != null && set.tempLines != null) return testBudget(0, set);
  let code = 0;
  for (const file of git(root, ['ls-files']).split('\n')) {
    if (!CODE_FILE.test(file) || file.startsWith('tests/') || file.startsWith('scratch/')) continue;
    try { code += lineCount(fs.readFileSync(path.join(root, file), 'utf8')); } catch { /* removed, not committed yet */ }
  }
  return testBudget(code, set);
}

/** The plan of the repo's tests against its budget (scripts/test-header.mjs plan); a test without a header is refused, not rotated. */
export function repoPlan(root = ROOT, day = today()) {
  const days = commitDays(path.join(root, 'tests'));
  const rel = (file) => file.slice('tests/'.length);
  return plan(testFiles(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8'), added: days.added[rel(file)], changed: days.changed[rel(file)] })), repoBudget(root), { day, untaggedDays: null });
}

/**
 * Every test file with what it is now: keep (a lasting core test), guarded (a lasting guarded test), ttl (the day a
 * temporary test leaves; a "// keep:" test that found no lasting room is temporary), error (no valid header);
 * expired = it leaves now (past its day, or over the budget: `reason`).
 */
export function survey(root = ROOT, day = today(), p = repoPlan(root, day)) {
  return p.rows.map((r) => ({
    file: r.file,
    ...(r.head.error ? { error: r.head.error } : r.lasting ? (r.head.keep ? { keep: true } : { guarded: true }) : { ttl: r.expires }),
    expired: !!r.gone,
    ...(r.gone ? { reason: r.gone === 'budget' ? 'over the budget' : `ttl ${r.expires}` } : {}),
  }));
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Removes the tests past their day or over the budget with git rm in one commit of its own. Returns the removed files. */
export function expire(root = ROOT, { day = today(), dry = false } = {}) {
  const gone = survey(root, day).filter((t) => t.expired);
  if (!gone.length || dry) return gone;
  const staged = git(root, ['diff', '--cached', '--name-only']).trim();
  if (staged) throw new Error(`staged changes would go into the expire commit: ${staged.split('\n').join(', ')}`);
  git(root, ['rm', '-q', '--', ...gone.map((t) => t.file)]);
  const body = gone.map((t) => `${t.file} (${t.reason})`).join('\n');
  git(root, ['commit', '-q', '-m', `tests: remove ${gone.length} test file(s) past their ttl or over the test budget\n\n${body}`]);
  return gone;
}

// Selection of the temporary tests (agent-alice/D-0085: a temporary test runs only when the code it guards changes). Cause:
// every topic close ran all temporary tests (40 on 2026-11-15), also when the topic did not touch their code.
/** Shared test infrastructure: a change of one of these runs the whole suite. */
export const SHARED = ['tests/helpers.mjs', 'package.json', 'tests/ttl.mjs', 'scripts/test-slot.mjs'];

const guardable = (f) => !f.startsWith('tests/') && !f.endsWith('.md');
const IMPORT = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

/** Repo-relative files a test imports directly (relative imports only). */
export function imports(file, text) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT)) out.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1] || m[2] || m[3])));
  return out;
}

/**
 * Guarded files of each test, without a header of their own (so the existing tests have them too): (a) the files outside
 * tests/ and not *.md of the commit that added the test, renames followed; (b) the files it imports directly.
 * One git log for all tests, not one per test.
 */
export function guarded(root, files) {
  const out = new Map(files.map((f) => [f, new Set()]));
  const want = new Map(files.map((f) => [f, f])); // name in older history -> test file
  for (const chunk of git(root, ['log', '-M', '--name-status', '--format=%x00']).split('\0')) {
    if (!want.size) break;
    const rows = chunk.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const touched = rows.map((r) => r[r.length - 1]);
    for (const [st, a, b] of rows) {
      if (st === 'A' && want.has(a)) {
        const t = want.get(a);
        for (const f of touched) if (guardable(f)) out.get(t).add(f);
        want.delete(a);
      } else if (st.startsWith('R') && want.has(b)) {
        want.set(a, want.get(b));
        want.delete(b);
      }
    }
  }
  for (const f of files) for (const i of imports(f, fs.readFileSync(path.join(root, f), 'utf8'))) out.get(f).add(i);
  return out;
}

/**
 * Files outside tests/ that import one of `targets` directly. A changed file no test guards (a new file, logic moved out
 * of a tested one: the lock left config.mjs and the release that changed only the lock picked 0 of 92 tests, v2.0.71) is
 * tested through its users. Not the whole import chain: through tests/helpers.mjs it reaches 124 of 135 tests.
 */
export function importers(root, targets) {
  const out = new Set();
  for (const file of git(root, ['ls-files', '*.mjs']).split('\n')) {
    if (!file || file.startsWith('tests/')) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const i of imports(file, text)) if (targets.has(i)) { out.add(file); break; }
  }
  return out;
}

/** Files changed in <ref>..HEAD (from their merge base) and not committed yet, untracked ones too. */
export function changedSince(root, ref) {
  const base = git(root, ['merge-base', ref, 'HEAD']).trim();
  const lines = (s) => s.split('\n').filter(Boolean);
  return new Set([...lines(git(root, ['diff', '--name-only', base])), ...lines(git(root, ['ls-files', '--others', '--exclude-standard']))]);
}

/** Tests to run since <ref>: { files, core, temporary, picked, shared } (shared: changed infrastructure, all run). */
export function selectSince(root, ref) {
  const all = survey(root);
  const changed = changedSince(root, ref);
  const core = all.filter((t) => t.keep).map((t) => t.file);
  // Guarded lasting tests are picked like the temporary ones (they only never expire).
  const temporary = all.filter((t) => !t.keep).map((t) => t.file);
  // The version line of package.json (every release changes it) is no change of the test infrastructure: it ran the whole
  // suite at every release (170 s, 2026-11-17).
  if (changed.has('package.json')) {
    const base = git(root, ['merge-base', ref, 'HEAD']).trim();
    const lines = git(root, ['diff', '-U0', base, '--', 'package.json']).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (lines.length && lines.every((l) => /^[+-]\s*"version":/.test(l))) changed.delete('package.json');
  }
  const shared = SHARED.filter((f) => changed.has(f));
  let picked = temporary;
  if (!shared.length) {
    const g = guarded(root, temporary);
    const known = new Set([...g.values()].flatMap((set) => [...set]));
    const unguarded = new Set([...changed].filter((f) => guardable(f) && f.endsWith('.mjs') && !known.has(f)));
    const users = unguarded.size ? importers(root, unguarded) : unguarded;
    picked = temporary.filter((t) => changed.has(t) || [...g.get(t)].some((f) => changed.has(f) || users.has(f)));
  }
  return { files: [...core, ...picked].sort(), core, temporary, picked, shared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const day = opt('--today') || today();
  const root = opt('--root') ? path.resolve(opt('--root')) : ROOT;
  if (cmd === 'check') {
    const p = repoPlan(root, day);
    const all = survey(root, day, p);
    const bad = all.filter((t) => t.error);
    for (const t of bad) console.log(`${t.file}: ${t.error}`);
    console.log(`${all.length} test file(s): ${all.filter((t) => t.keep).length} core, ${all.filter((t) => t.guarded).length} guarded, ${all.filter((t) => t.ttl).length} temporary, ${bad.length} without a valid header`);
    console.log(budgetLine(p, 'the next release (node tests/ttl.mjs expire)'));
    process.exit(bad.length ? 1 : 0);
  } else if (cmd === 'expire') {
    try {
      const gone = expire(root, { day, dry: rest.includes('--dry') });
      for (const t of gone) console.log(`${rest.includes('--dry') ? 'would remove' : 'removed'} ${t.file} (${t.reason})`);
      console.log(gone.length ? `expired: ${gone.length}` : 'expired: none');
    } catch (e) {
      console.error(`expire: ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'run') {
    let files = ['tests/**/*.test.mjs'];
    if (rest.includes('--since')) {
      const since = opt('--since');
      if (!since) { console.error('run: --since needs a git ref'); process.exit(2); }
      let s;
      try { s = selectSince(root, since); } catch (e) { console.error(`run: ${e.message}`); process.exit(2); }
      const why = s.shared.length ? `; shared infrastructure changed: ${s.shared.join(', ')}` : '';
      console.log(`tests: core ${s.core.length} + changed ${s.picked.length} of ${s.temporary.length} guarded or temporary (since ${since}${why})`);
      files = s.files;
    }
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-slot.mjs'), '--', 'node', '--test', ...files], { cwd: root, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  } else {
    console.error('usage: node tests/ttl.mjs check | expire [--dry] [--today YYYY-MM-DD] | run [--since <ref>]   [--root <repo>]');
    process.exit(2);
  }
}
