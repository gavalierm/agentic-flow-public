// Catalog configuration (docs: key `catalog` in <repo>/local/workflow.json). The catalog is opt-in: without a source in
// the configuration every hook returns at once and the clean code repo gets nothing (no directory, no file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, isInside } from '../util.mjs';
import { mainCheckout, WORKFLOW_CONFIG, LOCAL_CONFIG } from '../config.mjs';

export const DEFAULT_IGNORE = ['.git/**', '**/.DS_Store', '**/Thumbs.db', '**/~$*', '**/.~lock.*', '**/.sync*/**', '**/.tmp.drivedownload/**', '**/node_modules/**'];
export const DEFAULT_PII_COLUMNS = ['email', 'e-mail', 'mail', 'telefon', 'tel', 'phone', 'mobil', 'rodne-cislo', 'rc', 'iban', 'ucet', 'cislo-uctu', 'datum-narodenia', 'birth', 'meno', 'priezvisko', 'adresa', 'address'];

const DEFAULTS = {
  ignore: DEFAULT_IGNORE,
  exclude_llm: [],
  max_file_mb: 500,
  partial_hash_mb: 64,
  scan: { hook_budget_ms: 4000, hash_budget_ms: 2500, max_files: 50000 },
  csv: { sample_rows: 5, low_cardinality: 20, profile_max_mb: 2048, partial_mb: 256, engine: 'auto', pii_columns: DEFAULT_PII_COLUMNS },
  archives: { max_entries: 200 },
  find: { max_lines: 20 },
  reminder: true,
};

/**
 * Repo whose `local/` holds the catalog: the main checkout, never a topic worktree (the data is not part of the repo,
 * so a topic has nothing to branch). A normal checkout has `.git` as a directory, so no git process is needed.
 */
export function catalogRepo(projectDir) {
  try {
    if (fs.statSync(path.join(projectDir, '.git')).isDirectory()) return path.resolve(projectDir);
  } catch { /* worktree (.git is a file) or no git */ }
  return mainCheckout(projectDir);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** `catalog` of .workflow.json with local/workflow.json on top: one level deep, `sources` merged by name. */
function mergeCatalog(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(isObj(b) ? b : {})) {
    out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
  }
  return out;
}

function expand(p, repo) {
  const s = String(p);
  if (s === '~' || s.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), s.slice(1));
  return path.resolve(repo, s);
}

/**
 * Normalized catalog configuration of the repo containing projectDir. `enabled` is false without a usable source.
 * Never throws: a broken configuration file means a disabled catalog.
 */
export function catalogConfig(projectDir) {
  const off = { enabled: false, sources: [] };
  try {
    const repo = catalogRepo(projectDir);
    const main = readJson(path.join(repo, WORKFLOW_CONFIG), {});
    const local = readJson(path.join(repo, LOCAL_CONFIG), {});
    const raw = mergeCatalog(main?.catalog, local?.catalog);
    const rawSources = isObj(raw.sources) ? raw.sources : {};
    const sources = [];
    for (const [name, s] of Object.entries(rawSources)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !isObj(s) || typeof s.path !== 'string' || !s.path) continue;
      const abs = expand(s.path, repo);
      sources.push({ name, path: abs, mode: s.mode === 'rw' ? 'rw' : 'ro' });
    }
    // materialy/ of the repo is a source of its own (rw: the topics save into it); catalog.materialy:false switches it off
    const mat = path.join(repo, 'materialy');
    if (raw.materialy !== false && !sources.some((s) => s.name === 'materialy') && fs.existsSync(mat)) sources.push({ name: 'materialy', path: mat, mode: 'rw' });
    if (!sources.length) return off;
    return {
      enabled: true,
      repo,
      dir: path.join(repo, 'local', 'catalog'),
      sources,
      ignore: Array.isArray(raw.ignore) ? raw.ignore.map(String) : DEFAULTS.ignore,
      exclude_llm: Array.isArray(raw.exclude_llm) ? raw.exclude_llm.map(String) : DEFAULTS.exclude_llm,
      max_file_mb: num(raw.max_file_mb, DEFAULTS.max_file_mb),
      partial_hash_mb: num(raw.partial_hash_mb, DEFAULTS.partial_hash_mb),
      scan: { ...DEFAULTS.scan, ...numbers(raw.scan) },
      csv: { ...DEFAULTS.csv, ...numbers(raw.csv), engine: raw.csv?.engine || DEFAULTS.csv.engine, pii_columns: Array.isArray(raw.csv?.pii_columns) ? raw.csv.pii_columns.map(String) : DEFAULTS.csv.pii_columns },
      archives: { ...DEFAULTS.archives, ...numbers(raw.archives) },
      find: { ...DEFAULTS.find, ...numbers(raw.find) },
      reminder: raw.reminder !== false,
    };
  } catch {
    return off;
  }
}

function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
}
function numbers(o) {
  const out = {};
  if (isObj(o)) for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  return out;
}

/** The source whose root contains abs (lexically or after realpath), or null. */
export function sourceOf(cfg, abs) {
  if (!cfg?.enabled || !abs) return null;
  for (const s of cfg.sources) if (isInside(s.path, abs)) return s;
  return null;
}

/** Same as sourceOf for a `<source>/<path>` or bare relative catalog path; returns { source, rel } or null. */
export function resolveRef(cfg, ref, cwd = process.cwd()) {
  const posix = String(ref).replace(/\\/g, '/');
  for (const s of cfg.sources) {
    if (posix === s.name) return { source: s, rel: '' };
    if (posix.startsWith(`${s.name}/`)) return { source: s, rel: posix.slice(s.name.length + 1) };
  }
  const abs = path.resolve(cwd, ref);
  const s = sourceOf(cfg, abs);
  if (s) return { source: s, rel: path.relative(s.path, abs).split(path.sep).join('/') };
  return null;
}
