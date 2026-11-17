// Files of one topic in a brain, by the brain's data layout (layout.mjs, D-0048). Layout 1: topics/<id>/topic.json and
// holder.json, a closed topic moves to topics/archive/<id>/. Layout 2: one temy/<id>/.tema.json = the fields of the topic
// plus `holder` (a free topic `holder: {}`), a closed topic stays in temy/<id>/ with `state: "closed"`. Layout 3: the same
// .tema.json in topics/<id>/, without the hidden archive. The branches test the map (one file for topic and holder, a
// hidden archive), not the version.
// A leaf module next to layout.mjs (imports util, config and layout only), so brain.mjs, records.mjs, topic.mjs, comms.mjs
// and the hooks read and write topics through it without an import cycle.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';
import { sameMachine } from './config.mjs';
import { dataPath, dataRel, layoutOf, workDirFor, topicHome, hasData, hasScratch } from './layout.mjs';

const MAIN = 'main';
/** The brain keeps topic and holder in one file (.tema.json: layouts 2 and 3). */
export const oneTopicFile = (brainDir) => { const L = layoutOf(brainDir); return L.topicFile === L.holderFile; };
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Brain-relative path (posix) of the topic record and of the holder record (the same file in layout 2). */
export const topicFileRel = (brainDir, id) => dataRel(brainDir, 'topics', id, layoutOf(brainDir).topicFile);
export const holderFileRel = (brainDir, id) => dataRel(brainDir, 'topics', id, layoutOf(brainDir).holderFile);

function readTema(brainDir, id, dir = dataPath(brainDir, 'topics', id)) {
  const t = readJson(path.join(dir, layoutOf(brainDir).topicFile), null);
  return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
}

/** Layout 2: folder of a topic in the hidden archive (.brain/archive/topics/<id>, D-0060), or null when it is not there. */
export function hiddenTopicDir(brainDir, id) {
  if (!oneTopicFile(brainDir) || !id || !hasData(brainDir, 'topicHidden')) return null;
  const dir = dataPath(brainDir, 'topicHidden', id);
  return fs.existsSync(path.join(dir, layoutOf(brainDir).topicFile)) ? dir : null;
}

/** Layout 2: .tema.json of a topic in temy/, else in the hidden archive (a closed topic there). */
function readTemaAny(brainDir, id, { closed = false } = {}) {
  const open = readTema(brainDir, id);
  if (open || !closed) return open;
  const hidden = hiddenTopicDir(brainDir, id);
  return hidden ? readTema(brainDir, id, hidden) : null;
}

/** Split a .tema.json into the topic fields and the holder. */
export function splitTema(tema) {
  const { holder, ...topic } = obj(tema);
  return { topic, holder: obj(holder) };
}

/**
 * The topic record without the holder. Open topics by default (layout 1 topics/<id>/, layout 2 state other than closed);
 * `closed: true` reads a closed one (layout 1 topics/archive/<id>/, layout 2 state closed). Null when there is none.
 */
export function readTopicRecord(brainDir, id, { closed = false } = {}) {
  if (!brainDir || !id) return null;
  if (!oneTopicFile(brainDir)) {
    const dir = closed ? dataPath(brainDir, 'topicArchive', id) : dataPath(brainDir, 'topics', id);
    return readJson(path.join(dir, layoutOf(brainDir).topicFile), null);
  }
  let { topic } = splitTema(readTemaAny(brainDir, id, { closed }));
  // An open topic of the id in temy/ is not the closed one kept in the hidden archive (a topic reopened under its id).
  if (closed && topic.state !== 'closed' && hiddenTopicDir(brainDir, id)) topic = splitTema(readTema(brainDir, id, hiddenTopicDir(brainDir, id))).topic;
  if (!Object.keys(topic).length) return null;
  return (topic.state === 'closed') === !!closed ? topic : null;
}

/** The holder of a topic ({} when free or missing). */
export function readHolderRecord(brainDir, id) {
  if (!brainDir || !id) return {};
  if (!oneTopicFile(brainDir)) return readJson(dataPath(brainDir, 'topics', id, layoutOf(brainDir).holderFile), {}) || {};
  return splitTema(readTema(brainDir, id)).holder;
}

/** The open topic exists (layout 1: its topic.json; layout 2: its .tema.json, state not closed). */
export function openTopicExists(brainDir, id) {
  if (!oneTopicFile(brainDir)) return fs.existsSync(dataPath(brainDir, 'topics', id, layoutOf(brainDir).topicFile));
  return !!readTopicRecord(brainDir, id);
}

/** A closed topic of this id exists (layout 1: its folder in the archive; layout 2: .tema.json with state closed). */
export function closedTopicExists(brainDir, id) {
  if (!oneTopicFile(brainDir)) return fs.existsSync(dataPath(brainDir, 'topicArchive', id));
  return !!readTopicRecord(brainDir, id, { closed: true });
}

/** Folder of a closed topic: layout 1 topics/archive/<id>, layout 2 temy/<id> (it stays where it was) or its hidden archive. */
export function closedTopicDir(brainDir, id) {
  if (!oneTopicFile(brainDir)) return dataPath(brainDir, 'topicArchive', id);
  const inPlace = readTema(brainDir, id);
  return inPlace?.state === 'closed' || !hiddenTopicDir(brainDir, id) ? dataPath(brainDir, 'topics', id) : hiddenTopicDir(brainDir, id);
}

/**
 * Topics of a brain with their records: [{ id, dir, topic, holder }] sorted by id; open ones by default, `closed: true`
 * the closed ones. A folder without a valid topic record is left out.
 */
export function listTopicRecords(brainDir, { closed = false } = {}) {
  if (!brainDir) return [];
  const L = layoutOf(brainDir);
  const two = oneTopicFile(brainDir);
  const dir = !two && closed ? dataPath(brainDir, 'topicArchive') : dataPath(brainDir, 'topics');
  const archive = two ? null : dataPath(brainDir, 'topicArchive');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tdir = path.join(dir, entry.name);
    if (archive && !closed && tdir === archive) continue;
    if (two) {
      const tema = readTema(brainDir, entry.name);
      if (!tema) continue;
      const { topic, holder } = splitTema(tema);
      if ((topic.state === 'closed') !== !!closed) continue;
      out.push({ id: entry.name, dir: tdir, topic, holder });
    } else {
      const topic = readJson(path.join(tdir, L.topicFile), null);
      if (!topic) continue;
      out.push({ id: entry.name, dir: tdir, topic, holder: readJson(path.join(tdir, L.holderFile), {}) || {} });
    }
  }
  // Layout 2: the closed topics include those of the hidden archive (D-0060), unless one of the id is closed in temy/.
  if (two && closed && hasData(brainDir, 'topicHidden')) {
    const hidden = dataPath(brainDir, 'topicHidden');
    let more = [];
    try { more = fs.readdirSync(hidden, { withFileTypes: true }); } catch { more = []; }
    for (const entry of more) {
      if (!entry.isDirectory() || out.some((t) => t.id === entry.name)) continue;
      const tema = readTema(brainDir, entry.name, path.join(hidden, entry.name));
      if (!tema) continue;
      const { topic, holder } = splitTema(tema);
      out.push({ id: entry.name, dir: path.join(hidden, entry.name), topic, holder, hidden: true });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Write op of the topic record (all its fields, no holder). Layout 2: the op carries `tema.topic`, brainWrite merges it
 * with the holder on disk and with a holder op of the same write into one .tema.json (mergeTopicOps).
 */
export function topicOp(brainDir, id, topic) {
  const rel = topicFileRel(brainDir, id);
  if (!oneTopicFile(brainDir)) return { path: rel, content: json(topic) };
  const { topic: fields } = splitTema(topic);
  return { path: rel, content: json({ ...fields, holder: readHolderRecord(brainDir, id) }), tema: { topic: fields } };
}

/** Write op of the holder record ({} frees the topic). Layout 2: `tema.holder`, merged with the topic fields (mergeTopicOps). */
export function holderOp(brainDir, id, holder) {
  const rel = holderFileRel(brainDir, id);
  const h = obj(holder);
  if (!oneTopicFile(brainDir)) return { path: rel, content: json(h) };
  const { topic } = splitTema(readTema(brainDir, id));
  return { path: rel, content: json({ ...topic, holder: h }), tema: { holder: h } };
}

/**
 * Fields of flow v2 in the topic record (plan O1): `turn` (`state`, `alarm_at`, `stuck`, `continues`: the state of the
 * protocol, spec 10.2), `mode` (`discussion` | `off`, 10.6) and `repos` (`{ main, list }`, 4.5) at the top level; the
 * field `state` (working | paused | closed) is another one and stays. `results` (P-078): the results of the topic bound to
 * their work file (scripts/results.mjs).
 */
export const V2_FIELDS = ['turn', 'mode', 'repos', 'results'];
export const TURN_FIELDS = ['state', 'alarm_at', 'stuck', 'continues'];
export const MODES = ['discussion', 'off'];

/**
 * The record with `fields` set (null removes a field); `turn` merges key by key into the record's turn, a key set to null
 * stays null (`alarm_at: null` = no alarm, `stuck: null` = not stuck).
 */
export function withFields(topic, fields) {
  const out = { ...obj(topic) };
  for (const [k, v] of Object.entries(obj(fields))) {
    if (v === null || v === undefined) { delete out[k]; continue; }
    if (k !== 'turn') { out[k] = v; continue; }
    const turn = { ...obj(out.turn) };
    for (const [tk, tv] of Object.entries(obj(v))) if (tv !== undefined) turn[tk] = tv;
    out.turn = turn;
  }
  return out;
}

/**
 * Write op of fields of flow v2 (V2_FIELDS, `turn` key by key) into the topic record, merged with the record on disk at
 * write time (mergeTopicOps), so it goes in one op with a holder op of the same write (layout 2: one .tema.json) and
 * keeps every other field (withFields). A field or turn key outside the lists is refused (a typo would write a field nobody reads).
 */
export function fieldsOp(brainDir, id, fields) {
  const f = obj(fields);
  const bad = Object.keys(f).filter((k) => !V2_FIELDS.includes(k));
  if (bad.length) throw new Error(`unknown topic field ${bad.join(', ')} (fields of flow v2: ${V2_FIELDS.join(', ')})`);
  const badTurn = Object.keys(obj(f.turn)).filter((k) => !TURN_FIELDS.includes(k));
  if (badTurn.length) throw new Error(`unknown turn field ${badTurn.join(', ')} (turn: ${TURN_FIELDS.join(', ')})`);
  if (f.mode !== undefined && f.mode !== null && !MODES.includes(f.mode)) throw new Error(`mode ${f.mode}: expected ${MODES.join(' or ')}`);
  const rel = topicFileRel(brainDir, id);
  const two = oneTopicFile(brainDir);
  const now = two ? splitTema(readTema(brainDir, id)).topic : obj(readJson(path.join(brainDir, rel), null));
  const topic = withFields(now, f);
  return { path: rel, content: json(two ? { ...topic, holder: readHolderRecord(brainDir, id) } : topic), tema: { fields: f } };
}

/**
 * Ops of a topic record, of its holder and of fields of flow v2 (`tema`) for one file become one op, its content from the
 * file on disk at write time with the given parts replaced in the order of the ops, so a holder write keeps the topic
 * fields, a topic write the holder and a fields write every other field. Layout 2 one .tema.json (topic and holder);
 * layout 1 topic.json of a fields op, a plain topic op of the same file (layout 1 topicOp) counts as its topic part.
 * Other ops stay as they are.
 */
export function mergeTopicOps(brainDir, ops) {
  if (!ops.some((op) => op && op.tema)) return ops;
  const two = oneTopicFile(brainDir);
  const temaPaths = new Set(ops.filter((op) => op && op.tema).map((op) => op.path));
  const part = (op) => op && temaPaths.has(op.path) && (op.tema || (!two && typeof op.content === 'string'));
  const groups = new Map();
  for (const op of ops) if (part(op)) groups.set(op.path, [...(groups.get(op.path) || []), op]);
  const out = [];
  for (const op of ops) {
    if (!part(op)) { out.push(op); continue; }
    const group = groups.get(op.path);
    if (!group) continue;
    groups.delete(op.path);
    const disk = readJson(path.join(brainDir, op.path), null);
    let { topic, holder } = two ? splitTema(disk) : { topic: obj(disk), holder: null };
    for (const g of group) {
      if (!g.tema) { topic = splitTema(JSON.parse(g.content)).topic; continue; }
      if (g.tema.topic) topic = obj(g.tema.topic);
      if (g.tema.fields) topic = withFields(topic, g.tema.fields);
      if (g.tema.holder) holder = obj(g.tema.holder);
    }
    out.push({ path: op.path, content: json(two ? { ...topic, holder } : topic) });
  }
  return out;
}

/** The holder in the text of a holder record from git (git show <ref>:<holderFileRel>): layout 2 the `holder` of .tema.json. */
export function holderFromText(brainDir, text) {
  const parsed = JSON.parse(text || '{}');
  return oneTopicFile(brainDir) ? obj(parsed?.holder) : obj(parsed);
}

/** Topic whose work files this thread writes (layout 2): the first topic it holds on this machine other than main, else main. */
export function workTopic(ctx) {
  if (!ctx?.brainDir || !ctx.thread) return MAIN;
  const held = listTopicRecords(ctx.brainDir).filter((t) => t.holder?.thread === ctx.thread && sameMachine(t.holder.machine));
  const work = held.find((t) => t.id !== MAIN && t.topic?.kind !== 'main');
  return work ? work.id : MAIN;
}

/**
 * Folder of this thread's work files (P-052) in the topic home (topicHome, D-0056): a brain in layout 2 temy/<held topic or
 * main>/tmp, else the project repo (layout 1 scratch/, layout 2 temy/<held topic or main>/tmp).
 */
export function workDir(ctx) {
  if (!ctx?.projectDir) return null;
  const home = topicHome(ctx.brainDir, ctx.projectDir);
  return workDirFor(home, hasScratch(home) ? null : workTopic(ctx));
}

/**
 * Folders of the work files of every topic this thread holds on this machine (layout 2: temy/<id>/tmp of each, workDir
 * first), else [workDir]. A worker brief of a thread with several topics names the folder of the topic the work is for
 * (agent-alice/D-0094: the brief check waited for the folder of the first topic and refused the right one of the second).
 */
export function heldWorkDirs(ctx) {
  const first = workDir(ctx);
  if (!first) return [];
  const home = topicHome(ctx.brainDir, ctx.projectDir);
  if (!ctx.brainDir || !ctx.thread || hasScratch(home)) return [first];
  const held = listTopicRecords(ctx.brainDir).filter((t) => t.holder?.thread === ctx.thread && sameMachine(t.holder.machine) && t.id !== MAIN && t.topic?.kind !== 'main');
  return [...new Set([first, ...held.map((t) => workDirFor(home, t.id))])];
}
