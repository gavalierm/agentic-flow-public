#!/usr/bin/env node
// PreToolUse: secrets outside local/, brain protection (P-013, persona P-024), dangerous targets (P-018), work files outside the project (P-052), subagent limits incl. mail (P-025), decision binding (P-031), agent-to-agent channel (P-055), foreground waiting (P-061). Output: deny/ask or 1 line (c).
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readHookInput, emit, permissionOutput, contextOutput, isMain } from '../scripts/hooks-io.mjs';
import { loadContext, allowOutside, machineRoot, mainCheckout, WORKTREES_DIR, servicesDir, readThreadState, writeThreadState, personaWritable, SCRATCH_DIR, resolveBrain, threadStateFile } from '../scripts/config.mjs';
import { git, isInside, toPosix } from '../scripts/util.mjs';
import { readDrift } from '../scripts/drift.mjs';
import { parse, programIndex } from '../scripts/shell-parse.mjs';
import { findRelatesTo } from '../scripts/find.mjs';
import { SUBAGENT_ALLOWED, recordWaitingOperator } from '../scripts/comms.mjs';
import { repeatsAnswered, REPEATED_QUESTION_REASON } from '../scripts/protocol.mjs';
import { knowledgeDirOf, PROJECT_KNOWLEDGE } from '../scripts/repo-knowledge.mjs';
import { findSecret } from '../scripts/secrets.mjs';
import { inWorkScratch, ownedEdit, claimOwn, inPlaceEdits, snapshotShell } from '../scripts/own-files.mjs';
import { catalogPreTool } from '../scripts/catalog/pretool.mjs';
import { bigWriteDeny } from '../scripts/materialy.mjs';
import { heldTopics, topicCopyPath, expectedImplementation, implementMarkers, IMPLEMENT_CLASSES } from '../scripts/topic.mjs';
import { logDecision } from '../scripts/denials.mjs';
import { analyze, bypassOf, bypassReason, callKey, closedTargets, gitHookBypass, guardConfigWrite, heredocRuns, innerShellTexts, openByAnswers, runsText, segments, stateDenials, stripHeredocs, transcriptDenials, transcriptTurnText, turnLifts, awaitTranscriptToolUse, withDenial, withoutDataHeredocs } from '../scripts/bypass.mjs';

export const HOOK_META = { event: 'PreToolUse', class: 'block+c', limit: '1 line', principles: ['P-012', 'P-013', 'P-018', 'P-024', 'P-025', 'P-031', 'P-036', 'P-052', 'P-053', 'P-054', 'P-055'] };

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
export { withoutDataHeredocs, stripHeredocs };

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
    const runs = runsText(seg.trim().split(/\s+/));
    out.push(seg.replace(/\u0006(\d+)\u0006/g, (m, i) => (runs ? quoted[i] : 'Q')));
  }
  return out.join('');
}

/**
 * A command form the project's brain forbids (policy `harness.deny_commands`: [{ match: <regex source>, reason }]), tested
 * against the whole command text, heredoc bodies included; the reason names the skill that replaces the form (P-030).
 * An entry whose regex does not compile is skipped.
 */
export function deniedCommand(command, rules) {
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r.match !== 'string' || !r.match) continue;
    let re;
    try { re = new RegExp(r.match); } catch { continue; }
    if (re.test(String(command || ''))) return `${r.reason || 'command form forbidden by the project'} (policy harness.deny_commands of the brain)`;
  }
  return null;
}

/** History operation that needs confirmation: a listed command as a whole word sequence, minus listed safe forms (P-018). */
export function historyOperation(normalized, asks, except = []) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = (a) => new RegExp(`(^|[\\s;&|("'])${esc(a)}(?=\\s|$|[;&|)"'])`).test(normalized);
  // `git clean -nd`, `-ndx`, `-dn`: a dry run in a flag cluster lists files and removes nothing (the listed `git clean -n` is only the bare flag).
  const dryRunOnly = (a) => a === 'git clean' && [...normalized.matchAll(/(?:^|[\s;&|("'])git clean((?:\s+-[^\s;&|)"']+)*)/g)]
    .every((m) => m[1].split(/\s+/).some((f) => f === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f)));
  if (except.some(hit)) return null;
  return asks.find((a) => hit(a) && !dryRunOnly(a)) || null;
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
  // A variable the command assigns itself (`export TMPDIR=scratch; mkdir -p $TMPDIR`) is left to expandAssigned, which expands it to that value.
  const own = new Set([...String(command).matchAll(/(?:^|[\s;&|(])(?:export\s+)?(TMPDIR|TEMP|TMP)=/gi)].map((m) => m[1].toUpperCase()));
  return String(command)
    .replace(/\$(?:\{(TMPDIR|TEMP|TMP)\}|(TMPDIR|TEMP|TMP)\b)/gi, (m, a, b) => (own.has((a || b).toUpperCase()) ? m : dir))
    .replace(/\$env:(?:TEMP|TMP)\b|%(?:TEMP|TMP)%|\[(?:System\.)?IO\.Path\]::GetTemp(?:Path|FileName)\(\)/gi, dir)
    .replace(/\$\(\s*mktemp\b([^)]*)\)|`\s*mktemp\b([^`]*)`/g, (m, a, b) => {
      const args = a ?? b ?? '';
      if (/\s-p\b|--tmpdir=/.test(args)) return m;
      return mktempTemplate(args) || `${dir}/mktemp`;
    });
}
/**
 * `mktemp scratch/x.XXXXXX` (a template and no -t) creates the file where the template says, relative to the cwd, not in
 * the system temp dir; only a bare `mktemp`, `mktemp -d` or `mktemp -t …` uses TMPDIR. Returns the template or null.
 */
export function mktempTemplate(args) {
  const words = String(args).trim().split(/\s+/).filter(Boolean);
  if (words.some((w) => /^-[a-zA-Z]*t[a-zA-Z]*$/.test(w) || w === '--tmpdir')) return null;
  const t = words.find((w) => !w.startsWith('-'));
  return t && !/[$`'"()]/.test(t) ? t : null;
}

/** Comments removed (`# note > file`, an apostrophe in a comment no longer pairs with a later quote): `#` at the start of a word outside quotes. */
export function stripComments(cmd) {
  let out = '', q = null, i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (q) {
      out += c;
      if (c === '\\' && q !== "'") { out += cmd[i + 1] ?? ''; i += 2; continue; }
      if (c === (q === '"' ? '"' : "'")) q = null;
      i++; continue;
    }
    if (c === '\\') { out += c + (cmd[i + 1] ?? ''); i += 2; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Heredoc bodies removed, operators and spaces inside quotes masked, so only real shell syntax is parsed. */
export function maskShell(command) {
  let cmd = expandAssigned(expandTemp(String(command)));
  cmd = stripHeredocs(cmd);
  return stripComments(cmd).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => q.replace(/[>;&| ]/g, (c) => MASK[c]));
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
  // Only executed text: a brief written by `cat > f <<'EOF'` that named `chmod -R` asked the operator (alice 2026-11-12).
  // Quoted text given to a shell (`sudo bash -c '…'`) still runs.
  const text = executedText(command || '');
  for (let m; (m = re.exec(text)); ) {
    const words = m[3].trim().split(/\s+/).filter(Boolean);
    if (!words.some((w) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(w) || w === '--recursive')) continue;
    const args = words.filter((w) => !w.startsWith('-'));
    const paths = args.slice(1); // the first is the owner, mode or ACL spec
    const cd = /(^|[\s;&|('"`])(cd|pushd)\s/.test(text);
    const safe = paths.length && !cd && paths.every((p) => path.isAbsolute(p) && isInside(scratchDir, p));
    if (!safe) hits.push(`${m[2]} ${words.join(' ')}`.trim());
  }
  return hits.length ? hits : null;
}

/**
 * `grep -h` (no file names) over several files, a glob or a recursive search: the output cannot be split back into files,
 * and assigning lines to files by assumed order gives false claims (alice 2026-11-07: two non-existent conflicts between
 * daily reports 11-06/11-07). Returns a one-line hint, not a block: `-h` is fine for a plain union of matches, so no hint with
 * -o or when a later stage of the pipe sorts, counts or cuts the lines (sort, uniq, wc, cut, awk): no line is then assigned to a file.
 */
const GREP_VALUE_OPTS = new Set(['e', 'f', 'A', 'B', 'C', 'm', 'd', 'D']);
export function grepNoFilename(command) {
  const stages = [];
  for (const stmt of maskShell(command).split(/&&|\|\||[;\n]/)) {
    const parts = stmt.split('|');
    parts.forEach((seg, i) => stages.push({ seg, aggregated: parts.slice(i + 1).some((p) => /^\s*\(?(?:\S*\/)?(?:sort|uniq|wc|cut|awk)\b/.test(p)) }));
  }
  for (const { seg, aggregated } of stages) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const prog = (words[0] || '').replace(/^\(+/, '').split('/').pop();
    if (!['grep', 'egrep', 'fgrep'].includes(prog)) continue;
    let noName = false, recursive = false, onlyMatching = false, pattern = false, opts = true;
    const files = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (opts && w === '--') { opts = false; continue; }
      if (opts && w.startsWith('--')) {
        if (w === '--only-matching') onlyMatching = true;
        else if (w === '--no-filename') noName = true;
        else if (w === '--with-filename') noName = false;
        else if (/^--(recursive|dereference-recursive)$/.test(w)) recursive = true;
        else if (/^--(regexp|file)(=|$)/.test(w)) { pattern = true; if (!w.includes('=')) i++; }
        else if (/^--(after-context|before-context|context|max-count|directories|devices)$/.test(w)) i++;
        continue;
      }
      if (opts && /^-[A-Za-z]/.test(w)) {
        for (let j = 1; j < w.length; j++) {
          const c = w[j];
          if (c === 'o') onlyMatching = true;
          else if (c === 'h') noName = true;
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
    if (noName && many && !onlyMatching && !aggregated) {
      return `grep -h over several files (${files.length ? files.slice(0, 3).join(' ') : 'recursive'}) drops file names: lines cannot be assigned to files by order; to claim which file contains what, use grep -H or one grep per file`;
    }
  }
  return null;
}

export function bashTargets(command, cwd = process.cwd(), { skipRmdir = false, skipAppend = false } = {}) {
  const targets = [];
  let base = cwd;
  const home = process.env.HOME || '';
  const abs = (p) => path.resolve(base, gitBashPath(p.startsWith('~/') ? path.join(home, p.slice(2)) : p));
  for (const part of maskShell(command).split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const lead = leadOf(words);
    const prog = words[lead]?.split('/').pop();
    // A redirect written with a space (`rm x 2> /dev/null`, `cp a b > log`) takes the next word as its file, not as an argument.
    const operands = [];
    for (let i = lead + 1; i < words.length; i++) {
      if (/^[0-9&]*>>?&?$|^[0-9]*<{1,3}$/.test(words[i])) { i++; continue; }
      operands.push(words[i]);
    }
    const args = operands.filter((w) => !w.startsWith('-') && !/^['"]?[$<>|(`]/.test(w) && !/^[0-9]*>/.test(w));
    if (prog === 'cd') {
      if (args[0] && !/[$`]/.test(args[0])) base = abs(unmask(args[0]));
      continue;
    }
    // cp/mv into a directory overwrite <dir>/<source name>, not the directory (Bob 2026-11-01: `sudo cp $F /var/backups/`
    // asked as an overwrite of /var/backups); a source in a variable has no known name, so it adds no target.
    // A source `dir/.` (the contents of dir) has no name either: the files inside are not known here.
    const intoDir = (dest, sources, forceDir = false) => {
      const d = abs(unmask(dest));
      let isDir = forceDir || dest.endsWith('/');
      try { isDir ||= fs.statSync(d).isDirectory(); } catch { /* new path */ }
      return isDir ? sources.map((w) => path.basename(unmask(w))).filter((n) => n && n !== '.' && n !== '..').map((n) => path.join(d, n)) : [d];
    };
    // `-t DIR` / `--target-directory=DIR`: the directory is named by the option, every operand is a source (`cp -t dst a b`
    // asked as an overwrite of b).
    let tDir = null;
    const tOpt = operands.findIndex((w) => /^-[a-zA-Z]*t$/.test(w) || w === '--target-directory');
    const tEq = operands.find((w) => w.startsWith('--target-directory='));
    if (tEq) tDir = tEq.slice('--target-directory='.length);
    else if (tOpt >= 0 && operands[tOpt + 1]) tDir = operands[tOpt + 1];
    const sources = tDir ? (() => { const k = args.indexOf(tDir); return k >= 0 ? [...args.slice(0, k), ...args.slice(k + 1)] : args; })() : args.slice(0, -1);
    if (['rm', ...(skipRmdir ? [] : ['rmdir']), 'truncate', 'shred'].includes(prog)) targets.push(...args.map((w) => abs(unmask(w))));
    if (prog === 'mv' && (tDir || args.length > 1)) targets.push(...sources.map((w) => abs(unmask(w))), ...intoDir(tDir || args[args.length - 1], sources, Boolean(tDir)));
    else if (prog === 'mv') targets.push(...args.map((w) => abs(unmask(w))));
    if (prog === 'cp' && (tDir || args.length > 1)) targets.push(...intoDir(tDir || args[args.length - 1], sources, Boolean(tDir)));
    for (const m of part.matchAll(/(?:^|\s)(>{1,2})\s*(\S+)/g)) {
      const target = unmask(m[2]);
      if (skipAppend && m[1] === '>>') continue;
      if (!/^(&|\/dev\/|\$|\()/.test(target)) targets.push(abs(target)); // `>(cmd)` is a process substitution
    }
  }
  // text the command gives a local shell (`bash -c 'rm f'`, `sudo sh <<EOF`) removes and overwrites like the command itself
  for (const t of innerShellTexts(command)) targets.push(...bashTargets(t, cwd, { skipRmdir, skipAppend }));
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
// Programs whose `-o` is no output file: the logical OR in find and test/[ (alice 2026-11-04: `find . -path ./.git -prune
// -o -type f` was denied as a write to `-type`), "only matching" in grep and rg (a worker's `grep -o '<regex>'` was denied
// as a write to the regex and P-054 then locked the inventory, agentic-flow-public#11), an option or format elsewhere.
const OR_O_PROGS = new Set(['find', 'test', '[', '[[', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'git', 'ssh', 'scp', 'sftp', 'set', 'ps', 'pgrep', 'mount', 'lsblk', 'findmnt', 'join', 'ip', 'install', 'rsync', 'sshfs', 'fusermount', 'journalctl', 'lsof', 'xargs']);
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
// Output options per program (hooks review C3): the value is a file or folder the program writes. A program not in the
// table with `-o`/`--out*` is only a guess: it counts when the value looks like a path, and outside the boundary it asks
// instead of a deny (`sort -o`, `pandoc -o` are writes, `ls -o`, `grep -o`, `find -o` are not).
const OUTPUT_TABLE = {
  curl: ['-o', '--output', '--output-dir'], wget: ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output'],
  tsc: ['--outDir', '--outFile', '--declarationDir'], wrangler: ['--outdir'], esbuild: ['--outdir', '--outfile'], vite: ['--outDir'],
  rollup: ['-o', '--file', '-d', '--dir'], webpack: ['-o', '--output-path'], sort: ['-o', '--output'], pandoc: ['-o', '--output'],
  gcc: ['-o'], 'g++': ['-o'], cc: ['-o'], clang: ['-o'], 'clang++': ['-o'], go: ['-o'], rustc: ['-o', '--out-dir'], cargo: ['--target-dir'],
  npm: ['--prefix'], pnpm: ['--dir'], pip: ['--target', '-t', '--prefix', '--root'], pip3: ['--target', '-t', '--prefix', '--root'],
  unzip: ['-d'], '7z': ['-o'], tar: ['-C', '--directory'], gh: ['-O', '--output', '-D', '--dir'], yt: ['-o'], 'yt-dlp': ['-o', '--output', '-P', '--paths'],
  ffmpeg: [], jq: [], openssl: ['-out'], base64: ['-o'], magick: [], convert: [], dot: ['-o'], plantuml: ['-o'], mmdc: ['-o', '--output'],
};
// Programs that only read or print: an option-like word in their arguments is data (`grep -- --output /etc`, `echo --out x`,
// `ls -o /etc` where -o is "no group"), never an output file. `install -o` is the owner.
const NO_OUTPUT_PROGS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'echo', 'printf', 'cat', 'ls', 'head', 'tail', 'wc', 'nm', 'objdump', 'readelf', 'strings', 'stat', 'du', 'diff', 'cmp', 'man', 'which', 'cpio']);
// `npm --prefix <dir>` is the project the command runs in; it is a write target only where the command installs there.
const NPM_INSTALLERS = new Set(['install', 'i', 'add', 'ci', 'link', 'ln', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'dedupe', 'prune', 'rebuild', 'init', 'create']);
const NPM_VALUE_OPTS = new Set(['--prefix', '--dir', '-C', '--registry', '--cache', '--userconfig', '--workspace', '-w', '--loglevel']);
// Programs that run another program given in their arguments: `timeout 5 curl -o x`, `sudo -u root cp a b`, `xargs -I{} cp {} d`.
// Value = options that take a separate value; `positional` = words after the options that are not the program (timeout's duration).
const WRAPPERS = {
  sudo: { valued: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir'] },
  env: { valued: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], assigns: true },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  nice: { valued: ['-n', '--adjustment'] }, ionice: { valued: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] },
  stdbuf: { valued: ['-i', '-o', '-e'] }, nohup: { valued: [] }, setsid: { valued: [] }, time: { valued: [] },
  xargs: { valued: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-l', '-e', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
};
/** Index of the program a wrapper chain runs (`timeout 5 nice -n 5 curl …` -> curl). */
function skipWrappers(words, start) {
  let i = start;
  for (let guard = 0; guard < 8; guard++) {
    const spec = Object.hasOwn(WRAPPERS, String(words[i]?.text || '').split('/').pop()) ? WRAPPERS[String(words[i].text).split('/').pop()] : null;
    if (!spec || !words[i + 1]) return i;
    i++;
    while (words[i]) {
      const t = words[i].text;
      if (spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
      if (t === '--') { i++; break; }
      if (!t.startsWith('-') || t === '-') break;
      i += spec.valued.includes(t) ? 2 : 1;
    }
    i += spec.positional || 0;
  }
  return i;
}
const OUTPUT_GUESS = /^--(out|output|outdir|out-dir|output-dir|outfile|out-file|output-file|dest|destination|target-dir|log-file|cache-dir|prefix)$/i;
// Runners whose next word is the program: `npx wrangler …`, `pnpm exec tsc …`, `python3 -m pip …`.
const RUNNERS = { npx: 1, bunx: 1, pnpx: 1, uvx: 1, 'pnpm exec': 2, 'pnpm dlx': 2, 'npm exec': 2, 'yarn dlx': 2, 'python -m': 2, 'python3 -m': 2 };
const looksLikePath = (v, abs) => /[/\\~]/.test(v) || /^\.\.?$/.test(v) || /\.[A-Za-z0-9]{1,8}$/.test(v) || fs.existsSync(abs(v));

/**
 * The command runs bin/domain-move.mjs without --dry (the script itself, not its name in a quoted text: the hook asked
 * at a handover whose --task named the script, operator 2026-11-09). Without a domain argument the script only prints its usage
 * and changes nothing (`domain-move.mjs`, `domain-move.mjs finish`, `domain-move.mjs --to X`): no ask.
 */
export function runsDomainMove(command) {
  return parse(String(command || '')).some((seg) => {
    const words = seg.words.map((w) => w.text);
    const i = programIndex(seg.words);
    const prog = String(words[i] || '').split(/[\\/]/).pop();
    const at = /^(node|nodejs|bun)(\.exe)?$/.test(prog) ? words.findIndex((w, k) => k > i && !w.startsWith('-')) : i;
    if (!/(^|[\\/])domain-move\.mjs$/.test(words[at] || '') || words.includes('--dry')) return false;
    const operands = [];
    for (let k = at + 1; k < words.length; k++) {
      if (words[k] === '--to') k++;
      else if (!words[k].startsWith('-')) operands.push(words[k]);
    }
    return operands.length > (operands[0] === 'finish' ? 1 : 0);
  });
}

/** What a shell command writes: [{ path, sure }]; sure = false for an output option of a program the table does not know. */
export function shellWriteTargets(command, cwd = process.cwd(), env = process.env) {
  const found = [];
  let base = cwd;
  const home = env.HOME || '';
  const abs = (p) => path.resolve(base, gitBashPath(p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p));
  const add = (w, sure = true) => {
    // the temp dir expanded by expandTemp keeps its spaces masked so it stays one word
    const v = (typeof w === 'string' ? w : w && !w.dynamic ? w.text : '').replace(/[\u0001-\u0005]/g, (c) => UNMASK[c]) || null;
    if (v && v !== '-' && !/^\/dev\//.test(v) && !/^[&(]/.test(v)) found.push({ path: abs(v), sure });
  };
  for (const seg of parse(expandAssigned(expandTemp(String(command))))) {
    const words = seg.words;
    let lead = programIndex(words);
    // programIndex stops at the options of sudo/env (`sudo -u root cp a b`): the wrapper chain is walked from there.
    if (lead > 0 && words[lead]?.text.startsWith('-') && /^(sudo|env)$/.test(words[lead - 1].text)) lead--;
    lead = skipWrappers(words, lead);
    const name = (w) => String(w?.text || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
    let prog = name(words[lead]);
    const two = `${prog} ${words[lead + 1]?.text || ''}`;
    if (RUNNERS[two] || RUNNERS[prog]) {
      lead += RUNNERS[two] || RUNNERS[prog];
      while (words[lead] && words[lead].text.startsWith('-')) lead++;
      prog = name(words[lead]);
    }
    for (const r of seg.redirects) if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(r.op)) add(r.target);
    if (!prog) continue;
    if (prog === 'cd') { const d = words[lead + 1]; if (d && !d.dynamic) base = abs(d.text); continue; }
    const rest = words.slice(lead + 1);
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].text;
      if (t === '--') { positional.push(...rest.slice(i + 1)); break; }
      // values of options that are no path to create: mkdir -m MODE, touch -r REF / -d DATE / -t STAMP (`touch -r /etc/hosts f` only reads /etc/hosts)
      if (t.startsWith('-') && t.length > 1) { if ((prog === 'mkdir' && (t === '-m' || t === '--mode')) || (prog === 'touch' && ['-r', '-d', '-t', '--reference', '--date'].includes(t))) i++; continue; }
      positional.push(rest[i]);
    }
    if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(prog)) {
      const t = rest.findIndex((w) => w.text === '-t' || w.text === '--target-directory');
      const eq = rest.find((w) => w.text.startsWith('--target-directory='));
      if (t >= 0 && rest[t + 1]) add(rest[t + 1]);
      else if (eq) add(eq.text.slice('--target-directory='.length));
      else if (positional.length > 1) add(positional[positional.length - 1]);
    }
    if (prog === 'tee' || prog === 'mkdir' || prog === 'touch') positional.forEach((w) => add(w));
    if (prog !== 'cp' && prog !== 'mv') psWriteTargets(rest.map((w) => w.text), prog).forEach((w) => add(psValue(w)));
    // A bare `mktemp` / `New-TemporaryFile` creates the file in the system temp dir (`$(mktemp)` is expanded by expandTemp).
    // With a template and no -t the file is created where the template says (`mktemp scratch/x.XXXXXX`).
    if (prog === 'mktemp' && !rest.some((w) => /^(-[a-zA-Z]*u[a-zA-Z]*|--dry-run)$/.test(w.text)) && !rest.some((w) => w.text === '-p' || w.text.startsWith('--tmpdir='))) {
      const tpl = mktempTemplate(rest.map((w) => w.text).join(' '));
      if (tpl) add(tpl); else found.push({ path: path.join(os.tmpdir(), 'mktemp'), sure: true });
    } else if (/^new-temporaryfile$/i.test(prog)) found.push({ path: path.join(os.tmpdir(), 'mktemp'), sure: true });
    let known = Object.hasOwn(OUTPUT_TABLE, prog) ? OUTPUT_TABLE[prog] : null;
    // tar -C and unzip -d name the target only where the archive is extracted; `tar -czf a.tgz -C /etc ssh` and `tar -tf` read.
    if (prog === 'tar' && !rest.some((w, i) => /^--(extract|get)$/.test(w.text) || /^-[A-Za-z]*x/.test(w.text) || (i === 0 && /^[A-Za-z]*x/.test(w.text)))) known = [];
    if (prog === 'unzip' && rest.some((w) => /^-[a-zA-Z]*[lptvZ]/.test(w.text))) known = [];
    if ((prog === 'npm' || prog === 'pnpm') && known) {
      let sub = null;
      for (let i = 0; i < rest.length && !sub; i++) { if (NPM_VALUE_OPTS.has(rest[i].text)) i++; else if (!rest[i].text.startsWith('-')) sub = rest[i].text; }
      if (sub && !NPM_INSTALLERS.has(sub)) known = [];
    }
    if (NO_OUTPUT_PROGS.has(prog)) continue;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].text;
      if (t === '--') break; // after it every word is an argument: `grep -- --output /etc`
      // an option name written in quotes is text for the program (`grep -e "--log-file" /etc/nginx`), not an option
      if (/^['"]/.test(rest[i].raw) && t.startsWith('-')) continue;
      const eq = t.match(/^(--?[A-Za-z][\w-]*)=(.*)$/);
      const opt = eq ? eq[1] : t;
      const value = eq ? (rest[i].dynamic ? null : eq[2]) : rest[i + 1];
      if (value == null || (!eq && !rest[i + 1])) continue;
      if (known) { if (known.includes(opt)) add(value); continue; }
      if (OR_O_PROGS.has(prog) && opt === '-o') continue;
      // `git archive --prefix=x/` is a path inside the archive; `./configure --prefix=/usr` only records where `make install` goes
      if (opt === '--prefix' && ((prog === 'git' && !rest.some((w) => w.text === 'checkout-index')) || prog === 'configure')) continue;
      if (opt === '-o' || OUTPUT_GUESS.test(opt)) {
        const v = typeof value === 'string' ? value : value.dynamic ? null : value.text;
        // `NAME=value` sets an option, it is no path: `apt-get -o Dir::Etc::sourcelist=/etc/…` asked the operator about
        // `/tmp/Dir::Etc::…` (bob 2026-11-12).
        if (v && !/^[^/\\=]+=/.test(v) && looksLikePath(v, abs)) add(v, false);
      }
    }
  }
  // text the command gives a local shell (`bash -c '…'`, `sudo sh <<EOF`) writes like the command itself
  for (const t of innerShellTexts(command)) found.push(...shellWriteTargets(t, cwd, env));
  const seen = new Map();
  for (const f of found) seen.set(f.path, (seen.get(f.path) || false) || f.sure);
  return [...seen].map(([p, sure]) => ({ path: p, sure }));
}
/** Paths a shell command writes, sure or guessed (P-052). */
export function shellWrites(command, cwd = process.cwd(), env = process.env) {
  return shellWriteTargets(command, cwd, env).map((t) => t.path);
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

/**
 * Global paths of the harness in the policy (`harness.deny_paths` starting with `~/`, P-014): no tool writes there, also
 * where allow_outside would let it. The hook is the guard: Claude Code settings carry no native deny since D-0011.
 */
function harnessPathWrite(ctx, targets) {
  const roots = (ctx.policy?.harness?.deny_paths || []).filter((p) => p.startsWith('~/'))
    .map((p) => path.join(os.homedir(), ...p.slice(2).split('/').filter((s) => s && !s.includes('*'))));
  const hit = targets.find((t) => roots.some((r) => isInside(r, t)));
  return hit ? `${toPosix(hit)} is a global path of the harness (${roots.map(toPosix).join(', ')}): the agent never writes there (P-014)` : null;
}
function outsideReason(ctx, abs) {
  const scratch = toPosix(path.join(ctx.projectDir, SCRATCH_DIR));
  const where = ctx.domain ? `outside the domain ${toPosix(ctx.domain.root)}` : 'outside the project';
  const extra = ctx.domain ? '; a lasting exception is only the domain brain policy domain.allow_outside, changed on the operator\'s instruction' : '';
  return `${toPosix(abs)} is ${where}${isTempPath(abs) ? ' (system temp dir)' : ''}; the agent writes only inside it: work files and tool output go to ${scratch}/ (gitignored, no confirmation, P-052)${extra}${otherProjectHint(abs)}${rootHint(ctx, abs)}`;
}
/**
 * The domain lies outside the projects root saved for this machine (project.mjs root) and the target is inside it: the
 * domain was created in the wrong folder (carol 2026-11-09: persona in ~/agentic, the operator's domains elsewhere, the move
 * refused with no hint). Moving a domain is the operator's step; the agent gives it as an item under **Operátor:**.
 */
function rootHint(ctx, abs) {
  const root = machineRoot();
  if (!root || !ctx.domain || isInside(root, ctx.domain.root) || !isInside(root, abs)) return '';
  return `; this domain ${toPosix(ctx.domain.root)} is outside the projects root of this machine ${toPosix(root)} (project.mjs root): moving the domain there is the operator's step, give it as an item under **Úlohy pre operátora:** (mv ${toPosix(ctx.domain.root)} ${toPosix(path.join(root, path.basename(ctx.domain.root)))}, then adapter.mjs in each project)`;
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
      return `; it belongs to the workflow project ${p}: that work runs in a thread of that project, not here (topic.mjs create <topic> --class code --project ${p} --new-thread --task "..." or topic.mjs thread <topic> --project ${p} --task "...")`;
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
// Text a command only writes or sends is not a read (assist from a topic 2026-11-08: a heredoc with a mail body that named
// the principles path was denied): data heredocs and echo/printf parts are left out; a heredoc fed to a shell or an
// interpreter runs, so it stays.
const CODE_RUNNERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun']);
const TEXT_ONLY = new Set(['echo', 'printf']);
function readParts(command) {
  const noData = stripHeredocs(command, (head, line) => CODE_RUNNERS.has(head.split(/&&|\|\||;|\|/).pop().trim().split(/\s+/)[0]?.split('/').pop()) || heredocRuns(head, line));
  return segments(noData).filter((seg) => {
    const prog = (seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))[0] || '').replace(/^\(+/, '').split('/').pop();
    return !TEXT_ONLY.has(prog);
  });
}
export function principlesBulkRead(tool, toolInput = {}, cwd = process.cwd()) {
  const shell = tool === 'Bash' || tool === 'PowerShell';
  const parts = shell ? readParts(toolInput.command || '')
    : tool === 'Grep' ? [`${toolInput.path || ''} ${toolInput.glob || ''}`]
    : tool === 'Glob' ? [`${toolInput.pattern || ''} ${toolInput.path || ''}`] : [''];
  const home = process.env.HOME || '';
  // Only a directory that really is a principles dir (holds P-001.md): a project's own docs/principles stays free.
  const real = parts.some((text) => [...text.matchAll(PRINCIPLES_REF)].some((m) => {
    const ref = m[1].startsWith('~/') ? path.join(home, m[1].slice(2)) : m[1];
    return fs.existsSync(path.join(path.resolve(cwd, ref), 'P-001.md'));
  }));
  // A search over the parent docs/ walks into principles/ too (git grep x -- docs, grep -r x docs): the same bulk read.
  // The search and docs/ must be one part: `ls docs/*.md | grep x` searches the listing, not the directory.
  const searches = (text) => !shell || /(^|[\s;&|(`])(?:git\s+grep|[ef]?grep|ugrep|rg|ag|ack|find)(?=\s)/.test(text);
  const viaDocs = parts.some((text) => searches(text) && [...text.matchAll(DOCS_REF)].some((m) => {
    const ref = m[1].startsWith('~/') ? path.join(home, m[1].slice(2)) : m[1];
    return fs.existsSync(path.join(path.resolve(cwd, ref), 'principles', 'P-001.md'));
  }));
  return real || viaDocs ? 'docs/principles/ is read one principle at a time: the rule in rules/ is the working text, and only when you are unsure why a rule exists you open docs/principles/P-NNN.md for that one rule (P-001); if this call searches or lists the whole directory, use its output only for the rule you asked about' : null;
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
  const abs = (p) => path.resolve(base, gitBashPath(p.startsWith('~/') ? path.join(home, p.slice(2)) : p));
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

/**
 * Thread state files a workflow script of this command creates for another thread id it names (`WORKFLOW_THREAD_ID=<id>`,
 * in the brain of `WORKFLOW_PROJECT_DIR` or of cwd), when they do not exist yet: a test sender of this thread, so removing
 * it later is cleaning up after itself (P-018; alice 2026-11-12: `rm` of the pilot's local/threads/pilot-test-sender.json
 * asked the operator and waited 3.6 h overnight: the pilot brain is another repo and its local/ is ignored as a whole).
 */
export function threadStateBirths(command, cwd, self) {
  const value = (part, name) => {
    const m = part.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"$\`]+)"|'([^']+)'|([^\\s;&|$\`'"()<>]+))`));
    return m ? m[1] || m[2] || m[3] : null;
  };
  const out = new Set();
  for (const part of expandAssigned(command).split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const id = value(part, 'WORKFLOW_THREAD_ID');
    if (!id || id === self) continue;
    const dir = value(part, 'WORKFLOW_PROJECT_DIR');
    const info = resolveBrain(dir ? path.resolve(cwd, dir.replace(/^~(?=\/|$)/, os.homedir())) : cwd);
    if (!info?.brain) continue;
    const file = threadStateFile(info.brain, id);
    if (!fs.existsSync(file)) out.add(file);
  }
  return [...out];
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
      // `node --check <file>` only parses the file, it runs nothing (5 subagent refusals, audit M2 2026-11-11).
      let check = false;
      while (i < t.length && t[i].startsWith('-')) { if (head === 'node' && (t[i] === '--check' || t[i] === '-c')) check = true; i++; }
      if (check) continue;
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
    // No subcommand (usage, --help) prints help and reads nothing.
    if (sub && !SUBAGENT_ALLOWED.includes(sub)) return `subagents do not send, ack or decide mail (comms ${sub}); they may only read it (${SUBAGENT_ALLOWED.join(', ')}), P-025`;
  }
  return null;
}

/** Denied tool (P-055): exact name or MCP-namespaced `mcp__<server>__<name>`. Returns the denied name or null. */
export function deniedTool(toolName, denied = []) {
  const t = String(toolName || '');
  return denied.find((d) => t === d || t.endsWith(`__${d}`)) || null;
}

/**
 * Words of an MCP tool name (the part after the last `__`, split at `_` or `-`) that change something outside: a click or
 * typing on a page, mail, a calendar, a document, a deployment. hooks.json routes MCP tools holding one of them here.
 */
export const MCP_WRITE_VERBS = ['act', 'click', 'type', 'fill', 'form', 'submit', 'create', 'update', 'delete', 'remove', 'send', 'post', 'write', 'set', 'apply', 'upload', 'trash', 'edit', 'patch', 'insert', 'replace', 'move', 'press', 'select', 'drag', 'evaluate', 'javascript', 'reply', 'forward', 'label', 'mark', 'share', 'copy', 'rename', 'run', 'execute', 'batch', 'key', 'respond', 'merge', 'commit', 'push', 'deploy', 'publish', 'computer'];
const MCP_WRITE = new RegExp(`(?:^|_)(?:${MCP_WRITE_VERBS.join('|')})(?:_|$)`);
// A tool with an `action` field: a reading action (a screenshot, a list) changes nothing, an acting one (a click, typing,
// a rename) does, any other action is judged by the tool name; not the action alone, because t3_thread_update with
// action "rename" passed a question turn (pilot 2026-11-12).
const ACTING = /click|type|key|drag|fill|submit|press|select|upload/;
const READING = /^(?:screenshot|zoom|scroll|mouse_move|cursor_position|wait|read|get|list|show|status|find|search|query|snapshot|describe)(?:_|$)/;

/**
 * P-063 (agentic-flow-public#30): what this call changes beyond the work files, or null: a file tool or a shell write
 * outside a scratch/, a git write, an MCP tool that acts. Workflow scripts (save.mjs, comms.mjs, timer.mjs) are no shell
 * writes here, so the writes the workflow orders (handover, logs, mail) stay open (P-002).
 */
export function questionSideEffect(tool, toolInput = {}, cwd = process.cwd(), ctx = {}, sessionId = '') {
  const work = (abs) => toPosix(abs).startsWith('/dev/') || (ctx.projectDir && isInside(path.join(ctx.projectDir, SCRATCH_DIR), abs)) || inWorkScratch(abs);
  const shown = (abs) => toPosix((ctx.projectDir && insideProject(ctx, abs) && path.relative(ctx.projectDir, abs)) || abs);
  const name = String(tool || '');
  if (FILE_TOOLS.includes(name)) {
    const t = targetOf(name, toolInput);
    if (!t) return null;
    const abs = path.resolve(cwd, gitBashPath(t));
    return work(abs) || (ctx.projectDir && harnessScratchpadTarget(abs, sessionId, ctx)) ? null : `${name} ${shown(abs)}`;
  }
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(toolInput.command || '');
    const hit = [...shellWrites(cmd, cwd), ...bashEdits(cmd, cwd), ...bashTargets(cmd, cwd), ...gitWriteDirs(cmd, cwd)].map((p) => path.resolve(cwd, p)).find((p) => !work(p));
    return hit ? `${name} writing ${shown(hit)}` : null;
  }
  if (name.startsWith('mcp__')) {
    const short = name.slice(name.lastIndexOf('__') + 2).toLowerCase().replace(/-/g, '_');
    const act = typeof toolInput.action === 'string' ? toolInput.action.toLowerCase() : null;
    if (act && READING.test(act)) return null;
    if ((act && (ACTING.test(act) || MCP_WRITE.test(act))) || MCP_WRITE.test(short)) return `${short}${act ? ` (${act})` : ''}`;
  }
  return null;
}

/**
 * P-063 (report-f10bd0ef): a turn the operator started by saying the agent misread them; true when the call starts work on a
 * reading (a worker or subagent, a brief from delegate.mjs prepare) before the reading was checked with the operator.
 */
export function misreadWorkStart(tool, toolInput) {
  if (tool === 'Agent' || tool === 'Task') return true;
  return tool === 'Bash' && /\bdelegate\.mjs\b[^\n]*\bprepare\b/.test(String(toolInput?.command || ''));
}

export const MISREAD_TURN_REASON = 'the operator started this turn by saying you misread them, and this call starts work on your new reading before they confirmed it: first restate in the reply text in one sentence what you now understand they want (the kind of result, not only its topic: e.g. how we will work versus the content of the work); if two readings lead to different results, ask one AskUserQuestion with the readings as options, recommended first; an answered dialog opens the turn. If the reading is clear and already restated, run the same call again: it passes, this refusal comes once per turn (P-063, P-059)';

export const QUESTION_TURN_REASON = (what) => `the operator started this turn with a question (an explanation, a check), not an instruction to change, and ${what} changes something: answer the question first, and propose the change with what it would do; make it only when the operator asks for it. A guess or a hedge in the question („asi“, „maybe“) is no instruction. If the prompt does ask for this change, run the same call again: it passes, this refusal comes once per turn (P-063, P-002)`;

// P-012: topic drift. Only file tools and shell writes count; MCP tools and the workflow's own scripts do not.
const DRIFT_REMEDY = /(?:^|[\s/])(?:topic|save|comms|error)\.mjs\b/;
const driftRemedyText = (tool, toolInput) => ((tool === 'Bash' || tool === 'PowerShell') ? String(toolInput.command || '') : '');
function driftWrite(tool, toolInput, cwd, ctx, sessionId) {
  if (!FILE_TOOLS.includes(tool) && tool !== 'Bash' && tool !== 'PowerShell') return false;
  return !!questionSideEffect(tool, toolInput, cwd, ctx, sessionId);
}
export const DRIFT_REASON = (v) => `the task does not fit the subject of topic ${v.topic || '-'} ("${v.subject || '-'}"): ${v.reason || 'a different subject'}; save it (P-007), tell the operator the message drifted from the topic and offer a new topic (workflow:topic create), do not work on it here (P-012); if the operator explicitly wants it in this topic, repeat the step`;

const WAIT_UNIT = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
/**
 * P-061: a foreground command that waits for an event (sleep > 10 s, a loop that sleeps, watch) keeps the turn open
 * and burns tokens. Quoted data and heredoc bodies are not waits, except strings the shell runs (-c, eval, ssh, watch).
 * Returns the reason or null.
 */
export function foregroundWait(command) {
  let cmd = withoutDataHeredocs(command);
  cmd = cmd.replace(/((?<![\w.\/-])(?:(?:ba|z|da|k)?sh)(?:\s+-[A-Za-z]+)*?\s+-[A-Za-z]*c|\beval|\bssh\s+(?:-\S+\s+)*\S+|(?<![\w.\/-])watch(?:\s+-\S+)*)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, runs, sp, str) => {
    if (runs) return all;
    if (str[0] === '"' && /\$\(|`/.test(str.replace(/\\./g, ''))) return all;
    return `${sp}''`;
  });
  // A loop sent to the background (its `done`, with the redirects, is followed by a single &) or run under `timeout N` with N <= 10 s is no
  // foreground wait (audit 2.5: pilot wake loop, 4 of 20 denials); the loop in front of a ; or && stays one.
  cmd = cmd.replace(/\b(?:until|while)\b(?:(?!\bdone\b)[\s\S])*\bdone\b['"]?(?:\s*\d*>>?&?\s*[^\s&;|)]+)*\s*&(?!&)/g, '');
  cmd = cmd.replace(/\btimeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)\s+\S+\s+(?:-c\s+)?('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, n, u) => (Number(n) * WAIT_UNIT[u] <= 10 ? '' : all));
  if (/(?:^|[;&|({\n'"`]|\b(?:then|do|else)\b)\s*(?:until|while)\b[\s\S]*\bsleep\b/.test(cmd)) return 'loop with sleep';
  if (/(?<![\w.\/-])watch\s+(-\S+\s+)*\S/.test(cmd)) return 'watch';
  for (const m of cmd.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
    if (Number(m[1]) * WAIT_UNIT[m[2]] > 10) return `sleep ${m[1]}${m[2]}`;
  }
  return null;
}

/**
 * Git Bash on Windows gives paths as /d/<projekt>/...; on win32 they become D:/... before path.resolve, otherwise the
 * drive is taken from the cwd and the scratch/ write is denied (issue #28, 2026-11-11). Other platforms: unchanged.
 */
export function gitBashPath(p, platform = process.platform) {
  const s = String(p);
  if (platform !== 'win32') return s;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  return m ? `${m[1].toUpperCase()}:${m[2] || '/'}` : s;
}

/** System temp directories (os.tmpdir(), /tmp, /var/tmp; WORKFLOW_TEMP_DIRS overrides, the test fixtures live in /tmp). */
export function isTempPath(abs, env = process.env) {
  const dirs = env.WORKFLOW_TEMP_DIRS ? env.WORKFLOW_TEMP_DIRS.split(path.delimiter).filter(Boolean) : [os.tmpdir(), '/tmp', '/var/tmp'];
  return dirs.some((d) => isInside(d, abs));
}

/**
 * The harness scratchpad of this session (<temp>/claude-<uid>/<project slug>/<session>/scratchpad, which the system prompt
 * offers) is not the work dir here (P-052): a file tool aimed at it goes to <project>/scratch/ instead of a refusal (audit 2.5a:
 * 26 refusals, each one more turn; CLAUDE_CODE_TMPDIR in the settings.json env does not move it, checked on Claude Code 2.1.322).
 */
export function harnessScratchpadTarget(abs, sessionId, ctx, env = process.env) {
  if (!ctx.projectDir) return null;
  const m = /^(.*)\/claude-\d+\/[^/]+\/([0-9A-Fa-f-]{8,})\/scratchpad\/(.+)$/.exec(toPosix(abs));
  if (!m || !isTempPath(`${m[1]}/x`, env) || (sessionId && m[2] !== sessionId)) return null;
  return path.join(ctx.projectDir, SCRATCH_DIR, ...m[3].split('/'));
}

/**
 * `<repo>/agentic/` of a domain repo (or of its topic worktree) is written only by save (P-013, D-0002): format checks,
 * dedup and the commit into the repo happen there.
 */
export function repoKnowledgeWrite(ctx, absPaths) {
  if (!ctx.domain) return null;
  for (const p of absPaths) {
    const k = knowledgeDirOf(ctx.domain, ctx.brainDir, p);
    if (k) return `${k.repo}/${PROJECT_KNOWLEDGE}/ is written only by save (P-013, D-0002): save.mjs memory|decision|skill|handover ... --repo ${k.repo} (checks the format, deduplicates, commits into the repo${k.topic ? `, in topic ${k.topic} into its worktree` : ''}); a brain record moves with save.mjs move <path> --repo ${k.repo}`;
  }
  return null;
}

const GIT_WRITES = new Set(['commit', 'push', 'merge', 'tag', 'rebase', 'cherry-pick', 'am', 'revert', 'apply', 'reset', 'checkout', 'switch', 'stash', 'restore']);
// Read-only forms of write subcommands: `git tag` / `git tag -l|--sort=...|--contains X` list tags, `git stash list|show`
// list stashes (audit 2026-11-12: `git tag --sort=-creatordate | head -3` was denied as a change).
export function gitReadOnlyForm(w) {
  const pipe = w.findIndex((x) => /^[|>&]/.test(x));
  const rest = (pipe < 0 ? w : w.slice(0, pipe)).slice(1);
  if (w[0] === 'stash') return ['list', 'show'].includes(rest[0]);
  if (w[0] !== 'tag') return false;
  if (rest.some((x) => /^-[dafsum]$|^--(delete|annotate|force|sign|message|file)/.test(x))) return false;
  return rest.every((x) => /^-(l|n\d*|i)$|^--(list|sort|contains|no-contains|merged|no-merged|points-at|format|column|no-column|ignore-case|omit-empty|color|no-color)(=|$)/.test(x) || !x.startsWith('-')) && (rest.length === 0 || rest[0].startsWith('-'));
}
/** Repositories a shell command changes through git (`git [-C dir] commit|push|...`, also after `cd dir`); subs: the subcommands. */
export function gitWriteDirs(command, cwd = process.cwd(), subs = GIT_WRITES) {
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
    if (subs.has(w[i]) && !gitReadOnlyForm(w.slice(i))) dirs.push(dir);
  }
  return dirs;
}

// D-0020: in a topic code copy the worker only changes files; the topic thread commits, merges and releases after review.
export const TOPIC_THREAD_GIT = new Set(['commit', 'push', 'merge', 'rebase', 'tag']);

/** Roots of the topic code copies (P-036): the clones `../<project>-topics/` and, in a domain, `<domain>/.worktrees/`. */
export function topicCopyRoots(ctx) {
  const roots = [topicsDir(ctx.projectDir)];
  if (ctx.domain?.root) roots.push(path.join(ctx.domain.root, WORKTREES_DIR));
  return roots;
}

/** abs lies in a topic code copy (below one of the roots, not the root itself). */
export function inTopicCopy(ctx, abs) {
  return topicCopyRoots(ctx).some((root) => path.relative(path.resolve(root), path.resolve(abs)) !== '' && isInside(root, abs));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const samePath = (a, b) => toPosix(realOr(path.resolve(gitBashPath(String(a))))) === toPosix(realOr(path.resolve(gitBashPath(String(b)))));

/** The text names the directory (its path, native form or real path) as a whole path, not as the prefix of another name. */
export function mentionsPath(text, dir) {
  const forms = new Set([dir, toPosix(dir), realOr(dir), toPosix(realOr(dir))]);
  return [...forms].some((f) => new RegExp(`(?<![\\w./\\\\-])${escapeRe(f)}(?![\\w-]|\\.[\\w-])`).test(text));
}

/**
 * D-0020, P-053: an Agent call of the main agent whose prompt names the code copy of a topic this thread holds is an
 * implementation: it carries the marker of delegate.mjs prepare --implement for that copy and `model` equal to the model
 * the hook takes itself from policy and topic (class of the topic, or of its last recorded implementation); the marker
 * text is not trusted. Without `model` the worker runs on CLAUDE_CODE_SUBAGENT_MODEL, the cheap model. Read-only agent
 * types (harness.subagent_stop_exempt_agent_types) pass. Returns the deny reason or null.
 */
export function implementCheck(ctx, toolInput = {}) {
  if (!ctx.brainDir || !ctx.thread) return null;
  const type = String(toolInput.subagent_type || '');
  const exempt = ctx.policy?.harness?.subagent_stop_exempt_agent_types || [];
  if (type && exempt.some((t) => type === t || type.endsWith(`:${t}`))) return null;
  const prompt = String(toolInput.prompt || '');
  if (!prompt) return null;
  for (const topic of heldTopics(ctx.brainDir, ctx.thread)) {
    const copy = topicCopyPath(ctx, topic);
    if (!copy || !mentionsPath(prompt, copy)) continue;
    const prepare = `delegate.mjs prepare --implement${IMPLEMENT_CLASSES.includes(topic.class) ? '' : ' <web|code|ops>'} --topic ${topic.id} --task-file <file>`;
    const expected = expectedImplementation(ctx, topic);
    const want = expected?.model ? `; Agent with model: "${expected.model}" (class ${expected.cls})` : '';
    const marker = implementMarkers(prompt).find((m) => m.id === topic.id && samePath(m.copy, copy));
    if (!marker) return `the prompt names the code copy of topic ${topic.id} (${toPosix(copy)}) without its implement: marker: an implementation in a topic runs on the model of its class (D-0020, P-053); build the brief with ${prepare} and pass its output as the prompt${want}`;
    if (!expected) return `topic ${topic.id} has no class of an implementation (a discussion without delegate.mjs prepare --implement): the marker alone does not set it; run ${prepare} and pass its output as the prompt (D-0020, D-0021)`;
    if (!expected.model) return `policy topics.classes.${expected.cls}.subagent_model is not set: an implementation of class ${expected.cls} (topic ${topic.id}) has no model; set it in policy.json (a blocker of the policy, no fallback model, D-0021)`;
    if (marker.cls !== expected.cls) return `the marker names class ${marker.cls}, topic ${topic.id} implements as class ${expected.cls}: rebuild the brief with ${prepare}${want}`;
    const model = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (!model) return `the implementation worker of topic ${topic.id} has no model: without it the worker runs on CLAUDE_CODE_SUBAGENT_MODEL (the cheap model); pass model: "${expected.model}" (class ${expected.cls}, policy topics.classes.${expected.cls}.subagent_model, P-053); brief from ${prepare}`;
    if (model.toLowerCase() !== expected.model.toLowerCase()) return `model "${model}" is not the model of class ${expected.cls} (topic ${topic.id}): pass model: "${expected.model}" (policy topics.classes.${expected.cls}.subagent_model, P-053); brief from ${prepare}`;
  }
  return null;
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
    if (rest.some((x) => x === '-n' || x === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x))) continue;
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
// Only a CLAUDE.md a workflow session loads: in the project, its brain or a topic code copy, not in scratch/ (a clone
// of a foreign repo there keeps its own CLAUDE.md) and not in an unrelated repo (operator 2026-11-08, hooks review).
function claudeMdWrite(ctx, absPaths) {
  if (!ctx.brainInfo || ctx.brainInfo.error) return null;
  const copies = ctx.domain ? path.join(ctx.domain.root, WORKTREES_DIR, path.basename(mainCheckout(ctx.projectDir))) : path.resolve(ctx.projectDir, '..', `${ctx.projectName}-topics`);
  const roots = [ctx.projectDir, ctx.brainDir, copies].filter(Boolean);
  const loaded = (p) => roots.some((r) => isInside(r, p)) && !p.split(path.sep).includes(SCRATCH_DIR);
  const hit = absPaths.find((p) => /^CLAUDE(\.local)?\.md$/i.test(path.basename(p)) && loaded(path.resolve(p)));
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

/** The question texts of an AskUserQuestion call (kept until the dialog is answered, P-059). */
export const dialogQuestions = (toolInput) => (Array.isArray(toolInput?.questions) ? toolInput.questions : []).map((x) => (typeof x === 'string' ? x : x?.question)).filter(Boolean);

/** All the text an AskUserQuestion dialog shows: the questions, the option labels, descriptions and previews. */
export const dialogText = (toolInput) => (Array.isArray(toolInput?.questions) ? toolInput.questions : [])
  .flatMap((q) => (typeof q === 'string' ? [q] : [q?.question, ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description, o?.preview]) : [])]))
  .filter((s) => typeof s === 'string' && s.trim()).join('\n');

// P-061 (flow-public#32): a turn that wrote this much text before the dialog, with a dialog that shows less than the minimum.
export const LONG_TURN_TEXT = 1200;
export const MIN_DIALOG_TEXT = 200;
export const MIN_ANSWER_TEXT = 80;
export const UNANSWERED_DIALOG_REASON = (written) => `the operator started this turn with a question and the turn has written only ${written} characters of text before this dialog: while it is open the operator may not see the thread (T3 shows the dialog in place of the composer, on the phone over the thread), so they would decide about your proposal without your answer. Write the answer to the question in the reply text first, then ask about the proposal in the dialog: start its question with the answer in one sentence (the open dialog covers the text) and say what it decides about. A clarifying question you need before any answer: ask the same dialog again, a repeat passes (P-061, P-063)`;
export const THIN_DIALOG_REASON = (written, shown) => `this turn wrote ${written} characters of text before the dialog, the dialog shows only ${shown}: while it is open the operator may not see the text of the turn (T3 shows the dialog in place of the composer, on the phone over the thread), so they decide without the plan or proposal you wrote. Put into the dialog what the operator decides about: the content in short in the question (what the plan does, 1–3 sentences), in each option's description what it does, a longer text (the plan, a draft) in the option's preview (markdown). Then ask again; a repeat passes (P-061)`;

// flow-public#53: the turn wrote links (new products) in a table and opened a dialog at once; the dialog covered the table,
// so the operator decided without the links. The links the turn wrote that the dialog does not show.
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}|"'`]+/g;
export const turnLinks = (text) => [...new Set((String(text || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?*_~]+$/, '')))];
export const hiddenLinks = (turnText, shownText) => turnLinks(turnText).filter((u) => !String(shownText || '').includes(u));
export const HIDDEN_LINKS_REASON = (links) => `this turn wrote ${links.length} link(s) in its text that the dialog does not show (${links.slice(0, 5).join(', ')}${links.length > 5 ? ', …' : ''}): while it is open the operator may not see the text of the turn (T3 shows the dialog in place of the composer, on the phone over the thread), so they cannot open what they decide about. Put the links the operator needs into the dialog (the question, an option's description or preview), as bare addresses, not hidden in a table. Then ask again; a repeat passes (P-061, flow-public#53)`;

// flow-public#45: a dialog right after the operator's answer covers the thread again before the operator sees what the answer did.
export const CHAINED_DIALOG_REASON = (written) => `the operator answered a dialog in this turn and the turn has written only ${written} characters of text since: this dialog would cover the thread again (T3 shows the dialog in place of the composer, on the phone over the thread), so the operator would not see what the answer decided. Write in the reply text what the answer decided and what you did with it, then ask; put all remaining items into this one dialog (up to 4 questions) instead of one dialog after another. A follow-up the answer itself needs: ask the same dialog again, a repeat passes (P-061, flow-public#45)`;

// flow-public#43: a permission rule refused a compound command (`cd <project> && mkdir -p scratch/s && cp <deployed skill>
// scratch/s/ && diff scratch/s/x <brain copy>`) and every path it named counted as a refused write, so a later script that
// only read the deployed file and wrote scratch/ was locked. The harness does not say which path the rule hit: a rule
// refusal of a shell command locks the paths the command writes; one without a recognised write target keeps all its paths.
function ruleWrites(d, cwd) {
  if (!d.rule || d.paths || !(d.tool === 'Bash' || d.tool === 'PowerShell')) return d;
  const cmd = String(d.input?.command || '');
  const paths = [...new Set([...shellWrites(cmd, cwd), ...bashEdits(cmd, cwd), ...bashTargets(cmd, cwd)].map((p) => path.resolve(cwd, p)))].filter((p) => !p.startsWith('/dev/'));
  return paths.length ? { ...d, paths, write: true } : d;
}

/** P-054: the refusals of this turn that still lock: workflow hooks (thread state), the harness and permission rules (session
 * transcript); a dialog answer of the operator after a refusal that names its target and allows it opens it (flow-public#46). */
export function turnDenials(state, transcriptPath, cwd, anchors = []) {
  const all = [...(state ? stateDenials(state) : []), ...transcriptDenials(transcriptPath, state?.turn_started_at || '').map((d) => ruleWrites(d, cwd))];
  return openByAnswers(all, state ? turnLifts(state) : [], cwd, anchors);
}

/** flow-public#46: a compaction inside a turn drops which targets the turn refused, while the refusals still lock; the context after it lists them. */
export function closedTargetsNote(ctx, input) {
  if (!ctx.brainDir || !ctx.thread) return null;
  const cwd = gitBashPath(input.cwd || process.cwd());
  const anchors = [cwd, ctx.projectDir, os.homedir()];
  const closed = closedTargets(turnDenials(readThreadState(ctx.brainDir, ctx.thread), input.transcript_path, cwd, anchors), cwd, anchors, (p) => ownWork(ctx, p));
  return closed.length ? `refused in this turn (P-054): ${closed.join(', ')}; reaching them another way is a bypass; an answer of the operator in a dialog that names the target and allows it opens it (flow-public#46)` : null;
}

export function run(input) {
  const ctx = loadContext({ requireBrain: false });
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = gitBashPath(input.cwd || process.cwd());
  const policy = ctx.policy;
  const resolve = (p) => path.resolve(cwd, gitBashPath(p));

  // P-061 (operator 2026-11-08): a question to the operator is asked in the dialog, so T3 shows the thread as "Awaiting Input";
  // a text question was lost in the thread among the mail turns. The time is kept for the Stop hook (question asked this turn).
  if (tool === 'AskUserQuestion' && !input.agent_id && ctx.brainDir && ctx.thread) {
    // P-059: a dialog that repeats a question the operator answered in this thread is refused once per turn (the operator sees
    // the dialog before any Stop check); a second call in the turn passes: the agent then holds the step for serious.
    const before = readThreadState(ctx.brainDir, ctx.thread);
    const turnKey = before.turn_started_at || 'turn';
    if (before.repeat_denied_at !== turnKey) for (const q of dialogQuestions(toolInput)) {
      const old = repeatsAnswered(q, before.answered_questions || []);
      if (!old) continue;
      writeThreadState(ctx.brainDir, ctx.thread, { ...before, repeat_denied_at: turnKey });
      return permissionOutput('deny', REPEATED_QUESTION_REASON(old, q.replace(/\s+/g, ' ').trim()));
    }
    // P-061 (flow-public#32): an open dialog covers the text of the turn, so a dialog about a long plan written as text was
    // answered blind ("I have not seen it yet"): a dialog that shows little of it is refused once per turn; a repeat passes.
    // The harness appends the turn text after PreToolUse starts (pilot: 20 ms after the hook read it), so the check waits
    // until the transcript holds this call; only a thin dialog waits.
    const shown = dialogText(toolInput).length;
    if (before.thin_dialog_denied_at !== turnKey && shown < MIN_DIALOG_TEXT) {
      awaitTranscriptToolUse(input.transcript_path, input.tool_use_id);
      const written = transcriptTurnText(input.transcript_path, before.turn_started_at || '').trim().length;
      if (written >= LONG_TURN_TEXT) {
        writeThreadState(ctx.brainDir, ctx.thread, { ...before, thin_dialog_denied_at: turnKey });
        return permissionOutput('deny', THIN_DIALOG_REASON(written, shown));
      }
    }
    // flow-public#53: links written in the turn text are covered by the dialog; refused once per turn while the dialog does
    // not show them; a repeat passes. Without a transcript there is nothing to compare.
    if (before.hidden_links_denied_at !== turnKey && input.transcript_path && fs.existsSync(input.transcript_path)) {
      awaitTranscriptToolUse(input.transcript_path, input.tool_use_id);
      const hidden = hiddenLinks(transcriptTurnText(input.transcript_path, before.turn_started_at || ''), dialogText(toolInput));
      if (hidden.length) {
        writeThreadState(ctx.brainDir, ctx.thread, { ...readThreadState(ctx.brainDir, ctx.thread), hidden_links_denied_at: turnKey });
        return permissionOutput('deny', HIDDEN_LINKS_REASON(hidden));
      }
    }
    // flow-public#44: in a turn the operator started with a question, a dialog about a proposal opened before the answer
    // left the operator with the proposal and no answer: refused once per turn while the turn has written almost no text;
    // a repeat passes (a clarifying question asked first). Without a transcript there is nothing to measure.
    if (before.turn_intent === 'question' && before.unanswered_dialog_denied_at !== turnKey && input.transcript_path && fs.existsSync(input.transcript_path)) {
      awaitTranscriptToolUse(input.transcript_path, input.tool_use_id);
      const written = transcriptTurnText(input.transcript_path, before.turn_started_at || '').trim().length;
      if (written < MIN_ANSWER_TEXT) {
        writeThreadState(ctx.brainDir, ctx.thread, { ...before, unanswered_dialog_denied_at: turnKey });
        return permissionOutput('deny', UNANSWERED_DIALOG_REASON(written));
      }
    }
    // flow-public#45: the operator answered a dialog and the next dialog opened at once: it covered the thread again, so the
    // operator did not see what the answer decided. Refused once per answer while the turn has written almost no text since
    // the answer; a repeat passes (a follow-up the answer itself needs).
    const answeredAt = before.dialog_answered_at && (!before.turn_started_at || before.dialog_answered_at >= before.turn_started_at) ? before.dialog_answered_at : '';
    if (answeredAt && before.chained_dialog_denied_at !== answeredAt && input.transcript_path && fs.existsSync(input.transcript_path)) {
      awaitTranscriptToolUse(input.transcript_path, input.tool_use_id);
      const written = transcriptTurnText(input.transcript_path, answeredAt).trim().length;
      if (written < MIN_ANSWER_TEXT) {
        writeThreadState(ctx.brainDir, ctx.thread, { ...before, chained_dialog_denied_at: answeredAt });
        return permissionOutput('deny', CHAINED_DIALOG_REASON(written));
      }
    }
    const st ={ ...readThreadState(ctx.brainDir, ctx.thread), dialog_at: new Date().toISOString(), dialog_questions: dialogQuestions(toolInput) };
    writeThreadState(ctx.brainDir, ctx.thread, st);
    // P-061 (V1): the dialog holds the turn, so the thread cannot pick up mail: the open turn record in the mail says it waits for
    // the operator (PostToolUse clears it); mail then answers a sender `otázka` instead of "no reply".
    recordWaitingOperator(ctx, true, st.turn_opened_at ?? null);
  }

  // P-055: work for another agent goes through mail, never straight into its thread.
  const denied = deniedTool(tool, policy.harness?.denied_tools || []);
  if (denied) return permissionOutput('deny', `${denied} is not used to hand work to another agent: it has no reply path and wakes nobody; send mail (comms send --level blocker|assist --to @<persona>/main or [<project>/]<topic>), the answer comes as --reply-to and wakes you (P-055)`);

  // P-063 (agentic-flow-public#30): a turn the operator started with a question (UserPromptSubmit turn_intent) gives no
  // instruction to change: its first side effect is refused once per turn; a second call passes (the prompt did ask for it).
  if (!input.agent_id && !input.agent_type && ctx.brainDir && ctx.thread) {
    const st = readThreadState(ctx.brainDir, ctx.thread);
    const turnKey = st.turn_started_at || 'turn';
    const what = st.turn_intent === 'question' && st.question_denied_at !== turnKey ? questionSideEffect(tool, toolInput, cwd, ctx, input.session_id) : null;
    if (what) {
      writeThreadState(ctx.brainDir, ctx.thread, { ...st, question_denied_at: turnKey });
      return permissionOutput('deny', QUESTION_TURN_REASON(what));
    }
  }

  // P-063 (report-f10bd0ef): after „nepochopil si“ the agent started workers on a second wrong reading; the first work start of
  // such a turn is refused once until the reading is restated or the operator chose it in a dialog (PostToolUse clears turn_intent).
  if (!input.agent_id && !input.agent_type && ctx.brainDir && ctx.thread) {
    const st = readThreadState(ctx.brainDir, ctx.thread);
    const turnKey = st.turn_started_at || 'turn';
    if (st.turn_intent === 'misread' && st.misread_denied_at !== turnKey && misreadWorkStart(tool, toolInput)) {
      writeThreadState(ctx.brainDir, ctx.thread, { ...st, misread_denied_at: turnKey });
      return permissionOutput('deny', MISREAD_TURN_REASON);
    }
  }

  // P-012: the judge (UserPromptSubmit, detached) found this turn's task off the subject of the held topic: the first write of the
  // turn is refused once; a repeat passes (the operator may want it here). No verdict yet (late, failed, off): nothing is refused.
  if (!input.agent_id && !input.agent_type && ctx.brainDir && ctx.thread) {
    const st = readThreadState(ctx.brainDir, ctx.thread);
    const turnKey = st.turn_started_at;
    const verdict = turnKey && st.drift_denied_at !== turnKey ? readDrift(ctx.brainDir, ctx.thread, turnKey) : null;
    if (verdict && verdict.fits === false && !DRIFT_REMEDY.test(driftRemedyText(tool, toolInput)) && driftWrite(tool, toolInput, cwd, ctx, input.session_id)) {
      writeThreadState(ctx.brainDir, ctx.thread, { ...st, drift_denied_at: turnKey });
      return permissionOutput('deny', DRIFT_REASON(verdict));
    }
  }

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
    // D-0020: the worker changes the topic copy; commit, push, merge, rebase and tag stay with the topic thread.
    const inCopy = gitWriteDirs(cmd, cwd, TOPIC_THREAD_GIT).find((d) => inTopicCopy(ctx, d));
    if (inCopy) return permissionOutput('deny', `a worker does not commit, push, merge, rebase or tag in a topic code copy (${toPosix(inCopy)}): the topic thread commits after review (D-0020); leave the changes uncommitted and return a summary of them and the tests run`);
  }

  // P-052: a worker brief built by hand misses the work-file path, and the worker then writes into /tmp (2026-11-02:
  // 13 operator confirmations in one implementation run). The brief comes from `delegate.mjs prepare`. An agent of
  // another plugin (or general-purpose) gets the harness scratchpad in /tmp just the same (report-44b5e967: three
  // plugin agents with a hand-made brief tried to write and cd there); read-only types
  // (harness.subagent_stop_exempt_agent_types) pass.
  const agentType = String(toolInput.subagent_type || '');
  const readOnly = (ctx.policy?.harness?.subagent_stop_exempt_agent_types || []).some((t) => agentType === t || agentType.endsWith(`:${t}`));
  if ((tool === 'Agent' || tool === 'Task') && !readOnly) {
    const scratch = toPosix(path.join(ctx.projectDir, SCRATCH_DIR));
    if (!String(toolInput.prompt || '').includes(`${scratch}/`)) {
      const way = /(^|:)worker$/.test(agentType)
        ? 'build the brief with delegate.mjs prepare --task "..." and pass its output as the prompt (workflow:delegate, P-052)'
        : `name the work directory in the prompt ("work files only in ${scratch}/, not /tmp or the harness scratchpad"), or for research use workflow:worker with a brief from delegate.mjs prepare (P-052)`;
      return permissionOutput('deny', `agent brief${agentType ? ` (${agentType})` : ''} has no work-file path (${scratch}/), so the agent would write into the harness scratchpad in /tmp and the write hook refuses it; ${way}`);
    }
  }
  if ((tool === 'Agent' || tool === 'Task') && !input.agent_id && !input.agent_type) {
    const why = implementCheck(ctx, toolInput);
    if (why) return permissionOutput('deny', why);
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
  const denials = turnDenials(state, input.transcript_path, cwd, anchors)
    .filter((d) => !(viaSave && /\bsave\b|save\.mjs/.test(String(d.reason || ''))));
  const bypass = denials.length ? bypassOf({ tool, toolInput, cwd, anchors, denials, own: (p) => ownWork(ctx, p) }) : null;
  if (bypass) return permissionOutput('deny', bypassReason(bypass, cwd));

  if (tool === 'Bash' || tool === 'PowerShell') {
    const p = pluginScopeCall(toolInput.command || '');
    if (p) return permissionOutput('deny', `${p.call}: scope ${p.scope || 'user (default)'} turns it on in every session of this machine; install only for this repository: cd "${ctx.projectDir}" && <the same command> --scope project (or --scope local when it must not be committed)`);
  }

  const out = pathChecks(input, ctx, cwd);
  const decision = out?.hookSpecificOutput?.permissionDecision;
  // P-001 bulk read of docs/principles/ is a hint, not a deny: the check reads the command text and cannot tell a
  // search over the directory from a mention of it, and a wrong deny stopped the work (operator 2026-11-08, hooks
  // review: heuristic checks hint, only structural ones deny). The hint rides on an allow, never on a deny or ask.
  const bulk = principlesBulkRead(tool, toolInput, cwd);
  if (bulk && decision !== 'deny' && decision !== 'ask') {
    const prev = out?.hookSpecificOutput?.additionalContext;
    return { ...out, hookSpecificOutput: { ...(out?.hookSpecificOutput || {}), hookEventName: 'PreToolUse', additionalContext: prev ? `${bulk}\n${prev}` : bulk } };
  }
  // A refused forced add names its own way (git add without -f, a named file) on the same paths: it locks nothing.
  // So does a command form the brain forbids (deny_commands): it names the tool for the same file (Edit, multi-replace),
  // and its lock denied that Edit as a bypass until the end of the turn (report-14a1f628, 2026-11-13).
  if (decision === 'deny' && state && !/ adds ignored files too |\(policy harness\.deny_commands of the brain\)$/.test(out.hookSpecificOutput.permissionDecisionReason || '')) {
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
    // A secret refusal names local/ as its way: locking local/ closed the place it sends the secret to (report-123b3205).
    if (/^a secret \(/.test(reasonText)) {
      const locals = [path.join(ctx.projectDir, 'local'), ctx.brainDir && path.join(ctx.brainDir, 'local')].filter(Boolean);
      paths = paths.filter((p) => !locals.some((l) => isInside(l, path.resolve(cwd, p))));
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
  const resolve = (p) => path.resolve(cwd, gitBashPath(p));

  // Audit 2.5a, P-052: Write into the harness scratchpad of this session goes to scratch/; Edit follows a file that went there.
  // Read is not in the PreToolUse matcher (one hook process per read): the note names the new path, the model reads it there
  // (pilot pilot-0236-a). A file that really is in the scratchpad keeps the old way (a write there is refused).
  const padKey = tool === 'NotebookEdit' ? 'notebook_path' : FILE_TOOLS.includes(tool) ? 'file_path' : null;
  const padFrom = padKey && typeof toolInput[padKey] === 'string' ? resolve(toolInput[padKey]) : null;
  const padTo = padFrom ? harnessScratchpadTarget(padFrom, input.session_id, ctx) : null;
  if (padTo && !fs.existsSync(padFrom) && (tool === 'Write' || fs.existsSync(padTo))) {
    const updated = { ...toolInput, [padKey]: padTo };
    const out = pathChecks({ ...input, tool_input: updated }, ctx, cwd);
    const h = out?.hookSpecificOutput || {};
    if (h.permissionDecision === 'deny') return out;
    const note = `the harness scratchpad is not used here: this file is ${toPosix(padTo)}; read and edit it there (Read, cat), not in the scratchpad (work files in ${SCRATCH_DIR}/, P-052)`;
    return { ...out, hookSpecificOutput: { ...h, hookEventName: 'PreToolUse', permissionDecision: h.permissionDecision || 'allow', permissionDecisionReason: h.permissionDecisionReason || note, additionalContext: [h.additionalContext, note].filter(Boolean).join('\n'), updatedInput: updated } };
  }

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
    const written = [toolInput.content, toolInput.new_string, ...(toolInput.edits || []).map((e) => e.new_string), toolInput.new_source].filter((v) => typeof v === 'string').join('\n');
    const secret = secretOutsideLocal(ctx, [abs], written);
    if (secret) return permissionOutput('deny', secret);
    const claudeMd = claudeMdWrite(ctx, [abs]);
    if (claudeMd) return permissionOutput('deny', claudeMd);
    if (ctx.brainDir && isInside(ctx.brainDir, abs) && !personaWritable(ctx, abs)) {
      const persona = ctx.persona ? `; in a persona only ${SCRATCH_DIR}/, local/, docs/ and materialy/ are written directly (docs/ and materialy/ committed by save.mjs docs), outputs belong to the managed projects (P-024)` : '';
      return permissionOutput('deny', `direct write into brain is not allowed; use workflow:save, topic or done (P-013, P-040)${persona}`);
    }
    const harnessPath = harnessPathWrite(ctx, [abs]);
    if (harnessPath) return permissionOutput('deny', harnessPath);
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
    snapshotShell(ctx, input.tool_use_id, shellDirs(cmd, cwd), threadStateBirths(cmd, cwd, ctx.thread));
    const cat = catalogCheck(input, ctx, cwd);
    if (cat?.deny) return permissionOutput('deny', cat.deny);
    const forbidden = deniedCommand(cmd, policy.harness?.deny_commands);
    if (forbidden) return permissionOutput('deny', forbidden);
    const targets = bashTargets(cmd, cwd);
    const edits = bashEdits(cmd, cwd);
    const strayFile = (t) => fs.existsSync(t) && !fs.statSync(t).isDirectory() && ['untracked', 'ignored by git'].includes(classifyTarget(t).reason);
    const knowledge = repoKnowledgeWrite(ctx, [...targets, ...edits, ...shellWrites(cmd, cwd)].filter((t) => !strayFile(t)));
    if (knowledge) return permissionOutput('deny', knowledge);
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
    // Edits in place (sed -i, perl -pi), redirects and tee count too: the native deny of the harness caught them until D-0011
    // removed it (52 of 65 of its refusals were false). A new file in an ignored path (local/) is no brain data.
    const shellTargets = [...targets, ...edits, ...shellWrites(cmd, cwd)];
    const ignoredInBrain = (t) => !fs.existsSync(t) && git(['check-ignore', '-q', '--no-index', '--', t], { cwd: ctx.brainDir }).ok;
    if (ctx.brainDir && shellTargets.some((t) => isInside(ctx.brainDir, t) && !personaWritable(ctx, t) && !stray(t) && !ignoredInBrain(t))) {
      return permissionOutput('deny', `shell write into brain is not allowed; use workflow:save, topic or done (P-013, P-040)`);
    }
    const harnessPath = harnessPathWrite(ctx, shellTargets);
    if (harnessPath) return permissionOutput('deny', harnessPath);
    const skillsWrite = shellTargets.find((t) => isInside(ctx.projectDir, t) && ['/.claude/skills/', '/.agents/skills/'].some((d) => toPosix(t).includes(d)));
    if (skillsWrite) return permissionOutput('deny', `${toPosix(skillsWrite)}: .claude/skills/ in the project is generated from brain at session start; edit skills in brain via workflow:save (P-017)`);
    const created = createdByThread(ctx);
    const sudo = sudoDenied(ctx, cmd);
    if (sudo) return permissionOutput('deny', sudo);
    // A domain move writes outside the domain (mv of the domain, ~/.claude history and trust): the operator's step, confirmed
    // with the exact command; the plan (--dry) needs nothing (carol 2026-11-09).
    if (runsDomainMove(cmd)) return permissionOutput('ask', `domain-move.mjs moves a domain folder and writes into ~/.claude outside the domain (P-052): the operator confirms this exact command; show the plan first (domain-move.mjs <dir> --dry)`);
    const marker = domainMarkerWrite(ctx, [...targets, ...edits, ...shellWrites(cmd, cwd)]) || servicesWrite([...targets, ...edits, ...shellWrites(cmd, cwd)], process.env, outsideAllowed(ctx));
    if (marker) return permissionOutput('deny', marker);
    if (boundaryActive(ctx)) {
      const writes = shellWriteTargets(cmd, cwd);
      const outside = [...writes.filter((w) => w.sure).map((w) => w.path), ...edits, ...targets].find((t) => !t.startsWith('/dev/') && !insideProject(ctx, t));
      if (outside) return permissionOutput('deny', `command writes ${outsideReason(ctx, outside)}`);
      // An output option of a program the table does not know: maybe a write, so the operator decides (hooks review C3).
      const guess = writes.find((w) => !w.sure && !insideProject(ctx, w.path));
      if (guess) return permissionOutput('ask', `command may write ${toPosix(guess.path)} (an output option of a program the hook does not know) outside ${ctx.domain ? `the domain ${toPosix(ctx.domain.root)}` : 'the project'}; work files go to ${toPosix(path.join(ctx.projectDir, SCRATCH_DIR))}/ (P-052)`);
    }
    const guard = guardConfigWrite(ctx.projectDir, [...shellWrites(cmd, cwd), ...edits, ...targets]);
    if (guard) return permissionOutput('ask', guard);
    const forced = forcedAddIgnored(cmd, cwd);
    if (forced) return permissionOutput('deny', forced);
    const hookSkip = gitHookBypass(executedText(cmd));
    if (hookSkip) return permissionOutput('ask', `git with ${hookSkip} runs past the git hooks that guard brain and repos (brain pre-commit, repo checks); the operator confirms it (P-054)`);
    const isCreated = (t) => created.has(t) || [...created].some((c) => isInside(c, t));
    // Appending (`>>`) loses nothing, rmdir removes only an empty directory (skarper 2026-11-10: `rm docs/firma/x.md && rmdir docs/firma docs` asked)
    // and the same file named twice is one file: none of them asks as an overwrite of many files.
    const overwritten = [...new Set(bashTargets(cmd, cwd, { skipRmdir: true, skipAppend: true }))];
    const dangerous = overwritten.filter((t) => !isCreated(t) && fs.existsSync(t) && !ownWork(ctx, t) && classifyTarget(t).dangerous);
    const thr = policy.destructive || {};
    // The threshold counts files the command changes or removes: not the ones it creates, not missing ones and not the
    // thread's own work files (6 files in scratch/wt asked and waited 6 896 s for the operator, audit M2 2026-11-11).
    const changed = overwritten.filter((t) => !isCreated(t) && fs.existsSync(t) && !ownWork(ctx, t));
    if (changed.length > (thr.files_threshold ?? 5)) {
      return permissionOutput('ask', `operation on ${changed.length} files (> ${thr.files_threshold}); confirm the exact target list with the operator (P-018)`);
    }
    if (dangerous.length) {
      return permissionOutput('ask', `targets not recoverable from git: ${dangerous.map((t) => toPosix(path.relative(cwd, t))).join(', ')}; confirm with the operator before deleting or overwriting (P-018)`);
    }
    // A file this command creates (redirect, cp to a new target) is the thread's own: removing a stray one later needs
    // no confirmation (operator 2026-11-01: a file born by mistake is cleaned up, P-018).
    // The same for what mkdir, touch and tee create, and for the new directories above a new file: `mkdir -p d/sub && cp a d/sub/f`
    // is cleaned up by `rm -rf d` without asking (the thread made all of d).
    const born = [...targets, ...shellWriteTargets(cmd, cwd).filter((w) => w.sure).map((w) => w.path)].filter((t) => !fs.existsSync(t));
    for (const t of new Set(born)) {
      if (isInside(path.join(ctx.projectDir, SCRATCH_DIR), t)) continue;
      let top = t;
      while (!fs.existsSync(path.dirname(top)) && path.dirname(top) !== top) top = path.dirname(top);
      rememberCreated(ctx, top);
    }
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
    const input = readHookInput();
    const out = run(input);
    // Every deny/ask goes to <brain>/local/denials.jsonl, so false positives are counted, not only felt (bin/denials.mjs).
    if (['deny', 'ask'].includes(out?.hookSpecificOutput?.permissionDecision)) {
      try {
        const ctx = loadContext({ requireBrain: false });
        logDecision(ctx.brainDir, { event: 'PreToolUse', tool: input.tool_name, toolInput: input.tool_input, out, thread: ctx.thread, agentType: input.agent_type });
      } catch { /* the log never changes the decision */ }
    }
    emit(out);
  } catch (err) {
    process.stderr.write(`pre-tool-use: ${err.message}\n`);
    emit({});
  }
}
