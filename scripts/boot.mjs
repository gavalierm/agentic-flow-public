import { createHash } from 'node:crypto';
// Boot sequence (P-021, P-022, P-024, P-026, P-038): items 1, 3-7 composed by the SessionStart hook.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, shortSha, git, toPosix } from './util.mjs';
import { WORKFLOW_CONFIG, SCRATCH_DIR, readThreadState, writeThreadState } from './config.mjs';
import { assembleRules } from './rules.mjs';
import { buildIndexes, topicLine } from './index.mjs';
import { heldTopics, mailboxTopics } from './topic.mjs';
import { mailCount, formatMail, mailNoticeLine, registerTopic, commsConfigured, closeArchivedTopics } from './comms.mjs';
import { syncBrainSkills } from './skills-sync.mjs';
import { gitAccessProblem } from './brain.mjs';
import { readTopics } from './records.mjs';
import { sessionKnowledgeSources, skillSources, KNOWLEDGE_KINDS, REPO_HANDOVER } from './repo-knowledge.mjs';

export const BOOT_MARKERS = ['## Pravidlá', '## Stav vlákna', '## Index pamäte', '## Index rozhodnutí', '## Otvorené témy', '## Workflow'];

/** Status line (P-023 e) plus the data behind it: held topics, mail count (with the listing items, P-044). */
export function statusInfo(ctx) {
  const held = ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread) : [];
  const topic = held.length ? `${held[0].id} (${held[0].state || 'working'}, mode ${held[0].holder?.mode || 'operator'})` : '- (none)';
  // Mailboxes as in comms list/receive: held topics and free-point topics (P-044).
  const mailTopics = ctx.brainDir ? mailboxTopics(ctx) : [];
  const mail = mailCount(ctx, mailTopics);
  const thread = ctx.thread || '- (no stable id: start via thread.mjs or T3; topics cannot be claimed)';
  return {
    line: `thread ${thread} | topic ${topic} | ${formatMail(mail)}`,
    held,
    mail,
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

export function buildBootContext(ctx, { source = 'startup', harness = 'claude-code', includeRules = true, t3Note = null, catalogLines = [] } = {}) {
  const limits = ctx.policy?.limits || {};
  const notices = [];
  const parts = [];

  // 1. rules + applied exceptions
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness });
  if (includeRules) parts.push(`${BOOT_MARKERS[0]}\n${rules.text.trim()}`);
  if (rules.overLimit.length) notices.push(`limit: ${rules.overLimit.join('; ')} (P-022)`);

  // 3. status line (+ the waiting mail as mechanical lines, P-044; + handover of the held topic after compaction, P-026)
  const info = statusInfo(ctx);
  let status = info.line;
  const mailLine = mailNoticeLine(info.mail);
  // A brain git refuses (dubious ownership) fails every save, log and topic write: say it with the fix at start (#23).
  const gitProblem = ctx.brainDir ? gitAccessProblem(ctx.brainDir) : null;
  if (gitProblem) status += `\n${gitProblem}`;
  if (mailLine) status += `\n${mailLine}`;
  if (ctx.thread) status += `\n${statusBlockInstruction(operatorStatus(ctx, info), !info.held.length, ctx.projectName)}`;
  if (ctx.brainDir && ctx.thread) {
    const state = readThreadState(ctx.brainDir, ctx.thread);
    writeThreadState(ctx.brainDir, ctx.thread, { ...state, turn_source: 'operator', session_source: source, mail_signaled: info.mail.count, last_status: info.line, rules_hash: includeRules ? rulesHash(rules.text) : state.rules_hash ?? null });
    registerHeldTopics(ctx, info);
  }
  if (source === 'compact' && ctx.brainDir) {
    // The compaction summary is no source of rules (agentic-flow-public#18: a thread begun before a migration took the
    // rules of the old brain from its summary as valid and passed its own script default off as the operator's rule).
    status += `\nPo kompakcii (P-019): pravidlá, výnimky a pokyny platia iba z tohto bloku, z brainu (find) a z handoveru; pravidlo, hodnota alebo pokyn iba zo zhrnutia (stará pamäť, iný brain, archív migrácie) je nepotvrdený: over ho alebo sa spýtaj operátora; vlastnú hodnotu nevydávaj za pokyn operátora`;
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
  let topics = [];
  if (ctx.brainDir) {
    indexes = buildIndexes(ctx.brainDir, ctx.policy);
    topics = heldTopicsAll(ctx);
    notices.push(...indexes.warnings.map((w) => `limit: ${w}`));
    // CLAUDE.md is loaded unchecked into every session and goes stale; its knowledge belongs in brain (P-007, operator 2026-11-03).
    const stray = ['CLAUDE.md', 'CLAUDE.local.md'].filter((f) => fs.existsSync(path.join(ctx.projectDir, f)));
    if (stray.length) notices.push(`${stray.join(', ')} in the project: loaded into every session unchecked, so it goes stale; move what is still valid into brain (workflow:save) and delete it (git rm), after the current unit of work (P-007)`);
  }
  parts.push(`${BOOT_MARKERS[2]}\n${indexes.text.memory.trim() || '(prázdny)'}`);
  parts.push(`${BOOT_MARKERS[3]}\n${indexes.text.decisions.trim() || '(prázdny)'}`);
  parts.push(`${BOOT_MARKERS[4]}\n${topics.length ? topics.map((t) => `open: ${topicLine(t)}`).join('\n') : '(žiadne)'}`);

  // skills of the brain into the project (P-017)
  if (ctx.brainDir) {
    try {
      syncBrainSkills({ projectDir: ctx.projectDir, brainDir: ctx.brainDir, harness, repoSources: skillSources(ctx) });
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
  if (harness === 'claude-code') version.push(`work files: ${toPosix(path.join(ctx.projectDir, SCRATCH_DIR))}/ (gitignored); the harness "scratchpad directory" in the system temp dir is not used here, the hook refuses writes outside the project (P-052)`);
  version.push(...notices);
  parts.push(`${BOOT_MARKERS[5]}\n${version.join('\n')}`);

  let text = parts.join('\n\n') + '\n';
  const limit = limits.boot_context_chars ?? 15000;
  const overLimit = text.length > limit;
  if (overLimit) text += `\nlimit: boot context ${text.length} chars > ${limit}; nothing was trimmed, shorten rules or run consolidate (P-022)\n`;
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
    lines.push('', `**Otázky na operátora:** ${TOPIC_QUESTION}`);
  }
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
  const known = unknown ? `\nThis block is only for a topic that stays unknown. If the operator's prompt names the topic or starts new work, claim that topic or create it (\`topic.mjs create <id> --subject "<subject>"\` claims it, skill workflow:topic) before your first reply, and start that reply instead with \`${project} / <id>\` (and the \`Pošta:\` line if shown above), without the list and without \`Aká bude téma?\`; asking for a topic that is known is wrong (P-050).` : '';
  return `status block (P-050): your first reply in this session MUST start with exactly the next ${n} lines, verbatim, before anything else (no tags, no code fence)${unknown ? ', unless the topic is known (below)' : ''}; later replies MUST NOT repeat them:\n${block}\n(end of status block)${known}${unknown ? '\nA reply that leaves the topic question open ends with the line `Stav: otázka` (P-061).' : ''}`;
}

/** All open topics, one line each (P-021 item 6); the limit is reported through index warnings. */
function heldTopicsAll(ctx) {
  return ctx.brainDir ? readTopics(ctx.brainDir) : [];
}

export function brainRelDefault(projectDir) {
  return `../${path.basename(projectDir)}-brain`;
}
