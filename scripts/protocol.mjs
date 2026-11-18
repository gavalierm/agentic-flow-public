// P-061, spec 10: the reply protocol. The end of a turn is declared in a fixed skeleton, the result text above it is free:
// the last line of the final reply is `**Stav:** hotovo|otázka|čakám (na <čo>)`; what waits on the operator is a numbered
// list under `**Otázky na operátora:**` (decisions, confirmations) or `**Úlohy pre operátora:**` (steps only the operator
// does). The reply needs no `**Handover:**` section (operator 2026-11-18: the next step is the handover file); an old one
// before the state line is still parsed, so it is no part of the answer. Code reads only this skeleton and checks the
// declared state against facts (handover, alarms; spec 10.3); the text of the result is never read (spec 10.4: a sentence
// is no step, the step is only the handover's Ďalší krok).

export const STATES = ['hotovo', 'otázka', 'čakám'];

const ASCII = { hotovo: 'hotovo', otazka: 'otázka', cakam: 'čakám' };

export const STATE_LINE = '**Stav:** hotovo | otázka | čakám (na <čo>)';
export const WAIT_LINE = '**Stav:** čakám (na <čo>)';
/** The end of a reply in the protocol (D-0040), quoted in hook messages. */
export const PROTOCOL_EXAMPLE = '"**Otázky na operátora:**\\n1. <otázka>\\n\\n**Stav:** otázka"';

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

// The old handover section (D-0040, no longer asked for): the heading `**Handover:**` (or the line `Handover: <téma> – <krok>`)
// with list lines under it up to the state line. Parsed only so it is no part of the answer body.
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
 * what it waits for (`waitFor`, null when the line does not say it). Only `čakám` may carry text after the word. `handover`:
 * an old Handover section before the state line, else null (tolerated, never required); `onlyProtocol`: nothing but the
 * state line (and such a section) in the reply.
 */
export function parseReply(text) {
  const out = { state: null, handover: null, oldForm: [], onlyProtocol: false, question: null, waitFor: null, operator: null, questions: null, tasks: null, legacyOperator: false, emptySection: null };
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
  if (section) out.handover = section;
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
  return out;
}
