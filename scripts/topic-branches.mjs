// Topic branches with work on paths of an older data layout (a shop repo 2026-11-16): a migration moves only the target
// branch; a branch of an open topic forked before it keeps adding files in materialy/, docs/ … and done --topic would
// merge a folder the data of the repo no longer knows. The check and the session check list them; done refuses the merge.
import { git, GIT_PATHS } from './util.mjs';
import { dataLayoutVersion, layoutRole, ROLE_REPO } from './layout.mjs';
import { oldFolders } from './leftovers.mjs';
import { targetBranch } from './target.mjs';

const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

/** Top folders of older layouts a repository of this version must not get (folders reported as leftovers). */
function oldTops(dir) {
  const v = dataLayoutVersion(dir);
  if (v !== 2 && v !== 3) return [];
  let role = ROLE_REPO;
  try { role = layoutRole(dir); } catch { /* repo */ }
  return oldFolders(v, role).filter((f) => f.report).map((f) => f.rel);
}

/**
 * Files `from` adds or changes since it forked from `into` (refs as git reads them, e.g. origin/topic/x) on paths of an
 * older layout, grouped by their folder (two levels): [{ folder, files }].
 */
export function oldLayoutWork(dir, from, into) {
  const tops = oldTops(dir);
  if (!tops.length) return [];
  const r = git([...GIT_PATHS, 'diff', '--name-only', '-z', '--diff-filter=ACMR', `${into}...${from}`], { cwd: dir });
  if (!r.ok) return [];
  const groups = new Map();
  for (const rel of r.stdout.split('\0').filter(Boolean)) {
    const top = tops.find((t) => under(rel, t));
    if (!top) continue;
    const rest = rel.slice(top.length + 1).split('/');
    const folder = rest.length > 1 ? `${top}/${rest[0]}/` : `${top}/`;
    groups.set(folder, (groups.get(folder) || 0) + 1);
  }
  return [...groups].map(([folder, files]) => ({ folder, files }));
}

const text = (work) => work.map((w) => `${w.folder} (${w.files} file(s))`).join(', ');

/** The advice for such a branch: where its files go in the data of the repo. */
export const MOVE_HINT = 'move them on the branch (git mv in the topic worktree: sources to zdroje/<tema>/, finished works to vystupy/<typ>/, work files to the work folder of the topic in the brain), commit, push';

/**
 * Topic branches of a repository (local topic/* and origin/topic/*) whose own work is on paths of an older layout:
 * lines for a check, with the commits ahead and the fix. into: the branch they merge into (origin/<target> when known).
 */
export function topicBranchProblems(dir, into) {
  const refs = git(['for-each-ref', '--format=%(refname)', 'refs/heads/topic/', 'refs/remotes/origin/topic/'], { cwd: dir });
  if (!refs.ok) return [];
  const seen = new Map();
  for (const ref of refs.stdout.split('\n').filter(Boolean)) {
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    // The local branch wins (it has the newest work of this machine).
    if (!seen.has(name) || ref.startsWith('refs/heads/')) seen.set(name, ref);
  }
  const out = [];
  for (const [name, ref] of seen) {
    if (git(['merge-base', '--is-ancestor', ref, into], { cwd: dir }).ok) continue;
    const work = oldLayoutWork(dir, ref, into);
    if (!work.length) continue;
    const ahead = git(['rev-list', '--count', `${into}..${ref}`], { cwd: dir }).stdout || '?';
    out.push(`branch ${name} (${ahead} commit(s) not in ${into.replace(/^origin\//, '')}): work on paths of an older data layout, ${text(work)}; done --topic refuses to merge it: ${MOVE_HINT}`);
  }
  return out;
}

/** The refusal of done --topic for a branch with such work, or null. */
export function mergeRefusal(dir, from, into) {
  const work = oldLayoutWork(dir, from, into);
  return work.length ? `${from.replace(/^origin\//, '')} adds files on paths of an older data layout, ${text(work)}; nothing merged: ${MOVE_HINT}, then run done again` : null;
}

/** The ref topic branches merge into: origin/<target branch> when origin has it, else the local branch. */
export function mergeTarget(dir) {
  const t = targetBranch(dir);
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${t}`], { cwd: dir }).ok ? `origin/${t}` : t;
}

/** topicBranchProblems against the target of the repository. */
export const branchProblems = (dir) => { try { return topicBranchProblems(dir, mergeTarget(dir)); } catch { return []; } };
