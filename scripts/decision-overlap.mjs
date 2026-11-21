// A new decision against the valid ones (operator 2026-11-21: a decision of the operator cancelled a list that an agent's
// decision of the day before had set; both stayed valid, and the save named no older decision). After the write, save
// decision names the older valid decisions the new one contradicts or repeats; the saving agent reads them and marks the
// replaced ones (save.mjs decision --supersede ... --by ...). Nothing is refused (P-076).
// Two steps, as for a new topic (scripts/overlap.mjs): word stems pick the candidates, a cheap judge says which of them
// the new decision contradicts. Words alone do not tell: measured on the 141 decisions of a project (2026-11-21), 135
// saves had 5 older decisions with 5 shared stems, and no share or weight of the stems set the 7 known pairs apart from
// the rest; the related decision was among the first 5 by the count of shared stems for each pair (CANDIDATES has a margin).
// The count: stems of the new decision (title, choice, alternatives, reason) found in the title and choice of an older one.
// The cost (P-079): one call of the judge per saved decision that has a candidate, 6 to 15 s measured on that project;
// a decision without a candidate asks no judge.
import { stems } from './rule-gate.mjs';
import { askJudge } from './overlap.mjs';

export const OVERLAP_MIN = 5;
export const CANDIDATES = 8;
/** Candidates named by words when no judge ran. */
const UNJUDGED = 3;
export const validDecision = (d) => !d.status || d.status === 'valid';
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Title and choice of a saved decision (its body up to the rejected alternatives; a body in another form whole). */
const choice = (d) => `${d.title || d.name || ''} ${String(d.body || '').split(/\n\s*\*\*Zamietnuté alternatívy:\*\*/)[0]}`;

/** Valid decisions of `decisions` that share words with the new one ({ id, text }), best first: the records, with `shared`. */
export function overlappingDecisions(decisions, { id, text }, { limit = CANDIDATES, min = OVERLAP_MIN } = {}) {
  const mine = stems(text);
  const seen = new Set([id]);
  return decisions.filter((d) => d.id && validDecision(d) && !seen.has(d.id) && seen.add(d.id))
    .map((d) => { const theirs = stems(choice(d)); let shared = 0; for (const s of mine) if (theirs.has(s)) shared++; return { ...d, shared }; })
    .filter((d) => d.shared >= min).sort((a, b) => b.shared - a.shared || b.id.localeCompare(a.id)).slice(0, limit);
}

const named = (d, how = '') => `${d.id} "${oneLine(d.title || d.name, 80)}"${d.origin ? ` (${d.origin})` : ''}${how ? `: ${how}` : ''}`;
const STEP = (id, flags) => `read each one now (P-008): two valid decisions must not order different things. ${id} replaces one of them: mark it, save.mjs decision --supersede <D-NNNN>[,<D-NNNN>] --by ${id}${flags}; what of a replaced decision still holds must stand in ${id} or in a new decision. A decision of the operator is replaced only by a decision of the operator: in doubt ask (P-059). No conflict: nothing to do`;

/**
 * The line save decision prints after it wrote `decision` ({ id, title, text }): the valid decisions of `decisions` the
 * judge says it contradicts, cancels or repeats; without a judge the first candidates by words. null: nothing to read.
 * `flags`: options of the store for the command, e.g. ` --repo web`.
 */
export function decisionCheckLine(ctx, decisions, decision, { flags = '', ask = askJudge } = {}) {
  const candidates = overlappingDecisions(decisions, decision);
  if (!candidates.length) return null;
  const prompt = [
    'You compare a new decision of a project with its older valid decisions. Answer only with the JSON object.',
    'overlaps: the older decisions the new one contradicts or cancels, in whole or in part (they order different things for the same case; the new one removes, replaces or narrows what the older one sets), and the older decisions that already decide the same thing. Not a decision that only shares words or the field, and not one the new decision merely builds on. Ids exactly as given; how: one short sentence in the language of the decisions, starting with "conflict:" or "same choice:", naming what differs or repeats. Empty array when none.',
    '',
    '# Older valid decisions',
    ...candidates.map((d) => `## id: ${d.id}\n${oneLine(choice(d), 1500)}`),
    '',
    '# New decision',
    oneLine(decision.text, 3000),
  ].join('\n');
  const verdict = ask(ctx, prompt, candidates.map((d) => d.id));
  if (!verdict.ok) return `decision ${decision.id}: not compared with the older decisions (${verdict.cause}); valid decisions with the most words in common: ${candidates.slice(0, UNJUDGED).map((d) => named(d)).join(', ')}; ${STEP(decision.id, flags)}`;
  if (!verdict.overlaps.length) return null;
  return `decision ${decision.id} against the valid decisions (${verdict.overlaps.length}): ${verdict.overlaps.map((o) => named(candidates.find((d) => d.id === o.id), o.how)).join('; ')}; ${STEP(decision.id, flags)}`;
}
