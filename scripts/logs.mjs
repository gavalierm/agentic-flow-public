// Observation logs (P-030, P-028, P-005, P-006): per-turn buffer in <brain>/local/log-buffer/, one brain write per turn.
// Several machines on one brain (P-040): each machine only appends to its own logs/<machine>/<date>.log, so a sync never
// meets a log conflict (a flush that rewrote the shared logs/*.log lost lines of the other machine). A line is
// `<log> <entry>`; a removal is an appended `drop <log> <name|failure line>` (a failure comes back by `undrop failures <line>`). The combined view (old shared files
// first, then the day files in date order) is built on read and kept in <brain>/local/logs/<log>.log.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readText, today, nowIso, listFiles, git, PLUGIN_ROOT } from './util.mjs';
import { brainWrite } from './brain.mjs';
import { rejectedProposal } from './find.mjs';
import { machineName } from './config.mjs';

export const LOG_FILES = ['sequences.log', 'failures.log', 'procedures.log', 'derivations.log'];
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const kindOf = (logName) => String(logName).replace(/\.log$/, '');

/** This machine's day file (brain-relative). */
export function machineLogPath(date = today(), machine = machineName()) {
  return `logs/${machine}/${date}.log`;
}

/** Day files of every machine, in date order (machine name breaks ties). */
function dayFiles(brainDir) {
  const root = path.join(brainDir, 'logs');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const machine of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, machine)); } catch { continue; }
    for (const f of files) { const m = DAY_FILE.exec(f); if (m) out.push({ machine, date: m[1], file: path.join(root, machine, f), rel: `logs/${machine}/${f}` }); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.machine.localeCompare(b.machine));
}

/**
 * A drop is applied after all lines are read: the order of two machines' files of one day is unknown. A failure is
 * removed by its whole line (unique: time and session). A name (procedures, derivations, sequences, field 2) is removed
 * from the old shared file, from earlier lines of the dropping machine and from other machines' days before the drop;
 * a later repeat counts again.
 */
export function readLog(brainDir, logName, { rotationDays = null } = {}) {
  const kind = kindOf(logName);
  const days = dayFiles(brainDir);
  // Sources are stated before they are read: a line appended meanwhile changes the stat, so the next read rewrites the view.
  const sources = [path.join(brainDir, 'logs', logName), ...days.map((d) => d.file)].map(statSig);
  // Lines of the old shared file are plain strings (no machine): one object per line of a 100k-line file cost time (D-0034).
  const shared = fileLines(path.join(brainDir, 'logs', logName));
  const entries = [];
  const drops = [];
  const undrops = [];
  let seq = 0;
  // Prefix tests instead of slicing every line into head and rest (a kind has no space, so `head === kind` is a prefix).
  const own = `${kind} `;
  const drop = `drop ${kind} `;
  const undrop = `undrop ${kind} `;
  for (const d of days) {
    // An empty line has no space and is skipped either way, so the cached non-empty lines give the same entries.
    for (const raw of fileLines(d.file)) {
      if (raw.indexOf(' ') < 0) continue;
      seq += 1;
      if (raw.startsWith(own)) entries.push({ text: raw.slice(own.length), machine: d.machine, date: d.date, seq });
      else if (raw.startsWith(drop)) drops.push({ what: raw.slice(drop.length), machine: d.machine, date: d.date, seq });
      else if (raw.startsWith(undrop)) undrops.push(raw.slice(undrop.length));
    }
  }
  // A failure line is gone while its drops outnumber its undrops (error.mjs restore appends an undrop, append-only).
  // Drops are indexed by what they remove: checking every drop for every line made each turn end quadratic (1.5 s, D-0034).
  const byWhat = new Map();
  for (const x of drops) byWhat.set(x.what, [...(byWhat.get(x.what) || []), x]);
  const undropCount = new Map();
  for (const u of undrops) undropCount.set(u, (undropCount.get(u) || 0) + 1);
  const failureGone = (text) => (byWhat.get(text) || []).length > (undropCount.get(text) || 0);
  // A line of the old shared file is removed by any drop of its name (no machine, no order).
  const dropped = nameMatcher(byWhat.keys());
  const sharedGone = kind === 'failures' ? failureGone : (text) => dropped(text) !== undefined;
  const gone = (e) => (kind === 'failures'
    ? failureGone(e.text)
    : (byWhat.get(dropped(e.text)) || []).some((x) => (e.machine === x.machine ? e.seq < x.seq : e.date < x.date)));
  const filtering = drops.length || undrops.length;
  let lines = filtering ? shared.filter((t) => !sharedGone(t)) : shared.slice();
  for (const e of entries) if (!filtering || !gone(e)) lines.push(e.text);
  if (rotationDays) lines = rotateLines(lines, rotationDays);
  writeView(brainDir, logName, lines, JSON.stringify({ sources, rotationDays, n: lines.length }));
  return lines;
}

/** Field `i` of a space-separated line, as `line.split(' ')[i]` (undefined past the end), without splitting the whole line. */
export function field(line, i) {
  let start = 0;
  for (let k = 0; k < i; k++) {
    const sp = line.indexOf(' ', start);
    if (sp < 0) return undefined;
    start = sp + 1;
  }
  const end = line.indexOf(' ', start);
  return end < 0 ? line.slice(start) : line.slice(start, end);
}

/**
 * Which of `names` is field 1 of a line (`field(line, 1)`, undefined when none), without slicing the line: a name is
 * compared in place only when its length is the field's length. Empty names never match (an empty field is no name).
 */
export function nameMatcher(names) {
  const byLen = new Map();
  for (const n of names) {
    if (typeof n !== 'string' || !n) continue;
    if (!byLen.has(n.length)) byLen.set(n.length, []);
    byLen.get(n.length).push(n);
  }
  return (line) => {
    const a = line.indexOf(' ');
    if (a < 0 || !byLen.size) return undefined;
    const b = line.indexOf(' ', a + 1);
    const candidates = byLen.get((b < 0 ? line.length : b) - a - 1);
    if (candidates) for (const n of candidates) if (line.startsWith(n, a + 1)) return n;
    return undefined;
  };
}

function statSig(file) {
  try { const s = fs.statSync(file); return [path.basename(path.dirname(file)), path.basename(file), s.size, s.mtimeMs]; } catch { return null; }
}

// Non-empty lines of a log file, kept for the process while the file's size and mtime stay: one turn end reads the day
// files for sequences and failures and the old shared file for readLog and rotationOps (one read per flush, D-0034).
// Callers get the array read-only (they filter or copy it).
const linesCache = new Map();
function fileLines(file) {
  const sig = JSON.stringify(statSig(file));
  const hit = linesCache.get(file);
  if (hit && hit.sig === sig) return hit.lines;
  const lines = readText(file, '').split('\n').filter(Boolean);
  linesCache.set(file, { sig, lines });
  return lines;
}

/**
 * The combined view in local/logs/ is rewritten only when its result can differ: the sources (size, mtime), the rotation
 * or the line count changed (rotation only removes lines as time goes on, so the same sources and count give the same
 * lines), or the view was changed or removed. Writing 10 MB at every read cost every turn end (D-0034).
 */
function writeView(brainDir, logName, lines, sig) {
  try {
    const view = path.join(brainDir, 'local', 'logs', logName);
    const sigFile = `${view}.sig`;
    const viewSig = () => JSON.stringify(statSig(view));
    const stored = readText(sigFile, '');
    if (stored === `${sig}\n${viewSig()}\n`) return;
    fs.mkdirSync(path.dirname(view), { recursive: true });
    fs.writeFileSync(view, lines.length ? lines.join('\n') + '\n' : '');
    fs.writeFileSync(sigFile, `${sig}\n${viewSig()}\n`);
  } catch { /* the view is a convenience */ }
}

/** Append op for this machine's day file (entries of one log). */
export function appendOp(logName, entries, { date = today() } = {}) {
  const kind = kindOf(logName);
  return { path: machineLogPath(date), append: entries.map((e) => `${kind} ${e}\n`).join('') };
}

/** Removal by appending: names (procedures, derivations, sequences) or whole failure lines. */
export function dropOp(logName, whats) {
  const kind = kindOf(logName);
  return { path: machineLogPath(), append: whats.map((w) => `drop ${kind} ${w}\n`).join('') };
}

/**
 * Deletion on an explicit operator order (log.mjs remove): every line containing `match` leaves every machine's day file
 * and the old shared logs, physically (a drop line would keep the text). An emptied file is removed.
 */
export function removeLinesOps(brainDir, match) {
  const files = [...LOG_FILES.map((f) => ({ file: path.join(brainDir, 'logs', f), rel: `logs/${f}` })), ...dayFiles(brainDir)];
  const ops = [];
  let removed = 0;
  for (const { file, rel } of files) {
    if (!fs.existsSync(file)) continue;
    const lines = readText(file, '').split('\n').filter(Boolean);
    const kept = lines.filter((l) => !l.includes(match));
    if (kept.length === lines.length) continue;
    removed += lines.length - kept.length;
    ops.push(kept.length ? { path: rel, content: kept.join('\n') + '\n' } : { path: rel, remove: true });
  }
  return { ops, removed };
}

/** Old shared logs that are read through the rotation window (frozen since the day files; trimmed by rotation). */
export const ROTATED_SHARED_LOGS = ['sequences.log'];

/**
 * Rotation: this machine removes only its own day files past the window (other machines rotate theirs). The old shared
 * sequences.log only loses lines: lines of days before the window leave it, an emptied file is removed (D-0034; it was
 * read in full at every turn end). The cut is by whole days, so machines trimming on the same day write the same file;
 * a conflict between two days' trims keeps the lines of both (brain.mjs resolveConflict).
 */
export function rotationOps(brainDir, days, machine = machineName()) {
  if (!days) return [];
  const cutoff = Date.now() - days * 864e5;
  const ops = dayFiles(brainDir).filter((d) => d.machine === machine && Date.parse(d.date) < cutoff).map((d) => ({ path: d.rel, remove: true }));
  const cutDay = new Date(cutoff).toISOString().slice(0, 10);
  for (const name of ROTATED_SHARED_LOGS) {
    const lines = fileLines(path.join(brainDir, 'logs', name));
    const kept = lines.filter(byHead((head) => !/^\d{4}-\d{2}-\d{2}$/.test(head) || head >= cutDay));
    if (kept.length === lines.length) continue;
    ops.push(kept.length ? { path: `logs/${name}`, content: kept.join('\n') + '\n' } : { path: `logs/${name}`, remove: true });
  }
  return ops;
}

export function bufferFile(brainDir, sessionId) {
  return path.join(brainDir, 'local', 'log-buffer', `${sessionId || 'unknown'}.jsonl`);
}

export function bufferAppend(brainDir, sessionId, entry) {
  const file = bufferFile(brainDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ t: nowIso(), ...entry }) + '\n');
}

export function readBuffer(brainDir, sessionId) {
  return readText(bufferFile(brainDir, sessionId), '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const INTERPRETERS = ['node', 'python', 'python3', 'bash', 'sh'];

/** Script of the installed workflow plugin (any install path or the hook placeholder). */
export function isWorkflowScript(p) {
  const norm = String(p).replace(/\\/g, '/');
  const root = String(PLUGIN_ROOT).replace(/\\/g, '/');
  return norm.startsWith(root + '/') || norm.includes('${CLAUDE_PLUGIN_ROOT}') || /\/\.claude\/skills\/workflow\//.test(norm);
}

/** Split a shell command line into simple commands and normalize to "program [subcommand]". */
export function normalizeCommand(command, policy) {
  const programs = policy?.logs?.subcommand_programs || [];
  const out = [];
  // Heredoc bodies and quoted text are data, not commands: a commit message or a python script would otherwise split
  // into fake programs (alice 2026-11-03: `the` from a commit body counted as a command of a sequence).
  const masked = String(command)
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0])
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q');
  for (const part of masked.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const assigned = /^[A-Za-z_][A-Za-z0-9_]*=\$\((.+)$/.exec(words[0] || '');
    if (assigned) words[0] = assigned[1]; // out=$(npm test ...): the program is npm
    // groups and subshells are syntax, not programs (`|| { echo x; exit 1; }` made a sequence of `{+exit+}`)
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || /^[{}()!]+$/.test(words[0]))) words.shift();
    if (words.length) words[0] = words[0].replace(/^[({]+/, '');
    // Shell keywords are syntax: the body after do/then/else and the condition after if/while/until are the commands;
    // a for/case/select header has none (Bob 2026-11-03: `for+echo` was proposed as a skill).
    while (['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'].includes(words[0])) words.shift();
    if (['for', 'case', 'select', 'esac', 'in'].includes(words[0])) continue;
    if (['}', 'exit', 'fi', 'done', 'true', 'false', 'break', 'continue', 'return'].includes(words[0])) continue;
    if (!words.length) continue;
    let prog = words[0].split('/').pop();
    if (['sudo', 'time', 'env'].includes(prog) && words[1]) { words.shift(); prog = words[0].split('/').pop(); }
    // Interpreter + script: the script is the procedure (`node bin/<script>.mjs` -> `node <script>.mjs`). Scripts of the workflow
    // itself are already procedures with a skill and never count toward a skill proposal (P-005, pilot 2026-11-01).
    if (INTERPRETERS.includes(prog) && words[1] && /\.(m?js|cjs|py|sh)$/.test(words[1])) {
      if (isWorkflowScript(words[1])) continue;
      out.push(`${prog} ${words[1].split('/').pop()}`);
      continue;
    }
    // sed without in-place editing only reads (`sed -n 10,20p`): it is reading code, not a procedure step.
    if (prog === 'sed' && !words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) { out.push('sed -n'); continue; }
    let sub = null;
    if (programs.includes(prog)) {
      const cand = words.slice(1).find((w) => !w.startsWith('-'));
      if (cand && /^[a-z][a-z0-9:-]*$/.test(cand)) sub = cand;
    }
    out.push(sub ? `${prog} ${sub}` : prog);
  }
  return out;
}

export function isReadonly(normalized, policy) {
  const list = policy?.logs?.readonly_commands || [];
  return list.includes(normalized) || list.includes(normalized.split(' ')[0]);
}

export function sequencesFrom(commands, { min = 2, max = 5 } = {}) {
  const seqs = [];
  for (let len = min; len <= max; len++) {
    for (let i = 0; i + len <= commands.length; i++) {
      seqs.push(commands.slice(i, i + len).map((c) => c.replace(/\s+/g, '-')).join('+'));
    }
  }
  return seqs;
}

export function rotateLines(lines, days) {
  const cutoff = Date.now() - days * 864e5;
  // Date.parse once per distinct 10-character head (a log has a few dozen days): per line it cost ~45 ms (D-0034).
  return lines.filter(byHead((head) => {
    const d = Date.parse(head);
    return Number.isNaN(d) || d >= cutoff;
  }));
}

/**
 * A line test that depends only on the line's first 10 characters, computed once per distinct head: a run of lines of
 * one day repeats the previous head, recognised by a prefix test without slicing the line.
 */
function byHead(test) {
  const memo = new Map();
  let prev = null;
  let prevKeep = false;
  return (l) => {
    if (prev !== null && l.startsWith(prev)) return prevKeep;
    const head = l.slice(0, 10);
    let k = memo.get(head);
    if (k === undefined) { k = test(head); memo.set(head, k); }
    prev = head.length === 10 ? head : null;
    prevKeep = k;
    return k;
  };
}

export function countByField(lines, index = 1) {
  const counts = new Map();
  for (const l of lines) {
    const f = field(l, index);
    if (f) counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

/** Distinct sessions per sequence name (3rd field of a sequences.log line): repeats inside one session are one routine. */
export function sessionsByName(lines, { only = null, into = new Map() } = {}) {
  const m = into;
  const match = only ? nameMatcher(only) : null;
  for (const l of lines) {
    const name = match ? match(l) : field(l, 1);
    if (!name) continue;
    const sid = field(l, 2);
    if (!m.has(name)) m.set(name, new Set());
    m.get(name).add(sid || '-');
  }
  return m;
}

/** Sequences that reach `threshold` sessions with this flush, without those contained in a longer one reaching it now (P-030). */
export function newProposals(before, after, names, threshold) {
  const reached = [...new Set(names)].filter((s) => (after.get(s)?.size || 0) >= threshold && (before.get(s)?.size || 0) < threshold);
  const steps = (s) => ` ${s.split('+').join(' ')} `;
  return reached.filter((s) => !reached.some((o) => o.length > s.length && steps(o).includes(steps(s))));
}

/** Key of a P-030 proposal signal (`sequence <name> <n>x: create ...` -> `sequence <name>`), null for other signals. */
export function proposalKey(signal) {
  const m = /^sequence (\S+) \d+x: /.exec(String(signal || ''));
  return m ? `sequence ${m[1]}` : null;
}

/** Turn the per-session buffer into log lines; returns ops for brainWrite and signals. */
export function flushBuffer(ctx, sessionId, { sync = true } = {}) {
  const { brainDir, policy } = ctx;
  const entries = readBuffer(brainDir, sessionId);
  const signals = [];
  if (!entries.length) return { written: false, signals };
  const seqLines = readLog(brainDir, 'sequences.log', { rotationDays: policy.logs.rotation_days });
  const failLines = readLog(brainDir, 'failures.log');
  const newFails = [];

  // Sequences: consecutive successful shell commands per agent; a failure breaks the run.
  const runs = new Map();
  const newSeqs = [];
  const push = (agent) => {
    const run = runs.get(agent) || [];
    if (run.length >= policy.logs.sequence_min_length) newSeqs.push(...sequencesFrom(run, { min: policy.logs.sequence_min_length, max: policy.logs.sequence_max_length }));
    runs.set(agent, []);
  };
  for (const e of entries) {
    const agent = e.agent || 'main';
    if (e.kind === 'cmd') {
      const run = runs.get(agent) || [];
      for (const c of e.commands || []) if (!isReadonly(c, policy)) run.push(c);
      runs.set(agent, run);
    } else if (e.kind === 'fail') {
      push(agent);
      newFails.push(`${e.t} ${agent} ${sessionId} ${(e.command || e.tool || '?').replace(/\s+/g, ' ').slice(0, 120)} :: ${(e.error || '').split('\n')[0].slice(0, 160)}`);
    }
  }
  for (const agent of runs.keys()) push(agent);
  const date = today();
  const seqEntries = newSeqs.map((q) => `${date} ${q} ${sessionId}`);
  failLines.push(...newFails);
  // Sessions are counted only for this flush's names (the log holds ~70k names, a Set for each cost ~120 ms per pass,
  // D-0034); `after` adds this flush's lines to a copy of `before`.
  const only = new Set(newSeqs);
  const before = sessionsByName(seqLines, { only });
  const after = sessionsByName(seqEntries, { only, into: new Map([...before].map(([k, v]) => [k, new Set(v)])) });
  seqLines.push(...seqEntries);
  const threshold = policy.thresholds.sequence_repeats;
  for (const s of newProposals(before, after, newSeqs, threshold)) {
    if (!rejectedProposal(brainDir, s)) {
      signals.push(`sequence ${s} ${after.get(s).size}x: create a skill with a script or refactor the existing skill around the script yourself, no operator approval (P-030)`);
    }
  }
  const oldFailures = failLines.filter((l) => {
    const d = Date.parse(l.slice(0, 10));
    return !Number.isNaN(d) && Date.now() - d > policy.logs.failure_signal_days * 864e5;
  });
  if (oldFailures.length) signals.push(`failures.log: ${oldFailures.length} unprocessed failure(s) older than ${policy.logs.failure_signal_days} days; run error skill (P-030)`);

  const ops = [appendOp('sequences.log', seqEntries), appendOp('failures.log', newFails)].filter((o) => o.append);
  ops.push(...rotationOps(brainDir, policy.logs.rotation_days));
  const res = ops.length ? brainWrite(ctx, { ops, internal: true, sync, message: `logs flush ${sessionId}` }) : { committed: false, unpushed: 0 };
  fs.rmSync(bufferFile(brainDir, sessionId), { force: true });
  return { written: res.committed, signals, unpushed: res.unpushed, sequences: newSeqs.length, failures: entries.filter((e) => e.kind === 'fail').length };
}

/** procedures.log / derivations.log (P-005, P-006): append names, rotate, report repeats. */
export function recordNames(ctx, logName, names, { thread }) {
  const { brainDir, policy } = ctx;
  const lines = readLog(brainDir, logName, { rotationDays: policy.logs.rotation_days });
  const date = today();
  const entries = names.map((n) => `${date} ${n} ${thread || '-'}`);
  lines.push(...entries);
  const counts = countByField(lines);
  return { op: appendOp(logName, entries), counts, lines };
}

export function existingNames(brainDir, logName) {
  const lines = readLog(brainDir, logName);
  return [...countByField(lines).entries()].map(([name, n]) => ({ name, count: n }));
}

export function removeNames(brainDir, logName, names) {
  return dropOp(logName, names);
}

export function listFailures(brainDir) {
  return readLog(brainDir, 'failures.log');
}

/** Stable id of a failure line (its text is unique: time and session); a list number shifts after every resolve. */
export const failureId = (line) => `f${crypto.createHash('sha1').update(line).digest('hex').slice(0, 7)}`;

/** Listed failures with their stable ids, as `n. <id> <line>`. */
export function formatFailures(lines) {
  return lines.map((l, i) => `${i + 1}. ${failureId(l)} ${l}`).join('\n');
}

/**
 * Failures with the given ids processed: one appended drop per line. A bare number is refused: numbers from one
 * listing shift after each resolve and a series of them removed another session's failure (2026-11-13).
 */
export function resolveFailuresOp(brainDir, ids) {
  const want = [...new Set((ids || []).map(String))];
  if (!want.length) throw new Error('usage: resolve <id> [<id> ...] (the id from error.mjs list)');
  const numbers = want.filter((k) => /^\d+$/.test(k));
  if (numbers.length) throw new Error(`resolve takes the failure id from error.mjs list, not its number (${numbers.join(', ')}): numbers shift after each resolve`);
  const lines = listFailures(brainDir);
  const byId = new Map(lines.map((l) => [failureId(l), l]));
  const missing = want.filter((k) => !byId.has(k));
  if (missing.length) throw new Error(`no unprocessed failure with id ${missing.join(', ')}; nothing resolved`);
  return { op: dropOp('failures.log', want.map((k) => byId.get(k))), ids: want, remaining: lines.length - want.length };
}

/**
 * Failures dropped by a brain commit come back: one appended undrop per dropped line that is not listed now
 * (a wrong resolve is undone through the workflow, not by editing the brain, P-013).
 */
export function restoreFailuresOp(brainDir, commit) {
  if (!commit || commit === true) throw new Error('usage: restore <brain commit that dropped the failure>');
  const r = git(['show', '--format=', '--no-color', '-U0', String(commit), '--', 'logs'], { cwd: brainDir });
  if (!r.ok) throw new Error(`git show ${commit}: ${(r.stderr || r.stdout || '').trim()}`);
  const dropped = r.stdout.split('\n').filter((l) => l.startsWith('+drop failures ')).map((l) => l.slice('+drop failures '.length));
  if (!dropped.length) throw new Error(`commit ${commit} dropped no failure`);
  const listed = new Set(listFailures(brainDir));
  const lines = [...new Set(dropped)].filter((l) => !listed.has(l));
  if (!lines.length) throw new Error(`the failure(s) dropped by ${commit} are listed already; nothing restored`);
  return { op: { path: machineLogPath(), append: lines.map((l) => `undrop failures ${l}\n`).join('') }, lines };
}

export function pendingBuffers(brainDir) {
  return listFiles(path.join(brainDir, 'local', 'log-buffer'), (f) => f.endsWith('.jsonl'));
}
