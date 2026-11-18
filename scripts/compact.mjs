// keep: core
// Compaction (P-026). Operator 2026-11-16: "handover by mal byť kvalitnejší pred kompakciou". Three steps, all code:
// 1. before the auto-compact window fills, the main thread is told once to save the handover while it still has the whole
//    context (post-tool-use, `compactNudge`);
// 2. the PreCompact hook gives the summary its instructions: a state, not a history, operator messages verbatim, exact
//    identifiers, and what changed after the last handover (`compactInstructions`);
// 3. after compaction the start says how old the handover is, so a stale one does not overrule a newer summary
//    (boot.mjs, `handoverAgeLine`).
import fs from 'node:fs';
import path from 'node:path';
import { topicDir } from './topic.mjs';
import { layoutOf } from './layout.mjs';

export const NUDGE_RATIO = 0.8;
/** The large context window (1M): a context over the policy window runs on it, auto-compaction did not come at the policy
 * window (a project 2026-11-18: "~223k of 200k", later 468k, the line repeated for tens of turns). */
export const LARGE_WINDOW = 1_000_000;
const TAIL_BYTES = 1024 * 1024;

/** The summary as a state (Claude Code PreCompact stdout, Codex compact_prompt). No line limit: a terse summary lost the work. */
export const COMPACT_PROMPT = [
  'Zhrň kontext ako stav práce, nie ako históriu rozhovoru (P-026). Nový kontext bude pokračovať iba z tohto zhrnutia a z handoveru témy, ktorý vloží štart. Časti v tomto poradí:',
  '1. Zadanie: požiadavka operátora a každý jeho trvalý pokyn, ktorý ešte platí (napr. „odteraz…“, „už sa nepýtaj…“), doslova v úvodzovkách, s témou (ID), ak existuje.',
  '2. Správy operátora: každá správa operátora doslova; posledné správy a tie, na ktoré ešte nebola odpoveď, celé; neodpovedané označ.',
  '3. Hotové: overené výsledky s faktmi, ktoré ich overia (commit, tag, verzia, cesta, počet testov, URL, ID správy); zámery nie.',
  '4. Rozpracované: čo bežalo v okamihu kompakcie a presne kde to stojí (posledný príkaz a jeho výsledok, čo z kroku zostáva).',
  '5. Ďalší krok: konkrétne kroky, ktoré sa dajú vykonať bez operátora, v poradí.',
  '6. Otvorené otázky a úlohy pre operátora; čakajúca pošta a úlohy na pozadí (ID).',
  '7. Súbory: cesty, ktoré sa pri pokračovaní čítajú, s funkciou alebo riadkom, kde treba.',
  '8. Chyby a poučenia tejto session, ktoré menia ďalší postup (čo zlyhalo a ako sa to opravilo).',
  'Identifikátory (cesty, hashe, ID, príkazy, verzie) píš presne, neparafrázuj ich. Pravidlá workflow nezhrňuj, načíta ich štart.',
].join('\n');

/** Modification time of the handover of a topic (ISO) or null. */
export function handoverSavedAt(brainDir, id) {
  try { return fs.statSync(path.join(topicDir(brainDir, id), layoutOf(brainDir).handover)).mtime.toISOString(); } catch { return null; }
}

const minutesAgo = (iso, now) => Math.max(0, Math.round((now - Date.parse(iso)) / 60000));

/** PreCompact stdout: the prompt plus the held topic and how old its handover is (`held`: [{ id }], first one counts). */
export function compactInstructions({ held = [], brainDir = null, now = Date.now() } = {}) {
  const lines = [COMPACT_PROMPT];
  const topic = held[0];
  if (topic && brainDir) {
    const at = handoverSavedAt(brainDir, topic.id);
    lines.push(at
      ? `Téma ${topic.id}: jej handover je uložený ${at} (pred ${minutesAgo(at, now)} min). V časti Rozpracované vymenuj, čo sa po tomto čase zmenilo, aby sa handover dal hneď aktualizovať.`
      : `Téma ${topic.id} nemá uložený handover: zhrnutie je jediný podklad, píš ho úplne.`);
  }
  return lines.join('\n');
}

/**
 * Tokens of the main conversation now: input, cache read, cache creation and output of the last assistant response in
 * the transcript tail (as Claude Code counts `context_tokens`). Null when unknown.
 */
export function contextTokens(transcriptPath) {
  if (!transcriptPath) return null;
  let text = '';
  try {
    const size = fs.statSync(transcriptPath).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const u = d.message?.usage;
    if (!u) continue;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }
  return null;
}

/**
 * Once per context (thread state `compact_nudged`, cleared at every session start): at NUDGE_RATIO of the auto-compact
 * window the main thread that holds a topic saves its handover now. Returns { line, patch } or null.
 */
export function compactNudge({ tokens, window, state = {}, held = [], ratio = NUDGE_RATIO }) {
  if (!tokens || !window || state.compact_nudged || !held.length) return null;
  if (tokens > window) window = Math.max(window, LARGE_WINDOW);
  if (tokens < window * ratio) return null;
  const id = held[0].id;
  const k = (n) => `${Math.round(n / 1000)}k`;
  return {
    line: `context: ~${k(tokens)} of ${k(window)} tokens, auto-compaction comes at ${k(window)}: save the handover of topic ${id} now, while the whole context is here (save.mjs handover ${id} with all six sections: the task verbatim with the operator's standing instructions, Hotové with the facts that verify it, the exact Ďalší krok); then go on with the work (P-026)`,
    patch: { compact_nudged: true },
  };
}

/** After a compaction: the age of the handover against the compaction, so the newer of the two counts (P-026). */
export function handoverAgeLine(brainDir, id, compactedAt, now = Date.now()) {
  const at = handoverSavedAt(brainDir, id);
  if (!at) return null;
  const before = compactedAt ? Math.round((Date.parse(compactedAt) - Date.parse(at)) / 60000) : minutesAgo(at, now);
  if (before < 5) return `Handover témy ${id} je uložený ${at}, tesne pred kompakciou: platí.`;
  return `Handover témy ${id} je uložený ${at}, ${before} min pred kompakciou: zadanie a otázky z neho platia, ale kde zhrnutie opisuje novší stav (Hotové, Rozpracované, Ďalší krok), platí zhrnutie; handover podľa neho hneď aktualizuj (save.mjs handover ${id}).`;
}
