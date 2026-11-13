// P-061: the reply protocol. The end of a turn is declared, not guessed from prose: the last line of the final reply is
// `**Stav:** hotovo|otázka|čakám` and everything that waits on the operator is a numbered list under `**Otázky na operátora:**`
// (decisions, confirmations) or `**Úlohy pre operátora:**` (steps only the operator does); before the state line the section
// `**Handover:**` has one numbered line `<téma> → <ďalší krok>` per held topic, or reads `**Handover:** žiadny` (D-0040). Code reads
// only this fixed form and checks the
// declared state against facts (handover, wakers); any other wording of a promise or a wait is no state at all
// (operator 2026-11-08: "a hook that catches variants of promises is never reliable, the agent writes another one").
// `čakám` names what it waits for: `Stav: čakám (na <čo>)` (operator 2026-11-08: "musí napísať aj na čo sa čaká").
// A step is never a sentence (operator 2026-11-09: carol ended "Ostáva: … zmažem ho až na tvoje potvrdenie" with
// "Stav: hotovo"; "všetky zadávania pokynov, čakania… musia byť protokolované, nie voľný text"): what the operator decides,
// confirms or does is an item of one of the two operator checklists, an own step is done or saved in the handover, a wait is the
// state line. A label that writes a step as prose ("Ostáva:", "Ďalší krok:") is outside the protocol.

export const STATES = ['hotovo', 'otázka', 'čakám'];

// P-059 (operator 2026-11-11): a decision of the operator stands for further steps of the same kind. Questions he answered
// in a thread (an item of a reply that ended `otázka`, a dialog question) are kept in `answered_questions` ({q, at}, newest last).
export const ANSWERED_MAX = 20;
const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// The consent kind is the step asked for: review, approve, deploy, merge ("môžem" names no step). A question repeats an answered
// one of this kind only when both are short and ask for the same step: a longer question carries its own proposal and repeats
// only by subject (2026-11-12: "Kedy mám schválené návrhy implementovať" and design proposals ending "Súhlasíš?" or "Urobiť to
// tak?" were refused as repeats of the audit question R1 about merging into main).
const CONSENT_STEPS = { review: /\b(pozri|pozret)/, approve: /\b(potvrd|schval|suhlas)/, deploy: /\bnasadi/, merge: /\bzluci/ };
const CONSENT_MAX_WORDS = 30;
const consentSteps = (p) => ((p.match(/[a-z0-9]+/g) || []).length <= CONSENT_MAX_WORDS ? Object.keys(CONSENT_STEPS).filter((k) => CONSENT_STEPS[k].test(p)) : []);
const stems = (s) => [...new Set((plain(s).match(/[a-z0-9]{5,}/g) || []).map((w) => w.slice(0, 5)))];
/** The answered question (text) the new item repeats, or null: both short consents to the same step (review, approve, deploy, merge), or 60 % of >= 3 significant words shared. */
export function repeatsAnswered(newItem, answered) {
  const n = plain(newItem || '');
  const words = stems(newItem || '');
  const steps = consentSteps(n);
  for (const a of Array.isArray(answered) ? answered : []) {
    const old = typeof a === 'string' ? a : a?.q;
    if (!old) continue;
    if (steps.length && consentSteps(plain(old)).some((k) => steps.includes(k))) return old;
    const oldWords = new Set(stems(old));
    if (words.length >= 3 && words.filter((w) => oldWords.has(w)).length / words.length >= 0.6) return old;
  }
  return null;
}
/** `state.answered_questions` with the questions added (text items, at the time `at`), at most ANSWERED_MAX, newest last. */
export function withAnswered(state, items, at = new Date().toISOString()) {
  const add = (Array.isArray(items) ? items : []).map((q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).map((q) => ({ q, at }));
  return { ...state, answered_questions: [...(Array.isArray(state?.answered_questions) ? state.answered_questions : []), ...add].slice(-ANSWERED_MAX) };
}
const ASCII = { hotovo: 'hotovo', otazka: 'otázka', cakam: 'čakám' };

export const STATE_LINE = '**Stav:** hotovo | otázka | čakám (na <čo>)';
export const WAIT_LINE = '**Stav:** čakám (na <čo>)';
// The section before the state line: what continues after /clear or in a new session (operator: he could not tell), one
// numbered line per topic the thread holds, or none (D-0040).
export const HANDOVER_MARK = '**Handover:**';
export const HANDOVER_LINE = '**Handover:** with one numbered line per held topic, "1. <téma> → <ďalší krok v skratke>"';
export const HANDOVER_NONE_LINE = '**Handover:** žiadny';
/** The end of a reply in the protocol (D-0040), quoted in hook messages. */
export const PROTOCOL_EXAMPLE = '"**Otázky na operátora:**\\n1. <otázka>\\n\\n**Handover:**\\n1. <téma> → <ďalší krok>\\n\\n**Stav:** otázka"';

/** What a `čakám` state line waits for: "(na pracovníka)" or "na pracovníka" -> "na pracovníka"; null without letters. */
function waitTarget(rest) {
  const t = rest.replace(/^\((.*)\)$/s, '$1').replace(/^[\s,:–-]+/, '').trim();
  return /\p{L}{2,}/u.test(t) ? t : null;
}

export const QUESTIONS_MARK = '**Otázky na operátora:**';
export const TASKS_MARK = '**Úlohy pre operátora:**';
const QUESTIONS_BLOCK = /(^|\n)[ \t]*[*_]*(?:Otázky|Otazky|Otázka|Otazka)[ \t]+na[ \t]+(?:operátora|operatora)[*_]*[ \t]*:[*_]*[ \t]*/iu;
const TASKS_BLOCK = /(^|\n)[ \t]*[*_]*(?:Úlohy|Ulohy|Úloha|Uloha)[ \t]+pre[ \t]+(?:operátora|operatora)[*_]*[ \t]*:[*_]*[ \t]*/iu;
// The single heading before the split (P-061 until 2026-11-11); "Pre teba" is the marker before v0.9.43. Both still parse.
const LEGACY_BLOCK = /(^|\n)[ \t]*[*_]*(?:Operátor|Operator|Pre teba)[*_]*[ \t]*:[*_]*[ \t]*/iu;
const ITEM = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]?\][ \t]*)?|\d+[.)][ \t]+|\[[ xX]?\][ \t]*)(.*)$/;
const NUMBERED = /^[ \t]*\d+[.)][ \t]+/;
// A step written as prose under a label, at the start of a line (list marker and markdown allowed).
const STEP_LABEL = /(^|\n)[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?[*_]*(ostáva|zostáva|zvyšok|ďalší krok|ďalšie kroky|ďalej treba|next steps?|remaining|todo|to do)[*_]*[ \t]*:[*_]*[ \t]*([^\n]*)/iu;
// A request that the operator write "pokračuj" makes the operator the waker (bob 2026-11-11, after a bypass lock).
const CONTINUE_ASK = /(?:napíš|napíšte|napis|napiste|napísať|napisat|write|type|say)[ \t]+[„"'`*_]*(pokračuj|pokracuj|continue|go on)(?![\p{L}])/iu;
const NOTHING = /^(nič|nic|žiadn\p{L}*|nothing|none|-|–|—)?[.\s]*$/iu;

/** The items of a heading block: inline text after the marker and the list lines under it, up to an empty line.
 * `flags.unnumbered`: an item is not a numbered line (`- [ ] …`, `- …` or text after the heading; D-0040). */
function blockItems(body, re, flags = {}) {
  const m = re.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length).split('\n');
  const items = [];
  let unnumbered = false;
  const first = rest[0].replace(/[*_]+$/, '').trim();
  if (first) {
    if (!NUMBERED.test(first) && !NOTHING.test(first)) unnumbered = true;
    items.push(first.replace(ITEM, '$1').trim());
  }
  for (const line of rest.slice(1)) {
    if (!line.trim()) { if (items.length) break; continue; }
    const it = ITEM.exec(line);
    if (!it) break;
    if (!NUMBERED.test(line)) unnumbered = true;
    if (it[1].trim()) items.push(it[1].trim());
  }
  const out = items.filter((i) => !NOTHING.test(i));
  if (unnumbered && out.length) flags.unnumbered = true;
  return out;
}

// The handover section (D-0040): the bold heading `**Handover:**` with `žiadny` after it, or with numbered lines
// `<téma> → <ďalší krok>` under it up to the state line. The single line `Handover: <téma> – <krok>` is the old form.
const HANDOVER_HEAD = /^[ \t>]*[*_]*handover[*_]*[ \t]*:[*_]*[ \t]*(.*)$/i;
const HANDOVER_NEW_HEAD = /^[ \t>]*\*\*handover:\*\*[ \t]*(.*)$/i;
const ARROW = /^[`*_]*([^\s`*_→]+)[`*_]*[ \t]*(?:→|->)[ \t]*(\S.*)$/;
/** The handover section among the lines before the state line ({ none, items: [{ topic, next }], unnumbered, old, text })
 * and the index of its heading; null (start = end) when no heading or a line after it is no list item. */
function handoverSection(before) {
  let i = before.length - 1;
  while (i >= 0 && !HANDOVER_HEAD.test(before[i])) i--;
  if (i < 0) return { section: null, start: before.length };
  const neu = HANDOVER_NEW_HEAD.exec(before[i]);
  const inline = (neu ? neu[1] : HANDOVER_HEAD.exec(before[i])[1]).replace(/[*_`]/g, '').trim();
  const sec = { none: false, items: [], unnumbered: false, old: !neu, text: before[i].replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim() };
  if (neu && /^(?:žiadny|ziadny|-|–|—)(?![\p{L}\p{N}])/iu.test(inline)) sec.none = true;
  else if (inline) sec.old = true;
  for (const line of before.slice(i + 1)) {
    if (!line.trim()) continue;
    const it = ITEM.exec(line);
    if (!it) return { section: null, start: before.length };
    if (!NUMBERED.test(line)) sec.unnumbered = true;
    const a = ARROW.exec(it[1].trim());
    sec.items.push(a ? { topic: a[1], next: a[2].trim() } : { topic: null, next: null, text: it[1].trim() });
  }
  return { section: sec, start: i };
}

/**
 * The declared state of a reply ('hotovo' | 'otázka' | 'čakám') or null; `questions` and `tasks`, the items under
 * **Otázky na operátora:** and **Úlohy pre operátora:** (null without the heading); `operator`, all of them together
 * (plus the items of the old **Operátor:** heading, `legacyOperator: true`; null without any heading); `emptySection`,
 * the heading that has no item or null; `question`, the first question (else the first task) item, up to its question
 * mark when it has one, or null; for `čakám`
 * what it waits for (`waitFor`, null when the line does not say it); `step`, a step written as prose under a label
 * ("Ostáva: …") or null. Only `čakám` may carry text after the word. `handover`: the last non-empty line before the state line
 * when it is `Handover: …` (markdown stripped), else null.
 */
export function parseReply(text) {
  const out = { state: null, handover: null, oldForm: [], onlyProtocol: false, question: null, waitFor: null, operator: null, questions: null, tasks: null, legacyOperator: false, emptySection: null, step: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  const lines = text.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1].replace(/[*_`>]/g, '').trim();
  const m = /^stav\s*:\s*([^\s.(]+)\s*(.*?)\s*\.?$/i.exec(last);
  if (m) {
    const word = m[1].toLowerCase();
    const plain = word.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const state = STATES.includes(word) ? word : ASCII[plain] || null;
    if (!/^[>\s]*\*\*stav:\*\*/i.test(lines[lines.length - 1])) out.oldForm.push('state');
    if (state === 'čakám') {
      out.state = state;
      out.waitFor = waitTarget(m[2]);
    } else if (!m[2]) out.state = state;
  }
  const before = lines.slice(0, -1);
  const { section, start } = m ? handoverSection(before) : { section: null, start: before.length };
  if (section) {
    out.handover = section;
    if (section.old) out.oldForm.push('handover');
    else if (section.unnumbered) out.oldForm.push('handover-items');
  }
  out.onlyProtocol = !!m && !before.slice(0, start).join('').trim();
  const body = before.slice(0, start).join('\n');
  const prose = body.replace(/```[\s\S]*?```/g, '');
  const numbering = {};
  out.questions = blockItems(prose, QUESTIONS_BLOCK, numbering);
  out.tasks = blockItems(prose, TASKS_BLOCK, numbering);
  const legacy = blockItems(prose, LEGACY_BLOCK);
  out.legacyOperator = !!legacy;
  if (out.questions || out.tasks || legacy) out.operator = [...(out.questions || []), ...(out.tasks || []), ...(legacy || [])];
  for (const [items, mark] of [[out.questions, QUESTIONS_MARK], [out.tasks, TASKS_MARK], [legacy, '**Operátor:**']]) {
    if (items && !items.length) { out.emptySection = mark; break; }
  }
  if (numbering.unnumbered) out.oldForm.push('items');
  const first = out.questions?.[0] || out.tasks?.[0] || out.operator?.[0];
  if (first) {
    const q = first;
    const qi = q.indexOf('?');
    out.question = (qi >= 0 ? q.slice(0, qi + 1) : q).replace(/\s+/g, ' ').trim().slice(-200);
  }
  const step = STEP_LABEL.exec(prose);
  if (step && !NOTHING.test(step[3].replace(/[*_`]/g, ''))) out.step = `${step[2]}: ${step[3]}`.replace(/\s+/g, ' ').trim().slice(0, 160);
  const ask = !out.step && CONTINUE_ASK.exec(prose);
  if (ask) out.step = ask[0].replace(/\s+/g, ' ').trim();
  return out;
}

/** P-059: the reason of the Stop block and of the PreToolUse denial of a dialog that repeats an answered question. */
export const REPEATED_QUESTION_REASON = (oldItem, newItem) => `the operator already answered a question of this kind in this thread ("${String(oldItem).slice(0, 120)}"); you now ask "${String(newItem).slice(0, 120)}": his decision stands for further steps of the same kind. Act on it and report in the body what you did and what you could not verify yourself (e.g. the look in a browser). When the step is serious (irreversible: deleting data, git history, money, a message to a third party, a secret, a write to an external service or account: its settings, profile or data) or his decision does not cover it (another scope: he agreed to drafts without a write and this asks for the write; he rejected the previous version or asked for this preview), ask the same question again now: a repeat in this turn passes (P-059)`;

/** Does the Handover section (parseReply().handover) have a line `<id> → <step>` for every topic in `ids`, every line in
 * that form, or say žiadny with no line when `ids` is empty? */
export function handoverMatches(handover, ids) {
  if (!handover || typeof handover !== 'object' || handover.old) return false;
  if (!ids.length) return handover.none && !handover.items.length;
  if (handover.none || handover.items.some((i) => !i.topic)) return false;
  const topics = handover.items.map((i) => i.topic.toLowerCase());
  return ids.every((id) => topics.includes(String(id).toLowerCase()));
}
