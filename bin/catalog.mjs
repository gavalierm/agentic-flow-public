#!/usr/bin/env node
// catalog.mjs scan [--full] [--source <n>] | profile [--source <n>] [--path <p>] [--budget <s>] | find <slová> [--kind k] [--source n] [--all] [--json]
//             | show <cesta> [--json] | sql <cesta> "<SELECT ...>" | overview | status [--json]
// Katalóg dát projektu: index súborov zdrojov z `catalog.sources` v local/workflow.json (bez zdroja je katalóg vypnutý).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { catalogConfig } from '../scripts/catalog/config.mjs';
import { scanAll } from '../scripts/catalog/scan.mjs';
import { profileAll } from '../scripts/catalog/profiles.mjs';
import { findCatalog, formatMatch, formatCatalogBlock, getRow } from '../scripts/catalog/find.mjs';
import { writeOverview } from '../scripts/catalog/overview.mjs';
import { readManifest, readJsonSafe, paths, readIndex } from '../scripts/catalog/index.mjs';
import { hasTool, detectTools } from '../scripts/catalog/tools.mjs';
import { kindSummary } from '../scripts/catalog/hooks.mjs';

const USAGE = 'usage: catalog.mjs scan [--full] | profile [--path p] | find <slová> [--kind k] [--source n] [--all] | show <cesta> | sql <cesta> "<SELECT ...>" | overview | status';
const DISABLED = 'katalóg je vypnutý: repo nemá zdroj. Pridaj do <repo>/local/workflow.json {"catalog":{"sources":{"data":{"path":"/cesta/k/dátam","mode":"ro"}}}}';

const args = parseArgs(process.argv.slice(2));
// Switches without a value: parseArgs gives them the next word, so `find --all csv` lost its search words (pilot 2026-11-08).
for (const k of ['all', 'json', 'full']) {
  if (typeof args[k] === 'string') { args._.push(args[k]); args[k] = true; }
}
const out = (s) => process.stdout.write(`${s}\n`);

// SQL of `catalog.mjs sql`: a single read-only SELECT over the table `t`; nothing that reads other files or changes state.
const SQL_FORBIDDEN = /\b(copy|attach|detach|install|load|pragma|create|insert|update|delete|drop|alter|export|import|call|set|read_[a-z_]+|glob|parquet_scan|sniff_csv|getenv|system)\b|https?:|;|--|\/\*/i;
export function checkSelect(sql) {
  const s = String(sql || '').trim();
  if (!s) return 'chýba dotaz';
  if (!/^(select|with)\b/i.test(s)) return 'povolený je iba SELECT (alebo WITH … SELECT)';
  if (/\b(from|join)\s*['"]/i.test(s)) return 'zakázaný prvok dotazu: súbor alebo adresa za FROM (dotaz je iba čítanie jednej tabuľky t)';
  const bad = SQL_FORBIDDEN.exec(s.replace(/'(?:[^']|'')*'/g, "''")); // string literals may contain anything
  if (bad) return `zakázaný prvok dotazu: ${bad[0]} (dotaz je iba čítanie jednej tabuľky t)`;
  return null;
}

function cmdScan(cfg) {
  const res = scanAll(cfg, { full: !!args.full, only: args.source || null, waitMs: 5000 });
  if (res.skipped_busy) fail('katalóg je zaneprázdnený (iný scan beží), skús znova');
  for (const s of res.sources) {
    const state = s.available ? (s.complete === false ? 'neúplný, pokračuje ďalší scan' : 'kompletný') : `nedostupný (${s.reason}), index nezmenený`;
    out(`${s.name}: ${s.total} súborov (${kindSummary(s.kinds)}); nové ${s.new}, zmenené ${s.changed}, presunuté ${s.moved}, zmazané ${s.removed}; bez hashu ${s.hash_pending}; ${state}`);
  }
  for (const e of res.errors) out(`chyba ${e.source}: ${e.message}`);
  if (res.gitignore_added) out('.gitignore: doplnené local/catalog/');
  try { writeOverview(cfg); } catch (err) { out(`prehľad sa nezapísal: ${err.message}`); }
  if (res.errors.length) process.exitCode = 1;
}

function cmdProfile(cfg) {
  const budget = args.budget ? Number(args.budget) * 1000 : Infinity;
  if (args.budget && !(budget > 0)) fail('--budget je počet sekúnd');
  const res = profileAll(cfg, { source: args.source || null, only: args.path || null, deadline: Date.now() + budget, waitMs: 5000 });
  for (const r of res) out(`${r.source}: profilovaných ${r.profiled}, ostáva ${r.pending}${r.aborted ? ' (rozpočet vyčerpaný, spusti znova)' : ''}${r.busy ? ' (katalóg zaneprázdnený)' : ''}`);
  try { writeOverview(cfg); } catch { /* the overview is derived */ }
}

function cmdFind(cfg) {
  const q = args._.slice(1).join(' ');
  if (!q) fail('usage: catalog.mjs find <slová> [--kind k] [--source n] [--all] [--json]');
  const all = !!args.all;
  const res = findCatalog(cfg, q, { kind: args.kind || null, source: args.source || null, limit: all ? 0 : cfg.find.max_lines });
  if (args.json) return out(JSON.stringify(res.matches));
  if (!res.total) return out(`katalóg: bez zhody pre "${q}"`);
  if (all && res.total > cfg.find.max_lines) {
    // an unlimited list goes to a file, not into the context
    const dir = path.join(cfg.repo, 'scratch');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `catalog-find-${Date.now()}.txt`);
    fs.writeFileSync(file, res.matches.map(formatMatch).join('\n') + '\n');
    return out(`katalóg: ${res.total} zhôd zapísaných do ${file}`);
  }
  out(formatCatalogBlock(res, cfg));
}

function cmdShow(cfg) {
  const ref = args._[1];
  if (!ref) fail('usage: catalog.mjs show <cesta>');
  const r = getRow(cfg, ref, process.cwd());
  if (r.error) fail(r.error);
  out(JSON.stringify(r.row, null, args.json ? 0 : 2));
}

function cmdSql(cfg) {
  const ref = args._[1];
  const query = args._.slice(2).join(' ');
  if (!ref || !query) fail('usage: catalog.mjs sql <cesta> "<SELECT … FROM t …>"');
  const r = getRow(cfg, ref, process.cwd());
  if (r.error) fail(r.error);
  const row = r.row;
  if (row.kind !== 'csv') fail(`sql je iba pre CSV; ${row.source}/${row.path} je ${row.kind}`);
  const bad = checkSelect(query);
  if (bad) fail(bad);
  const source = cfg.sources.find((s) => s.name === row.source);
  const abs = path.join(source.path, ...row.path.split('/'));
  const p = row.profile || {};
  const delim = p.delimiter || ',';
  const header = p.has_header !== false;
  if (!hasTool('duckdb')) {
    out(`duckdb nie je v PATH. Bez neho: awk -F'${delim === '\t' ? '\\t' : delim}' 'NR>1 {…}' ${JSON.stringify(abs)}`);
    out(`Hlavička a typy sú v profile: node ${process.argv[1]} show ${row.source}/${row.path}`);
    process.exitCode = 2;
    return;
  }
  if (p.encoding && !/^utf-?8/i.test(p.encoding)) fail(`duckdb číta iba utf-8 (súbor je ${p.encoding}); najprv iconv -f ${p.encoding} -t utf-8 do ${cfg.repo}/scratch/`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // t is created first, then external access (other files, http) is switched off for the user's query; it cannot be switched back on
  const sql = `CREATE TABLE t AS SELECT * FROM read_csv_auto(${q(abs)}, delim=${q(delim)}, header=${header ? 'true' : 'false'}); SET enable_external_access=false; ${query}`;
  // argument array, no shell; in-memory database, results as CSV
  const res = spawnSync(hasTool('duckdb'), [':memory:', '-csv', '-c', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (res.error) fail(`duckdb zlyhal: ${res.error.message}`);
  process.stdout.write(res.stdout || '');
  if (res.status !== 0) { process.stderr.write(res.stderr || ''); process.exitCode = res.status || 1; }
}

function cmdOverview(cfg) {
  for (const f of writeOverview(cfg)) out(f);
}

function cmdStatus(cfg) {
  const manifest = readManifest(cfg.dir);
  const lastError = readJsonSafe(paths(cfg.dir, '_').lastError, null);
  const info = {
    repo: cfg.repo,
    dir: cfg.dir,
    tools: detectTools(),
    last_error: lastError,
    sources: cfg.sources.map((s) => {
      const m = manifest.sources?.[s.name] || null;
      const state = readJsonSafe(paths(cfg.dir, s.name).state, null);
      return { name: s.name, mode: s.mode, path: s.path, indexed: readIndex(cfg.dir, s.name).length, scanned_at: m?.scanned_at || null, available: m?.available ?? null, complete: state?.complete ?? null, kinds: m?.kinds || null, statuses: m?.statuses || null, duplicates: m?.duplicates ?? null, hash_pending: m?.hash_pending ?? null };
    }),
  };
  if (args.json) return out(JSON.stringify(info));
  out(`katalóg: ${cfg.dir}`);
  out(`nástroje: ${Object.entries(info.tools).map(([k, v]) => `${k} ${v ? 'áno' : 'nie'}`).join(', ')}`);
  for (const s of info.sources) {
    out(`${s.name} (${s.mode}) ${s.path}: ${s.indexed} súborov${s.kinds ? ` (${kindSummary(s.kinds)})` : ''}; posledný scan ${s.scanned_at || 'nikdy'}${s.available === false ? '; zdroj nedostupný' : ''}${s.complete === false ? '; neúplný' : ''}`);
    if (s.statuses) out(`  stavy: ${Object.entries(s.statuses).map(([k, v]) => `${k} ${v}`).join(', ')}; duplikáty ${s.duplicates ?? 0}; bez hashu ${s.hash_pending ?? 0}`);
  }
  if (lastError) out(`posledná chyba (${lastError.source}, ${lastError.at}): ${lastError.message}`);
}

const COMMANDS = { scan: cmdScan, profile: cmdProfile, find: cmdFind, show: cmdShow, sql: cmdSql, overview: cmdOverview, status: cmdStatus };

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cmd = args._[0];
    if (!COMMANDS[cmd]) fail(USAGE);
    const ctx = loadContext({ project: args.project, requireBrain: false });
    const cfg = catalogConfig(ctx.projectDir);
    if (!cfg.enabled) fail(DISABLED);
    fs.mkdirSync(cfg.dir, { recursive: true });
    COMMANDS[cmd](cfg);
  } catch (err) {
    fail(err.message);
  }
}
