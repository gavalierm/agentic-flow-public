// Row schema of index/<source>.jsonl (docs: one JSON object per file). The describer fields of the full design
// (title/desc by LLM, entities) are not written in the MVP; `profiled` is a row described only by its profile.
import { KINDS } from './kinds.mjs';

export const SCHEMA_VERSION = 1;
export const STATUSES = ['pending', 'profiled', 'described', 'stale', 'duplicate', 'skipped', 'error'];

export function validateLine(row) {
  const errs = [];
  if (!row || typeof row !== 'object') return ['not an object'];
  if (row.v !== SCHEMA_VERSION) errs.push(`v ${row.v}`);
  for (const k of ['source', 'path', 'kind', 'status']) if (typeof row[k] !== 'string' || !row[k]) errs.push(`${k} missing`);
  if (!KINDS.includes(row.kind)) errs.push(`kind ${row.kind}`);
  if (!STATUSES.includes(row.status)) errs.push(`status ${row.status}`);
  if (!Number.isFinite(row.size)) errs.push('size');
  return errs;
}
