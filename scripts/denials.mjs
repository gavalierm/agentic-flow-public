// Log of hook decisions (deny, ask, block) in <brain>/local/denials.jsonl (gitignored, per machine). Without it every
// false positive was found only by an interrupted agent and the rate was unknown (operator 2026-11-08, hooks review).
// Never throws: a log failure must not change a hook decision.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './layout.mjs';

export const DENIALS_FILE = 'denials.jsonl';
const KEEP = 2000;
const SECRETISH = /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+_-]{40,})\b/g;

export const denialsFile = (brainDir) => dataPath(brainDir, 'local', DENIALS_FILE);

const head = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(SECRETISH, '<masked>').slice(0, n);

/**
 * The kind of a refusal: the first clause of its reason without the variable parts (paths, quoted text, numbers, the
 * parentheses), at most 10 words. The counts group by it, so one check is one group (P-076: a hook that keeps refusing the
 * same kind of step shows a skill or rule that does not lead the work).
 */
export function kindOf(reason) {
  const text = String(reason || '')
    .replace(/`[^`]*`|"[^"]*"|„[^“”]*[“”]|'[^'\s][^']*'/g, '…')
    .replace(/\([^()]*\)/g, '')
    .replace(/(?:[A-Za-z]:)?(?:~|\.{1,2})?[\\/][^\s,;()]+/g, '<path>')
    .replace(/\b\d[\d.,:-]*\b/g, 'N')
    .replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
  const clause = text.split(/[;:](?:\s|$)/).map((s) => s.trim()).find((s) => s.split(' ').length >= 2) || text;
  return clause.split(' ').slice(0, 10).join(' ').replace(/[\s,.]+$/, '');
}

/** What the call did, in one short line: the command, the file path, or the prompt head. */
export function inputHead(tool, toolInput = {}) {
  const t = toolInput || {};
  return head(t.command ?? t.file_path ?? t.notebook_path ?? t.path ?? t.pattern ?? t.url ?? t.prompt ?? '', 160);
}

/**
 * Append one decision. `out` is the hook output: PreToolUse permissionDecision deny|ask, or Stop/SubagentStop
 * decision block. Anything else (allow, hint, nothing) is not logged.
 */
export function logDecision(brainDir, { event, tool = null, toolInput = null, out, thread = null, agentType = null, now = new Date() }) {
  try {
    if (!brainDir || !out) return false;
    const h = out.hookSpecificOutput || {};
    const decision = h.permissionDecision || out.decision || null;
    if (!['deny', 'ask', 'block'].includes(decision)) return false;
    const reason = String(h.permissionDecisionReason || out.reason || '');
    // The first cited principle is the check's own; later ones are references (`(P-007, P-013)`).
    const cited = [...new Set(reason.match(/\b[PD]-\d{3,4}\b/g) || [])];
    const principle = cited[0] || null;
    const line = { t: now.toISOString(), event, decision, kind: kindOf(reason), principle, cited, tool, thread, agent: agentType || null, input: tool ? inputHead(tool, toolInput) : null, reason: head(reason, 200) };
    const file = denialsFile(brainDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
    trim(file);
    return true;
  } catch { return false; }
}

function trim(file) {
  const size = fs.statSync(file).size;
  if (size < KEEP * 300) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > KEEP * 1.25) fs.writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n');
}

export function readDenials(brainDir, { days = 7, now = Date.now() } = {}) {
  let text = '';
  try { text = fs.readFileSync(denialsFile(brainDir), 'utf8'); } catch { return []; }
  const since = now - days * 86400000;
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && Date.parse(e.t) >= since);
}

/** Counts per principle and decision, most frequent first, with the last inputs of each. */
export function summarize(entries, { examples = 3 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.principle || '?'} ${e.event} ${e.decision}`;
    const g = groups.get(key) || { key, n: 0, last: [] };
    g.n++;
    g.last.push(e.input || e.reason);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n).map((g) => ({ ...g, last: g.last.slice(-examples) }));
}

/**
 * The most frequent kinds of refusal (event and kindOf), most frequent first: [{ event, kind, principle, n, last }]; the input
 * for consolidate (P-076: fix the skill or the rule that should have led the step, or loosen the hook). An entry from before
 * the kind field gets its kind from its reason.
 */
export function topDenials(entries, { top = 5 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const kind = e.kind || kindOf(e.reason);
    const key = `${e.event}\0${kind}`;
    const g = groups.get(key) || { event: e.event, kind, principle: e.principle || null, n: 0, last: '' };
    g.n++;
    g.last = e.input || e.reason || '';
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n).slice(0, top);
}

/** One line of the counts for a report: `3× PreToolUse P-052 "target <path> is outside the project"`; 'none' without entries. */
export function denialsLine(groups) {
  return groups.length ? groups.map((g) => `${g.n}× ${g.event}${g.principle ? ` ${g.principle}` : ''} "${g.kind}"`).join('; ') : 'none';
}
