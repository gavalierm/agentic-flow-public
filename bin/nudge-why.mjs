#!/usr/bin/env node
// Why the operator had to wake this thread (operator nudge, operator 2026-11-14): facts of the records, read only.
//   nudge-why.mjs [--thread <id>] [--transcript <session.jsonl>] [--since 12h]
//                 [--brain <dir>] [--comms-dir <instance data dir>] [--wake-log <file>] [--now <iso>]
// Sources: the thread state (<brain>/local/threads), the mail's turn record and wake-state (<comms data dir>), the wake
// module's log (journal of wake-<instance> or agentic-wake-<instance>, or --wake-log), waiting mail (comms count) and the
// session transcript (--transcript, else the newest transcript of the project naming the thread). No T3 tool, no write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, fail, readJson } from '../scripts/util.mjs';
import { loadContext, readThreadState } from '../scripts/config.mjs';
import { mailCount, mailProjectName } from '../scripts/comms.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { wakeFile } from '../scripts/wake-job.mjs';
import { parseDelay } from '../scripts/waker.mjs';
import { diagnose, format, readTranscript } from '../scripts/nudge-why.mjs';

const args = parseArgs(process.argv.slice(2));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The newest transcript of the project dir (Claude Code: ~/.claude/projects/<dir with / as ->) that names the thread. */
// The project dir under each spelling (a symlinked path and its real one name different transcript folders): the newest
// transcript of them all wins (pilot 2026-11-14: an old transcript of the lowercase path was taken first).
function findTranscript(projectDirs, thread, sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  // The session of the thread (state t3_cursor, written at session start): its transcript under any project folder.
  if (sessionId && /^[\w-]+$/.test(sessionId)) {
    try {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${sessionId}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    } catch { /* no transcripts folder */ }
  }
  const dirs = new Set();
  for (const d of projectDirs.filter(Boolean)) {
    dirs.add(d);
    try { dirs.add(fs.realpathSync(d)); } catch { /* as given */ }
  }
  let files = [];
  for (const d of dirs) {
    const base = path.join(root, d.replace(/[^A-Za-z0-9]/g, '-'));
    try { files.push(...fs.readdirSync(base).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(base, f)).map((f) => ({ f, m: fs.statSync(f).mtimeMs }))); } catch { /* none there */ }
  }
  files = files.sort((a, b) => b.m - a.m).slice(0, 20);
  for (const { f } of files) {
    try { if (fs.readFileSync(f, 'utf8').includes(`thread ${thread}`)) return f; } catch { /* next */ }
  }
  return null;
}

/** The wake module's log since `since`: the journal of its unit (system or user), '' when none can be read. */
function wakeLog(instance, since) {
  const sinceArg = new Date(since).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  for (const unit of [['-u', `wake-${instance}`], ['--user', '-u', `agentic-wake-${instance}`]]) {
    const r = spawnSync('journalctl', [...unit, '--since', sinceArg, '-o', 'cat', '--no-pager', '-q'], { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout;
  }
  return '';
}

try {
  const ctx = loadContext({ project: args.project, requireBrain: !str(args.brain) });
  const brainDir = str(args.brain) || ctx.brainDir;
  const thread = str(args.thread) || ctx.thread;
  if (!brainDir || !thread) fail('nudge-why needs a brain and a thread id (--thread <id>, thread <id> in the status line)');
  const now = str(args.now) ? Date.parse(args.now) : Date.now();
  const since = now - (parseDelay(str(args.since) || '12h') || 12 * 3600_000);
  const state = readThreadState(brainDir, thread);
  const wf = str(args['comms-dir']) ? { file: path.join(path.resolve(args['comms-dir']), 'wake.json'), instance: path.basename(path.resolve(args['comms-dir'])) } : (() => { try { return wakeFile(ctx); } catch { return null; } })();
  const dataDir = wf ? path.dirname(wf.file) : null;
  const enc = encodeURIComponent(String(thread)).replace(/\*/g, '%2A');
  const turn = dataDir ? readJson(path.join(dataDir, 'turns', `${enc}.json`), null) : null;
  const wakeState = dataDir ? readJson(path.join(dataDir, 'client', 'wake', 'wake-state.json'), null) : null;
  const log = str(args['wake-log']) ? fs.readFileSync(args['wake-log'], 'utf8') : wf?.instance && !args['no-journal'] ? wakeLog(wf.instance, since) : '';
  const transcriptFile = str(args.transcript) || findTranscript([ctx.projectDir, process.cwd()], thread, state.t3_cursor);
  const transcript = readTranscript(transcriptFile);
  let mail = null;
  try { mail = mailCount({ ...ctx, brainDir, thread }); } catch (e) { mail = { unknown: true, note: e.message }; }
  let topics = [];
  try { const p = mailProjectName(ctx); topics = heldTopics(brainDir, thread).map((x) => `${p}/${x.id}`); } catch { /* labels only filter the log */ }
  const nudges = ctx.policy?.prompt?.nudge_prompts;
  const res = diagnose({ thread, state, turn, wakeState, wakeLog: log, transcript, mail, now, since, topics, ...(Array.isArray(nudges) ? { nudges } : {}) });
  process.stdout.write(`${format({ thread, ...res })}\n`);
} catch (err) {
  fail(err.message);
}
