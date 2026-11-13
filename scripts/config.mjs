// Resolution of project, brain, policy and thread identity (P-024, P-017, P-038, P-047).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, writeJson, gitToplevel, git, isInside, realPathLoose, toPosix } from './util.mjs';
import { tightenPolicy } from './policy-layers.mjs';

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

// The folder of this machine's projects (domains) as the operator chose it (carol 2026-11-09: the operator keeps domains in
// another folder, the persona was created in ~/agentic and its move was refused by P-052; the choice was stored nowhere).
// One line in ~/.config/agentic-flow/projects-root, written by `project.mjs root <dir>` or by the first explicit --root.
export const ROOT_FILE = 'projects-root';
export const rootFile = (env = process.env) => env.WORKFLOW_ROOT_FILE || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', ROOT_FILE);

/** The projects root saved for this machine, or null. */
export function machineRoot(env = process.env) {
  try {
    const dir = fs.readFileSync(rootFile(env), 'utf8').trim();
    return dir ? path.resolve(dir.replace(/^~(?=$|[\\/])/, env.HOME || os.homedir())) : null;
  } catch { return null; }
}

/** Save the projects root of this machine; the folder must exist. Returns the saved absolute path. */
export function setMachineRoot(dir, env = process.env) {
  const abs = path.resolve(String(dir).replace(/^~(?=$|[\\/])/, env.HOME || os.homedir()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder`);
  const file = rootFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${abs}\n`);
  return abs;
}
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
// Brain layout of the workflow template (P-024).
const BRAIN_MARKS = ['topics', 'logs', 'exceptions'];
// Files of older agent setups: rules and memory kept outside the workflow brain format.
const LEGACY_MARKS = ['RULES.md', 'CLAUDE.md', 'AGENTS.md', 'errors', 'artifacts', 'agentic-brain'];

export function checkName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`project name must be lowercase letters, digits and dashes (3-50 chars), got "${name}"`);
  return name;
}

/** Kind of a repository from the names in its root: workflow-project, workflow-brain, legacy, code, empty. */
export function classifyNames(names) {
  const set = new Set(names);
  if (!names.length) return 'empty';
  if (set.has(WORKFLOW_CONFIG)) return 'workflow-project';
  if (set.has('.githooks') && BRAIN_MARKS.every((m) => set.has(m))) return 'workflow-brain';
  if (LEGACY_MARKS.some((m) => set.has(m))) return 'legacy';
  return 'code';
}

function localNames(dir) {
  try { return fs.readdirSync(dir).filter((n) => n !== '.git' && n !== 'local'); } catch { return []; }
}

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

/** Name for matching: case, spaces, dashes and underscores ignored ("Home assistant" = "home-assistant"). */
export const matchKey = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Folder holding the projects of the session's machine, from the session project: <root>/<name>/<repo> next to
 * <root>/<name>/<name>-brain, else the older flat <root>/<repo> (operator 2026-11-07: a Windows instance keeps its
 * projects in "D:\Claude projekty", probe looked only in ~/agentic and reported nothing).
 */
export function sessionRoot(projectDir, brainDir) {
  if (!projectDir) return null;
  const proj = path.resolve(projectDir);
  const parent = path.dirname(proj);
  const brain = brainDir ? path.resolve(brainDir) : null;
  // The domain may be a chosen folder name with spaces (`Home assistant` holding home-assistant-brain).
  const nested = brain && brain !== proj && path.dirname(brain) === parent && (path.basename(brain).toLowerCase().startsWith(`${path.basename(parent).toLowerCase()}-`)
    || matchKey(path.basename(brain).replace(/-brain$/i, '')) === matchKey(path.basename(parent)));
  return nested ? path.dirname(parent) : parent;
}
// docs/: lasting documents of a persona (research, reports); written directly, committed by save.mjs docs (alice 2026-11-03).
export const PERSONA_DOCS = 'docs';
// materialy/: what came from outside and the results of a topic (skill materialy), committed by save.mjs docs like docs/
// (D-0011: 2 refusals on 11-11, the result stayed outside git). A literal here: materialy.mjs imports this module.
export const PERSONA_MATERIALS = 'materialy';
export const PERSONA_WRITABLE = [SCRATCH_DIR, 'local', PERSONA_DOCS, PERSONA_MATERIALS];

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
  // The domain (D-0025), relative to the main checkout like brain: a code topic copy finds the same one. A "domain" that
  // does not match the domain found above the project throws here (resolveDomain), so the adapter stops with both paths.
  const file = path.join(projectDir, WORKFLOW_CONFIG);
  if (fs.existsSync(file)) {
    const domain = resolveDomain(projectDir);
    const current = readJson(file, {});
    if (domain && current && typeof current === 'object' && typeof current.domain !== 'string') {
      writeJson(file, { ...current, domain: toPosix(path.relative(mainCheckout(projectDir), domain.root)) || '.' });
      written = true;
    }
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

/** Policy of one brain: the plugin policy with `<brain>/policy.json` merged over it (brain-level commands, the domain brain). */
export function loadPolicy(brainDir) {
  const base = readJson(path.join(PLUGIN_ROOT, 'policy', 'policy.json'));
  if (brainDir) {
    const extra = readJson(path.join(brainDir, 'policy.json'), {});
    return deepMerge(base, extra);
  }
  return base;
}

const samePath = (a, b) => !!a && !!b && realPathLoose(a) === realPathLoose(b);
// Literal: repo-knowledge.mjs (PROJECT_KNOWLEDGE) imports this module.
const REPO_KNOWLEDGE_DIR = 'agentic';

/**
 * Layers of a project's policy, rules and skills (D-0016, D-0025). In a domain whose brain exists: the domain brain, the
 * project's own brain when it is another one, and the repo of the session (`<repo>/agentic/`, the checkout it runs in,
 * a code topic copy included) when the project is a repo of the domain and not a brain. Outside a domain (or without its
 * brain) inDomain is false and the project's brain is the only layer, as before.
 */
export function policyLayers({ projectDir, brainDir = null, domain = null }) {
  if (!domain?.brain || !brainExists(domain.brain)) return { inDomain: false, domainBrain: null, projectBrain: null, repo: null };
  const projectBrain = brainDir && !samePath(brainDir, domain.brain) ? brainDir : null;
  let repo = null;
  if (projectDir) {
    const main = mainCheckout(projectDir);
    if (!samePath(main, domain.brain) && !samePath(main, brainDir) && samePath(path.dirname(main), domain.root)) {
      repo = { name: path.basename(main), dir: path.resolve(projectDir), knowledge: path.join(path.resolve(projectDir), REPO_KNOWLEDGE_DIR) };
    }
  }
  return { inDomain: true, domainBrain: domain.brain, projectBrain, repo };
}

/**
 * Policy of a project (D-0025): plugin -> domain brain (merged) -> project layer (its own brain's policy.json when it is
 * not the domain brain, then `<repo>/agentic/policy.json`), the project layer only tightening (tightenPolicy). Outside a
 * domain: plugin -> project brain, as loadPolicy. Returns { policy, ignored: [{ key, why, source }], layers }.
 */
export function projectPolicy({ projectDir, brainDir = null, domain = null, layers = policyLayers({ projectDir, brainDir, domain }) }) {
  if (!layers.inDomain) return { policy: loadPolicy(brainDir), ignored: [], layers };
  let policy = loadPolicy(layers.domainBrain);
  const ignored = [];
  const files = [];
  if (layers.projectBrain) files.push({ file: path.join(layers.projectBrain, 'policy.json'), source: `${path.basename(layers.projectBrain)}/policy.json` });
  if (layers.repo) files.push({ file: path.join(layers.repo.knowledge, 'policy.json'), source: `${layers.repo.name}/${REPO_KNOWLEDGE_DIR}/policy.json` });
  for (const { file, source } of files) {
    if (!fs.existsSync(file)) continue;
    const layer = readJson(file, null);
    if (layer === null) { ignored.push({ key: '(file)', why: 'not valid JSON', source }); continue; }
    const res = tightenPolicy(policy, layer);
    policy = res.policy;
    ignored.push(...res.ignored.map((i) => ({ ...i, source })));
  }
  return { policy, ignored, layers };
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

/** A model harness runs this process (Claude Code sets CLAUDECODE in its shell, Codex its CODEX_* variables); cron does not. */
export function inHarness(env = process.env) {
  return !!(env.CLAUDECODE || env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID);
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

/** The operator answered a dialog (AskUserQuestion) in the running turn (PostToolUse sets dialog_answered_at, D-0011). */
export function dialogAnsweredInTurn(brainDir, id) {
  const st = readThreadState(brainDir, id);
  return !!st.dialog_answered_at && !!st.turn_started_at && st.dialog_answered_at >= st.turn_started_at;
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
/**
 * The domain of a project (D-0002). `"domain"` in .workflow.json (written by the adapter, D-0025) decides first: relative
 * to the main checkout like brain, so a code topic copy (`<domain>/.worktrees/<repo>/<id>`) finds the same domain. A
 * "domain" folder without DOMAIN_MARKER, or one that is not the domain found above the project, throws with both paths;
 * `{ field: false }` skips the field (a hook keeps the domain above the project and reports the error instead).
 */
export function resolveDomain(projectDir, home = os.homedir(), { field = true } = {}) {
  const up = domainAbove(projectDir, home);
  const rel = field ? readWorkflowConfig(projectDir).domain : undefined;
  if (typeof rel !== 'string' || !rel.trim()) return up;
  const cfgFile = path.join(projectDir, WORKFLOW_CONFIG);
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) throw new Error(`absolute domain path "${rel}" is not allowed in ${cfgFile}; it is relative to the project like brain (P-024)`);
  const root = path.resolve(mainCheckout(projectDir), rel);
  const above = up ? `the domain found above the project is ${up.root}` : `no ${DOMAIN_MARKER} lies above the project`;
  if (!fs.existsSync(path.join(root, DOMAIN_MARKER))) throw new Error(`domain "${rel}" in ${cfgFile} is ${root}, which has no ${DOMAIN_MARKER}; ${above}: fix "domain" in ${WORKFLOW_CONFIG} (D-0025)`);
  if (!up || !samePath(up.root, root)) throw new Error(`domain "${rel}" in ${cfgFile} is ${root}, but ${above}: fix "domain" in ${WORKFLOW_CONFIG} or move the project into its domain (D-0025)`);
  return up;
}

function domainAbove(projectDir, home) {
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
  // A wrong "domain" in .workflow.json stops a command; a hook (requireBrain false) keeps the domain above the project, so
  // its guards still bound the writes, and the start reports domainError.
  let domain = null;
  let domainError = null;
  try { domain = resolveDomain(projectDir); } catch (err) {
    if (requireBrain) throw err;
    domainError = err.message;
    domain = resolveDomain(projectDir, os.homedir(), { field: false });
  }
  const composed = projectPolicy({ projectDir, brainDir: ok ? brainDir : null, domain });
  // Write exceptions outside the domain from the composed policy: a project layer can only drop them (intersect).
  if (domain && composed.layers.inDomain) {
    const allow = allowOutside(composed.policy);
    domain = { ...domain, allowOutside: allow.paths, sudo: allow.sudo };
  }
  return {
    projectDir,
    projectName: path.basename(projectDir),
    brainDir: ok ? brainDir : null,
    brainInfo,
    persona: !!brainInfo?.persona,
    config: readWorkflowConfig(projectDir),
    policy: composed.policy,
    policyIgnored: composed.ignored,
    layers: composed.layers,
    thread: threadId(),
    pluginRoot: PLUGIN_ROOT,
    domain,
    domainError,
  };
}

export function pluginInstallDir() {
  return process.env.WORKFLOW_PLUGIN_ROOT || path.join(os.homedir(), '.claude', 'skills', PLUGIN_NAME);
}
