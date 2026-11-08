// CSV profile without an LLM and without dependencies: delimiter, encoding (utf-8, cp1250), header, column types,
// min/max, low-cardinality values, a few sample rows. The file is read once as a stream; PII columns are masked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readAt, headHash } from './hash.mjs';
import { normalizeKey } from '../keys.mjs';

const MB = 1024 * 1024;
const CHUNK = 4 * MB;
const CANDIDATES = [';', ',', '\t', '|'];
export const MASK = '***';

/** Streaming CSV record parser (RFC 4180 quoting, CRLF, newlines inside quotes). Blank lines are skipped. */
export class CsvParser {
  constructor(delim, onRecord) {
    this.delim = delim.charCodeAt(0);
    this.onRecord = onRecord;
    this.row = [];
    this.buf = '';
    this.inQuotes = false;
    this.pendingQuote = false;
    this.skipLF = false;
  }

  feed(s) {
    const n = s.length;
    let i = 0;
    let start = 0;
    if (this.skipLF) { this.skipLF = false; if (s.charCodeAt(0) === 10) { i = 1; start = 1; } }
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (s.charCodeAt(0) === 34) { this.buf += '"'; i = Math.max(i, 1); start = i; } else this.inQuotes = false;
    }
    while (i < n) {
      const c = s.charCodeAt(i);
      if (this.inQuotes) {
        if (c !== 34) { i++; continue; }
        this.buf += s.slice(start, i);
        if (i + 1 >= n) { this.pendingQuote = true; i++; start = i; break; }
        if (s.charCodeAt(i + 1) === 34) { this.buf += '"'; i += 2; } else { this.inQuotes = false; i++; }
        start = i;
      } else if (c === 34 && i === start && this.buf === '') {
        this.inQuotes = true;
        i++;
        start = i;
      } else if (c === this.delim) {
        this.row.push(this.buf + s.slice(start, i));
        this.buf = '';
        i++;
        start = i;
      } else if (c === 10 || c === 13) {
        this.row.push(this.buf + s.slice(start, i));
        this.buf = '';
        this.#record();
        if (c === 13) { if (i + 1 < n) { if (s.charCodeAt(i + 1) === 10) i++; } else this.skipLF = true; }
        i++;
        start = i;
      } else i++;
    }
    if (start < n && !this.pendingQuote) this.buf += s.slice(start);
  }

  end() {
    if (this.pendingQuote) { this.pendingQuote = false; this.inQuotes = false; }
    if (this.buf !== '' || this.row.length) { this.row.push(this.buf); this.buf = ''; this.#record(); }
  }

  #record() {
    const row = this.row;
    this.row = [];
    if (row.length === 1 && row[0] === '') return;
    this.onRecord(row);
  }
}

const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_DMY = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/;
const INT = /^[+-]?(?:0|[1-9]\d{0,17})$/;
const DEC = /^[+-]?\d+[.,]\d+$/;
const GROUPED = /^[+-]?\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?$/;

const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000;
const pad = (n) => String(n).padStart(2, '0');

/** { t: 'null'|'integer'|'number'|'date'|'boolean'|'string', v?: value } of one cell. */
export function classify(raw) {
  const s = raw.trim();
  if (s === '') return { t: 'null' };
  if (INT.test(s)) return { t: 'integer', v: Number(s) };
  if (DEC.test(s)) return { t: 'number', v: parseFloat(s.replace(',', '.')) };
  if (GROUPED.test(s)) { const v = parseFloat(s.replace(/[  ]/g, '').replace(',', '.')); return { t: /[.,]/.test(s) ? 'number' : 'integer', v }; }
  let m = DATE_ISO.exec(s);
  if (m && validDate(+m[1], +m[2], +m[3])) return { t: 'date', v: `${m[1]}-${m[2]}-${m[3]}` };
  m = DATE_DMY.exec(s);
  if (m && validDate(+m[3], +m[2], +m[1])) return { t: 'date', v: `${m[3]}-${pad(m[2])}-${pad(m[1])}` };
  if (/^(true|false)$/i.test(s)) return { t: 'boolean' };
  return { t: 'string' };
}

/** A column name that holds personal data: token sequence match against `csv.pii_columns` (never values, never samples). */
export function isPiiColumn(name, list) {
  const norm = `-${normalizeKey(String(name).replace(/([a-z])([A-Z])/g, '$1 $2'))}-`;
  return list.some((term) => norm.includes(`-${normalizeKey(term)}-`));
}

function decodeSample(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); return 'utf-8'; } catch { return 'windows-1250'; }
}

function detectDelimiter(text, truncated) {
  let best = null;
  for (const d of CANDIDATES) {
    const counts = [];
    const p = new CsvParser(d, (r) => { if (counts.length < 21) counts.push(r.length); });
    p.feed(text);
    if (!truncated) p.end();
    const used = counts.slice(0, 20);
    if (!used.length) continue;
    const freq = new Map();
    for (const c of used) freq.set(c, (freq.get(c) || 0) + 1);
    const [modal, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const consistency = hits / used.length;
    if (modal < 2 || consistency < 0.9) continue;
    if (!best || modal > best.modal) best = { d, modal };
  }
  return best?.d || ',';
}

function headerNames(row) {
  const seen = new Map();
  return row.map((v, i) => {
    let name = v.trim() || `col${i + 1}`;
    const key = name.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) name = `${name}_${n}`;
    return name;
  });
}

const looksHeader = (r1, r2) => {
  const kinds = r1.map((v) => classify(v).t);
  if (kinds.some((t) => t !== 'string')) return false;
  if (!r2) return true;
  const unique = new Set(r1.map((v) => v.trim().toLowerCase())).size === r1.length;
  return unique || r2.some((v) => ['integer', 'number', 'date'].includes(classify(v).t));
};

export const columnsHash = (names) => `sha1:${crypto.createHash('sha1').update(names.map((n) => n.trim().toLowerCase()).join('\u0001')).digest('hex')}`;

/**
 * Profile of a CSV file. `cfg` = catalog `csv` section (sample_rows, low_cardinality, profile_max_mb, partial_mb,
 * pii_columns). Returns the profile, `{ aborted: true }` when the deadline passed, or null when the file is unreadable.
 */
export function profileCsv(file, size, cfg, { deadline = Infinity } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, Math.min(size, 64 * 1024));
    if (!head.length) return { delimiter: ',', encoding: 'utf-8', has_header: false, rows: 0, rows_exact: true, columns: [], sample: [], partial: false, profiled_mb: 0, engine: 'node-stream', head_hash: headHash(file), head_bytes: 0, columns_hash: columnsHash([]) };
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return null; // utf-16 is not read
    const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
    const encoding = decodeSample(head.subarray(bom));
    const sampleText = new TextDecoder(encoding).decode(head.subarray(bom));
    const delim = detectDelimiter(sampleText, size > head.length);

    const limit = cfg.profile_max_mb * MB;
    const partial = size > limit;
    const readUntil = partial ? Math.min(size, cfg.partial_mb * MB) : size;
    const lowCard = cfg.low_cardinality;
    const state = { header: null, names: null, cols: null, rows: 0, ragged: 0, sample: [], pending: null };

    const startColumns = () => {
      state.cols = state.names.map((name) => ({
        name, pii: isPiiColumn(name, cfg.pii_columns), nulls: 0, n: 0, integer: 0, number: 0, date: 0, boolean: 0, string: 0,
        min: null, max: null, sum: 0, dmin: null, dmax: null, distinct: new Set(), overflow: false,
      }));
    };
    const data = (row) => {
      state.rows++;
      if (row.length !== state.cols.length) state.ragged++;
      if (state.sample.length < cfg.sample_rows) state.sample.push(row.slice(0, state.cols.length).map((v, i) => (state.cols[i].pii ? MASK : v.length > 60 ? `${v.slice(0, 60)}…` : v)));
      for (let i = 0; i < state.cols.length; i++) {
        const c = state.cols[i];
        const v = row[i];
        if (v === undefined) { c.nulls++; continue; }
        const k = classify(v);
        if (k.t === 'null') { c.nulls++; continue; }
        c.n++;
        c[k.t]++;
        if (c.pii) continue;
        if (k.t === 'integer' || k.t === 'number') {
          c.sum += k.v;
          if (c.min === null || k.v < c.min) c.min = k.v;
          if (c.max === null || k.v > c.max) c.max = k.v;
        } else if (k.t === 'date') {
          if (c.dmin === null || k.v < c.dmin) c.dmin = k.v;
          if (c.dmax === null || k.v > c.dmax) c.dmax = k.v;
        } else if (k.t === 'string' && !c.overflow) {
          c.distinct.add(v.length > 40 ? `${v.slice(0, 40)}…` : v);
          if (c.distinct.size > lowCard) { c.overflow = true; c.distinct = new Set(); }
        }
      }
    };
    const onRecord = (row) => {
      if (!state.header && !state.cols) {
        if (!state.pending) { state.pending = row; return; }
        const hasHeader = looksHeader(state.pending, row);
        state.hasHeader = hasHeader;
        state.names = hasHeader ? headerNames(state.pending) : state.pending.map((_, i) => `col${i + 1}`);
        startColumns();
        const first = state.pending;
        state.pending = null;
        if (!hasHeader) data(first);
        data(row);
        return;
      }
      data(row);
    };
    const parser = new CsvParser(delim, onRecord);
    const dec = new TextDecoder(encoding, { fatal: false });

    let pos = bom;
    let consumed = bom;
    while (pos < readUntil) {
      if (Date.now() > deadline) return { aborted: true };
      const buf = readAt(fd, pos, Math.min(CHUNK, readUntil - pos));
      if (!buf.length) break;
      pos += buf.length;
      parser.feed(dec.decode(buf, { stream: true }));
      consumed = pos;
    }
    parser.feed(dec.decode());
    if (!partial) parser.end();
    if (state.pending) { // a file with a single record
      state.hasHeader = looksHeader(state.pending, null);
      state.names = state.hasHeader ? headerNames(state.pending) : state.pending.map((_, i) => `col${i + 1}`);
      startColumns();
      if (!state.hasHeader) data(state.pending);
    }
    if (!state.cols) return null;

    const columns = state.cols.map((c) => {
      const out = { name: c.name, type: resolveType(c), nulls: c.nulls };
      if (c.pii) { out.pii = true; out.values = MASK; return out; }
      if (out.type === 'integer' || out.type === 'number') { out.min = c.min; out.max = c.max; out.sum = Math.round(c.sum * 1e6) / 1e6; }
      if (out.type === 'date') { out.min = c.dmin; out.max = c.dmax; }
      if (out.type === 'string') {
        if (c.overflow) out.distinct = `>${lowCard}`;
        else { out.distinct = c.distinct.size; out.values = [...c.distinct].sort(); }
      }
      return out;
    });
    let rows = state.rows;
    if (partial && state.rows > 0) rows = Math.round(state.rows * (size / Math.max(1, consumed)));
    return {
      delimiter: delim,
      encoding,
      has_header: state.hasHeader ?? false,
      rows,
      rows_exact: !partial,
      columns_hash: columnsHash(state.names),
      columns,
      sample: state.sample,
      partial,
      profiled_mb: Math.round((consumed / MB) * 10) / 10,
      engine: 'node-stream',
      head_hash: headHash(file),
      head_bytes: Math.min(size, 64 * 1024),
      ...(state.ragged ? { ragged_rows: state.ragged } : {}),
      sheet: null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

function resolveType(c) {
  if (c.n === 0) return 'empty';
  if (c.integer === c.n) return 'integer';
  if (c.integer + c.number === c.n) return 'number';
  if (c.date === c.n) return 'date';
  if (c.boolean === c.n) return 'boolean';
  return 'string';
}

/** One line from a CSV profile for the row description (no cell values). */
export function describeCsv(p) {
  const names = p.columns.map((c) => c.name);
  const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
  const date = p.columns.find((c) => c.type === 'date' && c.min);
  const period = date ? `, obdobie ${date.min} až ${date.max}` : '';
  return `CSV, ${p.rows_exact ? '' : '~'}${p.rows} riadkov, ${names.length} stĺpcov (${shown})${period}`;
}
