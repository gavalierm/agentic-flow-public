#!/usr/bin/env node
// Single entry point for writing knowledge (P-013, P-007, P-031, P-009, P-008, P-035, P-032, P-011).
// The agent classifies; this script only writes in a fixed format, deduplicates via find, commits via brain.mjs, regenerates indexes.
//   save.mjs memory <type> <name> --content "..." [--origin operator|derived|observed] [--aliases a,b] [--relates-to x,y] [--sources f1,f2] [--summary "..."] [--new]
//   save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y [--supersedes D-0001]
//   save.mjs decision --remove D-XXXX [--repo [<repo>]] --reason "operator <YYYY-MM-DD>: <why>"   only on an explicit operator order (P-008)
//   save.mjs rule <name> [--repo [<repo>]] --content "..." (--enforced-by <file>[:<symbol>][,...] | --unenforced "<why code cannot check it>") [--title "..."] | --remove --reason "..."
//   save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local] [--title "..."]
//   save.mjs skill <name> --description "..." --content "..." --origin error|routine [--aliases a,b] [--script <file>[,<file>]] [--replace | --sed 's/<pattern>/<replacement>/[gim]' ...] (existing skill: --script alone keeps the body) [--from-procedure <name>] [--from-sequence <seq>] | --remove --reason "..."
//   save.mjs handover <topic> (--task ".." --done "a; b" --next ".." --files "a; b" --questions "a; b" | --file <path>)
//   save.mjs docs [--message "..."]   persona only: commits the files written directly into docs/ (P-024)
//   memory, decision, rule, skill: --repo [<name>] writes into <repo>/agentic/ of the domain (bare: the session repo); --brain "<why>" keeps a repo's record in brain
//   save.mjs handover --repo [<name>] (--file <path> | --content "...")   state of the repo: <repo>/agentic/HANDOVER.md
//   save.mjs move <brain path> --repo <name> [--dry-run]   moves a brain record (memory, decision, agentic skill) into the repo
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lfBytes } from '../scripts/eol.mjs';
import { spawnSync } from 'node:child_process';
import { parseArgs, fail, today, readText, listFiles, relPosix } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, dialogAnsweredInTurn, machineName, foreignProjectCwd, readThreadState, resolveBrain, brainExists, projectPolicy } from '../scripts/config.mjs';
import { brainWrite, formatWriteResult, syncAndCheckHolder, checkHolder } from '../scripts/brain.mjs';
import { parseFrontmatter, serializeFrontmatter, asList } from '../scripts/frontmatter.mjs';
import { makeKey, normalizeKey, hasDiacritics, isValidId, KEY_TYPES } from '../scripts/keys.mjs';
import { find, findSimilar } from '../scripts/find.mjs';
import { readDecisions, readSkills, nextDecisionId } from '../scripts/records.mjs';
import { DECISION_REMOVED_ENV } from './brain-precommit.mjs';
import { recordAuthors, foreignAuthor } from '../scripts/authors.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { ruleCorpus, judgeRule, unanswered, onlyCondenses } from '../scripts/rule-gate.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { renderHandover, checkHandover, handoverNextStep, withReports } from '../scripts/brain-checks.mjs';
import { openReportLines, baseOf } from '../scripts/issue-watch.mjs';
import { reminderStep, armedSchedule, REMINDER_REFUSAL } from '../scripts/waker.mjs';
import { removeNames } from '../scripts/logs.mjs';
import { setTopicState, readTopic } from '../scripts/topic.mjs';
import { workflowSkillNames, PROJECT_SKILLS_DIR, syncBrainSkills } from '../scripts/skills-sync.mjs';
import { skillSources, PROJECT_KNOWLEDGE, REPO_HANDOVER, domainRepos, repoByName, sessionRepo, singleRepoOf, nextRepoDecisionId, repoWrite, formatRepoWrite, heldRepoTopic, repoPublic } from '../scripts/repo-knowledge.mjs';
import { checkSkill, meaningDiff } from '../scripts/skill-check.mjs';
import { machineStores, machineRecords, targetStore, sameStore, checkDecisionRefs, decisionRefs, rewriteDecisionRefs, subjectMatch, saveHint, displayPath, refFiles, SUBJECT_TYPES, ID_LINE, lc } from '../scripts/stores.mjs';

const args = parseArgs(process.argv.slice(2));
// Every --sed applies, in order: parseArgs keeps only the last value of a repeated option (2026-11-12: two --sed in one
// call changed only the second text and reported the skill as edited).
const SEDS = process.argv.slice(2).flatMap((a, i, all) => (a === '--sed' && all[i + 1] !== undefined && !/^--[a-z]/i.test(all[i + 1]) ? [all[i + 1]] : a.startsWith('--sed=') ? [a.slice(6)] : []));
const [category, ...rest] = args._;
const out = (s) => process.stdout.write(s + '\n');
const toPosixPath = (p) => String(p).replace(/\\/g, '/');

// override: Map of absolute path -> content for a file not written yet (the new place of a moved record).
function fingerprint(projectDir, sources, override = null) {
  const h = createHash('sha1');
  for (const s of sources) {
    const file = path.resolve(projectDir, s);
    const pending = override?.get(file);
    h.update(s + '\n');
    h.update(pending !== undefined ? lfBytes(Buffer.from(pending)) : fs.existsSync(file) ? lfBytes(fs.readFileSync(file)) : Buffer.from('missing'));
  }
  return h.digest('hex').slice(0, 12);
}

// Skill scripts (--script): node, shell or Python (agentic-flow-public#24: a procedure built on a Python script). The
// runner is printed with the deployed path; Python is `python` on Windows (python3 is the Store alias there), else python3.
const SKILL_SCRIPT = /^[a-z0-9][a-z0-9._-]*\.(mjs|js|sh|py)$/;
const SKILL_SCRIPT_TYPES = '.mjs | .js | .sh | .py';
// A .sh script with a bash shebang (arrays, [[ ]]) runs as bash: sh (dash) breaks it (Alice 2026-11-09).
// P-049: a script name says what the script does, in English. Each token of the basename (split on - _ .) is an English
// word (system word list, also with a trailing s/es/ed/ing stripped), short (1-3 chars) or with a digit, a built-in tech
// term, or a word of the skill text (product names; the script file names are removed from that text first).
// Machines without a word list (macOS, Windows) skip the token check: only the SKILL_SCRIPT charset check applies there.
const TECH_TERMS = new Set(['api', 'cli', 'json', 'csv', 'ftp', 'sftp', 'ssh', 'dns', 'url', 'http', 'https', 'npm', 'git', 'github', 'cloudflare', 'wrangler', 't3', 'mcp', 'repo', 'config', 'sync', 'env', 'auth', 'dev', 'prod', 'src', 'tmp', 'yaml', 'html', 'css', 'sql', 'regex', 'stdin', 'stdout', 'webhook', 'oauth', 'ssl', 'tls', 'cron', 'docker', 'lint', 'init', 'async', 'unix', 'linux', 'macos', 'xml', 'pdf', 'png', 'jpg', 'svg', 'utf']);
let wordListCache;
function wordList() {
  if (wordListCache !== undefined) return wordListCache;
  try { wordListCache = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean)); } catch { wordListCache = null; }
  return wordListCache;
}
// Returns the tokens of the script name that are not English (empty = fine, or no word list on this machine).
export function nonEnglishScriptTokens(base, skillText = '', scriptNames = [base], words = wordList()) {
  if (!words) return [];
  let text = String(skillText);
  // Script names with and without the extension do not count, nor paths (skill folder names are often Slovak:
  // dev-nahlad-tunel/nahlad.sh passed on its own folder name, 2026-11-11).
  for (const n of new Set([base, ...scriptNames])) text = text.split(n).join(' ').split(n.replace(/\.[^.]+$/, '')).join(' ');
  text = text.replace(/[^\s`'"()]*\/[^\s`'"()]*/g, ' ');
  // Only a capitalized word (a product name: Cloudflare, Beszel) or an upper-case identifier part (ZENTRA_KEY) of the
  // text counts, not Slovak prose without diacritics.
  const capitalized = text.match(/(?<![\p{L}\d])\p{Lu}[a-z0-9]+(?![\p{L}\d])/gu) || [];
  const upper = text.match(/(?<![\p{L}\d])[A-Z][A-Z0-9]{3,}(?![\p{Ll}])/gu) || [];
  const inText = new Set([...capitalized, ...upper].map((w) => w.toLowerCase()));
  const known = (t) => words.has(t) || TECH_TERMS.has(t) || inText.has(t) || (t.startsWith('re') && t.length > 5 && words.has(t.slice(2)));
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
  return stem.split(/[-_.]+/).filter(Boolean).filter((t) => {
    if (t.length <= 3 || /\d/.test(t)) return false;
    if (known(t)) return false;
    for (const suf of ['s', 'es', 'ed', 'ing']) if (t.endsWith(suf) && t.length > suf.length + 1 && known(t.slice(0, -suf.length))) return false;
    return true;
  });
}
function checkScriptName(src, base, skillText, scriptNames) {
  const bad = nonEnglishScriptTokens(base, skillText, scriptNames);
  if (bad.length) fail(`--script ${src}: the name must be English; not English: ${bad.join(', ')}. Name the action and its target, e.g. \`deploy-cloudflare.sh\`, not \`nasad-produkciu.sh\` or \`deploy-production.sh\` (P-049)`);
}

export function scriptRunner(base, platform = process.platform, content = '') {
  if (base.endsWith('.sh')) return /^#!.*\bbash\b/.test(String(content).split('\n', 1)[0]) ? 'bash' : 'sh';
  if (base.endsWith('.py')) return platform === 'win32' ? 'python' : 'python3';
  return 'node';
}

/**
 * Deploy the saved skill into the project now (skills-sync, as at session start): the path printed by
 * "script runs as" exists right after the save, not only at the next session (Bob 2026-11-08: only SKILL.md was there).
 * Returns null when deployed, else the reason.
 */
function deploySkills(ctx) {
  if (!ctx.brainDir || !ctx.projectDir) return 'no brain or project';
  try { syncBrainSkills({ projectDir: ctx.projectDir, brainDir: ctx.brainDir, repoSources: skillSources(ctx), domainBrainDir: ctx.layers?.projectBrain ? ctx.layers.domainBrain : null }); return null; }
  catch (err) { return err.message; }
}

function finish(ctx, res, paths) {
  out(formatWriteResult(res, paths));
  const idx = buildIndexes(ctx.brainDir, ctx.policy);
  for (const w of idx.warnings) out(`limit: ${w}`);
  // P-022: the agent keeps its own rules within the limit; nobody else hands it the task (operator 2026-11-01).
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code', layers: ctx.layers });
  if (rules.overLimit.length) out(`limit: ${rules.overLimit.join('; ')}: condense your project rules after the current unit of work (skill workflow:consolidate; mandated by the workflow, not out of scope, P-002): merge overlapping ones, shorten wording, remove those a core principle covers (save rule <name> --remove --reason "superseded by P-XXX"), P-022`);
}

/**
 * Repo target of a save (D-0002, P-007 step 4): `--repo <name>` writes into `<repo>/agentic/`, bare `--repo` into the
 * session repo. Returns the repo name or null (brain).
 */
/** Memory types that never belong to one repo (D-0002 boundary: operator, people). */
const BRAIN_ONLY_TYPES = ['operator', 'person'];

function repoTarget(ctx) {
  if (args.repo === undefined) return null;
  if (args.brain !== undefined) fail('--repo and --brain exclude each other');
  const name = args.repo === true ? sessionRepo(ctx) : String(args.repo);
  if (!name) fail('--repo without a name: this session has no repo of its own (it runs in the brain); name it: --repo <name>');
  repoByName(ctx.domain, name, ctx.brainDir);
  return name;
}

/**
 * Brain is for knowledge of the persona, the operator, people, the environment and of several repos; one repo's own
 * knowledge goes into that repo. Code checks only what it can decide: a `project-<repo>` key is refused in brain, a
 * record whose references all point into one repo gets a note (the agent decides). `--brain "<why>"` keeps it in brain.
 */
function brainGuard(ctx, key, refs = []) {
  if (!ctx.domain) return;
  const why = typeof args.brain === 'string' ? args.brain.trim() : '';
  if (args.brain !== undefined && why.length < 10) fail('--brain needs the reason why this repo knowledge stays in brain (at least 10 characters)');
  if (why) return;
  const all = domainRepos(ctx.domain, ctx.brainDir);
  // The key is normalized (keys.mjs), so the repo name is compared normalized too (web_A is project-web-a).
  const repos = all.filter((r) => !repoPublic(r.dir)).map((r) => ({ name: r.name, key: normalizeKey(r.name) })).sort((a, b) => b.key.length - a.key.length);
  const own = repos.find((r) => key === `project-${r.key}` || String(key).startsWith(`project-${r.key}-`))?.name;
  if (own) fail(`${key} describes repo ${own}: its knowledge belongs to ${own}/${PROJECT_KNOWLEDGE}/ (add --repo ${own}); only when it is not knowledge of that repo alone: --brain "<why>" (D-0002, P-007)`);
  const one = singleRepoOf(ctx.domain, ctx.brainDir, refs);
  if (one && !all.some((r) => r.name === one && repoPublic(r.dir))) out(`note: looks like repo ${one} (every reference points into it): knowledge of that repo alone is saved with --repo ${one}; knowledge of several repos, people or the environment stays in brain (P-007)`);
}

/** Path of a record inside `<repo>/agentic/` from its brain-relative path, or null when it lies elsewhere. */
function knowledgeRel(ctx, recPath) {
  const abs = path.resolve(ctx.brainDir, recPath);
  const parts = toPosixPath(path.relative(ctx.domain.root, abs)).split('/');
  const i = parts.indexOf(PROJECT_KNOWLEDGE);
  return i === -1 ? null : parts.slice(i + 1).join('/');
}

/** Same key elsewhere (brain or another repo, or a topic worktree the thread does not hold) is refused: one record per key (P-031). */
function otherHome(ctx, matches, repo) {
  const held = repo ? heldRepoTopic(ctx, repo)?.topic || null : null;
  return matches.find((m) => (repo ? m.repo !== repo || (m.topic && m.topic !== held) : !!m.repo));
}

function saveMemory(ctx) {
  const [type, ...nameParts] = rest;
  const name = nameParts.join(' ');
  if (!type || !name) fail(`usage: save.mjs memory <type> <name> --content "..." (types: ${KEY_TYPES.join(', ')})`);
  if (args.content === undefined) fail('--content required');
  const key = makeKey(type, name);
  const origin = args.origin || 'operator';
  if (!['operator', 'derived', 'observed'].includes(origin)) fail('origin must be operator | derived | observed (P-009)');
  const sources = asList(args.sources);
  if (origin === 'derived' && !sources.length) fail('derived record needs --sources f1,f2 (P-009)');
  const repo = repoTarget(ctx);
  if (repo && BRAIN_ONLY_TYPES.includes(type)) fail(`${type} records stay in brain: knowledge about the operator and people is not knowledge of one repo (D-0002, P-007)`);
  if (!repo) brainGuard(ctx, key, [...asList(args['relates-to']), ...sources]);
  const matches = find(ctx.brainDir, key, ctx.domain).filter((m) => m.kind === 'memory');
  const byAlias = matches.length ? matches : find(ctx.brainDir, name, ctx.domain).filter((m) => m.kind === 'memory' && m.key.startsWith(type + '-'));
  const elsewhere = otherHome(ctx, byAlias, repo);
  if (elsewhere) fail(`${elsewhere.key} already exists in ${elsewhere.repo ? `repo ${elsewhere.repo}${elsewhere.topic ? ` (topic ${elsewhere.topic})` : ''}` : 'brain'}: ${elsewhere.path}; one record per key (P-031): ${elsewhere.repo ? `save it with --repo ${elsewhere.repo}` : repo ? `move it: save.mjs move ${elsewhere.path} --repo ${repo}` : ''}`);
  const target = targetStore(ctx, repo);
  const refs = checkDecisionRefs(ctx, target, [args.content, args.summary, ...asList(args['relates-to'])]);
  if (refs) fail(refs);
  // One subject, one record on the machine (D-0028): a new project, service, person or tool record is refused when
  // another store already has its key, name or alias. operator and environment records belong to each brain.
  if (!byAlias.length && SUBJECT_TYPES.includes(type) && !args.new) {
    const names = [name, ...asList(args.aliases)];
    const hit = machineRecords(ctx).filter((r) => !sameStore(r.storeOf, target)).map((r) => ({ r, how: subjectMatch(r, { key, names }) })).find((x) => x.how);
    if (hit) fail(`${key}: this subject already has a record in store ${hit.r.storeOf.name} (${hit.how}): ${displayPath(hit.r)}; one subject has one record: write into that record (${saveHint(ctx, hit.r)}), or pass --new when it is another subject`);
  }
  let rel = `memory/${key}.md`;
  let existing = null;
  let by = null;
  if (byAlias.length) {
    rel = repo ? knowledgeRel(ctx, byAlias[0].path) : byAlias[0].path;
    existing = parseFrontmatter(readText(path.resolve(ctx.brainDir, byAlias[0].path), ''));
    // Author = who added the file (scripts/authors.mjs). Operator memory holds one operator's preferences: another operator's
    // is not overwritten (brain shared by several operators); a shared record of another type is, and the output names its author.
    by = repo ? null : foreignAuthor(recordAuthors(ctx.brainDir, { paths: [rel] }), rel);
    if (by && (type === 'operator' || existing.data.type === 'operator')) fail(`${byAlias[0].key} is the operator memory of ${by} (their preferences, not yours): not overwritten; save your own under another name, e.g. save memory operator <your-name> (P-013)`);
  } else {
    const similar = findSimilar(ctx.brainDir, key, ctx.domain);
    if (similar.length && !args.new) {
      fail(`similar key exists (P-031): ${similar.map((s) => `${s.key} (${s.path})`).join(', ')}\nchoose explicitly: reuse the existing name, or pass --new to create ${key}`);
    }
  }
  // An alias names one subject: it must not be the key, name or alias of another record in any store (D-0028). The
  // operator or environment record of the same key in another brain is the same subject kept per brain, no clash.
  const selfKey = existing?.data.key || key;
  const self = (r) => r.key === selfKey && (sameStore(r.storeOf, target) || !SUBJECT_TYPES.includes(type));
  for (const alias of asList(args.aliases)) {
    const clash = machineRecords(ctx).find((r) => r.kind === 'memory' && !self(r) && [r.key, r.data?.name, ...r.aliases].filter((v) => v !== undefined && v !== null).map(lc).includes(lc(alias)));
    if (clash) fail(`--aliases ${alias}: already the key, name or alias of ${clash.key} in store ${clash.storeOf.name}: ${displayPath(clash)}; an alias names one subject only, nothing saved`);
  }
  const data = {
    key: existing?.data.key || key,
    type,
    name: existing?.data.name || name,
    origin,
    aliases: [...new Set([...(asList(existing?.data.aliases)), ...asList(args.aliases)])],
    relates_to: [...new Set([...(asList(existing?.data.relates_to)), ...asList(args['relates-to'])])],
    summary: args.summary || existing?.data.summary || undefined,
    created: existing?.data.created || today(),
    updated: today(),
  };
  if (origin === 'derived') {
    data.sources = sources;
    // Sources of a repo record are paths in that repo (D-0002), so consolidate checks them from any session.
    data.fingerprint = fingerprint(repo ? path.join(ctx.domain.root, repo) : ctx.projectDir, sources);
  }
  const op = { path: rel, content: serializeFrontmatter(data, String(args.content)) };
  if (repo) return out(formatRepoWrite(repoWrite(ctx, repo, { ops: [op], message: `save memory ${data.key}` })));
  const res = brainWrite(ctx, { ops: [op], message: `save memory ${data.key}` });
  finish(ctx, res, [rel]);
  if (by) out(`record by ${by}`);
}

// Removal is an explicit operator order only (P-008); otherwise a decision is superseded. Not the shell (git rm), which
// the brain hook denies, and P-008 had no way for that order (report-526ff5ce, 2026-11-13).
const OPERATOR_REASON_RE = /^operator\b/i;

function removeDecision(ctx) {
  const id = String(args.remove === true ? rest[0] || '' : args.remove).trim();
  if (!/^([a-z0-9-]+\/)?D-\d{4}$/i.test(id)) fail('usage: save.mjs decision --remove D-XXXX [--repo [<repo>]] --reason "operator <YYYY-MM-DD>: <why>"');
  // The operator's answer in a dialog of this turn is the order (D-0011), as in done --topic (report-f52368f8).
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread)) fail('decisions cannot be removed in a turn started by a message, and the operator answered no dialog in it: ask the operator with AskUserQuestion (P-047, D-0011)');
  if (!args.reason || !OPERATOR_REASON_RE.test(String(args.reason))) fail('--remove needs --reason "operator <YYYY-MM-DD>: <why>": a decision is removed only on an explicit operator order; otherwise replace it with --supersedes (P-008)');
  const repo = repoTarget(ctx);
  if (repo) {
    const held = heldRepoTopic(ctx, repo)?.topic || null;
    const key = id.replace(new RegExp(`^${repo}/`), '').toUpperCase();
    const old = find(ctx.brainDir, key, ctx.domain).find((m) => m.kind === 'decision' && m.repo === repo && (!m.topic || m.topic === held));
    if (!old) fail(`decision ${id} not found in repo ${repo}`);
    out(formatRepoWrite(repoWrite(ctx, repo, { ops: [{ path: knowledgeRel(ctx, old.path), remove: true }], message: `remove decision ${key}: ${args.reason}` })));
    return out(`decision ${repo}/${key} removed; references to it elsewhere stay as they are`);
  }
  const key = id.toUpperCase();
  const old = readDecisions(ctx.brainDir).find((d) => (d.id || d.key) === key);
  if (!old) fail(`decision ${key} not found`);
  const res = brainWrite(ctx, { ops: [{ path: old.path, remove: true }], message: `remove decision ${key}: ${args.reason}`, env: { [DECISION_REMOVED_ENV]: old.path } });
  finish(ctx, res, [old.path]);
  out(`decision ${key} removed; references to it elsewhere (relates_to, supersedes, commit messages) stay as they are`);
}

function saveDecision(ctx) {
  if (args.remove) return removeDecision(ctx);
  const title = rest.join(' ');
  if (!title) fail('usage: save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y');
  const relates = asList(args['relates-to']);
  if (!relates.length) fail('decision needs --relates-to (P-008, P-031)');
  if (!args.what || !args.reason) fail('decision needs --what and --reason (P-008)');
  const repo = repoTarget(ctx);
  const refs = checkDecisionRefs(ctx, targetStore(ctx, repo), [title, args.what, args.alternatives, args.reason, ...relates, args.supersedes].map((v) => (typeof v === 'string' ? v : '')));
  if (refs) fail(refs);
  if (repo) return saveRepoDecision(ctx, repo, title, relates);
  brainGuard(ctx, '', relates);
  const id = nextDecisionId(ctx.brainDir);
  const slug = normalizeKey(title).slice(0, 40);
  const rel = `decisions/${id.toLowerCase()}-${slug}.md`;
  const ops = [];
  if (args.supersedes) {
    const old = readDecisions(ctx.brainDir).find((d) => (d.id || d.key) === args.supersedes);
    if (!old) fail(`decision ${args.supersedes} not found`);
    const parsed = parseFrontmatter(readText(path.join(ctx.brainDir, old.path), ''));
    ops.push({ path: old.path, content: serializeFrontmatter({ ...parsed.data, status: `superseded-by ${id}`, updated: today() }, parsed.body) });
  }
  const data = { key: id, id, title, status: 'valid', relates_to: relates, aliases: asList(args.aliases), supersedes: args.supersedes || undefined, created: today() };
  const body = `**Rozhodnuté:** ${args.what}\n\n**Zamietnuté alternatívy:** ${args.alternatives || '-'}\n\n**Dôvod:** ${args.reason}\n`;
  ops.push({ path: rel, content: serializeFrontmatter(data, body) });
  const res = brainWrite(ctx, { ops, message: `save decision ${id} ${slug}` });
  finish(ctx, res, [rel]);
  out(`decision ${id}: reference it in the commit message of the change it drives (P-008)`);
}

/** Decision of one repo: numbered within the repo over its main checkout and all topic worktrees (`<repo>/D-0001`). */
function saveRepoDecision(ctx, repo, title, relates) {
  const id = nextRepoDecisionId(ctx.domain, repo);
  const slug = normalizeKey(title).slice(0, 40);
  const rel = `decisions/${id.toLowerCase()}-${slug}.md`;
  const ops = [];
  if (args.supersedes) {
    const held = heldRepoTopic(ctx, repo)?.topic || null;
    const old = find(ctx.brainDir, String(args.supersedes).replace(new RegExp(`^${repo}/`), ''), ctx.domain)
      .find((m) => m.kind === 'decision' && m.repo === repo && (!m.topic || m.topic === held));
    if (!old) fail(`decision ${args.supersedes} not found in repo ${repo}`);
    const parsed = parseFrontmatter(readText(path.resolve(ctx.brainDir, old.path), ''));
    ops.push({ path: knowledgeRel(ctx, old.path), content: serializeFrontmatter({ ...parsed.data, status: `superseded-by ${id}`, updated: today() }, parsed.body) });
  }
  const data = { key: id, id, title, status: 'valid', relates_to: relates, aliases: asList(args.aliases), supersedes: args.supersedes ? String(args.supersedes).replace(new RegExp(`^${repo}/`), '') : undefined, created: today() };
  const body = `**Rozhodnuté:** ${args.what}\n\n**Zamietnuté alternatívy:** ${args.alternatives || '-'}\n\n**Dôvod:** ${args.reason}\n`;
  ops.push({ path: rel, content: serializeFrontmatter(data, body) });
  out(formatRepoWrite(repoWrite(ctx, repo, { ops, message: `save decision ${id} ${slug}` })));
  out(`decision ${repo}/${id}: reference it as ${repo}/${id} in the commit message of the change it drives (P-008)`);
}

const PRECEDENCE_RE = /prednos[tť]|\boverrid|takes? precedence/i;
// P-007: a rule is a gate (MUST / MUST NOT, or a pointer to a skill); steps and commands belong in a skill (Bob 2026-11-02).
const STEP_LINE_RE = /^\s*(\d+[.)]|[-*]\s*(najprv|potom|nakoniec|first|then|finally)\b)/i;
const COMMAND_RE = /`[^`\n]*\b(node|npm|npx|git|sudo|systemctl|docker|curl|ssh|scp|sed|awk|apt|pip|python3?)\s[^`\n]*`/;

/** Why the content reads as a procedure (numbered steps or shell commands), or null. */
function procedureSignal(content) {
  const text = String(content);
  const steps = text.split('\n').filter((l) => STEP_LINE_RE.test(l)).length;
  if (steps >= 2) return `${steps} step lines`;
  const cmd = COMMAND_RE.exec(text);
  if (cmd) return `command ${cmd[0]}`;
  return null;
}

/**
 * A rule only in text is unreliable (operator 2026-11-02: "rules are unreliable, solve it in code"): every saved rule names
 * the code that enforces it (hook, script, test) or states why code cannot check it. `<file>[:<symbol>]` resolves against
 * the workflow, the project and brain; the symbol must occur in the file. Returns frontmatter fields or fails.
 */
function enforcementOf(ctx, existing, opts = args, extraRoots = []) {
  const given = opts['enforced-by'] !== undefined && opts['enforced-by'] !== true;
  const why = opts.unenforced !== undefined && opts.unenforced !== true ? String(opts.unenforced).trim() : null;
  if (given && why) fail('--enforced-by and --unenforced exclude each other');
  if (!given && !why) {
    if (existing.enforced_by?.length) return { enforced_by: existing.enforced_by };
    if (existing.unenforced) return { unenforced: existing.unenforced };
    fail('a rule needs --enforced-by <file>[:<symbol>] (the hook, script or test that blocks the violation; write that code first, skill fix) or --unenforced "<why code cannot check it>"; a rule only in text is not reliable (operator 2026-11-02)');
  }
  if (why) {
    if (why.length < 20) fail('--unenforced needs the reason why code cannot check the rule (at least 20 characters)');
    return { unenforced: why };
  }
  const refs = asList(opts['enforced-by']);
  const roots = [ctx.pluginRoot, ctx.projectDir, ctx.brainDir, ...extraRoots].filter(Boolean);
  for (const ref of refs) {
    const [file, symbol] = ref.split(':');
    const abs = roots.map((r) => path.resolve(r, file)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!abs) fail(`--enforced-by ${ref}: file ${file} not found in the workflow, the project${extraRoots.length ? ', the repo' : ''} or brain`);
    if (symbol && !fs.readFileSync(abs, 'utf8').includes(symbol)) fail(`--enforced-by ${ref}: ${symbol} does not occur in ${file}`);
  }
  return { enforced_by: refs };
}

/**
 * New rule gate (operator 2026-11-03: rules multiply without end, eat the limit and still do not stop the errors): the
 * rules must stay within the limit; an existing rule on the same subject is extended instead of a second rule; a
 * conflict is resolved in the conflicting rule first; and a new rule the code could replace is refused.
 */
function ruleGate(ctx, name, content, oldBody, isNew, enforcedBy, target = null) {
  // A repo rule (D-0025) is judged within the rules of that repo's sessions: workflow, domain brain, project brain, repo.
  const where = target || { brainDir: ctx.brainDir, policy: ctx.policy, layers: ctx.layers, id: name };
  const rules = assembleRules({ brainDir: where.brainDir, policy: where.policy, harness: 'claude-code', layers: where.layers });
  const limit = where.policy?.limits?.rules_chars ?? 10000;
  const grow = content.trim().length - oldBody.trim().length + (isNew ? name.length + 6 : 0);
  if (grow > 0 && rules.chars + grow > limit) fail(`rules would have ${rules.chars + grow} chars > ${limit}: a rule must not grow the rules over the limit; put the gate into the code (hook, script) or into an existing rule by rewording it shorter, and condense first (skill workflow:consolidate, P-022)`);
  // Condensing a rule (fewer words, none new) is what the limit asks for; judging it again only re-reports the old wording.
  if (!isNew && onlyCondenses(content, oldBody)) return;
  const corpus = ruleCorpus({ brainDir: where.brainDir, coreDir: path.join(ctx.pluginRoot, 'rules'), skip: where.id, layers: where.layers });
  const verdict = judgeRule({ id: where.id, text: content, enforcedBy, oldText: isNew ? '' : oldBody }, corpus, { spawn: spawnSync });
  const list = (a) => a.map((x) => `${x.id} (${x.how})`).join('; ');
  const fix = (id) => (/^P-\d{3}$/.test(id) ? `${id} is a workflow principle: report it to maintainer/workflow-dev (send --level assist) or save an exception`
    : id.includes('/') ? `save.mjs rule ${id.split('/')[1]} --repo ${id.split('/')[0]} --content "<reworded>"` : `save.mjs rule ${id} --content "<reworded>"`);
  if (verdict.conflicts.length) fail(`rule ${name} conflicts with ${list(verdict.conflicts)}: two rules must not order different behaviour; resolve the conflict in that rule first (${verdict.conflicts.map((c) => fix(c.id)).join('; ')}), then save this one only if something is left [${verdict.by}]`);
  if (!isNew) return;
  const open = unanswered(verdict.overlaps, args.distinct);
  if (open.length) fail(`rule ${name} overlaps ${list(verdict.overlaps.filter((o) => open.includes(o.id)))}: extend or narrow the existing rule instead of a new one (${open.map(fix).join('; ')}); only when it truly is another subject: --distinct "<id>: <how it differs and why it does not conflict>; …" for each [${verdict.by}]`);
  if (verdict.code_instead && !(typeof args['needs-text'] === 'string' && args['needs-text'].trim().length >= 20)) fail(`rule ${name} can be enforced by code alone: ${verdict.code_instead} Do that (skill fix, or report it to maintainer/workflow-dev) and drop the rule; the code's own message teaches the agent. Only when the agent must know it before acting: --needs-text "<why>" [${verdict.by}]`);
}

/**
 * Target of a repo rule (D-0025): `<repo>/agentic/rules/` of the held code topic worktree, else of the repo checkout,
 * with the layers, policy and brain of that repo's sessions (its own brain when it has one), for the rule gate.
 */
function repoRuleTarget(ctx, repo, name) {
  if (!ctx.layers?.inDomain) fail(`rule --repo: the domain ${ctx.domain?.root || ''} has no brain, so repo rules would not be read; create the domain brain first (D-0025)`);
  const held = heldRepoTopic(ctx, repo);
  const dir = held ? held.dir : path.join(ctx.domain.root, repo);
  const info = resolveBrain(dir);
  const brainDir = info && !info.error && brainExists(info.brain) ? info.brain : null;
  const composed = projectPolicy({ projectDir: dir, brainDir, domain: ctx.domain });
  return { repo, dir, base: path.join(dir, PROJECT_KNOWLEDGE), brainDir, policy: composed.policy, layers: composed.layers, id: `${repo}/${name}` };
}

function saveRule(ctx) {
  const [name] = rest;
  if (!name || !isValidId(name)) fail('usage: save.mjs rule <name> [--repo [<repo>]] --content "..." | --remove --reason "..." (name: lowercase, digits, hyphens)');
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('rules cannot change in a turn started by a message (P-047)');
  const rel = `rules/${name}.md`;
  // A rule of one repo lives in that repo (`<repo>/agentic/rules/`, D-0025), written by repoWrite like its other knowledge.
  const repo = repoTarget(ctx);
  const target = repo ? repoRuleTarget(ctx, repo, name) : null;
  const file = path.join(target ? target.base : ctx.brainDir, rel);
  const shown = target ? `rule ${name} of repo ${repo}` : `rule ${name}`;
  // A project rule superseded by a workflow principle is removed, not kept twice (P-007, P-022).
  if (args.remove) {
    if (!fs.existsSync(file)) fail(`${shown} does not exist`);
    if (!args.reason) fail('--remove needs --reason "superseded by P-XXX | ..."');
    if (target) return out(formatRepoWrite(repoWrite(ctx, repo, { ops: [{ path: rel, remove: true }], message: `remove rule ${name}: ${args.reason}` })));
    const res = brainWrite(ctx, { ops: [{ path: rel, remove: true }], message: `remove rule ${name}: ${args.reason}` });
    return finish(ctx, res, [rel]);
  }
  if (args.content === undefined) fail('--content required');
  // Overlapping rules are resolved by moving the boundary into one rule, never by a rule that overrides another (operator 2026-11-02).
  if (PRECEDENCE_RE.test(String(args.content))) fail('a rule must not take precedence over another rule: move the boundary into one rule and narrow or remove the other (skill workflow:consolidate, P-007)');
  const proc = procedureSignal(args.content);
  if (proc) fail(`rule content reads as a procedure (${proc}): save the steps as a skill (save.mjs skill <name> --description "Použi, keď ..." --origin routine) and keep in the rule only the gate (MUST / MUST NOT, "skill <name>"), P-007`);
  const refs = checkDecisionRefs(ctx, targetStore(ctx, repo), [String(args.content), typeof args.title === 'string' ? args.title : '']);
  if (refs) fail(refs);
  const existing = parseFrontmatter(readText(file, ''));
  const isNew = !fs.existsSync(file);
  // Code first (operator 2026-11-03): a new rule exists only next to the code that blocks its violation; what code cannot
  // check goes into an existing rule, not a new one.
  if (isNew && args.unenforced !== undefined) fail('a new rule needs --enforced-by <file>[:<symbol>]: rules are unreliable, so a new one exists only next to the code that blocks its violation; what code cannot check belongs in an existing rule (extend it: save.mjs rule <existing> --content ...), not a new one');
  const enforcement = enforcementOf(ctx, existing.data, args, target ? [target.dir] : []);
  ruleGate(ctx, name, String(args.content), existing.body || '', isNew, enforcement.enforced_by?.join(', '), target);
  const data = { key: `rule-${name}`, title: args.title || existing.data.title || name, aliases: asList(args.aliases), ...enforcement, created: existing.data.created || today(), updated: today() };
  const op = { path: rel, content: serializeFrontmatter(data, String(args.content)) };
  if (target) out(formatRepoWrite(repoWrite(ctx, repo, { ops: [op], message: `save rule ${name}` })));
  else finish(ctx, brainWrite(ctx, { ops: [op], message: `save rule ${name}` }), [rel]);
  out('rule check (P-007): if it says how or when to do something (order of work, how to deploy or update), it is a skill with a trigger in its description; the rule keeps only the gate');
}

/** `s<d>pattern<d>replacement<d>flags` (sed syntax, JavaScript regex; flags g, i, m) applied to the body; fails when it matches nothing. */
function applySed(body, expr) {
  const m = /^s(.)/.exec(String(expr));
  if (!m) throw new Error(`--sed ${expr}: expected s/<pattern>/<replacement>/[gim]`);
  const d = m[1];
  const parts = [];
  let cur = '';
  for (let i = 2; i < expr.length; i++) {
    if (expr[i] === '\\' && expr[i + 1] === d) { cur += d; i++; continue; }
    if (expr[i] === d) { parts.push(cur); cur = ''; continue; }
    cur += expr[i];
  }
  parts.push(cur);
  if (parts.length !== 3 || /[^gim]/.test(parts[2])) throw new Error(`--sed ${expr}: expected s/<pattern>/<replacement>/[gim]`);
  const re = new RegExp(parts[0], parts[2]);
  if (!re.test(body)) throw new Error(`--sed ${expr}: pattern not found in the skill body; nothing changed`);
  re.lastIndex = 0;
  return body.replace(re, parts[1].replace(/\\n/g, '\n'));
}

function saveException(ctx) {
  const [id] = rest;
  if (!/^P-\d{3}$/.test(id || '')) fail('usage: save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local]');
  if (!args.wording || !args.reason) fail('exception needs --wording and --reason (P-035)');
  if ((ctx.policy.immutable_principles || []).includes(id)) fail(`${id} is immutable and cannot be overridden (P-035)`);
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('exceptions cannot change in a turn started by a message (P-047)');
  const layer = args.layer || 'project';
  const file = layer === 'project' ? 'exceptions/project.md'
    : layer === 'harness' ? `exceptions/harness-${normalizeKey(args.harness || 'claude-code')}.md`
      : layer === 'machine' ? `exceptions/machine-${normalizeKey(args.machine || machineName())}.md`
        : layer === 'local' ? 'local/exceptions.md' : null;
  if (!file) fail('layer must be project | harness | machine | local');
  const current = readText(path.join(ctx.brainDir, file), '');
  const blocks = current.split(/^(?=### )/m).filter((b) => b.trim());
  const entry = `### ${id}${args.title ? `: ${args.title}` : ''}\nZnenie: ${args.wording}\nDôvod: ${args.reason}\n`;
  const kept = blocks.filter((b) => !new RegExp(`^###\\s+${id}\\b`).test(b));
  const content = [...kept.map((b) => b.trim()), entry.trim()].join('\n\n') + '\n';
  if (layer === 'local') {
    fs.mkdirSync(path.join(ctx.brainDir, 'local'), { recursive: true });
    fs.writeFileSync(path.join(ctx.brainDir, file), content);
    out(`written: ${file} (local layer, not committed)`);
    return;
  }
  const res = brainWrite(ctx, { ops: [{ path: file, content }], message: `save exception ${id} (${layer})` });
  finish(ctx, res, [file]);
}

/**
 * New knowledge for an existing skill is merged into its whole body, not appended as another section: a skill reads as
 * one procedure, not a pile of additions that repeat or contradict each other (P-003; operator 2026-11-08).
 */
function requireRefactor(name, rel, body) {
  fail(`skill ${name} exists (${rel}): merge the new knowledge into the whole skill and save the result with --content "<whole body>" --replace, so it reads as one procedure without a step that repeats or contradicts another (P-003); a local fix of a few words: --sed. Current body:\n${body.trim()}`);
}

/** A skill superseded by a workflow skill or principle is removed, not kept twice (P-007, P-022; agent 2026-11-03). */
function removeSkill(ctx, name) {
  if (!args.reason) fail('--remove needs --reason "superseded by workflow:<skill> | P-XXX | ..."');
  const hit = readSkills(ctx.brainDir).find((s) => s.skillName === name);
  if (!hit) fail(`skill ${name} does not exist`);
  if (hit.owner === 'operator') fail(`skill ${name} belongs to the operator (skills/operator); propose the removal instead (P-032)`);
  const dir = path.dirname(hit.path);
  const files = fs.readdirSync(path.join(ctx.brainDir, dir), { recursive: true }).map(String)
    .filter((f) => fs.statSync(path.join(ctx.brainDir, dir, f)).isFile()).map((f) => path.posix.join(dir, f.split(path.sep).join('/')));
  const res = brainWrite(ctx, { ops: files.map((rel) => ({ path: rel, remove: true })), message: `remove skill ${name}: ${args.reason}` });
  // git does not track directories: the emptied skill dir stays and the brain hook denies rmdir (alice 2026-11-04).
  const abs = path.join(ctx.brainDir, dir);
  const left = fs.existsSync(abs) ? fs.readdirSync(abs, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(abs, f)).isFile()) : [];
  if (fs.existsSync(abs) && !left.length) fs.rmSync(abs, { recursive: true });
  finish(ctx, res, files);
  const notDeployed = deploySkills(ctx);
  if (notDeployed) out(`not removed from the project (${notDeployed}); it leaves at the next session start`);
}

function saveSkill(ctx) {
  const [name] = rest;
  if (!name || !isValidId(name) || hasDiacritics(name)) fail('usage: save.mjs skill <name> --description "..." --content "..." --origin error|routine');
  const repo = repoTarget(ctx);
  if (repo) return saveRepoSkill(ctx, repo, name);
  if (args.remove) return removeSkill(ctx, name);
  if (workflowSkillNames().includes(name)) fail(`"${name}" is a workflow skill name; choose another (P-024)`);
  const inRepo = ctx.domain && find(ctx.brainDir, name, ctx.domain).find((m) => m.kind === 'skill' && m.repo);
  if (inRepo) fail(`skill ${name} exists in repo ${inRepo.repo} (${inRepo.path}): one skill name per domain, skills-sync deploys both; save it with --repo ${inRepo.repo}`);
  const origin = args.origin || 'error';
  if (!['error', 'routine'].includes(origin)) fail('origin must be error | routine (P-032)');
  const sed = args.sed === undefined ? null : SEDS.length ? SEDS : [String(args.sed)];
  if (sed !== null && (args.content !== undefined || args.replace)) fail('--sed edits the existing body; do not combine it with --content or --replace');
  // --script alone adds or updates the scripts of an existing skill and keeps its body (report-dffad7fe: an agent
  // passed a dummy --sed 's/^/^/' to save only a script and the edit put a ^ in front of the body).
  const scriptOnly = sed === null && args.content === undefined && !args.replace && asList(args.script).length > 0;
  if (sed === null && args.content === undefined && !scriptOnly) fail('--content required (or --sed s/<pattern>/<replacement>/ to edit an existing skill, or --script alone to add a script to it)');
  const skills = readSkills(ctx.brainDir);
  const hit = skills.find((s) => s.skillName === name || s.aliases.map(normalizeKey).includes(normalizeKey(name)))
    || find(ctx.brainDir, name).map((m) => skills.find((s) => s.path === m.path)).find(Boolean);
  const ops = [];
  let rel;
  if (hit) {
    rel = hit.path;
    const parsed = parseFrontmatter(readText(path.join(ctx.brainDir, rel), ''));
    const data = { ...parsed.data, aliases: [...new Set([...asList(parsed.data.aliases), ...asList(args.aliases)])], updated: today() };
    if (args.description) data.description = args.description;
    // --replace: the refactored whole body replaces the old one; --sed: in-place edit, frontmatter kept.
    if (sed === null && !args.replace && !scriptOnly) requireRefactor(hit.skillName, rel, parsed.body);
    const body = scriptOnly ? parsed.body : sed !== null ? sed.reduce((b, e) => applySed(b, e), parsed.body) : `${String(args.content).trim()}\n`;
    const next = serializeFrontmatter(data, body);
    // P-032 (operator 2026-11-07): an operator skill changes without approval only when its meaning stays (cosmetic
    // edit, refactor); a change of meaning is reported to the operator and saved with --approved after their yes.
    if (hit.owner === 'operator') {
      const diff = meaningDiff(readText(path.join(ctx.brainDir, rel), ''), next);
      const approved = typeof args.approved === 'string' && args.approved.trim().length >= 2;
      if (approved && ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('--approved: an operator skill cannot change meaning in a turn started by a message (P-047)');
      if (diff.length && !approved) fail(`skill ${hit.skillName} belongs to the operator: this edit changes its meaning (${diff.slice(0, 8).join('; ')}${diff.length > 8 ? '; …' : ''}). Show the operator the change and why; after their yes save it again with --approved "<their words>" (P-032)`);
    }
    ops.push({ path: rel, content: next });
  } else {
    if (sed !== null) fail(`--sed: skill ${name} does not exist`);
    if (scriptOnly) fail(`--script alone: skill ${name} does not exist; a new skill needs --content`);
    if (!args.description) fail('new skill needs --description "Použi, keď ..." (trigger, P-003)');
    rel = `skills/agentic/${name}/SKILL.md`;
    const data = { name, description: args.description, origin, aliases: asList(args.aliases), created: today() };
    ops.push({ path: rel, content: serializeFrontmatter(data, String(args.content)) });
  }
  // Scripts of the skill (P-030 "skill with a script"): copied next to SKILL.md; skills-sync deploys the whole directory.
  const scripts = [];
  const runners = new Map();
  const scriptFiles = asList(args.script).map((x) => path.basename(path.resolve(x)));
  for (const src of asList(args.script)) {
    const file = path.resolve(src);
    const base = path.basename(file);
    if (!SKILL_SCRIPT.test(base)) fail(`--script ${src}: name must be lowercase english, ${SKILL_SCRIPT_TYPES} (P-049)`);
    checkScriptName(src, base, ops[0].content, scriptFiles);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`--script ${src}: file not found`);
    if (fs.statSync(file).size > 64 * 1024) fail(`--script ${src}: over 64 KB; a skill script stays small`);
    const scriptRel = `${path.posix.dirname(toPosixPath(rel))}/${base}`;
    ops.push({ path: scriptRel, content: fs.readFileSync(file, 'utf8') });
    scripts.push(scriptRel);
    runners.set(scriptRel, scriptRunner(base, process.platform, ops[ops.length - 1].content));
  }
  // Skill health (skill workflow:skill-check): a broken skill is not saved.
  const skillDir = path.join(ctx.brainDir, path.dirname(rel));
  const found = checkSkill({ name: path.basename(path.dirname(rel)), dir: skillDir, text: ops[0].content, owner: rel.split('/')[1], projectDir: ctx.projectDir, limit: ctx.policy?.limits?.skill_description_chars ?? 300, pendingScripts: scripts.map((s) => path.posix.basename(s)) });
  const errors = found.filter((x) => x.level === 'error');
  if (errors.length) fail(`skill check: ${errors.map((x) => `${x.line ? `line ${x.line} ` : ''}${x.message}`).join('; ')}; nothing saved (workflow:skill-check)`);
  for (const w of found.filter((x) => x.level === 'warn')) out(`skill check warn: ${w.line ? `line ${w.line} ` : ''}${w.message}`);
  if (args['from-procedure']) ops.push(removeNames(ctx.brainDir, 'procedures.log', asList(args['from-procedure'])));
  if (args['from-sequence']) ops.push(removeNames(ctx.brainDir, 'sequences.log', asList(args['from-sequence'])));
  const res = brainWrite(ctx, { ops, message: `save skill ${name} (${hit ? (sed !== null ? 'edit' : 'refactor') : origin})` });
  finish(ctx, res, [rel, ...scripts]);
  const notDeployed = deploySkills(ctx);
  out(hit ? `${sed !== null ? 'edited' : 'refactored'} existing skill ${hit.skillName}` : `new skill ${name} (origin: ${origin})`);
  out(notDeployed ? `not deployed to the project (${notDeployed}); it reaches the project at the next session start` : `deployed to ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR))}`);
  // P-052: the skill text calls its script by the deployed absolute path, never relative to the cwd or from scratch.
  for (const s of scripts) out(`script runs as: ${runners.get(s)} ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR, path.posix.basename(path.posix.dirname(s)), path.posix.basename(s)))} (write this path in the skill text)`);
}

/** Skill of one repo (`<repo>/agentic/skills/<name>/`): agentic only, one name per domain (skills-sync deploys both). */
function saveRepoSkill(ctx, repo, name) {
  if (args.approved !== undefined) fail('skills of a repo are agentic only; operator skills stay in brain (P-032)');
  if (workflowSkillNames().includes(name)) fail(`"${name}" is a workflow skill name; choose another (P-024)`);
  const inBrain = readSkills(ctx.brainDir).find((sk) => sk.skillName === name);
  if (inBrain) fail(`skill ${name} exists in brain (${inBrain.path}): one skill name per domain; move it: save.mjs move ${path.posix.dirname(inBrain.path)} --repo ${repo}`);
  const held = heldRepoTopic(ctx, repo)?.topic || null;
  const found = find(ctx.brainDir, name, ctx.domain).filter((m) => m.kind === 'skill' && m.repo);
  const other = found.find((m) => m.repo !== repo);
  if (other) fail(`skill ${name} exists in repo ${other.repo} (${other.path}): one skill name per domain`);
  const hit = found.find((m) => m.topic === held && held) || found.find((m) => !m.topic);
  const dirAbs = path.join(held ? heldRepoTopic(ctx, repo).dir : path.join(ctx.domain.root, repo), PROJECT_KNOWLEDGE, 'skills', name);
  const rel = hit ? knowledgeRel(ctx, hit.path) : `skills/${name}/SKILL.md`;
  if (args.remove) {
    if (!hit) fail(`skill ${name} does not exist in repo ${repo}`);
    if (!args.reason) fail('--remove needs --reason "superseded by workflow:<skill> | P-XXX | ..."');
    const files = fs.existsSync(dirAbs) ? fs.readdirSync(dirAbs, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dirAbs, f)).isFile()) : [];
    out(formatRepoWrite(repoWrite(ctx, repo, { ops: files.map((f) => ({ path: `skills/${name}/${toPosixPath(f)}`, remove: true })), message: `remove skill ${name}: ${args.reason}` })));
    const notDeployed = deploySkills(ctx);
    if (notDeployed) out(`not removed from this project (${notDeployed}); it leaves at the next session start`);
    return;
  }
  const origin = args.origin || 'error';
  if (!['error', 'routine'].includes(origin)) fail('origin must be error | routine (P-032)');
  const sed = args.sed === undefined ? null : SEDS.length ? SEDS : [String(args.sed)];
  if (sed !== null && (args.content !== undefined || args.replace)) fail('--sed edits the existing body; do not combine it with --content or --replace');
  const scriptOnly = sed === null && args.content === undefined && !args.replace && asList(args.script).length > 0;
  if (sed === null && args.content === undefined && !scriptOnly) fail('--content required (or --sed s/<pattern>/<replacement>/ to edit an existing skill, or --script alone to add a script to it)');
  let text;
  if (hit) {
    const parsed = parseFrontmatter(readText(path.resolve(ctx.brainDir, hit.path), ''));
    const data = { ...parsed.data, aliases: [...new Set([...asList(parsed.data.aliases), ...asList(args.aliases)])], updated: today() };
    if (args.description) data.description = args.description;
    if (sed === null && !args.replace && !scriptOnly) requireRefactor(name, hit.path, parsed.body);
    const body = scriptOnly ? parsed.body : sed !== null ? sed.reduce((b, e) => applySed(b, e), parsed.body) : `${String(args.content).trim()}\n`;
    text = serializeFrontmatter(data, body);
  } else {
    if (sed !== null) fail(`--sed: skill ${name} does not exist in repo ${repo}`);
    if (scriptOnly) fail(`--script alone: skill ${name} does not exist in repo ${repo}; a new skill needs --content`);
    if (!args.description) fail('new skill needs --description "Použi, keď ..." (trigger, P-003)');
    text = serializeFrontmatter({ name, description: args.description, origin, aliases: asList(args.aliases), created: today() }, String(args.content));
  }
  const ops = [{ path: rel, content: text }];
  const scripts = [];
  const runners = new Map();
  const scriptFiles = asList(args.script).map((x) => path.basename(path.resolve(x)));
  for (const src of asList(args.script)) {
    const file = path.resolve(src);
    const base = path.basename(file);
    if (!SKILL_SCRIPT.test(base)) fail(`--script ${src}: name must be lowercase english, ${SKILL_SCRIPT_TYPES} (P-049)`);
    checkScriptName(src, base, text, scriptFiles);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`--script ${src}: file not found`);
    if (fs.statSync(file).size > 64 * 1024) fail(`--script ${src}: over 64 KB; a skill script stays small`);
    ops.push({ path: `${path.posix.dirname(rel)}/${base}`, content: fs.readFileSync(file, 'utf8') });
    scripts.push(base);
    runners.set(base, scriptRunner(base, process.platform, ops[ops.length - 1].content));
  }
  const found2 = checkSkill({ name, dir: dirAbs, text, owner: 'agentic', projectDir: ctx.projectDir, limit: ctx.policy?.limits?.skill_description_chars ?? 300, pendingScripts: scripts });
  const errors = found2.filter((x) => x.level === 'error');
  if (errors.length) fail(`skill check: ${errors.map((x) => `${x.line ? `line ${x.line} ` : ''}${x.message}`).join('; ')}; nothing saved (workflow:skill-check)`);
  for (const w of found2.filter((x) => x.level === 'warn')) out(`skill check warn: ${w.line ? `line ${w.line} ` : ''}${w.message}`);
  out(formatRepoWrite(repoWrite(ctx, repo, { ops, message: `save skill ${name} (${hit ? (sed !== null ? 'edit' : 'refactor') : origin})` })));
  const notDeployed = deploySkills(ctx);
  out(hit ? `${sed !== null ? 'edited' : 'extended'} skill ${name} of repo ${repo}` : `new skill ${name} of repo ${repo} (origin: ${origin})`);
  out(notDeployed ? `not deployed to this project (${notDeployed}); other sessions of the repo get it at their next start` : `deployed to ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR))}; other sessions of the repo get it at their next start`);
  for (const base of scripts) out(`script runs as: ${runners.get(base)} ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR, name, base))} (write this path in the skill text)`);
}

/** State of a repo for whoever takes it over (`<repo>/agentic/HANDOVER.md`); the handover of a topic stays in brain (P-011). */
function saveRepoHandover(ctx, repo) {
  const content = args.file ? fs.readFileSync(String(args.file), 'utf8') : args.content !== undefined ? String(args.content) : null;
  if (content === null) fail('usage: save.mjs handover --repo [<name>] --file <path> | --content "..." (the whole current state of the repo)');
  const refs = checkDecisionRefs(ctx, targetStore(ctx, repo), [content]);
  if (refs) fail(refs);
  out(formatRepoWrite(repoWrite(ctx, repo, { ops: [{ path: REPO_HANDOVER, content: content.endsWith('\n') ? content : `${content}\n` }], message: `handover ${repo}` })));
}

/**
 * Move a brain record of one repo into the repo (D-0002): written into the repo first, then removed from brain; no
 * "moved" stub stays. A decision gets the next number of the repo and `moved_from: <brain>/<old id>`.
 */
function saveMove(ctx) {
  const [src] = rest;
  const repo = repoTarget(ctx);
  if (!src || !repo) fail('usage: save.mjs move <brain path: memory/<key>.md | decisions/<file>.md | skills/agentic/<name>> --repo <name> [--dry-run]');
  const rel = toPosixPath(src).replace(/^\.\//, '').replace(/\/$/, '');
  const abs = path.join(ctx.brainDir, rel);
  if (rel.split('/').includes('..') || !fs.existsSync(abs)) fail(`${rel}: not found in brain`);
  const brainName = path.basename(ctx.brainDir);
  const repoDir = path.join(ctx.domain.root, repo);
  const source = targetStore(ctx);
  const dest = targetStore(ctx, repo);
  const others = machineStores(ctx).filter((s) => !sameStore(s, source) && !sameStore(s, dest));
  let ops = [];
  let removed = [];
  let note = null;
  // References to the moved record (D-0028): rewritten in brain and in the repo within the commits of the move, listed
  // (path:line) in the other stores. brainEdit(text, file) and repoEdit(text, file) return the new text of a file.
  let brainEdit = null;
  let brainFiles = [];
  let repoEdit = null;
  let repoFiles = () => [];
  let elsewhere = () => [];
  if (/^memory\/[^/]+\.md$/.test(rel)) {
    const type = String(parseFrontmatter(fs.readFileSync(abs, 'utf8')).data.type || path.basename(rel, '.md').split('-')[0]);
    if (BRAIN_ONLY_TYPES.includes(type)) fail(`${rel}: ${type} records stay in brain: knowledge about the operator and people is not knowledge of one repo (D-0002, P-007)`);
    ops = [{ path: rel, content: fs.readFileSync(abs, 'utf8') }];
    removed = [rel];
    // Derived records with the moved record among their sources: the source path names its new place, the fingerprint
    // is renewed when it was fresh (a stale one stays stale). Brain sources are relative to the project, repo ones to the repo.
    const newAbs = path.join(repoDir, PROJECT_KNOWLEDGE, rel);
    const pending = new Map([[newAbs, ops[0].content]]);
    const derived = (base) => (text) => rebaseSources(text, base, abs, newAbs, pending);
    brainEdit = derived(ctx.projectDir);
    brainFiles = listFiles(path.join(ctx.brainDir, 'memory'), (f) => f.endsWith('.md')).filter((f) => path.resolve(f) !== path.resolve(abs));
    repoEdit = derived(repoDir);
    repoFiles = (kdir) => listFiles(path.join(kdir, 'memory'), (f) => f.endsWith('.md'));
    elsewhere = () => others.flatMap((s) => listFiles(path.join(s.knowledge, 'memory'), (f) => f.endsWith('.md')).flatMap((f) => sourceLines(f, s.kind === 'repo' ? s.dir : s.project || s.dir, abs)));
  } else if (/^decisions\/[^/]+\.md$/.test(rel)) {
    const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    const oldId = String(parsed.data.id || parsed.data.key || path.basename(rel, '.md'));
    const id = nextRepoDecisionId(ctx.domain, repo);
    const newRef = `${repo}/${id}`;
    const slug = path.basename(rel, '.md').replace(/^d-\d+-?/i, '') || normalizeKey(String(parsed.data.title || '')).slice(0, 40);
    // In the repo a bare D-NNNN means the repo's own decision: the moved record names brain decisions <brain>/D-NNNN.
    const content = rewriteDecisionRefs(serializeFrontmatter({ ...parsed.data, key: id, id, moved_from: `${brainName}/${oldId}`, updated: today() }, parsed.body), { bare: (d) => (d === oldId ? newRef : `${brainName}/${d}`), qualified: (s, d) => (s === brainName && d === oldId ? newRef : null) });
    ops = [{ path: `decisions/${id.toLowerCase()}-${slug}.md`, content }];
    removed = [rel];
    const old = (s, d) => s === brainName && d === oldId;
    brainEdit = (text) => rewriteDecisionRefs(text, { bare: (d) => (d === oldId ? newRef : null), qualified: (s, d) => (old(s, d) ? newRef : null) });
    brainFiles = refFiles(source).filter((f) => path.resolve(f) !== path.resolve(abs));
    repoEdit = (text) => rewriteDecisionRefs(text, { qualified: (s, d) => (old(s, d) ? newRef : null) });
    repoFiles = (kdir) => refFiles(dest, kdir);
    elsewhere = () => others.flatMap((s) => refFiles(s).flatMap((f) => decisionRefs(readText(f, ''), { skip: ID_LINE }).filter((r) => old(r.store, r.id)).map((r) => `${toPosixPath(f)}:${r.line}`)));
    note = `decision ${brainName}/${oldId} is now ${newRef}; references to it in ${brainName} and ${repo} now read ${newRef} (commit messages stay as they are)`;
  } else if (/^skills\/agentic\/[^/]+(\/SKILL\.md)?$/.test(rel)) {
    const dir = rel.replace(/\/SKILL\.md$/, '');
    const name = dir.split('/')[2];
    const files = fs.readdirSync(path.join(ctx.brainDir, dir), { recursive: true }).map(String).filter((f) => fs.statSync(path.join(ctx.brainDir, dir, f)).isFile()).map(toPosixPath);
    ops = files.map((f) => ({ path: `skills/${name}/${f}`, content: fs.readFileSync(path.join(ctx.brainDir, dir, f), 'utf8') }));
    removed = files.map((f) => `${dir}/${f}`);
  } else if (/^skills\/operator\//.test(rel)) {
    fail(`${rel}: operator skills stay in brain; skills of a repo are agentic only (P-032)`);
  } else {
    fail(`${rel}: only memory/, decisions/ and skills/agentic/<name> move into a repo`);
  }
  const target = ops.map((o) => `${repo}/${PROJECT_KNOWLEDGE}/${o.path}`);
  // Brain files a thread may not write (a topic handover it does not hold) are listed, not rewritten.
  const brainOps = [];
  const brainHeld = [];
  for (const f of brainEdit ? brainFiles : []) {
    const text = readText(f, '');
    const next = brainEdit(text);
    if (next === text) continue;
    const r = relPosix(ctx.brainDir, f);
    if (checkHolder(ctx.brainDir, r, ctx.thread)) brainHeld.push(r);
    else brainOps.push({ path: r, content: next });
  }
  const repoOps = (kdir) => (repoEdit ? repoFiles(kdir) : []).map((f) => {
    const text = readText(f, '');
    const next = repoEdit(text);
    return next === text ? null : { path: relPosix(kdir, f), content: next };
  }).filter(Boolean);
  const listed = [...brainHeld.map((r) => `${toPosixPath(path.join(ctx.brainDir, r))} (topic not held by this thread)`), ...elsewhere()];
  if (args['dry-run']) {
    out(`dry run: ${removed.join(', ')} -> ${target.join(', ')}`);
    const kdir = path.join(heldRepoTopic(ctx, repo)?.dir || repoDir, PROJECT_KNOWLEDGE);
    const rewrites = [...brainOps.map((o) => `${brainName}/${o.path}`), ...repoOps(kdir).filter((o) => !ops.some((m) => m.path === o.path)).map((o) => `${repo}/${PROJECT_KNOWLEDGE}/${o.path}`)];
    if (rewrites.length) out(`would rewrite references in: ${rewrites.join(', ')}`);
    if (listed.length) out(`references elsewhere, not changed:\n${listed.join('\n')}`);
    if (note) out(note);
    return;
  }
  const exists = ops.map((o) => path.join(ctx.domain.root, repo, PROJECT_KNOWLEDGE, o.path)).find((f) => fs.existsSync(f));
  if (exists) fail(`${toPosixPath(path.relative(ctx.domain.root, exists))} already exists in the repo; nothing moved`);
  out(formatRepoWrite(repoWrite(ctx, repo, { ops, message: `move ${brainName}/${rel} into ${repo}`, rewrite: repoEdit ? repoOps : null })));
  let res;
  try {
    res = brainWrite(ctx, { ops: [...removed.map((r) => ({ path: r, remove: true })), ...brainOps], message: `move ${rel} to ${repo}/${PROJECT_KNOWLEDGE}`, env: { WORKFLOW_DECISION_MOVED: removed.join(',') } });
  } catch (err) {
    fail(`${rel} is now in ${repo} but stays in brain too (${err.message.split('\n')[0]}): one record per key (P-031); fix the cause and remove it from brain, or revert the commit in ${repo}`);
  }
  const emptied = path.join(ctx.brainDir, rel.startsWith('skills/') ? rel.replace(/\/SKILL\.md$/, '') : '');
  if (rel.startsWith('skills/') && fs.existsSync(emptied) && !fs.readdirSync(emptied, { recursive: true }).length) fs.rmSync(emptied, { recursive: true });
  finish(ctx, res, [...removed, ...brainOps.map((o) => o.path)]);
  if (brainOps.length) out(`references rewritten in ${brainName}: ${brainOps.map((o) => o.path).join(', ')}`);
  if (listed.length) out(`references elsewhere, not changed:\n${listed.join('\n')}`);
  if (note) out(note);
}

/** Text of a derived memory record with the source oldAbs renamed to newAbs (relative to base); fingerprint renewed when fresh. */
function rebaseSources(text, base, oldAbs, newAbs, pending) {
  const { data, body } = parseFrontmatter(text);
  if (data.origin !== 'derived') return text;
  const sources = asList(data.sources).map(String);
  const hit = (s) => path.resolve(base, s) === path.resolve(oldAbs);
  if (!sources.some(hit)) return text;
  const next = sources.map((s) => (hit(s) ? relPosix(base, newAbs) : s));
  const fresh = data.fingerprint === fingerprint(base, sources);
  return serializeFrontmatter({ ...data, sources: next, ...(fresh ? { fingerprint: fingerprint(base, next, pending) } : {}) }, body);
}

/** path:line of a derived record in file whose sources name abs (relative to base). */
function sourceLines(file, base, abs) {
  const text = readText(file, '');
  const { data } = parseFrontmatter(text);
  if (data.origin !== 'derived') return [];
  const hits = asList(data.sources).map(String).filter((s) => path.resolve(base, s) === path.resolve(abs));
  if (!hits.length) return [];
  const lines = text.split('\n');
  return hits.map((s) => `${toPosixPath(file)}:${Math.max(1, lines.findIndex((l) => l.includes(s)) + 1)}`);
}

const HANDOVER_FIELDS = ['task', 'done', 'next', 'files', 'questions'];
const HANDOVER_OPTIONS = [...HANDOVER_FIELDS, 'file', 'project', 'repo'];

function saveHandover(ctx) {
  const repo = repoTarget(ctx);
  if (repo) return saveRepoHandover(ctx, repo);
  const [topic] = rest;
  if (!topic) fail('usage: save.mjs handover <topic> --task ".." --done "a; b" --next ".." --files "a; b" --questions "a; b" | --file <path>');
  // An unknown option or no content overwrote the topic's handover with an empty one (pilot of v0.9.73, 2026-11-12:
  // `save.mjs handover <topic> --help`): refuse before anything is written, the current handover stays.
  const unknown = Object.keys(args).filter((k) => k !== '_' && !HANDOVER_OPTIONS.includes(k));
  if (unknown.length) fail(`save.mjs handover: unknown option ${unknown.map((k) => `--${k}`).join(', ')}; nothing written, the current handover stays (usage: save.mjs handover <topic> --task ".." --done "a; b" --next ".." --files "a; b" --questions "a; b" | --file <path>)`);
  if (!args.file && !HANDOVER_FIELDS.some((k) => typeof args[k] === 'string' && args[k].trim())) fail('save.mjs handover: no content (--task, --done, --next, --files, --questions or --file); nothing written, the current handover stays');
  // Limits and the reminder need no remote state: refuse before the first fetch (53 limit refusals paid a whole sync cycle).
  const written = args.file ? fs.readFileSync(args.file, 'utf8') : renderHandover({ task: args.task, done: args.done, next: args.next, files: args.files, questions: args.questions });
  const refs = checkDecisionRefs(ctx, targetStore(ctx), [written]);
  if (refs) fail(refs);
  // The open issues of this topic (3c.3) come from the local records, also over --file: the agent neither writes nor drops them.
  const content = withReports(written, openReportLines(baseOf(ctx), topic));
  const errors = checkHandover(content, ctx.policy.limits.handover_lines);
  // flow-public#49: a "; " inside the sentence of an item split it into two lines and the refusal came twice: name the items per option.
  if (!args.file && errors.some((e) => /lines, limit/.test(e))) errors.push(`items: ${['done', 'files', 'questions'].map((k) => `--${k} ${String(args[k] ?? '').split(/\s*;\s*|\n/).filter((s) => s.trim()).length}`).join(', ')}; a ";" inside the text of an item starts a new item: write "," there (flow-public#49)`);
  if (errors.length) fail(errors.join('\n'));
  const reminder = ctx.thread ? reminderStep(handoverNextStep(content)) : null;
  if (reminder && !armedSchedule(readThreadState(ctx.brainDir, ctx.thread))) fail(REMINDER_REFUSAL(reminder));
  const holderError = syncAndCheckHolder(ctx.brainDir, `topics/${topic}/handover.md`, ctx.thread);
  if (holderError) fail(holderError);
  const ops = [{ path: `topics/${topic}/handover.md`, content }, setTopicState(ctx, topic, readTopic(ctx.brainDir, topic)?.state === 'paused' ? 'paused' : 'working')];
  const res = brainWrite(ctx, { ops, message: `handover ${topic}`, presynced: true });
  out(formatWriteResult(res, [`topics/${topic}/handover.md`]));
}

/** Persona docs/ (P-024): files written directly are committed and pushed in one script commit. */
function saveDocs(ctx) {
  if (!ctx.brainInfo?.persona) fail('save.mjs docs: only a persona keeps documents in brain (docs/, materialy/); in a project they belong to the project repo (P-024)');
  // materialy/ like docs/ (D-0011). A file is committed byte for byte (PDF, image); only .md is read as text for its checks.
  const st = spawnSync('git', ['status', '--porcelain', '-uall', '--', 'docs', 'materialy'], { cwd: ctx.brainDir, encoding: 'utf8' });
  const rels = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
  if (!rels.length) { out('unchanged: docs/, materialy/ (nothing to commit)'); return; }
  const read = (rel) => fs.readFileSync(path.join(ctx.brainDir, rel), rel.endsWith('.md') ? 'utf8' : undefined);
  const ops = rels.map((rel) => (fs.existsSync(path.join(ctx.brainDir, rel)) ? { path: rel, content: read(rel) } : { path: rel, remove: true }));
  const res = brainWrite(ctx, { ops, message: `docs: ${args.message || rels.join(', ')}` });
  finish(ctx, res, rels);
}

try {
  const ctx = loadContext({ project: args.project });
  const foreign = foreignProjectCwd(ctx, args.project);
  if (foreign) fail(foreign);
  const handlers = { memory: saveMemory, decision: saveDecision, rule: saveRule, exception: saveException, skill: saveSkill, handover: saveHandover, docs: saveDocs, move: saveMove };
  if (!handlers[category]) fail('usage: save.mjs memory|decision|rule|exception|skill|handover|docs|move ...');
  if (args.repo !== undefined && !['memory', 'decision', 'rule', 'skill', 'handover', 'move'].includes(category)) fail(`--repo: ${category} lives in brain only (memory, decision, rule, skill, handover and move take --repo)`);
  handlers[category](ctx);
} catch (err) {
  fail(err.message);
}
