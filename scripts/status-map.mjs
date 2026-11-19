// Status map (skill proposal, P-077): one page that shows what is done and what is not, as a tree. The page is the
// template templates/status-map.html with the checked data in it; the agent writes only the data (operator 2026-11-20:
// the tree of chips and notes reads at a glance, so every state overview has this one form).
import fs from 'node:fs';

export const TEMPLATE = new URL('../templates/status-map.html', import.meta.url);

/** State of an item -> label on the page; the order is the order of the filter. A page may rename a label, not add a state. */
export const STATES = { done: 'Hotové', work: 'Rozpracované', wait: 'Čaká na teba', miss: 'Chýba', off: 'Zrušené' };
export const DEFAULT_SUB = 'Zelené štítky sú hotové, lístky s poznámkou sa robia, čakajú na teba alebo chýbajú.';

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const stampNow = (now) => new Intl.DateTimeFormat('sk-SK', { dateStyle: 'medium', timeStyle: 'short' }).format(now);

/**
 * Checks the data of a status map and fills the defaults. Throws with the place of the first fault: a page with a wrong
 * state would show the item as nothing.
 *   { title, sub?, stamp?, root: {name, note?} | "name", states?: {key: label},
 *     areas: [{ name, side?: "left"|"right", items: [[state, what, ref?, note?]] }], log?: [[when, text]] }
 */
export function statusMapData(raw, { now = new Date() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('data is not an object');
  const title = text(raw.title);
  if (!title) throw new Error('title is missing');
  const root = typeof raw.root === 'object' && raw.root ? { name: text(raw.root.name), note: text(raw.root.note) } : { name: text(raw.root), note: '' };
  if (!root.name) throw new Error('root.name is missing (the node every area hangs on)');
  const states = { ...STATES };
  for (const [k, v] of Object.entries(raw.states || {})) {
    if (!(k in STATES)) throw new Error(`states.${k}: unknown state (${Object.keys(STATES).join(', ')})`);
    if (text(v)) states[k] = text(v);
  }
  if (!Array.isArray(raw.areas) || !raw.areas.length) throw new Error('areas is empty');
  const load = { left: 0, right: 0 };
  const areas = raw.areas.map((a, i) => {
    const name = text(a?.name);
    if (!name) throw new Error(`areas[${i}].name is missing`);
    if (!Array.isArray(a.items) || !a.items.length) throw new Error(`area "${name}": items is empty`);
    const items = a.items.map((it, j) => {
      if (!Array.isArray(it)) throw new Error(`area "${name}" item ${j + 1}: not [state, what, ref, note]`);
      const [state, what, ref, note] = it.map(text);
      if (!(state in STATES)) throw new Error(`area "${name}" item ${j + 1}: state "${state}" (${Object.keys(STATES).join(', ')})`);
      if (!what) throw new Error(`area "${name}" item ${j + 1}: what is empty`);
      return [state, what, ref || '', note || ''];
    });
    if (a.side !== undefined && a.side !== 'left' && a.side !== 'right') throw new Error(`area "${name}": side "${a.side}" (left, right)`);
    // Without a side the area goes to the shorter column, so both columns end at about the same height.
    const side = a.side || (load.left <= load.right ? 'left' : 'right');
    load[side] += items.length + 2;
    return { name, side, items };
  });
  const log = (raw.log || []).map((row, i) => {
    if (!Array.isArray(row) || !text(row[1])) throw new Error(`log[${i}]: not [when, text]`);
    return [text(row[0]), text(row[1])];
  });
  const key = `stav-${title.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40)}`;
  return { title, sub: text(raw.sub) || DEFAULT_SUB, stamp: text(raw.stamp) || stampNow(now), root, states, areas, log, key };
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** The page of a status map. `<` in the data is written as its unicode escape: a text with `</script>` must not end the script. */
export function statusMapPage(raw, opts) {
  const data = statusMapData(raw, opts);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return fs.readFileSync(TEMPLATE, 'utf8').replace('__TITLE__', () => escapeHtml(data.title)).replace('__DATA__', () => json);
}
