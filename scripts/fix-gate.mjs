// Fix gate (P-075, agent-alice/D-0093): a topic made from a report or an issue (code without a thread: report intake,
// topic.mjs auto; its orchestrator recorded in topic.json) starts the fix only after its orchestrator agreed, because
// the orchestrator knows the state of the development of the workflow and the mail. The skill and the rule lead the
// thread (it asks by mail first); this module is the safety net: the hook refuses a write into the topic's code copy
// until the orchestrator answered "áno, relevantné", and after "nie, pracuje sa na novej verzii" it names the rejection.
// The answer is one call of the orchestrator: comms send --reply-to <id> --state hotovo --fix yes|no (or topic.mjs
// consent <id> --fix yes|no), recorded with the topic's consents (topics/<id>/consents.json, P-064).
import path from 'node:path';
import { readTopic, readConsents, grantConsent, topicOrchestrator } from './topic.mjs';
import { readHolder } from './brain.mjs';
import { WORKTREES_DIR } from './config.mjs';
import { isValidId } from './keys.mjs';

/** The two answers of the orchestrator, as the reply text says them. */
export const FIX_ANSWERS = Object.freeze({ yes: 'áno, relevantné', no: 'nie, pracuje sa na novej verzii' });
export const FIX_TOOL = 'fix';

/**
 * The topic needs the orchestrator's consent before its fix: `fix_gate: true` (recorded at create by the intake and
 * topic.mjs auto); a code topic from before the field that code created (an orchestrator, no creating thread) too.
 */
export function fixGated(topic) {
  if (!topic || typeof topic !== 'object') return false;
  if (typeof topic.fix_gate === 'boolean') return topic.fix_gate;
  return topic.kind === 'code' && !!topic.orchestrator?.topic && !topic.created_by;
}

/** The orchestrator's last answer about the fix of topic `id`: { decision: 'yes'|'no', by, at, id } or null. */
export function fixDecision(brainDir, id) {
  const last = readConsents(brainDir, id).filter((c) => c && c.tool === FIX_TOOL && (c.target === 'yes' || c.target === 'no')).pop();
  return last ? { decision: last.target, by: last.by || null, at: last.at || null, id: last.id } : null;
}

/** Records the orchestrator's answer (only the orchestrator of the topic may, P-064); returns the consent. */
export function grantFix(ctx, id, decision, { reason = null, origin = ctx } = {}) {
  if (!['yes', 'no'].includes(decision)) throw new Error(`--fix ${decision}: the answer is yes (${FIX_ANSWERS.yes}) or no (${FIX_ANSWERS.no})`);
  const topic = readTopic(ctx.brainDir, id);
  if (!topic) throw new Error(`topic ${id} does not exist (archived or never created)`);
  if (!fixGated(topic)) throw new Error(`topic ${id} has no fix gate (not made from a report or an issue): nothing to agree to`);
  return grantConsent(ctx, id, { tool: FIX_TOOL, target: decision, reason, origin }).consent;
}

/**
 * The topic whose code copy holds `abs`, or null: `<domain>/.worktrees/<repo>/<id>/...` or `../<project>-topics/<id>/...`.
 * `repo`: the repo folder of a domain worktree (null for a clone beside the project).
 */
export function copyTopicOf(ctx, abs) {
  const roots = [];
  if (ctx.domain?.root) roots.push({ root: path.join(ctx.domain.root, WORKTREES_DIR), depth: 2 });
  if (ctx.projectDir) roots.push({ root: path.join(path.dirname(ctx.projectDir), `${path.basename(ctx.projectDir)}-topics`), depth: 1 });
  for (const { root, depth } of roots) {
    const rel = path.relative(path.resolve(root), path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    if (parts.length < depth) continue;
    const id = parts[depth - 1];
    if (isValidId(id)) return { id, repo: depth === 2 ? parts[0] : null };
  }
  return null;
}

/** The mail address of the topic's orchestrator, for the text of a refusal. */
function orchestratorTo(brainDir, topic) {
  try { return topicOrchestrator(brainDir, topic, readHolder(brainDir, topic.id).thread || null)?.to || null; } catch { return null; }
}

export const FIX_ASK_REASON = (id, to) => `topic ${id} comes from a report or an issue: the fix starts only after its orchestrator (${to || 'the topic that created it'}) agrees, it knows the state of the development of the workflow and the mail. Ask now: comms send --level assist --to ${to || '<orchestrator>'} --text "fix ${id}: <what>, version <workflow/mail version>, cause <if known>"; meanwhile do only what needs no answer (verify the report, first comment of the issue). The orchestrator answers ${FIX_ANSWERS.yes} or ${FIX_ANSWERS.no} (comms send --reply-to <id> --state hotovo --fix yes|no); after yes the same write passes (P-075)`;
export const FIX_NO_REASON = (id) => `the orchestrator answered "${FIX_ANSWERS.no}" for topic ${id}: no fix of this version. Reject the report or issue with this reason and ask to report it again in the new version (reply to the report, comment on the issue), then close the topic with done --topic (P-075)`;

/**
 * Why a write into these paths is refused by the fix gate (P-075), or null: a path in the code copy of a gated topic
 * without the orchestrator's yes. Never throws (a hook check).
 */
export function fixGateRefusal(ctx, absPaths) {
  if (!ctx?.brainDir) return null;
  const seen = new Set();
  for (const abs of absPaths) {
    let hit;
    try { hit = copyTopicOf(ctx, abs); } catch { hit = null; }
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    let topic;
    try { topic = readTopic(ctx.brainDir, hit.id); } catch { topic = null; }
    if (!topic || !fixGated(topic)) continue;
    // Only the topic's own copy: a worktree of another repo with the same topic id is not judged here.
    if (hit.repo && topic.repo && hit.repo !== topic.repo) continue;
    const d = fixDecision(ctx.brainDir, hit.id);
    if (d?.decision === 'yes') continue;
    return d?.decision === 'no' ? FIX_NO_REASON(hit.id) : FIX_ASK_REASON(hit.id, orchestratorTo(ctx.brainDir, topic));
  }
  return null;
}
