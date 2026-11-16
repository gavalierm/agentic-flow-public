// Move of one repository (brain or project repo) from data layout 1 to layout 2 (D-0048, phase 3). Every path comes from
// LAYOUTS[1] and LAYOUTS[2] (layout.mjs): the plan maps each file git tracks "from -> to", lists what waits for the
// operator (triage) and what is never moved automatically; the apply makes the plan one commit (a brain through brainWrite,
// a project repo with the brain script tag), so `git revert` brings layout 1 back; the check verifies the result.
//
// Triage file (TSV, one item per line, `#` comments and a header line starting with `cesta` are skipped):
//   cesta <TAB> navrh <TAB> tema <TAB> dovod
// cesta: the item as the plan lists it (a folder ends with `/`); navrh: a class of the triage at done --topic (D-0059,
// targets from classTargetIn of triage.mjs): `dokument` (vystupy/dokumenty/<name>), `zdroj` (zdroje/<tema>/...), `stav`
// (temy/<tema>/..., in a project repo the brain's), `pomocne` (removed: a tracked file by git rm in the move commit, a
// file outside git deleted, only from the confirmed file), `dokument@brain` or `zdroj@brain` (a project repo: into its
// brain, a file of several projects or of the agent); `ostava` (stays in place); or a path under zdroje/, temy/ or
// vystupy/ (a folder target ends with `/`; a file never takes the path of a folder of layout 2, such as
// vystupy/dokumenty). An unknown navrh stays with an error listing the valid ones. tema: the topic of `zdroj` and `stav`
// (default: <name> of an item materialy/<name>/); dovod: free text. In a project repo a target in the brain (the one its
// .workflow.json names) is written by the brain's writer and the project commit removes the files; a file the brain
// already has there with the same content is only removed (duplicita brainu), another content stays with an error.
// Files outside git (scratch/) never go into the brain. The plan reads proposals from one (--triage); the apply moves
// only the items of a file the operator confirmed (--confirmed), everything else stays and is listed. The check lists the
// references in tracked text files (md, json, html, txt) to paths the move changed, relative and absolute, with file and
// line; it does not rewrite them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, gitRemote, readJson, PLUGIN_ROOT } from './util.mjs';
import { BRAIN_COMMIT_TAG, MIGRATE_MOVE_ENV, DOMAIN_MARKER, brainScriptEnv, loadPolicy, threadId } from './config.mjs';
import { checkBrainFile } from './brain-checks.mjs';
import { LAYOUTS, LAYOUT_KEY, dataLayoutVersion, dataName } from './layout.mjs';
import { brainWrite, gitAccessProblem } from './brain.mjs';
import { branchProblems } from './topic-branches.mjs';
import { INDEX_FILE, refreshIndex, indexProblem, commitIndexAfterMerge, refreshDeployIgnores, deployIgnoreGaps, deployIgnoreLines, formatDeployIgnores } from './data-index.mjs';
import { CLASSES, MOVED_CLASSES, BRAIN_SUFFIX, classTargetIn } from './triage.mjs';
import { redactUrl } from './secrets.mjs';
import { staleCatalog, rescanStale } from './catalog/stale.mjs';
import { isJunk, isLarge, sizeOf, sizeText, leftovers, removeJunk, leftoverLines, junkText } from './leftovers.mjs';

const L1 = LAYOUTS[1];
const L2 = LAYOUTS[2];
export const FROM_VERSION = 1;
export const TO_VERSION = 2;
/** The record of a move (every file tracked before it, from -> to, status), committed with it; the check reads it. */
export const RECORD_REL = `${path.posix.dirname(L2.policy)}/migrate-1-2.tsv`;
export const COMMIT_SUBJECT = 'migrate data 1 -> 2.0';
const STATUS = { move: 'presun', merge: 'zlucene', triageMove: 'triaz-presun', stay: 'ostava', triageStay: 'triaz-ostava', never: 'nikdy', outside: 'mimo-gitu', toBrain: 'do-brainu', dupBrain: 'duplicita-brainu', removed: 'pomocne-zmazane', deleted: 'pomocne-zmazane-mimo-gitu' };
/** Moves of a project repo whose target is in its brain (written there, or there already: a duplicate). */
const intoBrain = (m) => m.status === STATUS.toBrain || m.status === STATUS.dupBrain;
/** A file removed by the move (pomocne): no target path. */
const GONE = '-';
const gone = (m) => m.status === STATUS.removed || m.status === STATUS.deleted;
/** A file that has a new place in this repository. */
const relocated = (m) => !intoBrain(m) && !gone(m);

/** The brain a project repo names in .workflow.json (relative to the repo, as the workflow resolves it), or null. */
export function configuredBrain(dir) {
  const cfg = readJson(path.join(dir, '.workflow.json'), null);
  return cfg && typeof cfg.brain === 'string' && cfg.brain.trim() && !path.isAbsolute(cfg.brain) ? path.resolve(dir, cfg.brain) : null;
}
const NO_PROPOSAL = 'bez navrhu';
/** Files of the repository itself (git, harness, adapter output): they stay where they are. */
const INFRA = new Set(['.gitattributes', '.gitignore', '.githooks', 'README.md', 'CLAUDE.md', 'AGENTS.md', '.workflow.json', '.claude', '.codex', '.agents', '.mcp.json']);
/** Top folders of layout 2 an explicit triage target may name (outside material, topics, outputs). */
const OUTPUTS = L2.docs.split('/')[0];
const TARGET_ROOTS = [L2.materialy, L2.topics, OUTPUTS];
/** Folders of layout 2 (and their parents): no tracked file may sit on one of these paths. */
const LAYOUT2_FOLDERS = new Set(['memory', 'decisions', 'rules', 'skills', 'exceptions', 'logs', 'topics', 'materialy', 'docs', 'local', 'catalog', 'runbooks']
  .flatMap((k) => L2[k].split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))));
const VALID_PROPOSALS = `valid navrh: dokument (${classTargetIn(TO_VERSION, 'dokument')}/<name>), zdroj (${classTargetIn(TO_VERSION, 'zdroj', '<tema>')}/), stav (${classTargetIn(TO_VERSION, 'stav', '<tema>')}/, in a project repo of its brain), pomocne (removed), ${MOVED_CLASSES.map((c) => `${c}${BRAIN_SUFFIX}`).join(', ')} (a project repo: into its brain), ostava, or a path under ${TARGET_ROOTS.join('/, ')}/ (a folder target ends with /)`;
/** The triage TSV for --help: columns, the values of navrh and the rows for parts of a folder item. */
export const TRIAGE_HELP = [
  'Triage TSV (--triage, --confirmed): one item per line, columns separated by a TAB; `#` comments and a header line',
  'starting with `cesta` are skipped:',
  '  cesta <TAB> navrh <TAB> tema <TAB> dovod',
  'cesta: the item as the preview lists it (a folder ends with /); a part of a folder item (scratch/t3ref/, a file in it)',
  '  is an item of its own with its own navrh, the folder item keeps the rest.',
  `navrh: ${VALID_PROPOSALS.replace(/^valid navrh: /, '')}.`,
  '  dokument: a document that holds; zdroj: material from outside (needs tema, except materialy/<tema>/); stav: work of a',
  '  topic (needs tema); pomocne: removed (a file outside git only from --confirmed); ostava or empty: stays.',
  'tema: the topic of zdroj and stav; dovod: free text.',
  'Example:',
  '  cesta\tnavrh\ttema\tdovod',
  '  scratch/t3ref/\tpomocne\t\tclone of a public repo',
  '  scratch/seo-audit/\tzdroj\tseo\taudit data',
  '  docs/audit.md\tdokument\t\taudit',
].join('\n');
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.yml', '.yaml', '.html', '.htm']);
/** Files the check searches for references to changed paths. */
const REF_EXT = new Set(['.md', '.json', '.html', '.txt']);
const VENV = new Set(['.venv', 'venv']);
// A file name of credentials: keys, .env, and credentials/secrets/tokens as data (not code such as secrets.mjs).
const CREDENTIAL = /^(\.env(\..+)?|.+\.(pem|key|p12|pfx|jks|keystore|ppk)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|(credentials?|secrets?|tokens?)(\.(json|txt|ya?ml|env|ini|toml|cfg|conf))?|.+\.secret)$/i;

const posix = (p) => String(p).split(path.sep).join('/');
const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/**
 * The repository is a brain (layout 1: its policy file in the root) or a project repo (knowledge in agentic/). After the
 * move the record names the kind (the policy file is then in .brain/ in both). A brain without its policy file (a domain
 * brain that never needed one) is known by topics/ and .git in the root and no agentic/ folder.
 */
export function repoKind(dir) {
  const rec = readRecord(dir);
  if (rec?.kind) return rec.kind;
  if (fs.existsSync(path.join(dir, L1.policy))) return 'brain';
  if (fs.existsSync(path.join(dir, L1.projectKnowledge))) return 'project';
  return fs.existsSync(path.join(dir, L1.topics)) && fs.existsSync(path.join(dir, '.git')) ? 'brain' : 'project';
}

/**
 * Every git call here that prints paths: names as they are, never quoted (core.quotepath turns "ľ" into "\304\276"),
 * and lists split on NUL (-z) where a name may hold a newline.
 */
const GIT_PATHS = ['-c', 'core.quotepath=false'];

/** Files git tracks: [{ rel, mode }] (mode 160000 is a nested repository, a gitlink). */
export function trackedFiles(dir) {
  const r = spawnSync('git', [...GIT_PATHS, 'ls-files', '-s', '-z'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${dir}: not a git repository (${(r.stderr || '').trim()})`);
  return r.stdout.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { mode: line.slice(0, 6), rel: line.slice(tab + 1) };
  });
}

const NESTED = 'nested git repository';

/**
 * State of a nested repository, so the operator sees what a later removal would lose: its origin, uncommitted changes
 * (git status --porcelain) and commits on no remote (git log --branches --not --remotes).
 */
export function nestedState(abs) {
  // Never the enclosing repository: a broken .git must not report the state of the repository around it.
  const opts = { cwd: abs, env: { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(abs)) } };
  const origin = git(['remote', 'get-url', 'origin'], opts);
  const st = git([...GIT_PATHS, 'status', '--porcelain'], opts);
  const un = git(['log', '--oneline', '--branches', '--not', '--remotes'], opts);
  const count = (r) => (r.ok ? String(r.stdout ? r.stdout.split('\n').length : 0) : '?');
  if (!st.ok) return 'state unreadable';
  return `origin ${origin.ok ? redactUrl(origin.stdout) : 'none'}, uncommitted ${count(st)}, unpushed ${count(un)}`;
}

/** Why a path is never moved automatically (nested repository, virtual environment, credentials, local/), or null. */
export function neverReason(rel, { mode = null, abs = null, dirEntry = !!abs } = {}) {
  const parts = rel.split('/');
  if (parts[0] === L1.local) return `${L1.local}/ (P-018)`;
  if (mode === '160000' || (abs && fs.existsSync(path.join(abs, '.git')))) return NESTED;
  if (parts.some((p) => VENV.has(p)) || (abs && fs.existsSync(path.join(abs, 'pyvenv.cfg')))) return 'virtual environment';
  if (!dirEntry && CREDENTIAL.test(parts.at(-1))) return 'credentials file';
  return null;
}

/** Proposals of a triage file: Map path -> { path, proposal, topic, reason } (missing file: empty). */
export function readTriage(file) {
  const out = new Map();
  if (!file) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#') || /^cesta\t/i.test(line)) continue;
    const [p, proposal = '', topic = '', reason = ''] = line.split('\t').map((s) => s.trim());
    if (!p) continue;
    out.set(normItem(p), { path: normItem(p), proposal, topic, reason });
  }
  return out;
}
const normItem = (p) => posix(p).replace(/^\.\//, '');

/** The triage file of a plan: its items with the proposals they carry. */
export function formatTriageTsv(plan) {
  const rows = ['cesta\tnavrh\ttema\tdovod'];
  for (const t of plan.triage) rows.push([t.path, t.proposal || NO_PROPOSAL, t.topic || '', t.reason || ''].join('\t'));
  return rows.join('\n') + '\n';
}

// ---- plan -------------------------------------------------------------------------------------------------------------

function brainTarget(rel) {
  if (rel === L1.policy) return L2.policy;
  for (const n of ['memory', 'decisions', 'rules', 'skills', 'exceptions', 'logs', 'docs']) {
    if (under(rel, L1[n]) && rel !== L1[n]) return `${L2[n]}/${rel.slice(L1[n].length + 1)}`;
  }
  return null;
}

function projectTarget(rel) {
  const k = L1.projectKnowledge;
  if (!rel.startsWith(`${k}/`)) return null;
  const rest = rel.slice(k.length + 1);
  if (rest === L1.policy) return L2.policy;
  if (rest === L1.repoHandover) return L2.repoHandover;
  for (const n of ['memory', 'decisions', 'rules', 'skills', 'runbooks']) {
    if (rest.startsWith(`${L1[n]}/`)) return `${L2[n]}/${rest.slice(L1[n].length + 1)}`;
  }
  return undefined; // inside agentic/ but outside the map: triage
}

/** Topic files of layout 1: { id, closed, file } for topics/<id>/<file> and topics/archive/<id>/<file>, else null. */
function topicPart(rel) {
  if (rel.startsWith(`${L1.topicArchive}/`)) {
    const [id, ...file] = rel.slice(L1.topicArchive.length + 1).split('/');
    return file.length ? { id, closed: true, file: file.join('/') } : { id: null, closed: true, file: id };
  }
  if (rel.startsWith(`${L1.topics}/`)) {
    const [id, ...file] = rel.slice(L1.topics.length + 1).split('/');
    return file.length ? { id, closed: false, file: file.join('/') } : { id: null, closed: false, file: id };
  }
  return null;
}

/** Triage item of a path: materialy/<topic>/ (or a loose file), docs/<entry> of a project repo, else the top entry. */
function triageItemOf(rel, kind) {
  const parts = rel.split('/');
  if (parts[0] === L1.materialy || (kind === 'project' && parts[0] === L1.docs)) {
    return parts.length > 2 ? `${parts[0]}/${parts[1]}/` : rel;
  }
  if (kind === 'project' && parts[0] === L1.projectKnowledge) return rel;
  return parts.length > 1 ? `${parts[0]}/` : rel;
}

const triageReason = (item, kind) => {
  const top = item.split('/')[0];
  if (top === L1.materialy) return `${L1.materialy}/: ${L2.materialy}/ or ${L2.topics}/<topic>/ (operator)`;
  if (top === L1.docs) return `${L1.docs}/ of a project repo (operator)`;
  if (top === L1.scratch) return `${L1.scratch}/ outside git (operator)`;
  if (top === L1.projectKnowledge) return `${L1.projectKnowledge}/ outside the map of data 2.0`;
  return `outside the map of data 1 (${kind})`;
};

/**
 * Untracked work files (scratch/): every file, and a nested repository, a virtual environment or a credentials file as one
 * unit (a folder moves whole). Work files are triaged or go to the work folder of a topic outside git; none is left in a
 * scratch/ data 2.0 does not have (operator 2026-11-16: a clone in scratch/ is work files too). A unit is never deleted by
 * the move (pomocne): `units` names them with their state, so the preview shows what a folder holds.
 */
function scanUntracked(dir, rel, files, units) {
  const abs = path.join(dir, rel);
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    const a = path.join(dir, r);
    const why = neverReason(r, { abs: e.isDirectory() ? a : null });
    if (why) { files.push(r); units.set(r, { why: why === NESTED ? `${why} (${nestedState(a)})` : why, folder: e.isDirectory() }); continue; }
    if (e.isDirectory()) scanUntracked(dir, r, files, units);
    else if (e.isFile()) files.push(r);
  }
}

/**
 * Target of a triage item by its proposal row: { to, brain } (brain: written into the brain of a project repo), { remove }
 * for pomocne, or { to: null } (stays) with the error when the proposal is not valid. The classes take their targets from
 * classTargetIn (triage.mjs), as done --topic does.
 */
function triageTarget(item, row, kind = 'brain', untracked = false) {
  const p = (row?.proposal || '').trim();
  if (!p || p === NO_PROPOSAL || p === 'ostava') return { to: null };
  const folder = item.endsWith('/');
  const slash = folder ? '/' : '';
  const name = item.replace(/\/$/, '').split('/').slice(1).join('/') || item.replace(/\/$/, '');
  const top = item.split('/')[0];
  const atBrain = p.endsWith(BRAIN_SUFFIX);
  const cls = atBrain ? p.slice(0, -BRAIN_SUFFIX.length) : p;
  let to;
  let byClass = false;
  if (CLASSES.includes(cls) && (!atBrain || MOVED_CLASSES.includes(cls))) {
    if (cls === 'pomocne') return { to: null, remove: true };
    byClass = true;
    if (cls === 'dokument') to = `${classTargetIn(TO_VERSION, cls, null, path.posix.basename(item.replace(/\/$/, '')))}${slash}`;
    else {
      // The material of a topic of layout 1 (materialy/<tema>/) becomes the folder of that topic; anything else keeps its name in it.
      const own = top === L1.materialy && folder;
      const topic = row.topic || (own ? name : '');
      if (!topic) return { to: null, error: `navrh ${p} needs a tema; ${VALID_PROPOSALS}` };
      to = own ? `${classTargetIn(TO_VERSION, cls, topic)}/` : `${classTargetIn(TO_VERSION, cls, topic, name)}${slash}`;
    }
  } else if (p.includes('/')) to = normItem(p);
  else return { to: null, error: `navrh ${p} is not valid; ${VALID_PROPOSALS}` };
  if (to.split('/').includes('..') || path.isAbsolute(to)) return { to: null, error: `${to}: target outside the repository; ${VALID_PROPOSALS}` };
  if (!TARGET_ROOTS.some((r) => under(to.replace(/\/$/, ''), r))) return { to: null, error: `${to}: target must be under ${TARGET_ROOTS.join('/, ')}/; ${VALID_PROPOSALS}` };
  // A file onto the path of a folder of layout 2 (vystupy, vystupy/dokumenty ...) would block that folder.
  if (!folder && LAYOUT2_FOLDERS.has(to)) return { to: null, error: `${to}: a folder of data ${dataName(TO_VERSION)}, a file cannot take its name (a folder target ends with /); ${VALID_PROPOSALS}` };
  // A tracked item of a project repo under temy/ (stav): the topic lives in its brain; @brain: a file of several projects
  // or of the agent. Work files outside git (scratch/) stay in the project repo.
  const brain = kind === 'project' && !untracked && (atBrain && byClass ? true : under(to.replace(/\/$/, ''), L2.topics));
  return { to, brain };
}

/**
 * Layout 2 has no scratch/: work files live in temy/<topic>/tmp/ (topic main when a thread holds none). Without a row of
 * its own, the folder item scratch/ (outside git) carries that target as its proposal, so the triage TSV of the preview
 * offers it; it moves only from a confirmed file (P-018). It was `bez navrhu` and stayed beside an empty temy/main/tmp/
 * (report-42a2a5ae): the operator saw layout 1 and layout 2 side by side.
 */
export const SCRATCH_TARGET = `${L2.topics}/main/${L2.topicTmp}/`;
function defaultProposal(t) {
  // Only a small scratch/ as one item carries it; a large one is split per entry without a proposal (planMigration).
  if (t.path !== `${L1.scratch}/` || t.untracked.size !== t.files.length) return null;
  return { proposal: SCRATCH_TARGET, topic: '', reason: `${L1.scratch}/ outside git: data ${dataName(TO_VERSION)} keeps work files in ${L2.topics}/<topic>/${L2.topicTmp}/ (operator)` };
}

const destOf = (item, target, rel) => {
  if (!item.endsWith('/')) return target.endsWith('/') ? `${target}${rel.split('/').at(-1)}` : target;
  return `${target.replace(/\/$/, '')}/${rel.slice(item.length)}`;
};

/**
 * The plan of a repository. { version, kind, moves: [{ from, to, status }], merges: [{ to, topic, holder, closed }],
 * triage: [{ path, files, untracked, proposal, topic, reason, to, error }], never: [{ path, reason }], stays: [rel],
 * tracked: [rel], brainDir }. `proposals`: Map from readTriage (the plan shows them, the apply moves only `confirmed`
 * ones). A project repo's triage target under temy/ is in its brain (the one .workflow.json names, configuredBrain): only
 * a brain in layout 2, and a file it already tracks there waits.
 */
export function planMigration(dir, { proposals = new Map(), confirmed = null } = {}) {
  const version = dataLayoutVersion(dir);
  const kind = repoKind(dir);
  const brainDir = kind === 'project' ? configuredBrain(dir) : null;
  const plan = { dir, version, kind, moves: [], merges: [], triage: [], never: [], stays: [], tracked: [], outside: [], brainDir };
  if (version !== FROM_VERSION) return plan;
  const files = trackedFiles(dir);
  plan.tracked = files.map((f) => f.rel);
  const triage = new Map();
  const addTriage = (item, rel, untracked = false) => {
    if (!triage.has(item)) triage.set(item, { path: item, files: [], untracked: new Set(), reason: triageReason(item, kind) });
    triage.get(item).files.push(rel);
    if (untracked) triage.get(item).untracked.add(rel);
  };
  const topics = new Map(); // id -> { closed, files: [{ rel, file }] }
  const openIds = new Set(files.map((f) => topicPart(f.rel)).filter((t) => t && t.id && !t.closed).map((t) => t.id));
  for (const { rel, mode } of files) {
    const why = neverReason(rel, { mode });
    if (why) { plan.never.push({ path: rel, reason: why === NESTED && fs.existsSync(path.join(dir, rel, '.git')) ? `${why} (${nestedState(path.join(dir, rel))})` : why }); continue; }
    const top = rel.split('/')[0];
    if (INFRA.has(top)) { plan.stays.push(rel); continue; }
    if (kind === 'brain') {
      const t = topicPart(rel);
      if (t) {
        if (!t.id) { plan.moves.push({ from: rel, to: `${L2.topics}/${t.file}`, status: STATUS.move }); continue; }
        if (t.closed && openIds.has(t.id)) { addTriage(`${L1.topicArchive}/${t.id}/`, rel); continue; }
        const key = `${t.closed ? 'c' : 'o'}:${t.id}`;
        if (!topics.has(key)) topics.set(key, { id: t.id, closed: t.closed, files: [] });
        topics.get(key).files.push({ rel, file: t.file });
        continue;
      }
      const to = brainTarget(rel);
      if (to) plan.moves.push({ from: rel, to, status: STATUS.move });
      else addTriage(triageItemOf(rel, kind), rel);
    } else {
      const to = projectTarget(rel);
      if (to) plan.moves.push({ from: rel, to, status: STATUS.move });
      else if (to === undefined || top === L1.materialy || top === L1.docs) addTriage(triageItemOf(rel, kind), rel);
      else plan.stays.push(rel);
    }
  }
  for (const t of topics.values()) {
    const base = `${L2.topics}/${t.id}`;
    const tf = t.files.find((f) => f.file === L1.topicFile);
    const hf = t.files.find((f) => f.file === L1.holderFile);
    const record = tf || hf;
    for (const f of t.files) {
      if (f === tf || f === hf) continue;
      plan.moves.push({ from: f.rel, to: `${base}/${f.file}`, status: STATUS.move });
    }
    if (record) {
      const to = `${base}/${L2.topicFile}`;
      plan.moves.push({ from: record.rel, to, status: STATUS.merge });
      if (tf && hf) plan.moves.push({ from: hf.rel, to, status: STATUS.merge, removed: true });
      plan.merges.push({ to, topic: tf?.rel || null, holder: hf?.rel || null, closed: t.closed });
    }
  }
  // Work files outside git (scratch/): triage, never committed by the plan itself.
  if (fs.existsSync(path.join(dir, L1.scratch))) {
    const list = [];
    plan.units = new Map();
    scanUntracked(dir, L1.scratch, list, plan.units);
    // Junk (__pycache__, *.pyc) is no work: the apply removes it, it is never triaged nor moved.
    const untracked = list.filter((r) => !plan.tracked.includes(r) && !isJunk(r));
    plan.scratchJunk = list.filter((r) => !plan.tracked.includes(r) && isJunk(r));
    // A large scratch/ (doma-pc 2026-11-16: 2.7 GB of exports) is triaged per entry with its size, never moved whole
    // blindly: each entry is an item of its own without a proposal (operator: no 3 GB without triage).
    const whole = sizeOf(path.join(dir, L1.scratch));
    plan.scratchSize = whole;
    // A row for scratch/ itself (the operator confirmed it whole) keeps it one item.
    const split = isLarge(whole) && !(confirmed?.has(`${L1.scratch}/`) || proposals.has(`${L1.scratch}/`));
    for (const r of untracked) {
      const rest = r.slice(L1.scratch.length + 1).split('/');
      const item = split ? (rest.length > 1 ? `${L1.scratch}/${rest[0]}/` : r) : `${L1.scratch}/`;
      addTriage(item, r, true);
    }
    if (split) for (const t of triage.values()) if (t.path.startsWith(`${L1.scratch}/`) && t.path !== `${L1.scratch}/`) t.reason = `${L1.scratch}/ outside git (operator): ${sizeText(sizeOf(path.join(dir, t.path)))}; ${L1.scratch}/ is ${sizeText(whole)} in all, triage each entry: remove what is not needed, the rest to ${L2.topics}/<topic>/${L2.topicTmp}/`;
  }
  // A target that already exists or that two files take: that file waits for the operator.
  const taken = new Set(plan.tracked.filter((r) => !plan.moves.some((m) => m.from === r)));
  const seen = new Map();
  plan.moves = plan.moves.filter((m) => {
    // Two placeholders for one folder (topics/.gitkeep and topics/archive/.gitkeep): one stays, the other merges into it.
    if (seen.has(m.to) && path.posix.basename(m.to) === '.gitkeep') { m.status = STATUS.merge; m.removed = true; return true; }
    const clash = taken.has(m.to) || (seen.has(m.to) && m.status !== STATUS.merge);
    if (clash) { addTriage(m.from, m.from); triage.get(m.from).reason = `target ${m.to} exists`; return false; }
    seen.set(m.to, m.from);
    return true;
  });
  // A row of the TSV naming a part of a folder item (scratch/t3ref/ of scratch/, a file in it) is an item of its own with
  // its own navrh: its files leave the folder item (shorter rows first, each takes the longest folder item it is under).
  const rows = [...new Set([...proposals.keys(), ...(confirmed ? confirmed.keys() : [])])].filter((p) => !triage.has(p)).sort((a, b) => a.length - b.length);
  for (const p of rows) {
    const parent = [...triage.values()].filter((t) => t.path.endsWith('/') && p.startsWith(t.path) && p !== t.path).sort((a, b) => b.path.length - a.path.length)[0];
    if (!parent) continue;
    const mine = parent.files.filter((rel) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
    if (!mine.length) continue;
    const item = { path: p, files: mine, untracked: new Set(mine.filter((rel) => parent.untracked.has(rel))), reason: `${parent.reason}, part of ${parent.path}` };
    parent.files = parent.files.filter((rel) => !mine.includes(rel));
    for (const rel of mine) parent.untracked.delete(rel);
    if (!parent.files.length) triage.delete(parent.path);
    triage.set(p, item);
  }
  for (const t of triage.values()) {
    const row = (confirmed || proposals).get(t.path) || proposals.get(t.path) || defaultProposal(t);
    t.proposal = row?.proposal || '';
    t.topic = row?.topic || '';
    if (row?.reason) t.reason = row.reason;
    t.remove = false;
    t.dups = new Set();
    if (confirmed) {
      const c = confirmed.get(t.path);
      const { to, error, brain: toBrain, remove } = c ? triageTarget(t.path, c, kind, t.untracked.size > 0) : { to: null };
      t.to = to;
      t.remove = !!remove;
      t.error = error || null;
      t.brain = !!(to && toBrain);
      if (t.brain) {
        const inBrain = brainDir && fs.existsSync(brainDir) && dataLayoutVersion(brainDir) === TO_VERSION ? new Set(trackedFiles(brainDir).map((f) => f.rel)) : null;
        // A file the brain has on its target already: the same content is a duplicate (removed here), another stays.
        const clashes = inBrain ? t.files.map((rel) => ({ rel, dest: destOf(t.path, to, rel) })).filter((x) => inBrain.has(x.dest)) : [];
        const differs = clashes.find((x) => !sameFile(path.join(dir, x.rel), path.join(brainDir, x.dest)));
        if (!brainDir || !fs.existsSync(brainDir)) { t.to = null; t.brain = false; t.error = `target ${to} is in the brain of the project, and .workflow.json names none (or it is missing); use zdroj, dokument or ostava`; }
        else if (!inBrain) { t.to = null; t.brain = false; t.error = `target ${to} is in brain ${path.basename(brainDir)}, which is in data ${dataName(dataLayoutVersion(brainDir))}: move the brain to data ${dataName(TO_VERSION)} first`; }
        else if (differs) { t.to = null; t.brain = false; t.error = `target ${differs.dest} exists in brain ${path.basename(brainDir)} with another content`; }
        else t.dups = new Set(clashes.map((x) => x.rel));
      } else if (to) {
        const dests = t.files.map((rel) => destOf(t.path, to, rel));
        const clash = dests.find((d) => taken.has(d) || seen.has(d));
        if (clash) { t.to = null; t.error = `target ${clash} exists`; }
      }
    }
  }
  plan.triage = [...triage.values()].sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

/** Two files with the same bytes. */
function sameFile(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/**
 * All "from -> to" pairs of a plan, triage included (confirmed ones): moves, files into the brain or there already
 * (duplicita brainu), pomocne removed (to `-`: tracked by git rm, outside git deleted).
 */
function allMoves(plan) {
  const out = plan.moves.map((m) => ({ ...m }));
  for (const t of plan.triage) {
    if (t.remove) {
      for (const rel of t.files) out.push(t.untracked.has(rel) ? { from: rel, to: GONE, status: STATUS.deleted } : { from: rel, to: GONE, status: STATUS.removed, removed: true });
      continue;
    }
    if (!t.to) continue;
    for (const rel of t.files) {
      const outside = t.untracked.has(rel);
      const status = t.brain ? (t.dups.has(rel) ? STATUS.dupBrain : STATUS.toBrain) : outside ? STATUS.outside : STATUS.triageMove;
      out.push({ from: rel, to: destOf(t.path, t.to, rel), status });
    }
  }
  return out;
}

// ---- path rewrite -----------------------------------------------------------------------------------------------------

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewriter of references to moved paths: exact old files and old folders whose files all moved under one new folder.
 * A reference is a relative path of at least two parts (`decisions/x.md`, `topics/<id>/`), not preceded by a path or a
 * word character (an absolute path or another repository's folder of the same name is left as it is). In a project
 * repo a path relative to agentic/ resolves too (the knowledge root becomes the repository root).
 */
export function makeRewriter(pairs, { tracked = [], kind = 'brain', folders = true } = {}) {
  const files = new Map();
  for (const { from, to } of pairs) if (from !== to) files.set(from, to);
  const k = L1.projectKnowledge;
  if (kind === 'project') for (const [from, to] of [...files]) if (from.startsWith(`${k}/`)) files.set(from.slice(k.length + 1), to);
  // Folder map: every old folder whose tracked files all moved keeping their path below it.
  const dirs = new Map();
  const bad = new Set();
  for (const [file, dest] of folders ? files : []) {
    // A file renamed in its folder (topic.json -> .tema.json) moves its folder: the folders are compared above the name.
    const renamed = path.posix.basename(file) !== path.posix.basename(dest);
    const from = renamed ? path.posix.dirname(file) : file;
    const to = renamed ? path.posix.dirname(dest) : dest;
    const fp = from.split('/');
    for (let i = renamed ? fp.length : fp.length - 1; i >= 1; i--) {
      const dir = fp.slice(0, i).join('/');
      const suffix = fp.slice(i).join('/');
      const target = !suffix ? to : to.endsWith(`/${suffix}`) ? to.slice(0, -suffix.length - 1) : null;
      if (!target || (dirs.has(dir) && dirs.get(dir) !== target)) { bad.add(dir); continue; }
      dirs.set(dir, target);
    }
  }
  for (const rel of tracked) {
    if (files.has(rel)) continue;
    const parts = rel.split('/');
    for (let i = parts.length - 1; i >= 1; i--) bad.add(parts.slice(0, i).join('/'));
  }
  for (const d of bad) dirs.delete(d);
  const tops = [...new Set([...files.keys(), ...dirs.keys()].map((p) => p.split('/')[0]))].filter(Boolean);
  if (!tops.length) return { rewrite: (t) => ({ text: t, hits: [] }), find: () => [] };
  const re = new RegExp(`(^|[\\s(\\[{<"'\`=,])(\\.\\/)?((?:${tops.map(escRe).join('|')})\\/[^\\s)\\]}>"'\`,;|*]*)`, 'g');
  // New path of a reference without its tail (anchor, :line, end punctuation), or null.
  const resolve = (p) => {
    const bare = p.replace(/\/$/, '');
    if (bare.split('/').length < 2) return null;
    if (files.has(bare) && !p.endsWith('/')) return files.get(bare);
    if (dirs.has(bare)) return dirs.get(bare) + (p.endsWith('/') ? '/' : '');
    const parts = bare.split('/');
    for (let i = parts.length - 1; i >= 2; i--) {
      const d = parts.slice(0, i).join('/');
      if (dirs.has(d)) return `${dirs.get(d)}/${parts.slice(i).join('/')}${p.endsWith('/') ? '/' : ''}`;
    }
    return null;
  };
  // accept(from): false leaves that reference as it is (a path the rewritten repository has itself, crossRepoFix).
  const rewrite = (text, { accept = null } = {}) => {
    const hits = [];
    const out = String(text).replace(re, (all, lead, dot, raw) => {
      const [, p, tail] = /^(.*?)((?:#[^/]*|:\d+(?::\d+)?)?[.:!?]*)$/.exec(raw);
      const to = resolve(p);
      if (!to || (accept && !accept(p, to))) return all;
      hits.push({ from: p, to });
      return `${lead}${dot || ''}${to}${tail}`;
    });
    return { text: out, hits };
  };
  return { rewrite, find: (text) => rewrite(text).hits };
}

/** Files whose text is rewritten: knowledge, topics and outputs (not zdroje/, not code, not generated harness files). */
function rewritable(rel, kind) {
  if (!TEXT_EXT.has(path.posix.extname(rel).toLowerCase())) return false;
  const top = rel.split('/')[0];
  if (under(rel, L2.materialy) || ['.githooks', '.claude', '.codex', '.agents'].includes(top)) return false;
  if (rel === RECORD_REL) return false;
  if (kind === 'project') return [L2.policy.split('/')[0], L2.topics, L2.decisions.split('/')[0]].includes(top);
  return true;
}

// ---- format -----------------------------------------------------------------------------------------------------------

export function formatPlan(plan, { all = false } = {}) {
  const lines = [];
  lines.push(`repository: ${plan.dir} (${plan.kind}, data ${dataName(plan.version)})`);
  if (plan.version === TO_VERSION) { lines.push(`already in data ${dataName(TO_VERSION)}: nothing to move`); return lines.join('\n'); }
  if (plan.version !== FROM_VERSION) { lines.push(`data ${dataName(plan.version)}: this tool moves only data ${dataName(FROM_VERSION)} to ${dataName(TO_VERSION)}; refused`); return lines.join('\n'); }
  const moves = allMoves(plan);
  lines.push(`moves (${moves.length}):`);
  const brainName = plan.brainDir ? path.basename(plan.brainDir) : 'brain';
  const label = { [STATUS.merge]: ' (merged into one topic file)', [STATUS.triageMove]: ' (triage, confirmed)', [STATUS.outside]: ' (triage, confirmed, outside git)', [STATUS.toBrain]: ' (triage, confirmed, into the brain)' };
  for (const m of moves) {
    if (m.status === STATUS.dupBrain) lines.push(`  ${m.from}: duplicita brainu ${brainName}:${m.to} (same content; the move commit removes it here)`);
    else if (m.status === STATUS.removed) lines.push(`  ${m.from} -> removed (triage, confirmed, pomocne: git rm in the move commit)`);
    else if (m.status === STATUS.deleted) lines.push(`  ${m.from} -> deleted (triage, confirmed, pomocne, outside git: git does not restore it)`);
    else lines.push(`  ${m.from} -> ${intoBrain(m) ? `${brainName}:` : ''}${m.to}${label[m.status] || ''}`);
  }
  const merges = plan.merges.filter((m) => m.closed);
  if (merges.length) lines.push(`closed topics (state closed, stay in ${L2.topics}/<id>/): ${merges.map((m) => m.to.split('/')[1]).join(', ')}`);
  if (plan.units?.size) { lines.push(`folders and files of ${L1.scratch}/ that move whole with their item (${plan.units.size}):`); for (const [p, u] of plan.units) lines.push(`  ${p}${u.folder ? '/' : ''}: ${u.why}`); }
  lines.push(`triage, waits for the operator (${plan.triage.length}; TSV: cesta, navrh, tema, dovod):`);
  for (const t of plan.triage) {
    const state = t.remove ? '-> removed (pomocne)' : t.to ? `-> ${t.brain ? `${brainName}:` : ''}${t.to}` : t.error ? `stays (${t.error})` : `stays`;
    lines.push(`  ${t.path}\t${t.proposal || NO_PROPOSAL}\t${t.topic || ''}\t${t.reason}${t.untracked.size ? ' [outside git]' : ''}\t${state} (${t.files.length} file(s))`);
  }
  lines.push(`never moved automatically (${plan.never.length}):`);
  for (const n of plan.never) lines.push(`  ${n.path}: ${n.reason}`);
  if (all) {
    lines.push(`stay in place (${plan.stays.length}):`);
    for (const s of plan.stays) lines.push(`  ${s}`);
  } else lines.push(`stay in place: ${plan.stays.length} file(s) (code, git and harness files; --all lists them)`);
  return lines.join('\n');
}

// ---- apply ------------------------------------------------------------------------------------------------------------

const firstLine = (s) => String(s || '').split('\n')[0];

/** Clean tree and up to date with origin (fast-forward); refuses a divergence. Returns { ok, error, note }. */
export function readyForMove(dir) {
  const status = git([...GIT_PATHS, 'status', '--porcelain', '--untracked-files=normal'], { cwd: dir });
  if (!status.ok) return { ok: false, error: gitAccessProblem(dir, status) || `git status failed: ${firstLine(status.stderr)}` };
  if (status.stdout) {
    const list = status.stdout.split('\n').map((l) => l.slice(3));
    return { ok: false, error: `the working tree is not clean (${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}); commit or restore first` };
  }
  if (!git(['remote', 'get-url', 'origin'], { cwd: dir }).ok) return { ok: true, note: 'no remote origin' };
  const fetch = gitRemote(['fetch', '--quiet', 'origin'], { cwd: dir });
  if (!fetch.ok) return { ok: false, error: `fetch from origin failed: ${redactUrl(firstLine(fetch.stderr))}; the move runs only after fetching origin` };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).stdout;
  if (!git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: dir }).ok) return { ok: true, note: `origin has no ${branch}` };
  const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], { cwd: dir }).stdout.split(/\s+/).map(Number);
  if (ahead && behind) return { ok: false, error: `${branch} and origin/${branch} diverged (${ahead} local, ${behind} on origin); settle it first, the move does not continue` };
  if (behind) {
    const ff = git(['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: dir, env: brainScriptEnv() });
    if (!ff.ok) return { ok: false, error: `fast-forward to origin/${branch} failed: ${firstLine(ff.stderr)}` };
    return { ok: true, note: `updated from origin (${behind} commit(s))` };
  }
  return { ok: true, note: null };
}

const readText = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** The record of a move: every file tracked before it with its new place and status. */
function recordText(plan, moves) {
  const byFrom = new Map(moves.map((m) => [m.from, m]));
  const rows = ['# from\tto\tstatus', `# kind ${plan.kind}`];
  for (const rel of plan.tracked) {
    const m = byFrom.get(rel);
    if (m) { rows.push(`${rel}\t${m.to}\t${m.status}`); continue; }
    const never = plan.never.some((n) => n.path === rel);
    const triage = plan.triage.some((t) => t.files.includes(rel));
    rows.push(`${rel}\t${rel}\t${never ? STATUS.never : triage ? STATUS.triageStay : STATUS.stay}`);
  }
  for (const m of moves.filter((x) => x.status === STATUS.outside || x.status === STATUS.deleted)) rows.push(`${m.from}\t${m.to}\t${m.status}`);
  return rows.join('\n') + '\n';
}

/** Lines .gitignore of layout 2 needs (local/, temy/*\/tmp/), appended to the existing file. */
function gitignoreText(dir) {
  let text = '';
  try { text = readText(dir, '.gitignore'); } catch { /* none */ }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const need = [`${L2.local}/`, `${L2.topics}/*/${L2.topicTmp}/`].filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, '')));
  if (!need.length) return null;
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${need.join('\n')}\n`;
}

/** Problems of consolidate report (references, links, sources) of the session whose brain is `dir`, or null when it cannot run. */
export function consolidateProblems(dir, { project = null, cwd = process.cwd() } = {}) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'consolidate.mjs'), 'report', '--json', ...(project ? ['--project', project] : [])], { cwd, encoding: 'utf8', env: process.env });
  if (r.status !== 0) return { error: firstLine(r.stderr || r.stdout) };
  let rep;
  try { rep = JSON.parse(r.stdout); } catch { return { error: 'consolidate report: no JSON' }; }
  const id = rep.identity || {};
  return { items: [...(id.refs || []), ...(id.links || []).map((l) => `${l.path}: ${l.value}: ${l.problem}`), ...(id.sources || [])] };
}

function sessionBrainIs(dir, { project, cwd }) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain.mjs'), 'status', ...(project ? ['--project', project] : [])], { cwd, encoding: 'utf8', env: process.env });
  const m = /^brain (.+)$/m.exec(r.stdout || '');
  if (!m) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(m[1]) === real(dir);
}

/**
 * Apply the plan: one commit (brain: brainWrite with moves, merged .tema.json, rewritten paths, .gitignore, data_layout 2
 * and the record; project repo: the same with git mv and a commit tagged as the brain script). Nothing is deleted
 * (holder.json lives on in .tema.json; untracked work files move outside git only when confirmed).
 */
export function applyMigration(dir, { confirmedFile = null, proposalsFile = null, project = null, cwd = process.cwd() } = {}) {
  const version = dataLayoutVersion(dir);
  if (version === TO_VERSION) return { ok: true, nothing: true, message: `already in data ${dataName(TO_VERSION)}: nothing to move` };
  if (version !== FROM_VERSION) return { ok: false, error: `data ${dataName(version)}: this tool moves only data ${dataName(FROM_VERSION)} to ${dataName(TO_VERSION)}` };
  // --triage carries only proposals; the move executes rows of --confirmed. Without --confirmed the apply committed the
  // proposals as triaz-ostava and marked the repository layout 2 without a word (flow-public#90).
  if (proposalsFile && !confirmedFile) return { ok: false, error: '--triage carries only proposals, the apply does not execute them: pass the reviewed TSV as --confirmed <tsv> (nothing changed)' };
  const ready = readyForMove(dir);
  if (!ready.ok) return { ok: false, error: ready.error };
  const confirmed = confirmedFile ? readTriage(confirmedFile) : new Map();
  const plan = planMigration(dir, { proposals: readTriage(proposalsFile), confirmed });
  const moves = allMoves(plan);
  // Moves and removals (pomocne, git rm) inside this repository's commit.
  const tracked = moves.filter((m) => m.status !== STATUS.outside && m.status !== STATUS.deleted && !intoBrain(m));
  const outside = moves.filter((m) => m.status === STATUS.outside);
  // Work files outside git the operator confirmed as pomocne: deleted after the commits, each one listed.
  const deleted = moves.filter((m) => m.status === STATUS.deleted);
  // Files of a project repo the operator confirmed into its brain: the project commit removes them, the brain's writer
  // adds them; one the brain has there with the same content (duplicita brainu) is only removed here.
  const toBrain = moves.filter((m) => m.status === STATUS.toBrain);
  const brainOps = toBrain.map((m) => ({ path: m.to, content: fileContent(path.join(dir, m.from)) }));
  const projectMoves = [...tracked, ...moves.filter(intoBrain).map((m) => ({ from: m.from, to: m.from, status: m.status, removed: true }))];
  const consolidate = plan.kind === 'brain' && sessionBrainIs(dir, { project, cwd });
  const before = consolidate ? consolidateProblems(dir, { project, cwd }) : null;
  const content = moveContent(dir, plan, moves);
  content.set(RECORD_REL, recordText(plan, moves));

  // Untracked work files the operator confirmed move first, outside git (nothing deleted; reported).
  for (const m of outside) {
    const to = path.join(dir, m.to);
    if (fs.existsSync(to)) return { ok: false, error: `${m.to} exists; untracked ${m.from} not moved` };
  }
  for (const m of outside) {
    fs.mkdirSync(path.dirname(path.join(dir, m.to)), { recursive: true });
    fs.renameSync(path.join(dir, m.from), path.join(dir, m.to));
  }
  const message = `${COMMIT_SUBJECT}: ${tracked.filter((m) => !m.removed).length} file(s) moved, ${plan.merges.length} topic file(s) merged, ${plan.triage.filter((t) => !t.to && !t.remove).length} triage item(s) stay (migrate.mjs, D-0048)`;
  let sha;
  const info = {};
  try {
    sha = plan.kind === 'brain' ? commitBrain(dir, tracked, content, message, info) : commitProject(dir, projectMoves, content, message, info);
  } catch (err) {
    for (const m of outside) { try { fs.renameSync(path.join(dir, m.to), path.join(dir, m.from)); } catch { /* left where it is, reported */ } }
    return { ok: false, error: err.message, plan };
  }
  let brainSha = null;
  if (brainOps.length) {
    try {
      brainSha = commitBrain(plan.brainDir, [], new Map(brainOps.map((o) => [o.path, o.content])), `${COMMIT_SUBJECT}: ${brainOps.length} file(s) of ${path.basename(dir)} into ${L2.topics}/ of the brain (migrate.mjs, D-0048)`);
    } catch (err) {
      // The project commit is local (not pushed): it goes back, so no file is lost from both repositories.
      git(['reset', '--quiet', '--hard', 'HEAD~1'], { cwd: dir, env: { ...brainScriptEnv(), [MIGRATE_MOVE_ENV]: '1' } });
      for (const m of outside) { try { fs.renameSync(path.join(dir, m.to), path.join(dir, m.from)); } catch { /* left where it is, reported */ } }
      return { ok: false, error: `brain ${path.basename(plan.brainDir)}: ${err.message}; the move of ${path.basename(dir)} was undone`, plan };
    }
  }
  const removedOutside = [];
  for (const m of deleted) {
    if (plan.units?.has(m.from)) { process.stderr.write(`${m.from}: not deleted (${plan.units.get(m.from).why}: the move deletes no folder of its own; move it to a topic's work folder or remove it by hand)\n`); continue; }
    try { fs.rmSync(path.join(dir, m.from)); removedOutside.push(m.from); } catch (err) { process.stderr.write(`${m.from}: not deleted (${err.message})\n`); }
  }
  // Junk outside git (__pycache__, *.pyc, .DS_Store) kept a folder of data 1 alive after its files moved (doma-pc
  // 2026-11-16: materialy/ with only .pyc): removed with the folders it leaves empty; other files there the check reports.
  const junk = removeJunk(dir, { version: TO_VERSION, role: plan.kind });
  const pruned = pruneOldFolders(dir, moves);
  let catalogs = [];
  try { catalogs = rescanStale(dir); } catch (err) { catalogs = [`catalog not scanned (${err.message}); migrate.mjs ${dir} --check --fix`]; }
  const adapter = regenerateAdapter(dir);
  const check = checkMigration(dir, { before, project, cwd, consolidate, outsideHere: true });
  // scratch/ left (not confirmed): said in one line with the row that moves it, not only as a triage item that stays.
  const scratchLeft = fs.existsSync(path.join(dir, L1.scratch))
    ? `${L1.scratch}/ stays (outside git, not confirmed, ${sizeText(sizeOf(path.join(dir, L1.scratch)))}); data ${dataName(TO_VERSION)} has no ${L1.scratch}/: triage it with the operator, entry by entry: remove what is not needed (exports, backups, generated files), move the rest into the work folder of its topic ${L2.topics}/<topic>/${L2.topicTmp}/ (${SCRATCH_TARGET} only for work of no topic); outside git: git does not restore it`
    : null;
  return { ok: true, sha, brainSha, plan, moves, outside, deleted: removedOutside, note: ready.note, adapter, check, pruned, junk, catalogs, scratchLeft, deployIgnores: info.deployIgnores || [] };
}

/** Content of a file for the brain writer: text when it is text, else the bytes. */
function fileContent(abs) {
  const buf = fs.readFileSync(abs);
  return buf.includes(0) ? buf : buf.toString('utf8');
}

/** Final content of every file the move commit writes (path -> text), by its new path; the record is added by the apply. */
function moveContent(dir, plan, moves) {
  const tracked = moves.filter((m) => m.status !== STATUS.outside);
  // A file moved into the brain is in another repository: the paths to it are not rewritten.
  // A removed file (pomocne) has no new path either.
  const { rewrite } = makeRewriter(moves.filter(relocated), { tracked: plan.tracked, kind: plan.kind });
  const content = new Map();
  const finalOf = new Map(tracked.filter((m) => !m.removed && relocated(m)).map((m) => [m.from, m.to]));
  for (const rel of plan.tracked) {
    const to = finalOf.get(rel) || (tracked.some((m) => m.from === rel) ? null : rel);
    // A triage item that stays waits for the operator as it is (it may be outside material): its text is not rewritten.
    if (!to || !rewritable(to, plan.kind) || plan.never.some((n) => n.path === rel) || plan.triage.some((t) => !t.to && t.files.includes(rel))) continue;
    let text;
    try { text = readText(dir, rel); } catch { continue; }
    if (text.includes('\0')) continue;
    const out = rewrite(text).text;
    if (out !== text) content.set(to, out);
  }
  for (const m of plan.merges) {
    const topic = m.topic ? readJson(path.join(dir, m.topic), {}) || {} : {};
    const holder = m.holder ? readJson(path.join(dir, m.holder), {}) || {} : {};
    const { holder: _h, ...fields } = topic;
    const tema = { ...fields, ...(m.closed ? { state: 'closed' } : {}), holder: m.closed ? {} : holder };
    content.set(m.to, rewrite(json(tema)).text);
  }
  const policyFrom = tracked.find((m) => m.to === L2.policy);
  const policy = policyFrom ? readJson(path.join(dir, policyFrom.from), {}) || {} : {};
  content.set(L2.policy, json({ ...policy, [LAYOUT_KEY]: dataName(TO_VERSION) }));
  const ignore = gitignoreText(dir);
  if (ignore) content.set('.gitignore', ignore);
  if (plan.kind === 'brain') {
    const after = new Set([...plan.tracked.filter((r) => !tracked.some((m) => m.from === r)), ...tracked.map((m) => m.to)]);
    for (const d of [L2.topics, L2.decisions, L2.docs, L2.materialy]) {
      if (![...after].some((r) => under(r, d))) content.set(`${d}/.gitkeep`, '');
    }
  }
  return content;
}

/**
 * Files the move writes with a new content that the brain content checks (handover, memory, rules and others) refuse; the
 * pre-commit refuses them at --apply. Files only moved keep their content and are not checked (MIGRATE_MOVE_ENV).
 */
export function contentProblems(dir, plan) {
  if (plan.version !== FROM_VERSION) return [];
  const policy = loadPolicy(dir);
  const problems = [];
  const moves = allMoves(plan);
  for (const [rel, text] of moveContent(dir, plan, moves)) {
    for (const error of checkBrainFile(rel, text, { policy, version: TO_VERSION })) problems.push(error.startsWith(rel) ? error : `${rel}: ${error}`);
  }
  // Files the brain's writer adds (a project's material into temy/<topic>/ of the brain): the brain's checks.
  const into = moves.filter((m) => m.status === STATUS.toBrain);
  if (into.length) {
    const brainPolicy = loadPolicy(plan.brainDir);
    const label = path.basename(plan.brainDir);
    for (const m of into) {
      const content = fileContent(path.join(dir, m.from));
      for (const error of checkBrainFile(m.to, typeof content === 'string' ? content : null, { policy: brainPolicy, version: TO_VERSION })) problems.push(`${label}:${error.startsWith(m.to) ? error : `${m.to}: ${error}`}`);
    }
  }
  return problems;
}

function commitBrain(dir, moves, content, message, info = {}) {
  const ops = [];
  for (const m of moves) {
    if (m.removed) ops.push({ path: m.from, remove: true });
    else ops.push({ from: m.from, to: m.to });
  }
  for (const [rel, text] of content) ops.push({ path: rel, content: text });
  const ctx = { brainDir: dir, thread: threadId(), policy: loadPolicy(dir) };
  const res = brainWrite(ctx, { ops, message, internal: true, env: { [MIGRATE_MOVE_ENV]: '1' } });
  if (!res.committed) throw new Error('nothing committed');
  info.deployIgnores = res.deployIgnores || [];
  const warnings = (res.warnings || []).filter((w) => !w.startsWith('deploy ignore:'));
  if (warnings.length) process.stderr.write(`${warnings.join('\n')}\n`);
  return res.sha;
}

function commitProject(dir, moves, content, message, info = {}) {
  const env = { ...brainScriptEnv(), [MIGRATE_MOVE_ENV]: '1' };
  const head = git(['rev-parse', 'HEAD'], { cwd: dir }).stdout;
  const undo = () => { git(['reset', '--quiet', '--hard', head], { cwd: dir, env }); };
  for (const m of moves) {
    if (m.removed) { const r = git(['rm', '--quiet', '--', m.from], { cwd: dir, env }); if (!r.ok) { undo(); throw new Error(`git rm ${m.from}: ${firstLine(r.stderr)}`); } continue; }
    fs.mkdirSync(path.dirname(path.join(dir, m.to)), { recursive: true });
    const r = git(['mv', '--', m.from, m.to], { cwd: dir, env });
    if (!r.ok) { undo(); throw new Error(`git mv ${m.from} ${m.to}: ${firstLine(r.stderr)}`); }
  }
  for (const [rel, text] of content) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const add = git(['add', '--', ...content.keys()], { cwd: dir, env });
  if (!add.ok) { undo(); throw new Error(`git add: ${firstLine(add.stderr)}`); }
  // Layout 2: INDEX.md of the project repo (zdroje/, vystupy/) in the commit of the move, as every write of the workflow.
  // Deploy ignore files (.assetsignore ...) get the new internal folders and INDEX.md in the same commit (a static web repo, 2026-11-14).
  let deployIgnores;
  try { refreshIndex(dir, env); deployIgnores = refreshDeployIgnores(dir, env); } catch (err) { undo(); throw err; }
  const commit = git(['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} ${message}`], { cwd: dir, env });
  if (!commit.ok) { undo(); throw new Error(`commit failed: ${firstLine(commit.stderr || commit.stdout)}`); }
  info.deployIgnores = deployIgnores;
  return git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout;
}

/** Top folders of layout 2 (never sources of the move, never pruned). */
const NEW_TOPS = new Set(Object.values(L2).filter(Boolean).map((p) => p.split('/')[0]));

/** Top folders of layout 1 the move took files from (logs, topics, memory, agentic ...), by rows { from, to }. */
function sourceTops(rows) {
  const tops = rows.filter((r) => r.from && r.from !== r.to && r.from.includes('/')).map((r) => r.from.split('/')[0]);
  return [...new Set(tops)].filter((t) => !NEW_TOPS.has(t)).sort();
}

/** Folders under `rel` with no file in them, outermost only; a nested repository (.git) is never entered. */
function emptyFolders(dir, rel) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return { empty: false, list: [] }; }
  if (entries.some((e) => e.name === '.git')) return { empty: false, list: [] };
  let empty = true;
  const list = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) { empty = false; continue; }
    const sub = emptyFolders(dir, `${rel}/${e.name}`);
    if (sub.empty) list.push(`${rel}/${e.name}`);
    else { empty = false; list.push(...sub.list); }
  }
  return { empty, list: empty ? [] : list };
}

/** Empty folders (no file inside) left in the source folders of layout 1 after the move, by the rows of the record. */
export function oldEmptyFolders(dir, rows) {
  const out = [];
  for (const top of sourceTops(rows)) {
    const r = emptyFolders(dir, top);
    out.push(...(r.empty ? [top] : r.list));
  }
  return out.sort();
}

/**
 * After the move: the empty source folders of layout 1 are removed (only folders with no file inside: nothing with
 * content is deleted). Files git ignores in them stay and are listed. Returns { removed, ignored } (paths, posix).
 */
function pruneOldFolders(dir, rows) {
  const removed = [];
  for (const rel of oldEmptyFolders(dir, rows)) {
    try { fs.rmSync(path.join(dir, rel), { recursive: true }); removed.push(`${rel}/`); } catch { /* stays, the check reports it */ }
  }
  const ignored = [];
  for (const top of sourceTops(rows)) {
    if (!fs.existsSync(path.join(dir, top))) continue;
    const r = git([...GIT_PATHS, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', `${top}/`], { cwd: dir });
    if (r.ok && r.stdout) ignored.push(...r.stdout.split('\0').filter(Boolean));
  }
  return { removed, ignored };
}

/** The adapter command of a repository with .workflow.json (its generated .claude/), or null. */
export function adapterCommand(dir) {
  const cfg = readJson(path.join(dir, '.workflow.json'), null);
  return cfg?.brain ? `cd ${dir} && node ${path.join(PLUGIN_ROOT, 'bin', 'adapter.mjs')} claude-code --brain ${cfg.brain}` : null;
}

/** The adapter of a repository with .workflow.json (generated .claude/) runs again on the new layout. */
export function regenerateAdapter(dir) {
  const cfg = readJson(path.join(dir, '.workflow.json'), null);
  if (!cfg || !cfg.brain) return null;
  // WORKFLOW_NO_PUSH: a persona's adapter commits into the brain it moved and pushed the move before its check.
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'adapter.mjs'), 'claude-code', '--brain', cfg.brain], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_PROJECT_DIR: dir, WORKFLOW_NO_PUSH: '1' } });
  return { ok: r.status === 0, out: firstLine(r.status === 0 ? r.stdout : r.stderr || r.stdout) };
}

// ---- check ------------------------------------------------------------------------------------------------------------

/** The committed record: { kind, rows: [{ from, to, status }] }, or null. */
export function readRecord(dir) {
  let text;
  try { text = readText(dir, RECORD_REL); } catch { return null; }
  const kind = /^# kind (\w+)$/m.exec(text)?.[1] || null;
  const rows = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const [from, to, status] = l.split('\t'); return { from, to, status }; });
  return { kind, rows };
}

/**
 * The places of an archived topic for a target temy/<id>/<file>: the hidden archive .brain/archive/topics/<id>/<file>
 * (done --topic, done --archive-closed) and the archive of layout 1 topics/archive/<id>/<file>; [] for another path.
 */
function archivedTopicPlaces(rel) {
  if (!rel.startsWith(`${L2.topics}/`)) return [];
  const rest = rel.slice(L2.topics.length + 1);
  if (!rest.includes('/')) return [];
  return [`${L2.topicHidden}/${rest}`, `${L1.topicArchive}/${rest}`];
}

/** A file of the topic archive (hidden or of layout 1): history, not scanned for references. */
const inTopicArchive = (rel) => rel.startsWith(`${L2.topicHidden}/`) || rel.startsWith(`${L1.topicArchive}/`);

/**
 * The check after a move (also on its own): layout 2; every file tracked before the move has its new place or stays as
 * triage, never moved or in place; no reference in the records points to an old path; consolidate report has no new
 * problems (against `before` when the apply measured it). `outsideHere`: the apply just moved the files outside git on
 * this machine, so a missing one is a problem; otherwise (a later --check, a clone) it is only a note.
 */
export function checkMigration(dir, { before = null, project = null, cwd = process.cwd(), consolidate = null, outsideHere = false } = {}) {
  const problems = [];
  const notes = [];
  const outsideAway = [];
  const version = dataLayoutVersion(dir);
  if (version !== TO_VERSION) problems.push(`data layout is ${version}, not ${TO_VERSION}`);
  const rows = readRecord(dir)?.rows;
  if (!rows) return { ok: false, problems: [...problems, `${RECORD_REL} missing: no move record`], notes };
  const added = git(['log', '--diff-filter=A', '--format=%H', '-1', '--', RECORD_REL], { cwd: dir }).stdout;
  // -z: a name with diacritics came quoted ("\304\276") under core.quotepath and every such file was reported missing.
  const prior = added ? git([...GIT_PATHS, 'ls-tree', '-r', '-z', '--name-only', `${added}^`], { cwd: dir }) : { ok: false };
  const now = new Set(trackedFiles(dir).map((f) => f.rel));
  const byFrom = new Map(rows.map((r) => [r.from, r]));
  if (prior.ok) {
    for (const rel of prior.stdout.split('\0').filter(Boolean)) if (!byFrom.has(rel)) problems.push(`${rel}: tracked before the move, missing in ${RECORD_REL}`);
  } else notes.push('the commit before the move is not readable; files checked against the record only');
  const brainDir = repoKind(dir) === 'project' ? configuredBrain(dir) : null;
  for (const r of rows) {
    if (intoBrain(r)) {
      if (!brainDir) notes.push(`${r.from}: moved into the brain, which .workflow.json does not name; not checked`);
      else if (!fs.existsSync(path.join(brainDir, r.to))) problems.push(`${r.from}: moved into brain ${path.basename(brainDir)} to ${r.to}, not there`);
      if (now.has(r.from)) problems.push(`${r.from}: moved into the brain, still tracked here`);
      continue;
    }
    if (r.status === STATUS.removed) { if (now.has(r.from)) problems.push(`${r.from}: removed (pomocne), still tracked`); continue; }
    if (r.status === STATUS.deleted) { if (fs.existsSync(path.join(dir, r.from))) problems.push(`${r.from}: deleted (pomocne, outside git), still there`); continue; }
    if (r.status === STATUS.outside) {
      // Outside git the files exist only on the machine that ran the move: right after the apply a missing one is a
      // problem; a later --check (a fresh clone, another machine) has none of them by design, which is no error.
      if (!fs.existsSync(path.join(dir, r.to))) (outsideHere ? problems.push(`${r.from}: moved outside git to ${r.to}, not there`) : outsideAway.push(r));
      continue;
    }
    if (!now.has(r.to) && !archivedTopicPlaces(r.to).some((p) => now.has(p))) {
      const gone = removedByScript(dir, r.to);
      if (gone) notes.push(`${r.to}: removed after the move by ${gone.sha} (${gone.subject})`);
      else problems.push(`${r.from}: ${r.from === r.to ? 'should stay' : `new place ${r.to}`}, not tracked`);
    }
  }
  if (outsideAway.length) notes.push(`${outsideAway.length} file(s) the move put outside git are not here (${outsideAway.slice(0, 3).map((r) => r.to).join(', ')}${outsideAway.length > 3 ? ', …' : ''}): untracked work files exist only on the machine that ran the move, a clone or another machine has none; not checked`);
  problems.push(...deployIgnoreLines(deployIgnoreGaps(dir), `migrate.mjs ${dir} --check --fix`));
  problems.push(...branchProblems(dir));
  for (const rel of now) if (LAYOUT2_FOLDERS.has(rel)) problems.push(`${rel}: a tracked file on the path of a folder of data ${dataName(TO_VERSION)}; move it under ${rel}/ or elsewhere`);
  const index = version === TO_VERSION ? indexProblem(dir) : null;
  if (index) problems.push(`${INDEX_FILE}: ${index === 'missing' ? 'missing' : 'stale (differs from the tracked files)'} in HEAD; regenerate it: migrate.mjs ${dir} --check --fix`);
  for (const rel of oldEmptyFolders(dir, rows)) problems.push(`${rel}/: empty folder of data ${dataName(FROM_VERSION)} left after the move (no file inside; remove it)`);
  problems.push(...leftoverProblems(dir, { version: TO_VERSION, role: repoKind(dir), fix: `migrate.mjs ${dir} --check --fix` }));
  for (const s of staleCatalog(dir)) problems.push(`local/catalog: source ${s.name} is indexed on ${posix(s.indexed)}, the data is in ${posix(s.path)} now (moved): catalog.mjs find misses it; scan it again: migrate.mjs ${dir} --check --fix`);
  const stayed = rows.filter((r) => r.from === r.to).map((r) => r.from);
  const { find } = makeRewriter(rows.filter((r) => r.from !== r.to && relocated(r)), { tracked: stayed, kind: repoKind(dir) });
  const waiting = new Set(rows.filter((r) => r.status === STATUS.triageStay).map((r) => r.from));
  const covered = (rel) => rewritable(rel, repoKind(dir)) && !waiting.has(rel);
  for (const rel of now) {
    if (!covered(rel)) continue;
    let text;
    try { text = readText(dir, rel); } catch { continue; }
    for (const h of find(text)) problems.push(`${rel}: old path ${h.from} (now ${h.to})`);
  }
  const refs = changedPathRefs(dir, rows, [...now], { brainDir, stayed, covered, find });
  // The other repositories of the domain (its brain, the repos beside it) naming a path of this one the move changed.
  const cross = crossRepoRefs(dir, rows);
  for (const c of cross) problems.push(`${c.repo}/${c.file}:${c.line}: reference to ${path.basename(path.resolve(dir))} ${c.from}, which the move changed (now ${c.to}); ${c.to === 'removed' ? `remove or replace it in ${c.repo}` : /^[^/]+:/.test(c.to) && !c.inBrain ? `point it to the brain in ${c.repo}` : `rewrite it: migrate.mjs ${dir} --check --fix`}`);
  const run = consolidate ?? (repoKind(dir) === 'brain' && sessionBrainIs(dir, { project, cwd }));
  if (run) {
    const after = consolidateProblems(dir, { project, cwd });
    if (after.error) notes.push(`consolidate report not run: ${after.error}`);
    else if (before && !before.error) {
      const old = new Set(before.items);
      const fresh = after.items.filter((i) => !old.has(i));
      if (after.items.length > before.items.length) problems.push(`consolidate report: ${after.items.length - before.items.length} new problem(s): ${fresh.slice(0, 5).join('; ')}`);
    } else {
      const { find: oldRef } = makeRewriter(rows.filter((r) => r.from !== r.to && !intoBrain(r)), { kind: repoKind(dir) });
      const stale = after.items.filter((i) => oldRef(` ${i}`).length);
      if (stale.length) problems.push(`consolidate report: ${stale.length} problem(s) naming old paths: ${stale.slice(0, 5).join('; ')}`);
      notes.push(`consolidate report: ${after.items.length} problem(s) in all (no measurement from before the move)`);
    }
  } else notes.push('consolidate report not run (not the brain of this session)');
  const again = adapterCommand(dir);
  if (again) notes.push(`after git revert of the move run the adapter again: ${again}`);
  return { ok: !problems.length, problems, notes, refs, cross };
}

/**
 * Leftovers outside git in the folders of an older layout, as problems (doma-pc 2026-11-16): the junk with the command
 * that removes it, every other entry with its size, to triage with the operator. Shared by both checks (data 2.0, 2.1).
 */
export function leftoverProblems(dir, { version, role, fix, skip } = {}) {
  const found = leftovers(dir, { version, role, skip });
  const out = [];
  if (found.junk.length) out.push(`${junkText(found.junk)}: left outside git in folders of an older data layout; remove them: ${fix}`);
  for (const l of leftoverLines(found.other)) out.push(`${l}: outside git in a folder of an older data layout, left after the move; triage it with the operator: remove what is not needed, move the rest into the work folder of its topic (outside git, nothing is deleted without consent)`);
  return out;
}

/**
 * References in the tracked text files (md, json, html, txt) to paths the move changed: { file, line, from, to,
 * absolute } (to: the new path, `<brain>:<path>` for a file in the brain, `removed`). Relative paths and absolute ones
 * under the repository root. A file the check already reports old paths of (`covered`, the records the apply rewrote)
 * lists only the paths into the brain and the removed ones. Nothing is rewritten.
 */
export function changedPathRefs(dir, rows, files, { brainDir = null, stayed = [], covered = () => false, find = null } = {}) {
  const kind = repoKind(dir);
  const brainName = brainDir ? path.basename(brainDir) : 'brain';
  const moved = find || makeRewriter(rows.filter((r) => r.from !== r.to && relocated(r)), { tracked: stayed, kind }).find;
  const intoB = makeRewriter(rows.filter(intoBrain).map((r) => ({ from: r.from, to: `${brainName}:${r.to}` })), { tracked: stayed, kind }).find;
  const removed = makeRewriter(rows.filter(gone).map((r) => ({ from: r.from, to: 'removed' })), { kind, folders: false }).find;
  const roots = [...new Set([path.resolve(dir), (() => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } })()])].map((r) => `${posix(r)}/`);
  const out = [];
  for (const rel of files.sort()) {
    if (!REF_EXT.has(path.posix.extname(rel).toLowerCase()) || rel === RECORD_REL || inTopicArchive(rel)) continue;
    let text;
    try { text = readText(dir, rel); } catch { continue; }
    if (text.includes('\0')) continue;
    const finders = covered(rel) ? [intoB, removed] : [moved, intoB, removed];
    text.split('\n').forEach((line, i) => {
      const seen = new Set();
      const add = (hits, absolute) => {
        for (const h of hits) {
          const key = `${h.from}\t${absolute}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ file: rel, line: i + 1, from: h.from, to: h.to, absolute });
        }
      };
      for (const f of finders) add(f(line), false);
      // An absolute path under the repository root: the part after the root, read as a relative path.
      if (roots.some((r) => line.includes(r))) {
        const relLine = roots.reduce((l, r) => l.split(r).join(' '), line);
        for (const f of finders) add(f(relLine), true);
      }
    });
  }
  return out;
}

/** A prefix of another repository's path to `dir` (absolute, ../<name>/, <name>/) and the path after it (group 2). */
const prefixRefRe = (prefixes) => new RegExp(`(${prefixes.map(escRe).join('|')})([^\\s)\\]}>"'\`,;|*]+)`, 'g');

/**
 * Repositories whose files may name paths of `dir`: the brain its .workflow.json names and, in a domain folder (marker
 * .agentic-domain beside `dir`), every other git repository there. Outside a domain folder only the brain.
 */
export function domainRepoDirs(dir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const self = real(dir);
  const out = [];
  const add = (d) => { if (d && fs.existsSync(path.join(d, '.git')) && real(d) !== self && !out.some((o) => real(o) === real(d))) out.push(d); };
  if (repoKind(dir) === 'project') add(configuredBrain(dir));
  const parent = path.dirname(path.resolve(dir));
  if (fs.existsSync(path.join(parent, DOMAIN_MARKER))) {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) add(path.join(parent, e.name));
  }
  return out;
}

/**
 * References in the other repositories of the domain (domainRepoDirs) to paths of `dir` the move changed or removed:
 * [{ repo, file, line, from, to }] (to: the new path, `removed`, or `<brain>:<path>`). A reference is a path relative to
 * `dir` (relates_to: [docs/x.md], a path in a skill text), one prefixed by the repository name (web/docs/x.md)
 * or its absolute path; a path the referring repository tracks itself is its own file, not a reference. Nothing is
 * rewritten (pilot 2026-11-14: relates_to and a skill of the domain brain named docs/ of the moved web repo).
 */
export function crossRepoRefs(dir, rows) {
  const kind = repoKind(dir);
  const name = path.basename(path.resolve(dir));
  const brainDir = kind === 'project' ? configuredBrain(dir) : null;
  const brainName = brainDir ? path.basename(brainDir) : 'brain';
  const pairs = [
    ...rows.filter((r) => r.from !== r.to && relocated(r)),
    ...rows.filter(intoBrain).map((r) => ({ from: r.from, to: `${brainName}:${r.to}` })),
    ...rows.filter(gone).map((r) => ({ from: r.from, to: 'removed' })),
  ];
  if (!pairs.length) return [];
  const stayed = rows.filter((r) => r.from === r.to).map((r) => r.from);
  const { find } = makeRewriter(pairs, { tracked: stayed, kind });
  const prefixes = [...new Set([path.resolve(dir), (() => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } })()].map((r) => `${posix(r)}/`)), `../${name}/`, `${name}/`];
  const out = [];
  for (const other of domainRepoDirs(dir)) {
    let files;
    try { files = trackedFiles(other).map((f) => f.rel); } catch { continue; }
    const own = new Set(files);
    const repoLabel = path.basename(other);
    const inBrain = !!brainDir && path.resolve(other) === path.resolve(brainDir);
    for (const rel of files.sort()) {
      if (!REF_EXT.has(path.posix.extname(rel).toLowerCase()) || rel === RECORD_REL || inTopicArchive(rel)) continue;
      let text;
      try { text = readText(other, rel); } catch { continue; }
      if (text.includes('\0')) continue;
      text.split('\n').forEach((line, i) => {
        const seen = new Set();
        // Prefixed: only the path right after a prefix (a bare path elsewhere on the line stays bare, so the own file of
        // the referring repo is not counted; report-ed8bbae2). A bare match never starts after a prefix (`/` before it).
        const prefixedHits = [...line.matchAll(prefixRefRe(prefixes))].flatMap((m) => find(` ${m[2]}`));
        const hits = [...find(line).map((h) => ({ ...h, prefixed: false })), ...prefixedHits.map((h) => ({ ...h, prefixed: true }))];
        for (const h of hits) {
          const bare = h.from.replace(/\/$/, '');
          // A bare path the referring repository has itself is its own file.
          if (!h.prefixed && (own.has(bare) || files.some((f) => f.startsWith(`${bare}/`)))) continue;
          if (seen.has(h.from)) continue;
          seen.add(h.from);
          out.push({ repo: repoLabel, file: rel, line: i + 1, from: h.from, to: h.to, inBrain });
        }
      });
    }
  }
  return out;
}

/**
 * --check --fix: the references crossRepoRefs reports rewritten to the new paths in the other repositories of the domain,
 * one commit per repository (brain script tag, not pushed; git revert brings them back). A path relative to `dir`, one
 * prefixed by its name (web/docs/x.md, ../web/docs/x.md) or its absolute path keeps its form; a file moved into the brain
 * becomes the brain's own path in the brain (elsewhere it stays reported). A reference to a removed file is not rewritten
 * (stays reported). A file with uncommitted changes is skipped (listed), as is a repository with staged changes. Cause:
 * the check listed these references and no command of the workflow could rewrite them (a decision is replaced only by
 * --supersedes, a handover only by its holder; report-ed8bbae2, 2026-11-15).
 * Returns [{ repo, files: [{ file, count }], skipped: [file], sha, error }] (sha null when nothing was rewritten).
 */
export function fixCrossRefs(dir, rows = readRecord(dir)?.rows || []) {
  const kind = repoKind(dir);
  const name = path.basename(path.resolve(dir));
  const brainDir = kind === 'project' ? configuredBrain(dir) : null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const stayed = rows.filter((r) => r.from === r.to).map((r) => r.from);
  const moved = rows.filter((r) => r.from !== r.to && relocated(r));
  const prefixes = [...new Set([path.resolve(dir), real(dir)].map((r) => `${posix(r)}/`)), `../${name}/`, `${name}/`];
  const prefixRe = prefixRefRe(prefixes);
  const out = [];
  for (const other of domainRepoDirs(dir)) {
    const isBrain = brainDir && real(other) === real(brainDir);
    const pairs = [...moved, ...(isBrain ? rows.filter(intoBrain) : [])];
    if (!pairs.length) continue;
    const { rewrite } = makeRewriter(pairs, { tracked: stayed, kind });
    const res = { repo: path.basename(other), files: [], skipped: [], sha: null, error: null };
    let files;
    try { files = trackedFiles(other).map((f) => f.rel); } catch { continue; }
    const own = new Set(files);
    const isOwn = (p) => { const bare = p.replace(/\/$/, ''); return own.has(bare) || files.some((f) => f.startsWith(`${bare}/`)); };
    // Not git(): it trims the output and the first entry ` M file` would lose its first character.
    const st = spawnSync('git', [...GIT_PATHS, 'status', '--porcelain', '-z', '--untracked-files=no'], { cwd: other, encoding: 'utf8' });
    const dirty = new Set((st.stdout || '').split('\0').filter(Boolean).map((l) => l.slice(3)));
    for (const rel of files.sort()) {
      if (!REF_EXT.has(path.posix.extname(rel).toLowerCase()) || rel === RECORD_REL || inTopicArchive(rel)) continue;
      let text;
      try { text = readText(other, rel); } catch { continue; }
      if (text.includes('\0')) continue;
      let count = 0;
      // Prefixed: the path after the prefix, always a reference to `dir`; bare: not a path the repository has itself.
      let next = text.replace(prefixRe, (all, pre, raw) => {
        const r = rewrite(` ${raw}`);
        if (!r.hits.length) return all;
        count += r.hits.length;
        return `${pre}${r.text.slice(1)}`;
      });
      const bare = rewrite(next, { accept: (p) => !isOwn(p) });
      count += bare.hits.length;
      next = bare.text;
      if (!count || next === text) continue;
      if (dirty.has(rel)) { res.skipped.push(rel); continue; }
      fs.writeFileSync(path.join(other, rel), next);
      res.files.push({ file: rel, count });
    }
    if (res.files.length) {
      const paths = res.files.map((f) => f.file);
      if (!git(['diff', '--cached', '--quiet'], { cwd: other }).ok) {
        git(['checkout', '--', ...paths], { cwd: other });
        res.error = 'staged changes; commit or unstage them first (the rewritten files are committed alone)';
        res.files = [];
      } else {
        const c = spawnSync('git', ['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} rewrite references to moved paths of ${name} (migrate --check --fix)`, '--', ...paths], { cwd: other, encoding: 'utf8', env: { ...process.env, ...brainScriptEnv() } });
        if (c.status !== 0) {
          git(['checkout', '--', ...paths], { cwd: other });
          res.error = `commit failed: ${firstLine(c.stderr || c.stdout)}`;
          res.files = [];
        } else res.sha = git(['rev-parse', '--short', 'HEAD'], { cwd: other }).stdout;
      }
    }
    if (res.files.length || res.skipped.length || res.error) out.push(res);
  }
  return out;
}

/** Lines of the --check --fix output for fixCrossRefs. */
export function formatCrossFix(results) {
  const lines = [];
  for (const r of results) {
    if (r.sha) lines.push(`${r.repo}: references rewritten in ${r.files.map((f) => `${f.file} (${f.count})`).join(', ')}, committed ${r.sha} (not pushed; undo: git revert ${r.sha})`);
    if (r.error) lines.push(`${r.repo}: references not rewritten: ${r.error}`);
    if (r.skipped.length) lines.push(`${r.repo}: skipped (uncommitted changes): ${r.skipped.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * --check --fix: INDEX.md of a layout 2 repository written again from its tracked files and committed alone (brain script
 * tag, not pushed). Refused with staged changes (they would get into the index). Returns { sha } or { sha: null } when
 * current.
 */
export function fixIndex(dir) {
  if (dataLayoutVersion(dir) !== TO_VERSION) throw new Error(`${dir}: data ${dataName(dataLayoutVersion(dir))}, ${INDEX_FILE} only in data ${dataName(TO_VERSION)}`);
  if (!git(['diff', '--cached', '--quiet'], { cwd: dir }).ok) throw new Error(`${dir}: staged changes; commit or unstage them first (${INDEX_FILE} is built from the staged files)`);
  if (!indexProblem(dir)) return { sha: null };
  const committed = commitIndexAfterMerge(dir, { env: brainScriptEnv(), message: `${BRAIN_COMMIT_TAG} regenerate ${INDEX_FILE} (migrate --check --fix)` });
  return { sha: committed ? git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout : null };
}

/**
 * The commit of a brain script that removed `rel` after the move (save ... --remove, a skill or record dropped on purpose):
 * { sha, subject }, or null when the last removal was no brain script's (a move lost the file). A check names it as a note.
 */
export function removedByScript(dir, rel) {
  const r = git([...GIT_PATHS, 'log', '-1', '--diff-filter=D', '--format=%h%x09%s', '--', rel], { cwd: dir });
  if (!r.ok || !r.stdout) return null;
  const [sha, ...rest] = r.stdout.split('\t');
  const subject = rest.join('\t');
  return subject.startsWith(`${BRAIN_COMMIT_TAG} `) ? { sha, subject } : null;
}

/**
 * --check --fix: the deploy ignore files of a repository of data 2.0 or 2.1 get the internal entries they miss (refreshDeployIgnores,
 * as on every write of the workflow) in one commit (brain script tag, not pushed). Refused with staged changes. Returns
 * { added: [{ file, added }], sha } (sha null when nothing was missing).
 */
export function fixDeployIgnores(dir) {
  const v = dataLayoutVersion(dir);
  if (v !== TO_VERSION && v !== 3) throw new Error(`${dir}: data ${dataName(v)}, deploy ignores are filled only in data ${dataName(TO_VERSION)} and 2.1`);
  if (!deployIgnoreGaps(dir).length) return { added: [], sha: null };
  if (!git(['diff', '--cached', '--quiet'], { cwd: dir }).ok) throw new Error(`${dir}: staged changes; commit or unstage them first (the deploy ignore files are committed alone)`);
  const env = brainScriptEnv();
  const added = refreshDeployIgnores(dir, env);
  const c = spawnSync('git', ['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} add internal data to deploy ignores (migrate --check --fix)`, '--', ...added.map((x) => x.file)], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (c.status !== 0) throw new Error(`commit of the deploy ignore files failed: ${firstLine(c.stderr || c.stdout)}`);
  return { added, sha: git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).stdout };
}

export function formatCheck(check) {
  const lines = [check.ok ? 'check: ok' : `check: ${check.problems.length} problem(s)`];
  for (const p of check.problems) lines.push(`  ${p}`);
  for (const n of check.notes) lines.push(`  note: ${n}`);
  if (check.refs?.length) {
    lines.push(`references to paths the move changed (${check.refs.length}; not rewritten, fix them by hand where needed):`);
    for (const r of check.refs) lines.push(`  ${r.file}:${r.line}: ${r.absolute ? 'absolute ' : ''}${r.from} -> ${r.to}`);
  }
  return lines.join('\n');
}
