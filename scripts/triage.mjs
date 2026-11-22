// Sorting of a topic's content. Data layout 3 (flow v2 spec 5, plan B12): at done --topic every file of topics/<topic>/
// (outside tmp/, the handover and .tema.json) gets a line: a type of outputs (a folder of vystupy/ of the main target repo
// of the topic, the topic in the header of the file), a new type the operator approves (`novy:<typ>`), or `zanikne` (it
// ends with the topic and stays in the history of git); a file the agent cannot sort is `nejasne`, a question to the
// operator. The classes of data layout 2 (D-0059: dokument, zdroj, stav, pomocne) remain only as the targets of the
// migration of an older repo (scripts/migrate.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { removeTree } from './util.mjs';
import { isWakeTurn, supervisorTurn, dialogAnsweredInTurn } from './config.mjs';
import { bellContinuation } from './waker.mjs';
import { brainWrite, readHolder, isHolderOf } from './brain.mjs';
import { dataPath, layoutOf, relPath, workDirFor, hasData, hasScratch } from './layout.mjs';
import { readTopicRecord } from './topic-files.mjs';

/** Who gave the topic (`assigned_by` of .tema.json): the operator (topic create from a thread) or code. */
export const ASSIGNED_OPERATOR = 'operator';
export const ASSIGNED_TECHNICAL = 'technical';

/**
 * Classes of the content of a topic in data layout 2 (D-0059), the targets of a migration line (scripts/migrate.mjs) `<class>[@brain] <path>`. The question: would
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
const CLASS_FOLDER = Object.freeze({ dokument: 'docs', zdroj: 'materialy', stav: 'topics' });

/**
 * Target of a class in a repo of data layout `version` (D-0059), the one rule of done --topic and migrate.mjs: dokument
 * -> vystupy/dokumenty/<name>, zdroj -> zdroje/<topic>/<name>, stav -> temy/<topic>/<name> (layout 1: docs/,
 * materialy/<topic>/, topics/<topic>/). `name`: the path below that folder ('' for the folder itself).
 */
export function classTargetIn(version, cls, topic, name = '', role = undefined) {
  const key = CLASS_FOLDER[cls];
  if (!key) throw new Error(`class ${cls} has no target folder`);
  const base = cls === 'dokument' ? relPath(key, version, role) : `${relPath(key, version, role)}/${topic}`;
  return name ? path.posix.join(base, name) : base;
}

/** A topic without the field was given by the operator (every topic made before layout 2 recorded it). */
export const assignedBy = (topic) => (topic?.assigned_by === ASSIGNED_TECHNICAL ? ASSIGNED_TECHNICAL : ASSIGNED_OPERATOR);

/** A brain of data layout 2: it holds the work of its topics (no scratch/) and keeps documents itself (assigned_by of a topic). */
export const hasTriage = (brainDir) => !!brainDir && !hasScratch(brainDir) && hasData(brainDir, 'docs');

// The own steps a bell turn may run for a topic it holds (agent-alice/D-0094): the step written in its handover or its task.
const OWN_STEPS = {
  done: /(?<![\w-])done(?:\.mjs)?\s+(?:[^\n;]*\s)?--topic(?![\w-])|(?<!\p{L})(?:uzavr\p{L}*|zatvor\p{L}*|close)\s+(?:\p{L}+\s+)?(?:tém\p{L}*|topic)(?!\p{L})/iu,
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
 * agent-alice/D-0094 (P-076): in a turn from a bell, done --topic of a topic this thread holds runs when
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
 * held topic its handover or task orders (`own`: { topic, step }, ownStepRequested), and with `supervisor` (done --topic,
 * plan O7) a turn the supervisor's instruction started.
 */
export function bellRefusal(brainDir, thread, what, own = null, { supervisor = false } = {}) {
  if (!thread) return `${what} needs a stable thread id (P-038)`;
  if (supervisor && supervisorTurn(brainDir, thread)) return null;
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

/** Files of a topic (paths relative to temy/<id>/, posix, sorted), except the handover, .tema.json and tmp/. */
export function topicFiles(brainDir, id, root = path.join(brainDir, layoutOf(brainDir).topics, id)) {
  const L = layoutOf(brainDir);
  const skip = new Set([L.handover, L.topicFile]);
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
    if (!root || hasScratch(root)) continue;
    dirs.add(path.resolve(workDirFor(root, id)));
  }
  const removed = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    // After the topic is closed in git: a file a program holds must not fail the close (the mail close and the thread
    // settle come after this). What stays is outside git.
    const left = removeTree(dir);
    removed.push(left ? `${dir} (${left} file(s) stay: a program holds them open)` : dir);
  }
  return removed;
}


/** A line of the triage by type (layout 3): the file ends with the topic (it stays in the history of git). */
export const DROP = 'zanikne';
/** `novy:<typ>`: a type of outputs the main target repo does not have yet; the operator approves it (spec 5.3). */
export const NEW_TYPE = 'novy';
const NEW_TYPE_RE = /^nov[yý]:(.+)$/;
const TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse a triage by type (spec 5): one line per file of the topic, `<typ> <path>` (a type of outputs the repo has),
 * `novy:<typ> <path>` (a new type), `zanikne <path>` or `nejasne <path>`. Every file needs a line, none is left in the
 * topic (it ends at done). Returns { outputs: [{ rel, type, isNew }], drop: [rel], unclear: [rel], newTypes: [type],
 * errors }.
 */
export function parseTypeTriage(text, files, types = []) {
  const known = new Set(files);
  const have = new Set(types);
  const plan = { outputs: [], drop: [], unclear: [], newTypes: [], errors: [] };
  const seen = new Set();
  const usage = `"<typ> <path>" (types of the repo: ${types.join(', ') || 'none yet'}), "${NEW_TYPE}:<typ> <path>" (a new type, the operator approves it), "${DROP} <path>" (ends with the topic) or "${UNCLEAR} <path>"`;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) { plan.errors.push(`line "${line}": expected ${usage}`); continue; }
    const target = m[1];
    const rel = m[2].trim();
    if (!known.has(rel)) { plan.errors.push(`${rel}: not a file of the topic (files: ${files.join(', ') || 'none'})`); continue; }
    if (seen.has(rel)) { plan.errors.push(`${rel}: listed twice`); continue; }
    seen.add(rel);
    if (target === DROP) { plan.drop.push(rel); continue; }
    if (target === UNCLEAR) { plan.unclear.push(rel); continue; }
    const n = NEW_TYPE_RE.exec(target);
    const type = n ? n[1] : target;
    if (!TYPE_RE.test(type)) { plan.errors.push(`line "${line}": ${type} is no name of a type (lowercase letters, digits, hyphens); expected ${usage}`); continue; }
    if (!n && !have.has(type)) { plan.errors.push(`line "${line}": the repo has no type ${type}; a new type is "${NEW_TYPE}:${type} ${rel}" and the operator approves it (spec 5.3)`); continue; }
    const isNew = !have.has(type);
    if (isNew && !plan.newTypes.includes(type)) plan.newTypes.push(type);
    plan.outputs.push({ rel, type, isNew });
  }
  for (const f of files) if (!seen.has(f)) plan.errors.push(`${f}: no line; every file of the topic gets a type, "${DROP}" or "${UNCLEAR}" (the topic ends at done, spec 5)`);
  return plan;
}

/** The list for the agent at done --topic of layout 3: one line per file, `?` for what the agent gives. */
export function typeTriageListing(id, files, types, repo) {
  return [
    `triage: topic ${id} has ${files.length} file(s) outside tmp/ and is not closed (spec 5). Give every file one line in a file and run done.mjs --topic --verified "<observation>" --knowledge "<...>" --triage <file>: "<typ> <path>" for a finished output (it goes to ${repo ? `vystupy/<typ>/ of the repo ${repo}` : 'vystupy/<typ>/ of the main target repo'} with the topic in its header; types there: ${types.join(', ') || 'none yet'}), "${NEW_TYPE}:<typ> <path>" for an output no type fits (the operator approves the new type in a dialog), "${DROP} <path>" for the rest (an intermediate result, a log: it ends with the topic, git keeps it), "${UNCLEAR} <path>" when you cannot sort it (a question to the operator). Knowledge (fact, decision, procedure, rule) is no line here: write it with save first; a source from outside goes at once with save.mjs source.`,
    ...files.map((f) => `? ${f}`),
  ].join('\n');
}
