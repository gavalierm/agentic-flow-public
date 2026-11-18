// T3-WORKAROUND(t3-stale-session) T3 0.1.10 (pingdotgg/t3code#38764, operator 2026-11-18): after a send with fresh context
// T3 opens a new Claude session but leaves the old one running. A background task of the old session wakes it later, and
// the operator's next prompt goes to the session that ran last: the old one, which never saw the turns of the new one
// ("schvaľujem A" reached a session that had never offered A). One T3 thread has one thread state (keyed by the T3 thread
// id), so UserPromptSubmit records each Claude session of the thread with the time of its last prompt. A prompt that lands
// in a session while another session of the thread wrote turns after that time gets those turns in its context.
// The usual turn (one session) costs one comparison; a transcript is read only in the split case, and only its tail.
import fs from 'node:fs';

export const STALE_MAX_SESSIONS = 6;
export const STALE_KEEP_MS = 2 * 24 * 3600 * 1000;
export const STALE_TAIL_BYTES = 1.5 * 1024 * 1024;
export const STALE_MAX_TURNS = 10;
export const STALE_TURN_CHARS = 1200;

const NOT_OPERATOR = /^\s*<(task-notification|system-reminder|command-|local-command)|^Caveat:/;

const realpath = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

/** The last `bytes` of a file as complete lines (the first, partial line dropped when the read starts mid-file). */
export function tailLines(file, bytes = STALE_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

/** Operator prompts and agent text of a Claude transcript written after `afterMs` (main conversation only), oldest first. */
export function turnsAfter(file, afterMs) {
  const out = [];
  for (const line of tailLines(file)) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain || d.isMeta || !d.timestamp || !(Date.parse(d.timestamp) > afterMs)) continue;
    const content = d.message?.content;
    if (d.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const text = textOf(content).trim();
      if (text && !NOT_OPERATOR.test(text)) out.push({ at: d.timestamp, who: 'operator', text });
    } else if (d.type === 'assistant') {
      const text = textOf(content).trim();
      if (text) out.push({ at: d.timestamp, who: 'agent', text });
    }
  }
  return out;
}

// A reply ends with its question or proposal (the options the operator answers): keep its start and its end.
const clip = (t, n) => (t.length > n ? `${t.slice(0, Math.floor(n / 4))} … ${t.slice(-Math.ceil(n * 3 / 4))}` : t);
const hhmm = (iso) => String(iso).slice(11, 16);

/**
 * UserPromptSubmit in a T3 thread. `state.t3_sessions`: { <session id>: { transcript, seen_at } }.
 * Returns { patch, block }: patch updates the thread state (this session's seen_at is now), block is the context with the
 * turns of other sessions of this thread written since this session's last prompt ('' when there are none).
 */
export function staleSessionCatchUp(input, state, { now = new Date() } = {}) {
  const sid = input?.session_id;
  const transcript = input?.transcript_path;
  if (!sid || !transcript) return { patch: {}, block: '' };
  const nowMs = now.getTime();
  const sessions = { ...(state?.t3_sessions || {}) };
  const mine = sessions[sid];
  const seenMs = mine?.seen_at ? Date.parse(mine.seen_at) : null;
  let block = '';
  // A new session (fresh context, first prompt after an upgrade) starts here: what other sessions wrote before is not its context.
  if (seenMs) {
    const own = realpath(transcript);
    const found = [];
    for (const [id, s] of Object.entries(sessions)) {
      if (id === sid || !s?.transcript) continue;
      const m = mtimeMs(s.transcript);
      // The pre-0.1.10 /clear redirect (t3-clear-cursor) links the old transcript name to the new one: the same file.
      if (m === null || m <= seenMs || (own && realpath(s.transcript) === own)) continue;
      for (const t of turnsAfter(s.transcript, seenMs)) found.push({ ...t, session: id });
    }
    if (found.length) {
      found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const shown = found.slice(-STALE_MAX_TURNS);
      const left = found.length - shown.length;
      const sids = [...new Set(found.map((t) => t.session.slice(0, 8)))].join(', ');
      block = [
        `## T3 session split (T3-WORKAROUND t3-stale-session, pingdotgg/t3code#38764)`,
        `T3 ran part of this thread in another Claude session (${sids}); you did not see these turns. They are part of the operator's conversation in this thread: read them before you answer, the operator's prompt may refer to them.`,
        ...shown.map((t) => `[${hhmm(t.at)} ${t.who}] ${clip(t.text, STALE_TURN_CHARS)}`),
        ...(left > 0 ? [`(${left} older turns left out; transcript: ${sessions[found[0].session].transcript})`] : []),
      ].join('\n');
    }
  }
  sessions[sid] = { transcript, seen_at: now.toISOString() };
  // Keep the recent sessions only: a transcript gone or untouched for two days no longer takes part.
  const kept = Object.entries(sessions)
    .filter(([id, s]) => id === sid || ((mtimeMs(s?.transcript) ?? 0) > nowMs - STALE_KEEP_MS))
    .sort((a, b) => Date.parse(b[1].seen_at || 0) - Date.parse(a[1].seen_at || 0))
    .slice(0, STALE_MAX_SESSIONS);
  return { patch: { t3_sessions: Object.fromEntries(kept) }, block };
}
