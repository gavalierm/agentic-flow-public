// P-061: the reply protocol. The end of a turn is declared, not guessed from prose: the last line of the final reply is
// `Stav: hotovo|otázka|čakám` and everything that waits on the operator is a checklist under `**Operátor:**`. Code reads
// only this fixed form and checks the
// declared state against facts (handover, wakers); any other wording of a promise or a wait is no state at all
// (operator 2026-11-08: "a hook that catches variants of promises is never reliable, the agent writes another one").
// `čakám` names what it waits for: `Stav: čakám (na <čo>)` (operator 2026-11-08: "musí napísať aj na čo sa čaká").
// A step is never a sentence (operator 2026-11-09: carol ended "Ostáva: … zmažem ho až na tvoje potvrdenie" with
// "Stav: hotovo"; "všetky zadávania pokynov, čakania… musia byť protokolované, nie voľný text"): what the operator decides,
// confirms or does is an item of the Operátor checklist, an own step is done or saved in the handover, a wait is the
// state line. A label that writes a step as prose ("Ostáva:", "Ďalší krok:") is outside the protocol.

export const STATES = ['hotovo', 'otázka', 'čakám'];
const ASCII = { hotovo: 'hotovo', otazka: 'otázka', cakam: 'čakám' };

export const STATE_LINE = 'Stav: hotovo | otázka | čakám (na <čo>)';
export const WAIT_LINE = 'Stav: čakám (na <čo>)';

/** What a `čakám` state line waits for: "(na pracovníka)" or "na pracovníka" -> "na pracovníka"; null without letters. */
function waitTarget(rest) {
  const t = rest.replace(/^\((.*)\)$/s, '$1').replace(/^[\s,:–-]+/, '').trim();
  return /\p{L}{2,}/u.test(t) ? t : null;
}

export const OPERATOR_MARK = '**Operátor:**';
// "Pre teba" is the marker before v0.9.43; it still opens the block.
const OPERATOR_BLOCK = /(^|\n)[ \t]*[*_]*(?:Operátor|Operator|Pre teba)[*_]*[ \t]*:[*_]*[ \t]*/iu;
const ITEM = /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]?\][ \t]*)?|\d+[.)][ \t]+|\[[ xX]?\][ \t]*)(.*)$/;
// A step written as prose under a label, at the start of a line (list marker and markdown allowed).
const STEP_LABEL = /(^|\n)[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?[*_]*(ostáva|zostáva|zvyšok|ďalší krok|ďalšie kroky|ďalej treba|next steps?|remaining|todo|to do)[*_]*[ \t]*:[*_]*[ \t]*([^\n]*)/iu;
// A request that the operator write "pokračuj" makes the operator the waker (bob 2026-11-11, after a bypass lock).
const CONTINUE_ASK = /(?:napíš|napíšte|napis|napiste|napísať|napisat|write|type|say)[ \t]+[„"'`*_]*(pokračuj|pokracuj|continue|go on)(?![\p{L}])/iu;
const NOTHING = /^(nič|nic|žiadn\p{L}*|nothing|none|-|–|—)?[.\s]*$/iu;

/** The items of the Operátor block: inline text after the marker and the list lines under it, up to an empty line. */
function operatorItems(body) {
  const m = OPERATOR_BLOCK.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length).split('\n');
  const items = [];
  const first = rest[0].replace(/[*_]+$/, '').trim();
  if (first) items.push(first.replace(ITEM, '$1').trim());
  for (const line of rest.slice(1)) {
    if (!line.trim()) { if (items.length) break; continue; }
    const it = ITEM.exec(line);
    if (!it) break;
    if (it[1].trim()) items.push(it[1].trim());
  }
  return items.filter((i) => !NOTHING.test(i));
}

/**
 * The declared state of a reply ('hotovo' | 'otázka' | 'čakám') or null; `operator`, the items under **Operátor:**
 * (null without the block); `question`, the first item (up to its question mark when it has one) or null; for `čakám`
 * what it waits for (`waitFor`, null when the line does not say it); `step`, a step written as prose under a label
 * ("Ostáva: …") or null. Only `čakám` may carry text after the word.
 */
export function parseReply(text) {
  const out = { state: null, question: null, waitFor: null, operator: null, step: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  const lines = text.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1].replace(/[*_`>]/g, '').trim();
  const m = /^stav\s*:\s*([^\s.(]+)\s*(.*?)\s*\.?$/i.exec(last);
  if (m) {
    const word = m[1].toLowerCase();
    const plain = word.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const state = STATES.includes(word) ? word : ASCII[plain] || null;
    if (state === 'čakám') {
      out.state = state;
      out.waitFor = waitTarget(m[2]);
    } else if (!m[2]) out.state = state;
  }
  const body = lines.slice(0, -1).join('\n');
  const prose = body.replace(/```[\s\S]*?```/g, '');
  out.operator = operatorItems(prose);
  if (out.operator?.length) {
    const q = out.operator[0];
    const qi = q.indexOf('?');
    out.question = (qi >= 0 ? q.slice(0, qi + 1) : q).replace(/\s+/g, ' ').trim().slice(-200);
  }
  const step = STEP_LABEL.exec(prose);
  if (step && !NOTHING.test(step[3].replace(/[*_`]/g, ''))) out.step = `${step[2]}: ${step[3]}`.replace(/\s+/g, ' ').trim().slice(0, 160);
  const ask = !out.step && CONTINUE_ASK.exec(prose);
  if (ask) out.step = ask[0].replace(/\s+/g, ' ').trim();
  return out;
}
