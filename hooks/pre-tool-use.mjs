#!/usr/bin/env node
// PreToolUse: topic-owned code (P-012), secrets outside local/, brain protection (P-013, persona P-024), dangerous targets (P-018), work files outside the project (P-052), subagent limits incl. mail (P-025), decision binding (P-031), agent-to-agent channel (P-055), foreground waiting (P-061). Output: deny/ask or 1 line (c).
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readHookInput, emit, permissionOutput, contextOutput, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, allowOutside, mainCheckout, WORKTREES_DIR, servicesDir, readThreadState, writeThreadState, personaWritable, SCRATCH_DIR } from '../scripts/config.mjs';
import { git, isInside, toPosix } from '../scripts/util.mjs';
import { findRelatesTo } from '../scripts/find.mjs';
import { SUBAGENT_ALLOWED } from '../scripts/comms.mjs';
import { readTopics } from '../scripts/records.mjs';
import { knowledgeDirOf, PROJECT_KNOWLEDGE } from '../scripts/repo-knowledge.mjs';
import { findSecret } from '../scripts/secrets.mjs';
import { inWorkScratch, ownedEdit, claimOwn, inPlaceEdits, snapshotShell } from '../scripts/own-files.mjs';
import { catalogPreTool } from '../scripts/catalog/pretool.mjs';
import { bigWriteDeny } from '../scripts/materialy.mjs';
import { analyze, bypassOf, bypassReason, callKey, gitHookBypass, guardConfigWrite, stateDenials, transcriptDenials, withDenial, withoutDataHeredocs } from '../scripts/bypass.mjs';

export const HOOK_META = { event: 'PreToolUse', class: 'block+c', limit: '1 line', principles: ['P-012', 'P-013', 'P-018', 'P-024', 'P-025', 'P-031', 'P-052', 'P-054', 'P-055'] };

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function targetOf(toolName, toolInput = {}) {
  if (toolName === 'NotebookEdit') return toolInput.notebook_path;
  if (FILE_TOOLS.includes(toolName)) return toolInput.file_path;
  return null;
}

/** Root of a sibling workflow project (or its topic copies) that contains abs; a persona manages them (P-024, P-052). */
export function managedProjectOf(projectDir, abs) {
  const parent = path.dirname(projectDir);
  const rel = path.relative(parent, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const top = parts[0];
  const name = top.endsWith('-topics') ? top.slice(0, -'-topics'.length) : top;
  if (isWorkflowProject(path.join(parent, name))) return path.join(parent, top);
  // nested project under a sibling folder (pilot/project-a/example-project-1)
  for (let i = 2; i < parts.length; i++) {
    const dir = path.join(parent, ...parts.slice(0, i));
    if (isWorkflowProject(dir)) return dir;
  }
  return null;
}

/** A project set up by the adapter: .workflow.json, or (project without brain, P-024) settings enabling the workflow plugin. */
function isWorkflowProject(dir) {
  if (fs.existsSync(path.join(dir, '.workflow.json'))) return true;
  try {
    const plugins = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {};
    if (Object.keys(plugins).some((k) => k.startsWith('workflow@'))) return true;
  } catch {}
  try { return /\bworkflow\b/.test(fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8')); } catch { return false; }
}

/** Files this thread created (P-018): rewriting or deleting them is recoverable from the agent's own work. */
const CREATED_LIMIT = 500;
function createdByThread(ctx) {
  if (!ctx.brainDir || !ctx.thread) return new Set();
  return new Set(readThreadState(ctx.brainDir, ctx.thread).created_files || []);
}
function rememberCreated(ctx, abs) {
  if (!ctx.brainDir || !ctx.thread) return;
  const state = readThreadState(ctx.brainDir, ctx.thread);
  const list = (state.created_files || []).filter((f) => f !== abs);
  list.push(abs);
  writeThreadState(ctx.brainDir, ctx.thread, { ...state, created_files: list.slice(-CREATED_LIMIT) });
}

/** Data heredocs (scripts/bypass.mjs): bodies stored or read, not executed. */
const SHELL_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ssh', 'sudo', 'su', 'eval', 'xargs', 'env', 'nohup', 'time']);
export { withoutDataHeredocs };

/**
 * The executed part of a command for the history check: data heredocs dropped, and quoted arguments of programs that
 * are not shells replaced by `Q` (`git commit -m "... git restore ..."`, `topic.mjs create --subject "..."`: text, not a
 * command; alice 2026-11-03, 5 approvals in one hour). Quoted text given to a shell (`bash -c "..."`, `ssh h "..."`) runs.
 */
export function executedText(command) {
  const quoted = [];
  const held = withoutDataHeredocs(command).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => `\u0006${quoted.push(q) - 1}\u0006`);
  const out = [];
  for (const seg of held.split(/(\s*(?:&&|\|\||;|\n|\|)\s*)/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const prog = (words[0] || '').replace(/^\(+/, '').split('/').pop();
    out.push(seg.replace(/\u0006(\d+)\u0006/g, (m, i) => (SHELL_RUNNERS.has(prog) ? quoted[i] : 'Q')));
  }
  return out.join('');
}

/** History operation that needs confirmation: a listed command as a whole word sequence, minus listed safe forms (P-018). */
export function historyOperation(normalized, asks, except = []) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = (a) => new RegExp(`(^|[\\s;&|("'])${esc(a)}(?=\\s|$|[;&|)"'])`).test(normalized);
  if (except.some(hit)) return null;
  return asks.find(hit) || null;
}

/** Directory of the code copies of topics next to the project (P-036). */
export function topicsDir(projectDir) {
  return path.join(path.dirname(projectDir), `${path.basename(projectDir)}-topics`);
}

function existingAncestor(p) {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return cur;
}

/** Danger classification of one filesystem target (P-018). */
export function classifyTarget(file) {
  const abs = path.resolve(file);
  const exists = fs.existsSync(abs);
  const anchor = existingAncestor(abs);
  const top = anchor ? git(['rev-parse', '--show-toplevel'], { cwd: fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor) }) : { ok: false };
  if (!top.ok) return { dangerous: true, reason: 'not in a git repository', exists };
  const repo = path.resolve(top.stdout);
  const ignored = git(['check-ignore', '-q', '--', abs], { cwd: repo }).ok;
  if (ignored) return { dangerous: true, reason: 'ignored by git', exists, repo };
  if (!exists) return { dangerous: false, reason: 'new file', exists, repo };
  const status = git(['status', '--porcelain', '--', abs], { cwd: repo }).stdout;
  if (status.startsWith('??')) return { dangerous: true, reason: 'untracked', exists, repo };
  if (status.trim()) return { dangerous: true, reason: 'uncommitted changes', exists, repo };
  return { dangerous: false, reason: 'tracked and clean', exists, repo };
}

export function removedLines(toolInput, file) {
  if (toolInput.old_string !== undefined) {
    const oldLines = String(toolInput.old_string).split('\n').length;
    const newLines = String(toolInput.new_string ?? '').split('\n').length;
    return Math.max(0, oldLines - newLines);
  }
  if (toolInput.content !== undefined && fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').split('\n').length;
  }
  return 0;
}

const MASK = { '>': '\u0001', ';': '\u0002', '&': '\u0003', '|': '\u0004', ' ': '\u0005' };
const UNMASK = Object.fromEntries(Object.entries(MASK).map(([k, v]) => [v, k]));

/**
 * `NAME=value` set earlier in the command expanded in later `$NAME` / `${NAME}` (`T=~/repo; cd $T && cat > f`: the
 * target is ~/repo/f, not a file in the session dir; alice 2026-11-03). Values with substitutions stay unexpanded.
 */
export function expandAssigned(command) {
  const vars = {};
  return command.split(/(\s*(?:&&|\|\||;|\n)\s*)/).map((part) => {
    const out = part.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, x, y) => vars[x || y] ?? m);
    for (const m of out.matchAll(/(?:^|\s)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"$`]*"|'[^']*'|[^\s;&|$`'"()<>]+)(?=\s|$)/g)) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    return out;
  }).join('');
}

/**
 * The system temp dir written through a variable or a temp-file helper, as its real path: `$TMPDIR`, `$TEMP`, `$TMP`
 * (bash), `$env:TEMP`, `[IO.Path]::GetTempPath()` (PowerShell), `%TEMP%` (cmd), `$(mktemp)`. Unexpanded they read as
 * a file in the session dir and the write passed (alice 2026-11-07: on Windows the temp tendency goes through $env:TEMP).
 */
export function expandTemp(command, tmp = os.tmpdir()) {
  const dir = String(tmp).replace(/ /g, MASK[' ']);
  return String(command)
    .replace(/\$(?:\{(?:TMPDIR|TEMP|TMP)\}|(?:TMPDIR|TEMP|TMP)\b)|\$env:(?:TEMP|TMP)\b|%(?:TEMP|TMP)%|\[(?:System\.)?IO\.Path\]::GetTemp(?:Path|FileName)\(\)/gi, dir)
    .replace(/\$\(\s*mktemp\b(?![^)]*(?:\s-p\b|--tmpdir=))[^)]*\)|`\s*mktemp\b(?![^`]*(?:\s-p\b|--tmpdir=))[^`]*`/g, `${dir}/mktemp`);
}

/** Heredoc bodies removed, operators and spaces inside quotes masked, so only real shell syntax is parsed. */
export function maskShell(command) {
  let cmd = expandAssigned(expandTemp(String(command)));
  cmd = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0]);
  return cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => q.replace(/[>;&| ]/g, (c) => MASK[c]));
}
export const unmask = (s) => s.replace(/[\u0001-\u0005]/g, (c) => UNMASK[c]).replace(/^['"]|['"]$/g, '');

/**
 * Absolute filesystem targets a shell command writes or deletes (P-018, P-013). `cd <dir>` changes the base of
 * relative paths for the following parts; cp sources are only read; redirects to devices (>/dev/null, >&2) are not files.
 */
/**
 * Recursive owner/mode change (`chown -R`, `chgrp -R`, `chmod -R`, `setfacl -R`), also inside `sudo bash -c '…'`: it rewrites
 * every file under the target and git does not record it. Asks unless every path is absolute and inside the scratch dir
 * (2026-11-03: a leftover `chown -R user:user .` in a compound sudo command changed 8 root files in the home).
 */
export function recursiveModeChange(command, cwd, scratchDir) {
  const re = /(^|[\s;&|('"`])(chown|chgrp|chmod|setfacl)\s+([^;&|\n'"`)]*)/g;
  const hits = [];
  for (let m; (m = re.exec(String(command || ''))); ) {
    const words = m[3].trim().split(/\s+/).filter(Boolean);
    if (!words.some((w) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(w) || w === '--recursive')) continue;
    const args = words.filter((w) => !w.startsWith('-'));
    const paths = args.slice(1); // the first is the owner, mode or ACL spec
    const cd = /(^|[\s;&|('"`])(cd|pushd)\s/.test(String(command));
    const safe = paths.length && !cd && paths.every((p) => path.isAbsolute(p) && isInside(scratchDir, p));
    if (!safe) hits.push(`${m[2]} ${words.join(' ')}`.trim());
  }
  return hits.length ? hits : null;
}

/**
 * `grep -h` (no file names) over several files, a glob or a recursive search: the output cannot be split back into files,
 * and assigning lines to files by assumed order gives false claims (alice 2026-11-07: two non-existent conflicts between
 * daily reports 11-06/11-07). Returns a one-line hint, not a block: `-h` is fine for a plain union of matches.
 */
const GREP_VALUE_OPTS = new Set(['e', 'f', 'A', 'B', 'C', 'm', 'd', 'D']);
export function grepNoFilename(command) {
  for (const seg of maskShell(command).split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const prog = (words[0] || '').replace(/^\(+/, '').split('/').pop();
    if (!['grep', 'egrep', 'fgrep'].includes(prog)) continue;
    let noName = false, recursive = false, pattern = false, opts = true;
    const files = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (opts && w === '--') { opts = false; continue; }
      if (opts && w.startsWith('--')) {
        if (w === '--no-filename') noName = true;
        else if (w === '--with-filename') noName = false;
        else if (/^--(recursive|dereference-recursive)$/.test(w)) recursive = true;
        else if (/^--(regexp|file)(=|$)/.test(w)) { pattern = true; if (!w.includes('=')) i++; }
        else if (/^--(after-context|before-context|context|max-count|directories|devices)$/.test(w)) i++;
        continue;
      }
      if (opts && /^-[A-Za-z]/.test(w)) {
        for (let j = 1; j < w.length; j++) {
          const c = w[j];
          if (c === 'h') noName = true;
          else if (c === 'H') noName = false;
          else if (c === 'r' || c === 'R') recursive = true;
          if (GREP_VALUE_OPTS.has(c)) {
            if (c === 'e' || c === 'f') pattern = true;
            if (j === w.length - 1) i++;
            break;
          }
        }
        continue;
      }
      if (/^[<>]|^\d*>/.test(w)) { if (/^\d*[<>]+&?$/.test(w)) i++; continue; }
      if (!pattern) { pattern = true; continue; }
      files.push(unmask(w));
    }
    const many = recursive || files.length > 1 || files.some((f) => /[*?[]/.test(f));
    if (noName && many) {
      return `grep -h over several files (${files.length ? files.slice(0, 3).join(' ') : 'recursive'}) drops file names: lines cannot be assigned to files by order; to claim which file contains what, use grep -H or one grep per file`;
    }
  }
  return null;
}

export function bashTargets(command, cwd = process.cwd()) {
  const targets = [];
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (p) => path.resolve(base, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const lead = leadOf(words);
    const prog = words[lead]?.split('/').pop();
    const args = words.slice(lead + 1).filter((w) => !w.startsWith('-') && !/^['"]?[$<>|(`]/.test(w) && !/^[0-9]*>/.test(w));
    if (prog === 'cd') {
      if (args[0] && !/[$`]/.test(args[0])) base = abs(unmask(args[0]));
      continue;
    }
    // cp/mv into a directory overwrite <dir>/<source name>, not the directory (Bob 2026-11-01: `sudo cp $F /var/backups/`
    // asked as an overwrite of /var/backups); a source in a variable has no known name, so it adds no target.
    const intoDir = (dest, sources) => {
      const d = abs(unmask(dest));
      let isDir = dest.endsWith('/');
      try { isDir ||= fs.statSync(d).isDirectory(); } catch { /* new path */ }
      return isDir ? sources.map((w) => path.join(d, path.basename(unmask(w)))) : [d];
    };
    if (['rm', 'rmdir', 'truncate', 'shred'].includes(prog)) targets.push(...args.map((w) => abs(unmask(w))));
    if (prog === 'mv' && args.length > 1) targets.push(...args.slice(0, -1).map((w) => abs(unmask(w))), ...intoDir(args[args.length - 1], args.slice(0, -1)));
    else if (prog === 'mv') targets.push(...args.map((w) => abs(unmask(w))));
    if (prog === 'cp' && args.length > 1) targets.push(...intoDir(args[args.length - 1], args.slice(0, -1)));
    for (const m of part.matchAll(/(?:^|\s)>{1,2}\s*(\S+)/g)) {
      const target = unmask(m[1]);
      if (!/^(&|\/dev\/|\$)/.test(target)) targets.push(abs(target));
    }
  }
  return targets;
}

/**
 * Paths a shell command writes (P-052): redirects, cp/mv/tee destinations, mkdir/touch and output options of any program
 * (`--outdir /tmp/x`, `-o ~/x`). Removing files is not counted (cleanup goes through P-018). 2026-11-04: `wrangler deploy
 * --dry-run --outdir /tmp/claude-1007/wr` left a bundle outside the project; only Write and Edit were checked.
 */
// The program of a segment comes after sudo and shell keywords: `for f in a; do grep -o x "$f"; done` runs grep, not `do`.
const LEAD_WORDS = new Set(['sudo', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'nohup', 'command', 'exec', '!', '{']);
export function leadOf(words) {
  let i = 0;
  while (i < words.length - 1 && LEAD_WORDS.has(words[i])) i++;
  return i;
}
// `--outDir` (tsc) and `--outdir` (wrangler) alike; short `-o` only lower case (`curl -O` takes no value).
const OUTPUT_LONG = /^--(out|output|outdir|out-dir|output-dir|outfile|out-file|output-file|dest|destination|target-dir|log-file|cache-dir|prefix)$/i;
const OUTPUT_OPT = { test: (w) => w === '-o' || OUTPUT_LONG.test(w) };
// Programs whose `-o` is no output file: the logical OR in find and test/[ (alice 2026-11-04: `find . -path ./.git -prune
// -o -type f` was denied as a write to `-type`), "only matching" in grep and rg (a worker's `grep -o '<regex>'` was denied
// as a write to the regex and P-054 then locked the inventory, agentic-flow-public#11), an option or format elsewhere.
const OR_O_PROGS = new Set(['find', 'test', '[', '[[', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'git', 'ssh', 'scp', 'sftp', 'set', 'ps', 'pgrep', 'mount', 'lsblk', 'findmnt', 'join', 'ip']);
// PowerShell write cmdlets and their aliases (Windows agent, alice 2026-11-07: `Set-Content -Path $env:TEMP\a.ps1` was no
// write). The target is -Path/-FilePath/-LiteralPath, for copy/move -Destination, else the first (copy/move: second) positional.
const PS_WRITE = /^(set-content|add-content|out-file|new-item|export-csv|export-clixml|sc|ac|ni)$/i;
const PS_COPY = /^(copy-item|move-item|copy|move|cpi|mi|cp|mv)$/i;
const PS_SWITCH = /^-(force|append|nonewline|noclobber|recurse|passthru|whatif|confirm)$/i;
export function psWriteTargets(words, prog) {
  const copy = PS_COPY.test(prog);
  if (!copy && !PS_WRITE.test(prog)) return [];
  const named = copy ? /^-destination$/i : /^-(path|filepath|literalpath)$/i;
  const positional = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (named.test(w)) return words[i + 1] ? [words[i + 1]] : [];
    if (/^-[A-Za-z]/.test(w)) { if (!PS_SWITCH.test(w) && !/:/.test(w)) i++; continue; }
    positional.push(w);
  }
  const dest = positional[copy ? 1 : 0];
  return dest ? [dest] : [];
}
/** The value of a PowerShell argument in parentheses, `([IO.Path]::GetTempPath())`, is the path inside them. */
const psValue = (w) => String(w).replace(/^\(+|\)+$/g, '');
export function shellWrites(command, cwd = process.cwd(), env = process.env) {
  const found = [];
  let base = cwd;
  const home = env.HOME || '';
  const abs = (p) => path.resolve(base, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const add = (w) => { const v = unmask(w); if (v && !/[$`*?]/.test(v) && !/^\/dev\//.test(v)) found.push(abs(v)); };
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const lead = leadOf(words);
    const prog = words[lead]?.split('/').pop();
    if (prog === 'cd') { if (words[lead + 1] && !/[$`]/.test(words[lead + 1])) base = abs(unmask(words[lead + 1])); continue; }
    const args = words.slice(lead + 1).filter((w) => !w.startsWith('-') && !/^['"]?[$<>|(`]/.test(w) && !/^[0-9]*>/.test(w));
    if ((prog === 'cp' || prog === 'mv' || prog === 'ln' || prog === 'install') && args.length > 1) add(args[args.length - 1]);
    if (prog === 'tee' || prog === 'mkdir' || prog === 'touch') args.forEach(add);
    if (prog && prog !== 'cp' && prog !== 'mv') psWriteTargets(words.slice(lead + 1), prog).forEach((w) => add(psValue(w)));
    // A bare `mktemp` / `New-TemporaryFile` creates the file in the system temp dir (`$(mktemp)` is expanded by expandTemp).
    if ((prog === 'mktemp' && !words.some((w) => w === '-p' || w.startsWith('--tmpdir='))) || /^new-temporaryfile$/i.test(prog || '')) found.push(path.join(os.tmpdir(), 'mktemp'));
    for (let i = lead + 1; i < words.length; i++) {
      const w = unmask(words[i]);
      const eq = w.match(/^(--[a-zA-Z-]+)=(.+)$/);
      if (eq && OUTPUT_OPT.test(eq[1])) add(eq[2]);
      else if (OUTPUT_OPT.test(w) && words[i + 1] && !(w === '-o' && OR_O_PROGS.has(String(prog).replace(/\.exe$/i, '')))) add(words[i + 1]);
    }
    for (const m of part.matchAll(/(?:^|\s)[0-9]*>{1,2}\s*(\S+)/g)) if (!/^&/.test(unmask(m[1]))) add(m[1]);
  }
  return [...new Set(found)];
}

/**
 * Where the agent may write (P-052). With a domain (v3, D-0002): the domain folder and the domain brain's explicit
 * `domain.allow_outside` list. Without one (layout not migrated yet): the project, its topic copies and, in a persona,
 * its managed sibling projects.
 */
function insideProject(ctx, abs) {
  if (ctx.domain) return isInside(ctx.domain.root, abs) || ctx.domain.allowOutside.some((d) => isInside(d, abs));
  return isInside(ctx.projectDir, abs) || isInside(topicsDir(ctx.projectDir), abs) || Boolean(ctx.persona && managedProjectOf(ctx.projectDir, abs))
    || allowOutside(ctx.policy).paths.some((d) => isInside(d, abs));
}
/** The operator's explicit write exceptions (policy `domain.allow_outside` paths), with or without a domain marker. */
function outsideAllowed(ctx) {
  return ctx.domain ? ctx.domain.allowOutside : allowOutside(ctx.policy).paths;
}
function boundaryActive(ctx) {
  return Boolean(ctx.domain) || Boolean(ctx.brainInfo && !ctx.brainInfo.error);
}
function outsideReason(ctx, abs) {
  const scratch = toPosix(path.join(ctx.projectDir, SCRATCH_DIR));
  const where = ctx.domain ? `outside the domain ${toPosix(ctx.domain.root)}` : 'outside the project';
  const extra = ctx.domain ? '; a lasting exception is only the domain brain policy domain.allow_outside, changed on the operator\'s instruction' : '';
  return `${toPosix(abs)} is ${where}${isTempPath(abs) ? ' (system temp dir)' : ''}; the agent writes only inside it: work files and tool output go to ${scratch}/ (gitignored, no confirmation, P-052)${extra}${otherProjectHint(abs)}`;
}
/**
 * The target belongs to another workflow project (its folder or a topic copy has .workflow.json): its work runs in a
 * thread of that project. The adopt step "clean the old files in a code topic" was done from the wizard's thread and
 * denied with only the scratch hint (Windows instance 2026-11-07, agentic-flow-public#9).
 */
function otherProjectHint(abs) {
  for (let dir = path.dirname(path.resolve(abs)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.workflow.json'))) {
      let project = dir;
      try { project = mainCheckout(dir); } catch { /* not a git checkout */ }
      const p = toPosix(project);
      return `; it belongs to the workflow project ${p}: that work runs in a thread of that project, not here (topic.mjs create <topic> --kind code --project ${p} --new-thread --task "..." or topic.mjs thread <topic> --project ${p} --task "...")`;
    }
    if (path.dirname(dir) === dir) return '';
  }
}
/**
 * Installed releases (D-0003): `~/services/<repo>/` is a checkout of a release tag that the running services use; it
 * changes only through git checkout of a tag (release), never by a file write. The one exception is the operator's explicit
 * `domain.allow_outside` entry covering the path (operator 2026-11-05: an allow_outside entry must work, that is its point).
 */
export function servicesWrite(absPaths, env = process.env, allowed = []) {
  const root = servicesDir(env);
  const hit = absPaths.find((p) => isInside(root, p) && !allowed.some((d) => isInside(d, p)));
  return hit ? `${toPosix(hit)} is an installed release (~/services, D-0003): it changes only by checking out a release tag (skill release), never by writing files unless the operator lists it in domain.allow_outside; change the repo in its domain and release it` : null;
}
/**
 * docs/principles/ holds the reasons behind the rules (one file per P-NNN). The short rules in rules/ are what the agent
 * works by; a reason is read one file at a time. Searching or reading the whole directory poisons the context with
 * sixty principles to answer one question (operator 2026-11-05).
 */
const PRINCIPLES_REF = /([^\s'"=:;|&<>()]*docs[\\/]principles)(?=[\s'"/\\*;|&<>()]|$)(?!\/(?:P-\d{3}|README)\.md(?![\w.-]))/g;
const DOCS_REF = /([^\s'"=:;|&<>()]*docs)\/?(?=[\s'"*;|&<>()]|$)/g;
export function principlesBulkRead(tool, toolInput = {}, cwd = process.cwd()) {
  const text = tool === 'Bash' || tool === 'PowerShell' ? String(toolInput.command || '')
    : tool === 'Grep' ? `${toolInput.path || ''} ${toolInput.glob || ''}`
    : tool === 'Glob' ? `${toolInput.pattern || ''} ${toolInput.path || ''}` : '';
  const home = process.env.HOME || '';
  // Only a directory that really is a principles dir (holds P-001.md): a project's own docs/principles stays free.
  const real = [...text.matchAll(PRINCIPLES_REF)].some((m) => {
    const ref = m[1].startsWith('~/') ? path.join(home, m[1].slice(2)) : m[1];
    return fs.existsSync(path.join(path.resolve(cwd, ref), 'P-001.md'));
  });
  // A search over the parent docs/ walks into principles/ too (git grep x -- docs, grep -r x docs): the same bulk read.
  const searching = tool === 'Grep' || tool === 'Glob' || /(^|[\s;&|(`])(?:git\s+grep|[ef]?grep|ugrep|rg|ag|ack|find)(?=\s)/.test(text);
  const viaDocs = searching && [...text.matchAll(DOCS_REF)].some((m) => {
    const ref = m[1].startsWith('~/') ? path.join(home, m[1].slice(2)) : m[1];
    return fs.existsSync(path.join(path.resolve(cwd, ref), 'principles', 'P-001.md'));
  });
  return real || viaDocs ? 'docs/principles/ is read one principle at a time: the rule in rules/ is the working text, and only when you are unsure why a rule exists you open docs/principles/P-NNN.md for that one rule (P-001); searching or listing the whole directory is not allowed' : null;
}
/** The domain marker decides the boundary: no agent changes it (it would widen its own domain). */
function domainMarkerWrite(ctx, absPaths) {
  return ctx.domain && absPaths.some((p) => path.resolve(p) === ctx.domain.marker)
    ? `${toPosix(ctx.domain.marker)} defines the domain boundary; agents do not change it (operator only, D-0002)` : null;
}
/** sudo acts outside every domain: only with "sudo" in domain.allow_outside (operator 2026-11-04). */
function sudoDenied(ctx, command) {
  if (!ctx.domain || ctx.domain.sudo) return null;
  return /(^|[\n;&|(`])\s*(\w+=\S*\s+)*sudo(\s|$)/.test(executedText(command))
    ? `sudo is not allowed in domain ${toPosix(ctx.domain.root)}: it is allowed only by "sudo" in domain.allow_outside of the domain brain policy (D-0002)` : null;
}

/** Files a shell command edits in place (`sed -i`, `perl -i`), with `cd` tracked like bashTargets. */
export function bashEdits(command, cwd = process.cwd()) {
  const edits = [];
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (p) => path.resolve(base, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).filter((w) => !/^[0-9]*>/.test(w));
    const lead = leadOf(words);
    if (words[lead]?.split('/').pop() === 'cd') {
      if (words[lead + 1] && !/[$`]/.test(words[lead + 1])) base = abs(unmask(words[lead + 1]));
      continue;
    }
    edits.push(...inPlaceEdits(words.slice(lead)).filter((w) => !/^['"]?[$<>|(`]/.test(w)).map((w) => abs(unmask(w))));
  }
  return edits;
}

/**
 * `git restore <paths>` / `git checkout [<rev>] -- <paths>` that only drops the thread's own edits (P-018, operator
 * 2026-11-03: cleaning up after yourself never asks). Every uncommitted file under the paths must be an own edit;
 * any other git history operation in the command, or no explicit path, keeps the confirmation.
 */
export function restoresOnlyOwn(ctx, command, cwd) {
  let base = cwd;
  let found = false;
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map(unmask);
    if (words[0] === 'cd') { if (words[1] && !/[$`]/.test(words[1])) base = path.resolve(base, words[1]); continue; }
    if (words[0] !== 'git') continue;
    let i = 1;
    let dir = base;
    while (words[i] === '-C' || words[i] === '-c') { if (words[i] === '-C') dir = path.resolve(base, words[i + 1] || '.'); i += 2; }
    const sub = words[i];
    let paths;
    if (sub === 'restore') {
      const rest = words.slice(i + 1);
      if (rest.some((w) => /^(-s|--source)/.test(w))) return false;
      paths = rest.filter((w) => !w.startsWith('-'));
    } else if (sub === 'checkout' && words.includes('--')) {
      if (words.indexOf('--') !== i + 1) return false;
      paths = words.slice(words.indexOf('--') + 1);
    } else {
      if (historyOperation(words.join(' '), ctx.policy?.harness?.ask_commands || [], ctx.policy?.harness?.ask_commands_except || [])) return false;
      continue;
    }
    if (!paths.length || paths.some((w) => /[$`*?]/.test(w))) return false;
    for (const rel of paths) {
      const abs = path.resolve(dir, rel);
      const top = git(['rev-parse', '--show-toplevel'], { cwd: dir });
      if (!top.ok) return false;
      const diff = git(['diff', '--name-only', 'HEAD', '--', abs], { cwd: top.stdout });
      if (!diff.ok || !diff.stdout.split('\n').filter(Boolean).every((rel) => ownedEdit(ctx, path.resolve(top.stdout, rel)))) return false;
    }
    found = true;
  }
  return found;
}

/** Directories a shell command works in: cwd, every literal `cd <dir>` and `git -C <dir>` (own edits by scripts). */
export function shellDirs(command, cwd) {
  const dirs = [cwd];
  let base = cwd;
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map(unmask);
    if (words[0] === 'cd' && words[1] && !/[$`]/.test(words[1])) dirs.push((base = path.resolve(base, words[1])));
    for (let i = 0; i < words.length - 1; i++) if (words[i] === '-C' && words[0] === 'git' && !/[$`]/.test(words[i + 1])) dirs.push(path.resolve(base, words[i + 1]));
  }
  return [...new Set(dirs)];
}

/** Targets the thread may change without asking: work files in a scratch/ and its own edits (P-018, P-052). */
function ownWork(ctx, abs) {
  return isInside(path.join(ctx.projectDir, SCRATCH_DIR), abs) || inWorkScratch(abs) || ownedEdit(ctx, abs);
}

/**
 * Mail in a subagent (P-025): any subagent may only read (`receive`, `list`, `count`) through the comms client.
 * Returns a deny reason or null.
 */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PREFIXES = new Set(['sudo', 'exec', 'time', 'env', 'nice', 'nohup', 'command', 'timeout']);

/**
 * Scripts a shell command executes: the head of each segment, `[prefix] [node [flags]] <script.mjs> args`, also inside
 * `sh -c "..."`. A script only named as an argument (`cat bin/comms.mjs`, `grep x bin/topic.mjs`) or in quoted text and
 * heredocs is not executed. Returns [{ script, args }].
 */
export function executedScripts(command, depth = 0) {
  const out = [];
  for (const seg of maskShell(command).split(/[;&|\n()`]+|\$\(/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < t.length && (PREFIXES.has(t[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || (PREFIXES.has(t[i - 1]) && /^-|^\d/.test(t[i])))) i++;
    const head = path.basename(t[i] || '');
    if (SHELLS.has(head) && depth < 2) {
      const c = t.indexOf('-c', i);
      if (c > 0 && t[c + 1]) out.push(...executedScripts(unmask(t[c + 1]), depth + 1));
      continue;
    }
    if (INTERPRETERS.has(head)) {
      i++;
      while (i < t.length && t[i].startsWith('-')) i++;
      if (head === 'deno' && t[i] === 'run') i++;
    }
    if (t[i] && /\.[cm]?[jt]s$/.test(unmask(t[i]))) out.push({ script: toPosix(unmask(t[i])), args: t.slice(i + 1).map(unmask) });
  }
  return out;
}

export function commsSubagentCheck(command, agentType = '') {
  const cmd = String(command || '');
  const calls = executedScripts(cmd).filter((e) => /(^|\/)comms\.mjs$/.test(e.script)).map((e) => e.args.find((a) => !a.startsWith('-')) || '');
  for (const sub of calls) {
    if (!SUBAGENT_ALLOWED.includes(sub)) return `subagents do not send, ack or decide mail (comms ${sub}); they may only read it (receive, list, count), P-025`;
  }
  return null;
}

/** Denied tool (P-055): exact name or MCP-namespaced `mcp__<server>__<name>`. Returns the denied name or null. */
export function deniedTool(toolName, denied = []) {
  const t = String(toolName || '');
  return denied.find((d) => t === d || t.endsWith(`__${d}`)) || null;
}

const WAIT_UNIT = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
/**
 * P-061: a foreground command that waits for an event (sleep > 10 s, a loop that sleeps, watch) keeps the turn open
 * and burns tokens. Quoted data and heredoc bodies are not waits, except strings the shell runs (-c, eval, ssh, watch).
 * Returns the reason or null.
 */
export function foregroundWait(command) {
  let cmd = String(command).replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0]);
  cmd = cmd.replace(/(-c|\beval|\bssh\s+(?:-\S+\s+)*\S+|\bwatch(?:\s+-\S+)*)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, runs, sp, str) => {
    if (runs) return all;
    if (str[0] === '"' && /\$\(|`/.test(str)) return all;
    return `${sp}''`;
  });
  if (/\b(until|while)\b[\s\S]*\bsleep\b/.test(cmd)) return 'loop with sleep';
  if (/\bwatch\s+(-\S+\s+)*\S/.test(cmd)) return 'watch';
  for (const m of cmd.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
    if (Number(m[1]) * WAIT_UNIT[m[2]] > 10) return `sleep ${m[1]}${m[2]}`;
  }
  return null;
}

/** System temp directories (os.tmpdir(), /tmp, /var/tmp; WORKFLOW_TEMP_DIRS overrides, the test fixtures live in /tmp). */
export function isTempPath(abs, env = process.env) {
  const dirs = env.WORKFLOW_TEMP_DIRS ? env.WORKFLOW_TEMP_DIRS.split(path.delimiter).filter(Boolean) : [os.tmpdir(), '/tmp', '/var/tmp'];
  return dirs.some((d) => isInside(d, abs));
}

/**
 * Topic-owned code (policy `topic_owned`: { "<path relative to the project>": "<topic>" }, P-012, P-036): changes in a
 * listed repo (and its topic copies) belong to one topic; a thread that does not hold it sends the work as mail and does
 * not change, commit or release that code itself (2026-11-02: a repo-cleanup thread changed the workflow and asked the
 * operator for a release; the routing rule was text only). Returns the deny reason or null.
 */
/**
 * `<repo>/agentic/` of a domain repo (or of its topic worktree) is written only by save (P-013, D-0002): format checks,
 * dedup and the commit into the repo happen there. Also keeps topicOwnedCheck from reading a knowledge save as code.
 */
export function repoKnowledgeWrite(ctx, absPaths) {
  if (!ctx.domain) return null;
  for (const p of absPaths) {
    const k = knowledgeDirOf(ctx.domain, ctx.brainDir, p);
    if (k) return `${k.repo}/${PROJECT_KNOWLEDGE}/ is written only by save (P-013, D-0002): save.mjs memory|decision|skill|handover ... --repo ${k.repo} (checks the format, deduplicates, commits into the repo${k.topic ? `, in topic ${k.topic} into its worktree` : ''}); a brain record moves with save.mjs move <path> --repo ${k.repo}`;
  }
  return null;
}

export function topicOwnedCheck(ctx, absPaths) {
  const owned = ctx.policy?.topic_owned || {};
  if (!ctx.brainDir || !absPaths.length) return null;
  for (const [rel, topic] of Object.entries(owned)) {
    const root = path.resolve(ctx.projectDir, rel);
    const wt = ctx.domain ? path.join(ctx.domain.root, WORKTREES_DIR, path.basename(root)) : null;
    if (!absPaths.some((p) => isInside(root, p) || isInside(`${root}-topics`, p) || (wt && isInside(wt, p)))) continue;
    const t = readTopics(ctx.brainDir).find((x) => x.id === topic);
    if (ctx.thread && t?.holder?.thread === ctx.thread) continue;
    const state = !t ? 'not open: open it with workflow:topic' : t.holder?.thread ? `held by thread ${t.holder.thread}` : 'not held: claim it with workflow:topic if this thread is to do the work';
    return `changes in ${rel} belong to topic ${topic} (${state}); this thread does not hold it, so it does not change, commit or release that code: send the work as mail (comms send --level assist --to ${ctx.projectName}/${topic} --text "..."), the holder fixes, tests and releases it (P-012, policy topic_owned)`;
  }
  return null;
}

const GIT_WRITES = new Set(['commit', 'push', 'merge', 'tag', 'rebase', 'cherry-pick', 'am', 'revert', 'apply', 'reset', 'checkout', 'switch', 'stash', 'restore']);
/** Repositories a shell command changes through git (`git [-C dir] commit|push|...`, also after `cd dir`). */
export function gitWriteDirs(command, cwd = process.cwd()) {
  const dirs = [];
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (b, p) => path.resolve(b, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const w = part.trim().split(/\s+/).filter(Boolean).map(unmask);
    if (w[0] === 'cd') {
      if (w[1] && !/[$`]/.test(w[1])) base = abs(base, w[1]);
      continue;
    }
    let i = w[0] === 'sudo' ? 1 : 0;
    if (path.basename(w[i] || '') !== 'git') continue;
    let dir = base;
    i++;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C' && w[i + 1]) { dir = abs(dir, w[i + 1]); i += 2; } else if (w[i] === '-c') i += 2; else i++;
    }
    if (GIT_WRITES.has(w[i])) dirs.push(dir);
  }
  return dirs;
}

/**
 * `git add -f <folder|glob>` adds every ignored file under it, not only the one the task needs (agentic-flow-public#15:
 * `git add -f .claude/skills` staged the ignored, generated .workflow-generated.json). A forced add names files.
 */
export function forcedAddIgnored(command, cwd = process.cwd()) {
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (b, p) => path.resolve(b, p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const w = part.trim().split(/\s+/).filter(Boolean).map(unmask);
    if (w[0] === 'cd') { if (w[1] && !/[$`]/.test(w[1])) base = abs(base, w[1]); continue; }
    let i = w[0] === 'sudo' ? 1 : 0;
    if (path.basename(w[i] || '') !== 'git') continue;
    let dir = base;
    i++;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C' && w[i + 1]) { dir = abs(dir, w[i + 1]); i += 2; } else if (w[i] === '-c') i += 2; else i++;
    }
    if (w[i] !== 'add') continue;
    const rest = w.slice(i + 1);
    if (!rest.some((x) => x === '-f' || x === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x))) continue;
    const specs = rest.filter((x) => !x.startsWith('-'));
    const wide = specs.filter((x) => /[*?[]/.test(x) || (() => { try { return fs.statSync(abs(dir, x)).isDirectory(); } catch { return false; } })());
    if (!wide.length) continue;
    const res = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...wide], { cwd: dir });
    const ignored = res.status === 0 ? res.stdout.split('\n').filter(Boolean) : [];
    if (ignored.length) return `git add -f ${wide.join(' ')} adds ignored files too (${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? ', …' : ''}); add the folder without -f and force only a named file the task needs: git add -f <file>`;
  }
  return null;
}

/** CLAUDE.md is loaded into every session unchecked and goes stale; project knowledge lives in brain (P-007, operator 2026-11-03). */
export const CLAUDE_MD_REASON = (rel) => `${rel}: CLAUDE.md is loaded into every session unchecked and goes stale (an agent took an outdated address from it); project knowledge goes to brain through workflow:save (memory, decision, rule, skill), the workflow rules come from its SessionStart hook (P-007, P-013). Move a still valid fact into brain; only deleting CLAUDE.md is allowed`;
function claudeMdWrite(ctx, absPaths) {
  if (!ctx.brainInfo || ctx.brainInfo.error) return null;
  const hit = absPaths.find((p) => /^CLAUDE(\.local)?\.md$/i.test(path.basename(p)));
  return hit ? CLAUDE_MD_REASON(toPosix(path.relative(ctx.projectDir, hit) || hit)) : null;
}

/** A secret written into the project outside local/ (P-018, P-052; Carol 2026-11-02: tokens stayed in scratch/). */
function secretOutsideLocal(ctx, absPaths, text) {
  const local = [path.join(ctx.projectDir, 'local'), ctx.brainDir && path.join(ctx.brainDir, 'local')].filter(Boolean);
  const inWork = (p) => isInside(ctx.projectDir, p) || isInside(topicsDir(ctx.projectDir), p) || (ctx.persona && managedProjectOf(ctx.projectDir, p));
  const hit = absPaths.filter((p) => inWork(p) && !local.some((l) => isInside(l, p)));
  if (!hit.length) return null;
  const kind = findSecret(text);
  if (!kind) return null;
  return `a secret (${kind}) would be written to ${toPosix(path.relative(ctx.projectDir, hit[0]) || hit[0])}; secrets go only to ${toPosix(path.join(ctx.projectDir, 'local'))}/ (gitignored, never shared; scratch/ is for work files and may end up in a worker brief or a snapshot), reference them by path (P-018, P-052)`;
}

// Claude Code's built-in privacy plugin asks the operator when a shell or web call holds the signed-in account email
// next to a network word (2026-11-04: four operator prompts in one topic). The agent is told first; a repeated
// identical call passes, so a send the operator asked for still reaches the operator's approval.
const EMAIL_WEB_TOOLS = ['WebBrowser', 'WebFetch', 'WebSearch'];
const EMAIL_SHELL_TOOLS = ['Bash', 'Monitor', 'PowerShell', 'Tmux'];
const EMAIL_NET = /\b(curl|wget|https?|httpie|xh|nc|ncat|socat|telnet|ssh|scp|sftp|rsync|ftp|lftp|rclone|iwr|irm|invoke-webrequest|invoke-restmethod)\b/;

export function accountEmail(env = process.env) {
  const files = [env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), env.HOME && path.join(env.HOME, '.claude.json')].filter(Boolean);
  for (const f of files) {
    try { const e = JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount?.emailAddress; if (e) return String(e).toLowerCase(); } catch { /* next */ }
  }
  return '';
}

export function accountEmailCall(tool, toolInput, email) {
  if (!email || (!EMAIL_WEB_TOOLS.includes(tool) && !EMAIL_SHELL_TOOLS.includes(tool))) return false;
  const raw = JSON.stringify(toolInput || {}).toLowerCase();
  const text = `${raw} ${raw.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))}`.toLowerCase();
  if (!text.includes(email)) return false;
  return EMAIL_WEB_TOOLS.includes(tool) || EMAIL_NET.test(text.replaceAll(email, ' ').replace(/\\(?:\\|[nrt])/g, ' '));
}

/**
 * `claude plugin install|enable` and `claude plugin marketplace add` default to scope user: the plugin is then on in
 * every session of the machine (operator 2026-11-07). Each such call needs --scope project|local; `claude mcp add`
 * is refused only with scope user (its default is local). Quoted text (commit messages) does not count.
 * Returns the offending call or null.
 */
export function pluginScopeCall(command) {
  for (const seg of executedText(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const i = words.findIndex((w) => w.replace(/^\(+/, '').split('/').pop() === 'claude');
    if (i < 0) continue;
    const [a, b, c] = words.slice(i + 1);
    const plugin = /^plugins?$/.test(a || '') && (/^(install|i|enable)$/.test(b || '') || (b === 'marketplace' && c === 'add'));
    const mcp = a === 'mcp' && b === 'add';
    if (!plugin && !mcp) continue;
    if (words.some((w) => w === '--help' || w === '-h')) continue;
    const rest = words.slice(i + 1).join(' ');
    const scope = (rest.match(/(?:--scope[\s=]|-s\s+)(\S+)/) || [])[1] || null;
    if (plugin && !['project', 'local'].includes(scope)) return { call: words.slice(i).join(' '), scope };
    if (mcp && scope === 'user') return { call: words.slice(i).join(' '), scope };
  }
  return null;
}

export function run(input) {
  const ctx = loadContext({ requireBrain: false });
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const policy = ctx.policy;
  const resolve = (p) => path.resolve(cwd, p);

  // P-061 (operator 2026-11-08): a question to the operator is asked in the dialog, so T3 shows the thread as "Awaiting Input";
  // a text question was lost in the thread among the mail turns. The time is kept for the Stop hook (question asked this turn).
  if (tool === 'AskUserQuestion' && !input.agent_id && ctx.brainDir && ctx.thread) {
    writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), dialog_at: new Date().toISOString() });
  }

  // P-055: work for another agent goes through mail, never straight into its thread.
  const denied = deniedTool(tool, policy.harness?.denied_tools || []);
  if (denied) return permissionOutput('deny', `${denied} is not used to hand work to another agent: it has no reply path and wakes nobody; send mail (comms send --level blocker|assist --to @<persona>/main or [<project>/]<topic>), the answer comes as --reply-to and wakes you (P-055)`);

  if (ctx.thread && accountEmailCall(tool, toolInput, accountEmail())) {
    const key = crypto.createHash('sha1').update(JSON.stringify(toolInput)).digest('hex').slice(0, 16);
    const state = readThreadState(ctx.brainDir, ctx.thread);
    const seen = Array.isArray(state.email_calls) ? state.email_calls : [];
    if (!seen.includes(key)) {
      writeThreadState(ctx.brainDir, ctx.thread, { ...state, email_calls: [...seen, key].slice(-50) });
      return permissionOutput('deny', `this call holds the operator's account email next to a network word (ssh, http, curl...), so Claude Code's built-in privacy check would ask the operator to approve it; keep the address out of shell and web calls: write file content with Write/Edit, or let the script read the address from a config file or an environment variable. If the operator asked to send it, run the same call again unchanged: the operator then approves it`);
    }
  }

  // P-061: no foreground waiting; the agent arms a waker and ends the turn.
  if (tool === 'Bash' && !toolInput.run_in_background) {
    const why = foregroundWait(toolInput.command || '');
    if (why) return permissionOutput('deny', `foreground waiting (${why}) keeps the turn open and burns tokens; arm a waker and end the turn: mail reply/TTL (comms send --level blocker|assist), a scheduled re-check (harness scheduler, e.g. T3 schedule_task), or a background watcher (run_in_background) for an event on this machine; a pause up to 10 s is allowed (P-061)`);
  }

  // Subagent: no brain scripts, no mail except reading (P-025).
  if ((input.agent_id || input.agent_type) && (tool === 'Bash' || tool === 'PowerShell')) {
    const cmd = String(toolInput.command || '');
    const executed = executedScripts(cmd);
    const hit = (policy.harness?.subagent_denied_scripts || []).find((s) => executed.some((e) => e.script === s || e.script.endsWith(`/${s}`)));
    if (hit) return permissionOutput('deny', `subagents do not write to brain or hold topics (${hit}); return the result to the main agent (P-025)`);
    const comms = commsSubagentCheck(cmd, input.agent_type);
    if (comms) return permissionOutput('deny', comms);
  }

  // P-052: a worker brief built by hand misses the work-file path, and the worker then writes into /tmp (2026-11-02:
  // 13 operator confirmations in one implementation run). The brief comes from `delegate.mjs prepare`.
  if ((tool === 'Agent' || tool === 'Task') && /(^|:)worker$/.test(String(toolInput.subagent_type || ''))) {
    const scratch = toPosix(path.join(ctx.projectDir, SCRATCH_DIR));
    if (!String(toolInput.prompt || '').includes(`${scratch}/`)) {
      return permissionOutput('deny', `worker brief has no work-file path (${scratch}/), so the worker would write into /tmp and every write would ask the operator; build the brief with delegate.mjs prepare --task "..." and pass its output as the prompt (workflow:delegate, P-052)`);
    }
  }

  // P-030: a recurring task collects data with a script and the agent only evaluates its output; a prompt that makes
  // the agent fetch and diff sources itself on every run is not repeatable (alice 2026-11-03: daily news report).
  const recurring = /(^|__)schedule_task$/.test(tool) ? typeof toolInput.prompt === 'string' : tool === 'CronCreate' && toolInput.recurring !== false;
  if (recurring && !/[\w./~-]+\.(mjs|cjs|js|sh|py)\b/.test(String(toolInput.prompt || ''))) {
    return permissionOutput('deny', `a recurring task runs a script, not a prompt that does the work by hand: write the deterministic part (fetch, diff against saved state, write the result) as a script, keep it in a skill (save.mjs skill <name> --script <file>, P-030) and let the prompt run it by absolute path and evaluate its output; lasting results of a persona go to docs/ (save.mjs docs, P-024), state to local/`);
  }

  // P-054: a step refused in this turn (workflow hook, harness permission, operator) is not reached another way.
  const state = ctx.brainDir && ctx.thread ? readThreadState(ctx.brainDir, ctx.thread) : null;
  const anchors = [cwd, ctx.projectDir, os.homedir()];
  // A refusal that names save.mjs as the way (P-013 single writer) does not lock a call that runs save.mjs: it is the
  // way, not a bypass (alice 2026-11-08: a refused Edit of a repo record locked the save.mjs call the refusal named).
  const viaSave = (tool === 'Bash' || tool === 'PowerShell') && executedScripts(String(toolInput.command || '')).some((e) => /(^|[\\/])bin[\\/]save\.mjs$/.test(e.script));
  const denials = [...(state ? stateDenials(state) : []), ...transcriptDenials(input.transcript_path, state?.turn_started_at || '')]
    .filter((d) => !(viaSave && /\bsave\b|save\.mjs/.test(String(d.reason || ''))));
  const bypass = denials.length ? bypassOf({ tool, toolInput, cwd, anchors, denials }) : null;
  if (bypass) return permissionOutput('deny', bypassReason(bypass, cwd));

  if (tool === 'Bash' || tool === 'PowerShell') {
    const p = pluginScopeCall(toolInput.command || '');
    if (p) return permissionOutput('deny', `${p.call}: scope ${p.scope || 'user (default)'} turns it on in every session of this machine; install only for this repository: cd "${ctx.projectDir}" && <the same command> --scope project (or --scope local when it must not be committed)`);
  }

  const out = pathChecks(input, ctx, cwd);
  const decision = out?.hookSpecificOutput?.permissionDecision;
  // The principles guard refuses only the bulk read; one principle file is its own sanctioned way, so the refusal locks
  // nothing (alice 2026-11-08: a refused `cat docs/principles/*` locked the README edit, and the agent asked the operator
  // a fake question to be let on, P-061).
  // A refused forced add names its own way (git add without -f, a named file) on the same paths: it locks nothing either.
  if (decision === 'deny' && state && !principlesBulkRead(tool, toolInput, cwd) && !/ adds ignored files too /.test(out.hookSpecificOutput.permissionDecisionReason || '')) {
    const found = analyze(tool, toolInput, cwd, anchors);
    const write = found.write;
    // A P-052 refusal (write outside the project) is about the outside target only: the way it names, a work file in
    // scratch/, may touch the other paths of the call (alice 2026-11-07: a patch script in the system temp dir locked
    // the repo files it was to change for the rest of the turn, and the work stopped until the operator wrote "up").
    const reasonText = out.hookSpecificOutput.permissionDecisionReason;
    // The refusal is about the write target outside, not about what the call only reads there (agentic-flow-public#16:
    // `grep <brain skills> > D:/tmp_$s.txt` refused, then reading the same skills was locked as a bypass).
    let paths = found.paths;
    if (/ is outside the (project|domain)/.test(reasonText)) {
      const cmd = String(toolInput.command || '');
      const writes = tool === 'Bash' || tool === 'PowerShell' ? [...shellWrites(cmd, cwd), ...bashEdits(cmd, cwd), ...bashTargets(cmd, cwd)] : found.paths;
      paths = [...new Set(writes.map((p) => path.resolve(cwd, p)))].filter((p) => !p.startsWith('/dev/') && !insideProject(ctx, p));
      if (!paths.length) paths = found.paths.filter((p) => !insideProject(ctx, p));
    }
    if (paths.length) writeThreadState(ctx.brainDir, ctx.thread, withDenial(readThreadState(ctx.brainDir, ctx.thread), { key: callKey(tool, toolInput), tool, paths, write, reason: out.hookSpecificOutput.permissionDecisionReason.slice(0, 160) }));
  }
  return out;
}

/** Catalog of project data (scripts/catalog/pretool.mjs): deny of a write into a read-only source, one reminder per session. Never throws. */
function catalogCheck(input, ctx, cwd) {
  try {
    return catalogPreTool(input, ctx, cwd, { bashTargets, bashEdits, shellWrites, maskShell, unmask, leadOf, readThreadState, writeThreadState });
  } catch {
    return null;
  }
}

function pathChecks(input, ctx, cwd) {
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const policy = ctx.policy;
  const resolve = (p) => path.resolve(cwd, p);

  const bulk = principlesBulkRead(tool, toolInput, cwd);
  if (bulk) return permissionOutput('deny', bulk);

  const target = targetOf(tool, toolInput);
  if (target) {
    const abs = resolve(target);
    const cat = catalogCheck(input, ctx, cwd);
    if (cat?.deny) return permissionOutput('deny', cat.deny);
    if (tool === 'Write' && typeof toolInput.content === 'string') {
      const big = bigWriteDeny(ctx.projectDir, policy, abs, Buffer.byteLength(toolInput.content));
      if (big) return permissionOutput('deny', big);
    }
    const knowledge = repoKnowledgeWrite(ctx, [abs]);
    if (knowledge) return permissionOutput('deny', knowledge);
    const owned = topicOwnedCheck(ctx, [abs]);
    if (owned) return permissionOutput('deny', owned);
    const written = [toolInput.content, toolInput.new_string, ...(toolInput.edits || []).map((e) => e.new_string), toolInput.new_source].filter((v) => typeof v === 'string').join('\n');
    const secret = secretOutsideLocal(ctx, [abs], written);
    if (secret) return permissionOutput('deny', secret);
    const claudeMd = claudeMdWrite(ctx, [abs]);
    if (claudeMd) return permissionOutput('deny', claudeMd);
    if (ctx.brainDir && isInside(ctx.brainDir, abs) && !personaWritable(ctx, abs)) {
      const persona = ctx.persona ? `; in a persona only ${SCRATCH_DIR}/ and local/ are written directly, outputs belong to the managed projects (P-024)` : '';
      return permissionOutput('deny', `direct write into brain is not allowed; use workflow:save, topic or done (P-013, P-040)${persona}`);
    }
    // P-052: work files stay in the project; topic copies ../<project>-topics/ are part of the project's work (P-036).
    // The agent's environment is its project: a write outside is denied, not asked (operator 2026-11-04: "agents must not
    // write to top-level directories, their environment is limited to the project").
    const marker = domainMarkerWrite(ctx, [abs]) || servicesWrite([abs], process.env, outsideAllowed(ctx));
    if (marker) return permissionOutput('deny', marker);
    if (boundaryActive(ctx) && !insideProject(ctx, abs)) {
      return permissionOutput('deny', `target ${outsideReason(ctx, abs)}`);
    }
    const guard = guardConfigWrite(ctx.projectDir, [abs]);
    if (guard) return permissionOutput('ask', guard);
    const generatedSkills = /[\\/]\.(claude|agents)[\\/]skills[\\/]/.exec(abs);
    if (tool !== 'NotebookEdit' && generatedSkills && isInside(ctx.projectDir, abs)) {
      return permissionOutput('deny', `.${generatedSkills[1]}/skills/ in the project is generated from brain at session start; edit skills in brain via workflow:save (P-017)`);
    }
    const inScratch = isInside(path.join(ctx.projectDir, SCRATCH_DIR), abs) || inWorkScratch(abs);
    const createdHere = createdByThread(ctx).has(abs);
    const cls = inScratch || createdHere || ownedEdit(ctx, abs) ? { dangerous: false, exists: fs.existsSync(abs) } : classifyTarget(abs);
    if (!cls.exists && !inScratch) rememberCreated(ctx, abs);
    if (cls.reason === 'tracked and clean') claimOwn(ctx, [abs]);
    let out = null;
    if (cls.dangerous && cls.exists) {
      const removed = removedLines(toolInput, abs);
      const total = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n').length : 0;
      const whole = tool === 'Write' || tool === 'NotebookEdit';
      const thr = policy.destructive || {};
      if (whole || removed > (thr.removed_lines_threshold ?? 50) || (total && removed > total * (thr.removed_fraction_threshold ?? 0.5))) {
        out = permissionOutput('ask', `target ${toPosix(path.relative(cwd, abs))} is ${cls.reason} (not recoverable from git); ${whole ? 'overwriting the whole file' : `removing ${removed} of ${total} lines`} needs operator confirmation with the exact target list (P-018)`);
      }
    }
    // Decision binding (P-031): one line, once per file per thread.
    if (ctx.brainDir) {
      const rel = isInside(ctx.projectDir, abs) ? toPosix(path.relative(ctx.projectDir, abs)) : toPosix(abs);
      const matches = findRelatesTo(ctx.brainDir, rel, { validOnly: true, domain: ctx.domain }).filter((m) => m.kind === 'decision');
      if (matches.length && ctx.thread) {
        const state = readThreadState(ctx.brainDir, ctx.thread);
        const seen = state.signaled_relates || [];
        if (!seen.includes(rel)) {
          writeThreadState(ctx.brainDir, ctx.thread, { ...state, signaled_relates: [...seen, rel] });
          const m = matches[0];
          const line = `decision ${m.id || m.key} relates to ${rel}: ${m.description} (read ${m.path} before changing, P-008)`;
          if (out) out.hookSpecificOutput.additionalContext = line;
          else out = contextOutput('PreToolUse', line);
        }
      }
    }
    return out || {};
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(toolInput.command || '');
    snapshotShell(ctx, input.tool_use_id, shellDirs(cmd, cwd));
    const cat = catalogCheck(input, ctx, cwd);
    if (cat?.deny) return permissionOutput('deny', cat.deny);
    const targets = bashTargets(cmd, cwd);
    const edits = bashEdits(cmd, cwd);
    const strayFile = (t) => fs.existsSync(t) && !fs.statSync(t).isDirectory() && ['untracked', 'ignored by git'].includes(classifyTarget(t).reason);
    const knowledge = repoKnowledgeWrite(ctx, [...targets, ...edits, ...shellWrites(cmd, cwd)].filter((t) => !strayFile(t)));
    if (knowledge) return permissionOutput('deny', knowledge);
    const owned = topicOwnedCheck(ctx, [...targets, ...edits, ...gitWriteDirs(cmd, cwd)]);
    if (owned) return permissionOutput('deny', owned);
    const secret = secretOutsideLocal(ctx, targets, cmd);
    if (secret) return permissionOutput('deny', secret);
    const claudeMd = claudeMdWrite(ctx, [...targets, ...edits].filter(() => !/^\s*(git\s+)?rm\s/.test(executedText(cmd))));
    if (claudeMd) return permissionOutput('deny', claudeMd);
    const asks = policy.harness?.ask_commands || [];
    const normalized = executedText(cmd).replace(/\s+/g, ' ');
    const historyOp = historyOperation(normalized, asks, policy.harness?.ask_commands_except || []);
    if (historyOp && !restoresOnlyOwn(ctx, cmd, cwd)) return permissionOutput('ask', `"${historyOp}" rewrites or drops git history; always needs explicit operator confirmation (P-018)`);
    const recursive = recursiveModeChange(cmd, cwd, path.join(ctx.projectDir, SCRATCH_DIR));
    if (recursive) return permissionOutput('ask', `recursive owner/mode change (${recursive.join('; ').slice(0, 160)}) rewrites every file under the target and git does not record it; confirm the exact target with the operator, or name only the files that need it (P-018)`);
    // An untracked file in brain is not brain data (git has none of it): removing such stray output goes through P-018
    // below, not the P-013 deny (Bob 2026-11-01: `rm 0` in the persona root was denied as a brain write). The same holds for
    // ignored files: an old `.scratch/` left by a migration is no brain data and asks instead of a deny (Carol 2026-11-02).
    // An empty directory holds no data and git does not track it (alice 2026-11-04: rmdir of an emptied skill dir was denied).
    const emptyDir = (t) => { try { return fs.statSync(t).isDirectory() && fs.readdirSync(t).length === 0; } catch { return false; } };
    const stray = (t) => emptyDir(t) || (fs.existsSync(t) && ['untracked', 'ignored by git'].includes(classifyTarget(t).reason));
    if (ctx.brainDir && targets.some((t) => isInside(ctx.brainDir, t) && !personaWritable(ctx, t) && !stray(t))) {
      return permissionOutput('deny', `shell write into brain is not allowed; use workflow:save, topic or done (P-013, P-040)`);
    }
    const created = createdByThread(ctx);
    const sudo = sudoDenied(ctx, cmd);
    if (sudo) return permissionOutput('deny', sudo);
    const marker = domainMarkerWrite(ctx, [...targets, ...edits, ...shellWrites(cmd, cwd)]) || servicesWrite([...targets, ...edits, ...shellWrites(cmd, cwd)], process.env, outsideAllowed(ctx));
    if (marker) return permissionOutput('deny', marker);
    if (boundaryActive(ctx)) {
      const outside = [...shellWrites(cmd, cwd), ...edits, ...targets].find((t) => !t.startsWith('/dev/') && !insideProject(ctx, t));
      if (outside) return permissionOutput('deny', `command writes ${outsideReason(ctx, outside)}`);
    }
    const guard = guardConfigWrite(ctx.projectDir, [...shellWrites(cmd, cwd), ...edits, ...targets]);
    if (guard) return permissionOutput('ask', guard);
    const forced = forcedAddIgnored(cmd, cwd);
    if (forced) return permissionOutput('deny', forced);
    const hookSkip = gitHookBypass(executedText(cmd));
    if (hookSkip) return permissionOutput('ask', `git with ${hookSkip} runs past the git hooks that guard brain and repos (brain pre-commit, repo checks); the operator confirms it (P-054)`);
    const isCreated = (t) => created.has(t) || [...created].some((c) => isInside(c, t));
    const dangerous = targets.filter((t) => !isCreated(t) && fs.existsSync(t) && !ownWork(ctx, t) && classifyTarget(t).dangerous);
    const thr = policy.destructive || {};
    if (targets.length > (thr.files_threshold ?? 5)) {
      return permissionOutput('ask', `operation on ${targets.length} files (> ${thr.files_threshold}); confirm the exact target list with the operator (P-018)`);
    }
    if (dangerous.length) {
      return permissionOutput('ask', `targets not recoverable from git: ${dangerous.map((t) => toPosix(path.relative(cwd, t))).join(', ')}; confirm with the operator before deleting or overwriting (P-018)`);
    }
    // A file this command creates (redirect, cp to a new target) is the thread's own: removing a stray one later needs
    // no confirmation (operator 2026-11-01: a file born by mistake is cleaned up, P-018).
    for (const t of targets) if (!fs.existsSync(t) && !isInside(path.join(ctx.projectDir, SCRATCH_DIR), t)) rememberCreated(ctx, t);
    // A tracked clean file this command changes becomes the thread's own edit (hash recorded by PostToolUse).
    claimOwn(ctx, [...targets, ...edits].filter((t) => fs.existsSync(t) && !ownWork(ctx, t) && classifyTarget(t).reason === 'tracked and clean'));
    const grepHint = grepNoFilename(cmd);
    if (grepHint) return contextOutput('PreToolUse', grepHint);
    if (cat?.remind) return contextOutput('PreToolUse', cat.remind);
  }
  return {};
}

if (isMain(import.meta.url)) {
  try {
    emit(run(readHookInput()));
  } catch (err) {
    process.stderr.write(`pre-tool-use: ${err.message}\n`);
    emit({});
  }
}
