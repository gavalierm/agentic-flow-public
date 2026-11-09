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

const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees', 'scratch', 'local']);
// Logs, decisions and reports record what happened at the old path; they stay as written.
const KEEP_AS_WRITTEN = [':!logs', ':!decisions', ':!docs/ai-news/reports'];

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
  const grep = spawnSync('git', ['-C', brain, 'grep', '-lF', ...forms.flatMap((f) => ['-e', f]), '--', '.', ...KEEP_AS_WRITTEN], { encoding: 'utf8' });
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
  try { policy = JSON.parse(fs.readFileSync(path.join(brain, 'policy.json'), 'utf8')); } catch { return []; }
  const list = Array.isArray(policy?.domain?.allow_outside) ? policy.domain.allow_outside : [];
  const abs = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, home));
  return list.filter((p) => typeof p === 'string' && p !== 'sudo' && isInside(abs(p), src));
}

/** Move the domain. Returns the report lines and the T3 steps the agent does with the T3 tool. */
export function moveDomain(domainDir, { root = machineRoot(), home = os.homedir(), trustFile = claudeConfigFile(), env = process.env, adapter = true } = {}) {
  const plan = planMove(domainDir, { root, home });
  const { src, dest } = plan;
  const lines = [];
  try { fs.renameSync(src, dest); } catch (err) {
    throw new Error(err.code === 'EXDEV' ? `${dest} is on another file system than ${src}; this script moves only within one file system` : err.message);
  }
  fs.symlinkSync(dest, src, 'dir');
  lines.push(`moved ${toPosix(src)} -> ${toPosix(dest)} (old path kept as a symlink for running threads and scripts)`);
  for (const h of plan.history) {
    const to = path.join(plan.historyDir, h.to);
    if (!fs.existsSync(to)) { fs.symlinkSync(h.from, to); lines.push(`history: ${h.to} -> ${h.from}`); }
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
  return { ...plan, lines, steps };
}

/**
 * After the T3 server restart on the new paths: the new history dirs become real, the old names symlinks to them.
 * Returns the report lines; idempotent.
 */
export function finishMove(oldDir, { home = os.homedir() } = {}) {
  const src = path.resolve(oldDir);
  if (!fs.lstatSync(src).isSymbolicLink()) throw new Error(`${src} is not the symlink of a moved domain`);
  const dest = path.resolve(path.dirname(src), fs.readlinkSync(src));
  const dir = path.join(home, '.claude', 'projects');
  const oldName = historyName(src); const newName = historyName(dest);
  const lines = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n === newName || n.startsWith(`${newName}-`)); } catch {}
  for (const n of names) {
    const p = path.join(dir, n);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    const o = path.resolve(dir, fs.readlinkSync(p));
    if (!fs.existsSync(o) || fs.lstatSync(o).isSymbolicLink()) { lines.push(`skip ${n}`); continue; }
    fs.rmSync(p); fs.renameSync(o, p); fs.symlinkSync(n, o);
    lines.push(`history: ${n} is the real folder, ${path.basename(o)} -> ${n}`);
  }
  if (!lines.length) lines.push(`history of ${toPosix(dest)}: nothing to swap`);
  lines.push(`the symlink ${toPosix(src)} stays while threads, scripts or services use the old path (${oldName})`);
  return lines;
}
