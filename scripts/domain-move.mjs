// Move a domain (persona or project folder with .agentic-domain) under the projects root of this machine (carol
// 2026-11-09: a persona was created in ~/agentic while the operator keeps domains elsewhere; the move by hand was refused
// by P-052 and nothing listed what else points at the old path). The steps follow the domain rename of 2026-11-07:
//   move: mv + symlink of the old path (running threads, absolute paths in scripts and services keep working), Claude
//         Code history (~/.claude/projects) under the new path as a symlink to the old one, trust entries
//         (~/.claude.json) copied, absolute paths in the tracked brain files rewritten through the brain writer (P-040),
//         the adapter in every project; the T3 projects are pointed at the new folder with the T3 tool (listed).
//   finish: after the T3 server restart, the new history dirs become the real ones and the old names symlinks (a
//         symlinked history dir of a running session breaks persisting tool results, 2026-11-07).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, toPosix, isInside } from './util.mjs';
import { DOMAIN_MARKER, WORKFLOW_CONFIG, machineRoot } from './config.mjs';
import { claudeConfigFile } from './t3-setup.mjs';
import { LAYOUT, dataPath, layoutFor } from './layout.mjs';

// Layout 2 (D-0048): the workflow data (.brain) and the topics with their work files (temy) hold no project either.
const L2 = layoutFor(2);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees', LAYOUT.scratch, LAYOUT.local, L2.policy.split('/')[0], L2.topics]);
// Logs, decisions and reports record what happened at the old path; they stay as written (the brain in either layout).
const KEEP_AS_WRITTEN = [':!logs', ':!decisions', ':!docs/ai-news/reports', `:!${L2.logs}`, `:!${L2.decisions}`];

/** The folder name Claude Code keeps the history of a project in (~/.claude/projects/<name>). */
export const historyName = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

/** Workflow projects inside a domain (folders with .workflow.json, two levels deep) and the brain of each. */
export function domainProjects(domain) {
  const found = [];
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, WORKFLOW_CONFIG))) {
      let brainRel = null;
      try { brainRel = JSON.parse(fs.readFileSync(path.join(dir, WORKFLOW_CONFIG), 'utf8')).brain || null; } catch {}
      found.push({ dir, brainRel, brain: brainRel ? path.resolve(dir, brainRel) : null });
    }
    if (depth >= 2) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.endsWith('-topics')) visit(path.join(dir, e.name), depth + 1);
  };
  visit(domain, 0);
  return found;
}

/** What a move would do, without doing it. Throws when the move is not possible. */
export function planMove(domainDir, { root = machineRoot(), home = os.homedir() } = {}) {
  if (!root) throw new Error('no projects root saved for this machine: the operator sets it with project.mjs root <dir>, or pass --to <dir>');
  const src = path.resolve(domainDir);
  if (!fs.existsSync(src)) throw new Error(`${src} does not exist`);
  if (fs.lstatSync(src).isSymbolicLink()) throw new Error(`${src} is a symlink (already moved?): give the real folder`);
  if (!fs.existsSync(path.join(src, DOMAIN_MARKER))) throw new Error(`${src} has no ${DOMAIN_MARKER}: not a domain`);
  const to = path.resolve(root);
  if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) throw new Error(`${to} is not a folder`);
  if (path.dirname(src) === to) throw new Error(`${src} already lies in ${to}`);
  if (isInside(src, to)) throw new Error(`${to} is inside the domain ${src}`);
  const dest = path.join(to, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  const historyDir = path.join(home, '.claude', 'projects');
  const oldName = historyName(src);
  let history = [];
  try { history = fs.readdirSync(historyDir).filter((n) => n === oldName || n.startsWith(`${oldName}-`)); } catch {}
  return { src, dest, projects: domainProjects(src), historyDir, history: history.map((n) => ({ from: n, to: historyName(dest) + n.slice(oldName.length) })) };
}

/** Copy the trust entries (~/.claude.json projects) of the old folders to the new ones. */
function copyTrust(src, dest, file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
  let added = 0;
  for (const key of Object.keys(j.projects || {})) {
    const abs = path.resolve(key);
    if (abs !== src && !isInside(src, abs)) continue;
    const nk = toPosix(path.join(dest, path.relative(src, abs)));
    if (!j.projects[nk]) { j.projects[nk] = j.projects[key]; added++; }
  }
  if (added) { fs.writeFileSync(`${file}.tmp`, JSON.stringify(j, null, 2)); fs.renameSync(`${file}.tmp`, file); }
  return added;
}

const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

/** Rewrite the old domain path in the tracked files of a brain, each file through brain.mjs write of its project. */
function rewriteBrain(project, brain, src, dest, home, env) {
  const forms = [toPosix(src)];
  if (isInside(home, src)) forms.push(`~/${toPosix(path.relative(home, src))}`);
  const destOf = (form) => (form.startsWith('~/') && isInside(home, dest) ? `~/${toPosix(path.relative(home, dest))}` : toPosix(dest));
  const grep = spawnSync('git', ['-c', 'core.quotepath=false', '-C', brain, 'grep', '-lF', ...forms.flatMap((f) => ['-e', f]), '--', '.', ...KEEP_AS_WRITTEN], { encoding: 'utf8' });
  const files = (grep.stdout || '').split('\n').filter(Boolean);
  const lines = [];
  for (const f of files) {
    let text = fs.readFileSync(path.join(brain, f), 'utf8');
    // Only whole path prefixes: <old>/..., <old>" or <old> at the end, not <old>-other.
    for (const form of forms) text = text.split(form).reduce((acc, part, i) => (i === 0 ? part : acc + (/^($|[/"'`\s),\]])/.test(part) ? destOf(form) : form) + part), '');
    const r = node([path.join(PLUGIN_ROOT, 'bin', 'brain.mjs'), 'write', f, '--project', project, '--stdin', '--message', `domain moved to ${toPosix(dest)}: absolute paths in ${f} (P-052)`], { input: text, cwd: project, env: { ...env, WORKFLOW_PROJECT_DIR: project } });
    lines.push(r.status === 0 ? `brain ${path.basename(brain)}: ${f} rewritten` : `brain ${path.basename(brain)}: ${f} NOT rewritten (${(r.stderr || r.stdout).trim().split('\n').pop()})`);
  }
  return lines;
}

/** Entries of domain.allow_outside that name the old root or the old domain: the operator decides about them. */
function oldAllowOutside(brain, src, home) {
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(dataPath(brain, 'policy'), 'utf8')); } catch { return []; }
  const list = Array.isArray(policy?.domain?.allow_outside) ? policy.domain.allow_outside : [];
  const abs = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, home));
  return list.filter((p) => typeof p === 'string' && p !== 'sudo' && isInside(abs(p), src));
}

// The move is a rename and then many steps (the link at the old path, the history links, trust, the brains, the
// adapters). A run that stopped after the rename had no way on: the old path was gone or a link ("give the real
// folder"), the new one "already lies in" the root, and finish found nothing (audit 2026-11-22). A note inside the
// domain folder travels with the rename and names both paths; a run that finds it does the steps after the rename again
// (each of them leaves what is done as it is).
const MOVE_NOTE = '.agentic-move.json';
const lexists = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false });

/** The plan of a move whose rename is done and whose other steps are not: found from the old path, the new one, or the root. */
function unfinishedMove(domainDir, { root, home }) {
  const given = path.resolve(domainDir);
  const places = [given, root ? path.join(path.resolve(root), path.basename(given)) : null].filter(Boolean);
  for (const place of places) {
    let note = null;
    try { note = JSON.parse(fs.readFileSync(path.join(place, MOVE_NOTE), 'utf8')); } catch { continue; }
    if (!note?.from || !note?.to || fs.realpathSync(place) !== fs.realpathSync(note.to)) continue;
    const src = path.resolve(note.from); const dest = path.resolve(note.to);
    const historyDir = path.join(home, '.claude', 'projects');
    const oldName = historyName(src);
    let history = [];
    try { history = fs.readdirSync(historyDir).filter((n) => (n === oldName || n.startsWith(`${oldName}-`)) && !fs.lstatSync(path.join(historyDir, n)).isSymbolicLink()); } catch {}
    const back = (p) => path.join(src, path.relative(dest, p));
    return { src, dest, resumed: true, projects: domainProjects(dest).map((p) => ({ ...p, dir: back(p.dir), brain: p.brain ? back(p.brain) : null })), historyDir, history: history.map((n) => ({ from: n, to: historyName(dest) + n.slice(oldName.length) })) };
  }
  return null;
}

/** Move the domain. Returns the report lines and the T3 steps the agent does with the T3 tool. */
export function moveDomain(domainDir, { root = machineRoot(), home = os.homedir(), trustFile = claudeConfigFile(), env = process.env, adapter = true } = {}) {
  const plan = unfinishedMove(domainDir, { root, home }) || planMove(domainDir, { root, home });
  const { src, dest } = plan;
  const lines = [];
  if (plan.resumed) lines.push(`a move ${toPosix(src)} -> ${toPosix(dest)} that stopped after its rename goes on`);
  else {
    fs.writeFileSync(path.join(src, MOVE_NOTE), `${JSON.stringify({ from: src, to: dest, at: new Date().toISOString() }, null, 2)}\n`);
    try { fs.renameSync(src, dest); } catch (err) {
      fs.rmSync(path.join(src, MOVE_NOTE), { force: true });
      throw new Error(err.code === 'EXDEV' ? `${dest} is on another file system than ${src}; this script moves only within one file system` : err.message);
    }
  }
  if (!lexists(src)) {
    try { fs.symlinkSync(dest, src, 'dir'); lines.push(`moved ${toPosix(src)} -> ${toPosix(dest)} (old path kept as a symlink for running threads and scripts)`); }
    catch (err) { lines.push(`moved ${toPosix(src)} -> ${toPosix(dest)}; the old path is NOT kept as a link (${err.code || err.message}): threads, scripts and services that use it need the new path`); }
  }
  for (const h of plan.history) {
    const to = path.join(plan.historyDir, h.to);
    if (lexists(to)) continue;
    try { fs.symlinkSync(h.from, to); lines.push(`history: ${h.to} -> ${h.from}`); } catch (err) { lines.push(`history: ${h.to} NOT linked to ${h.from} (${err.code || err.message})`); }
  }
  const trusted = copyTrust(src, dest, trustFile);
  lines.push(`trust: ${trusted} entries copied in ${toPosix(trustFile)}`);
  const steps = [];
  const brains = new Map();
  for (const p of plan.projects) {
    const dir = path.join(dest, path.relative(src, p.dir));
    const brain = p.brain ? path.join(dest, path.relative(src, p.brain)) : null;
    if (brain && isInside(dest, brain) && !brains.has(brain)) brains.set(brain, dir);
    steps.push(`t3_project_update (project with workspaceRoot ${toPosix(p.dir)}): workspaceRoot ${toPosix(dir)}`);
  }
  for (const [brain, project] of brains) {
    lines.push(...rewriteBrain(project, brain, src, dest, home, env));
    const old = oldAllowOutside(brain, src, home);
    if (old.length) lines.push(`brain ${path.basename(brain)}: policy domain.allow_outside still allows ${old.join(', ')} (the old place); the operator removes it when the old path is not needed`);
  }
  if (adapter) {
    for (const p of plan.projects) {
      const dir = path.join(dest, path.relative(src, p.dir));
      const r = node([path.join(PLUGIN_ROOT, 'bin', 'adapter.mjs'), 'claude-code', ...(p.brainRel ? ['--brain', p.brainRel] : [])], { cwd: dir, env: { ...env, WORKFLOW_PROJECT_DIR: dir } });
      lines.push(`adapter ${path.basename(dir)}: ${r.status === 0 ? 'settings regenerated' : `FAILED (${(r.stderr || r.stdout).trim().split('\n').pop()})`}`);
    }
  }
  fs.rmSync(path.join(dest, MOVE_NOTE), { force: true });
  return { ...plan, lines, steps, linked: lexists(src) };
}

/**
 * After the T3 server restart on the new paths: the new history dirs become real, the old names symlinks to them.
 * Returns the report lines; idempotent.
 */
export function finishMove(oldDir, { home = os.homedir(), to = null } = {}) {
  const src = path.resolve(oldDir);
  const link = fs.lstatSync(src, { throwIfNoEntry: false });
  // A move that could not keep the old path as a link has no link to read the new place from: the caller names it.
  if (!link?.isSymbolicLink() && !(to && !link)) throw new Error(`${src} is not the symlink of a moved domain${link ? '' : ': it does not exist; when the move kept no link, name the new place: finish <old domain path> --to <new domain path>'}`);
  const dest = link ? path.resolve(path.dirname(src), fs.readlinkSync(src)) : path.resolve(to);
  const dir = path.join(home, '.claude', 'projects');
  const oldName = historyName(src); const newName = historyName(dest);
  const lines = [];
  // One swap: the real folder of the old name becomes the real folder of the new name, the old name a link to it. The
  // folder waits as <new name>.moving between the parts: a swap that stopped left the history at neither name the new
  // path reads, and the next finish said "nothing to swap" (audit 2026-11-22). Every state a stop leaves is finished here.
  const of = (n, prefix) => n === prefix || n.startsWith(`${prefix}-`);
  const swap = (n) => {
    const p = path.join(dir, n); const o = path.join(dir, oldName + n.slice(newName.length)); const moving = `${p}.moving`;
    const real = (x) => { const st = fs.lstatSync(x, { throwIfNoEntry: false }); return !!st && st.isDirectory() && !st.isSymbolicLink(); };
    if (real(p) && !lexists(moving)) { if (!lexists(o)) fs.symlinkSync(n, o); return false; }
    if (!lexists(moving)) { if (!real(o)) return false; fs.renameSync(o, moving); }
    if (!lexists(o)) fs.symlinkSync(n, o);
    if (lexists(p)) fs.rmSync(p);
    fs.renameSync(moving, p);
    lines.push(`history: ${n} is the real folder, ${path.basename(o)} -> ${n}`);
    return true;
  };
  let all = [];
  try { all = fs.readdirSync(dir); } catch {}
  // The names to look at: the links of the move, a folder left as .moving, and a real folder under the old name (a swap
  // an older version left half done, or a session that ran through the link of the old path).
  const names = new Set([
    ...all.filter((n) => of(n, newName) && !n.endsWith('.moving')),
    ...all.filter((n) => n.endsWith('.moving') && of(n.slice(0, -7), newName)).map((n) => n.slice(0, -7)),
    ...all.filter((n) => of(n, oldName) && !of(n, newName)).map((n) => newName + n.slice(oldName.length)),
  ]);
  for (const n of names) { try { swap(n); } catch (err) { lines.push(`history: ${n} NOT swapped (${err.code || err.message}); run finish again`); } }
  if (!lines.length) lines.push(`history of ${toPosix(dest)}: nothing to swap`);
  if (link) lines.push(`the symlink ${toPosix(src)} stays while threads, scripts or services use the old path (${oldName})`);
  return lines;
}
