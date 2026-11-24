// T3-WORKAROUND(t3-cli-title) P-036: the thread title follows the thread's topic. The hook cannot rename a thread itself (T3 renames only through its
// agent tool), so it reads the title (`thread_title.command`, default `t3 thread show --json <thread>`) once per change of the
// topic and gives the agent one line. Skipped: persona main threads (they hold `main`), titles the operator changed by hand
// (title differs from the one the workflow asked for and from the one it saw before), bell turns, a harness outside T3,
// and a thread that holds more than one work topic: none of them is "the" topic, and `held` is alphabetical, so the first
// one is arbitrary (alice 2026-11-03: workflow-dev thread renamed to carol-v2, the other topic it held).
import { spawnSync } from 'node:child_process';

export const TITLE_TIMEOUT_MS = 3000;

/**
 * argv of the T3 command that shows a thread (`t3 thread show --json`, policy `thread_title.command`, the command the mail's
 * wake adapter runs as its `status_command`); WORKFLOW_T3_SHOW_COMMAND overrides it (tests: a stub, never the real T3).
 */
export function t3ShowCommand(policy, env = process.env) {
  const raw = env.WORKFLOW_T3_SHOW_COMMAND ? env.WORKFLOW_T3_SHOW_COMMAND : policy?.thread_title?.command;
  return String(raw || '').trim().split(/\s+/).filter(Boolean);
}

/** `<show command> <thread>`: { ok: true, data } (its JSON) or { ok: false, ran, text } (ran: the command ran and failed). */
function showThread(policy, thread, { run = spawnSync, env = process.env, timeout = TITLE_TIMEOUT_MS } = {}) {
  const cmd = t3ShowCommand(policy, env);
  if (!cmd.length || !thread) return { ok: false, ran: false, text: 'no command' };
  const r = run(cmd[0], [...cmd.slice(1), String(thread)], { encoding: 'utf8', timeout, env });
  if (r.error) return { ok: false, ran: false, text: r.error.message };
  if (r.status !== 0) return { ok: false, ran: true, text: `${r.stderr || ''} ${r.stdout || ''}`.replace(/\s+/g, ' ').trim() };
  try { return { ok: true, data: JSON.parse(r.stdout) }; } catch { return { ok: false, ran: false, text: 'output is no JSON' }; }
}

/** Current thread title via the configured command; null when unavailable. */
export function readThreadTitle(ctx, run = spawnSync) {
  if (!ctx.thread) return null;
  const r = showThread(ctx.policy, ctx.thread, { run });
  if (!r.ok) return null;
  const t = r.data?.thread?.title ?? r.data?.title;
  return typeof t === 'string' ? t : null;
}

// As the mail's wake module reads a ring that fails for good (agentic-comms PERMANENT_RING_FAILURE).
export const THREAD_GONE = /archived|not found|no longer available|does not exist|no such thread|unknown thread/i;

/**
 * State of thread `thread` in T3, read as the mail's wake adapter reads it (`thread.archived` of `t3 thread show --json`):
 * { known, gone, why }. gone = archived, or the command answered that the thread is not there. Unknown (known: false)
 * when there is no command, T3 does not answer (timeout, no CLI: another harness) or prints no thread: the caller keeps
 * the safe side.
 */
export function t3ThreadState(policy, thread, opts = {}) {
  const r = showThread(policy, thread, opts);
  if (r.ok) {
    const th = r.data?.thread;
    if (!th || typeof th !== 'object') return { known: false, gone: false, why: 'output without a thread object' };
    if (th.archived === true) return { known: true, gone: true, why: `thread ${thread} is archived (T3 status)` };
    return { known: true, gone: false, why: null };
  }
  // A shell that has no such program says "command not found": that is no answer of T3 about the thread.
  if (r.ran && THREAD_GONE.test(r.text) && !/command not found/i.test(r.text)) return { known: true, gone: true, why: r.text.slice(0, 160) };
  return { known: false, gone: false, why: r.text || null };
}

/**
 * Operator 2026-11-19: the thread title reads as a name, not a slug: the topic's `title` (2 to 5 words, set by
 * topic create --title), else its subject up to a colon, a bracket or a dash, cut at a word boundary to 40 characters,
 * else the topic id.
 */
export const TITLE_MAX = 40;
export function topicTitle(topic) {
  const own = String(topic?.title || '').trim();
  if (own) return own.slice(0, 60);
  let s = String(topic?.subject || '').split(/\s*[:(–—;]\s*|\s+-\s+/)[0].replace(/[.,\s]+$/, '').trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX + 1).replace(/\s+\S*$/, '').replace(/[,\s]+$/, '');
  return s || String(topic?.id || '');
}

/** The question the rename dialog asks: it names the old and the new title, so the operator knows what to look for. */
export const renameQuestion = (current, target) => `Premenovať toto vlákno z „${current}“ na „${target}“? Téma vlákna sa zmenila, so starým názvom ho v zozname vlákien nenájdete.`;

/**
 * Decide about the title for this turn. `state` is the thread state; returns { line, patch } (patch merged into the state)
 * or null when nothing is to be done. Operator 2026-11-19: a rename is never silent: the operator confirms it in a
 * dialog that names the old and the new title (renameGate refuses the rename without it).
 */
export function threadTitleSignal(ctx, held, state, { read = readThreadTitle, env = process.env } = {}) {
  // Only inside T3 (it sets T3CODE_THREAD_ID); elsewhere there is no title to follow.
  if (!env.T3CODE_THREAD_ID || !ctx.policy?.thread_title?.command || !ctx.thread || !state) return null;
  if (held.length !== 1 || held[0].id === 'main') return null;
  const topic = held[0].id;
  if (state.title_topic === topic) return null;
  const current = read(ctx);
  if (current == null) return { line: null, patch: { title_topic: topic } };
  const target = topicTitle(held[0]);
  if (current === target) return { line: null, patch: { title_topic: topic, auto_title: target } };
  const known = [state.auto_title, state.title_prev].filter((t) => typeof t === 'string');
  if (known.length && !known.includes(current)) return { line: null, patch: { title_topic: topic, title_manual: current } };
  return {
    line: `thread title: this thread is titled "${current}", its topic "${target}"; a rename is never silent: ask in one AskUserQuestion "${renameQuestion(current, target)}" with the options "Premenovať na „${target}“" (recommended) and "Nechať „${current}“"; only after the yes rename it (tool t3_thread_update, action rename, title "${target}"), after the no keep the title (P-036)`,
    patch: { title_topic: topic, auto_title: target, title_prev: current },
  };
}

// A refusal is not kept as a lift (bypass.mjs REFUSING_ANSWER); these are the "keep the title" answers on top of it.
const RENAME_NO = /^\s*(?:nie|ne|no|nechaj|nechať|ponechaj|ponechať|zachovaj|keep|cancel|zru[sš]|stop)(?![\p{L}])/iu;

/**
 * Operator 2026-11-19 (P-036): a thread rename (t3_thread_update rename or regenerate_title, own thread or another) passes
 * only after the operator's yes in a dialog; a rename to a title the dialog names that title. `lifts` are the answered
 * dialogs of the turn ({ text: question + "\n" + answer }), `kept` every kept one (bypass.mjs keptLifts). A rename to a
 * title counts a kept yes that names the title: the turn may end between the answer and the call (a notice of a finished
 * worker starts a new one, a web project, 2026-11-23). regenerate_title names no title, so it needs the yes of this turn.
 * Returns the reason of the refusal, or null.
 */
export function renameGate(toolName, toolInput, lifts = [], kept = lifts) {
  if (!/(?:^|__)t3_thread_update$/.test(String(toolName || ''))) return null;
  const action = String(toolInput?.action || '');
  if (action !== 'rename' && action !== 'regenerate_title') return null;
  const title = String(toolInput?.title || '').trim();
  const ok = (action === 'rename' ? kept : lifts).some((l) => {
    const text = String(l?.text || '');
    const answer = text.slice(text.lastIndexOf('\n') + 1);
    if (RENAME_NO.test(answer)) return false;
    return action === 'rename' ? !!title && text.includes(title) : /premenova|názov vlákna|rename|title/i.test(text);
  });
  if (ok) return null;
  return `a thread rename is never silent (operator 2026-11-19, P-036): the operator looks for the thread by its title. Ask first in one AskUserQuestion that names the old and the new title, e.g. "${renameQuestion('<current title>', title || '<new title>')}", options "Premenovať na „${title || '<new title>'}“" (recommended) and "Nechať „<current title>“"; after the yes the same call passes, after the no keep the title`;
}
