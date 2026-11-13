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
import { sessionKnowledgeSources, skillSources, KNOWLEDGE_KINDS, REPO_HANDOVER } from './repo-knowledge.mjs';
import { HANDOVER_NONE_LINE } from './protocol.mjs';

export const BOOT_MARKERS = ['## Pravidlá', '## Stav vlákna', '## Index pamäte', '## Index rozhodnutí', '## Otvorené témy', '## Workflow'];

/**
 * Status line (P-023 e) plus the data behind it: held topics, mail count (with the listing items, P-044). `discussion`
 * (D-0015, D-0022): the thread discusses with the operator, so waiting steer and assist are left out until it ends.
 */
export function statusInfo(ctx, { discussion = false } = {}) {
  const held = ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread) : [];
  const topic = held.length ? `${held[0].id} (${held[0].state || 'working'}, mode ${held[0].holder?.mode || 'operator'})` : '- (none)';
  // Mailboxes as in comms list/receive: held topics and free-point topics (P-044).
  const mailTopics = ctx.brainDir ? mailboxTopics(ctx) : [];
  const counted = mailCount(ctx, mailTopics);
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

const BOOT_STAMPS = ['local', 'boot'];
const bootStamp = (brainDir, sessionId) => path.join(brainDir, ...BOOT_STAMPS, `${encodeURIComponent(sessionId)}.json`);

/**
 * session-start.mjs after the brain pull (P-040): the rules hook running at the same time reads the rules after it.
 * `extra` rides along for that hook (`foreign_rules`: { path: name } of the project rules of other operators), so it needs
 * no git call of its own; written whole (rename), the hook never reads half a stamp.
 */
export function stampBootPull(brainDir, sessionId, now = Date.now(), extra = {}) {
  if (!brainDir || !sessionId) return;
  try {
    const dir = path.join(brainDir, ...BOOT_STAMPS);
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

  // 3. status line (+ the waiting mail as mechanical lines, P-044; + handover of the held topic after compaction, P-026)
  const info = statusInfo(ctx);
  let status = info.line;
  const mailLine = mailNoticeLine(info.mail);
  // A brain git refuses (dubious ownership) fails every save, log and topic write: say it with the fix at start (#23).
  const gitProblem = ctx.brainDir ? gitAccessProblem(ctx.brainDir, who.git) : null;
  if (gitProblem) status += `\n${gitProblem}`;
  if (mailLine) status += `\n${mailLine}`;
  if (ctx.thread) status += `\n${statusBlockInstruction(operatorStatus(ctx, info), !info.held.length, ctx.projectName)}`;
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
  // repo knowledge of the session repo and held code topics (D-0002): one line each, the HANDOVER of a topic's repo in full.
  for (const line of repoKnowledgeLines(ctx)) status += `\n${line}`;
  // catalog of project data (scripts/catalog/hooks.mjs): 1 line per source, computed by session-start after its scan.
  for (const line of catalogLines) status += `\n${line}`;
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
  // The harness names its own scratchpad in the system temp dir; the write hook refuses it (P-052) and the refusal cost
  // turns (alice 2026-11-07: a patch script in /tmp was refused, the work waited for the operator).
  if (harness === 'claude-code') version.push(`work files: ${toPosix(path.join(ctx.projectDir, SCRATCH_DIR))}/ (gitignored); the harness "scratchpad directory" in the system temp dir is not used here: Write/Edit there go to this scratch/ (read the file there), other writes outside the project are refused (P-052)`);
  version.push(...notices);
  parts.push(`${BOOT_MARKERS[5]}\n${version.join('\n')}`);

  let text = parts.join('\n\n') + '\n';
  const limit = limits.boot_context_chars ?? 9500;
  const overLimit = text.length > limit;
  if (overLimit) text += `\nlimit: boot context ${text.length} chars > ${limit}; nothing was trimmed (the harness shows a hook output over 10 000 chars only as a 2 KB preview), shorten rules or run consolidate (P-022)\n`;
  return { text, chars: text.length, overLimit, notices, rules, source, status: operatorStatus(ctx, info) };
}

/** Records in a repo knowledge folder (memory, decisions, runbooks, skills). */
function countKnowledge(dir) {
  let n = 0;
  for (const sub of Object.keys(KNOWLEDGE_KINDS)) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (sub === 'skills' ? e.isDirectory() && fs.existsSync(path.join(d, e.name, 'SKILL.md')) : e.isFile() && e.name.endsWith('.md')) n++;
    }
  }
  return n;
}

/** Start lines for repo knowledge (D-0002): `repo vedomosti: <repo> n záznamov, HANDOVER`, plus a topic repo's HANDOVER.md. */
export function repoKnowledgeLines(ctx) {
  const lines = [];
  for (const src of sessionKnowledgeSources(ctx)) {
    const handover = path.join(src.dir, REPO_HANDOVER);
    const has = fs.existsSync(handover);
    lines.push(`repo vedomosti: ${src.repo}${src.topic ? ` (téma ${src.topic})` : ''} ${countKnowledge(src.dir)} záznamov, ${has ? 'HANDOVER' : 'bez HANDOVER'}`);
    if (has && src.topic) lines.push(`HANDOVER ${src.repo} (stav projektu):\n${fs.readFileSync(handover, 'utf8').trim().replace(/^## /gm, '### ')}`);
  }
  return lines;
}

/** The start question of a thread without a topic (P-050, as a P-061 question); Stop arms no auto timer after it. */
export const TOPIC_QUESTION = 'Aká bude téma?';

/** Status block shown to the operator at start (P-050): topic, free topics and the question when none is held, waiting mail. */
export function operatorStatus(ctx, info) {
  const lines = [];
  // The project leads the line (operator 2026-11-04: "skarper-web / bez témy", "skarper-web / <téma>").
  if (info.held.length) {
    lines.push(`${ctx.projectName} / ${info.held[0].id}`);
  } else {
    lines.push(`${ctx.projectName} / bez témy`, '', 'Dostupné témy:');
    const free = freeTopics(ctx);
    lines.push(...(free.length ? free.map((t) => `- ${t.id}${t.subject && t.subject !== t.id ? ` – ${t.subject}` : ''}`) : ['- žiadne']));
    lines.push('', '**Otázky na operátora:**', `1. ${TOPIC_QUESTION}`);
  }
  if (info.notices) lines.splice(1, 0, `Otvorené oznamy: ${info.notices}`);
  if (info.mail.count) lines.splice(1, 0, `Pošta: ${info.mail.count}${info.mail.blockers ? ` (${info.mail.blockers} blocker)` : ''}${info.mail.steers ? ` (${info.mail.steers} steer)` : ''}`);
  return lines.join('\n');
}

function freeTopics(ctx) {
  return ctx.brainDir ? readTopics(ctx.brainDir).filter((t) => t.kind !== 'main' && (t.state === 'free' || !t.holder?.thread)) : [];
}

/**
 * T3-WORKAROUND(hook-message-hidden) The harness UI (T3) does not show hook messages, so the agent shows the block (P-050): verbatim, as the start of its
 * first reply only; without a held topic the operator's answer to the question decides the topic.
 */
export function statusBlockInstruction(block, unknown = false, project = '<project>') {
  const n = block.split('\n').length;
  // The question is only for an unknown topic: a prompt that names the topic (claimed before the reply) is not asked again.
  const known = unknown ? `\nThis block is only for a topic that stays unknown. If the operator's prompt names the topic or starts new work, claim that topic or create it (\`topic.mjs create <id> --subject "<subject>" --class web|code|ops|discussion\` claims it, skill workflow:topic) before your first reply, and start that reply instead with \`${project} / <id>\` (and the \`Pošta:\` line if shown above), without the list and without \`Aká bude téma?\`; asking for a topic that is known is wrong (P-050).` : '';
  return `status block (P-050): your first reply in this session MUST start with exactly the next ${n} lines, verbatim, before anything else (no tags, no code fence)${unknown ? ', unless the topic is known (below)' : ''}; later replies MUST NOT repeat them:\n${block}\n(end of status block)${known}${unknown ? `\nA reply that leaves the topic question open ends with the lines \`${HANDOVER_NONE_LINE}\` and \`Stav: otázka\` (P-061).` : ''}`;
}

/** All open topics, one line each (P-021 item 6); the limit is reported through index warnings. */
function heldTopicsAll(ctx) {
  return ctx.brainDir ? readTopics(ctx.brainDir) : [];
}

export function brainRelDefault(projectDir) {
  return `../${path.basename(projectDir)}-brain`;
}
