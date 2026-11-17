// Decisions and the skills that carry them out (report 2026-11-17, a project thread: a thread confirmed a skill consistent with the
// decisions, but the check covered only the decisions the skill cites; a valid decision of another topic of the same brain
// set another form of the skill's output, and it never reached the thread of the skill). Nothing is refused (P-076): save
// skill names the valid decisions whose subject the skill covers and does not cite, save decision names the skills it may
// bind. The match is the share of the decision's word stems found in the skill (scripts/rule-gate.mjs stems).
import { readDecisions, readSkills } from './records.mjs';
import { stems } from './rule-gate.mjs';

export const MIN_SHARE = 0.6;
const MIN_STEMS = 8;
const valid = (d) => !d.status || d.status === 'valid';
const decisionStems = (d) => stems(`${d.title || d.name} ${d.body}`);
const cites = (text, id) => !!id && new RegExp(`(^|[^\\w-])${id}($|[^\\w-])`).test(String(text || ''));

function share(ds, skillStems) {
  if (ds.size < MIN_STEMS) return 0;
  let n = 0;
  for (const s of ds) if (skillStems.has(s)) n++;
  return n / ds.size;
}

/** Valid decisions the skill text covers and does not cite: [{ id, title, share }], best first. */
export function uncitedDecisions(brainDir, skillText, { limit = 10, min = MIN_SHARE } = {}) {
  const sk = stems(skillText);
  return readDecisions(brainDir).filter((d) => valid(d) && d.id && !cites(skillText, d.id))
    .map((d) => ({ id: d.id, title: d.title || d.name, share: share(decisionStems(d), sk) }))
    .filter((d) => d.share >= min).sort((a, b) => b.share - a.share).slice(0, limit);
}

/** Skills a decision may bind (its subject is in their text) and that do not cite it: [{ name, path, share }], best first. */
export function boundSkills(brainDir, decision, { limit = 5, min = MIN_SHARE } = {}) {
  const ds = stems(`${decision.title || ''} ${decision.body || ''}`);
  return readSkills(brainDir).filter((s) => !cites(s.body, decision.id))
    .map((s) => ({ name: s.skillName, path: s.path, share: share(ds, stems(`${s.description} ${s.body}`)) }))
    .filter((s) => s.share >= min).sort((a, b) => b.share - a.share).slice(0, limit);
}

export const uncitedLine = (rows) => (rows.length ? `decisions of this brain the skill covers and does not cite (${rows.length}): ${rows.map((d) => `${d.id} "${String(d.title).slice(0, 70)}"`).join(', ')}; before calling the skill consistent with the decisions, find for each its place in the skill text or code or the conflict, and cite the decision where the skill carries it out (P-008)` : null);
export const boundLine = (id, rows) => (rows.length ? `skills ${id} may bind (${rows.length}): ${rows.map((s) => `${s.name} (${s.path})`).join(', ')}; check that each carries it out, and tell the topic that edits one of them (workflow:comms) (P-008)` : null);
