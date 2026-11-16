// Data layout of a repository (brain or project repo): one map "logical name -> relative path" per layout version.
// Every module builds paths of brain and project data through this module (dataPath, layoutOf, workDirFor); none spells
// the folder names itself. A leaf module: it imports only node builtins, so config.mjs, materialy.mjs and the hooks can
// import it.
//
// Layout version of a repository: key `data_layout` in its policy file. Looked up in fixed places that do not depend on
// the version (VERSION_FILES), first `.brain/policy.json` (where layout 2 keeps policy), then `policy.json` (a brain in
// layout 1) and `agentic/policy.json` (a project repo in layout 1). A missing key means layout 1, so no repository written
// before this module changes. Three layouts exist: 1 (topics/, scratch/, agentic/ in a project repo), 2 (.brain/, temy/,
// vystupy/, the knowledge of a project repo in its root) and 3 (flow v2, spec 4: a brain with topics/, memory/,
// decisions/ ... in its root and no outputs or sources; a project repo with .brain/ as in layout 2 and vystupy/<typ>/,
// zdroje/<téma>/). Layout 3 has two maps, one per role (layoutRole: the brain keeps its policy in its root, a project repo
// in .brain/); layouts 1 and 2 have one map for both. A name a layout does not have is null there (topicArchive, scratch
// in layout 2): relPath and dataPath of it throw, so a caller that forgot the version fails in a test. Code that branches
// on the layout tests a capability of the map (hasScratch, oneTopicFile in topic-files.mjs, a name that is not null), not
// the version number. Code that reads a version's map at import (patterns, messages) builds it per version (memoized).
import fs from 'node:fs';
import path from 'node:path';

/** Layout 1: the layout of every brain and project repo today (templates/brain, <repo>/agentic/). */
const LAYOUT_1 = Object.freeze({
  // Brain records (P-007, P-013).
  memory: 'memory',
  decisions: 'decisions',
  rules: 'rules',
  skills: 'skills',
  exceptions: 'exceptions',
  logs: 'logs',
  policy: 'policy.json',
  // Topics and the files of one topic (topics/<id>/...).
  topics: 'topics',
  topicArchive: 'topics/archive',
  topicFile: 'topic.json',
  holderFile: 'holder.json',
  handover: 'handover.md',
  results: 'results.md',
  // Work files, outside material and documents of a project (P-052, save.mjs source and result).
  scratch: 'scratch',
  topicTmp: null,
  topicHidden: null,
  materialy: 'materialy',
  docs: 'docs',
  // Operator's local files (P-018) and the catalog of client data inside them.
  local: 'local',
  catalog: 'local/catalog',
  // Knowledge of a project repo, kept in the repo (D-0002).
  projectKnowledge: 'agentic',
  runbooks: 'runbooks',
  repoHandover: 'HANDOVER.md',
  // INDEX.md of the repository (scripts/data-index.mjs): none in layout 1.
  index: null,
  // Outputs sorted by type, vystupy/<typ>/<vec> (spec 4): a project repo of layout 3 only.
  outputs: null,
});


/**
 * Layout 2 (D-0048): the data of the workflow under `.brain/`, topics in `temy/` with one `.tema.json` (topic and holder
 * in one file), outputs in `vystupy/`, outside material in `zdroje/`. The knowledge of a project repo is in its root
 * (projectKnowledge ''), next to the code. A closed topic stays in temy/<id>/ with `state: "closed"`; one left with only its
 * handover and .tema.json after the triage goes to the hidden .brain/archive/topics/<id>/ (topicHidden, D-0060); work
 * files belong to a topic (temy/<id>/tmp, outside git), so there is no scratch folder of the repository.
 */
const LAYOUT_2 = Object.freeze({
  memory: '.brain/memory',
  decisions: 'vystupy/rozhodnutia',
  rules: '.brain/rules',
  skills: '.brain/skills',
  exceptions: '.brain/exceptions',
  logs: '.brain/logs',
  policy: '.brain/policy.json',
  topics: 'temy',
  topicArchive: null,
  topicFile: '.tema.json',
  holderFile: '.tema.json',
  handover: 'handover.md',
  results: 'results.md',
  scratch: null,
  topicTmp: 'tmp',
  // A closed topic left with only its handover and .tema.json after the triage: hidden, outside INDEX.md (D-0060).
  topicHidden: '.brain/archive/topics',
  materialy: 'zdroje',
  docs: 'vystupy/dokumenty',
  local: 'local',
  catalog: 'local/catalog',
  projectKnowledge: '',
  runbooks: '.brain/runbooks',
  repoHandover: '.brain/HANDOVER.md',
  index: 'INDEX.md',
  outputs: null,
});

/**
 * Layout 3, the brain (flow v2, spec 4; plan O11): records in the root as in layout 1 (memory/, decisions/, rules/,
 * skills/, exceptions/, logs/, policy.json), topics in topics/<topic>/ with one .tema.json, handover.md, the results of
 * the work and tmp/ (outside git). No outputs and no sources (they go to the target repo of the topic, spec 4.5), no
 * archive of topics (a closed topic ends, spec 5) and no scratch folder.
 */
const LAYOUT_3 = Object.freeze({
  memory: 'memory',
  decisions: 'decisions',
  rules: 'rules',
  skills: 'skills',
  exceptions: 'exceptions',
  logs: 'logs',
  policy: 'policy.json',
  topics: 'topics',
  topicArchive: null,
  topicFile: '.tema.json',
  holderFile: '.tema.json',
  handover: 'handover.md',
  results: 'results.md',
  scratch: null,
  topicTmp: 'tmp',
  topicHidden: null,
  materialy: null,
  docs: null,
  local: 'local',
  catalog: 'local/catalog',
  projectKnowledge: '',
  runbooks: 'runbooks',
  repoHandover: 'HANDOVER.md',
  index: 'INDEX.md',
  outputs: null,
});

/**
 * Layout 3, a project repo (plan O11): .brain/ as in layout 2 (policy, sources.json, the knowledge of the repo), outputs by
 * type in vystupy/<typ>/ (outputs; the documents of layout 2 and the decisions of the repo are the types dokumenty and
 * rozhodnutia) and outside material in zdroje/<téma>/. Topics live in the brain; topics/ here only names where a topic
 * home would be.
 */
const LAYOUT_3_REPO = Object.freeze({
  ...LAYOUT_2,
  topics: 'topics',
  topicHidden: null,
  outputs: 'vystupy',
});

/** Maps by layout version (the brain's map where a layout has two). A name a layout does not have is null there. */
export const LAYOUTS = Object.freeze({ 1: LAYOUT_1, 2: LAYOUT_2, 3: LAYOUT_3 });
/** Maps of a project repo where they differ from the brain's (layout 3). */
const REPO_LAYOUTS = Object.freeze({ 3: LAYOUT_3_REPO });
const KNOWN_VERSIONS = Object.freeze([1, 2, 3]);
/** Version of a repository whose policy names none (every repository written before layout 2). */
export const DEFAULT_LAYOUT_VERSION = 1;
/** Version of a brain brain-init creates without --layout (flow v2). */
export const NEW_BRAIN_LAYOUT = 3;
/** Roles of a repository in a layout with two maps. */
export const ROLE_BRAIN = 'brain';
export const ROLE_REPO = 'repo';
/** Key of the layout version in a repository's policy file. */
export const LAYOUT_KEY = 'data_layout';
/** Where the version is read, in order; fixed paths readable before any other path of the repository is known. */
export const VERSION_FILES = Object.freeze(['.brain/policy.json', 'policy.json', 'agentic/policy.json']);

/** Logical names of the map (every layout has all of them, null where it lacks one). */
export const LAYOUT_NAMES = Object.freeze(Object.keys(LAYOUT_1));

/** Versions this workflow knows. */
export const layoutVersions = () => [...KNOWN_VERSIONS];

/**
 * Map of one layout version (role: ROLE_BRAIN or ROLE_REPO, which differ only in layout 3); an unknown version is an
 * error (a newer workflow wrote the repository).
 */
export function layoutFor(version = DEFAULT_LAYOUT_VERSION, role = ROLE_BRAIN) {
  const v = Number(version);
  const map = KNOWN_VERSIONS.includes(v) ? (role === ROLE_REPO && REPO_LAYOUTS[v]) || LAYOUTS[v] : null;
  if (!map) throw new Error(`data layout ${version} is not known to this workflow (known: ${KNOWN_VERSIONS.join(', ')}); update the workflow`);
  return map;
}

/** The layout keeps two maps, one for the brain and one for a project repo (layout 3): both must carry the same version (plan O18). */
export const splitRoles = (version) => layoutFor(version, ROLE_BRAIN) !== layoutFor(version, ROLE_REPO);

/** Where the version of a repository is written: { version, file } (file null when no policy file names one). */
function versionSource(root) {
  if (!root) return { version: DEFAULT_LAYOUT_VERSION, file: null };
  for (const rel of VERSION_FILES) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')); } catch { continue; }
    if (json && Object.prototype.hasOwnProperty.call(json, LAYOUT_KEY)) return { version: json[LAYOUT_KEY], file: rel };
  }
  return { version: DEFAULT_LAYOUT_VERSION, file: null };
}

/** Layout version of a repository (brain or project repo); 1 when no policy file names one. */
export const dataLayoutVersion = (root) => versionSource(root).version;

/** Role of a repository: a project repo keeps its policy in .brain/ (layouts 2 and 3), a brain of layout 3 in its root. */
export function layoutRole(root) {
  const { version, file } = versionSource(root);
  return file && path.posix.dirname(file) === path.posix.dirname(layoutFor(version, ROLE_REPO).policy) && splitRoles(version) ? ROLE_REPO : ROLE_BRAIN;
}

/** Map of a repository by its layout version and role. */
export function layoutOf(root) {
  const { version } = versionSource(root);
  return layoutFor(version, layoutRole(root));
}

const pathIn = (map, name, version) => {
  const rel = map[name];
  if (rel === undefined) throw new Error(`unknown data path ${name}`);
  if (rel === null) throw new Error(`data path ${name} does not exist in data layout ${version}`);
  return rel;
};

/** Relative path (posix) of a logical name in a layout version; '' for the root itself (projectKnowledge in layout 2). */
export function relPath(name, version = DEFAULT_LAYOUT_VERSION, role = ROLE_BRAIN) {
  return pathIn(layoutFor(version, role), name, version);
}

const parts = (rel) => (rel ? rel.split('/') : []);
const relOf = (root, name) => pathIn(layoutOf(root), name, dataLayoutVersion(root));

/** Absolute path of a logical name in a repository, with optional parts under it: dataPath(brain, 'topics', id, ...). */
export function dataPath(root, name, ...rest) {
  return path.join(root, ...parts(relOf(root, name)), ...rest);
}

/**
 * Path relative to the repository root (posix, for brain write ops and git paths): dataRel(brain, 'topics', id, 'handover.md').
 * Empty parts are left out (the knowledge of a layout 2 repo is its root): never a leading `/` or a `//`.
 */
export function dataRel(root, name, ...rest) {
  return [relOf(root, name), ...rest].filter((p) => p !== '' && p !== undefined && p !== null).join('/');
}

/** The repository has the logical name (a capability of its map: docs in a brain of layout 3 has none). */
export const hasData = (root, name) => layoutOf(root)[name] !== null && layoutOf(root)[name] !== undefined;

/** Work files in one scratch/ of the repository and the work of a topic beside them (layout 1), not per topic in tmp/. */
export const hasScratch = (root) => layoutOf(root).scratch !== null;

/**
 * The layouts of a brain and of a repo of its domain do not fit together (spec 11.10, plan O18): a layout with two maps
 * (3) needs the same version on both sides. A brain in layout 2 beside a project repo in layout 1 still fits (the repo
 * is moved with its domain). Returns null or { brain, repo } (the versions).
 */
export function layoutMismatch(brainDir, repoDir) {
  if (!brainDir || !repoDir || path.resolve(brainDir) === path.resolve(repoDir)) return null;
  const brain = dataLayoutVersion(brainDir);
  const repo = dataLayoutVersion(repoDir);
  if (brain === repo) return null;
  let split;
  try { split = splitRoles(brain) || splitRoles(repo); } catch { split = true; }
  return split ? { brain, repo } : null;
}

/**
 * Refusal of work in a repo whose layout does not fit the brain of its domain (layoutMismatch), or null: a clone that
 * was not pulled after the migration of the domain (spec 11.10). The older side is pulled; nothing is moved here.
 */
export function layoutRefusal(brainDir, repoDir) {
  const m = layoutMismatch(brainDir, repoDir);
  if (!m) return null;
  const older = Number(m.repo) < Number(m.brain) ? repoDir : brainDir;
  return `data layout of repo ${repoDir} is ${m.repo}, the brain of its domain ${brainDir} has ${m.brain} (${LAYOUT_KEY} in its policy): one clone is not current; run git -C ${older} pull and start the session again; no work in this repo until both have the same layout (spec 11.10)`;
}

/** Relative path (posix) of a logical name, layout 1 (kept for the tests and messages of layout 1; code reads layoutOf(root)). */
export const LAYOUT = LAYOUT_1;

const MAIN = 'main';
const inside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Repository where the work of a topic lives (D-0056): files of the work, conclusions (zavery/) and tmp/ of a topic. A brain
 * in layout 2 holds the whole topic in its temy/<topic>/, also when the project repo is still in layout 1; a brain in
 * layout 1 (or no brain) leaves it as it is: the project repo (layout 1 scratch/ and materialy/, layout 2 temy/). Outside
 * material (zdroje/) and outputs (vystupy/) stay in the project repo by its own layout (dataPath/dataRel).
 */
export function topicHome(brainDir, projectDir) {
  if (brainDir && !hasScratch(brainDir)) return brainDir;
  return projectDir || brainDir || null;
}

/** The project repo is its own topic home and differs from the brain: a session with a project beside the brain. */
export const separateProject = (brainDir, projectDir) => !!brainDir && !!projectDir && path.resolve(brainDir) !== path.resolve(projectDir);

/** Folder of the work files of a topic in its topic home (topicHome): layout 1 scratch/, layout 2 temy/<topic>/tmp. */
export function topicWorkDir(brainDir, projectDir, topic = null) {
  const home = topicHome(brainDir, projectDir);
  return home ? workDirFor(home, topic) : null;
}

/**
 * Folder of work files of a repository (P-052) for a topic: layout 1 `<root>/scratch` (one for the repository), layout 2
 * `<root>/temy/<topic>/tmp` (outside git; topic `main` when the thread holds no other). The repository is the topic home
 * (topicHome): callers that know the brain pass topicHome(brainDir, projectDir), not the project repo alone.
 */
export function workDirFor(projectDir, topic = null) {
  if (hasScratch(projectDir)) return dataPath(projectDir, 'scratch');
  return dataPath(projectDir, 'topics', topic || MAIN, ...parts(relOf(projectDir, 'topicTmp')));
}

/**
 * A path in the work files of a repository: layout 1 inside scratch/; layout 2 inside temy/<any topic>/ except the topic
 * record (.tema.json) and the handover (written only by the workflow scripts, P-013).
 */
export function isWorkPath(root, abs) {
  if (!root || !abs) return false;
  if (hasScratch(root)) return inside(dataPath(root, 'scratch'), abs);
  const L = layoutOf(root);
  const topics = dataPath(root, 'topics');
  if (!inside(topics, abs)) return false;
  const rel = path.relative(path.resolve(topics), path.resolve(abs)).split(path.sep);
  if (rel.length < 2 || !rel[0]) return false;
  return !(rel.length === 2 && [L.topicFile, L.holderFile, L.handover].includes(rel[1]));
}

/**
 * A path in the work files of a session: the work files of its topic home (topicHome). A project repo in layout 1 keeps its
 * scratch/ (outside git) beside a brain in layout 2; temy/ of a project repo in layout 2 beside a brain in layout 2 is not
 * one (that repo has no topics, D-0056).
 */
export function isSessionWorkPath(brainDir, projectDir, abs) {
  const home = topicHome(brainDir, projectDir);
  if (home && isWorkPath(home, abs)) return true;
  return !!projectDir && hasScratch(projectDir) && isWorkPath(projectDir, abs);
}

/** Folders of the work files of a repository, for listings and git ignore: layout 1 scratch/, layout 2 temy/<id>/tmp of every topic. */
export function workDirs(root) {
  if (hasScratch(root)) return [dataPath(root, 'scratch')];
  let ids = [];
  try { ids = fs.readdirSync(dataPath(root, 'topics'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  return ids.map((id) => workDirFor(root, id));
}

/** The gitignore line of the work files: layout 1 `scratch/`, layout 2 `temy/*\/tmp/`, layout 3 `topics/*\/tmp/`. */
export function workIgnoreLine(root) {
  return hasScratch(root) ? `${relOf(root, 'scratch')}/` : `${relOf(root, 'topics')}/*/${relOf(root, 'topicTmp')}/`;
}

/** How a message names the work files of a repository: `scratch/`, `temy/<topic>/tmp/` or `topics/<topic>/tmp/`. */
export function workLabel(root, topic = null) {
  return hasScratch(root) ? `${relOf(root, 'scratch')}/` : `${relOf(root, 'topics')}/${topic || '<téma>'}/${relOf(root, 'topicTmp')}/`;
}

/**
 * How a message names the work files of a session: workLabel of the topic home, with "brain " in front when that home is
 * the brain beside the project (`brain temy/<topic>/tmp/`), so the agent does not look for it in the project repo.
 */
export function topicWorkLabel(brainDir, projectDir, topic = null) {
  const home = topicHome(brainDir, projectDir);
  if (!home) return workLabel(projectDir, topic);
  const inBrain = separateProject(brainDir, projectDir) && path.resolve(home) === path.resolve(brainDir);
  return `${inBrain ? 'brain ' : ''}${workLabel(home, topic)}`;
}
