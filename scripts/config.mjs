// Resolution of project, brain, policy and thread identity (P-024, P-017, P-038, P-047).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, writeJson, gitToplevel, git, isInside, realPathLoose } from './util.mjs';

export const WORKFLOW_CONFIG = '.workflow.json';
export const LOCAL_CONFIG = path.join('local', 'workflow.json');
export const PLUGIN_NAME = 'workflow';
export const PLUGIN_KEY = 'workflow@skills-dir';
// P-048 channels: stable = clone in ~/.claude/skills/workflow (skills-dir plugin, pinned release tag);
// dev = clone on branch dev loaded through CLAUDE_CODE_PLUGIN_DIRS (inline plugin). The project picks one
// in its committed .claude/settings.json; the other id is set to false so it never shadows or doubles.
export const PLUGIN_KEY_DEV = 'workflow@inline';
export const CHANNELS = ['stable', 'dev'];
export function enabledPluginsFor(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}; use ${CHANNELS.join(' or ')}`);
  return channel === 'dev' ? { [PLUGIN_KEY]: false, [PLUGIN_KEY_DEV]: true } : { [PLUGIN_KEY]: true, [PLUGIN_KEY_DEV]: false };
}
/** Channel of existing project settings, or null. */
export function channelOf(settings) {
  return settings?.enabledPlugins?.[PLUGIN_KEY_DEV] === true ? 'dev' : settings?.enabledPlugins?.[PLUGIN_KEY] === true ? 'stable' : null;
}
// P-024: a persona is a project whose repository is its brain (`"brain": "."`).
export const PERSONA_BRAIN = '.';
// Template entries of a brain; in a persona they are protected like `<brain>/**` (P-013, P-024).
export const BRAIN_ENTRIES = ['memory/**', 'decisions/**', 'rules/**', 'skills/**', 'topics/**', 'exceptions/**', 'logs/**', 'policy.json', '.githooks/**', '.gitattributes', '.gitignore', '.workflow.json', 'README.md'];
// P-052: work files of the agent; P-018: operator's local files. Writable in a persona.
export const SCRATCH_DIR = 'scratch';
// docs/: lasting documents of a persona (research, reports); written directly, committed by save.mjs docs (alice 2026-11-03).
export const PERSONA_DOCS = 'docs';
export const PERSONA_WRITABLE = [SCRATCH_DIR, 'local', PERSONA_DOCS];

/** Main checkout of the repository containing dir (never a worktree), P-024 persona. */
export function mainCheckout(dir) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  if (!r.ok) return path.resolve(dir);
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : path.resolve(dir);
}

/** Brain deny patterns for harness settings: `<brain>/x` -> `<brainRel>/x`; in a persona the template entries (P-024). */
export function expandBrainPath(p, brainRel) {
  if (!p.startsWith('<brain>')) return [p];
  if (!brainRel) return [];
  if (brainRel === PERSONA_BRAIN) return p === '<brain>/**' ? [...BRAIN_ENTRIES] : [p.slice('<brain>/'.length)];
  return [`${brainRel}${p.slice('<brain>'.length)}`];
}

/** True when abs lies in a directory a persona agent may write directly (scratch/, local/). */
export function personaWritable(ctx, abs) {
  return !!ctx.brainInfo?.persona && PERSONA_WRITABLE.some((d) => isInside(path.join(ctx.projectDir, d), abs));
}

export const BRAIN_COMMIT_TAG = '[brain-script]';
export const BRAIN_SCRIPT_ENV = 'WORKFLOW_BRAIN_SCRIPT';
/** Env for git in brain: script tag plus the root of the running plugin, so the brain hooks check with the same version (stable or dev). */
export function brainScriptEnv() {
  return { [BRAIN_SCRIPT_ENV]: '1', WORKFLOW_PLUGIN_ROOT: PLUGIN_ROOT };
}

/** Project root: explicit, CLAUDE_PROJECT_DIR, git toplevel of cwd, or cwd. */
/**
 * Target project of a command that generates the project's own files (adapter): --project, else the directory it runs in.
 * Neither CLAUDE_PROJECT_DIR nor WORKFLOW_PROJECT_DIR: SessionStart exports the session's project into every Bash command
 * (exportProjectDir), so a persona session editing another project would regenerate the persona (alice 2026-11-03: adapter
 * run in agentic-flow targeted alice). Brain commands keep resolveProject (they write to the persona's brain).
 */
export function resolveTargetProject(explicit) {
  if (explicit) return path.resolve(explicit);
  return gitToplevel(process.cwd()) || process.cwd();
}

export function resolveProject(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.WORKFLOW_PROJECT_DIR) return domainRootProject(path.resolve(process.env.WORKFLOW_PROJECT_DIR));
  if (process.env.CLAUDE_PROJECT_DIR) return domainRootProject(path.resolve(process.env.CLAUDE_PROJECT_DIR));
  return gitToplevel(process.cwd()) || process.cwd();
}

/**
 * A session whose project is a domain root (no WORKFLOW_CONFIG, only DOMAIN_MARKER) works in the domain brain's project.
 * Sessions started before a persona moved into its domain keep the old dir, which became the domain root (alice
 * 2026-11-04: ~/agentic/alice -> ~/agentic/alice/agent-alice; hook mail "comms unavailable", save "no brain configured").
 */
export function domainRootProject(dir) {
  if (fs.existsSync(path.join(dir, WORKFLOW_CONFIG))) return dir;
  const cfg = readJson(path.join(dir, DOMAIN_MARKER), null);
  if (!cfg || typeof cfg.brain !== 'string' || path.isAbsolute(cfg.brain)) return dir;
  const brain = path.resolve(dir, cfg.brain);
  return path.dirname(brain) === dir && fs.existsSync(path.join(brain, WORKFLOW_CONFIG)) ? brain : dir;
}

/** Read .workflow.json and local/workflow.json. Returns { brainRel, brain, source } or null when config is missing. */
export function resolveBrain(projectDir) {
  const localFile = path.join(projectDir, LOCAL_CONFIG);
  const mainFile = path.join(projectDir, WORKFLOW_CONFIG);
  let cfg = null;
  let source = null;
  if (fs.existsSync(localFile)) {
    cfg = readJson(localFile, {});
    source = LOCAL_CONFIG;
  }
  if (!cfg || typeof cfg.brain !== 'string') {
    if (fs.existsSync(mainFile)) {
      cfg = readJson(mainFile, {});
      source = WORKFLOW_CONFIG;
    }
  }
  if (!cfg || typeof cfg.brain !== 'string') return null;
  if (path.isAbsolute(cfg.brain) || /^[A-Za-z]:[\\/]/.test(cfg.brain)) {
    return { error: `absolute brain path is not allowed in ${source} (P-024)`, brainRel: cfg.brain, source };
  }
  if (cfg.brain.replace(/\/+$/, '') === PERSONA_BRAIN) return { brainRel: PERSONA_BRAIN, brain: mainCheckout(projectDir), source, persona: true };
  // Relative to the main checkout: in a topic worktree (`<domain>/.worktrees/<repo>/<id>`) `../<brain>` means the same brain.
  return { brainRel: cfg.brain, brain: path.resolve(mainCheckout(projectDir), cfg.brain), source };
}

/** Ensure <project>/.workflow.json exists with a relative brain path (P-024). Returns { brainInfo, written }. */
export const NO_BRAIN_NOTE = `no brain: project without its own brain (optional, P-024); topics and memory stay in the brain of the persona that manages it. Create one only on the operator's instruction: adapter.mjs <harness> --brain ../<name>, then brain-init.mjs ../<name> --project .`;

// A brain is optional (P-024): without --brain and without a configured one nothing is written and brainInfo is null
// (a project managed from a persona keeps its topics and memory in the persona's brain).
export function ensureWorkflowConfig(projectDir, brainRelArg = null) {
  let brainInfo = resolveBrain(projectDir);
  let written = false;
  if (brainRelArg || brainInfo?.error) {
    const rel = (brainRelArg || brainInfo.brainRel).replace(/\\/g, '/');
    if (path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) throw new Error('brain path must be relative to the project root (P-024)');
    // Other keys (comms) are kept; only brain is set.
    const current = readJson(path.join(projectDir, WORKFLOW_CONFIG), {});
    writeJson(path.join(projectDir, WORKFLOW_CONFIG), { ...(current && typeof current === 'object' ? current : {}), brain: rel });
    written = true;
    brainInfo = resolveBrain(projectDir);
  }
  return { brainInfo, written };
}

/** Merged workflow configuration: .workflow.json with local/workflow.json on top (shallow). Never throws. */
export function readWorkflowConfig(projectDir) {
  const main = readJson(path.join(projectDir, WORKFLOW_CONFIG), {});
  const local = readJson(path.join(projectDir, LOCAL_CONFIG), {});
  const cfg = { ...(main && typeof main === 'object' ? main : {}), ...(local && typeof local === 'object' ? local : {}) };
  return cfg;
}

export function brainExists(brainDir) {
  return !!brainDir && fs.existsSync(path.join(brainDir, 'topics')) && fs.existsSync(path.join(brainDir, '.git'));
}

export function loadPolicy(brainDir) {
  const base = readJson(path.join(PLUGIN_ROOT, 'policy', 'policy.json'));
  if (brainDir) {
    const extra = readJson(path.join(brainDir, 'policy.json'), {});
    return deepMerge(base, extra);
  }
  return base;
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

/** Stable thread identity (P-038). */
export function threadId() {
  return process.env.WORKFLOW_THREAD_ID || process.env.T3CODE_THREAD_ID || null;
}

/** Subagent detection for scripts started from the model's shell (P-025). Hooks pass agent_id explicitly. */
export function inSubagent() {
  return !!(process.env.WORKFLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID);
}

/**
 * Stable machine id (holder.json `machine`, logs/<machine>/, machine exceptions). The hostname at first use is kept in
 * ~/.config/agentic-flow/machine-id, so a later hostname change does not make this machine a stranger to its own topics.
 * WORKFLOW_MACHINE_ID overrides; WORKFLOW_MACHINE_FILE moves the file (tests, a second machine simulated on one host).
 */
export function machineName(env = process.env) {
  if (env.WORKFLOW_MACHINE_ID) return safeMachine(env.WORKFLOW_MACHINE_ID);
  const file = env.WORKFLOW_MACHINE_FILE || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', 'machine-id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (id) return safeMachine(id);
  } catch { /* first use */ }
  const id = safeMachine(os.hostname());
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${id}\n`); } catch { /* read-only home: hostname each time */ }
  return id;
}

/** A holder recorded on this machine (or without a machine, older records). */
export function sameMachine(name, env = process.env) {
  return !name || safeMachine(name) === machineName(env);
}

const safeMachine = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'machine';

// A thread id can hold characters Windows forbids in file names (`mcp:launch:…`, `thread:delegated-task:…`); the file
// name is encoded the way comms names turns/ (encodeURIComponent, plus `*`), so a UUID keeps its plain name.
const threadFileName = (id) => encodeURIComponent(String(id)).replace(/\*/g, '%2A');

/** Thread state file in <brain>/local/threads/<encoded id>.json (P-047 turn source, pending signals). */
export function threadStateFile(brainDir, id) {
  return path.join(brainDir, 'local', 'threads', `${threadFileName(id)}.json`);
}

// State written before v0.9.15 under the raw id (Linux, macOS); read once, the next write moves it to the encoded name.
function legacyThreadState(brainDir, id) {
  if (threadFileName(id) === String(id)) return null;
  try { return readJson(path.join(brainDir, 'local', 'threads', `${id}.json`), null); } catch { return null; }
}

export function readThreadState(brainDir, id) {
  if (!brainDir || !id) return { thread: id, turn_source: 'operator', pending_signals: [] };
  const state = readJson(threadStateFile(brainDir, id), null) || legacyThreadState(brainDir, id) || {};
  return { thread: id, turn_source: 'operator', pending_signals: [], ...state };
}

export function writeThreadState(brainDir, id, state) {
  if (!brainDir || !id) return;
  writeJson(threadStateFile(brainDir, id), { ...state, thread: id, updated: new Date().toISOString() });
}

export function isWakeTurn(brainDir, id) {
  return readThreadState(brainDir, id).turn_source === 'wake';
}

/**
 * Domain (v3, D-0002): the folder that bounds where agents write, ~/agentic/<domain>/. Its root holds DOMAIN_MARKER
 * (`{"brain": "<dir of the domain brain>"}`); the nearest marker above the project (also above a topic worktree inside
 * the domain) decides. Exceptions outside the domain come only from the domain brain policy
 * (`domain.allow_outside`: paths, `~/` allowed, and the word "sudo"). Returns null without a marker (not migrated yet).
 */
/**
 * Policy `domain.allow_outside`: the operator's explicit exceptions to the write boundary (D-0002): absolute or `~/`
 * paths (a filesystem root is ignored) and the word "sudo". Relative paths are ignored: they would depend on the cwd.
 */
export function allowOutside(policy, home = os.homedir()) {
  const allow = Array.isArray(policy?.domain?.allow_outside) ? policy.domain.allow_outside.filter((x) => typeof x === 'string') : [];
  const paths = allow.filter((x) => x !== 'sudo' && (x.startsWith('~/') || path.isAbsolute(x)))
    .map((x) => path.resolve(x.startsWith('~/') ? path.join(home, x.slice(2)) : x)).filter((x) => x !== path.parse(x).root);
  return { paths, sudo: allow.includes('sudo') };
}

export const DOMAIN_MARKER = '.agentic-domain';
/**
 * Folder name of a domain, the folder wrapping a persona's or a project's repositories: always with an upper case
 * first letter ("bob" -> "Bob", operator 2026-11-07). Repository names inside stay lower case (agent-bob, bob-brain).
 */
export function domainDirName(name) {
  const s = String(name || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Characters no folder name may hold on Windows (and the separators everywhere).
const BAD_DOMAIN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
/**
 * The domain folder name the operator chose (operator 2026-11-07: "a domain may have spaces, it is a folder name the
 * user picks"): any one folder name valid on Windows, macOS and Linux; spaces allowed.
 */
export function checkDomainName(domain) {
  const s = String(domain ?? '');
  if (!s.trim() || s === '.' || s === '..' || BAD_DOMAIN_CHARS.test(s) || /[ .]$/.test(s) || /^ /.test(s) || s.length > 100) {
    throw new Error(`domain must be one folder name (spaces allowed; not < > : " / \\ | ? *, no leading or trailing space, no trailing dot, at most 100 chars), got "${s}"`);
  }
  return s;
}
// A folder already used as a domain: its marker or a workflow project inside (not an old setup's own folder).
function heldDomain(dir) {
  if (fs.existsSync(path.join(dir, DOMAIN_MARKER))) return true;
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, WORKFLOW_CONFIG))); } catch { return false; }
}
const domainKey = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
/**
 * Domain folder of <name> under root. `domain` is the folder name the operator chose (spaces allowed); without it an
 * existing folder of the name in any case (older lower case domains are reused, not duplicated next to a capitalized
 * one; on Windows and macOS they are the same folder), then a domain (marker) whose name differs only in spaces and
 * dashes (`Home assistant` for home-assistant), else the capitalized name.
 */
export function domainDir(root, name, domain = null) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { /* root does not exist yet */ }
  if (domain) {
    const want = checkDomainName(domain);
    return path.join(root, entries.includes(want) ? want : entries.find((e) => e.toLowerCase() === want.toLowerCase()) || want);
  }
  const want = domainDirName(name);
  const found = entries.includes(want) ? want : entries.find((e) => e.toLowerCase() === want.toLowerCase())
    || entries.find((e) => domainKey(e) === domainKey(name) && heldDomain(path.join(root, e)));
  return path.join(root, found || want);
}
/** Code topic worktrees of a domain: `<domain>/.worktrees/<repo>/<topic>/` (hidden: every visible folder is a repo). */
export const WORKTREES_DIR = '.worktrees';
/** Installed releases the running services use (v3, D-0003): `~/services/<repo>/`; WORKFLOW_SERVICES_DIR for tests. */
export function servicesDir(env = process.env) {
  return env.WORKFLOW_SERVICES_DIR || path.join(env.HOME || os.homedir(), 'services');
}
export function resolveDomain(projectDir, home = os.homedir()) {
  for (let p = path.resolve(projectDir); ; p = path.dirname(p)) {
    const file = path.join(p, DOMAIN_MARKER);
    if (fs.existsSync(file)) {
      const cfg = readJson(file, {}) || {};
      const brain = typeof cfg.brain === 'string' && !path.isAbsolute(cfg.brain) ? path.resolve(p, cfg.brain) : null;
      const policy = brain ? readJson(path.join(brain, 'policy.json'), {}) || {} : {};
      const allow = allowOutside(policy, home);
      return { root: p, marker: file, brain, allowOutside: allow.paths, sudo: allow.sudo };
    }
    if (p === path.dirname(p)) return null;
  }
}

/** Full context for scripts: project, brain, policy, thread. */
/**
 * A brain command run from inside another workflow project with its own brain writes to the session's brain, because
 * the exported WORKFLOW_PROJECT_DIR wins over cwd (alice 2026-11-04: save from a client project wrote into the persona's
 * brain). Returns the reason to refuse, or null. An explicit --project decides; a dir whose brain is the same passes.
 */
export function foreignProjectCwd(ctx, explicit) {
  if (explicit || !ctx.brainDir) return null;
  const top = gitToplevel(process.cwd());
  if (!top || realPathLoose(top) === realPathLoose(ctx.projectDir)) return null;
  // cwd is another brain itself (a brain has no .workflow.json): brain.mjs write from <domain>/<x>-brain went to the
  // session's brain (alice 2026-11-07: path rewrite of other personas' brains wrote 11 files into agent-alice).
  if (brainExists(top) && realPathLoose(top) !== realPathLoose(ctx.brainDir)) {
    return `cwd is in brain ${path.basename(top)}, but the session's brain is ${path.basename(ctx.brainDir)}: this would write into ${path.basename(ctx.brainDir)}. Pass --project <the project whose brain is ${path.basename(top)}> to write there, or --project ${ctx.projectDir} (or run from the session dir) to write into ${ctx.projectName}`;
  }
  const info = resolveBrain(top);
  const other = info && !info.error ? info.brain : null;
  if (!other || !brainExists(other) || realPathLoose(other) === realPathLoose(ctx.brainDir)) return null;
  return `cwd is in project ${path.basename(top)} with its own brain, but the session project is ${ctx.projectName}: this would write into the brain of ${ctx.projectName}. Pass --project ${top} to write into ${path.basename(top)}, or --project ${ctx.projectDir} (or run from the session dir) to write into ${ctx.projectName}`;
}

export function loadContext({ project, requireBrain = true } = {}) {
  const projectDir = resolveProject(project);
  const brainInfo = resolveBrain(projectDir);
  const brainDir = brainInfo && !brainInfo.error ? brainInfo.brain : null;
  const ok = brainExists(brainDir);
  if (requireBrain && !ok) {
    const reason = !brainInfo
      ? `no brain configured for ${projectDir} (${WORKFLOW_CONFIG} without brain; optional, P-024)`
      : brainInfo.error || `brain not found at ${brainInfo.brainRel}`;
    throw new Error(`brain unavailable: ${reason}`);
  }
  return {
    projectDir,
    projectName: path.basename(projectDir),
    brainDir: ok ? brainDir : null,
    brainInfo,
    persona: !!brainInfo?.persona,
    config: readWorkflowConfig(projectDir),
    policy: loadPolicy(ok ? brainDir : null),
    thread: threadId(),
    pluginRoot: PLUGIN_ROOT,
    domain: resolveDomain(projectDir),
  };
}

export function pluginInstallDir() {
  return process.env.WORKFLOW_PLUGIN_ROOT || path.join(os.homedir(), '.claude', 'skills', PLUGIN_NAME);
}
