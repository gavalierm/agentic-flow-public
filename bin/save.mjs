#!/usr/bin/env node
// Single entry point for writing knowledge (P-013, P-007, P-031, P-009, P-008, P-035, P-032, P-011).
// The agent classifies; this script only writes in a fixed format, deduplicates via find, commits via brain.mjs, regenerates indexes.
//   save.mjs memory <type> <name> --content "..." [--origin operator|derived|observed] [--aliases a,b] [--relates-to x,y] [--unrelate x,y] [--sources f1,f2] [--summary "..."] [--new]
//   save.mjs memory <type> <name> (--relates-to x,y | --unrelate x,y)   existing record: changes only its links, the body stays
//   save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y [--origin operator|agent] [--sources f1,f2] [--supersedes D-0001]
//   sources (D-0036) of memory (derived: required, observed: optional, operator: none) and of a decision: a file tracked
//   in git, D-NNNN, P-NNN or a URL; a new source in scratch/, local/, outside git or missing is refused (scripts/links.mjs)
//   save.mjs decision --relink D-XXXX [--repo [<repo>]] (--relates-to x,y | --unrelate x,y)   changes only the links of a decision
//   relates_to (D-0029): a record key (<type>-<name>), a decision (D-NNNN, <store>/D-NNNN), a principle (P-NNN) or a file
//   tracked in git; a new link that resolves to none of them is refused (scripts/links.mjs)
//   save.mjs decision --remove D-XXXX [--repo [<repo>]] [--path <file>] --reason "operator <YYYY-MM-DD>: <why>"   only on an explicit operator order (P-008); --path when two decisions share the ID
//   save.mjs rule <name> [--repo [<repo>]] --content "..." (--enforced-by <file>[:<symbol>][,...] | --unenforced "<why code cannot check it>") [--title "..."] | --remove --reason "..."
//   save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local] [--title "..."]
//   save.mjs exception P-XXX --remove --reason "..." [--layer project|harness|machine|local]   removes its section (one commit; an empty file goes)
//   save.mjs skill <name> --description "..." --content "..." --origin error|routine [--aliases a,b] [--script <file>[,<file>]] [--remove-script <file>[,<file>]] [--replace | --sed 's/<pattern>/<replacement>/[gim]' ...] (existing skill: --script or --description alone keeps the body; an edit needs --origin error|routine|operator, operator with --reason "operator <date>: ...") [--from-procedure <name>] [--from-sequence <seq>] | --remove --reason "..."
//   save.mjs handover <topic> (--task ".." --done "a; b" --next "a; b" --files "a; b" --questions "a; b" --tasks "a; b" [--done-replace "a; b"] | --file <path>)
//                        six sections (P-011); --next (a step in Ďalší krok) is refused in a topic in mode discussion (spec 10.6)
//   save.mjs docs [--message "..."]   persona only: commits the files written directly into docs/ (P-024)
//   save.mjs person <alias|id> [--domain [<d>]] --content "..." | <id> --name "<name>" --content "..." [--aliases] [--domains] [--new]
//                        a fact about a person: osoby/ of the operator repo (spec 4.3, 6; memory person|operator is refused)
//   every save of a thread that holds a topic first pulls and verifies its locks; a lost lock writes nothing (spec 4.2.4)
//   --repo writes go through the own clone of the workflow: pull, write, push on the knowledge branch (spec 4.1)
//   memory, decision, rule, skill: --repo [<name>] writes into <repo>/agentic/ of the domain (bare: the session repo); --brain "<why>" keeps a repo's record in brain
//   save.mjs handover --repo [<name>] (--file <path> | --content "...")   state of the repo: <repo>/agentic/HANDOVER.md
//   save.mjs move <brain path> --repo <name> [--dry-run]   moves a brain record (memory, decision, agentic skill) into the repo
//   save.mjs source <file|folder> [--topic <id>] [--description "..."] [--from <where>] [--as <name|subpath>] [--repo <name>]
//                        a source from outside, at once (spec 5, plan O15): zdroje/<topic>/ of the main target repo of the
//                        topic (layout 3: own clone, target branch or topic/<topic>--obsah when protected, 4.6), else of the
//                        project repo; a folder in one commit with names by the rule of names (the mapping is printed)
//   save.mjs source --record <file> --from <where> [--topic <id>] [--description "..."]   a file over the limit: its record
//   save.mjs source --check [--repo <name>]   files in the sources over the limit (exit 1)
//   save.mjs share <skill>[,<skill>] --to <brain dir> [--overwrite]   a saved agentic skill into another brain: one checked commit, pushed;
//     refused while the other brain has its own commits on the skill since the last share (--overwrite after taking them over)
//   save.mjs share <skill>[,<skill>] --to <brain dir> --retire --reason "..." [--overwrite]   removes the agentic skill in the
//     other brain (superseded there) by the same checked commit, pushed; git keeps it in the history
//   save.mjs result <file> [--topic <id>] [--as <name>] [--replace]   a result of the topic's work worth keeping, into
//                        topics/<topic>/ of the brain (spec 5; the SubagentStop hook writes none, O13)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lfBytes } from '../scripts/eol.mjs';
import { spawnSync } from 'node:child_process';
import { parseArgs, fail, today, readText, listFiles, relPosix, git, gitRemote } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, dialogAnsweredInTurn, machineName, foreignProjectCwd, resolveBrain, brainExists, projectPolicy, inSubagent, loadPolicy } from '../scripts/config.mjs';
import { isMainTopic, commsProjectName } from '../scripts/comms.mjs';
import { brainId } from '../scripts/brain-id.mjs';
import { brainWrite, formatWriteResult, syncAndCheckHolder, checkHolder, withBrainLock, hasRemote, brainSync, verifyHeldLocks, lockLostText } from '../scripts/brain.mjs';
import { parseFrontmatter, serializeFrontmatter, asList } from '../scripts/frontmatter.mjs';
import { makeKey, normalizeKey, hasDiacritics, isValidId, KEY_TYPES } from '../scripts/keys.mjs';
import { find, findSimilar } from '../scripts/find.mjs';
import { checkLinks, linkProblems, checkSources, sourceProblems } from '../scripts/links.mjs';
import { readDecisions, readSkills, nextDecisionId } from '../scripts/records.mjs';
import { DECISION_REMOVED_ENV } from './brain-precommit.mjs';
import { recordAuthors, foreignAuthor } from '../scripts/authors.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { ruleCorpus, judgeRule, unanswered, onlyCondenses } from '../scripts/rule-gate.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { mergeHandover, checkHandover, handoverNextStep, withReports } from '../scripts/brain-checks.mjs';
import { openReportLines, baseOf } from '../scripts/issue-watch.mjs';
import { removeNames } from '../scripts/logs.mjs';
import { setTopicState, readTopic, topicRel, heldTopics, isDiscussionMode, DISCUSSION_NEXT_REFUSAL } from '../scripts/topic.mjs';
import { dataPath, dataRel, layoutOf, hasData, layoutRefusal, topicHome, topicWorkLabel } from '../scripts/layout.mjs';
import { hasTypeTriage, targetRepoDir, mainTargetRepo, contentWrite, contentWhere } from '../scripts/target.mjs';
import { oversized, maxBytes, materialyDir, sourceAddOp, sourceAddDirOps, resultAddOp, recordBigFileOp } from '../scripts/materialy.mjs';
import { hasDataIndex, sourcesFileRel, sourcesWith } from '../scripts/data-index.mjs';
import { workflowSkillNames, PROJECT_SKILLS_DIR, syncBrainSkills, deployedSkillName } from '../scripts/skills-sync.mjs';
import { skillSources, PROJECT_KNOWLEDGE, domainRepos, knowledgeDirs, repoByName, sessionRepo, singleRepoOf, nextRepoDecisionId, repoWrite, formatRepoWrite, heldRepoTopic, repoPublic } from '../scripts/repo-knowledge.mjs';
import { isInside, nowIso } from '../scripts/util.mjs';
import { fieldsOp } from '../scripts/topic-files.mjs';
import { resultsActive, tmpOwner, readBindings, stalePages } from '../scripts/results.mjs';
import { uncitedDecisions, uncitedLine, boundSkills, boundLine } from '../scripts/skill-decisions.mjs';
import { checkSkill, meaningDiff, workLayout } from '../scripts/skill-check.mjs';
import { personRedirect, requireOperatorRepo, readPeople, findPeople, newPerson, changePerson, shortIdProblem, proposedId } from '../scripts/people.mjs';
import { machineStores, machineRecords, targetStore, sameStore, checkDecisionRefs, decisionRefs, rewriteDecisionRefs, subjectMatch, saveHint, displayPath, refFiles, isTombstone, SUBJECT_TYPES, ID_LINE, lc } from '../scripts/stores.mjs';

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
  if (own) fail(`${key} describes repo ${own}: its knowledge belongs to ${repoHome(ctx, own)}/ (add --repo ${own}); only when it is not knowledge of that repo alone: --brain "<why>" (D-0002, P-007)`);
  const one = singleRepoOf(ctx.domain, ctx.brainDir, refs);
  if (one && !all.some((r) => r.name === one && repoPublic(r.dir))) out(`note: looks like repo ${one} (every reference points into it): knowledge of that repo alone is saved with --repo ${one}; knowledge of several repos, people or the environment stays in brain (P-007)`);
}

/** Path of a record inside `<repo>/agentic/` from its brain-relative path, or null when it lies elsewhere. */
function knowledgeRel(ctx, recPath) {
  const abs = path.resolve(ctx.brainDir, recPath);
  // Layout 2: the knowledge root is the repo (or its topic worktree) itself; the path relative to it.
  const roots = domainRepos(ctx.domain, ctx.brainDir).flatMap((r) => knowledgeDirs(ctx.domain, r.name))
    .filter((k) => layoutOf(k.dir).projectKnowledge === '' && isInside(k.dir, abs)).sort((a, b) => b.dir.length - a.dir.length);
  if (roots.length) return toPosixPath(path.relative(roots[0].dir, abs));
  const parts = toPosixPath(path.relative(ctx.domain.root, abs)).split('/');
  const i = parts.indexOf(PROJECT_KNOWLEDGE);
  return i === -1 ? null : parts.slice(i + 1).join('/');
}

/** Root a record path is relative to: the knowledge folder of the repo (`<repo>/agentic/`), or the brain. */
const recordRoot = (ctx, repo) => (repo ? dataPath(path.join(ctx.domain.root, repo), 'projectKnowledge') : ctx.brainDir);
/** How a message names the knowledge of a repo: `<repo>/agentic` (layout 1), `<repo>` (layout 2: the repo root). */
const repoHome = (ctx, repo) => [repo, dataRel(path.join(ctx.domain.root, repo), 'projectKnowledge')].filter(Boolean).join('/');
/** Regex source of a literal path part (the map in layout.mjs). */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Owner folder of the agent's skills inside skills/ (P-032): an owner name, not a data folder of the map. */
const AGENTIC_OWNER = 'agentic';

/** Same key elsewhere (brain or another repo, or a topic worktree the thread does not hold) is refused: one record per key (P-031). */
function otherHome(ctx, matches, repo) {
  const held = repo ? heldRepoTopic(ctx, repo)?.topic || null : null;
  return matches.find((m) => (repo ? m.repo !== repo || (m.topic && m.topic !== held) : !!m.repo));
}

function saveMemory(ctx) {
  const [type, ...nameParts] = rest;
  const name = nameParts.join(' ');
  if (!type || !name) fail(`usage: save.mjs memory <type> <name> --content "..." | --remove --reason "..." (types: ${KEY_TYPES.join(', ')})`);
  if (args.remove) return removeMemory(ctx, type, name);
  // spec 4.3, 11.4: a person or the operator is written to osoby/ of the operator repo; memory keeps them for reading only.
  if (BRAIN_ONLY_TYPES.includes(type)) fail(personRedirect(type, name));
  // --relates-to or --unrelate alone changes the links of an existing record; body, origin and sources stay (D-0029:
  // the fix consolidate prints must not make the agent retype the content).
  const linksOnly = args.content === undefined && (args['relates-to'] !== undefined || args.unrelate !== undefined);
  if (args.content === undefined && !linksOnly) fail('--content required');
  const key = makeKey(type, name);
  let origin = args.origin || 'operator';
  if (!['operator', 'derived', 'observed'].includes(origin)) fail('origin must be operator | derived | observed (P-009)');
  let sources = asList(args.sources);
  if (!linksOnly && origin === 'derived' && !sources.length) fail('derived record needs --sources f1,f2 (P-009)');
  // An operator record is what the operator said: it has no source to check, and --sources was dropped silently (D-0036).
  if (!linksOnly && origin === 'operator' && sources.length) fail('--sources belong to a derived or observed record (what it was derived from or checked against); an operator record has none (D-0036)');
  const repo = repoTarget(ctx);
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
  let rel = dataRel(recordRoot(ctx, repo), 'memory', `${key}.md`);
  let existing = null;
  let by = null;
  if (byAlias.length) {
    rel = repo ? knowledgeRel(ctx, byAlias[0].path) : byAlias[0].path;
    existing = parseFrontmatter(readText(path.resolve(ctx.brainDir, byAlias[0].path), ''));
    // Author = who added the file (scripts/authors.mjs): a shared record is overwritten and the output names its author.
    // (Operator and person records are no memory type any more, spec 4.3: refused above.)
    by = repo ? null : foreignAuthor(recordAuthors(ctx.brainDir, { paths: [rel] }), rel);
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
  // --relates-to adds to the links a record has; --unrelate drops a link that no longer holds (a decision of another
  // store named bare, a removed record): a rewrite alone kept it and consolidate kept reporting it (D-0028).
  const linked = asList(existing?.data.relates_to);
  const unrelate = asList(args.unrelate);
  const absent = unrelate.filter((v) => !linked.includes(v));
  if (absent.length) fail(`--unrelate ${absent.join(', ')}: not in relates_to of ${existing?.data.key || key} (${linked.join(', ') || 'empty'}), nothing saved`);
  if (linksOnly) {
    if (!existing) fail(`${key} does not exist: --relates-to or --unrelate without --content changes the links of an existing record; give --content`);
    if (args.origin !== undefined || args.sources !== undefined || args.summary !== undefined || args.aliases !== undefined) fail('--relates-to or --unrelate without --content changes only the links: give --content to change origin, sources, summary or aliases');
    origin = existing.data.origin || 'operator';
    sources = asList(existing.data.sources);
  }
  // A new link must resolve (D-0029); links the record already has are reported, and the agent drops them with --unrelate.
  const added = asList(args['relates-to']).filter((v) => !linked.includes(v));
  const badLinks = checkLinks(ctx, target, added);
  if (badLinks) fail(badLinks);
  // A new source must last (D-0036); sources the record already has are named, like old links.
  const hadSources = asList(existing?.data.sources);
  const badSources = linksOnly ? null : checkSources(ctx, target, sources.filter((s) => !hadSources.includes(s)));
  if (badSources) fail(badSources);
  const oldBadSources = linksOnly ? [] : sourceProblems(ctx, target, sources.filter((s) => hadSources.includes(s)));
  const kept = linked.filter((v) => !unrelate.includes(v));
  const oldBad = linkProblems(ctx, target, kept);
  const data = {
    key: existing?.data.key || key,
    type,
    name: existing?.data.name || name,
    origin,
    aliases: [...new Set([...(asList(existing?.data.aliases)), ...asList(args.aliases)])],
    relates_to: [...new Set([...linked, ...asList(args['relates-to'])])].filter((v) => !unrelate.includes(v)),
    summary: args.summary || existing?.data.summary || undefined,
    created: existing?.data.created || today(),
    updated: today(),
  };
  if (origin === 'derived') {
    data.sources = sources;
    // Sources of a repo record are paths in that repo (D-0002), so consolidate checks them from any session. A links-only
    // edit keeps the fingerprint: the sources were not read again.
    data.fingerprint = linksOnly ? existing.data.fingerprint : fingerprint(repo ? path.join(ctx.domain.root, repo) : ctx.projectDir, sources);
  } else if (origin === 'observed' && sources.length) data.sources = sources; // where it was checked; no fingerprint (D-0036)
  const op = { path: rel, content: serializeFrontmatter(data, linksOnly ? existing.body : String(args.content)) };
  const notes = [
    oldBad.length ? `links of ${data.key} that resolve to nothing (drop or replace them: --unrelate x [--relates-to <key>]): ${oldBad.join('; ')}` : null,
    oldBadSources.length ? `sources of ${data.key} that do not last (replace them in --sources: a file in git, ${dataRel(ctx.projectDir, 'materialy')}/<topic>/, D-NNNN, P-NNN or a URL): ${oldBadSources.join('; ')}` : null,
  ].filter(Boolean);
  const note = notes.length ? `note: ${notes.join('; ')}` : null;
  if (repo) { out(formatRepoWrite(repoWrite(ctx, repo, { ops: [op], message: `save memory ${data.key}` }))); if (note) out(note); return; }
  const res = brainWrite(ctx, { ops: [op], message: `save memory ${data.key}` });
  finish(ctx, res, [rel]);
  if (by) out(`record by ${by}`);
  if (note) out(note);
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
    return out(`decision ${repo}/${key} removed; references to it elsewhere stay as they are, and consolidate reports them as history (removed in <commit>), not as references that do not resolve`);
  }
  const key = id.toUpperCase();
  // Two decisions with one ID (two saves at once, decision-id-race): --path names the one to remove; the first match
  // would have removed either of them.
  const hits = readDecisions(ctx.brainDir).filter((d) => (d.id || d.key) === key);
  if (!hits.length) fail(`decision ${key} not found`);
  const want = typeof args.path === 'string' ? toPosixPath(args.path).replace(/^\.\//, '') : null;
  if (want && !hits.some((d) => toPosixPath(d.path) === want)) fail(`decision ${key} has no file ${want}; its files: ${hits.map((d) => d.path).join(', ')}`);
  if (!want && hits.length > 1) fail(`decision ${key} has ${hits.length} files (one ID, two decisions): name the one to remove with --path <file>: ${hits.map((d) => d.path).join(', ')}`);
  const old = want ? hits.find((d) => toPosixPath(d.path) === want) : hits[0];
  const res = brainWrite(ctx, { ops: [{ path: old.path, remove: true }], message: `remove decision ${key}: ${args.reason}`, env: { [DECISION_REMOVED_ENV]: old.path } });
  finish(ctx, res, [old.path]);
  out(`decision ${key} removed; references to it elsewhere (relates_to, supersedes, commit messages) stay as they are, and consolidate reports them as history (removed in <commit>), not as references that do not resolve; a new record cannot link to it`);
}

// A memory record leaves through save only (P-013): a duplicate folded into its home record, a tombstone, a stale derived
// record. save had no way, and consolidate kept reporting them while the brain hook denies the shell (D-0028).
// A record of origin operator goes only on an explicit operator order (P-009); a tombstone holds no subject of its own.
function removeMemory(ctx, type, name) {
  const key = makeKey(type, name);
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread) && !dialogAnsweredInTurn(ctx.brainDir, ctx.thread)) fail('memory records cannot be removed in a turn started by a message, and the operator answered no dialog in it: ask the operator with AskUserQuestion (P-047)');
  if (!args.reason || args.reason === true) fail(`--remove needs --reason "<why>": nothing removed (${key})`);
  const repo = repoTarget(ctx);
  const held = repo ? heldRepoTopic(ctx, repo)?.topic || null : null;
  const same = find(ctx.brainDir, key, ctx.domain).filter((m) => m.kind === 'memory' && m.key === key);
  const hit = same.find((m) => (repo ? m.repo === repo && (!m.topic || m.topic === held) : !m.repo));
  if (!hit) {
    const other = same.find((m) => m.repo);
    fail(`memory ${key} not found in ${repo ? `repo ${repo}` : 'brain'}${other ? `; it is in repo ${other.repo}: add --repo ${other.repo}` : ''}`);
  }
  const abs = path.resolve(ctx.brainDir, hit.path);
  const { data, body } = parseFrontmatter(readText(abs, ''));
  if (data.origin === 'operator' && !isTombstone(body) && !OPERATOR_REASON_RE.test(String(args.reason))) fail(`${key} is an operator record (origin: operator): it is removed only on an explicit operator order, --reason "operator <YYYY-MM-DD>: <why>"; otherwise rewrite it with save.mjs memory ${type} ${name} --content "..." (P-009)`);
  // Records that still name the key (relates_to, text) are listed for the agent to change; the record of the same key in
  // another store is that store's own record, not a reference.
  const word = new RegExp(`(^|[^a-z0-9-])${key}([^a-z0-9-]|$)`, 'i');
  const named = machineStores(ctx).flatMap((s) => refFiles(s)).filter((f) => path.resolve(f) !== abs && word.test(readText(f, '').replace(/^key:.*$/m, '')));
  const message = `remove memory ${key}: ${args.reason}`;
  if (repo) out(formatRepoWrite(repoWrite(ctx, repo, { ops: [{ path: knowledgeRel(ctx, hit.path), remove: true }], message })));
  else finish(ctx, brainWrite(ctx, { ops: [{ path: hit.path, remove: true }], message }), [hit.path]);
  out(`memory ${key} removed; ${named.length ? `still named in (change them with save): ${[...new Set(named.map(toPosixPath))].join(', ')}` : 'no other record names it'}`);
}

/**
 * Links of a decision (D-0029): --relink D-XXXX with --relates-to adds, --unrelate drops; the choice and its body stay
 * (a wrong link is no new choice, so no --supersedes). A decision keeps at least one link (P-008).
 */
function relinkDecision(ctx) {
  const id = String(args.relink === true ? rest[0] || '' : args.relink).trim();
  if (!/^([a-z0-9-]+\/)?D-\d{4}$/i.test(id) || (args['relates-to'] === undefined && args.unrelate === undefined)) fail('usage: save.mjs decision --relink D-XXXX [--repo [<repo>]] (--relates-to x,y | --unrelate x,y)');
  const repo = repoTarget(ctx);
  const target = targetStore(ctx, repo);
  const key = (repo ? id.replace(new RegExp(`^${repo}/`), '') : id).toUpperCase();
  let hit;
  if (repo) {
    const held = heldRepoTopic(ctx, repo)?.topic || null;
    hit = find(ctx.brainDir, key, ctx.domain).find((m) => m.kind === 'decision' && m.repo === repo && (!m.topic || m.topic === held));
  } else hit = readDecisions(ctx.brainDir).find((d) => (d.id || d.key) === key);
  if (!hit) fail(`decision ${id} not found${repo ? ` in repo ${repo}` : ''}`);
  const parsed = parseFrontmatter(readText(path.resolve(ctx.brainDir, hit.path), ''));
  const linked = asList(parsed.data.relates_to);
  const unrelate = asList(args.unrelate);
  const absent = unrelate.filter((v) => !linked.includes(v));
  if (absent.length) fail(`--unrelate ${absent.join(', ')}: not in relates_to of ${key} (${linked.join(', ') || 'empty'}), nothing saved`);
  const added = asList(args['relates-to']).filter((v) => !linked.includes(v));
  const refs = checkDecisionRefs(ctx, target, added);
  if (refs) fail(refs);
  const bad = checkLinks(ctx, target, added);
  if (bad) fail(bad);
  const relates = [...new Set([...linked, ...added])].filter((v) => !unrelate.includes(v));
  if (!relates.length) fail(`decision ${key} keeps at least one link (P-008): add --relates-to <key|D-NNNN|P-NNN|file> with the --unrelate`);
  const op = { path: repo ? knowledgeRel(ctx, hit.path) : hit.path, content: serializeFrontmatter({ ...parsed.data, relates_to: relates, updated: today() }, parsed.body) };
  const message = `relink decision ${key}`;
  if (repo) out(formatRepoWrite(repoWrite(ctx, repo, { ops: [op], message })));
  else finish(ctx, brainWrite(ctx, { ops: [op], message }), [hit.path]);
  out(`decision ${repo ? `${repo}/` : ''}${key} relates_to: ${relates.join(', ')}`);
}

function saveDecision(ctx) {
  if (args.remove) return removeDecision(ctx);
  if (args.relink !== undefined) return relinkDecision(ctx);
  const title = rest.join(' ');
  if (!title) fail('usage: save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y');
  const relates = asList(args['relates-to']);
  if (!relates.length) fail('decision needs --relates-to (P-008, P-031)');
  if (!args.what || !args.reason) fail('decision needs --what and --reason (P-008)');
  const repo = repoTarget(ctx);
  const refs = checkDecisionRefs(ctx, targetStore(ctx, repo), [title, args.what, args.alternatives, args.reason, ...relates, args.supersedes].map((v) => (typeof v === 'string' ? v : '')));
  if (refs) fail(refs);
  const badLinks = checkLinks(ctx, targetStore(ctx, repo), relates);
  if (badLinks) fail(badLinks);
  // Who decided and on what basis (D-0036): the origin was only free text in the body, so nobody could check or filter it.
  const origin = args.origin || 'operator';
  if (!['operator', 'agent'].includes(origin)) fail('decision origin must be operator | agent (who decided, D-0036)');
  const sources = asList(args.sources);
  const badSources = checkSources(ctx, targetStore(ctx, repo), sources);
  if (badSources) fail(badSources);
  const meta = { origin, sources: sources.length ? sources : undefined };
  if (repo) return saveRepoDecision(ctx, repo, title, relates, meta);
  brainGuard(ctx, '', relates);
  if (args.supersedes && !readDecisions(ctx.brainDir).some((d) => (d.id || d.key) === args.supersedes)) fail(`decision ${args.supersedes} not found`);
  const slug = normalizeKey(title).slice(0, 40);
  // The ID is assigned under the brain lock after a sync: two threads saving at once both got D-0033 when the ID was taken
  // before the lock (report-392ea415, 2026-11-13).
  let id; let rel;
  const res = withBrainLock(ctx.brainDir, () => {
    if (hasRemote(ctx.brainDir)) brainSync(ctx.brainDir);
    id = nextDecisionId(ctx.brainDir);
    rel = dataRel(ctx.brainDir, 'decisions', `${id.toLowerCase()}-${slug}.md`);
    const ops = [];
    const old = args.supersedes ? readDecisions(ctx.brainDir).find((d) => (d.id || d.key) === args.supersedes) : null;
    if (old) {
      const parsed = parseFrontmatter(readText(path.join(ctx.brainDir, old.path), ''));
      ops.push({ path: old.path, content: serializeFrontmatter({ ...parsed.data, status: `superseded-by ${id}`, updated: today() }, parsed.body) });
    }
    // The topic this thread works on (frontmatter `topic`): the decision names the topic it was made in.
    const topic = heldTopics(ctx.brainDir, ctx.thread).find((t) => t.kind !== 'main')?.id;
    const data = { key: id, id, title, status: 'valid', ...meta, relates_to: relates, aliases: asList(args.aliases), supersedes: args.supersedes || undefined, ...(topic ? { topic } : {}), created: today() };
    const body = `**Rozhodnuté:** ${args.what}\n\n**Zamietnuté alternatívy:** ${args.alternatives || '-'}\n\n**Dôvod:** ${args.reason}\n`;
    ops.push({ path: rel, content: serializeFrontmatter(data, body) });
    return brainWrite(ctx, { ops, message: `save decision ${id} ${slug}` });
  });
  finish(ctx, res, [rel]);
  out(`decision ${id}: reference it in the commit message of the change it drives (P-008)`);
  // Report 2026-11-17: a decision of one topic set the output of a skill another topic edited, and never reached it.
  try { const line = boundLine(id, boundSkills(ctx.brainDir, { id, title, body: `${args.what} ${args.reason || ''}` })); if (line) out(line); } catch { /* a hint never fails the save */ }
}

// The ID is assigned under the repo lock (repoWrite takes it again, re-entrant): two threads saving into one repo at once,
// from the checkout and a topic worktree, would both get the next ID (decision-id-race, 2026-11-13). Checks that fail()
// run before the lock: process.exit skips its release.
/** Decision of one repo: numbered within the repo over its main checkout and all topic worktrees (`<repo>/D-0001`). */
function saveRepoDecision(ctx, repo, title, relates, meta) {
  let old = null;
  if (args.supersedes) {
    const held = heldRepoTopic(ctx, repo)?.topic || null;
    old = find(ctx.brainDir, String(args.supersedes).replace(new RegExp(`^${repo}/`), ''), ctx.domain)
      .find((m) => m.kind === 'decision' && m.repo === repo && (!m.topic || m.topic === held));
    if (!old) fail(`decision ${args.supersedes} not found in repo ${repo}`);
  }
  withBrainLock(repoByName(ctx.domain, repo, ctx.brainDir).dir, () => saveRepoDecisionLocked(ctx, repo, title, relates, old, meta));
}

function saveRepoDecisionLocked(ctx, repo, title, relates, old, meta) {
  const id = nextRepoDecisionId(ctx.domain, repo);
  const slug = normalizeKey(title).slice(0, 40);
  const rel = dataRel(recordRoot(ctx, repo), 'decisions', `${id.toLowerCase()}-${slug}.md`);
  const ops = [];
  if (old) {
    const parsed = parseFrontmatter(readText(path.resolve(ctx.brainDir, old.path), ''));
    ops.push({ path: knowledgeRel(ctx, old.path), content: serializeFrontmatter({ ...parsed.data, status: `superseded-by ${id}`, updated: today() }, parsed.body) });
  }
  const data = { key: id, id, title, status: 'valid', ...meta, relates_to: relates, aliases: asList(args.aliases), supersedes: args.supersedes ? String(args.supersedes).replace(new RegExp(`^${repo}/`), '') : undefined, created: today() };
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
    fail(`a rule needs --enforced-by <file>[:<symbol>] (the hook, script or test that blocks the violation; write that code first, skill ${deployedSkillName(ctx.projectDir, 'fix')}) or --unenforced "<why code cannot check it>"; a rule only in text is not reliable (operator 2026-11-02)`);
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
  // agent-alice/D-0094: the exceptions of the project (exceptions/*.md of the brain that grants them) replace their principle
  // here as in the session; a conflict with a principle the project has an exception to is no conflict (3 false refusals).
  const excepted = new Set((rules.exceptions || []).map((e) => e.id));
  const corpus = ruleCorpus({ brainDir: where.brainDir, coreDir: path.join(ctx.pluginRoot, 'rules'), skip: where.id, layers: where.layers, exceptions: rules.exceptions });
  const judged = judgeRule({ id: where.id, text: content, enforcedBy, oldText: isNew ? '' : oldBody }, corpus, { spawn: spawnSync });
  const verdict = { ...judged, conflicts: judged.conflicts.filter((c) => !excepted.has(c.id)) };
  const list = (a) => a.map((x) => `${x.id} (${x.how})`).join('; ');
  const fix = (id) => (/^P-\d{3}$/.test(id) ? `${id} is a workflow principle: report it to the workflow maintainer (error.mjs report --title ... --text ...) or save an exception`
    : id.includes('/') ? `save.mjs rule ${id.split('/')[1]} --repo ${id.split('/')[0]} --content "<reworded>"` : `save.mjs rule ${id} --content "<reworded>"`);
  if (verdict.conflicts.length) fail(`rule ${name} conflicts with ${list(verdict.conflicts)}: two rules must not order different behaviour; resolve the conflict in that rule first (${verdict.conflicts.map((c) => fix(c.id)).join('; ')}), then save this one only if something is left [${verdict.by}]`);
  if (!isNew) return;
  const open = unanswered(verdict.overlaps, args.distinct);
  if (open.length) fail(`rule ${name} overlaps ${list(verdict.overlaps.filter((o) => open.includes(o.id)))}: extend or narrow the existing rule instead of a new one (${open.map(fix).join('; ')}); only when it truly is another subject: --distinct "<id>: <how it differs and why it does not conflict>; …" for each [${verdict.by}]`);
  if (verdict.code_instead && !(typeof args['needs-text'] === 'string' && args['needs-text'].trim().length >= 20)) fail(`rule ${name} can be enforced by code alone: ${verdict.code_instead} Do that (skill ${deployedSkillName(ctx.projectDir, 'fix')}, or report it to the workflow maintainer: error.mjs report) and drop the rule; the code's own message teaches the agent. Only when the agent must know it before acting: --needs-text "<why>" [${verdict.by}]`);
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
  return { repo, dir, base: dataPath(dir, 'projectKnowledge'), brainDir, policy: composed.policy, layers: composed.layers, id: `${repo}/${name}` };
}

function saveRule(ctx) {
  const [name] = rest;
  if (!name || !isValidId(name)) fail('usage: save.mjs rule <name> [--repo [<repo>]] --content "..." | --remove --reason "..." (name: lowercase, digits, hyphens)');
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('rules cannot change in a turn started by a message (P-047)');
  // A rule of one repo lives in that repo (`<repo>/agentic/rules/`, D-0025), written by repoWrite like its other knowledge.
  const repo = repoTarget(ctx);
  const target = repo ? repoRuleTarget(ctx, repo, name) : null;
  const rel = dataRel(target ? target.base : ctx.brainDir, 'rules', `${name}.md`);
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

const SED_SPECIAL = '().*+?[]{}|^$\\';

/**
 * Hint for a --sed pattern that matched nothing (flow-public#79: `(D-0038)` was read as a group and the agent searched
 * the text for the mistake): the pattern is a regex, which characters to escape, and, when the pattern has unescaped
 * special characters and its plain text is in the body, that escaping them is the fix.
 */
function sedRegexHint(body, pattern, flags) {
  const bare = [];
  let plain = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) { plain += SED_SPECIAL.includes(pattern[i + 1]) ? pattern[i + 1] : pattern.slice(i, i + 2); i++; continue; }
    if (SED_SPECIAL.includes(pattern[i]) && !bare.includes(pattern[i])) bare.push(pattern[i]);
    plain += pattern[i];
  }
  let hint = `; the pattern is a JavaScript regex: escape ${SED_SPECIAL.split('').join(' ')} with a backslash to match them as text`;
  const hay = flags.includes('i') ? body.toLowerCase() : body;
  if (bare.length && hay.includes(flags.includes('i') ? plain.toLowerCase() : plain)) hint += `; as plain text the pattern is in the body: escape ${bare.join(' ')} (${bare.map((c) => `\\${c}`).join(' ')})`;
  return hint;
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
  // Line-oriented like sed: ^ and $ match at every line, not only at the start and end of the body (report-fb996133:
  // `s/^- Krok/.../` reported "pattern not found" for a line inside the body).
  const re = new RegExp(parts[0], parts[2].includes('m') ? parts[2] : `${parts[2]}m`);
  if (!re.test(body)) throw new Error(`--sed ${expr}: pattern not found in the skill body; nothing changed${sedRegexHint(body, parts[0], parts[2])}`);
  re.lastIndex = 0;
  // sed group references \1..\9 are honoured like $1..$9 (report-46e5fd4c: `\1` was written into the skill verbatim
  // and the clause matched by the group was lost); & stays literal, because skill texts carry `&&`.
  const groups = new RegExp(`${parts[0]}|`).exec('').length - 1;
  const repl = parts[1].replace(/\\([1-9])/g, (_, n) => {
    if (Number(n) > groups) throw new Error(`--sed ${expr}: \\${n} names a group the pattern does not have; nothing changed`);
    return `$${n}`;
  }).replace(/\\n/g, '\n');
  return body.replace(re, repl);
}

function saveException(ctx) {
  const [id] = rest;
  if (!/^P-\d{3}$/.test(id || '')) fail('usage: save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local] | --remove --reason "..."');
  if (args.remove) {
    if (!args.reason || args.reason === true) fail(`--remove needs --reason "<why>": nothing removed (${id})`);
  } else if (!args.wording || !args.reason) fail('exception needs --wording and --reason (P-035)');
  if (!args.remove && (ctx.policy.immutable_principles || []).includes(id)) fail(`${id} is immutable and cannot be overridden (P-035)`);
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('exceptions cannot change in a turn started by a message (P-047)');
  const layer = args.layer || 'project';
  const file = layer === 'project' ? dataRel(ctx.brainDir, 'exceptions', 'project.md')
    : layer === 'harness' ? dataRel(ctx.brainDir, 'exceptions', `harness-${normalizeKey(args.harness || 'claude-code')}.md`)
      : layer === 'machine' ? dataRel(ctx.brainDir, 'exceptions', `machine-${normalizeKey(args.machine || machineName())}.md`)
        : layer === 'local' ? dataRel(ctx.brainDir, 'local', 'exceptions.md') : null;
  if (!file) fail('layer must be project | harness | machine | local');
  const current = readText(path.join(ctx.brainDir, file), '');
  const blocks = current.split(/^(?=### )/m).filter((b) => b.trim());
  if (args.remove) return removeException(ctx, { id, layer, file, blocks });
  const entry = `### ${id}${args.title ? `: ${args.title}` : ''}\nZnenie: ${args.wording}\nDôvod: ${args.reason}\n`;
  const kept = blocks.filter((b) => !new RegExp(`^###\\s+${id}\\b`).test(b));
  const content = [...kept.map((b) => b.trim()), entry.trim()].join('\n\n') + '\n';
  if (layer === 'local') {
    fs.mkdirSync(dataPath(ctx.brainDir, 'local'), { recursive: true });
    fs.writeFileSync(path.join(ctx.brainDir, file), content);
    out(`written: ${file} (local layer, not committed)`);
    return;
  }
  const res = brainWrite(ctx, { ops: [{ path: file, content }], message: `save exception ${id} (${layer})` });
  finish(ctx, res, [file]);
}

/**
 * `exception P-XXX --remove --reason "..."`: the section of the exception leaves the file of its layer in one commit
 * (brainWrite); a file left without content is removed. An exception the layer does not have fails with the layer and
 * the file, nothing written. The locks of a write hold (a bell turn is refused, P-047).
 */
function removeException(ctx, { id, layer, file, blocks }) {
  const own = (b) => new RegExp(`^###\\s+${id}\\b`).test(b);
  if (!blocks.some(own)) fail(`exception ${id} is not in layer ${layer} (${file}): nothing removed`);
  const kept = blocks.filter((b) => !own(b)).map((b) => b.trim()).filter(Boolean);
  const content = kept.length ? `${kept.join('\n\n')}\n` : null;
  const reason = String(args.reason).replace(/\s+/g, ' ').trim();
  if (layer === 'local') {
    const abs = path.join(ctx.brainDir, file);
    if (content) fs.writeFileSync(abs, content); else fs.rmSync(abs, { force: true });
    out(`exception ${id} removed: ${file} ${content ? 'rewritten' : 'removed (empty)'} (local layer, not committed)`);
    return;
  }
  const res = brainWrite(ctx, { ops: [content ? { path: file, content } : { path: file, remove: true }], message: `remove exception ${id} (${layer}): ${reason}` });
  finish(ctx, res, [file]);
  out(`exception ${id} removed from layer ${layer}${content ? '' : ` (${file} had no other exception: file removed)`}`);
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

/**
 * issue #64: after a test an agent changed an existing skill on its own (a lesson read as a permission, P-002); an edit
 * of an existing skill names its basis: error (a mistake, P-003), routine (repeated procedure, consolidate, P-005) or
 * operator with their order in --reason "operator <YYYY-MM-DD>: <their words>" (or --approved of P-032). The basis
 * goes into the commit message of the brain or repo.
 */
function editBasis(name) {
  const o = args.origin;
  if (o === undefined && typeof args.approved === 'string' && args.approved.trim().length >= 2) return `operator: ${args.approved.trim().slice(0, 120)}`;
  if (!['error', 'routine', 'operator'].includes(o)) fail(`skill ${name} exists: an edit names its basis with --origin error (a mistake of this session, P-003) | routine (repeated procedure, consolidate, P-005) | operator with --reason "operator <YYYY-MM-DD>: <their words>"; a lesson from a test or your own idea is no basis: propose the change to the operator (P-002)`);
  if (o !== 'operator') return o;
  if (!OPERATOR_REASON_RE.test(String(args.reason || ''))) fail('--origin operator needs --reason "operator <YYYY-MM-DD>: <their words>" (the order the edit carries out, P-002)');
  return `operator: ${String(args.reason).replace(/^operator\b[:\s]*/i, '').slice(0, 120)}`;
}

/**
 * Whether a skill body still calls its own script `base`: a bare name or a path through this skill's folder counts, a
 * path through another skill's folder (`<other-skill>/<base>`, the script moved there) does not (a project 2026-11-18).
 */
export function namesOwnScript(text, base, skillName) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of String(text).matchAll(new RegExp(`(?:([\\w.-]+)/)?${esc}(?![\\w.-])`, 'g'))) {
    if (m.index > 0 && /[\w.-]/.test(text[m.index - 1]) && !m[1]) continue; // part of a longer name
    if (!m[1] || m[1] === skillName) return true;
  }
  return false;
}

function saveSkill(ctx) {
  const [name] = rest;
  // report-5d6c4ce2: the usage listed only the new-skill form, so an agent editing an existing skill passed a
  // placeholder --description and it replaced the real one; the edit forms keep the description without it.
  if (!name || !isValidId(name) || hasDiacritics(name)) fail('usage: save.mjs skill <name> --description "Použi, keď ..." --content "..." --origin error|routine (new skill)\n'
    + '       save.mjs skill <name> --origin error|routine|operator --sed \'s/<pattern>/<replacement>/\' | --script <file> | --content "..." --replace (existing skill: keeps its description; --description only to change it, it replaces the old one)');
  const repo = repoTarget(ctx);
  if (repo) return saveRepoSkill(ctx, repo, name);
  if (args.remove) return removeSkill(ctx, name);
  if (workflowSkillNames().includes(name)) fail(`"${name}" is a workflow skill name; choose another (P-024)`);
  const inRepo = ctx.domain && find(ctx.brainDir, name, ctx.domain).find((m) => m.kind === 'skill' && m.repo);
  if (inRepo) fail(`skill ${name} exists in repo ${inRepo.repo} (${inRepo.path}): one skill name per domain, skills-sync deploys both; save it with --repo ${inRepo.repo}`);
  const origin = args.origin || 'error';
  if (!['error', 'routine', 'operator'].includes(origin)) fail('origin must be error | routine (P-032); operator only for an edit of an existing skill');
  const sed = args.sed === undefined ? null : SEDS.length ? SEDS : [String(args.sed)];
  if (sed !== null && (args.content !== undefined || args.replace)) fail('--sed edits the existing body; do not combine it with --content or --replace');
  // --script alone adds or updates the scripts of an existing skill and keeps its body (report-dffad7fe: an agent
  // passed a dummy --sed 's/^/^/' to save only a script and the edit put a ^ in front of the body). --description alone
  // likewise changes only the description (workflow-dev 2026-11-14: it was refused and the body had to be re-sent).
  // --remove-script drops scripts of an existing skill (a project 2026-11-18: scripts moved to another skill stayed in the
  // old one, in its deployed copy and, by share, in the other brain; only --remove of the whole skill existed).
  const removeList = asList(args['remove-script']).map((x) => path.basename(String(x)));
  const scriptOnly = sed === null && args.content === undefined && !args.replace && (asList(args.script).length > 0 || removeList.length > 0 || Boolean(args.description));
  if (sed === null && args.content === undefined && !scriptOnly) fail('--content required (or --sed s/<pattern>/<replacement>/ to edit an existing skill, or --script / --remove-script / --description alone to change its scripts or description)');
  const skills = readSkills(ctx.brainDir);
  const hit = skills.find((s) => s.skillName === name || s.aliases.map(normalizeKey).includes(normalizeKey(name)))
    || find(ctx.brainDir, name).map((m) => skills.find((s) => s.path === m.path)).find(Boolean);
  const ops = [];
  let rel;
  let basis = null;
  if (hit) {
    basis = editBasis(hit.skillName);
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
    if (origin === 'operator') fail('--origin operator is for an edit of an existing skill; a new skill is error | routine (P-032)');
    if (scriptOnly) fail(`--${asList(args.script).length ? 'script' : 'description'} alone: skill ${name} does not exist; a new skill needs --content`);
    if (!args.description) fail('new skill needs --description "Použi, keď ..." (trigger, P-003)');
    rel = dataRel(ctx.brainDir, 'skills', AGENTIC_OWNER, name, 'SKILL.md');
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
  if (removeList.length) {
    if (!hit) fail(`--remove-script: skill ${name} does not exist`);
    for (const base of removeList) {
      if (base === 'SKILL.md') fail('--remove-script: SKILL.md is the skill itself; remove the whole skill with --remove --reason "..."');
      if (scriptFiles.includes(base)) fail(`--remove-script ${base}: also given in --script; one of them`);
      if (!fs.existsSync(path.join(skillDir, base))) fail(`--remove-script ${base}: skill ${name} has no such file (${toPosixPath(path.relative(ctx.brainDir, skillDir))}/)`);
      // The body must not call a script that goes: the deployed path would point at nothing.
      if (namesOwnScript(ops[0].content, base, path.basename(skillDir))) fail(`--remove-script ${base}: SKILL.md still names it; change the body in the same call (--sed or --content --replace), nothing saved`);
      ops.push({ path: `${path.posix.dirname(toPosixPath(rel))}/${base}`, remove: true });
    }
  }
  const scriptTexts = Object.fromEntries(ops.slice(1).filter((o) => !o.remove).map((o) => [path.posix.basename(o.path), o.content]));
  const found = checkSkill({ name: path.basename(path.dirname(rel)), dir: skillDir, text: ops[0].content, owner: rel.split('/')[1], projectDir: ctx.projectDir, limit: ctx.policy?.limits?.skill_description_chars ?? 300, pendingScripts: scripts.map((s) => path.posix.basename(s)), removedScripts: removeList, layout: workLayout(ctx), scriptTexts });
  const errors = found.filter((x) => x.level === 'error');
  if (errors.length) fail(`skill check: ${errors.map((x) => `${x.line ? `line ${x.line} ` : ''}${x.message}`).join('; ')}; nothing saved (workflow:skill-check)`);
  for (const w of found.filter((x) => x.level === 'warn')) out(`skill check warn: ${w.line ? `line ${w.line} ` : ''}${w.message}`);
  if (args['from-procedure']) ops.push(removeNames(ctx.brainDir, 'procedures.log', asList(args['from-procedure'])));
  if (args['from-sequence']) ops.push(removeNames(ctx.brainDir, 'sequences.log', asList(args['from-sequence'])));
  const res = brainWrite(ctx, { ops, message: `save skill ${name} (${hit ? `${sed !== null ? 'edit' : 'refactor'}, ${basis}` : origin})` });
  finish(ctx, res, [rel, ...scripts]);
  const notDeployed = deploySkills(ctx);
  out(hit ? `${sed !== null ? 'edited' : 'refactored'} existing skill ${hit.skillName}` : `new skill ${name} (origin: ${origin})`);
  if (removeList.length) out(`removed from skill ${name}: ${removeList.join(', ')} (brain and deployed copy; save.mjs share removes them in the other brain too)`);
  // D-0065: in a persona its own skill is deployed as <persona>-<name>; the brain keeps the name.
  const deployedName = deployedSkillName(ctx.projectDir, name);
  out(notDeployed ? `not deployed to the project (${notDeployed}); it reaches the project at the next session start` : `deployed to ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR))}${deployedName !== name ? ` as skill ${deployedName}` : ''}`);
  // P-052: the skill text calls its script by the deployed absolute path, never relative to the cwd or from scratch.
  for (const s of scripts) out(`script runs as: ${runners.get(s)} ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR, deployedName, path.posix.basename(s)))} (write this path in the skill text)`);
  // Report 2026-11-17: the skill was called consistent with the decisions it cites; a valid decision of another topic it does not cite set its output.
  try { const line = uncitedLine(uncitedDecisions(ctx.brainDir, String(ops[0].content))); if (line) out(line); } catch { /* a hint never fails the save */ }
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
  const kdir = dataPath(held ? heldRepoTopic(ctx, repo).dir : path.join(ctx.domain.root, repo), 'projectKnowledge');
  const dirAbs = dataPath(kdir, 'skills', name);
  const rel = hit ? knowledgeRel(ctx, hit.path) : dataRel(kdir, 'skills', name, 'SKILL.md');
  if (args.remove) {
    if (!hit) fail(`skill ${name} does not exist in repo ${repo}`);
    if (!args.reason) fail('--remove needs --reason "superseded by workflow:<skill> | P-XXX | ..."');
    const files = fs.existsSync(dirAbs) ? fs.readdirSync(dirAbs, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dirAbs, f)).isFile()) : [];
    out(formatRepoWrite(repoWrite(ctx, repo, { ops: files.map((f) => ({ path: dataRel(kdir, 'skills', name, toPosixPath(f)), remove: true })), message: `remove skill ${name}: ${args.reason}` })));
    const notDeployed = deploySkills(ctx);
    if (notDeployed) out(`not removed from this project (${notDeployed}); it leaves at the next session start`);
    return;
  }
  const origin = args.origin || 'error';
  if (!['error', 'routine', 'operator'].includes(origin)) fail('origin must be error | routine (P-032); operator only for an edit of an existing skill');
  const sed = args.sed === undefined ? null : SEDS.length ? SEDS : [String(args.sed)];
  if (sed !== null && (args.content !== undefined || args.replace)) fail('--sed edits the existing body; do not combine it with --content or --replace');
  const scriptOnly = sed === null && args.content === undefined && !args.replace && (asList(args.script).length > 0 || Boolean(args.description));
  if (sed === null && args.content === undefined && !scriptOnly) fail('--content required (or --sed s/<pattern>/<replacement>/ to edit an existing skill, or --script / --description alone to add a script to it or change its description)');
  let text;
  let basis = null;
  if (hit) {
    basis = editBasis(name);
    const parsed = parseFrontmatter(readText(path.resolve(ctx.brainDir, hit.path), ''));
    const data = { ...parsed.data, aliases: [...new Set([...asList(parsed.data.aliases), ...asList(args.aliases)])], updated: today() };
    if (args.description) data.description = args.description;
    if (sed === null && !args.replace && !scriptOnly) requireRefactor(name, hit.path, parsed.body);
    const body = scriptOnly ? parsed.body : sed !== null ? sed.reduce((b, e) => applySed(b, e), parsed.body) : `${String(args.content).trim()}\n`;
    text = serializeFrontmatter(data, body);
  } else {
    if (sed !== null) fail(`--sed: skill ${name} does not exist in repo ${repo}`);
    if (origin === 'operator') fail('--origin operator is for an edit of an existing skill; a new skill is error | routine (P-032)');
    if (scriptOnly) fail(`--${asList(args.script).length ? 'script' : 'description'} alone: skill ${name} does not exist in repo ${repo}; a new skill needs --content`);
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
  const found2 = checkSkill({ name, dir: dirAbs, text, owner: 'agentic', projectDir: ctx.projectDir, limit: ctx.policy?.limits?.skill_description_chars ?? 300, pendingScripts: scripts, layout: workLayout(ctx), scriptTexts: Object.fromEntries(ops.slice(1).map((o) => [path.posix.basename(o.path), o.content])) });
  const errors = found2.filter((x) => x.level === 'error');
  if (errors.length) fail(`skill check: ${errors.map((x) => `${x.line ? `line ${x.line} ` : ''}${x.message}`).join('; ')}; nothing saved (workflow:skill-check)`);
  for (const w of found2.filter((x) => x.level === 'warn')) out(`skill check warn: ${w.line ? `line ${w.line} ` : ''}${w.message}`);
  out(formatRepoWrite(repoWrite(ctx, repo, { ops, message: `save skill ${name} (${hit ? `${sed !== null ? 'edit' : 'refactor'}, ${basis}` : origin})` })));
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
  out(formatRepoWrite(repoWrite(ctx, repo, { ops: [{ path: dataRel(recordRoot(ctx, repo), 'repoHandover'), content: content.endsWith('\n') ? content : `${content}\n` }], message: `handover ${repo}` })));
}

/**
 * Move a brain record of one repo into the repo (D-0002): written into the repo first, then removed from brain; no
 * "moved" stub stays. A decision gets the next number of the repo and `moved_from: <brain>/<old id>`.
 */
function saveMove(ctx) {
  const [src] = rest;
  const repo = repoTarget(ctx);
  if (!src || !repo) { const B = layoutOf(ctx.brainDir); fail(`usage: save.mjs move <brain path: ${B.memory}/<key>.md | ${B.decisions}/<file>.md | ${B.skills}/${AGENTIC_OWNER}/<name>> --repo <name> [--dry-run]`); }
  const rel = toPosixPath(src).replace(/^\.\//, '').replace(/\/$/, '');
  const abs = path.join(ctx.brainDir, rel);
  // Brain paths that move (memory, decisions, an agentic skill), from the map of the brain and of the repo (layout.mjs).
  const L = Object.fromEntries(['memory', 'decisions', 'skills'].map((n) => [n, esc(layoutOf(ctx.brainDir)[n])]));
  const MOVE_MEMORY = new RegExp(`^${L.memory}/[^/]+\\.md$`);
  const MOVE_DECISION = new RegExp(`^${L.decisions}/[^/]+\\.md$`);
  const MOVE_SKILL = new RegExp(`^${L.skills}/${AGENTIC_OWNER}/[^/]+(/SKILL\\.md)?$`);
  const OPERATOR_SKILL = new RegExp(`^${L.skills}/operator/`);
  if (rel.split('/').includes('..') || !fs.existsSync(abs)) fail(`${rel}: not found in brain`);
  const brainName = path.basename(ctx.brainDir);
  const repoDir = path.join(ctx.domain.root, repo);
  const repoKnowledge = dataPath(repoDir, 'projectKnowledge');
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
  if (MOVE_MEMORY.test(rel)) {
    const type = String(parseFrontmatter(fs.readFileSync(abs, 'utf8')).data.type || path.basename(rel, '.md').split('-')[0]);
    if (BRAIN_ONLY_TYPES.includes(type)) fail(`${rel}: ${type} records stay in brain: knowledge about the operator and people is not knowledge of one repo (D-0002, P-007)`);
    ops = [{ path: dataRel(repoKnowledge, 'memory', path.posix.basename(rel)), content: fs.readFileSync(abs, 'utf8') }];
    removed = [rel];
    // Derived records with the moved record among their sources: the source path names its new place, the fingerprint
    // is renewed when it was fresh (a stale one stays stale). Brain sources are relative to the project, repo ones to the repo.
    const newAbs = path.join(repoKnowledge, ops[0].path);
    const pending = new Map([[newAbs, ops[0].content]]);
    const derived = (base) => (text) => rebaseSources(text, base, abs, newAbs, pending);
    brainEdit = derived(ctx.projectDir);
    brainFiles = listFiles(dataPath(ctx.brainDir, 'memory'), (f) => f.endsWith('.md')).filter((f) => path.resolve(f) !== path.resolve(abs));
    repoEdit = derived(repoDir);
    repoFiles = (kdir) => listFiles(dataPath(kdir, 'memory'), (f) => f.endsWith('.md'));
    elsewhere = () => others.flatMap((s) => listFiles(dataPath(s.knowledge, 'memory'), (f) => f.endsWith('.md')).flatMap((f) => sourceLines(f, s.kind === 'repo' ? s.dir : s.project || s.dir, abs)));
  } else if (MOVE_DECISION.test(rel)) {
    const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    const oldId = String(parsed.data.id || parsed.data.key || path.basename(rel, '.md'));
    const id = nextRepoDecisionId(ctx.domain, repo);
    const newRef = `${repo}/${id}`;
    const slug = path.basename(rel, '.md').replace(/^d-\d+-?/i, '') || normalizeKey(String(parsed.data.title || '')).slice(0, 40);
    // In the repo a bare D-NNNN means the repo's own decision: the moved record names brain decisions <brain>/D-NNNN.
    const content = rewriteDecisionRefs(serializeFrontmatter({ ...parsed.data, key: id, id, moved_from: `${brainName}/${oldId}`, updated: today() }, parsed.body), { bare: (d) => (d === oldId ? newRef : `${brainName}/${d}`), qualified: (s, d) => (s === brainName && d === oldId ? newRef : null) });
    ops = [{ path: dataRel(repoKnowledge, 'decisions', `${id.toLowerCase()}-${slug}.md`), content }];
    removed = [rel];
    const old = (s, d) => s === brainName && d === oldId;
    brainEdit = (text) => rewriteDecisionRefs(text, { bare: (d) => (d === oldId ? newRef : null), qualified: (s, d) => (old(s, d) ? newRef : null) });
    brainFiles = refFiles(source).filter((f) => path.resolve(f) !== path.resolve(abs));
    repoEdit = (text) => rewriteDecisionRefs(text, { qualified: (s, d) => (old(s, d) ? newRef : null) });
    repoFiles = (kdir) => refFiles(dest, kdir);
    elsewhere = () => others.flatMap((s) => refFiles(s).flatMap((f) => decisionRefs(readText(f, ''), { skip: ID_LINE }).filter((r) => old(r.store, r.id)).map((r) => `${toPosixPath(f)}:${r.line}`)));
    note = `decision ${brainName}/${oldId} is now ${newRef}; references to it in ${brainName} and ${repo} now read ${newRef} (commit messages stay as they are)`;
  } else if (MOVE_SKILL.test(rel)) {
    const dir = rel.replace(/\/SKILL\.md$/, '');
    const name = path.posix.basename(dir);
    const files = fs.readdirSync(path.join(ctx.brainDir, dir), { recursive: true }).map(String).filter((f) => fs.statSync(path.join(ctx.brainDir, dir, f)).isFile()).map(toPosixPath);
    ops = files.map((f) => ({ path: dataRel(repoKnowledge, 'skills', name, f), content: fs.readFileSync(path.join(ctx.brainDir, dir, f), 'utf8') }));
    removed = files.map((f) => `${dir}/${f}`);
  } else if (OPERATOR_SKILL.test(rel)) {
    fail(`${rel}: operator skills stay in brain; skills of a repo are agentic only (P-032)`);
  } else {
    const B = layoutOf(ctx.brainDir);
    fail(`${rel}: only ${B.memory}/, ${B.decisions}/ and ${B.skills}/${AGENTIC_OWNER}/<name> move into a repo`);
  }
  const target = ops.map((o) => `${repoHome(ctx, repo)}/${o.path}`);
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
    const kdir = dataPath(heldRepoTopic(ctx, repo)?.dir || repoDir, 'projectKnowledge');
    const rewrites = [...brainOps.map((o) => `${brainName}/${o.path}`), ...repoOps(kdir).filter((o) => !ops.some((m) => m.path === o.path)).map((o) => `${repoHome(ctx, repo)}/${o.path}`)];
    if (rewrites.length) out(`would rewrite references in: ${rewrites.join(', ')}`);
    if (listed.length) out(`references elsewhere, not changed:\n${listed.join('\n')}`);
    if (note) out(note);
    return;
  }
  const exists = ops.map((o) => path.join(repoKnowledge, o.path)).find((f) => fs.existsSync(f));
  if (exists) fail(`${toPosixPath(path.relative(ctx.domain.root, exists))} already exists in the repo; nothing moved`);
  out(formatRepoWrite(repoWrite(ctx, repo, { ops, message: `move ${brainName}/${rel} into ${repo}`, rewrite: repoEdit ? repoOps : null })));
  let res;
  try {
    res = brainWrite(ctx, { ops: [...removed.map((r) => ({ path: r, remove: true })), ...brainOps], message: `move ${rel} to ${repoHome(ctx, repo)}`, env: { WORKFLOW_DECISION_MOVED: removed.join(',') } });
  } catch (err) {
    fail(`${rel} is now in ${repo} but stays in brain too (${err.message.split('\n')[0]}): one record per key (P-031); fix the cause and remove it from brain, or revert the commit in ${repo}`);
  }
  const skillMoved = MOVE_SKILL.test(rel);
  const emptied = path.join(ctx.brainDir, skillMoved ? rel.replace(/\/SKILL\.md$/, '') : '');
  if (skillMoved && fs.existsSync(emptied) && !fs.readdirSync(emptied, { recursive: true }).length) fs.rmSync(emptied, { recursive: true });
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

const HANDOVER_FIELDS = ['task', 'done', 'next', 'files', 'questions', 'tasks'];
const HANDOVER_OPTIONS = [...HANDOVER_FIELDS, 'done-replace', 'file', 'project', 'repo'];

function saveHandover(ctx) {
  const repo = repoTarget(ctx);
  if (repo) return saveRepoHandover(ctx, repo);
  const [topic] = rest;
  // An unknown option or no content overwrote the topic's handover with an empty one (pilot of v0.9.73, 2026-11-12:
  // `save.mjs handover <topic> --help`): refuse before anything is written, the current handover stays.
  // `--topic <id>` from memory got only the usage line: name the replacement, as comms send does (report-d718bc1f).
  const unknown = Object.keys(args).filter((k) => k !== '_' && !HANDOVER_OPTIONS.includes(k));
  const hint = (k) => (k === 'topic' ? ` (the topic is the first argument: save.mjs handover ${typeof args.topic === 'string' ? args.topic : '<topic>'} ...)` : '');
  if (!topic && !unknown.length) fail('usage: save.mjs handover <topic> --task ".." --done "a; b" --next "a; b" --files "a; b" --questions "a; b" --tasks "a; b" [--done-replace "a; b"] | --file <path>');
  if (unknown.length) fail(`save.mjs handover: unknown option ${unknown.map((k) => `--${k}${hint(k)}`).join(', ')}; nothing written, the current handover stays (usage: save.mjs handover <topic> --task ".." --done "a; b" --next "a; b" --files "a; b" --questions "a; b" --tasks "a; b" [--done-replace "a; b"] | --file <path>)`);
  // --done adds to Hotové (the topic's history); --done-replace rewrites it (a line that must change, e.g. done --topic).
  if (typeof args['done-replace'] === 'string' && typeof args.done === 'string') fail('save.mjs handover: --done adds to Hotové, --done-replace rewrites it; give one of them; nothing written, the current handover stays');
  if (typeof args['done-replace'] === 'string') { args.done = args['done-replace']; args.replaceDone = true; }
  if (!args.file && !HANDOVER_FIELDS.some((k) => typeof args[k] === 'string')) fail('save.mjs handover: no content (--task, --done, --next, --files, --questions, --tasks or --file); nothing written, the current handover stays');
  // The structure check and the mode need no remote state: refuse before the first fetch.
  // Without --file only the sections given change; the others keep their current text (P-018, mergeHandover).
  const fields = { ...Object.fromEntries(HANDOVER_FIELDS.map((k) => [k, typeof args[k] === 'string' ? args[k] : undefined])), replaceDone: args.replaceDone === true };
  const merged = args.file ? null : mergeHandover(readText(path.join(ctx.brainDir, topicRel(ctx.brainDir, topic, 'handover')), ''), fields);
  const written = args.file ? fs.readFileSync(args.file, 'utf8') : merged.text;
  const refs = checkDecisionRefs(ctx, targetStore(ctx), [written]);
  if (refs) fail(refs);
  // The open issues of this topic (3c.3) come from the local records, also over --file: the agent neither writes nor drops them.
  const content = withReports(written, openReportLines(baseOf(ctx), topic));
  // P-011: the six sections; no line limit (agent-alice/D-0094): brevity is led by skill save, not by a refusal.
  const errors = checkHandover(content);
  if (errors.length) fail([...errors, 'nothing written, the current handover stays'].join('\n'));
  // Spec 10.6: in mode discussion the handover has no next step; only the field `mode` decides, never class or kind.
  const steps = handoverNextStep(content) || [];
  if (steps.length && isDiscussionMode(readTopic(ctx.brainDir, topic))) fail(DISCUSSION_NEXT_REFUSAL(topic, steps));
  const handoverRel = topicRel(ctx.brainDir, topic, 'handover');
  const holderError = ctx.presynced ? checkHolder(ctx.brainDir, handoverRel, ctx.thread) : syncAndCheckHolder(ctx.brainDir, handoverRel, ctx.thread);
  if (holderError) fail(holderError);
  const ops = [{ path: handoverRel, content }, setTopicState(ctx, topic, readTopic(ctx.brainDir, topic)?.state === 'paused' ? 'paused' : 'working')];
  let lastHandover = 0;
  try { lastHandover = fs.statSync(path.join(ctx.brainDir, handoverRel)).mtimeMs; } catch { /* first handover */ }
  const res = brainWrite(ctx, { ops, message: `handover ${topic}`, presynced: true });
  out(formatWriteResult(res, [handoverRel]));
  // Skill proposal, Report výsledku: one work is one page; a state change goes into the published page, not only the handover.
  const stale = stalePages(ctx.brainDir, topic, lastHandover);
  if (stale.length) out(`published page${stale.length > 1 ? 's' : ''} ${stale.map((p) => `${p.name} (${p.url})`).join(', ')} not changed since the handover before this one: if the state it describes changed, update its work file and publish it again with its url (skill proposal, Report výsledku)`);
  if (merged?.kept.length) out(`kept from the current handover: ${merged.kept.join(', ')} (an option not given keeps its section; --<option> "" empties it)`);
  if (merged && merged.added !== null) out(`Hotové: ${merged.added} item(s) added after the current ones (--done adds; --done-replace rewrites Hotové; --done "" empties it)`);
}

/**
 * A fact about a person (spec 4.3, 6, plan B8): written to osoby/ of the operator repo (scripts/people.mjs, its own clone),
 * never to memory/. The one person the alias names is changed; with --name and no match a new person <id> is made. No or
 * several matches without --name are refused: the operator says who it is first (spec 6.2).
 */
function savePerson(ctx) {
  const alias = rest.join(' ');
  if (!alias) fail('usage: save.mjs person <alias|id> [--domain [<domain>]] (--content "<the whole record>" | --name | --aliases a,b | --domains d1,d2) | save.mjs person <id> --name "<name>" --content "..." [--aliases a,b] [--domains d1,d2] [--new]   (a new person)');
  const repo = requireOperatorRepo();
  const domain = args.domain === undefined ? null : args.domain !== true ? String(args.domain) : ctx.domain?.root ? path.basename(ctx.domain.root) : fail('--domain without a name: this session has no domain; name it: --domain <domain>');
  const fields = { name: args.name, aliases: args.aliases, domains: args.domains, content: args.content, another: !!args.new };
  const create = args.name !== undefined && !findPeople(readPeople(repo.dir), alias, domain).length;
  // A new person gets the id meno-priezvisko when --name is the full name; the word it was called by stays an alias.
  let id = alias;
  if (create && shortIdProblem(alias, [String(args.name)])) {
    id = proposedId(String(args.name));
    const given = String(fields.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);
    if (!given.map((a) => a.toLowerCase()).includes(alias.toLowerCase())) fields.aliases = [...given, alias].join(',');
  }
  for (const line of create ? newPerson(repo, { id, ...fields }) : changePerson(repo, { alias, domain, ...fields })) out(line);
}

/** Persona docs/ (P-024): files written directly are committed and pushed in one script commit. */
function saveDocs(ctx) {
  // Data layout 3 (spec 4): a brain keeps no documents and no sources; they go to the target repo of the topic.
  if (!hasData(ctx.brainDir, 'docs')) fail('save.mjs docs: a brain of data 2.1 keeps no documents (spec 4): a result of the topic goes to topics/<topic>/ (save.mjs result), data from outside to the target repo (save.mjs source), and done --topic sorts the topic files into vystupy/<typ>/ of the target repo; nothing written');
  if (!ctx.brainInfo?.persona) fail(`save.mjs docs: only a persona keeps documents in brain (${dataRel(ctx.brainDir, 'docs')}/, ${dataRel(ctx.brainDir, 'materialy')}/); in a project they belong to the project repo (P-024)`);
  // materialy/ like docs/ (D-0011). A file is committed byte for byte (PDF, image); only .md is read as text for its checks.
  const docs = dataRel(ctx.brainDir, 'docs');
  const materialy = dataRel(ctx.brainDir, 'materialy');
  const st = spawnSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--', docs, materialy], { cwd: ctx.brainDir, encoding: 'utf8' });
  const rels = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
  if (!rels.length) { out(`unchanged: ${docs}/, ${materialy}/ (nothing to commit)`); return; }
  const read = (rel) => fs.readFileSync(path.join(ctx.brainDir, rel), rel.endsWith('.md') ? 'utf8' : undefined);
  const ops = rels.map((rel) => (fs.existsSync(path.join(ctx.brainDir, rel)) ? { path: rel, content: read(rel) } : { path: rel, remove: true }));
  const res = brainWrite(ctx, { ops, message: `docs: ${args.message || rels.join(', ')}` });
  finish(ctx, res, rels);
}

/** Topic of a source or a result: --topic, else the one work topic this thread holds. */
function sourceTopic(ctx, what) {
  if (typeof args.topic === 'string') return args.topic;
  const held = ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread).filter((t) => t.kind !== 'main') : [];
  if (held.length === 1) return held[0].id;
  return fail(held.length ? `${what}: this thread holds several topics (${held.map((t) => t.id).join(', ')}); pass --topic <id>` : `${what}: this thread holds no topic; pass --topic <id> (the topic the file came for)`);
}

/**
 * Repo the sources of a topic go to: --repo <name>; in data layout 3 the main target repo of the topic (spec 4.5, written
 * through the own clone on its target branch or topic/<id>--obsah, 4.6); in an older layout the project repo of the
 * session (as materialy.mjs did). Returns { name, dir, clone }.
 */
function sourceRepo(ctx, id) {
  if (typeof args.repo === 'string') {
    const dir = targetRepoDir(ctx, args.repo);
    if (!dir) fail(`--repo ${args.repo}: no such repo of ${ctx.domain ? 'the domain' : 'this session'}`);
    return { name: args.repo, dir, clone: hasData(dir, 'outputs') };
  }
  if (hasTypeTriage(ctx.brainDir)) {
    const topic = readTopic(ctx.brainDir, id);
    if (!topic) fail(`topic ${id} does not exist`);
    const m = mainTargetRepo(ctx, topic);
    if (m.error) fail(`save.mjs source: ${m.error}`);
    return { ...m, clone: hasData(m.dir, 'outputs') };
  }
  const dir = ctx.projectDir;
  return { name: path.basename(dir), dir, clone: false };
}

/**
 * Write ops of sources into their repo: through the own clone in a repo of data layout 3 (the clone must not have the file
 * yet, sources.json from the clone), else a write of that repo as before (layout 1 and 2).
 */
function writeSources(ctx, repo, id, files, { message, describe = null }) {
  const rels = files.map((f) => f.rel);
  if (repo.clone) {
    const res = contentWrite(ctx, repo.dir, id, {
      message,
      ops: (clone) => {
        const exists = rels.filter((r) => fs.existsSync(path.join(clone, ...r.split('/'))));
        if (exists.length) throw new Error(`${exists.join(', ')} exists already in ${repo.name}: a source is not changed, choose another name (--as <name>); nothing written`);
        const ops = files.map((f) => ({ path: f.rel, content: f.content }));
        if (describe && hasDataIndex(clone)) ops.push({ path: sourcesFileRel(clone), content: sourcesWith(clone, describe.rels || rels, describe.fields) });
        return ops;
      },
    });
    return { line: `${res.committed ? 'written' : 'unchanged'}: ${rels.slice(0, 5).join(', ')}${rels.length > 5 ? `, … (+${rels.length - 5})` : ''}${res.sha ? ` (${repo.name} ${res.sha})` : ''} [${contentWhere(res)}]${(res.notes || []).length ? `\n${res.notes.join('\n')}` : ''}` };
  }
  const ops = files.map((f) => ({ path: f.rel, content: f.content }));
  const paths = [...rels];
  if (describe && hasDataIndex(repo.dir)) {
    const sourcesRel = sourcesFileRel(repo.dir);
    ops.push({ path: sourcesRel, content: sourcesWith(repo.dir, describe.rels || rels, describe.fields) });
    paths.push(sourcesRel, 'INDEX.md');
  }
  const isBrain = ctx.brainDir && path.resolve(ctx.brainDir) === path.resolve(repo.dir);
  const res = brainWrite({ brainDir: repo.dir, thread: ctx.thread, policy: ctx.policy }, { ops, message, sync: !!isBrain });
  return { line: formatWriteResult(res, paths) };
}

/** The longest folder all paths are under. */
function commonDir(rels) {
  const parts = rels.map((r) => r.split('/').slice(0, -1));
  const dirs = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) dirs.push(parts[0][i]);
  return dirs.join('/');
}

/**
 * A source from outside (spec 5: saved at once; plan O15, the former materialy.mjs add|record|check):
 *   save.mjs source <file|folder> [--topic <id>] [--description "..."] [--from <where>] [--as <name|subpath>] [--repo <name>]
 *   save.mjs source --record <file> --from <where> [--topic <id>] [--description "..."]   a file over the limit: its record only
 *   save.mjs source --check [--repo <name>]   files in the sources over the limit (exit 1 when there are some)
 * Into zdroje/<topic>/ of the main target repo of the topic (layout 3, own clone), else of the project repo.
 */
function saveSource(ctx) {
  if (args.check) {
    const repo = typeof args.repo === 'string' || hasTypeTriage(ctx.brainDir) ? sourceRepo(ctx, sourceTopic(ctx, 'save.mjs source --check')) : { dir: ctx.projectDir };
    const big = oversized(repo.dir, ctx.policy);
    if (!big.length) { out(`ok: v ${materialyDir(repo.dir)}/ nič nad ${maxBytes(ctx.policy) / 1048576} MB`); return; }
    for (const b of big) out(`nad limitom: ${b.path} (${(b.size / 1048576).toFixed(0)} MB)`);
    fail(`${big.length} súbor(ov) nad ${maxBytes(ctx.policy) / 1048576} MB: presuň ich mimo gitu (stiahnuté do ${topicWorkLabel(ctx.brainDir, ctx.projectDir)}) a zaznamenaj cez save.mjs source --record`);
  }
  const record = typeof args.record === 'string' ? args.record : null;
  const file = record || rest[0];
  if (!file) fail('usage: save.mjs source <file|folder> [--topic <id>] [--description "..."] [--from <where>] [--as <name|subpath>] [--repo <name>] | source --record <file> --from <where> [--topic <id>] [--description "..."] | source --check');
  const id = sourceTopic(ctx, 'save.mjs source');
  const repo = sourceRepo(ctx, id);
  if (!hasData(repo.dir, 'materialy')) fail(`save.mjs source: repo ${repo.name} has no sources folder in its data layout`);
  const from = typeof args.from === 'string' ? args.from : '';
  const description = typeof args.description === 'string' ? args.description : '';
  if (record) {
    const { rel, content, record: rec } = recordBigFileOp(repo.dir, id, record, { from: from || null, brainDir: ctx.brainDir });
    const res = writeSources(ctx, repo, id, [{ rel, content }], { message: `save source --record ${rel}`, describe: { rels: rel.replace(/\.zaznam\.json$/, ''), fields: { description, from, date: rec.date } } });
    out(`záznam: ${rel}\n${rec.size} B, sha256 ${rec.sha256.slice(0, 12)}…; súbor ostal ${rec.stored_at}; do gitu patrí iba záznam`);
    out(res.line);
    return;
  }
  const name = typeof args.as === 'string' ? args.as : null;
  const folder = fs.existsSync(file) && fs.statSync(file).isDirectory();
  const added = folder ? sourceAddDirOps(repo.dir, id, file, { name, policy: ctx.policy }) : null;
  const one = folder ? null : sourceAddOp(repo.dir, id, file, { name, policy: ctx.policy });
  const files = folder ? added.ops : [one];
  const rels = files.map((f) => f.rel);
  if (!hasDataIndex(repo.dir) && (description || from)) out('--description a --from: iba v repe s INDEX.md; tu sa nezapíšu');
  const res = writeSources(ctx, repo, id, files, { message: folder ? `save source ${commonDir(rels)}/ (${rels.length} file(s))` : `save source ${rels[0]}`, describe: { fields: { description, from, date: folder ? added.date : one.date } } });
  out(res.line);
  if (added?.mapping.length) {
    out(`mená podľa pravidla mien (${added.mapping.length}):`);
    for (const [a, b] of added.mapping) out(`  ${a} -> ${b}`);
  }
}

/**
 * A result of the topic's work worth keeping (spec 5: topics/<topic>/ in the brain, the manager decides; plan O13: the
 * SubagentStop hook no longer writes it): save.mjs result <file> [--topic <id>] [--as <name>] [--replace]. Into the topic
 * home (a brain without scratch/ topics/<id>/, layout 1 the sources of the project as before).
 */
function saveResult(ctx) {
  const file = rest[0];
  if (!file) fail('usage: save.mjs result <file> [--topic <id>] [--as <name>] [--replace]');
  const id = sourceTopic(ctx, 'save.mjs result');
  const home = topicHome(ctx.brainDir, ctx.projectDir);
  const inBrain = !!ctx.brainDir && path.resolve(ctx.brainDir) === path.resolve(home);
  // P-078: a result saved from the work files stays bound to its source; the end of each turn copies a change over it.
  const name = typeof args.as === 'string' ? args.as : null;
  const bound = inBrain && resultsActive(home);
  const owner = bound ? tmpOwner(home, path.resolve(file)) : null;
  const bindings = bound ? readBindings(home, id) : {};
  const target = name || path.basename(path.resolve(file));
  const same = !!owner && bindings[target]?.from === owner.from;
  const { rel, content } = resultAddOp(home, id, file, { name, policy: ctx.policy, replace: args.replace === true || same });
  const ops = [{ path: rel, content }];
  if (bound) {
    const base = path.posix.basename(rel);
    const prev = bindings[base];
    const next = owner ? { from: owner.from, via: prev?.from === owner.from ? prev.via : 'save', ...(prev?.from === owner.from && prev.url ? { url: prev.url } : {}), at: prev?.from === owner.from ? prev.at : nowIso() } : { from: null, via: 'manual', at: nowIso() };
    if (JSON.stringify(prev) !== JSON.stringify(next)) ops.push(fieldsOp(home, id, { results: { ...bindings, [base]: next } }));
  }
  const res = brainWrite(inBrain ? ctx : { brainDir: home, thread: ctx.thread, policy: ctx.policy }, { ops, message: `save result ${rel}`, sync: inBrain, presynced: !!ctx.presynced });
  const shown = inBrain && path.resolve(home) !== path.resolve(ctx.projectDir) ? `brain ${rel}` : rel;
  out(formatWriteResult(res, [shown, ...(hasDataIndex(home) ? ['INDEX.md'] : [])]));
  if (owner) out(`bound to ${owner.from}: its changes are saved at the end of each turn (P-078)`);
}

/**
 * A saved agentic skill into another brain (a project, 2026-11-18: a skill went to a peer's brain by `git commit
 * --no-verify`, so every transfer asked the operator for a dialog against a standing order): save.mjs share <skill>[,<skill>]
 * --to <brain dir>. The files of each skill (as saved in this brain) replace the skill in the other brain in one commit made
 * by the brain script, checked by its pre-commit (P-040) and pushed; nothing else of the other brain changes.
 */
/**
 * a project 2026-11-19: a share overwrote three edits a thread of the other brain made to the skill after the last share.
 * The commits of `to` on the skill since its last share of `name` (all of them when it was never shared): [{ h, a, s }].
 */
function foreignSkillCommits(to, destRel, name) {
  // The upstream too: brainWrite pulls it before the copy, so a commit only there would be overwritten as well.
  const up = git(['rev-parse', '--verify', '--quiet', '@{u}'], { cwd: to }).ok ? ['@{u}'] : [];
  const log = git(['log', '--format=%h%x09%an%x09%s', 'HEAD', ...up, '--', destRel], { cwd: to }).stdout.trim();
  if (!log) return [];
  const rows = log.split('\n').map((l) => { const [h, a, ...s] = l.split('\t'); return { h, a, s: s.join('\t') }; });
  const shared = (r) => { const m = r.s.match(/share skill (.+?) from /); return !!m && m[1].split(',').map((x) => x.trim()).includes(name); };
  const last = rows.findIndex(shared);
  return (last === -1 ? rows : rows.slice(0, last)).filter((r) => !shared(r));
}

const skillFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(d, f)).isFile() && !f.split(/[\\/]/).includes('__pycache__')).map(toPosixPath) : []);

/** The other brain's own edits of the skills since the last share would be lost: refused until taken over (a project 2026-11-19). */
function refuseForeignEdits(to, names) {
  if (hasRemote(to)) gitRemote(['fetch', '--quiet', 'origin'], { cwd: to });
  if (args.overwrite) return;
  const found = names.flatMap((name) => foreignSkillCommits(to, dataRel(to, 'skills', AGENTIC_OWNER, name), name).map((r) => `${name}: ${r.h} ${r.a} "${r.s.slice(0, 80)}"`));
  if (found.length) fail(`save.mjs share: ${toPosixPath(to)} has its own commits on the skill since the last share, the ${args.retire ? 'removal' : 'copy'} would ${args.retire ? 'drop' : 'overwrite'} them:\n  ${found.join('\n  ')}\ntake them over into this brain first (git -C ${toPosixPath(to)} show <commit>, then save.mjs skill here), then run the share again with --overwrite; nothing written`);
}

/**
 * a project 2026-11-19: skills replaced in a peer's brain on this machine could not be retired from here (save.mjs skill
 * --remove works only in this session's brain, share never removed a skill), so the agent asked the peer's agent by mail,
 * which the operator refused: edits of another brain on this machine are made here. --retire removes the agentic skill in
 * the other brain in one commit of its brain script, checked by its pre-commit and pushed; git keeps it in the history.
 */
function retireShared(ctx, names, to) {
  const reason = String(args.reason || '').trim();
  if (!reason) fail('save.mjs share --retire needs --reason "superseded by <skill> | operator <YYYY-MM-DD>: <their words>"');
  const ops = [];
  const dirs = [];
  for (const name of names) {
    const destRel = dataRel(to, 'skills', AGENTIC_OWNER, name);
    if (!fs.existsSync(path.join(to, destRel, 'SKILL.md'))) fail(`save.mjs share --retire: no agentic skill ${name} in ${toPosixPath(to)} (skills/${AGENTIC_OWNER}/; a skill of the operator is not retired from here, P-032); nothing written`);
    dirs.push(path.join(to, destRel));
    for (const f of skillFiles(path.join(to, destRel))) ops.push({ path: `${destRel}/${f}`, remove: true });
  }
  refuseForeignEdits(to, names);
  const res = brainWrite({ brainDir: to, thread: ctx.thread, policy: loadPolicy(to) }, { ops, message: `retire skill ${names.join(', ')} from ${path.basename(ctx.brainDir)}: ${reason.slice(0, 160)}` });
  // git does not track directories: an emptied skill folder (only __pycache__ left) goes too, as with save.mjs skill --remove.
  for (const d of dirs) if (fs.existsSync(d) && !skillFiles(d).length) fs.rmSync(d, { recursive: true, force: true });
  out(res.committed ? formatWriteResult(res, [`${toPosixPath(to)}: skill ${names.join(', ')} removed`]) : `nothing to retire: skill ${names.join(', ')} in ${toPosixPath(to)}`);
  if (res.committed) out('the other machine drops it after a pull and a new session (skills are deployed at session start)');
}

function saveShare(ctx) {
  const names = String(typeof args.retire === 'string' ? args.retire : rest[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const to = typeof args.to === 'string' ? path.resolve(args.to) : null;
  if (!names.length || !to) fail('usage: save.mjs share <skill>[,<skill>] --to <brain dir> [--overwrite] | --retire --reason "..."');
  if (!ctx.brainDir) fail('save.mjs share: this session has no brain to take the skill from');
  if (path.resolve(to) === path.resolve(ctx.brainDir)) fail('save.mjs share: --to is this brain; a skill of this brain is saved with save.mjs skill');
  if (!brainExists(to) || !fs.existsSync(path.join(to, '.githooks'))) fail(`save.mjs share: ${toPosixPath(to)} is no brain of the workflow (topics/, .git and .githooks/); nothing written`);
  if (args.retire) return retireShared(ctx, names, to);
  const ops = [];
  // The copy names the topic that develops the skill, as a mail address (operator 2026-11-18: a thread of the other brain
  // reported a fault of the skill, did not know which thread develops it, and the report reached nobody).
  const dev = heldTopics(ctx.brainDir, ctx.thread).filter((t) => !isMainTopic(t));
  // Mail model 3: `<brain id>:<project>/<topic>`, so the report reaches that brain's topic, not one of the same name.
  const devProject = dev.length === 1 ? (typeof dev[0].project === 'string' && dev[0].project) || commsProjectName(ctx) : null;
  const devAt = devProject ? `${brainId(ctx.brainDir)}:${devProject}/${dev[0].id}` : null;
  for (const name of names) {
    const rel = dataRel(ctx.brainDir, 'skills', AGENTIC_OWNER, name);
    const src = path.join(ctx.brainDir, rel);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) fail(`save.mjs share: no agentic skill ${name} in this brain (${toPosixPath(src)}); save it first (save.mjs skill)`);
    if (git(['status', '--porcelain', '--', rel], { cwd: ctx.brainDir }).stdout.trim()) fail(`save.mjs share: ${rel} has changes not saved in this brain; the saved state is shared (save.mjs skill first)`);
    const destRel = dataRel(to, 'skills', AGENTIC_OWNER, name);
    const files = skillFiles(src);
    for (const f of files) {
      const buf = fs.readFileSync(path.join(src, f));
      let content = f.endsWith('.md') ? buf.toString('utf8') : buf;
      if (f === 'SKILL.md' && devAt) { const fm = parseFrontmatter(content); content = serializeFrontmatter({ ...fm.data, developed_in: devAt }, fm.body); }
      ops.push({ path: `${destRel}/${f}`, content });
    }
    for (const f of skillFiles(path.join(to, destRel))) if (!files.includes(f)) ops.push({ path: `${destRel}/${f}`, remove: true });
  }
  refuseForeignEdits(to, names);
  const sha = git(['rev-parse', '--short', 'HEAD'], { cwd: ctx.brainDir }).stdout.trim();
  const res = brainWrite({ brainDir: to, thread: ctx.thread, policy: loadPolicy(to) }, { ops, message: `share skill ${names.join(', ')} from ${path.basename(ctx.brainDir)} (${sha})` });
  out(res.committed ? formatWriteResult(res, [`${toPosixPath(to)}: skill ${names.join(', ')}`]) : `nothing to share: skill ${names.join(', ')} in ${toPosixPath(to)} is the same as here`);
  if (res.committed) out(`the other machine gets it after a pull and a new session (skills are deployed at session start)${devAt ? `; the copy names its developer: developed_in ${devAt} (a report on it: error.mjs report --to ${devAt})` : ''}`);
}

try {
  const ctx = loadContext({ project: args.project });
  const foreign = foreignProjectCwd(ctx, args.project);
  if (foreign) fail(foreign);
  // Spec 11.10, plan O18: the guard of the session start, again before a write (a session started before the migration).
  if (ctx.brainDir && ctx.projectDir) { const refusal = layoutRefusal(ctx.brainDir, ctx.projectDir); if (refusal) fail(`save.mjs refused, nothing written: ${refusal}`); }
  const handlers = { memory: saveMemory, decision: saveDecision, rule: saveRule, exception: saveException, skill: saveSkill, handover: saveHandover, docs: saveDocs, move: saveMove, person: savePerson, source: saveSource, result: saveResult, share: saveShare };
  if (!handlers[category]) fail('usage: save.mjs memory|decision|rule|exception|skill|handover|docs|move|person|source|result|share ...');
  if (args.repo !== undefined && !['memory', 'decision', 'rule', 'skill', 'handover', 'move', 'source'].includes(category)) fail(`--repo: ${category} lives in brain only (memory, decision, rule, skill, handover, move and source take --repo)`);
  // Spec 4.2.4 (plan B5): a thread that holds a topic pulls and verifies its locks before any write; a lost one stops the
  // save with nothing written, whatever it writes (not only the files of the topic).
  if (ctx.brainDir && ctx.thread && !inSubagent()) {
    const locks = verifyHeldLocks(ctx.brainDir, ctx.thread);
    if (locks.lost.length) fail(lockLostText(locks.lost));
    if (locks.sync) ctx.presynced = true;
  }
  handlers[category](ctx);
} catch (err) {
  fail(err.message);
}
