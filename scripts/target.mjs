// Target repos and the target branch of a topic (flow v2 spec 4.5, 4.6, 4.1; plan B11, O12, O14, O18). A topic lists
// its target repos in `.tema.json` (`repos: { main, list }`); outputs and sources go to the main one. Without a list the
// default repo of the domain holds (`default_repo` in the policy of the domain brain, O18); a brain without one (the
// supervisor's) gives none, and a topic without a target repo has no outputs and no sources. Each repo names one target
// branch in its `.workflow.json` (`target_branch`, default `main`; O12: the one key, `knowledge_branch` is gone) and
// `target_protected: true` when only a human writes into it: non-code content then goes to `topic/<topic>--obsah` of
// the own clone, pushed, and done asks for the merge of both topic branches (gh when available, else the exact command,
// always an item in Úlohy pre operátora; O14).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, readJson } from './util.mjs';
import { BRAIN_COMMIT_TAG, brainScriptEnv, mainCheckout, readWorkflowConfig } from './config.mjs';
import { dataPath, dataRel, hasData, hasScratch } from './layout.mjs';
import { cloneWrite } from './own-clone.mjs';
import { INDEX_FILE, refreshIndex, refreshDeployIgnores } from './data-index.mjs';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';

/** Target branch of a repo without `target_branch` (spec 4.6). */
export const DEFAULT_TARGET_BRANCH = 'main';
/** Task name of the branch with the non-code content of a protected target branch: topic/<topic>--obsah (spec 4.6). */
export const CONTENT_TASK = 'obsah';
export const contentBranch = (id) => `topic/${id}--${CONTENT_TASK}`;
export const topicBranch = (id) => `topic/${id}`;

/** Target branch of a repo: `target_branch` of its .workflow.json, else main (O12: no other key is read). */
export function targetBranch(repoDir) {
  const b = readWorkflowConfig(repoDir).target_branch;
  return typeof b === 'string' && b.trim() ? b.trim() : DEFAULT_TARGET_BRANCH;
}

/** Only a human writes into the target branch of the repo (`target_protected: true`, spec 4.6). */
export const targetProtected = (repoDir) => readWorkflowConfig(repoDir).target_protected === true;

/**
 * Branch the non-code content of topic `id` is written to in a repo (spec 4.6): its target branch, or for a protected one
 * topic/<id>--obsah (started from the target branch). A protected repo without a topic is refused.
 */
export function contentTarget(repoDir, id) {
  const target = targetBranch(repoDir);
  if (!targetProtected(repoDir)) return { branch: target, target, protected: false };
  if (!id) throw new Error(`${path.basename(mainCheckout(repoDir))}: its target branch ${target} is protected (target_protected in .workflow.json), so non-code content goes to topic/<topic>--${CONTENT_TASK} of a topic this thread holds; hold the topic first, nothing written`);
  return { branch: contentBranch(id), target, protected: true };
}

/** Data layout 3 of a brain: no scratch and no outputs of its own (spec 4): triage by type into the target repo. */
export const hasTypeTriage = (brainDir) => !!brainDir && !hasScratch(brainDir) && !hasData(brainDir, 'docs');

/** `default_repo` of a brain policy (O18): the folder name of a repo of the domain; migrate --to 3 writes it in this form. */
export function defaultRepoName(policy) {
  const v = policy?.default_repo;
  return typeof v === 'string' && v.trim() ? path.basename(v.trim()) : null;
}

/** The default repo of the domain (O18): `default_repo` in the policy of the domain brain (the session brain without a domain). */
export function defaultRepo(ctx) {
  const brain = ctx?.domain?.brain || ctx?.brainDir;
  if (!brain) return null;
  let file;
  try { file = dataPath(brain, 'policy'); } catch { return null; }
  return defaultRepoName(readJson(file, {}));
}

/**
 * Target repos of a topic (spec 4.5): { main, list, from }; from = 'topic' (its .tema.json), 'default' (the default repo
 * of the domain) or 'none' (no target repo: no outputs, no sources).
 */
export function targetRepos(ctx, topic) {
  const list = Array.isArray(topic?.repos?.list) ? [...new Set(topic.repos.list.filter((r) => typeof r === 'string' && r))] : [];
  if (list.length) return { main: list.includes(topic.repos.main) ? topic.repos.main : list[0], list, from: 'topic' };
  const def = defaultRepo(ctx);
  return def ? { main: def, list: [def], from: 'default' } : { main: null, list: [], from: 'none' };
}

/** Checkout of a target repo by name: the repo of the domain, else the session's repo of that name; null when absent. */
export function targetRepoDir(ctx, name) {
  if (!name) return null;
  if (ctx?.domain?.root) {
    const dir = path.join(ctx.domain.root, name);
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  const main = ctx?.projectDir ? mainCheckout(ctx.projectDir) : null;
  return main && path.basename(main) === name && fs.existsSync(path.join(main, '.git')) ? main : null;
}

/** The main target repo of a topic as { name, dir }, or an error text (no target repo, or not on this machine). */
export function mainTargetRepo(ctx, topic) {
  const t = targetRepos(ctx, topic);
  if (!t.main) return { error: `topic ${topic?.id} has no target repo (no repos in its .tema.json and no default_repo in the policy of the domain brain, spec 4.5): a topic without a project has no outputs and no sources` };
  const dir = targetRepoDir(ctx, t.main);
  if (!dir) return { error: `target repo ${t.main} of topic ${topic?.id} is not on this machine (expected in the domain beside the brain)` };
  return { name: t.main, dir };
}

/**
 * Write non-code content (sources, outputs of the triage) into a target repo through the own clone of the workflow (spec
 * 4.1, 4.6): on its target branch, or on topic/<id>--obsah of a protected one (pushed, created from the target branch),
 * INDEX.md and the deploy ignore files in the same commit. ops: [{ path, content }] relative to the repo, or a function
 * (cloneDir) -> ops. Returns the cloneWrite result with { branch, target, protected }.
 */
export function contentWrite(ctx, repoDir, id, { ops, message }) {
  const where = contentTarget(repoDir, id);
  const env = brainScriptEnv();
  const res = cloneWrite(repoDir, {
    branch: where.branch,
    base: where.protected ? where.target : null,
    message: `${BRAIN_COMMIT_TAG} ${message}`,
    env,
    indexFiles: [INDEX_FILE],
    ops,
    index: (dir) => { refreshIndex(dir, env); refreshDeployIgnores(dir, env); },
  });
  return { ...res, ...where };
}

/** How a write result names where it went: `<branch>, pushed from the own clone` (+ the protected note). */
export function contentWhere(res) {
  if (!res?.committed) return `${res?.branch}, unchanged`;
  return `${res.branch}, pushed from the own clone of the workflow${res.protected ? `; target branch ${res.target} is protected: done asks for the merge of ${res.branch}` : ''}`;
}

/** The types of outputs a repo has (folders of vystupy/ on origin/<target>, else in its checkout). */
export function outputTypes(repoDir) {
  const root = dataRel(repoDir, 'outputs');
  const target = targetBranch(repoDir);
  const ref = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`], { cwd: repoDir }).ok ? `origin/${target}` : null;
  if (ref) {
    const ls = git(['ls-tree', '-d', '--name-only', `${ref}:${root}`], { cwd: repoDir });
    if (ls.ok) return ls.stdout.split('\n').filter(Boolean).sort();
  }
  try { return fs.readdirSync(dataPath(repoDir, 'outputs'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; }
}

/** A name of a type of outputs: lowercase letters, digits and hyphens (a folder of vystupy/, P-049). */
export const validType = (t) => typeof t === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(t);

/**
 * Content of an output with the topic in its header (spec 4: "téma v hlavičke súboru"): a markdown file gets the front
 * matter key `topic:` (an existing one is kept, other keys stay); another file has no header and is copied as it is.
 */
export function withTopicHeader(rel, content, id) {
  if (!/\.md$/i.test(rel)) return { content, header: false };
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  if (hasFrontmatter && data.topic) return { content: text, header: true };
  return { content: serializeFrontmatter({ topic: id, ...data }, body), header: true };
}

/** The branch is on origin of the repo (after a fetch by the caller). */
export const onOrigin = (repoDir, branch) => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repoDir }).ok;

/** The branch on origin is merged into origin/<target> (true also when it is not on origin: nothing to merge). */
export function mergedInto(repoDir, branch, target) {
  if (!onOrigin(repoDir, branch)) return true;
  return git(['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, `refs/remotes/origin/${target}`], { cwd: repoDir }).ok;
}

const GH = () => process.env.WORKFLOW_GH_CLI || 'gh';
const quote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * A request to merge `head` into `base` of a repo (O14): a pull request through gh when gh runs there (an open one for the
 * same head is reused), else the exact command for the operator. Returns { url, command, how }; url null without gh.
 */
export function mergeRequest(repoDir, { head, base, title, body }) {
  const command = `cd ${repoDir} && gh pr create --head ${head} --base ${base} --title ${quote(title)} --body ${quote(body)}`;
  const run = (args) => {
    const r = spawnSync(GH(), args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    return { ok: r.status === 0 && !r.error, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
  };
  if (!run(['--version']).ok) return { url: null, command, how: 'gh not available' };
  const open = run(['pr', 'view', head, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url']);
  if (open.ok && open.out) return { url: open.out.split('\n')[0], command, how: 'open pull request' };
  const made = run(['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body]);
  const url = made.ok ? (made.out.split('\n').find((l) => /^https?:\/\//.test(l.trim())) || made.out.split('\n')[0] || '').trim() : '';
  if (made.ok && url) return { url, command, how: 'pull request created' };
  return { url: null, command, how: `gh pr create failed (${(made.err || made.out).split('\n')[0] || 'no output'})` };
}
