// Overlap of a new topic with the open topics (flow v2, plan O6): at topic create the scope of the new topic is compared
// with the open topics of the same repo or mail project (word stems, then a cheap judge) and the overlaps are listed as
// `overlap:` lines. Nothing is refused: whether two topics overlap is the supervisor's judgement (spec 3.9.4, 3.3.2a).
// No import of topic.mjs: it imports this module.
import { spawnSync } from 'node:child_process';
import { readTopics } from './records.mjs';
import { isHolderOf } from './brain.mjs';
import { stems } from './rule-gate.mjs';
import { isMainTopic } from './comms.mjs';

const oneLine = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The scope of a topic: its subject with its task. A task is often only a pointer to a task file ("Zadanie je v …task.md"),
 * so the subject names the work; a task that already holds the subject is kept as is.
 */
export function topicScopeText(subject, task) {
  const s = String(subject || '').trim();
  const t = String(task || '').trim();
  if (!s) return t;
  if (!t || t === s || t.toLowerCase().includes(s.toLowerCase())) return t || s;
  return `${s}: ${t}`;
}

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
 * Does the scope of a new topic overlap an open topic? Returns { lines, overlaps }: `overlap: <id> held by <thread>
 * (<how>)` per overlap, `overlap: not checked (<cause>)` when the judge is unavailable. The topics this thread holds are
 * left out (a part of them given to a new topic is the point, not an overlap). Never refuses.
 */
export function checkOverlap(ctx, { scope, repo = null, project = null, exclude = [] } = {}) {
  if (!ctx?.brainDir || !scope || !String(scope).trim()) return { lines: [], overlaps: [] };
  let own = [];
  try { own = ctx.thread ? readTopics(ctx.brainDir).filter((t) => isHolderOf(t.holder, ctx.thread)).map((t) => t.id) : []; } catch { own = []; }
  const candidates = overlapCandidates(ctx.brainDir, { scope, repo, project, exclude: [...[].concat(exclude), ...own] });
  if (!candidates.length) return { lines: [], overlaps: [] };
  const prompt = [
    'You check whether a new piece of agent work overlaps open topics (work items that agent threads hold). Answer only with the JSON object.',
    'overlaps: the open topics whose scope covers the same work as the new scope, even partly or in other words (the same thing would be done twice, or both would change the same thing). Not a topic that only shares words or the field. Ids exactly as given; how: in one short sentence what both cover. Empty array when none.',
    '',
    '# Open topics',
    ...candidates.map(topicBlock),
    '',
    '# New scope',
    String(scope).trim(),
  ].join('\n');
  const verdict = askJudge(ctx, prompt, candidates.map((t) => t.id));
  if (!verdict.ok) return { lines: [`overlap: not checked (${verdict.cause})`], overlaps: [] };
  const overlaps = verdict.overlaps.map((o) => ({ ...o, topic: candidates.find((t) => t.id === o.id) }));
  return { lines: overlaps.map(({ id, how, topic }) => `overlap: ${id} held by ${topic.holder?.thread || 'nobody'} (${how || 'same scope'})`), overlaps };
}
