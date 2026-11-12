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
// flow-public#47: the text of a workflow hook refusal in the transcript (a harness without `permissionDecision.source`).
export const HOOK_REFUSAL = /^\s*[A-Za-z]+:\S+ hook (error|denied)/;
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
const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const STRING_RUNNERS = new Set(['ssh', 'su', 'eval', 'watch']);
// Programs that run the next program: `sudo git commit -m "x"` runs git, `timeout 5 bash -c "x"` runs a shell.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'setsid', 'stdbuf', 'command', 'exec', 'xargs', 'flock', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
// Wrapper options that take a separate value: `sudo -u root bash -c "x"` still runs a shell.
const WRAPPER_VALUED = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'], doas: ['-u', '-C'], env: ['-u', '-C', '-S'],
  timeout: ['-s', '-k'], nice: ['-n'], ionice: ['-c', '-n', '-p'], stdbuf: ['-i', '-o', '-e'], flock: ['-w', '-E'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-l'],
};
/**
 * Does this command (its words, quoted arguments as placeholders) hand its quoted text or heredoc body to a shell?
 * True for a shell with -c or reading stdin (`bash -c "x"`, `bash - <<EOF`), for ssh/su/eval/watch, also behind wrappers
 * (`sudo bash <<EOF`, `timeout 5 sh -c "x"`, `FOO=1 bash <<EOF`, `then bash -c "x"`). False for a shell that runs a script file
 * (`sh run.sh -m "x"`), for `sudo tee f <<EOF`, `env A=1 git commit -m "x"`, `xargs echo "x"`: their text is data (alice 2026-11-12:
 * `sh prove-commit.sh … -m "…chmod -R … sudo …"` asked the operator).
 */
export function runsText(words) {
  const w = words.map((x) => x.replace(/^\(+/, '')).filter((x) => x && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
  let wrapper = null;
  for (let i = 0; i < w.length; i++) {
    const prog = w[i].split('/').pop();
    if (wrapper && WRAPPER_VALUED[wrapper]?.includes(w[i])) { i++; continue; }
    if (WRAPPERS.has(prog)) wrapper = prog;
    if (STRING_RUNNERS.has(prog)) return true;
    if (SHELL_BINS.has(prog)) {
      for (let j = i + 1; j < w.length; j++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w[j])) return true;
        if (/^\d*[<>]/.test(w[j])) { if (/^\d*[<>]+&?$/.test(w[j])) j++; continue; }
        if (w[j].startsWith('-') && w[j] !== '--') continue;
        return false;
      }
      return true;
    }
    if (!WRAPPERS.has(prog) && !(i > 0 && (w[i].startsWith('-') || /^\d+(\.\d+)?[smhd]?$|^\{\}$/.test(w[i])))) return false;
  }
  return false;
}
/**
 * Heredoc bodies removed (the command line with `<<DELIM` stays); the one implementation every heredoc removal uses
 * (maskShell, withoutDataHeredocs, readParts, foregroundWait). The delimiter is any shell word, not only an identifier:
 * `<<'END-OF-BRIEF'`, `<<'.'`, `<<\EOF`, `<<"EOF 2"`. `<<<` is a here-string, not a heredoc. An unterminated heredoc keeps
 * its text (the shell would fail on it). `keep(head, line)` (head = text before `<<` on its line, line = from `<<` to the
 * end of the line) returns true for a body that stays, e.g. one given to a shell.
 */
export function stripHeredocs(command, keep = null) {
  command = String(command);
  let out = '';
  let pos = 0;
  for (const d of heredocs(command)) {
    if (keep && keep(d.head, d.line)) continue;
    out += command.slice(pos, d.bodyStart - 1);
    pos = d.endAt;
  }
  return out + command.slice(pos);
}
/** The terminated heredocs of a command: head (text before `<<` on its line), line (`<<` to the end of the line), body bounds. */
function heredocs(command) {
  const re = /(?<!<)<<(?!<)-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([^\s'"<>|;&()\\]+))[^\n]*\n/g;
  const found = [];
  let m;
  while ((m = re.exec(command))) {
    const delim = m[1] ?? m[2] ?? m[3];
    const bodyStart = m.index + m[0].length;
    let off = 0;
    let endAt = -1;
    for (const line of command.slice(bodyStart).split('\n')) {
      if (line.trim() === delim) { endAt = bodyStart + off + line.length; break; }
      off += line.length + 1;
    }
    if (endAt < 0) continue;
    found.push({ head: command.slice(command.lastIndexOf('\n', m.index - 1) + 1, m.index), line: m[0].slice(0, -1), bodyStart, bodyEnd: bodyStart + off, endAt });
    re.lastIndex = endAt;
  }
  return found;
}
/**
 * Shell text the command runs on this machine: the quoted arguments of `bash -c`, `sudo sh -c`, `eval`, `su -c` and heredoc
 * bodies given to a shell. The write checks read it like the command itself (alice 2026-11-12: `bash -c 'echo x > /etc/x'`
 * and `bash <<EOF` with a redirect into /etc were no write). Not ssh: its text runs on another host.
 */
export function innerShellTexts(command) {
  const cmd = String(command);
  const remote = (words) => words.some((w) => w.split('/').pop() === 'ssh');
  const texts = [];
  for (const d of heredocs(cmd)) {
    const words = d.head.split(/&&|\|\||;|\|/).pop().trim().split(/\s+/).filter(Boolean);
    if (heredocRuns(d.head, d.line) && !remote(words) && !/\|\s*ssh\b/.test(d.line)) texts.push(cmd.slice(d.bodyStart, d.bodyEnd));
  }
  const quoted = [];
  const held = stripHeredocs(cmd).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => `\u0006${quoted.push(q) - 1}\u0006`);
  for (const seg of held.split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!runsText(words) || remote(words)) continue;
    for (const m of seg.matchAll(/\u0006(\d+)\u0006/g)) {
      const q = quoted[m[1]];
      texts.push(q[0] === "'" ? q.slice(1, -1) : q.slice(1, -1).replace(/\\(["\\$`])/g, '$1'));
    }
  }
  return texts;
}
/** Does the heredoc whose line is `head<<…` get a shell (or a command with -c, ssh, eval: runsText) or is it piped into one? */
export function heredocRuns(head, line) {
  const words = head.split(/&&|\|\||;|\|/).pop().trim().split(/\s+/).filter(Boolean);
  return runsText(words) || /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(line.replace(/^<<-?[ \t]*(?:'[^'\n]+'|"[^"\n]+"|\\?[^\s'"<>|;&()\\]+)/, ''));
}
export function withoutDataHeredocs(command) {
  return stripHeredocs(command, heredocRuns);
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

/** The last TRANSCRIPT_TAIL bytes of the session transcript, or null. */
function transcriptTail(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const size = fs.statSync(transcriptPath).size;
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return null; }
}

/** Waits until the session transcript holds the tool call `toolUseId`, at most `timeoutMs` (P-061, flow-public#32 pilot: the
 * harness appended the turn text and the dialog call 20 ms after PreToolUse had read the transcript, so the plan was not seen).
 * Entries are appended in order, so the text written before the call is there too. Returns whether the call was seen. */
export function awaitTranscriptToolUse(transcriptPath, toolUseId, timeoutMs = 2000) {
  if (!transcriptPath || !toolUseId) return false;
  const needle = JSON.stringify(String(toolUseId));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  for (;;) {
    if (transcriptTail(transcriptPath)?.includes(needle)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    Atomics.wait(pause, 0, 0, 50);
  }
}

/** The text the main agent wrote in this turn so far (P-061, flow-public#32: an open dialog covers it). Without a turn start the last operator prompt bounds it. */
export function transcriptTurnText(transcriptPath, since = '') {
  const text = transcriptTail(transcriptPath);
  if (!text) return '';
  let parts = [];
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e.type === 'user' && !e.isMeta && !(Array.isArray(content) && content.some((c) => c?.type === 'tool_result'))) {
      if (!since) parts = [];
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain || !Array.isArray(content)) continue;
    if (since && e.timestamp && e.timestamp < since) continue;
    for (const c of content) if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

/** Harness permission refusals of this turn, read from the session transcript. Without a turn start the last operator prompt bounds it. */
export function transcriptDenials(transcriptPath, since = '') {
  const text = transcriptTail(transcriptPath);
  if (!text) return [];
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
    // A permission rule of the settings (`permissionDecision.source` config) is no operator decision: it reads a `sed -n`
    // or a `cp` source as a write and resolves relative paths from the session folder, so it locks like a workflow hook
    // refusal, not like the operator in the dialog (11 of 14 locks were false, audit M2 2026-11-11).
    // flow-public#47: a workflow hook refusal is in the thread state (withDenial) with its own lock. Its text quotes the earlier
    // refusal ("… has been denied"), so read as a refusal of the operator it locked every path of the refused call again,
    // reads too: one refused bypass closed the folder of a deployed skill for the rest of the turn.
    if (e.permissionDecision?.source === 'hook') continue;
    const rule = e.permissionDecision?.source === 'config';
    for (const r of results) {
      const use = uses.get(r.tool_use_id);
      const msg = resultText(r);
      if (use && r.is_error && HARNESS_DENIAL.test(msg) && !HOOK_REFUSAL.test(msg)) out.push({ ...use, key: callKey(use.tool, use.input), reason: msg.split('\n')[0].slice(0, 160), harness: !rule, rule, at: e.timestamp || '' });
    }
  }
  return out;
}

/**
 * The earlier denial this call reaches again by another way, or null. After a workflow hook refusal only a write after
 * a refused write to the same path locks: a read finds the cause, and a refused read locked every later read of the
 * folder, so one false positive of a heuristic check stopped the turn (operator 2026-11-08, hooks review). A harness
 * refusal by the operator also locks reads after a refused read; a permission rule of the settings locks like a hook.
 * `own(path)` marks the thread's own work files (scratch/): a refusal elsewhere never closes them (5 of 13 locks wrote
 * into the project's scratch/, audit M2 2026-11-11).
 */
export function bypassOf({ tool, toolInput = {}, cwd = process.cwd(), anchors = [], denials = [], own = () => false }) {
  const key = callKey(tool, toolInput);
  const found = analyze(tool, toolInput, cwd, anchors);
  const cur = { ...found, paths: found.paths.filter((p) => !own(p)) };
  if (!cur.paths.length) return null;
  for (const d of denials) {
    if (d.key === key) continue;
    const prev = d.paths ? { paths: d.paths, write: d.write } : analyze(d.tool, d.input, cwd, anchors);
    // A refusal by the operator in the dialog is the operator's decision: it locks reads too.
    if (d.harness ? prev.write && !cur.write : !prev.write || !cur.write) continue;
    // A folder above the refused path counts only when it exists (git grep -- docs after docs/principles was refused).
    const hit = cur.paths.find((p) => prev.paths.some((q) => isInside(q, p) || (isInside(p, q) && fs.existsSync(p))));
    if (hit) return { denial: d, path: hit };
  }
  return null;
}

// flow-public#46: an answer that keeps the target closed (the operator refused in the dialog).
export const REFUSING_ANSWER = /^\s*(nie\b|no\b|ne\b|neschv|zamiet|nepovo|nechaj|ponechaj|zru[sš]|stop\b|deny|don'?t|reject|cancel)/i;

/** flow-public#46: the operator's answers in dialogs of this turn (question and answer), kept by PostToolUse. */
export function turnLifts(state = {}) {
  const since = state.turn_started_at || '';
  return (Array.isArray(state.dialog_lifts) ? state.dialog_lifts : []).filter((l) => l && typeof l.text === 'string' && (!since || l.at >= since));
}

/** flow-public#46: keeps an answer of the operator that does not refuse; a later call may then reach the targets it names. */
export function withLift(state, question, answer, at = new Date().toISOString()) {
  const a = String(answer || '').trim();
  if (!a || REFUSING_ANSWER.test(a)) return state;
  return { ...state, dialog_lifts: [...turnLifts(state), { at, text: `${question}\n${a}` }].slice(-10) };
}

/** Whether the text names the path: absolute, relative to cwd or by its file name, as a whole word. */
function namesPath(text, p, cwd) {
  const names = [toPosix(p), toPosix(path.relative(cwd, p)), path.basename(p)].filter((n) => n && n.length >= 3 && n !== '..');
  return names.some((n) => new RegExp('(^|[^\\w.-])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w-])').test(toPosix(text)));
}

/**
 * flow-public#46: the lock text tells the agent to ask the operator in a dialog when the work needs the target, but the
 * answer opened nothing until the next prompt. An answer given after a refusal whose question or answer names a refused
 * path, and that does not refuse, opens that path for the rest of the turn; the other paths of the refusal stay closed.
 */
export function openByAnswers(denials, lifts, cwd, anchors = []) {
  if (!lifts.length) return denials;
  return denials.flatMap((d) => {
    const after = lifts.filter((l) => l.at >= (d.at || ''));
    if (!after.length) return [d];
    const prev = d.paths ? { paths: d.paths, write: d.write } : analyze(d.tool, d.input || {}, cwd, anchors);
    const paths = prev.paths.filter((p) => !after.some((l) => namesPath(l.text, p, cwd)));
    if (paths.length === prev.paths.length) return [d];
    return paths.length ? [{ ...d, paths, write: prev.write }] : [];
  });
}

/** flow-public#46: the targets the refusals of this turn keep closed, relative to cwd (the context after a compaction lists them). */
export function closedTargets(denials, cwd, anchors = [], own = () => false) {
  const out = new Set();
  for (const d of denials) {
    const prev = d.paths ? { paths: d.paths, write: d.write } : analyze(d.tool, d.input || {}, cwd, anchors);
    if (!d.harness && !prev.write) continue;
    for (const p of prev.paths) if (!own(p)) out.add(toPosix(path.relative(cwd, p)) || '.');
  }
  return [...out];
}

export function bypassReason(hit, cwd) {
  const rel = toPosix(path.relative(cwd, hit.path)) || '.';
  const why = String(hit.denial.reason || '').replace(/\s+/g, ' ').slice(0, 120);
  return `this call reaches ${rel}, which a ${hit.denial.tool} call refused earlier in this turn also reached (${why}); reaching it another way is a bypass (P-054): this target stays closed for the rest of this turn. Write the refused command and its message in the result, and do the work that does not need the target. A refusal by the operator in the dialog is the operator's decision: when the work needs the target, ask whether to allow it with AskUserQuestion, naming the target in the question: an answer that allows it opens the target for the rest of this turn (flow-public#46). A workflow hook refusal names its own way: use that way; a permission rule of the settings refused a write: write a work file in scratch/ or use the way the workflow names (save.mjs). The lock ends with this turn: when the work still needs the target, save the step with save handover --next, arm a waker (<plugin>/bin/timer.mjs --in 1m --then "<step>") and end with Stav: čakám (na nový ťah: <step>); the new turn has the target open. Not Stav: hotovo with an undone step and not "napíš pokračuj": the operator is no waker (P-061, P-026)`;
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
  // A repo-relative path (`git config core.hooksPath .githooks`) turns the repo's own hooks ON; /dev/null, an absolute path,
  // `..` or --unset turn them off (alice 2026-11-02/03: `git config core.hooksPath .githooks` asked the operator).
  const set = /\bgit\b[^;&|\n]*core\.hooksPath(?:=|[ \t]+)([^\s;&|-][^\s;&|]*)/.exec(cmd);
  if (set && !/^(?!\.\.?(\/|$))(?!.*\/\.\.(\/|$))[\w.][\w.\/-]*$/.test(set[1].replace(/^['"]|['"]$/g, ''))) return 'core.hooksPath';
  if (/\bgit\b[^;&|\n]*--unset(-all)?[ \t]+core\.hooksPath/.test(cmd)) return 'core.hooksPath';
  return null;
}
