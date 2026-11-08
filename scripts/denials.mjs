// Log of hook decisions (deny, ask, block) in <brain>/local/denials.jsonl (gitignored, per machine). Without it every
// false positive was found only by an interrupted agent and the rate was unknown (operator 2026-11-08, hooks review).
// Never throws: a log failure must not change a hook decision.
import fs from 'node:fs';
import path from 'node:path';

export const DENIALS_FILE = 'denials.jsonl';
const KEEP = 2000;
const SECRETISH = /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+_-]{40,})\b/g;

export const denialsFile = (brainDir) => path.join(brainDir, 'local', DENIALS_FILE);

const head = (s, n) => String(s || '').replace(/\s+/g, ' ').replace(SECRETISH, '<masked>').slice(0, n);

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
    const line = { t: now.toISOString(), event, decision, principle, cited, tool, thread, agent: agentType || null, input: tool ? inputHead(tool, toolInput) : null, reason: head(reason, 200) };
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
