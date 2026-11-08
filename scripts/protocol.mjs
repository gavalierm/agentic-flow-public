// P-061: the reply protocol. The end of a turn is declared, not guessed from prose: the last line of the final reply is
// `Stav: hotovo|otázka|čakám` and a question sits under `**Pre teba:**`. Code reads only this fixed form and checks the
// declared state against facts (handover, wakers); any other wording of a promise or a wait is no state at all
// (operator 2026-11-08: "a hook that catches variants of promises is never reliable, the agent writes another one").
// `čakám` names what it waits for: `Stav: čakám (na <čo>)` (operator 2026-11-08: "musí napísať aj na čo sa čaká").

export const STATES = ['hotovo', 'otázka', 'čakám'];
const ASCII = { hotovo: 'hotovo', otazka: 'otázka', cakam: 'čakám' };

export const STATE_LINE = 'Stav: hotovo | otázka | čakám (na <čo>)';
export const WAIT_LINE = 'Stav: čakám (na <čo>)';

/** What a `čakám` state line waits for: "(na pracovníka)" or "na pracovníka" -> "na pracovníka"; null without letters. */
function waitTarget(rest) {
  const t = rest.replace(/^\((.*)\)$/s, '$1').replace(/^[\s,:–-]+/, '').trim();
  return /\p{L}{2,}/u.test(t) ? t : null;
}

/**
 * The declared state of a reply ('hotovo' | 'otázka' | 'čakám') or null, the question under "Pre teba" or null, and for
 * `čakám` what it waits for (`waitFor`, null when the line does not say it). Only `čakám` may carry text after the word.
 */
export function parseReply(text) {
  const out = { state: null, question: null, waitFor: null };
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
  const pre = /(^|\n)\s*[*_]*Pre teba[*_:]*\s*/i.exec(body);
  if (pre) {
    const rest = body.slice(pre.index + pre[0].length);
    const qi = rest.indexOf('?');
    if (qi >= 0) out.question = rest.slice(0, qi + 1).replace(/\s+/g, ' ').trim().slice(-200);
  }
  return out;
}
