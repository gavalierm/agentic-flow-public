// Freeze during a rebuild (P-074, agent-alice/D-0092): while a new version of the workflow and the mail is being built,
// no work comes from issues or reports and nothing fixes the old version. The state lives in the brain policy
// (`<brain>/policy.json` key `freeze`, written by `brain.mjs freeze on|off`), so code enforces it, not a text:
//   { "reason": "<why>", "until": "<version that ends it>", "allow": ["<topic>", ...], "repos": ["<repo>", ...],
//     "since": "<iso>", "by": "<thread>" }
// The report intake rejects a report with a reply to the reporter (report again in the new version) instead of a topic;
// `topic create` of a code topic in a frozen repo is refused unless the topic is allowed (the work of the rebuild).

/** Repos a freeze covers when the policy names none: the workflow and the mail. */
export const FREEZE_REPOS = Object.freeze(['agentic-flow', 'agentic-comms']);

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);

/** The freeze of a policy, normalized, or null when none is on. */
export function freezeOf(policy) {
  const f = policy?.freeze;
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.on === false) return null;
  const repos = list(f.repos);
  return {
    reason: typeof f.reason === 'string' && f.reason.trim() ? f.reason.trim() : null,
    until: typeof f.until === 'string' && f.until.trim() ? f.until.trim() : null,
    allow: list(f.allow),
    repos: repos.length ? repos : [...FREEZE_REPOS],
    since: typeof f.since === 'string' ? f.since : null,
    by: typeof f.by === 'string' ? f.by : null,
  };
}

/** One line of the freeze for status output and refusals. */
export function freezeLine(f) {
  if (!f) return 'freeze: off';
  return `freeze: on until ${f.until || 'the new version'}${f.reason ? ` (${f.reason})` : ''}; repos ${f.repos.join(', ')}; allowed topics ${f.allow.join(', ') || 'none'}${f.since ? `; since ${f.since}` : ''}`;
}

const repoName = (repo) => String(repo || '').split('/').pop().replace(/\.git$/, '').toLowerCase();

/** A repo the freeze covers (by name, `-public` mirrors too). */
export function frozenRepo(f, repo) {
  if (!f || !repo) return false;
  const name = repoName(repo);
  return f.repos.some((r) => { const n = repoName(r); return name === n || name === `${n}-public`; });
}

/**
 * Why a new code topic `id` in `repo` is refused by the freeze of `policy`, or null (no freeze, not a frozen repo, an
 * allowed topic of the rebuild).
 */
export function freezeRefusal(policy, { id, repo }) {
  const f = freezeOf(policy);
  if (!f || !frozenRepo(f, repo) || f.allow.includes(String(id))) return null;
  return `topic ${id} refused: ${repoName(repo)} is frozen until ${f.until || 'the new version'}${f.reason ? ` (${f.reason})` : ''}; only the work of the rebuild runs (allowed topics: ${f.allow.join(', ') || 'none'}), a fix of the old version is not made: reject the report or issue with this reason and ask to report it again in the new version (P-074). The orchestrator allows a topic of the rebuild: brain.mjs freeze allow ${id}`;
}

/** The answer a reporter gets for a report (or an issue, `what`) rejected during the freeze (no topic, nothing fixed). */
export function freezeRejectText(f, messageId, what = 'Hlásenie') {
  const until = f?.until || 'nová verzia';
  return `${what} ${messageId} je odmietnuté: workflow a pošta sú zmrazené do verzie ${until}${f?.reason ? ` (${f.reason})` : ''}; stará verzia sa neopravuje a téma nevznikla (P-074). Ak chyba pretrvá vo verzii ${until}, nahlás ju znova${what === 'Hlásenie' ? ' (error.mjs report)' : ''}.`;
}
