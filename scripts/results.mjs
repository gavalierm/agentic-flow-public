// Results bound to their work file (P-078, operator 2026-11-17: "save result by malo byť poloautomatické; či je niečo v gite
// je irelevantné, ak sú tie súbory zastarané; pointa flow je, aby sa dôležité dáta a vedomosti ukladali").
// Audit of a project 2026-11-17: pages shown to the operator (Artifact) lived only in topics/<id>/tmp/ (outside git, removed by
// done --topic), the generators of saved pages too, and two saved results were older than their work copy (a register
// without the type a decision added). A result now remembers its source in the work files (`results` in .tema.json, in
// git); the end of every turn copies a changed source over its result, and these are saved without a command:
//   - a work file published as an Artifact or shown with html_preview (it was presented to the operator),
//   - a work file the handover cites (the manager named it as part of the state of the work),
//   - an older result of the same name as one work file of the topic (saved before results were bound).
// done --topic syncs before its triage and refuses while a handover cites a folder of the work files that would end.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataPath, dataRel, layoutOf, hasScratch } from './layout.mjs';
import { fieldsOp, readTopicRecord, oneTopicFile } from './topic-files.mjs';
import { maxBytes } from './materialy.mjs';
import { readArtifacts, pagePublish } from './artifacts.mjs';
import { toPosix } from './util.mjs';

export const RESULTS_FIELD = 'results';
const SKIP = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv']);
const WALK_BUDGET = 20000;
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const readBuf = (abs) => { try { return fs.readFileSync(abs); } catch { return null; } };
const statOf = (abs) => { try { return fs.statSync(abs); } catch { return null; } };
const newer = (a, b) => (statOf(a)?.mtimeMs ?? 0) > (statOf(b)?.mtimeMs ?? 0);

/** Bound results exist in a brain with topic folders and one topic file (data 2.0 and 2.1); not in data 1 (scratch/). */
export const resultsActive = (brainDir) => !!brainDir && !hasScratch(brainDir) && oneTopicFile(brainDir) && fs.existsSync(dataPath(brainDir, 'topics'));

/** A path in the work files of some topic: { topic, rel (inside its tmp/), from (brain-relative posix) } or null. */
export function tmpOwner(brainDir, abs) {
  if (!brainDir || !abs) return null;
  const root = dataPath(brainDir, 'topics');
  const rel = path.relative(root, path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 3 || parts[1] !== layoutOf(brainDir).topicTmp || parts.some((p) => SKIP.has(p))) return null;
  return { topic: parts[0], rel: parts.slice(2).join('/'), from: toPosix(path.relative(brainDir, path.resolve(abs))) };
}

/** The bound results of a topic: { <name>: { from, via, url?, at } } (from null = an older result checked, no source). */
export function readBindings(brainDir, id) {
  const r = readTopicRecord(brainDir, id)?.[RESULTS_FIELD];
  return r && typeof r === 'object' && !Array.isArray(r) ? { ...r } : {};
}

/**
 * A project 2026-11-18: a published result page (an Artifact) kept describing an old state; the thread wrote only the
 * handover, turn after turn. The pages of topic `id` published as an Artifact whose source did not change since `sinceMs`
 * (the time of the handover before this one): [{ name, url }].
 */
export function stalePages(brainDir, id, sinceMs) {
  if (!sinceMs) return [];
  return Object.entries(readBindings(brainDir, id))
    .filter(([, b]) => b?.url && b.from && (statOf(path.join(brainDir, ...b.from.split('/')))?.mtimeMs ?? Infinity) < sinceMs)
    .map(([name, b]) => ({ name, url: b.url }));
}

// Paths of the work files in a text: `tmp/<…>` (relative to the topic), `<…>/<topics>/<id>/tmp/<…>` (another topic,
// brain-relative, domain-relative or absolute). The end of a sentence or a list is not part of the path.
// Windows: `tmp\<…>` and `D:\Claude projekty\…\topics\<id>\tmp\<…>` (a space in the path cuts the token; its part from
// `topics\` on still names the file) count as well.
const CITE_RE = /(?:^|[\s`'"(\[<])((?:[^\s`'"()\[\]<>,;]*[\\/])?tmp[\\/][^\s`'"()\[\]<>,;]*)/g;

/** Work files and folders a text cites, resolved for topic `id`: { files: [abs], dirs: [abs] } (existing ones only). */
export function citedWork(brainDir, id, text) {
  const files = new Set();
  const dirs = new Set();
  const topicsName = dataRel(brainDir, 'topics');
  for (const m of String(text || '').matchAll(CITE_RE)) {
    const p = m[1].replace(/\\/g, '/').replace(/[.:!?…]+$/, '');
    let abs = null;
    if (path.isAbsolute(p) && p.includes(`/${topicsName}/`)) abs = path.resolve(p);
    else if (p.startsWith('tmp/')) abs = dataPath(brainDir, 'topics', id, ...p.split('/'));
    else {
      const at = p.indexOf(`${topicsName}/`);
      if (at === 0 || (at > 0 && p[at - 1] === '/')) abs = path.join(brainDir, ...p.slice(at).split('/'));
    }
    const owner = abs && tmpOwner(brainDir, abs);
    if (!owner) continue;
    const st = statOf(abs);
    if (!st) continue;
    if (st.isFile()) files.add(path.resolve(abs));
    else if (st.isDirectory() && owner.rel) dirs.add(path.resolve(abs));
  }
  return { files: [...files], dirs: [...dirs] };
}

function walkTmp(brainDir, id, visit) {
  let seen = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > WALK_BUDGET) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); } else if (e.isFile()) visit(p);
    }
  };
  walk(dataPath(brainDir, 'topics', id, layoutOf(brainDir).topicTmp));
}

/** Files of a folder in the work files (for a message): count, without the skipped folders. */
export function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n > WALK_BUDGET) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(d, e.name)); } else if (e.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * One sync of the results of topic `id` (P-078): ops for changed or new results and the bindings field, and what happened.
 * `extra`: [{ abs, via, url }] to bind now (a publish, a preview, save.mjs result). Returns
 * { ops, saved: [{ name, via, from }], skipped: [{ from, reason }], dirs: [abs] }.
 */
export function syncResults(brainDir, id, { policy = {}, extra = [], handover = null, now = Date.now() } = {}) {
  const empty = { ops: [], saved: [], skipped: [], dirs: [] };
  if (!resultsActive(brainDir) || !id || !readTopicRecord(brainDir, id)) return empty;
  const L = layoutOf(brainDir);
  const topicDir = dataPath(brainDir, 'topics', id);
  const reserved = new Set([L.topicFile, L.handover, L.topicTmp, L.holderFile].filter(Boolean));
  const max = maxBytes(policy);
  const before = readBindings(brainDir, id);
  const bindings = { ...before };
  const ops = [];
  const saved = [];
  const skipped = [];
  const at = new Date(now).toISOString();
  const resultPath = (name) => path.join(topicDir, name);
  const savedNames = () => (fs.existsSync(topicDir) ? fs.readdirSync(topicDir, { withFileTypes: true }).filter((e) => e.isFile() && !reserved.has(e.name)).map((e) => e.name) : []);
  const byFrom = () => new Map(Object.entries(bindings).filter(([, b]) => b?.from).map(([n, b]) => [b.from, n]));

  // A free name for a new source: the bound one, its own name, an unbound older result of that name (its saved copy),
  // the folder in front of it, then a number.
  const nameFor = (abs, owner, wanted) => {
    const known = byFrom().get(owner.from);
    if (known) return known;
    // An older result with the same content is the saved copy of this source (saved under another name).
    if (!wanted) {
      const src = readBuf(abs);
      const h = src && sha(src);
      const twin = h && savedNames().find((n) => !bindings[n]?.from && sha(readBuf(resultPath(n)) || Buffer.alloc(0)) === h);
      if (twin) return twin;
    }
    const base = wanted || path.basename(abs);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const parent = path.basename(path.dirname(abs));
    const tries = [base];
    if (!wanted && parent !== L.topicTmp && owner.topic === id) tries.push(`${parent}-${base}`);
    if (owner.topic !== id) tries.push(`${owner.topic}-${base}`);
    for (let i = 2; i < 50; i++) tries.push(`${stem}-${i}${ext}`);
    for (const n of tries) {
      if (reserved.has(n)) continue;
      if (bindings[n]?.from) continue;
      return n;
    }
    return null;
  };

  const bind = (abs, via, { url = null, name = null } = {}) => {
    const owner = tmpOwner(brainDir, abs);
    if (!owner) return;
    const st = statOf(abs);
    if (!st?.isFile()) return;
    if (st.size > max) { skipped.push({ from: owner.from, reason: `${(st.size / 1048576).toFixed(0)} MB over the limit ${max / 1048576} MB` }); return; }
    const n = nameFor(abs, owner, name);
    if (!n) { skipped.push({ from: owner.from, reason: 'no free name in the topic' }); return; }
    const prev = bindings[n];
    bindings[n] = { from: owner.from, via: prev?.from === owner.from ? prev.via : via, ...(url || prev?.url ? { url: url || prev.url } : {}), at: prev?.from === owner.from ? prev.at : at };
  };

  for (const e of extra) bind(path.resolve(e.abs), e.via, { url: e.url || null, name: e.name || null });
  // Pages published from the work files of this topic, or by its thread from elsewhere in the work files.
  for (const a of readArtifacts(brainDir)) {
    const owner = tmpOwner(brainDir, a.file);
    if (owner && (owner.topic === id || a.key === id)) bind(a.file, 'artifact', { url: a.url || null });
  }
  const text = handover ?? (() => { try { return fs.readFileSync(path.join(topicDir, L.handover), 'utf8'); } catch { return ''; } })();
  const cited = citedWork(brainDir, id, text);
  for (const f of cited.files) bind(f, 'handover');
  // Older results without a binding: the one work file of the same name is their source; none = checked (from null).
  let names = null;
  const unbound = savedNames().filter((n) => !(n in bindings));
  if (unbound.length) {
    names = new Map();
    walkTmp(brainDir, id, (p) => { const b = path.basename(p); names.set(b, [...(names.get(b) || []), p]); });
    for (const n of unbound) {
      const hits = names.get(n) || [];
      // Only a newer work file is the source of the older result (a work file older than the result is an earlier draft:
      // audit-skillu-nahodenie, the saved v1-v3 are newer than the draft left in tmp/); checked again in the next turn.
      if (hits.length === 1) { if (newer(hits[0], resultPath(n)) && !byFrom().has(tmpOwner(brainDir, hits[0])?.from)) bind(hits[0], 'inferred', { name: n }); }
      else bindings[n] = { from: null, via: hits.length ? 'ambiguous' : 'none', at };
    }
  }
  // Copy every bound source that differs from its result (a source that is gone keeps the result as it is).
  for (const [n, b] of Object.entries(bindings)) {
    if (!b?.from) continue;
    const src = readBuf(path.join(brainDir, ...b.from.split('/')));
    if (!src) continue;
    if (src.length > max) { skipped.push({ from: b.from, reason: `${(src.length / 1048576).toFixed(0)} MB over the limit ${max / 1048576} MB` }); continue; }
    const cur = readBuf(resultPath(n));
    if (cur && sha(cur) === sha(src)) continue;
    // A result written after its source changed last (a pull of another machine's save, a manual save) is not overwritten
    // by an older work file; the source wins once it changes again.
    if (cur && !newer(path.join(brainDir, ...b.from.split('/')), resultPath(n))) continue;
    ops.push({ path: dataRel(brainDir, 'topics', id, n), content: src });
    saved.push({ name: n, via: b.via, from: b.from, fresh: !cur });
  }
  if (JSON.stringify(bindings) !== JSON.stringify(before)) ops.push(fieldsOp(brainDir, id, { [RESULTS_FIELD]: bindings }));
  return { ops, saved, skipped, dirs: cited.dirs };
}

/** The work file a tool call shows to the operator: an Artifact page publish or html_preview of a file; else null. */
export function shownFile(input) {
  const page = pagePublish(input);
  if (page) return page.file;
  if (/(^|__)html_preview$/.test(String(input?.tool_name || '')) && typeof input.tool_input?.path === 'string' && input.tool_input.path) return path.resolve(input.cwd || process.cwd(), input.tool_input.path);
  return null;
}

/** One line of what a sync saved, or null. */
export function savedLine(id, res) {
  const parts = [];
  if (res.saved.length) parts.push(`results of ${id} saved from the work files (P-078): ${res.saved.slice(0, 6).map((s) => `${s.name} <- ${s.from} (${s.via}${s.fresh ? ', new' : ''})`).join(', ')}${res.saved.length > 6 ? `, … (+${res.saved.length - 6})` : ''}`);
  if (res.skipped.length) parts.push(`not saved: ${res.skipped.slice(0, 3).map((s) => `${s.from} (${s.reason})`).join(', ')}`);
  return parts.length ? parts.join('; ') : null;
}
