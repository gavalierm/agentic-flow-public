// T3-WORKAROUND(t3-clear-cursor) T3 /clear workaround (pingdotgg/t3code#24152): after /clear the Claude SDK starts a new session, but T3 keeps resuming
// the session it opened first (its resume cursor). Once the query closes (idle, restart, interrupt), the thread falls back
// to the pre-clear conversation, or fails with "No conversation found" when the old transcript does not exist.
// Fix on our side: the transcript T3 resumes, <cursor>.jsonl, becomes a symlink to the newest session's transcript.
// Claude Code follows the link on --resume and appends to the new transcript (checked 2026-11-03).
// Windows without Developer Mode refuses symlinks (EPERM): a hard link instead (NTFS, no privilege). Claude Code appends
// to the transcript in place, so both names keep sharing it across turns and resumes (checked 2026-11-09). A hard link
// needs the new transcript, which may not exist yet at SessionStart; it is never pre-created (Claude then refuses the
// session id, checked 2026-11-09): a detached process waits for it and links then.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const LINK_LATER_MS = 15 * 60 * 1000;

/**
 * Point <dir>/<cursor>.jsonl at <dir>/<sid>.jsonl (the old name must already be free): symlink, else hard link.
 * Returns 'symlink', 'hardlink', or null when only a hard link is possible and the new transcript does not exist yet.
 */
export function linkTranscript(dir, cursor, sid, { symlink = fs.symlinkSync } = {}) {
  const link = path.join(dir, `${cursor}.jsonl`);
  const target = path.join(dir, `${sid}.jsonl`);
  try { symlink(`${sid}.jsonl`, link); return 'symlink'; } catch (err) {
    if (!fs.existsSync(target)) return null;
    try { fs.linkSync(target, link); } catch (e) { throw new Error(`symlink: ${err.code || err.message}; hard link: ${e.code || e.message}`); }
    return 'hardlink';
  }
}

/** Wait until <dir>/<sid>.jsonl exists, then hard-link <cursor>.jsonl to it (unless that name was taken meanwhile). */
export function linkLater(dir, cursor, sid, { timeoutMs = LINK_LATER_MS, intervalMs = 2000 } = {}) {
  const target = path.join(dir, `${sid}.jsonl`);
  const link = path.join(dir, `${cursor}.jsonl`);
  const end = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(target)) {
        try { fs.lstatSync(link); return resolve(null); } catch { /* still free */ }
        try { fs.linkSync(target, link); return resolve('hardlink'); } catch { return resolve(null); }
      }
      if (Date.now() >= end) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function spawnLinkLater(dir, cursor, sid) {
  spawn(process.execPath, [SELF, '--link-later', dir, cursor, sid], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** query.open event of T3's provider log that resumes a session; group 1 is the session id (T3 internal format). */
export const RESUME_RE = /"type":"query\.open","options":\{[^\n]*?"resume":"([0-9a-f-]{36})"/g;

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Last session id T3 resumed for this thread, from its provider log (fallback when the cursor was not recorded). */
export function cursorFromProviderLog(thread, logDir = path.join(os.homedir(), '.t3', 'userdata', 'logs', 'provider')) {
  if (!thread) return null;
  const names = [...new Set([thread.replace(/:/g, '-'), thread.replace(/^[a-z]+:/, '')])].map((n) => path.join(logDir, `events.${n}.log`));
  for (const file of names) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const all = [...text.matchAll(RESUME_RE)];
    if (all.length) return all[all.length - 1][1];
  }
  return null;
}

/**
 * SessionStart in a T3 thread. startup: the new session is T3's cursor; resume: keep the recorded cursor (record it once).
 * clear: point <cursor>.jsonl at the new session's transcript (the real old file is kept as <cursor>.jsonl.pre-clear-<ts>).
 * Returns { state, note } where state is the updated thread state and note a one-line result for the boot context (or null).
 * First the session folders of the session and the cursor become real folders (realSessionDirs).
 */
export function handleT3Session(input, state, opts = {}) {
  const fixed = input.transcript_path ? realSessionDirs(path.dirname(input.transcript_path), [input.session_id, state?.t3_cursor]) : [];
  const r = clearSession(input, state, opts);
  return fixed.length ? { ...r, note: [r.note, ...fixed].filter(Boolean).join('\n') } : r;
}

/**
 * alice 2026-11-10: the folder <id>/ beside a transcript (tool-results, subagents) was a symlink into another history
 * folder; Claude Code refuses to persist a large hook output or tool result through a linked folder ("tool-results
 * path refused: … is a link or not a directory") and cuts it to 10 000 chars. The real folder moves under the session's
 * own name and the old place becomes a symlink to it, so paths already written in transcripts still resolve.
 * Returns one note line per folder made real.
 */
export function realSessionDirs(dir, ids) {
  const notes = [];
  for (const id of new Set(ids.filter((x) => SID.test(x || '')))) {
    const p = path.join(dir, id);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let target;
    try { target = fs.realpathSync(p); } catch { continue; } // dangling link: Claude Code makes the folder itself once it is gone
    if (!fs.statSync(target).isDirectory() || target === path.resolve(p)) continue;
    const back = fs.readlinkSync(p);
    try {
      fs.unlinkSync(p);
      fs.renameSync(target, p);
      fs.symlinkSync(p, target, 'dir');
      notes.push(`história: priečinok session ${id.slice(0, 8)} bol odkaz na ${target}; teraz je skutočný (staré miesto odkazuje naň), výstupy nástrojov sa znova ukladajú celé.`);
    } catch (err) {
      try { if (!fs.existsSync(p)) fs.symlinkSync(back, p, 'dir'); } catch { /* best effort */ }
      notes.push(`história: priečinok session ${id.slice(0, 8)} je odkaz a nepodarilo sa ho nahradiť (${err.code || err.message}); veľké výstupy sa orežú.`);
    }
  }
  return notes;
}

function clearSession(input, state, { thread, logDir, now = new Date(), symlink, spawnLater = spawnLinkLater } = {}) {
  const source = input.source || 'startup';
  const sid = input.session_id;
  if (!SID.test(sid || '')) return { state, note: null };
  if (source === 'startup') return { state: { ...state, t3_cursor: sid }, note: null };
  if (source === 'resume') return { state: state.t3_cursor ? state : { ...state, t3_cursor: sid }, note: null };
  if (source !== 'clear') return { state, note: null };
  const cursor = SID.test(state.t3_cursor || '') ? state.t3_cursor : cursorFromProviderLog(thread, logDir);
  if (!cursor) return { state, note: 'T3 /clear: neznámy kurzor T3 (session, ktorú T3 obnovuje); po zatvorení query sa vlákno vráti pred /clear.' };
  if (cursor === sid || path.basename(input.transcript_path || '') !== `${sid}.jsonl`) return { state: { ...state, t3_cursor: cursor }, note: null };
  const dir = path.dirname(input.transcript_path);
  const link = path.join(dir, `${cursor}.jsonl`);
  let how;
  try {
    let st = null;
    try { st = fs.lstatSync(link); } catch { /* no transcript yet: T3 would fail with No conversation found */ }
    if (st?.isSymbolicLink()) fs.unlinkSync(link);
    else if (st) fs.renameSync(link, `${link}.pre-clear-${now.toISOString().replace(/[:.]/g, '-')}`);
    how = linkTranscript(dir, cursor, sid, { symlink });
    if (!how) spawnLater(dir, cursor, sid);
  } catch (err) {
    return { state: { ...state, t3_cursor: cursor }, note: `T3 /clear: presmerovanie ${cursor}.jsonl zlyhalo (${err.message}); po zatvorení query sa vlákno vráti pred /clear.` };
  }
  const state2 = { ...state, t3_cursor: cursor, t3_cleared_to: sid, t3_cleared_at: now.toISOString() };
  if (!how) return { state: state2, note: `T3 /clear: kurzor T3 ${cursor.slice(0, 8)} sa presmeruje na novú session ${sid.slice(0, 8)} hard linkom, keď vznikne jej transkript (symlink nejde, napr. Windows bez Developer Mode).` };
  return { state: state2, note: `T3 /clear: kurzor T3 ${cursor.slice(0, 8)} presmerovaný na novú session ${sid.slice(0, 8)}${how === 'hardlink' ? ' (hard link)' : ''}; vlákno pokračuje aj po obnovení query.` };
}

if (process.argv[2] === '--link-later' && process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [dir, cursor, sid] = process.argv.slice(3);
  if (dir && SID.test(cursor || '') && SID.test(sid || '')) linkLater(dir, cursor, sid).then(() => process.exit(0));
}
