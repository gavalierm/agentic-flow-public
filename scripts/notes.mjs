// Notes of a brain (operator 2026-11-21, a report of a project): a remark that must not be acted on now is added to a
// channel (notes/<channel>/) by any thread, with no topic held, and waits there until the operator orders its processing.
//   - one file per note, named by its time and title: two threads or machines never write one file, so an add has no race;
//   - nothing reads the notes at the start of a session and no index lists them: a note is no rule and no knowledge
//     (P-007), find does not search it;
//   - only the brain of data 2.1 has the folder (layout.mjs `notes`).
// Pure but for readNotes; save.mjs note writes through brainWrite (pre-commit, push).
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, dataRel } from './layout.mjs';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';
import { normalizeKey, tokens } from './keys.mjs';

/** States of a note: `open` waits; `processed` and `rejected` are closed by the thread that processes the channel. */
export const NOTE_STATES = Object.freeze(['open', 'processed', 'rejected']);
/** Tokens two titles must share to be similar, and the shortest token that counts (short words say nothing). */
const SIMILAR_TOKENS = 2;
const TOKEN_MIN = 4;

const stamp = (iso) => `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;

/** A new note: { id, rel, content }. `id` is `<YYYYMMDD>-<HHMMSS>-<title slug>` (UTC), the file name without .md. */
export function newNote(brainDir, channel, { title, body, topic = null, now = new Date().toISOString() }) {
  const id = `${stamp(now)}-${normalizeKey(title).slice(0, 40).replace(/-+$/, '')}`;
  const data = { title, state: 'open', created: now, ...(topic ? { topic } : {}) };
  return { id, rel: dataRel(brainDir, 'notes', channel, `${id}.md`), content: serializeFrontmatter(data, String(body).trim()) };
}

/** Notes of a channel, oldest first: [{ id, rel, title, state, created, data, body }]. */
export function readNotes(brainDir, channel) {
  const dir = dataPath(brainDir, 'notes', channel);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  return names.map((name) => {
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, name), 'utf8'));
    const id = name.slice(0, -3);
    return { id, rel: dataRel(brainDir, 'notes', channel, name), title: String(data.title || id), state: NOTE_STATES.includes(data.state) ? data.state : 'open', created: data.created || null, data, body };
  });
}

/** Open notes whose title shares SIMILAR_TOKENS words with `title` (the add refuses them: one remark, one note). */
export function similarNotes(notes, title) {
  const want = new Set(tokens(title).filter((t) => t.length >= TOKEN_MIN));
  return notes.filter((n) => n.state === 'open' && tokens(n.title).filter((t) => want.has(t)).length >= SIMILAR_TOKENS);
}

/** Text of `note` with `text` added under a dated line (the same remark came again or got a detail). */
export function appendedNote(note, text, now = new Date().toISOString()) {
  return serializeFrontmatter({ ...note.data, updated: now }, `${note.body.trim()}\n\n${now.slice(0, 10)}: ${String(text).trim()}`);
}

/** Text of `note` in `state` with its reason (a note that is open again has none). */
export function statedNote(note, state, reason, now = new Date().toISOString()) {
  const { closed, reason: old, ...data } = note.data;
  return serializeFrontmatter({ ...data, state, ...(state === 'open' ? {} : { closed: now, reason }) }, note.body.trim());
}
