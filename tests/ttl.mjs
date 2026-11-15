#!/usr/bin/env node
// Test headers and their TTL (D-0061, D-0062). Every test file names in its first lines what it is:
//   // keep: core          a core test: it guards against irreversible damage or data loss, or checks a base flow
//   // ttl: YYYY-MM-DD     any other test (a test of one fix): it is removed by `expire` after that day
// A new non-core test gets a ttl 30 days after it is written.
//   node tests/ttl.mjs check                       lists files without a valid header (exit 1) and the expired ones
//   node tests/ttl.mjs expire [--dry] [--today D]  git rm of every expired test in one commit; prints them
//   node tests/ttl.mjs run [--since <ref>]         the suite through scripts/test-slot.mjs (npm test); with --since only the
//                                                  core tests and the temporary tests whose guarded code changed (D-0085)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TTL_DAYS = 30;
const HEAD_LINES = 5;
const KEEP = /^\/\/ keep: core$/;
const TTL = /^\/\/ ttl: (\d{4}-\d{2}-\d{2})$/;

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

const validDate = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

/** Header of a test file: { keep } or { ttl } or { error } (the text says what to add). */
export function header(text) {
  const lines = text.split('\n').slice(0, HEAD_LINES).map((l) => l.trimEnd());
  const keep = lines.some((l) => KEEP.test(l));
  const ttls = lines.map((l) => TTL.exec(l)).filter(Boolean).map((m) => m[1]);
  if (keep && ttls.length) return { error: 'has both "// keep: core" and "// ttl:"; keep one' };
  if (keep) return { keep: true };
  if (ttls.length > 1) return { error: 'has more than one "// ttl:" line' };
  if (ttls.length) return validDate(ttls[0]) ? { ttl: ttls[0] } : { error: `ttl ${ttls[0]} is not a valid date` };
  return { error: `no header: add "// keep: core" (core test) or "// ttl: YYYY-MM-DD" (test of a fix, ${DEFAULT_TTL_DAYS} days from today) in the first ${HEAD_LINES} lines` };
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Every test file with its header; expired = ttl before `day`. */
export function survey(root = ROOT, day = today()) {
  return testFiles(root).map((file) => {
    const h = header(fs.readFileSync(path.join(root, file), 'utf8'));
    return { file, ...h, expired: !!h.ttl && h.ttl < day };
  });
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Removes the expired tests with git rm in one commit of its own. Returns the removed files. */
export function expire(root = ROOT, { day = today(), dry = false } = {}) {
  const gone = survey(root, day).filter((t) => t.expired);
  if (!gone.length || dry) return gone;
  const staged = git(root, ['diff', '--cached', '--name-only']).trim();
  if (staged) throw new Error(`staged changes would go into the expire commit: ${staged.split('\n').join(', ')}`);
  git(root, ['rm', '-q', '--', ...gone.map((t) => t.file)]);
  const body = gone.map((t) => `${t.file} (ttl ${t.ttl})`).join('\n');
  git(root, ['commit', '-q', '-m', `tests: remove ${gone.length} test file(s) past their ttl\n\n${body}`]);
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
  const temporary = all.filter((t) => !t.keep).map((t) => t.file);
  const shared = SHARED.filter((f) => changed.has(f));
  let picked = temporary;
  if (!shared.length) {
    const g = guarded(root, temporary);
    picked = temporary.filter((t) => changed.has(t) || [...g.get(t)].some((f) => changed.has(f)));
  }
  return { files: [...core, ...picked].sort(), core, temporary, picked, shared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const day = opt('--today') || today();
  if (cmd === 'check') {
    const all = survey(ROOT, day);
    const bad = all.filter((t) => t.error);
    for (const t of bad) console.log(`${t.file}: ${t.error}`);
    for (const t of all.filter((x) => x.expired)) console.log(`${t.file}: expired (ttl ${t.ttl}), removed by: node tests/ttl.mjs expire`);
    console.log(`${all.length} test file(s): ${all.filter((t) => t.keep).length} core, ${all.filter((t) => t.ttl).length} with ttl, ${bad.length} without a valid header`);
    process.exit(bad.length ? 1 : 0);
  } else if (cmd === 'expire') {
    try {
      const gone = expire(ROOT, { day, dry: rest.includes('--dry') });
      for (const t of gone) console.log(`${rest.includes('--dry') ? 'would remove' : 'removed'} ${t.file} (ttl ${t.ttl})`);
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
      try { s = selectSince(ROOT, since); } catch (e) { console.error(`run: ${e.message}`); process.exit(2); }
      const why = s.shared.length ? `; shared infrastructure changed: ${s.shared.join(', ')}` : '';
      console.log(`tests: core ${s.core.length} + changed ${s.picked.length} of ${s.temporary.length} temporary (since ${since}${why})`);
      files = s.files;
    }
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-slot.mjs'), '--', 'node', '--test', ...files], { cwd: ROOT, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  } else {
    console.error('usage: node tests/ttl.mjs check | expire [--dry] [--today YYYY-MM-DD] | run [--since <ref>]');
    process.exit(2);
  }
}
