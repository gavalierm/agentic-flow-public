// New rule gate (operator 2026-11-03): rules are unreliable and every new one costs rule-limit characters, so a new rule
// is the last resort. Before one is written, code checks that no existing rule (workflow principle or project rule)
// already covers the subject (then that rule is extended or narrowed, a conflict resolved in it, not a second rule),
// that the assembled rules stay within the limit, and that the rule names the code enforcing it.
import path from 'node:path';
import { listFiles, readText, PLUGIN_ROOT } from './util.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { splitBlocks, ruleLayers } from './rules.mjs';
import { normalizeKey } from './keys.mjs';

/** Share of the new rule's word stems found in an existing rule at which they are one subject. */
export const SIMILAR_AT = 0.4;
const STEM = 5;
const STOP = new Set(['alebo', 'ktory', 'ktora', 'ktore', 'ktori', 'tento', 'tieto', 'takze', 'preto', 'lebo', 'pretoze', 'nesmi', 'musi',
  'mozes', 'nemoz', 'iba', 'len', 'ale', 'aby', 'ako', 'ked', 'kedy', 'pred', 'potom', 'ešte', 'este', 'vsetk', 'kazdy', 'kazd', 'nikdy',
  'vzdy', 'tvoj', 'tvoju', 'svoj', 'svoju', 'jeho', 'jej', 'their', 'there', 'which', 'when', 'must', 'never', 'always', 'with', 'from',
  'that', 'this', 'into', 'only', 'operator', 'opera', 'agent', 'agenta', 'pravi', 'workf', 'skill', 'hook']);

export function stems(text) {
  const out = new Set();
  for (const t of normalizeKey(text).split('-')) {
    if (t.length < 4 || /^\d+$/.test(t)) continue;
    const s = t.slice(0, STEM);
    if (!STOP.has(t) && !STOP.has(s)) out.add(s);
  }
  return out;
}

/** A rewrite that only removes or reorders words of the current wording (condensing) cannot add a conflict or an overlap. */
export function onlyCondenses(text, oldText) {
  if (!oldText || !oldText.trim()) return false;
  const old = stems(oldText);
  return [...stems(text)].every((s) => old.has(s));
}

/**
 * Workflow principles and project rules: [{ id, source, text }]. With layers (D-0025) the rules of every layer
 * (rules.mjs ruleLayers): the domain brain, the project brain, the repo; a repo rule has the id `<repo>/<name>`.
 */
export function ruleCorpus({ brainDir = null, coreDir = path.join(PLUGIN_ROOT, 'rules'), skip = null, layers = null } = {}) {
  const corpus = [];
  for (const file of listFiles(coreDir, (f) => f.endsWith('.md') && path.basename(f) !== 'README.md', { recursive: false })) {
    for (const b of splitBlocks(readText(file, '')).blocks) corpus.push({ id: b.id, source: 'workflow', text: b.text });
  }
  for (const layer of ruleLayers(brainDir, layers)) {
    for (const file of listFiles(layer.dir, (f) => f.endsWith('.md') && path.basename(f) !== 'README.md', { recursive: false })) {
      const name = path.basename(file, '.md');
      const id = layer.repo ? `${layer.repo}/${name}` : name;
      if (id === skip) continue;
      const { data, body } = parseFrontmatter(readText(file, ''));
      corpus.push({ id, source: layer.repo ? 'repo' : 'project', text: `${data.title || name}\n${body}` });
    }
  }
  return corpus;
}

/** Existing rules on the same subject as `text`, most similar first: [{ id, source, score, shared }]. */
export function similarRules(text, corpus, at = SIMILAR_AT) {
  const mine = stems(text);
  if (!mine.size) return [];
  return corpus
    .map((r) => {
      const theirs = stems(r.text);
      const shared = [...mine].filter((s) => theirs.has(s));
      return { id: r.id, source: r.source, score: shared.length / mine.size, shared };
    })
    .filter((r) => r.score >= at && r.shared.length >= 3)
    .sort((a, b) => b.score - a.score);
}

/**
 * `--distinct "<id>: <how it differs and why it does not conflict>; <id>: …"` must answer every similar rule.
 * Returns the ids left unanswered.
 */
export function unanswered(similar, distinct) {
  const parts = String(distinct || '').split(';').map((p) => p.trim()).filter(Boolean);
  const answered = new Set(parts.map((p) => /^([^:]+):\s*(.{20,})$/.exec(p)).filter(Boolean).map((m) => m[1].trim()));
  return similar.filter((s) => !answered.has(s.id)).map((s) => s.id);
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    overlaps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, how: { type: 'string' } }, required: ['id', 'how'] } },
    conflicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, how: { type: 'string' } }, required: ['id', 'how'] } },
    code_instead: { type: 'string' },
  },
  required: ['overlaps', 'conflicts', 'code_instead'],
};

function judgePrompt(rule, corpus) {
  return [
    'You review a proposed agent rule against the existing rules. Answer only with the JSON object.',
    'overlaps: existing rules that already cover the same subject or behaviour (even partly, in other words), so the proposed text belongs in that rule, not in a new one. Ids exactly as given.',
    'conflicts: existing rules the proposed rule contradicts (one allows what the other forbids, or they order different behaviour in the same situation).',
    'code_instead: if a hook or script could enforce the behaviour by itself (block the action, do the step automatically) so the agent needs no rule text, say how in one sentence; else empty.',
    'Empty arrays when there is nothing; do not invent overlaps for merely shared words.',
    '',
    '# Existing rules',
    ...corpus.map((r) => `## id: ${r.id} (${r.source})\n${r.text.trim()}`),
    '',
    ...(rule.oldText ? ['# Current wording of this rule (the proposal rewrites it)', rule.oldText.trim(), 'Report only overlaps and conflicts the proposed wording adds; not those the current wording already has.', ''] : []),
    '# Proposed rule',
    `id: ${rule.id}`,
    rule.text,
    rule.enforcedBy ? `enforced by: ${rule.enforcedBy}` : '',
  ].join('\n');
}

/**
 * Judge the proposed rule against the corpus: an LLM call (claude -p on the cheap model, no hooks, no tools) or the
 * command in WORKFLOW_RULE_JUDGE_CMD (gets the prompt on stdin, prints the JSON). Falls back to word-stem similarity
 * when no judge runs (WORKFLOW_RULE_JUDGE=off, CLI missing or failing). Returns { overlaps, conflicts, code_instead, by }.
 */
export function judgeRule(rule, corpus, { spawn } = {}) {
  const lexical = () => ({ overlaps: similarRules(rule.text, corpus).map((s) => ({ id: s.id, how: `shared terms: ${s.shared.join(', ')}` })), conflicts: [], code_instead: '', by: 'lexical' });
  if (process.env.WORKFLOW_RULE_JUDGE === 'off' || !spawn) return lexical();
  const prompt = judgePrompt(rule, corpus);
  const custom = process.env.WORKFLOW_RULE_JUDGE_CMD;
  const res = custom
    ? spawn('sh', ['-c', custom], { input: prompt, encoding: 'utf8', timeout: 120_000 })
    : spawn('claude', ['-p', '--model', 'haiku', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(JUDGE_SCHEMA)], { input: prompt, encoding: 'utf8', timeout: 120_000, cwd: '/' });
  if (res.status !== 0 || !res.stdout) return lexical();
  try {
    let data = JSON.parse(res.stdout);
    if (data && data.structured_output) data = data.structured_output;
    else if (data && typeof data.result === 'string') data = JSON.parse(data.result.replace(/^```(json)?|```$/g, '').trim());
    const ids = new Set(corpus.map((r) => r.id));
    const clean = (a) => (Array.isArray(a) ? a.filter((x) => x && ids.has(String(x.id).trim())).map((x) => ({ id: String(x.id).trim(), how: String(x.how || '').slice(0, 200) })) : []);
    return { overlaps: clean(data.overlaps), conflicts: clean(data.conflicts), code_instead: String(data.code_instead || '').slice(0, 300), by: custom ? 'judge-cmd' : 'llm' };
  } catch {
    return lexical();
  }
}
