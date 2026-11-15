// Data layout of a repository (brain or project repo): one map "logical name -> relative path" per layout version.
// Every module builds paths of brain and project data through this module (dataPath, layoutOf, workDirFor); none spells
// the folder names itself. A leaf module: it imports only node builtins, so config.mjs, materialy.mjs and the hooks can
// import it.
//
// Layout version of a repository: key `data_layout` in its policy file. Looked up in fixed places that do not depend on
// the version (VERSION_FILES), first `.brain/policy.json` (where layout 2 keeps policy), then `policy.json` (a brain in
// layout 1) and `agentic/policy.json` (a project repo in layout 1). A missing key means layout 1, so no repository written
// before this module changes. Two layouts exist: 1 (topics/, scratch/, agentic/ in a project repo) and 2 (.brain/, temy/,
// vystupy/, the knowledge of a project repo in its root). A name a layout does not have is null there (topicArchive,
// scratch in layout 2): relPath and dataPath of it throw, so a caller that forgot the version fails in a test. Code that
// reads a version's map at import (patterns, messages) builds it per version (memoized), never from LAYOUT alone.
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
  // Work files, outside material and documents of a project (P-052, skill materialy).
  scratch: 'scratch',
  materialy: 'materialy',
  docs: 'docs',
  // Operator's local files (P-018) and the catalog of client data inside them.
  local: 'local',
  catalog: 'local/catalog',
  // Knowledge of a project repo, kept in the repo (D-0002).
  projectKnowledge: 'agentic',
  runbooks: 'runbooks',
  repoHandover: 'HANDOVER.md',
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
});

/** Maps by layout version. A name a layout does not have is null there (topicArchive, scratch in layout 2). */
export const LAYOUTS = Object.freeze({ 1: LAYOUT_1, 2: LAYOUT_2 });
const KNOWN_VERSIONS = Object.freeze([1, 2]);
export const DEFAULT_LAYOUT_VERSION = 1;
/** Key of the layout version in a repository's policy file. */
export const LAYOUT_KEY = 'data_layout';
/** Where the version is read, in order; fixed paths readable before any other path of the repository is known. */
export const VERSION_FILES = Object.freeze(['.brain/policy.json', 'policy.json', 'agentic/policy.json']);

/** Logical names of the map (layout 1; layout 2 adds topicTmp and topicHidden). */
export const LAYOUT_NAMES = Object.freeze(Object.keys(LAYOUT_1));

/** Versions this workflow knows. */
export const layoutVersions = () => [...KNOWN_VERSIONS];

/** Map of one layout version; an unknown version is an error (a newer workflow wrote the repository). */
export function layoutFor(version = DEFAULT_LAYOUT_VERSION) {
  const map = KNOWN_VERSIONS.includes(Number(version)) ? LAYOUTS[Number(version)] : null;
  if (!map) throw new Error(`data layout ${version} is not known to this workflow (known: ${KNOWN_VERSIONS.join(', ')}); update the workflow`);
  return map;
}

/** Layout version of a repository (brain or project repo); 1 when no policy file names one. */
export function dataLayoutVersion(root) {
  if (!root) return DEFAULT_LAYOUT_VERSION;
  for (const rel of VERSION_FILES) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')); } catch { continue; }
    if (json && Object.prototype.hasOwnProperty.call(json, LAYOUT_KEY)) return json[LAYOUT_KEY];
  }
  return DEFAULT_LAYOUT_VERSION;
}

/** Map of a repository by its layout version. */
export const layoutOf = (root) => layoutFor(dataLayoutVersion(root));

/** Relative path (posix) of a logical name in a layout version; '' for the root itself (projectKnowledge in layout 2). */
export function relPath(name, version = DEFAULT_LAYOUT_VERSION) {
  const rel = layoutFor(version)[name];
  if (rel === undefined) throw new Error(`unknown data path ${name}`);
  if (rel === null) throw new Error(`data path ${name} does not exist in data layout ${version}`);
  return rel;
}

const parts = (rel) => (rel ? rel.split('/') : []);

/** Absolute path of a logical name in a repository, with optional parts under it: dataPath(brain, 'topics', id, ...). */
export function dataPath(root, name, ...rest) {
  return path.join(root, ...parts(relPath(name, dataLayoutVersion(root))), ...rest);
}

/**
 * Path relative to the repository root (posix, for brain write ops and git paths): dataRel(brain, 'topics', id, 'handover.md').
 * Empty parts are left out (the knowledge of a layout 2 repo is its root): never a leading `/` or a `//`.
 */
export function dataRel(root, name, ...rest) {
  return [relPath(name, dataLayoutVersion(root)), ...rest].filter((p) => p !== '' && p !== undefined && p !== null).join('/');
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
  if (brainDir && dataLayoutVersion(brainDir) !== 1) return brainDir;
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
  const v = dataLayoutVersion(projectDir);
  if (v === 1) return dataPath(projectDir, 'scratch');
  return path.join(projectDir, ...parts(relPath('topics', v)), topic || MAIN, ...parts(relPath('topicTmp', v)));
}

/**
 * A path in the work files of a repository: layout 1 inside scratch/; layout 2 inside temy/<any topic>/ except the topic
 * record (.tema.json) and the handover (written only by the workflow scripts, P-013).
 */
export function isWorkPath(root, abs) {
  if (!root || !abs) return false;
  const v = dataLayoutVersion(root);
  if (v === 1) return inside(dataPath(root, 'scratch'), abs);
  const L = layoutFor(v);
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
  return !!projectDir && dataLayoutVersion(projectDir) === 1 && isWorkPath(projectDir, abs);
}

/** Folders of the work files of a repository, for listings and git ignore: layout 1 scratch/, layout 2 temy/<id>/tmp of every topic. */
export function workDirs(root) {
  const v = dataLayoutVersion(root);
  if (v === 1) return [dataPath(root, 'scratch')];
  let ids = [];
  try { ids = fs.readdirSync(dataPath(root, 'topics'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  return ids.map((id) => workDirFor(root, id));
}

/** The gitignore line of the work files: layout 1 `scratch/`, layout 2 `temy/*\/tmp/`. */
export function workIgnoreLine(root) {
  const v = dataLayoutVersion(root);
  return v === 1 ? `${relPath('scratch', v)}/` : `${relPath('topics', v)}/*/${relPath('topicTmp', v)}/`;
}

/** How a message names the work files of a repository: `scratch/` or `temy/<topic>/tmp/`. */
export function workLabel(root, topic = null) {
  const v = dataLayoutVersion(root);
  return v === 1 ? `${relPath('scratch', v)}/` : `${relPath('topics', v)}/${topic || '<téma>'}/${relPath('topicTmp', v)}/`;
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
