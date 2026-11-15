// Sorting of a topic's content in data layout 2 (D-0058, D-0059, D-0060). What can be sorted at once is sorted at once
// (knowledge with save, a source with materialy add, a work file in tmp/, a finished document with save.mjs promote);
// what cannot, stays in the topic and is sorted by the triage at done --topic of every topic with work files outside
// tmp/, whoever gave it. The agent gives every file a class (dokument, zdroj, stav, pomocne); a file it cannot sort it
// marks nejasne, and the operator confirms those (a dialog of the thread that may ask the operator, else the answer of the
// orchestrator by mail, D-0031). A triage without unclear files runs without a question. A move is a rename in git
// (history stays), a removal is a removal in git (git restores it); INDEX.md goes into the same commit (brainWrite). A
// topic with a project repo beside the brain (D-0056) sends documents and sources to that repo (outputRepo), unless the
// line says @brain (several projects or the agent): the file is committed there first, then removed from the brain.
import fs from 'node:fs';
import path from 'node:path';
import { git, toPosix } from './util.mjs';
import { isWakeTurn, dialogAnsweredInTurn, mainCheckout } from './config.mjs';
import { bellContinuation } from './waker.mjs';
import { brainWrite, readHolder, isHolderOf } from './brain.mjs';
import { dataLayoutVersion, dataPath, dataRel, layoutOf, relPath, workDirFor, separateProject } from './layout.mjs';
import { readTopicRecord } from './topic-files.mjs';

/** Who gave the topic (`assigned_by` of .tema.json): the operator (topic create from a thread) or code. */
export const ASSIGNED_OPERATOR = 'operator';
export const ASSIGNED_TECHNICAL = 'technical';
/** Folder of the accepted worker results of a topic (one file per result, hooks/subagent-stop.mjs). */
export const CONCLUSIONS_DIR = 'zavery';

/**
 * Classes of the content of a topic (D-0059), the targets of a triage line `<class>[@brain] <path>`. The question: would
 * a new agent in a new session have to find out, collect or make it again? dokument (a synthesis, audit, analysis,
 * comparison, documentation) -> vystupy/dokumenty/; zdroj (downloaded data, exports, material of a client) ->
 * zdroje/<topic>/; stav (work in progress the topic still needs) -> stays in the topic; pomocne (a one-off script, an
 * intermediate result, a log) -> removed (git rm). vedomost (a fact, decision, procedure, rule) is written with save and
 * is no target of the triage. `nejasne <path>`: the agent cannot sort it; `nejasne:<class> <path>`: the class the operator
 * confirmed for it.
 */
export const CLASSES = Object.freeze(['dokument', 'zdroj', 'stav', 'pomocne']);
export const UNCLEAR = 'nejasne';
/** `@brain`: a document or source of several projects or of the agent goes to the brain, not to the project repo. */
export const BRAIN_SUFFIX = '@brain';
/** Classes that take a file out of the topic to the documents or the sources: the ones that take @brain. */
export const MOVED_CLASSES = Object.freeze(['dokument', 'zdroj']);
const MOVED = new Set(MOVED_CLASSES);
const CLASS_FOLDER = Object.freeze({ dokument: 'docs', zdroj: 'materialy', stav: 'topics' });

/**
 * Target of a class in a repo of data layout `version` (D-0059), the one rule of done --topic and migrate.mjs: dokument
 * -> vystupy/dokumenty/<name>, zdroj -> zdroje/<topic>/<name>, stav -> temy/<topic>/<name> (layout 1: docs/,
 * materialy/<topic>/, topics/<topic>/). `name`: the path below that folder ('' for the folder itself).
 */
export function classTargetIn(version, cls, topic, name = '') {
  const key = CLASS_FOLDER[cls];
  if (!key) throw new Error(`class ${cls} has no target folder`);
  const base = cls === 'dokument' ? relPath(key, version) : `${relPath(key, version)}/${topic}`;
  return name ? path.posix.join(base, name) : base;
}

/** A topic without the field was given by the operator (every topic made before layout 2 recorded it). */
export const assignedBy = (topic) => (topic?.assigned_by === ASSIGNED_TECHNICAL ? ASSIGNED_TECHNICAL : ASSIGNED_OPERATOR);

/** Triage and promote exist only in a brain of layout 2. */
export const hasTriage = (brainDir) => !!brainDir && dataLayoutVersion(brainDir) === 2;

// The own steps a bell turn may run for a topic it holds (agent-alice/D-0094): the step written in its handover or its task.
const OWN_STEPS = {
  done: /(?<![\w-])done(?:\.mjs)?\s+(?:[^\n;]*\s)?--topic(?![\w-])|(?<!\p{L})(?:uzavr\p{L}*|zatvor\p{L}*|close)\s+(?:\p{L}+\s+)?(?:tém\p{L}*|topic)(?!\p{L})/iu,
  promote: /(?<![\w-])promote(?![\w-])/i,
};

/** The texts of a held topic that may order its own step: Zadanie and Ďalší krok of its handover, and its task. */
function ownStepTexts(brainDir, id) {
  const L = layoutOf(brainDir);
  let handover = '';
  try { handover = fs.readFileSync(path.join(dataPath(brainDir, 'topics', id), L.handover), 'utf8'); } catch { /* none */ }
  const section = (name) => {
    const lines = handover.split('\n');
    const i = lines.findIndex((l) => l.trim() === name);
    if (i === -1) return '';
    const end = lines.findIndex((l, j) => j > i && /^## /.test(l.trim()));
    return lines.slice(i + 1, end === -1 ? lines.length : end).join('\n');
  };
  return [section('## Zadanie'), section('## Ďalší krok'), String(readTopicRecord(brainDir, id)?.task || '')];
}

/**
 * agent-alice/D-0094 (P-076): in a turn from a bell, done --topic and save.mjs promote of a topic this thread holds run when
 * the topic itself orders them: its handover (Zadanie, Ďalší krok) or its task names the step. The text of the message
 * never counts (P-047 stays for taking over another topic and changing rules). Before, the refusal armed a timer and a
 * new turn only to run the same step.
 */
export function ownStepRequested(brainDir, thread, id, step) {
  if (!brainDir || !thread || !id || !OWN_STEPS[step]) return false;
  if (!isHolderOf(readHolder(brainDir, id), thread)) return false;
  return ownStepTexts(brainDir, id).some((text) => OWN_STEPS[step].test(text));
}

/**
 * A turn started by a bell never sorts nor removes topic files (P-047), not even with an answer; except the own step of a
 * held topic its handover or task orders (`own`: { topic, step }, ownStepRequested).
 */
export function bellRefusal(brainDir, thread, what, own = null) {
  if (!thread) return `${what} needs a stable thread id (P-038)`;
  if (isWakeTurn(brainDir, thread) && !(own && ownStepRequested(brainDir, thread, own.topic, own.step))) return `${what} refused: this turn was started by a message, never by the operator; a turn from a bell does not sort or remove topic files (P-047)${bellContinuation(brainDir, thread) || '. Save the step with save handover --next and run it in the next turn (continue from handover)'}`;
  return null;
}

/** The operator confirmed in this turn: a dialog answered in it, and the turn was not started by a bell (P-047). */
export function confirmRefusal(brainDir, thread, what) {
  const bell = bellRefusal(brainDir, thread, what);
  if (bell) return bell;
  if (!dialogAnsweredInTurn(brainDir, thread)) return `${what} refused: the operator answered no dialog in this turn; ask the operator with AskUserQuestion and run it again in the turn of the answer (D-0058)`;
  return null;
}

/** Files of a topic (paths relative to temy/<id>/, posix, sorted), except the handover, .tema.json, handoffs.json and tmp/. */
export function topicFiles(brainDir, id, root = path.join(brainDir, layoutOf(brainDir).topics, id)) {
  const L = layoutOf(brainDir);
  // handoffs.json is code's record of the topic's handoffs (agent-alice/D-0082), not a result to triage.
  const skip = new Set([L.handover, L.topicFile, 'handoffs.json']);
  const found = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!(rel === '' && e.name === L.topicTmp)) walk(path.join(dir, e.name), r); }
      else if (e.isFile() && !(rel === '' && skip.has(e.name))) found.push(r);
    }
  };
  walk(root, '');
  return found.sort();
}

/** Path in brain of a topic file (relative to the topic, or temy/<id>/..., or absolute inside the topic). */
export function topicFileRel(brainDir, id, file) {
  const base = dataRel(brainDir, 'topics', id);
  let rel = toPosix(String(file)).replace(/^\.\//, '');
  if (path.isAbsolute(String(file))) rel = toPosix(path.relative(brainDir, String(file)));
  if (rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1);
  return rel;
}

/**
 * Repo that receives the documents and sources of a topic (D-0056): the project repo of the session (its main checkout)
 * when it is another repo than the brain, else the brain (a persona, a brain session, no project). Its own layout names
 * the folders (dataRel(repo, 'docs'): layout 2 vystupy/dokumenty/, layout 1 docs/; 'materialy': zdroje/ or materialy/).
 */
export function outputRepo(ctx) {
  if (!separateProject(ctx?.brainDir, ctx?.projectDir)) return ctx?.brainDir || null;
  const main = mainCheckout(ctx.projectDir);
  return path.resolve(main) === path.resolve(ctx.brainDir) ? ctx.brainDir : main;
}

/** The outputs go to another repo than the brain (a move between repos, not a rename in the brain). */
const otherRepo = (brainDir, repo) => !!repo && path.resolve(repo) !== path.resolve(brainDir);

/** How a message names the documents folder of the output repo: `vystupy/dokumenty/` or `vystupy/dokumenty/ of the project repo <name>`. */
export function docsLabel(brainDir, repo = brainDir) {
  const docs = `${dataRel(repo, 'docs')}/`;
  return otherRepo(brainDir, repo) ? `${docs} of the project repo ${path.basename(repo)}` : docs;
}

/** How a message names the sources folder of a topic in the output repo. */
export function sourcesLabel(brainDir, id, repo = brainDir) {
  const src = `${dataRel(repo, 'materialy', id)}/`;
  return otherRepo(brainDir, repo) ? `${src} of the project repo ${path.basename(repo)}` : src;
}

/** Target in the documents of a repo (vystupy/dokumenty/ or docs/) of a topic file: its name, a name already there is an error (nothing is overwritten). */
export function docTarget(repo, rel) {
  return classTargetIn(dataLayoutVersion(repo), 'dokument', null, path.posix.basename(rel));
}

/** Target of a source of topic `id` in a repo: zdroje/<id>/<name> (layout 1 materialy/<id>/<name>). */
export function sourceTarget(repo, id, rel) {
  return classTargetIn(dataLayoutVersion(repo), 'zdroj', id, path.posix.basename(rel));
}

/** The list for the agent at done --topic: one line per file, `?` for the class the agent gives. */
export function triageListing(brainDir, id, files, repo = brainDir) {
  const intoRepo = otherRepo(brainDir, repo);
  return [
    `triage: topic ${id} has ${files.length} work file(s) outside tmp/ and is not closed (D-0059). Give every file its class by the question "would a new agent in a new session have to find out, collect or make it again?": dokument (synthesis, audit, analysis, comparison, documentation: moves it to ${docsLabel(brainDir, repo)}), zdroj (downloaded data, exports, material of a client: moves it to ${sourcesLabel(brainDir, id, repo)}), stav (work in progress the topic still needs: stays in the topic), pomocne (one-off script, intermediate result, log: removed, git restores it)${intoRepo ? `; dokument${BRAIN_SUFFIX} or zdroj${BRAIN_SUFFIX} for a file of several projects or of the agent (goes to the brain)` : ''}. Knowledge (fact, decision, procedure, rule) is no class here: write it with save first. A file you cannot sort: "${UNCLEAR} <path>". Write the list to a file, one line "<class> <path>" per file (a file left out stays), and run: done.mjs --topic --verified "<observation>" --knowledge "<...>" --triage <file>`,
    ...files.map((f) => `? ${f}`),
  ].join('\n');
}

/**
 * Parse a triage list: { dokument: [{ rel, brain }], zdroj: [{ rel, brain }], stav: [rel], pomocne: [rel],
 * unclear: [rel] (not sorted), confirmed: [rel] (sorted by the operator), errors: [] }; rel relative to the topic.
 */
export function parseTriage(text, files) {
  const known = new Set(files);
  const plan = { dokument: [], zdroj: [], stav: [], pomocne: [], unclear: [], confirmed: [], errors: [] };
  const seen = new Set();
  const usage = `"<class> <path>", class ${CLASSES.join(' | ')} (dokument and zdroj also with ${BRAIN_SUFFIX}), "${UNCLEAR} <path>" or "${UNCLEAR}:<class> <path>" (confirmed by the operator)`;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) { plan.errors.push(`line "${line}": expected ${usage}`); continue; }
    let target = m[1];
    const rel = m[2].trim();
    let confirmed = false;
    if (target === UNCLEAR) {
      if (!known.has(rel)) { plan.errors.push(`${rel}: not a file of the topic (listed: ${files.join(', ') || 'none'})`); continue; }
      if (seen.has(rel)) { plan.errors.push(`${rel}: listed twice`); continue; }
      seen.add(rel);
      plan.unclear.push(rel);
      continue;
    }
    if (target.startsWith(`${UNCLEAR}:`)) { confirmed = true; target = target.slice(UNCLEAR.length + 1); }
    const brain = target.endsWith(BRAIN_SUFFIX);
    const cls = brain ? target.slice(0, -BRAIN_SUFFIX.length) : target;
    if (!CLASSES.includes(cls) || (brain && !MOVED.has(cls))) { plan.errors.push(`line "${line}": expected ${usage}`); continue; }
    if (!known.has(rel)) { plan.errors.push(`${rel}: not a file of the topic (listed: ${files.join(', ') || 'none'})`); continue; }
    if (seen.has(rel)) { plan.errors.push(`${rel}: listed twice`); continue; }
    seen.add(rel);
    if (confirmed) plan.confirmed.push(rel);
    plan[cls].push(MOVED.has(cls) ? { rel, brain } : rel);
  }
  for (const f of files) if (!seen.has(f)) plan.stav.push(f);
  return plan;
}

/** Files a plan takes out of the topic (moved or removed). */
export const leavingFiles = (plan) => [...plan.dokument.map((e) => e.rel), ...plan.zdroj.map((e) => e.rel), ...plan.pomocne];

const tracked = (brainDir, rel) => git(['ls-files', '--error-unmatch', '--', rel], { cwd: brainDir }).ok;
const changed = (brainDir, rel) => !tracked(brainDir, rel) || !git(['diff', '--quiet', 'HEAD', '--', rel], { cwd: brainDir }).ok;

/**
 * Ops that record topic files not yet committed as they are (a work file written by hand), so that the move keeps their
 * history and git restores a removed one. Empty when all are committed.
 */
export function recordOps(brainDir, rels) {
  return rels.filter((rel) => changed(brainDir, rel)).map((rel) => ({ path: rel, content: fs.readFileSync(path.join(brainDir, ...rel.split('/'))) }));
}

/** Repo and target of a moved entry of a plan: the brain for @brain or without a project repo, else the output repo. */
export function entryTarget(brainDir, id, cls, entry, repo = brainDir) {
  const into = entry.brain ? brainDir : repo;
  return { repo: into, to: cls === 'zdroj' ? sourceTarget(into, id, entry.rel) : docTarget(into, entry.rel) };
}

/**
 * Ops of a plan and the errors that stop it (a target that exists). A move into the brain is a rename in git; a move into
 * another repo (the project repo, D-0056) is an export ({ repo, from, to, content }, written into that repo first) and a
 * removal in the brain (`ops`), so the brain changes only after the project repo has the file. `moved`: [{ cls, from, to,
 * repo }] for the summary.
 */
export function triageOps(brainDir, id, plan, repo = brainDir) {
  const base = dataRel(brainDir, 'topics', id);
  const ops = [];
  const exports = [];
  const moved = [];
  const errors = [];
  const targets = new Set();
  for (const cls of MOVED) {
    for (const entry of plan[cls] || []) {
      const t = entryTarget(brainDir, id, cls, entry, repo);
      const other = otherRepo(brainDir, t.repo);
      const where = other ? `${path.basename(t.repo)}/${t.to}` : t.to;
      if (fs.existsSync(path.join(t.repo, ...t.to.split('/'))) || targets.has(where)) { errors.push(`${base}/${entry.rel}: ${where} exists already; rename the file in the topic first`); continue; }
      targets.add(where);
      moved.push({ cls, from: `${base}/${entry.rel}`, to: t.to, where, repo: t.repo });
      if (!other) { ops.push({ from: `${base}/${entry.rel}`, to: t.to }); continue; }
      exports.push({ repo: t.repo, from: `${base}/${entry.rel}`, to: t.to, content: fs.readFileSync(path.join(brainDir, base, ...entry.rel.split('/'))) });
      ops.push({ path: `${base}/${entry.rel}`, remove: true });
    }
  }
  for (const rel of plan.pomocne || []) ops.push({ path: `${base}/${rel}`, remove: true });
  return { ops, exports, moved, errors };
}

/**
 * Write the exports of a triage (triageOps) into their repo and commit them there, INDEX.md of a repo in layout 2 in the
 * same commit (brainWrite on that repo, as materialy.mjs add writes the sources of a project). A refused commit leaves
 * nothing behind there and throws: the caller writes nothing into the brain then. Returns the write result.
 */
export function exportOutputs(ctx, repo, exports, message) {
  if (!exports?.length) return null;
  return brainWrite({ brainDir: repo, thread: ctx.thread, policy: ctx.policy }, { ops: exports.map(({ to, content }) => ({ path: to, content })), message, sync: false });
}

/** Handover lines of a done triage: what went where. */
export function triageSummary(brainDir, id, plan, moved = []) {
  const base = dataRel(brainDir, 'topics', id);
  const done = [];
  const of = (cls) => moved.filter((m) => m.cls === cls).map((m) => `${m.from} -> ${m.where}`);
  if (of('dokument').length) done.push(`triáž: dokument ${of('dokument').join(', ')}`);
  if (of('zdroj').length) done.push(`triáž: zdroj ${of('zdroj').join(', ')}`);
  if (plan.stav.length) done.push(`triáž: stav, ostáva v téme ${plan.stav.map((r) => `${base}/${r}`).join(', ')}`);
  if (plan.pomocne.length) done.push(`triáž: pomocné, zmazané (git rm, obnoví git) ${plan.pomocne.map((r) => `${base}/${r}`).join(', ')}`);
  if (plan.confirmed?.length) done.push(`triáž: nejasné potvrdil operátor ${plan.confirmed.map((r) => `${base}/${r}`).join(', ')}`);
  return done;
}

/** The task of a handover (text under "## Zadanie"), '-' when none. */
export function handoverTask(text) {
  const m = /## Zadanie\n([\s\S]*?)\n## /.exec(String(text || ''));
  return (m ? m[1].trim() : '') || '-';
}

/**
 * Remove tmp/ of the closing topic (outside git): temy/<id>/tmp/ of the brain and of a project in layout 2, and the
 * given folders (tmp/ of a topic moved to the hidden archive); nothing else. Returns the removed folders (absolute).
 */
export function removeTopicTmp(brainDir, projectDir, id, extra = []) {
  const dirs = new Set(extra.map((d) => path.resolve(d)));
  for (const root of [brainDir, projectDir]) {
    if (!root || dataLayoutVersion(root) !== 2) continue;
    dirs.add(path.resolve(workDirFor(root, id)));
  }
  const removed = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/** File name of a worker conclusion: <time>-<agent>.md, lowercase (P-049): 20261114-101500-<agent>.md (UTC). */
export function conclusionName(at, agent) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(at));
  const time = m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : 'unknown-time';
  const who = String(agent || 'worker').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
  return `${time}-${who}.md`;
}

/** Text of a worker conclusion: the first line of its task as the heading, then the result. */
export function conclusionText({ task, agent, result }) {
  const heading = String(task || '').replace(/\s+/g, ' ').trim() || `Záver pracovníka ${agent || 'worker'}`;
  return `# ${heading}\n\n${String(result || '').trim()}\n`;
}
