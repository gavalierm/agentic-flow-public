// P-054: a step that was denied (workflow hook, harness permission, operator) is not reached another way in the same turn.
// The agent tends to route around an obstacle (python3 instead of a denied sed -i, Read instead of a denied cat, a parent
// directory instead of a denied subdirectory); the hook compares the paths a call reaches with the paths of the calls
// denied since the turn began. The operator's next prompt starts a new turn and lifts the block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isInside, toPosix } from './util.mjs';

const MAX_DENIALS = 20;
const TRANSCRIPT_TAIL = 2 * 1024 * 1024;
/** Harness wording of a permission refusal (rule, dialog answered "no"); a workflow hook denial is recorded in thread state. */
export const HARNESS_DENIAL = /has been denied|doesn't want to proceed|tool use was rejected|denied by the user|user rejected/i;
const SHELLS = ['Bash', 'PowerShell', 'Monitor'];
const INTERPRETERS = new Set(['node', 'sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'pwsh', 'powershell', 'deno', 'bun', 'ruby', 'perl', 'env', 'sudo', 'nice', 'timeout', 'xargs']);
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more', 'ls', 'stat', 'file', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'true', 'test', '[', 'pwd', 'which', 'type', 'realpath', 'readlink', 'basename', 'dirname', 'du', 'df', 'tree', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'jq', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'get-content', 'get-childitem', 'select-string', 'test-path', 'cd', 'set-location']);
const READ_GIT = new Set(['status', 'log', 'diff', 'show', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'blame', 'cat-file', 'shortlog', 'reflog', 'ls-remote', 'remote', 'branch', 'tag']);
const SHELL_LEAD = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', 'time']);
const SHELL_END = new Set(['done', 'fi', 'esac', '}', ')']);
const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export function callKey(tool, toolInput = {}) {
  return crypto.createHash('sha1').update(`${tool}\0${JSON.stringify(toolInput)}`).digest('hex').slice(0, 16);
}

function expand(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p.replace(/^\$HOME(?=\/|$)/, os.homedir()).replace(/^\$env:USERPROFILE(?=[\\/]|$)/i, os.homedir());
}

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []).map((t) => t.replace(/^["']|["']$/g, '').replace(/^[<>]+|^\d?>+&?\d?/, ''));
}

/**
 * Parts of a shell command split at &&, ||, ;, | and newlines outside quotes. A separator inside a quoted argument is
 * text: a commit message with "; " gave a part whose words read as paths (bob 2026-11-08: "commit iba v agentic/
 * preskočí testy; …" matched the refused <repo>/agentic and blocked a commit that did not touch it).
 */
/**
 * Heredoc bodies fed to a program that only stores or reads them (`cat > f <<EOF`, `python3 - <<EOF`) are data: the
 * text `git checkout --` inside a script being written is no history operation (alice 2026-11-03: writing release.sh
 * asked the operator), and a `/** comment` inside it is no path (alice 2026-11-08: it matched a refused temp file and
 * locked the write to scratch/ the refusal named). A body fed to a shell (`bash <<EOF`, `ssh host <<EOF`) is executed and stays.
 */
const SHELL_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ssh', 'sudo', 'su', 'eval', 'xargs', 'env', 'nohup', 'time']);
export function withoutDataHeredocs(command) {
  return String(command).replace(/([^\n]*?)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, (m, head) => {
    const prog = head.split(/&&|\|\||;|\|/).pop().trim().split(/\s+/)[0]?.split('/').pop();
    return SHELL_RUNNERS.has(prog) ? m : m.split('\n')[0];
  });
}

export function segments(cmd) {
  const out = [];
  let cur = '', quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A path too wide to mean one target: a filesystem root, a repo root, or a folder above the session's anchors. */
function broad(p, anchors) {
  if (p === path.parse(p).root) return true;
  if (/^\/(dev|proc|sys)(\/|$)/.test(toPosix(p))) return true;
  if (anchors.some((a) => a && isInside(p, a))) return true;
  try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git')); } catch { return false; }
}

/** Paths a call reaches and whether it may change them. A shell command counts as read-only only when every program in it is a known reader. */
export function analyze(tool, toolInput = {}, cwd = process.cwd(), anchors = []) {
  const raw = [];
  let write = FILE_WRITE_TOOLS.includes(tool);
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof toolInput[k] === 'string' && toolInput[k]) raw.push([toolInput[k], cwd]);
  if (tool === 'Glob' && toolInput.pattern) {
    const base = String(toolInput.pattern).split(/[*?[{]/)[0].replace(/\/+$/, '');
    if (base) raw.push([base, toolInput.path ? path.resolve(cwd, toolInput.path) : cwd]);
  }
  if (SHELLS.includes(tool) && toolInput.command) {
    let dir = cwd;
    const cmd = String(toolInput.command);
    if (/(^|[^0-9&>])>{1,2}(?!&)\s*[^\s&]/.test(cmd.replace(/"[^"]*"|'[^']*'/g, '""')) || /<<-?\s*['"]?\w/.test(cmd)) write = true;
    for (const segment of segments(withoutDataHeredocs(cmd))) {
      const t = tokens(segment.trim()).filter(Boolean);
      let i = 0;
      // Shell keywords are no programs: `do grep …` runs grep, `done`/`fi` end a block, `for s in a b` lists words
      // (agentic-flow-public#16: a read-only loop over skill folders counted as a write and P-054 locked it).
      while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || SHELL_LEAD.has(t[i]))) i++;
      const program = (t[i] || '').split(/[\\/]/).pop().toLowerCase();
      if (!program || SHELL_END.has(program)) continue;
      if (program === 'for' || program === 'select' || program === 'case') continue;
      if (program === 'cd' || program === 'set-location' || program === 'pushd') {
        if (t[i + 1]) dir = path.resolve(dir, expand(t[i + 1]));
        continue;
      }
      if (program === 'git') {
        let j = i + 1;
        while (j < t.length && t[j].startsWith('-')) j += ['-C', '-c', '--git-dir', '--work-tree'].includes(t[j]) ? 2 : 1;
        if (!READ_GIT.has(t[j])) write = true;
      } else if (program === 'sed') {
        if (t.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place')) write = true;
      } else if (program === 'find') {
        if (t.some((x) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(x))) write = true;
      } else if (!READ_PROGRAMS.has(program)) write = true;
      let skipNext = INTERPRETERS.has(program);
      for (const tok of t.slice(i + 1)) {
        if (skipNext && !tok.startsWith('-')) { skipNext = INTERPRETERS.has(tok.split(/[\\/]/).pop().toLowerCase()); continue; }
        const val = tok.includes('=') && tok.startsWith('-') ? tok.slice(tok.indexOf('=') + 1) : tok;
        if (!val || val.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(val)) continue;
        const e = expand(val);
        if (path.isAbsolute(e) || /^[A-Za-z]:[\\/]/.test(e)) raw.push([e, dir]);
        else if (/[\\/.]/.test(e) || fs.existsSync(path.resolve(dir, e))) {
          if (fs.existsSync(path.resolve(dir, e))) raw.push([e, dir]);
        }
      }
    }
  }
  const wide = [cwd, ...anchors];
  const paths = [...new Set(raw.map(([p, base]) => path.resolve(base, expand(p))))].filter((p) => !broad(p, wide));
  return { paths, write };
}

/** Workflow hook denials of this turn, kept in thread state. */
export function stateDenials(state = {}) {
  const since = state.turn_started_at || '';
  return (Array.isArray(state.denials) ? state.denials : []).filter((d) => !since || d.at >= since);
}

export function withDenial(state, denial) {
  return { ...state, denials: [...stateDenials(state), { at: new Date().toISOString(), ...denial }].slice(-MAX_DENIALS) };
}

function resultText(c) {
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
  return '';
}

/** Harness permission refusals of this turn, read from the session transcript. Without a turn start the last operator prompt bounds it. */
export function transcriptDenials(transcriptPath, since = '') {
  if (!transcriptPath) return [];
  let text = '';
  try {
    const size = fs.statSync(transcriptPath).size;
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return []; }
  const uses = new Map();
  let out = [];
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use') uses.set(c.id, { tool: c.name, input: c.input || {} });
      continue;
    }
    if (e.type !== 'user') continue;
    const results = Array.isArray(content) ? content.filter((c) => c?.type === 'tool_result') : [];
    if (!results.length) {
      if (!since && !e.isMeta) out = [];
      continue;
    }
    if (since && e.timestamp && e.timestamp < since) continue;
    for (const r of results) {
      const use = uses.get(r.tool_use_id);
      const msg = resultText(r);
      if (use && r.is_error && HARNESS_DENIAL.test(msg)) out.push({ ...use, key: callKey(use.tool, use.input), reason: msg.split('\n')[0].slice(0, 160) });
    }
  }
  return out;
}

/** The earlier denial this call reaches again by another way, or null. A denied write blocks only writes to the same path. */
export function bypassOf({ tool, toolInput = {}, cwd = process.cwd(), anchors = [], denials = [] }) {
  const key = callKey(tool, toolInput);
  const cur = analyze(tool, toolInput, cwd, anchors);
  if (!cur.paths.length) return null;
  for (const d of denials) {
    if (d.key === key) continue;
    const prev = d.paths ? { paths: d.paths, write: d.write } : analyze(d.tool, d.input, cwd, anchors);
    if (prev.write && !cur.write) continue;
    // A folder above the refused path counts only when it exists (git grep -- docs after docs/principles was refused).
    const hit = cur.paths.find((p) => prev.paths.some((q) => isInside(q, p) || (isInside(p, q) && fs.existsSync(p))));
    if (hit) return { denial: d, path: hit };
  }
  return null;
}

export function bypassReason(hit, cwd) {
  const rel = toPosix(path.relative(cwd, hit.path)) || '.';
  const why = String(hit.denial.reason || '').replace(/\s+/g, ' ').slice(0, 120);
  return `this call reaches ${rel}, which a ${hit.denial.tool} call refused earlier in this turn also reached (${why}); reaching it another way is a bypass (P-054): this target stays closed for the rest of this turn. Write the refused command and its message in the result, and do the work that does not need the target. A refusal by the operator or a harness permission is the operator's decision: when the work needs the target, ask whether to allow it with AskUserQuestion. A workflow hook refusal names its own way: use that way. When nothing else remains, end with Stav: hotovo and name the step that stayed undone (P-061)`;
}

/** Files that set what the workflow enforces (hooks, permissions, plugins): a change goes past the operator (P-054). */
export function guardConfigWrite(projectDir, absPaths) {
  const home = os.homedir();
  const files = new Set([
    path.join(projectDir || '', '.claude', 'settings.json'), path.join(projectDir || '', '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json'),
  ].map((p) => path.resolve(p)));
  const hit = absPaths.find((p) => files.has(path.resolve(p)));
  return hit ? `${toPosix(hit)} sets the hooks, permissions and plugins that enforce the workflow; a change there changes what is enforced, so the operator confirms it (P-054); project settings come from adapter.mjs` : null;
}

/** git run past its hooks (--no-verify, core.hooksPath): the brain pre-commit and repo hooks guard what gets committed. */
export function gitHookBypass(command) {
  const cmd = String(command || '');
  if (/\bgit\b[^;&|\n]*\b(commit|push|merge|am|rebase|cherry-pick)\b[^;&|\n]*\s--no-verify\b/.test(cmd)) return '--no-verify';
  if (/\bgit\b[^;&|\n]*(core\.hooksPath(=|[ \t]+[^\s;&|-])|--unset(-all)?[ \t]+core\.hooksPath)/.test(cmd)) return 'core.hooksPath';
  return null;
}
