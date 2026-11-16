#!/usr/bin/env node
// Create or attach a brain repository from templates/brain (P-024, P-018, P-040).
//   brain-init.mjs <path> [--attach [--adopt]] [--remote <url>] [--project <dir>] [--persona] [--layout 1|2|3]
// --layout: data layout of a new brain (layout.mjs, D-0048): 3 (default, flow v2: templates/brain-3, topics/ and the
// records in the root, no outputs), 2 (templates/brain-2: .brain/, temy/, vystupy/) or 1 (templates/brain); an attach
// keeps the layout of the brain it attaches.
// --adopt: a brain from an older setup: its git hooks are replaced by the workflow ones, .gitignore gets the
// workflow lines, and the change is committed; data stays (the old hooks remain in the git history).
// --persona: the repository (remote and directory) must be named agent-<name>.
// --attach makes the git hooks executable; hooks git keeps as 100644 (a brain made on Windows) get 100755 in a brain
// script commit, so the brain stays clean. project.mjs connect and restore attach their brain the same way.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, copyDir, git, fail, parseArgs, exists } from '../scripts/util.mjs';
import { assertPersonaRemote, PERSONA_REPO_RE } from '../scripts/persona-name.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV, brainScriptEnv } from '../scripts/config.mjs';
import { dataPath, dataRel, dataLayoutVersion, layoutFor, DEFAULT_LAYOUT_VERSION, NEW_BRAIN_LAYOUT, layoutVersions, dataName, parseDataVersion } from '../scripts/layout.mjs';

const HOOKS = ['pre-commit', 'commit-msg'];

/**
 * Hooks git keeps as 100644 (a brain made on Windows, where git records no modes): the chmod of the attach made them
 * executable, so the brain showed them as changed and stayed dirty. The mode goes into git with a brain script commit,
 * only for hooks whose content and index are as in HEAD; core.fileMode false would only hide it. Where git records no
 * modes (Windows, core.fileMode false) nothing changes. Returns the hooks committed.
 */
function commitHookModes(brainDir, env) {
  if (process.platform === 'win32' || git(['config', '--type=bool', 'core.fileMode'], { cwd: brainDir }).stdout === 'false') return [];
  const rels = HOOKS.map((h) => `.githooks/${h}`).filter((rel) => /^100644 /.test(git(['ls-tree', 'HEAD', '--', rel], { cwd: brainDir }).stdout)
    && git(['diff', '--cached', '--quiet', 'HEAD', '--', rel], { cwd: brainDir }).ok
    && git(['-c', 'core.fileMode=false', 'diff', '--quiet', '--', rel], { cwd: brainDir }).ok);
  if (!rels.length) return [];
  const commit = git(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} brain template: git hooks executable (100755)`, '--', ...rels], { cwd: brainDir, env });
  if (!commit.ok) throw new Error(`git hooks mode commit failed: ${commit.stderr || commit.stdout}`);
  return rels.map((rel) => path.basename(rel));
}

/** Template folder of a data layout version: templates/brain (1), templates/brain-<v> (newer); an unknown version is an error. */
export function brainTemplate(version = DEFAULT_LAYOUT_VERSION) {
  const v = Number(version);
  layoutFor(v);
  return path.join(PLUGIN_ROOT, 'templates', v === 1 ? 'brain' : `brain-${v}`);
}

export function brainInit(target, { attach = false, adopt = false, remote = null, project = null, persona = false, layout = null } = {}) {
  const brainDir = path.resolve(target);
  if (layout !== null && layout !== undefined && parseDataVersion(layout) === null) throw new Error(`--layout must be a data version (${layoutVersions().map(dataName).join(', ')}), got "${layout}"`);
  if (persona) {
    if (!PERSONA_REPO_RE.test(path.basename(brainDir))) throw new Error(`persona directory must be named agent-<name>, got "${path.basename(brainDir)}"`);
    if (remote) assertPersonaRemote(remote);
  }
  const isGit = exists(path.join(brainDir, '.git'));
  const version = layout !== null && layout !== undefined ? parseDataVersion(layout) : (isGit ? dataLayoutVersion(brainDir) : NEW_BRAIN_LAYOUT);
  if (isGit && layout !== null && layout !== undefined && dataLayoutVersion(brainDir) !== version) throw new Error(`${brainDir} has data ${dataName(dataLayoutVersion(brainDir))}, not ${dataName(version)}; an attach keeps the data of the brain`);
  const template = brainTemplate(version);
  const env = brainScriptEnv();
  const created = [];
  const isRepo = exists(path.join(brainDir, '.git'));
  let attrsMigration = false;

  if (isRepo && !attach) throw new Error(`${brainDir} is already a git repository; use --attach to activate it`);
  if (!isRepo && attach) throw new Error(`${brainDir} is not a git repository; run without --attach to create it`);
  if (adopt && !attach) throw new Error('--adopt needs --attach');

  if (!isRepo) {
    if (exists(brainDir) && fs.readdirSync(brainDir).length) throw new Error(`${brainDir} exists and is not empty`);
    copyDir(template, brainDir, { filter: (p) => path.basename(p) !== 'README.md' || path.dirname(p) === template });
    const init = git(['init', '--quiet', '-b', 'main'], { cwd: brainDir });
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
    created.push('repository');
  } else {
    // Attach: an empty clone (remote HEAD pointed elsewhere) gets the main branch checked out first.
    if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: brainDir }).ok) {
      git(['fetch', '--quiet', 'origin'], { cwd: brainDir });
      if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: brainDir }).ok) {
        git(['checkout', '--quiet', '-B', 'main', 'origin/main'], { cwd: brainDir });
        created.push('checked out main');
      }
    }
    if (adopt) {
      fs.rmSync(path.join(brainDir, '.githooks'), { recursive: true, force: true });
      const ignore = path.join(brainDir, '.gitignore');
      if (exists(ignore)) {
        const have = new Set(fs.readFileSync(ignore, 'utf8').split('\n').map((l) => l.trim()));
        const add = fs.readFileSync(path.join(template, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !have.has(l));
        if (add.length) { fs.appendFileSync(ignore, `${fs.readFileSync(ignore, 'utf8').endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`); created.push('.gitignore: workflow lines added'); }
      }
    }
    // Older template line `* text eol=lf` marked images and fonts as text: a commit would rewrite their bytes.
    const attrs = path.join(brainDir, '.gitattributes');
    if (exists(attrs) && /^\* text eol=lf$/m.test(fs.readFileSync(attrs, 'utf8'))) {
      // Committed below: an uncommitted fix left every attached clone dirty and blocked its sync with origin (P-040).
      attrsMigration = git(['diff', '--quiet', 'HEAD', '--', '.gitattributes'], { cwd: brainDir }).ok;
      fs.writeFileSync(attrs, fs.readFileSync(attrs, 'utf8').replace(/^\* text eol=lf$/m, '* text=auto eol=lf'));
      created.push('.gitattributes: binary files kept as they are');
    }
    // Make sure template infrastructure exists without touching data.
    for (const rel of ['.githooks', '.gitattributes', '.gitignore']) {
      const src = path.join(template, rel);
      const dest = path.join(brainDir, rel);
      if (!exists(dest)) {
        if (fs.statSync(src).isDirectory()) copyDir(src, dest);
        else fs.copyFileSync(src, dest);
        created.push(rel);
      }
    }
    const map = layoutFor(version);
    for (const dir of [['memory'], ['decisions'], ['rules'], ['skills', 'operator'], ['skills', 'agentic'], ['topicArchive'], ['topics'], ['exceptions'], ['logs']]) {
      if (map[dir[0]] === null) continue;
      fs.mkdirSync(dataPath(brainDir, ...dir), { recursive: true });
    }
  }
  for (const hook of HOOKS) {
    try { fs.chmodSync(path.join(brainDir, '.githooks', hook), 0o755); } catch { /* windows */ }
  }
  const hooks = git(['config', 'core.hooksPath', '.githooks'], { cwd: brainDir });
  if (!hooks.ok) throw new Error(`git config failed: ${hooks.stderr}`);
  for (const dir of ['index', 'threads', 'log-buffer', 'outbox']) fs.mkdirSync(dataPath(brainDir, 'local', dir), { recursive: true });
  created.push(`${dataRel(brainDir, 'local')}/`);

  if (adopt) {
    git(['add', '--', '.githooks', '.gitattributes', '.gitignore'], { cwd: brainDir, env });
    if (!git(['diff', '--cached', '--quiet'], { cwd: brainDir }).ok) {
      const commit = git(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} adopt brain into the workflow: workflow git hooks`], { cwd: brainDir, env });
      if (!commit.ok) throw new Error(`adopt commit failed: ${commit.stderr || commit.stdout}`);
      created.push('committed workflow git hooks');
    }
  } else if (attrsMigration) {
    // Only the template line: other local edits of the file were not clean before, those stay uncommitted.
    git(['add', '--', '.gitattributes'], { cwd: brainDir, env });
    const commit = git(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} brain template: .gitattributes keeps binary files as they are`, '--', '.gitattributes'], { cwd: brainDir, env });
    if (!commit.ok) throw new Error(`.gitattributes commit failed: ${commit.stderr || commit.stdout}`);
    created.push('committed .gitattributes');
  }
  if (isRepo && !adopt) {
    const hooksFixed = commitHookModes(brainDir, env);
    if (hooksFixed.length) created.push(`committed git hooks as executable (100755): ${hooksFixed.join(', ')}`);
  }
  if (!isRepo) {
    git(['add', '-A'], { cwd: brainDir, env });
    const commit = git(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} init brain from workflow template`], { cwd: brainDir, env });
    if (!commit.ok) throw new Error(`initial commit failed: ${commit.stderr || commit.stdout}`);
  }
  if (remote) {
    git(['remote', 'remove', 'origin'], { cwd: brainDir });
    const add = git(['remote', 'add', 'origin', remote], { cwd: brainDir });
    if (!add.ok) throw new Error(`remote add failed: ${add.stderr}`);
    const push = git(['push', '--quiet', '-u', 'origin', 'main'], { cwd: brainDir });
    if (!push.ok) created.push(`remote set, push failed: ${push.stderr.split('\n')[0]}`);
    else created.push('pushed to origin');
  }
  if (project) {
    const localDir = dataPath(path.resolve(project), 'local');
    fs.mkdirSync(localDir, { recursive: true });
    created.push(`${path.resolve(project)}/${dataRel(path.resolve(project), 'local')}/`);
  }
  return { brainDir, created };
}

if ((process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) || process.argv[1]?.endsWith('brain-init.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const [target] = args._;
  if (!target) fail('usage: brain-init.mjs <path> [--attach [--adopt]] [--remote <url>] [--project <dir>] [--persona] [--layout 1|2.0|2.1]');
  try {
    const res = brainInit(target, { attach: !!args.attach, adopt: !!args.adopt, remote: args.remote || null, project: args.project || null, persona: !!args.persona, layout: args.layout ?? null });
    process.stdout.write(`brain ${args.attach ? 'attached' : 'created'}: ${res.brainDir}\n${res.created.map((c) => `- ${c}`).join('\n')}\n`);
  } catch (err) {
    fail(err.message);
  }
}
