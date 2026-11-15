// Topic handoff tracking (agent-alice/D-0082, operator 2026-11-15). The orchestrator copied the state of a topic it had
// handed off into its own handover; the operator then gave the work in that topic's own thread and the copy went stale,
// so the orchestrator passed it off as fact and asked the operator the same thing again. Topics also worked over each
// other because their tasks overlapped and the giver did not note what it gave. Here:
//   1. a handoff is a record in the giver's topic (topics/<giver>/handoffs.json), written by code with the create, thread
//      or `comms send --handoff` that makes it;
//   2. the giver's handover shows the live state of each target in a section written by code (save handover, boot);
//   3. a new scope is compared with the open topics of the same repo or project (word stems, then a cheap judge);
//   4. a change in a target (decision, Zadanie, Ďalší krok, closed) is a line for the giver until it saves its handover;
//   5. a dialog about the scope of a topic another thread holds is refused: its holder asks the operator.
// No import of topic.mjs: it imports this module.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, nowIso, git, localTime, relPosix } from './util.mjs';
import { dataPath, dataRel, layoutOf } from './layout.mjs';
import { readTopics, readDecisions } from './records.mjs';
import { readTopicRecord, openTopicExists, closedTopicExists, closedTopicDir } from './topic-files.mjs';
import { readHolder, isHolderOf, brainWrite } from './brain.mjs';
import { handoverNextStep, HANDOFFS_SECTION } from './brain-checks.mjs';
import { stems } from './rule-gate.mjs';
import { isMainTopic } from './comms.mjs';
import { setStallCheck, stallCheckMs, registerTimerThread } from './waker.mjs';

export const HANDOFFS_FILE = 'handoffs.json';
export const handoffsRel = (brainDir, id) => dataRel(brainDir, 'topics', id, HANDOFFS_FILE);
export const handoffsPath = (brainDir, id) => dataPath(brainDir, 'topics', id, HANDOFFS_FILE);

export function readHandoffs(brainDir, id) {
  if (!brainDir || !id) return [];
  const list = readJson(handoffsPath(brainDir, id), []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.to === 'string') : [];
}

/** The op writing the records of topic `id` (for a brainWrite with internal: true). */
export const handoffsOp = (brainDir, id, records) => ({ path: handoffsRel(brainDir, id), content: `${JSON.stringify(records.slice(-100), null, 2)}\n` });

/** Topics this thread holds, work topics first (as topic.mjs heldTopics). */
function held(brainDir, thread) {
  if (!brainDir || !thread) return [];
  const all = readTopics(brainDir).filter((t) => isHolderOf(t.holder, thread));
  return [...all.filter((t) => !isMainTopic(t)), ...all.filter(isMainTopic)];
}

/** The giver of a handoff: the topic this thread holds (a work topic first; main only when it is the only one), or null. */
export function giverTopic(brainDir, thread) {
  return held(brainDir, thread)[0]?.id || null;
}

/** Body lines of a handover section (without the heading). */
export function sectionBody(text, heading) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return [];
  const end = lines.findIndex((l, j) => j > i && /^## /.test(l.trim()));
  return lines.slice(i + 1, end === -1 ? lines.length : end).filter((l) => l.trim());
}

function handoverFile(brainDir, id) {
  const name = layoutOf(brainDir).handover;
  if (openTopicExists(brainDir, id)) return path.join(dataPath(brainDir, 'topics', id), name);
  if (closedTopicExists(brainDir, id)) return path.join(closedTopicDir(brainDir, id), name);
  return null;
}

/** Commit time (ISO) of the last brain commit that touched `file`, or null. */
function commitTime(brainDir, file) {
  if (!file) return null;
  const r = git(['log', '-1', '--format=%cI', '--', relPosix(brainDir, file)], { cwd: brainDir });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Decisions of a topic: the frontmatter `topic` that save decision records (the topic its thread held); a decision from
 * before that field names no topic and is not linked.
 */
function topicDecisions(brainDir, id) {
  try { return readDecisions(brainDir).filter((d) => String(d.data?.topic || '') === id).map((d) => ({ id: String(d.data.id || d.key), file: d.abs })); } catch { return []; }
}

/** What point 4 compares: { open, task, next, decisions } of the target, read live; null when the brain has no such topic. */
export function targetSnapshot(brainDir, id) {
  const open = openTopicExists(brainDir, id);
  if (!open && !closedTopicExists(brainDir, id)) return null;
  const file = handoverFile(brainDir, id);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  return { open, task: sectionBody(text, '## Zadanie').join('\n').trim(), next: handoverNextStep(text), decisions: topicDecisions(brainDir, id).map((d) => d.id) };
}

/** A new record; the snapshot is the baseline of point 4 (the target as it is at the handoff). */
export function newRecord(brainDir, { to, project = null, scope, not = null, via, snapshot }) {
  const s = snapshot === undefined ? targetSnapshot(brainDir, to) : snapshot;
  return { to, ...(project ? { project } : {}), scope: String(scope || '').trim(), not: not && String(not).trim() ? String(not).trim() : null, at: nowIso(), via, snapshot: s || null };
}

/** Write one record into the giver's topic in its own brain commit; the giver's thread gets the stall check of the target. */
export function writeHandoff(ctx, giver, record) {
  const list = [...readHandoffs(ctx.brainDir, giver), record];
  const res = brainWrite(ctx, { internal: true, ops: [handoffsOp(ctx.brainDir, giver, list)], message: `handoff ${giver} -> ${record.project ? `${record.project}/` : ''}${record.to} (${record.via})` });
  armStallCheck(ctx, record.to);
  return res;
}

/**
 * agent-alice/D-0084: the thread that hands topic `to` off gets its stall check (scripts/waker.mjs setStallCheck), one per
 * topic, a new handoff replaces it. Only for an open topic of the giver's brain: `topic.mjs stalled` reads its thread state
 * there (a topic of another brain is asked by mail). Never throws; returns the timer or null.
 */
export function armStallCheck(ctx, to) {
  try {
    if (!ctx?.brainDir || !ctx.thread || !to || !openTopicExists(ctx.brainDir, to)) return null;
    const t = setStallCheck(ctx.brainDir, ctx.thread, to, { everyMs: stallCheckMs(ctx.policy) });
    registerTimerThread(ctx);
    return t;
  } catch { return null; }
}

const oneLine = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The scope of a topic: its subject with its task (agent-alice/D-0082 point 2). A task is often only a pointer to a task file
 * ("Zadanie je v …task.md"), so the subject names the work; a task that already holds the subject is kept as is.
 */
export function topicScopeText(subject, task) {
  const s = String(subject || '').trim();
  const t = String(task || '').trim();
  if (!s) return t;
  if (!t || t === s || t.toLowerCase().includes(s.toLowerCase())) return t || s;
  return `${s}: ${t}`;
}
const scopeText = (r) => `${oneLine(r.scope)}${r.not ? ` (mimo: ${oneLine(r.not, 100)})` : ''}`;

/** One line of the section for a record, read live: { line, closed, snapshot }. */
export function handoffLine(brainDir, r) {
  const name = r.project && !openTopicExists(brainDir, r.to) && !closedTopicExists(brainDir, r.to) ? `${r.project}/${r.to}` : r.to;
  const snap = targetSnapshot(brainDir, r.to);
  // A record from before point 2 holds only --task: the section shows the target's subject with it.
  if (snap) { try { const subject = readTopicRecord(brainDir, r.to, { closed: !snap.open })?.subject; if (subject) r = { ...r, scope: topicScopeText(subject, r.scope) }; } catch { /* the stored scope stays */ } }
  if (!snap) return { line: `- ${name}: ${scopeText(r)} | stav nie je v tomto brain-e (téma iného projektu: pýtaj sa jej držiteľa poštou)`, closed: false, snapshot: r.snapshot || null };
  const at = commitTime(brainDir, handoverFile(brainDir, r.to));
  const when = at ? localTime(at) : '-';
  if (!snap.open) {
    const verified = readTopicRecord(brainDir, r.to, { closed: true })?.verified;
    return { line: `- ${name}: ${scopeText(r)} | uzavretá | držiteľ žiadny | handover ${when} | výsledok: ${oneLine(verified, 200) || '-'}`, closed: true, snapshot: snap };
  }
  const holder = readHolder(brainDir, r.to).thread || 'žiadny';
  return { line: `- ${name}: ${scopeText(r)} | otvorená | držiteľ ${holder} | handover ${when} | ďalej: ${oneLine(snap.next) || '-'}`, closed: false, snapshot: snap };
}

/**
 * The section of a giver topic: lines of the records not shown closed yet, and the records as save handover stores them
 * (each with a fresh snapshot, a closed one marked closed_shown so the next save leaves it out).
 */
export function handoffView(brainDir, id) {
  const all = readHandoffs(brainDir, id);
  const lines = [];
  const records = all.map((r) => {
    if (r.closed_shown) return r;
    const v = handoffLine(brainDir, r);
    lines.push(v.line);
    return { ...r, snapshot: v.snapshot, ...(v.closed ? { closed_shown: true } : {}) };
  });
  return { lines, records, changed: all.length > 0 };
}

/** The section as the boot shows it (live, not stored): lines per held topic with records. */
export function bootHandoffLines(brainDir, thread) {
  const out = [];
  for (const t of held(brainDir, thread)) {
    const { lines } = handoffView(brainDir, t.id);
    if (lines.length) out.push(`${HANDOFFS_SECTION} (téma ${t.id}, živý stav z odovzdaných tém, D-0082):`, ...lines);
  }
  return out;
}

// --- point 2: --next / --done that copies the state of another topic -------------------------------------------------

const STATE_WORDS = ['zostáva', 'ostáva', 'čaká', 'hotové', 'hotová', 'hotovo', 'ďalšia', 'ďalší', 'ďalšie',
  // without diacritics, as agents also write (pilot 2026-11-15: "dalšia" passed); not "cakam", the own step
  'zostava', 'ostava', 'caka', 'hotove', 'hotova', 'dalsia', 'dalšia', 'dalsi', 'další', 'dalsie', 'dalšie', 'done', 'pending', 'remaining', 'waits', 'next'];
const STATE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${STATE_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The other open topic an item names (its id as a word, or its full subject), or null. */
function namedTopic(text, topics) {
  const low = String(text).toLowerCase();
  for (const t of topics) {
    if (new RegExp(`(?<![\\p{L}\\p{N}-])${esc(t.id)}(?![\\p{L}\\p{N}-])`, 'iu').test(text)) return t.id;
    const subject = String(t.subject || '').trim().toLowerCase();
    if (subject.length >= 6 && low.includes(subject)) return t.id;
  }
  return null;
}

/**
 * The points of one line of a step: numbered "1) … 2) …" or separated by ";" (agent-alice/D-0094: a state word of one point
 * and a topic named in another are two points, the whole line read as one gave four false refusals in a day).
 */
export function stepPoints(text) {
  return String(text || '').split(/;|(?:^|\s)\(?\d{1,2}[).]\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The handover `content` of topic `own` describes in a point of Ďalší krok or of an item of Hotové the state of another open
 * topic (the point names the topic and a state word): { field: 'next'|'done', id, point }, else null. Only a warning
 * (P-076): the agent rewrites the point, nothing is refused.
 */
export function copiedState(brainDir, own, content) {
  let topics = [];
  try { topics = readTopics(brainDir).filter((t) => t.id !== own && !isMainTopic(t)); } catch { return null; }
  if (!topics.length) return null;
  const items = [
    ...sectionBody(content, '## Ďalší krok').map((l) => ({ field: 'next', text: l.replace(/^-\s*/, '') })),
    ...sectionBody(content, '## Hotové').map((l) => ({ field: 'done', text: l.replace(/^-\s*/, '') })),
  ];
  for (const it of items) {
    for (const point of stepPoints(it.text)) {
      if (!STATE_RE.test(point)) continue;
      const id = namedTopic(point, topics);
      if (id) return { field: it.field, id, point };
    }
  }
  return null;
}

export const COPIED_STATE_WARNING = ({ field, id, point }) => `warning: --${field} "${oneLine(point, 120)}" describes the state of topic ${id}; that state is in the section "${HANDOFFS_SECTION}" (written by code from the topic itself, agent-alice/D-0082) and a copy goes stale: at the next save write only your own step there (e.g. "dohľad nad ${id}"); the handover is written`;

// --- point 3 and 5: the cheap judge -------------------------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { overlaps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, how: { type: 'string' } }, required: ['id', 'how'] } } },
  required: ['overlaps'],
};

/**
 * Ask the judge (pattern of judgeRule, scripts/rule-gate.mjs): `claude -p` on the policy's subagents.default_model, or the
 * command in WORKFLOW_OVERLAP_JUDGE_CMD (prompt on stdin, prints {overlaps:[{id,how}]}). WORKFLOW_OVERLAP_JUDGE=off: none.
 * Returns { ok: true, overlaps } (ids limited to `ids`) or { ok: false, cause }.
 */
export function askJudge(ctx, prompt, ids, { timeout = 120_000, spawn = spawnSync } = {}) {
  if (process.env.WORKFLOW_OVERLAP_JUDGE === 'off') return { ok: false, cause: 'judge off, WORKFLOW_OVERLAP_JUDGE=off' };
  const custom = process.env.WORKFLOW_OVERLAP_JUDGE_CMD;
  const model = ctx?.policy?.subagents?.default_model || 'haiku';
  const res = custom
    ? spawn('sh', ['-c', custom], { input: prompt, encoding: 'utf8', timeout })
    : spawn('claude', ['-p', '--model', model, '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE_SCHEMA)], { input: prompt, encoding: 'utf8', timeout, cwd: '/' });
  if (res.error) return { ok: false, cause: res.error.code === 'ETIMEDOUT' ? `judge timed out after ${Math.round(timeout / 1000)} s` : `judge did not run: ${res.error.message}` };
  if (res.status !== 0 || !res.stdout) return { ok: false, cause: `judge exit ${res.status}${res.stderr ? `: ${oneLine(res.stderr, 120)}` : ''}` };
  try {
    let data = JSON.parse(res.stdout);
    if (data && data.structured_output) data = data.structured_output;
    else if (data && typeof data.result === 'string') data = JSON.parse(data.result.replace(/^```(json)?|```$/g, '').trim());
    const known = new Set(ids);
    const overlaps = (Array.isArray(data?.overlaps) ? data.overlaps : []).filter((x) => x && known.has(String(x.id).trim())).map((x) => ({ id: String(x.id).trim(), how: oneLine(x.how, 200) }));
    return { ok: true, overlaps };
  } catch (err) {
    return { ok: false, cause: `judge answer is no JSON (${oneLine(err.message, 80)})` };
  }
}

const topicScope = (t) => oneLine(topicScopeText(t.subject, t.task), 300);
const topicBlock = (t) => `## id: ${t.id}\nsubject: ${oneLine(t.subject, 200)}\nscope: ${topicScope(t)}\nholder: ${t.holder?.thread || 'nobody'}`;

/** Open topics a new scope is compared with: same repo, or for topics without a repo the same mail project. */
export function overlapCandidates(brainDir, { scope, repo = null, project = null, exclude = [] }) {
  const skip = new Set([].concat(exclude).filter(Boolean));
  const mine = stems(scope);
  if (!mine.size) return [];
  let topics = [];
  try { topics = readTopics(brainDir); } catch { return []; }
  return topics.filter((t) => {
    if (skip.has(t.id) || isMainTopic(t)) return false;
    if (repo ? t.repo !== repo : !!t.repo || (t.project || null) !== (project || null)) return false;
    const theirs = stems(`${t.subject || ''} ${t.task || ''}`);
    return [...mine].filter((s) => theirs.has(s)).length >= 2;
  });
}

/**
 * Point 3: does the new scope overlap an open topic? Returns { lines, overlaps, refusal } where lines are the `overlap:`
 * lines to print, refusal the text when an overlap is found (null with --distinct, or for `auto` which never refuses), and
 * an unavailable judge refuses nothing (`overlap: not checked (<cause>)`).
 */
export function checkOverlap(ctx, { scope, not = null, repo = null, project = null, exclude = [], distinct = null, what = 'nothing created' } = {}) {
  if (!ctx?.brainDir || !scope || !String(scope).trim()) return { lines: [], overlaps: [], refusal: null };
  if (typeof distinct === 'string' && distinct.trim()) return { lines: [], overlaps: [], refusal: null };
  // The topics this thread holds are the giver's own: handing a part of them on is the point, not an overlap.
  const own = held(ctx.brainDir, ctx.thread).map((t) => t.id);
  const candidates = overlapCandidates(ctx.brainDir, { scope, repo, project, exclude: [...[].concat(exclude), ...own] });
  if (!candidates.length) return { lines: [], overlaps: [], refusal: null };
  const prompt = [
    'You check whether a new piece of agent work overlaps open topics (work items that agent threads hold). Answer only with the JSON object.',
    'overlaps: the open topics whose scope covers the same work as the new scope, even partly or in other words (the same thing would be done twice, or both would change the same thing). Not a topic that only shares words or the field. Ids exactly as given; how: in one short sentence what both cover. Empty array when none.',
    '',
    '# Open topics',
    ...candidates.map(topicBlock),
    '',
    '# New scope',
    String(scope).trim(),
    ...(not && String(not).trim() ? ['', '# Not in the new scope (left out on purpose)', String(not).trim()] : []),
  ].join('\n');
  const verdict = askJudge(ctx, prompt, candidates.map((t) => t.id));
  if (!verdict.ok) return { lines: [`overlap: not checked (${verdict.cause})`], overlaps: [], refusal: null };
  const overlaps = verdict.overlaps.map((o) => ({ ...o, topic: candidates.find((t) => t.id === o.id) }));
  if (!overlaps.length) return { lines: [], overlaps: [], refusal: null };
  const refusal = overlaps.map(({ id, how, topic }) => `scope overlaps open topic ${id} (held by ${topic.holder?.thread || 'nobody'}, scope: ${topicScope(topic)}${how ? `; ${how}` : ''})`).join('; ')
    + `: send the work to its holder (comms send --to ${overlaps[0].id} --level assist --handoff "<scope>" --text ".."), narrow the scope (--not "<what stays out>"), or say how it differs (--distinct "<how it differs>"); ${what} (agent-alice/D-0082)`;
  return { lines: overlaps.map((o) => `overlap: ${o.id} (${o.how || 'same scope'})`), overlaps, refusal };
}

// --- point 4: what changed in a target since the giver's last save --------------------------------------------------------

/**
 * Changes of the targets of the topics this thread holds since their record's snapshot: [{ to, what, at, key, line }].
 * The line: `handoff <topic>: <what changed> (<local time of the change>)`.
 */
export function handoffChanges(ctx) {
  if (!ctx?.brainDir || !ctx.thread) return [];
  const out = [];
  for (const t of held(ctx.brainDir, ctx.thread)) {
    for (const r of readHandoffs(ctx.brainDir, t.id)) {
      if (r.closed_shown || !r.snapshot) continue;
      const live = targetSnapshot(ctx.brainDir, r.to);
      if (!live) continue;
      const was = r.snapshot;
      const what = [];
      const times = [];
      const handoverAt = () => commitTime(ctx.brainDir, handoverFile(ctx.brainDir, r.to));
      const fresh = (live.decisions || []).filter((d) => !(was.decisions || []).includes(d));
      if (fresh.length) {
        what.push(`nové rozhodnutie ${fresh.join(', ')}`);
        for (const d of topicDecisions(ctx.brainDir, r.to).filter((x) => fresh.includes(x.id))) times.push(commitTime(ctx.brainDir, d.file));
      }
      if ((live.task || '') !== (was.task || '')) { what.push('zmenené Zadanie'); times.push(handoverAt()); }
      if ((live.next || '') !== (was.next || '')) { what.push(`zmenený Ďalší krok: "${oneLine(live.next, 120) || '-'}"`); times.push(handoverAt()); }
      if (was.open && !live.open) {
        const closed = readTopicRecord(ctx.brainDir, r.to, { closed: true });
        what.push(`uzavretá (výsledok: ${oneLine(closed?.verified, 120) || '-'})`);
        times.push(closed?.closed || null);
      }
      if (!what.length) continue;
      const at = times.filter(Boolean).sort().pop();
      const text = what.join(', ');
      out.push({ to: r.to, what: text, at, key: `${t.id}>${r.to}|${text}`, line: `handoff ${r.to}: ${text} (${at ? localTime(at) : '?'}); the section ${HANDOFFS_SECTION} refreshes with your save handover ${t.id}` });
    }
  }
  return out;
}

// --- point 5: a dialog about the scope of a topic another thread holds ------------------------------------------------------

/** The operator's prompt names the topic: its id as a word or its subject. */
function promptNames(prompt, t) {
  const p = String(prompt || '');
  if (!p.trim()) return false;
  if (new RegExp(`(?<![\\p{L}\\p{N}-])${esc(t.id)}(?![\\p{L}\\p{N}-])`, 'iu').test(p)) return true;
  const s = String(t.subject || '').trim().toLowerCase();
  return s.length >= 6 && p.toLowerCase().includes(s);
}

/** Mail this thread received in the current turn (thread state `received_from`, written by comms receive). */
function receivedThisTurn(state) {
  const since = state?.turn_started_at || null;
  if (!since) return [];
  return (Array.isArray(state.received_from) ? state.received_from : []).filter((m) => m && m.at && m.at >= since);
}

/**
 * The topic whose scope a dialog asks about, held by another thread: candidates are the open targets of this thread's
 * records and the open topics another thread holds; a topic the last operator prompt names is left out. Returns
 * { id, holder, scope, how } or null (no candidate, no overlap, or the judge unavailable: the dialog passes).
 * With the thread state (`state`): a turn the operator started passes (the operator asked here, in this turn); a topic
 * whose question this thread received in this turn (mail from the topic or its holder, P-064) is left out.
 */
export function dialogHolderTopic(ctx, dialogText, operatorPrompt = '', { timeout = 12_000, state = null } = {}) {
  if (!ctx?.brainDir || !ctx.thread || !String(dialogText || '').trim()) return null;
  if (state?.turn_source === 'operator') return null;
  let topics = [];
  try { topics = readTopics(ctx.brainDir); } catch { return null; }
  const own = new Set(held(ctx.brainDir, ctx.thread).map((t) => t.id));
  const targets = new Set(held(ctx.brainDir, ctx.thread).flatMap((t) => readHandoffs(ctx.brainDir, t.id).filter((r) => !r.closed_shown).map((r) => r.to)));
  const got = receivedThisTurn(state);
  const askedHere = (t) => got.some((m) => m.from_topic === t.id || (t.holder?.thread && m.thread_id === t.holder.thread));
  const candidates = topics.filter((t) => !isMainTopic(t) && !own.has(t.id) && (targets.has(t.id) || (t.holder?.thread && t.holder.thread !== ctx.thread)))
    .filter((t) => !promptNames(operatorPrompt, t) && !askedHere(t));
  // Lexical prefilter as in point 3: a dialog sharing fewer than 2 word stems with a topic does not call the judge, so a
  // dialog unrelated to other topics costs no `claude -p` (the hook has 15 s).
  const asked = stems(dialogText);
  const related = candidates.filter((t) => { const theirs = stems(`${t.subject || ''} ${t.task || ''}`); return [...asked].filter((s) => theirs.has(s)).length >= 2; });
  if (!related.length) return null;
  const prompt = [
    'An agent wants to ask its operator the question below in a dialog. Other agent threads hold the open topics listed; the holder of a topic asks the operator about it in its own thread, not this agent. Answer only with the JSON object.',
    'overlaps: the topics whose scope the dialog asks the operator about (what to do in it, which variant, next step, its state or result). The dialog does not name topic ids: compare the content. Not a topic that only shares words. Ids exactly as given; how: in one short sentence what the question asks of it. Empty array when none.',
    '',
    '# Open topics held by other threads',
    ...related.map(topicBlock),
    '',
    '# Dialog (questions and options)',
    String(dialogText).trim(),
  ].join('\n');
  const verdict = askJudge(ctx, prompt, related.map((t) => t.id), { timeout });
  if (!verdict.ok || !verdict.overlaps.length) return null;
  const hit = related.find((t) => t.id === verdict.overlaps[0].id);
  return { id: hit.id, holder: hit.holder?.thread || null, scope: topicScope(hit), how: verdict.overlaps[0].how };
}

export const HOLDER_QUESTION_REASON = (h) => `this question belongs to topic ${h.id} (held by ${h.holder || 'nobody'}, scope: ${h.scope}): send it to its holder (comms send --to ${h.id} --level assist) with the options and your recommendation; its holder asks the operator in its own thread (agent-alice/D-0082)`;
