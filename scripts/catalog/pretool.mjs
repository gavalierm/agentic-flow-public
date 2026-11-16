// PreToolUse parts of the catalog: deny of a write into a read-only source, and a one-line reminder (once per session,
// main thread only) that refuses the first shell listing or search over a source. The shell parsers of hooks/pre-tool-use.mjs are
// passed in (`h`), so this module needs no import of the hook (no cycle). Nothing here reads the index.
import fs from 'node:fs';
import path from 'node:path';
import { catalogConfig, sourceOf } from './config.mjs';
import { dataRel, workLabel, topicHome, separateProject, hasScratch } from '../layout.mjs';

const READERS = new Set(['ls', 'find', 'grep', 'egrep', 'fgrep', 'rg', 'cat']);
const SPLIT = /\s*(?:&&|\|\||;|\n|\|)\s*/;

/** Deny reason when a target lies in a `ro` source, else null. */
export function readOnlySourceDeny(cfg, absPaths, projectDir = null, brainDir = null) {
  // Where results and work files go, by the layout of the topic home (D-0048, D-0056: a brain in layout 2 holds the work
  // of a topic, else the project repo); without a project the logical names.
  let where = 'výsledky patria do práce témy a medzivýsledky do pracovných súborov (cesty v štarte, blok „Dáta tohto repa“)';
  try {
    if (projectDir) {
      const home = topicHome(brainDir, projectDir);
      const repo = separateProject(brainDir, projectDir) && path.resolve(home) === path.resolve(brainDir) ? 'brainu' : 'repa projektu';
      where = `výsledky patria do ${hasScratch(home) ? dataRel(home, 'materialy') : dataRel(home, 'topics')}/<téma>/ a medzivýsledky do ${workLabel(home)} ${repo}`;
    }
  } catch { /* unknown layout: the logical names */ }
  for (const p of absPaths) {
    const s = sourceOf(cfg, p);
    if (s && s.mode === 'ro') return `zápis do zdroja dát ${s.name} (iba čítanie): ${where}; zdroj klienta sa nemení; zdroj ${s.path} zapína catalog.sources.${s.name} v ${s.from}: ak je to priečinok práce témy, nie dáta klienta, oznám operátorovi zdroj a ten súbor`;
  }
  return null;
}

/** Targets a shell command writes, with the three parsers of the hook. */
export function shellWriteTargets(cmd, cwd, h) {
  return [...new Set([...h.bashTargets(cmd, cwd), ...h.bashEdits(cmd, cwd), ...h.shellWrites(cmd, cwd)])];
}

/** The first source a listing or search command (ls, find, grep, rg, cat) works in, or null. `cd` is followed. */
export function readerSource(cfg, cmd, cwd, h) {
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (p) => path.resolve(base, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const part of h.maskShell(cmd).split(SPLIT)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const lead = h.leadOf(words);
    const prog = words[lead]?.split('/').pop();
    if (prog === 'cd') {
      if (words[lead + 1] && !/[$`]/.test(words[lead + 1])) base = abs(h.unmask(words[lead + 1]));
      continue;
    }
    if (!READERS.has(prog)) continue;
    const args = words.slice(lead + 1).filter((w) => !w.startsWith('-') && !/^['"]?[$<>|(`]/.test(w) && !/^[0-9]*>/.test(w)).map((w) => h.unmask(w));
    const targets = args.filter((a) => !/[$`]/.test(a)).map(abs);
    if (['ls', 'find'].includes(prog) && !targets.length) targets.push(base); // bare `ls` lists the working dir
    const hit = targets.map((t) => sourceOf(cfg, t)).find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/**
 * Catalog decision for a PreToolUse call: { deny } | { remind } | null. `state` is the thread state (or null),
 * `h` the shell parsers. Returns null at once when the repo has no catalog source.
 */
export function catalogPreTool(input, ctx, cwd, h) {
  const cfg = catalogConfig(ctx.projectDir);
  if (!cfg.enabled) return null;
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const FILE = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
  if (FILE[tool]) {
    const t = toolInput[FILE[tool]];
    if (typeof t !== 'string' || !t) return null;
    const deny = readOnlySourceDeny(cfg, [path.resolve(cwd, t)], ctx.projectDir, ctx.brainDir);
    return deny ? { deny } : null;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (!input.cwd) return null; // a relative path without a known cwd is unclear: do nothing
  const cmd = String(toolInput.command || '');
  const deny = readOnlySourceDeny(cfg, shellWriteTargets(cmd, cwd, h), ctx.projectDir, ctx.brainDir);
  if (deny) return { deny };
  if (!cfg.reminder || input.agent_id || input.agent_type || !ctx.brainDir || !ctx.thread) return null;
  if (/catalog\.mjs/.test(cmd)) return null;
  const src = readerSource(cfg, cmd, cwd, h);
  if (!src || !fs.existsSync(path.join(cfg.dir, 'index', `${src.name}.jsonl`))) return null;
  const state = h.readThreadState(ctx.brainDir, ctx.thread);
  if (state.catalog_reminded) return null;
  h.writeThreadState(ctx.brainDir, ctx.thread, { ...state, catalog_reminded: true });
  return { remind: `katalóg: pre dáta v ${src.name} najprv node ${ctx.pluginRoot}/bin/catalog.mjs find <slová> alebo show <cesta> (hľadá aj súbory repa z INDEX.md, napr. vystupy/); CSV dotazuj cez catalog.mjs sql, nečítaj ich (P-031); prvý výpis zdroja v session je preto zamietnutý, keď katalóg nestačí, zopakovaný príkaz prejde` };
}
