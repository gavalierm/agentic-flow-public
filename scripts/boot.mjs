import { createHash } from 'node:crypto';
// Boot sequence (P-021, P-022, P-024, P-026, P-038): items 1, 3-7 composed by the SessionStart hook.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, shortSha, git, toPosix } from './util.mjs';
import { WORKFLOW_CONFIG, SCRATCH_DIR, readThreadState, writeThreadState } from './config.mjs';
import { assembleRules } from './rules.mjs';
import { buildIndexes, shownIndexes, topicLine } from './index.mjs';
import { recordAuthors, foreignAuthor } from './authors.mjs';
import { heldTopics, mailboxTopics } from './topic.mjs';
import { mailCount, formatMail, mailNoticeLine, registerTopic, commsConfigured, closeArchivedTopics, isMainTopic, noticesCount, discussionMail } from './comms.mjs';
import { syncBrainSkills } from './skills-sync.mjs';
import { policyIgnoredLine } from './policy-layers.mjs';
import { gitAccessProblem } from './brain.mjs';
import { readTopics } from './records.mjs';
import { undeliveredIssues } from './issue-watch.mjs';
import { sessionKnowledgeSources, skillSources, knowledgeKinds } from './repo-knowledge.mjs';
import { dataPath, dataRel, dataLayoutVersion, layoutOf, topicHome, topicWorkLabel, hasData, hasScratch, layoutRefusal, dataName } from './layout.mjs';
import { workDir, workTopic } from './topic-files.mjs';
import { overview, overviewLines, obligationLines, isSupervisorSession } from './overview.mjs';
import { migrateLocalMail } from './comms-migrate.mjs';
import { operatorProfile } from './people.mjs';
export const BOOT_MARKERS = ['## Pravidlá', '## Stav vlákna', '## Index pamäte', '## Index rozhodnutí', '## Otvorené témy', '## Workflow'];

/**
 * Status line (P-023 e) plus the data behind it: held topics, mail count (with the listing items, P-044) and the rest of
 * the mail's `obligations` (`mail.obligations`, one request). `discussion` (D-0015, D-0022): the thread discusses with the
 * operator, so waiting steer and assist are left out until it ends. `since`: the cursor of recent rows already shown.
 */
export function statusInfo(ctx, { discussion = false, since = null } = {}) {
  const held = ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread) : [];
  const topic = held.length ? `${held[0].id} (${held[0].state || 'working'}, mode ${held[0].holder?.mode || 'operator'})` : '- (none)';
  // Mailboxes as in comms list/receive: held topics and free-point topics (P-044).
  const mailTopics = ctx.brainDir ? mailboxTopics(ctx) : [];
  const counted = mailCount(ctx, mailTopics, { since });
  const mail = discussion ? discussionMail(counted) : counted;
  // Open notices of the instance, in the persona main thread only (D-0011: 41 open, none decided, nobody saw them).
  const notices = held.some(isMainTopic) && mail.available ? noticesCount(ctx) : null;
  const thread = ctx.thread || '- (no stable id: start via thread.mjs or T3; topics cannot be claimed)';
  // Answers on the reporter's own issues the check could not ring (project without persona, its topic closed; 3c.2).
  let issues = 0;
  try { issues = undeliveredIssues(ctx.brainDir || ctx.projectDir).length; } catch { /* only a notice */ }
  return {
    line: `thread ${thread} | topic ${topic} | ${formatMail(mail)}${notices ? ` | notices: ${notices} open (comms notices; decide only on operator instruction, P-046)` : ''}${issues ? ` | issues: ${issues} answer(s) not rung (error.mjs watch)` : ''}`,
    held,
    mail,
    notices,
  };
}

export function statusLine(ctx) {
  return statusInfo(ctx).line;
}

/** Register held topics in the mail service at session start (idempotent, P-041); skipped during an outage. */
export function registerHeldTopics(ctx, info) {
  if (!commsConfigured(ctx) || !info.mail.available) return [];
  const res = info.held.map((t) => registerTopic(ctx, t.id));
  closeArchivedTopics(ctx);
  return res;
}

export function pluginVersionLine() {
  const sha = shortSha(PLUGIN_ROOT);
  const dirty = git(['status', '--porcelain'], { cwd: PLUGIN_ROOT }).stdout;
  return `workflow ${sha}${dirty ? ' (local changes in plugin clone, P-014)' : ''}`;
}

/**
 * Boot context (P-021). `includeRules: false` leaves item 1 out for a harness whose entry file already carries the rules
 * (Codex `AGENTS.md`, P-017); the rules are still assembled for limit checks and the staleness comparison.
 */
/** Hash of the assembled rules; a change during a session re-injects them (P-021). */
export function rulesHash(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

/** Chars of one rules part: the harness keeps at most 10 000 chars of one hook output in the context (audit 2026-11-11). */
export const RULES_PART_CHARS = 9000;
/** Entries of session-start-rules.mjs in hooks.json (parts 1 and 2). */
export const RULES_HOOK_PARTS = 2;

function ruleSections(text) {
  return String(text || '').trim().split(/\n(?=#{1,3} )/).map((s) => s.replace(/\s+$/, '')).filter(Boolean);
}

/** The rules cut only at headings into parts of at most `max` chars, in order; a section over `max` is a part of its own. */
export function rulesParts(text, max = RULES_PART_CHARS) {
  const parts = [];
  let cur = '';
  for (const s of ruleSections(text)) {
    if (cur && cur.length + 1 + s.length > max) { parts.push(cur); cur = s; } else cur = cur ? `${cur}\n${s}` : s;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Hash of every rules section by its heading line, so a change during a session re-injects only the changed sections. */
export function rulesSections(text) {
  const out = {};
  for (const s of ruleSections(text)) out[s.split('\n', 1)[0]] = rulesHash(s);
  return out;
}

/** Sections new or changed against `prev` (rulesSections of the injected rules) and the headings no longer present. */
export function changedRules(text, prev) {
  const seen = new Set();
  const changed = [];
  for (const s of ruleSections(text)) {
    const key = s.split('\n', 1)[0];
    seen.add(key);
    if (prev[key] !== rulesHash(s)) changed.push(s);
  }
  return { changed, removed: Object.keys(prev).filter((k) => !seen.has(k)).map((k) => k.replace(/^#+ /, '')) };
}

const bootDir = (brainDir) => dataPath(brainDir, 'local', 'boot');
const bootStamp = (brainDir, sessionId) => path.join(bootDir(brainDir), `${encodeURIComponent(sessionId)}.json`);

/**
 * session-start.mjs after the brain pull (P-040): the rules hook running at the same time reads the rules after it.
 * `extra` rides along for that hook (`foreign_rules`: { path: name } of the project rules of other operators), so it needs
 * no git call of its own; written whole (rename), the hook never reads half a stamp.
 */
export function stampBootPull(brainDir, sessionId, now = Date.now(), extra = {}) {
  if (!brainDir || !sessionId) return;
  try {
    const dir = bootDir(brainDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > 86_400_000) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* gone */ }
    }
    const file = bootStamp(brainDir, sessionId);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date(now).toISOString(), ...extra }));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* best effort: the rules hook waits at most maxMs */ }
}

/** The stamp of this boot as stampBootPull wrote it, or null. */
export function readBootStamp(brainDir, sessionId) {
  if (!brainDir || !sessionId) return null;
  try { return JSON.parse(fs.readFileSync(bootStamp(brainDir, sessionId), 'utf8')); } catch { return null; }
}

/** Wait (synchronously, at most `maxMs`) for the pull stamp of this boot; a stamp older than `since` is an earlier boot. */
export function waitBootPull(brainDir, sessionId, { since = Date.now() - 30_000, maxMs = 10_000 } = {}) {
  if (!brainDir || !sessionId) return false;
  const end = Date.now() + maxMs;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { if (fs.statSync(bootStamp(brainDir, sessionId)).mtimeMs >= since) return true; } catch { /* not yet */ }
    if (Date.now() >= end) return false;
    Atomics.wait(cell, 0, 0, 50);
  }
}

// `rulesHook`: item 1 comes from session-start-rules.mjs (Claude Code); the hash is recorded, on resume it is left as it is.
// `authors`: record authors (scripts/authors.mjs) the caller already read; else read here, the one git call they cost.
export function buildBootContext(ctx, { source = 'startup', harness = 'claude-code', includeRules = true, rulesHook = false, t3Note = null, catalogLines = [], authors = null } = {}) {
  const limits = ctx.policy?.limits || {};
  const notices = [];
  const parts = [];
  const who = ctx.brainDir ? authors || recordAuthors(ctx.brainDir) : null;

  // 1. rules + applied exceptions (a rule of another operator applies to the project too, marked [by <name>])
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness, foreign: (rel) => foreignAuthor(who, rel), layers: ctx.layers });
  if (includeRules && !rulesHook) parts.push(`${BOOT_MARKERS[0]}\n${rules.shown.trim()}`);
  // On resume the rules hook injects nothing when a hash is recorded, so the hash stays that of the rules in the transcript.
  const recordRules = includeRules && !(rulesHook && source === 'resume');
  if (rules.overLimit.length) notices.push(`limit: ${rules.overLimit.join('; ')} (P-022)`);
  // Layers (D-0025): what the project layer could not loosen, and a "domain" in .workflow.json that does not match.
  const ignoredLine = policyIgnoredLine(ctx.policyIgnored);
  if (ignoredLine) notices.push(ignoredLine);
  if (ctx.domainError) notices.push(`domain: ${ctx.domainError}`);
  // Mail model 2, first run (4b step 5): the local waits go to the mail, the local message state goes (once per brain).
  if (ctx.brainDir && ctx.thread) { try { migrateLocalMail(ctx); } catch { /* retried at the next prompt */ } }
  // 3. status line (+ the waiting mail as mechanical lines, P-044; + handover of the held topic after compaction, P-026)
  const info = statusInfo(ctx);
  let status = info.line;
  const mailLine = mailNoticeLine(info.mail);
  // A brain git refuses (dubious ownership) fails every save, log and topic write: say it with the fix at start (#23).
  const gitProblem = ctx.brainDir ? gitAccessProblem(ctx.brainDir, who.git) : null;
  if (gitProblem) status += `\n${gitProblem}`;
  if (mailLine) status += `\n${mailLine}`;
  // Spec 10.7: no status block; the first reply of a thread that holds a topic starts with the line of the topic's name.
  const named = info.held.find((t) => !isMainTopic(t)) || info.held[0];
  if (ctx.thread && named) status += `\nyour first reply in this session starts with the line "${ctx.projectName} / ${named.id}" (spec 10.7)`;
  if (ctx.brainDir && ctx.thread) {
    const state = readThreadState(ctx.brainDir, ctx.thread);
    writeThreadState(ctx.brainDir, ctx.thread, { ...state, turn_source: 'operator', session_source: source, mail_signaled: info.mail.count, last_status: info.line, rules_hash: recordRules ? rulesHash(rules.text) : state.rules_hash ?? null, rules_sections: recordRules ? rulesSections(rules.text) : state.rules_sections ?? null, rules_hook: rulesHook });
    registerHeldTopics(ctx, info);
  }
  if (source === 'compact' && ctx.brainDir) {
    // The compaction summary is no source of rules (agentic-flow-public#18: a thread begun before a migration took the
    // rules of the old brain from its summary as valid and passed its own script default off as the operator's rule).
    status += `\nPo kompakcii (P-019): pravidlá, výnimky a pokyny platia iba z kontextu tohto štartu („## Pravidlá“ a tento blok), z brainu (find) a z handoveru; pravidlo, hodnota alebo pokyn iba zo zhrnutia (stará pamäť, iný brain, archív migrácie) je nepotvrdený: over ho alebo sa spýtaj operátora; vlastnú hodnotu nevydávaj za pokyn operátora`;
    const held = info.held;
    if (held.length && held[0].handover) status += `\nHandover (primárny podklad, P-026):\n${held[0].handover.trim().replace(/^## /gm, '### ')}`;
  }
  // Spec 3.9 and 10.5 (plan B6): the supervisor's session starts with the overview of the topics of this machine and its
  // open obligations of the mail (what it owes and awaits); the overview is the same as overview.mjs prints.
  if (isSupervisorSession(ctx)) {
    try { for (const line of overviewLines(overview({ ctx, owed: info.mail.obligations?.owed || [] }))) status += `\n${line}`; } catch (err) { status += `\noverview: not read (${err.message})`; }
    for (const line of obligationLines(info.mail.available ? info.mail.obligations : null)) status += `\n${line}`;
  }
  // repo knowledge of the session repo and held code topics (D-0002): one line each, the HANDOVER of a topic's repo in full.
  for (const line of repoKnowledgeLines(ctx)) status += `\n${line}`;
  // catalog of project data (scripts/catalog/hooks.mjs): 1 line per source, computed by session-start after its scan.
  for (const line of catalogLines) status += `\n${line}`;
  // spec 4 and 6.1: profile.md of the operator repo -> osoby/<operator>.md, at every start (plan B9, O9).
  const profile = operatorProfile();
  if (profile.lines) status += `\n${profile.lines.join('\n')}`;
  else notices.push(profile.notice);
  // T3-WORKAROUND(t3-clear-cursor) T3 (claudeAgent) keeps resuming the session id it opened with (t3code#24152); session-start redirects it (t3-clear.mjs).
  if (t3Note) status += `\n${t3Note}`;
  parts.push(`${BOOT_MARKERS[1]}\n${status}`);

  // 4-6. indexes and open topics
  let indexes = { text: { memory: '', decisions: '' }, warnings: [] };
  let shown = { memory: '', decisions: '' };
  let topics = [];
  if (ctx.brainDir) {
    indexes = buildIndexes(ctx.brainDir, ctx.policy);
    shown = shownIndexes(indexes.records, who);
    topics = heldTopicsAll(ctx);
    notices.push(...indexes.warnings.map((w) => `limit: ${w}`));
    // CLAUDE.md is loaded unchecked into every session and goes stale; its knowledge belongs in brain (P-007, operator 2026-11-03).
    const stray = ['CLAUDE.md', 'CLAUDE.local.md'].filter((f) => fs.existsSync(path.join(ctx.projectDir, f)));
    if (stray.length) notices.push(`${stray.join(', ')} in the project: loaded into every session unchecked, so it goes stale; move what is still valid into brain (workflow:save) and delete it (git rm), after the current unit of work (P-007)`);
  }
  parts.push(`${BOOT_MARKERS[2]}\n${shown.memory || '(prázdny)'}`);
  parts.push(`${BOOT_MARKERS[3]}\n${shown.decisions || '(prázdny)'}`);
  parts.push(`${BOOT_MARKERS[4]}\n${topics.length ? topics.map((t) => `open: ${topicLine(t)}`).join('\n') : '(žiadne)'}`);

  // skills of the brain into the project (P-017)
  if (ctx.brainDir) {
    try {
      syncBrainSkills({ projectDir: ctx.projectDir, brainDir: ctx.brainDir, harness, repoSources: skillSources(ctx), domainBrainDir: ctx.layers?.projectBrain ? ctx.layers.domainBrain : null });
    } catch (err) {
      notices.push(err.message);
    }
  }

  // 7. version and configuration notices
  const version = [pluginVersionLine()];
  if (!ctx.brainDir) {
    const rel = ctx.brainInfo?.brainRel;
    version.push(!ctx.brainInfo
      ? `brain: none (optional, P-024): project without its own brain; do not propose one, it is created only on the operator's instruction`
      : ctx.brainInfo.error || `brain not found at ${rel}; propose: node <plugin>/bin/brain-init.mjs ${rel} (only after operator approval, P-024)`);
  }
  version.push(...dataMapLines(ctx));
  // The harness names its own scratchpad in the system temp dir; the write hook refuses it (P-052) and the refusal cost
  // turns (alice 2026-11-07: a patch script in /tmp was refused, the work waited for the operator).
  if (harness === 'claude-code') {
    // Layout 2 (D-0048): the work files belong to the held topic (temy/<topic>/tmp, main without one), outside git; a
    // brain in layout 2 holds them (D-0056), else the project repo.
    const v1 = hasScratch(topicHome(ctx.brainDir, ctx.projectDir));
    const here = toPosix(workDir(ctx));
    version.push(`work files: ${here}/ (gitignored${v1 ? '' : `; per topic ${topicWorkLabel(ctx.brainDir, ctx.projectDir)}, the topic this thread holds or main`}); the harness "scratchpad directory" in the system temp dir is not used here: Write/Edit there go to ${v1 ? 'this scratch/' : 'this folder'} (read the file there), other writes outside the project are refused (P-052)`);
  }
  version.push(...notices);
  parts.push(`${BOOT_MARKERS[5]}\n${version.join('\n')}`);

  let text = parts.join('\n\n') + '\n';
  const limit = limits.boot_context_chars ?? 9500;
  const overLimit = text.length > limit;
  if (overLimit) text += `\nlimit: boot context ${text.length} chars > ${limit}; nothing was trimmed (the harness shows a hook output over 10 000 chars only as a 2 KB preview), shorten rules or run consolidate (P-022)\n`;
  return { text, chars: text.length, overLimit, notices, rules, source };
}

/**
 * Layout guard of a session (spec 11.10, plan O18): the refusal when the project repo of the session does not carry the
 * layout of its brain (layoutRefusal), else null. The session start shows it in place of the boot, save refuses with it.
 */
export function layoutGuard(ctx) {
  if (!ctx?.brainDir || !ctx.projectDir) return null;
  try { return layoutRefusal(ctx.brainDir, ctx.projectDir); } catch (err) { return `data layout not readable (${err.message}); no work in this repo until it is (spec 11.10)`; }
}

/**
 * Start block "Dáta tohto repa" (D-0048): the paths of the logical names rules and skills use (zdroje, práca témy,
 * pracovné súbory, výstupy, fakt o subjekte, INDEX.md) for the layout version of this project and its brain, so no rule
 * or skill spells a folder of one layout. Topics, decisions and memory live in the brain, sources and documents in the
 * project repo; the work of a topic and its work files in a brain without scratch/ (layouts 2 and 3, D-0056), else in the
 * project repo (P-052, P-024). Layout 3 (spec 4): outputs by type in vystupy/<typ>/ and sources of the project repo; a
 * brain without them says where they go. Every branch tests the map (hasData, hasScratch), not the version.
 */
export function dataMapLines(ctx) {
  const proj = ctx?.projectDir;
  if (!proj) return [];
  const brain = ctx.brainDir || null;
  let pv;
  let bv = null;
  try { pv = dataLayoutVersion(proj); layoutOf(proj); if (brain) { bv = dataLayoutVersion(brain); layoutOf(brain); } } catch { return []; }
  const same = brain && path.resolve(brain) === path.resolve(proj);
  const P = same ? 'brain' : 'projekt';
  const at = (who, root, name, ...rest) => `${who} ${[dataRel(root, name), ...rest].filter(Boolean).join('/')}/`;
  const topic = workTopic(ctx);
  const t = topic && topic !== 'main' ? topic : '<téma>';
  const head = `Dáta tohto repa (dáta ${dataName(pv)}${brain && !same && bv !== pv ? `, brain dáta ${dataName(bv)}` : ''}; ${same ? `brain = projekt = repo ${toPosix(proj)}` : `projekt = repo ${toPosix(proj)}${brain ? `, brain = repo ${toPosix(brain)}` : ''}`}; cesta nižšie je od koreňa repa, ktoré riadok menuje):`;
  const index = [[P, proj], ...(brain && !same ? [['brain', brain]] : [])].filter(([, root]) => hasData(root, 'index')).map(([who]) => `${who} INDEX.md (generuje workflow pri zápise, ručne nie)`);
  // D-0056: a brain without scratch/ holds the whole topic (work, tmp/), also beside a project repo in layout 1.
  const inBrain = !!brain && !hasScratch(brain);
  const home = brain && inBrain ? brain : proj;
  // Worker conclusions in zavery/ exist only where the topic home keeps documents (layout 2); layout 3 has none.
  const work = hasData(home, 'docs') ? 'handover, .tema.json, súbory práce, závery pracovníkov v zavery/' : 'handover, .tema.json, výsledky práce';
  const triaged = inBrain && !same ? ' (hotové výsledky témy sem presunie triáž pri done --topic)' : '';
  const outputs = hasData(proj, 'outputs')
    ? `výstupy podľa typu ${at(P, proj, 'outputs', '<typ>')} (téma v hlavičke súboru)${triaged}`
    : hasData(proj, 'docs') ? `dokumenty ${at(P, proj, 'docs')}${triaged}` : 'dokumenty: brain ich nemá, idú do cieľového repa témy';
  return [
    head,
    `- zdroje (súbory zvonka, nemenia sa): ${hasData(proj, 'materialy') ? at(P, proj, 'materialy', '<téma>') : 'brain ich nemá, idú do cieľového repa témy'}`,
    hasScratch(proj) && !inBrain
      ? `- práca témy: handover ${brain ? at('brain', brain, 'topics', t) : 'bez brainu'}, výsledky práce ${at(P, proj, 'materialy', t)}`
      : `- práca témy (${work}): ${brain ? at('brain', brain, 'topics', t) : at(P, proj, 'topics', t)}`,
    `- pracovné súbory (mimo gitu, ${same || inBrain ? 'v brainu' : 'v repe projektu'}): ${toPosix(workDir(ctx))}/`,
    `- rozhodnutia: ${brain ? at('brain', brain, 'decisions') : 'bez brainu'}${brain && !same && hasData(proj, 'outputs') ? `, rozhodnutie jedného repa (--repo) ${at(P, proj, 'decisions')}` : ''}`,
    `- výstupy: ${outputs}`,
    `- fakt o subjekte (pamäť agenta): ${brain ? at('brain', brain, 'memory') : 'bez brainu'}`,
    // Layout 1 has no INDEX.md: the block does not name it there.
    ...(index.length ? [`- INDEX.md: ${index.join(', ')}`] : []),
  ];
}

/** Records in a repo knowledge folder (memory, decisions, runbooks, skills). */
function countKnowledge(dir) {
  let n = 0;
  const kinds = knowledgeKinds(dir);
  for (const sub of Object.keys(kinds)) {
    const d = path.join(dir, ...sub.split('/'));
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (kinds[sub] === 'skill' ? e.isDirectory() && fs.existsSync(path.join(d, e.name, 'SKILL.md')) : e.isFile() && e.name.endsWith('.md')) n++;
    }
  }
  return n;
}

/** Start lines for repo knowledge (D-0002): `repo vedomosti: <repo> n záznamov, HANDOVER`, plus a topic repo's HANDOVER.md. */
export function repoKnowledgeLines(ctx) {
  const lines = [];
  for (const src of sessionKnowledgeSources(ctx)) {
    const handover = dataPath(src.dir, 'repoHandover');
    const has = fs.existsSync(handover);
    lines.push(`repo vedomosti: ${src.repo}${src.topic ? ` (téma ${src.topic})` : ''} ${countKnowledge(src.dir)} záznamov, ${has ? 'HANDOVER' : 'bez HANDOVER'}`);
    if (has && src.topic) lines.push(`HANDOVER ${src.repo} (stav projektu):\n${fs.readFileSync(handover, 'utf8').trim().replace(/^## /gm, '### ')}`);
  }
  return lines;
}

/** All open topics, one line each (P-021 item 6); the limit is reported through index warnings. */
function heldTopicsAll(ctx) {
  return ctx.brainDir ? readTopics(ctx.brainDir) : [];
}

export function brainRelDefault(projectDir) {
  return `../${path.basename(projectDir)}-brain`;
}
