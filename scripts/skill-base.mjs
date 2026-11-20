// Base of a skill save that replaces whole files (report 2026-11-20: two threads edited one skill from their own work
// copies; the second `save skill --replace`, 18 minutes after the first, replaced the whole skill and the first thread's
// changes left the brain and the deployed copy, found by chance in the history). A whole body (--replace) or a whole
// script (--script of an existing file) is saved only on top of the commits the saving thread knows: its own saves, or the
// commit it names with --base after it merged the others. An in-place edit (--sed) changes the current body, so it needs
// no base. The thread state keeps `skill_base[<name>]`: { seen: the commit the thread knows everything up to, own: its
// commits after it }.
import { git } from './util.mjs';
import { readThreadState, writeThreadState } from './config.mjs';

const OWN_MAX = 50;
const head = (brainDir, dir) => git(['log', '-1', '--format=%H', '--', dir], { cwd: brainDir, env: {} }).stdout || null;
const record = (brainDir, thread, name) => readThreadState(brainDir, thread).skill_base?.[name] || null;

/**
 * Commits of the skill folder `dir` the thread does not build on, newest first: [{ hash, at, subject }]. `base` is the
 * commit of --base; without it the thread's record decides, and a thread with no record counts the commits since `since`
 * (the time it took its topic: an older state it could only read). Throws when `base` is no commit of the brain.
 */
export function unseenSkillCommits(brainDir, thread, name, dir, { base = null, since = null } = {}) {
  const rec = record(brainDir, thread, name);
  const from = base || rec?.seen || null;
  if (!from && !since) return [];
  const r = git(['log', '--format=%H%x09%cI%x09%s', ...(from ? [`${from}..HEAD`] : [`--since=${since}`]), '--', dir], { cwd: brainDir, env: {} });
  if (!r.ok) throw new Error(base ? `--base ${base}: not a commit of the brain` : `git log of ${dir}: ${r.stderr.split('\n')[0]}`);
  const own = new Set(rec?.own || []);
  return r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, at, ...s] = l.split('\t'); return { hash, at, subject: s.join('\t') }; }).filter((c) => !own.has(c.hash));
}

/** The refusal of a whole save over commits the thread does not build on. */
export const UNSEEN_REASON = (name, dir, brainDir, commits, base) => `skill ${name}: ${commits.length} commit(s) changed it ${base ? `after your base ${base}` : 'that this thread did not save'}, and this save replaces whole files, so their changes would be lost: ${commits.slice(0, 5).map((c) => `${c.hash.slice(0, 7)} ${c.at.slice(0, 16)} ${c.subject.slice(0, 110)}`).join('; ')}${commits.length > 5 ? '; …' : ''}. Compare them with your content (git -C ${brainDir} diff ${commits[commits.length - 1].hash.slice(0, 7)}~..HEAD -- ${dir}), merge what yours lacks, then save again with --base ${commits[0].hash.slice(0, 7)}; nothing saved`;

/** After a save of the skill by this thread: a whole save makes the new commit the one it knows everything up to, a partial
 * one (--sed, a new script, the description) only adds its commit to the thread's own. */
export function recordSkillSave(brainDir, thread, name, dir, { whole }) {
  if (!brainDir || !thread) return;
  const now = head(brainDir, dir);
  if (!now) return;
  const state = readThreadState(brainDir, thread);
  const rec = state.skill_base?.[name] || null;
  const next = whole ? { seen: now, own: [] } : { ...(rec?.seen ? { seen: rec.seen } : {}), own: [...(rec?.own || []), now].slice(-OWN_MAX) };
  writeThreadState(brainDir, thread, { ...state, skill_base: { ...(state.skill_base || {}), [name]: next } });
}
