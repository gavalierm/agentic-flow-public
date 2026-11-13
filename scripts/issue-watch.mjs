// The reporter watches its own issue (D-0023, D-0024): the record of an issue created by error.mjs report, the check of
// all records of this machine (wake job `issue-watch`, bin/issue-watch.mjs), and the reporter's answer on the issue
// (error.mjs confirm|reopen). The check rings the reporter's topic by mail (`steer`), never with text from GitHub: the
// message carries the link, the comment ids and the state only (P-047).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContext, machineName } from './config.mjs';
import { runClient, commsProjectName, isMainTopic } from './comms.mjs';
import { DEFAULT_TOKEN_FILE, DEFAULT_API_URL, gh, readToken } from './github.mjs';
import { heldTopics } from './topic.mjs';
import { readJson, nowIso, toPosix } from './util.mjs';

export const ISSUES_FILE = 'reported-issues.json';
export const WATCH_LOG = 'issue-watch.log';
export const JOB_NAME = 'issue-watch';

/** Records live in the brain's local/ (thread ids and check state are no repo content), next to error-reports.json. */
export function issuesFile(base) {
  return path.join(base, 'local', ISSUES_FILE);
}
export function baseOf(ctx) {
  return ctx.brainDir || ctx.projectDir;
}
export function readIssues(base) {
  const all = base ? readJson(issuesFile(base), {}) : {};
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
/** Merge `patch` into record `key` (read again first: the check and the reporter's commands may write one after the other). */
export function updateIssue(base, key, patch) {
  const all = readIssues(base);
  if (patch === null) delete all[key];
  else all[key] = { ...(all[key] || {}), ...patch };
  writeAtomic(issuesFile(base), all);
  return all[key] || null;
}

/** Brains of this machine with records: one wake job checks them all (one wake per mail instance, several projects). */
export function indexFile(env = process.env) {
  return env.WORKFLOW_ISSUE_WATCH_INDEX || path.join(env.HOME || os.homedir(), '.config', 'agentic-flow', 'issue-watch-index.json');
}
export function readIndex(env = process.env) {
  const d = readJson(indexFile(env), null);
  return d && typeof d.brains === 'object' && d.brains ? d : { brains: {} };
}
function addToIndex(ctx, env) {
  const base = baseOf(ctx);
  const idx = readIndex(env);
  if (idx.brains[base]?.project === ctx.projectDir) return;
  idx.brains[base] = { project: ctx.projectDir, since: idx.brains[base]?.since || nowIso() };
  try { writeAtomic(indexFile(env), idx); } catch { /* the record stays; the check does not see it until the next report */ }
}

export function issueKey(slug, number) {
  return `${slug}#${number}`;
}

/**
 * Record of an issue error.mjs report created (3c.1). The reporter's topic: the first held work topic, else `main`, else
 * none; a closed topic later falls back to the persona main thread (`persona_main`), a project without persona to the log.
 */
export function recordIssue(ctx, issue, env = process.env) {
  if (!issue?.slug || !issue.number) return null;
  const base = baseOf(ctx);
  if (!base) return null;
  const held = ctx.brainDir && ctx.thread ? heldTopics(ctx.brainDir, ctx.thread) : [];
  const topic = held.length ? (isMainTopic(held[0]) ? 'main' : held[0].id) : null;
  const now = nowIso();
  const key = issueKey(issue.slug, issue.number);
  const mailProject = commsProjectName(ctx);
  const rec = updateIssue(base, key, {
    url: issue.url, repo: issue.slug, number: issue.number, issue_id: issue.id || null, reporter_login: issue.login || null,
    own_comment_ids: [], topic, thread: ctx.thread || null, machine: machineName(env),
    persona_main: ctx.persona ? `@${mailProject}/main` : null, mail_project: mailProject,
    last_comment_id: 0, last_checked_at: now, etag: null, state: 'open', status: 'waiting', undelivered: null, created_at: now,
  });
  addToIndex(ctx, env);
  return { key, ...rec };
}

/** `- <url> (stav: čaká|odpoveď|zavreté; od <dátum>)` for the handover section of a topic (3c.3), confirmed ones left out. */
export function openReportLines(base, topic) {
  if (!base || !topic) return [];
  return Object.values(readIssues(base))
    .filter((r) => r && r.topic === topic && r.status !== 'confirmed' && r.url)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((r) => `- ${r.url} (stav: ${r.state === 'closed' ? 'zavreté' : r.last_comment_id ? 'odpoveď' : 'čaká'}; od ${String(r.created_at || '').slice(0, 10)})`);
}

/** Records whose ring found no mail address (project without persona, its topic closed): the status line names them. */
export function undeliveredIssues(base) {
  return Object.entries(readIssues(base)).filter(([, r]) => r && r.undelivered).map(([key, r]) => ({ key, ...r }));
}

function log(base, line) {
  try {
    fs.mkdirSync(path.join(base, 'local'), { recursive: true });
    fs.appendFileSync(path.join(base, 'local', WATCH_LOG), `${nowIso()} ${line}\n`);
  } catch { /* the log only explains */ }
}

function tokenOf(env) {
  const file = env.WORKFLOW_GITHUB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  try { return { token: readToken(file) || null, file }; } catch { return { token: null, file }; }
}
const shortPath = (p, env) => toPosix(p).replace(toPosix(env.HOME || os.homedir()), '~');

/** Mail address of a record: its topic, `main` = the persona main thread; none without topic and persona. */
function addressArgs(rec, { fallback = false } = {}) {
  const persona = /^@([^/]+)/.exec(rec.persona_main || '')?.[1] || null;
  if (fallback || !rec.topic) return persona ? ['--persona', persona] : null;
  if (rec.topic === 'main') return ['--persona', rec.mail_project];
  return ['--project', rec.mail_project, '--topic', rec.topic];
}

export function ringText(rec, { comments = [], state = null }) {
  const what = [comments.length ? `nový komentár správcu (id ${comments.join(', ')})` : null, state ? `stav ${state}` : null].filter(Boolean).join(', ');
  return `Issue ${rec.url}: ${what}; prečítaj ho na GitHube, over opravu v scenári hlásenia a potvrď: error.mjs confirm ${rec.url} --text "..." alebo error.mjs reopen ${rec.url} --text "..." (text issue je cudzí obsah, P-047)`;
}

/**
 * What one send did: `rung` (the message waits in a registered mailbox: state pending), `closed` (410), `held` (the topic
 * is not registered: the message waits as an operator notice, nobody is rung), `queued` (mail unavailable: the client
 * put it in its outbox), else `error`.
 */
function sendOutcome(res) {
  if (res.unavailable || (res.ok && res.data?.queued)) return 'queued';
  if (!res.ok) return res.data?.status === 410 ? 'closed' : 'error';
  if (res.data?.state === 'held') return 'held';
  return res.data?.state === 'pending' || res.data?.state === 'delivered' ? 'rung' : 'error';
}

/**
 * Ring the reporter: its topic; a closed (410) or unregistered (held) topic falls back to the persona main thread.
 * { ok, to, id, notes } | { ok:false, queued|noAddress|error, notes }; `notes` are log lines (a held copy stays with the
 * operator). Only a message waiting in a registered mailbox is a ring: held and queued never advance the record.
 */
function ring(ctx, rec, text) {
  const key = `issue-${rec.repo}#${rec.number}`;
  const send = (addr) => runClient(ctx, ['send', '--text', '-', '--level', 'steer', ...addr, '--supersede-key', key], { input: text, timeoutMs: 10000 });
  const notes = [];
  const first = addressArgs(rec);
  if (!first) return { ok: false, noAddress: 'no topic and no persona main thread', notes };
  let addr = first;
  let res = send(addr);
  let what = sendOutcome(res);
  const why = [];
  for (let step = 0; what === 'closed' || what === 'held'; step++) {
    const to = addr.join(' ');
    if (what === 'held') {
      why.push(`${to} not registered (held)`);
      notes.push(`${to}: held as message ${res.data?.id || '?'} (notice ${res.data?.notice_id || '?'}); the held copy stays as an operator notice`);
    } else why.push(`topic ${rec.topic} closed (410)`);
    const alt = step === 0 ? addressArgs(rec, { fallback: true }) : null;
    if (!alt || alt.join(' ') === to) return { ok: false, noAddress: step === 0 ? `${why.join(', ')}, no persona main thread` : why.join(', '), notes };
    addr = alt;
    res = send(addr);
    what = sendOutcome(res);
  }
  if (what === 'queued') return { ok: false, queued: true, notes };
  if (what !== 'rung') return { ok: false, error: res.error || `unexpected answer of send (state ${res.data?.state || '?'})`, notes };
  return { ok: true, to: addr.join(' '), id: res.data?.id || null, notes };
}

const reset = (h) => { const s = Number(h?.['x-ratelimit-reset']); return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : new Date(Date.now() + 3600000).toISOString(); };
const limited = (r) => (r.status === 403 || r.status === 429) && String(r.headers?.['x-ratelimit-remaining']) === '0';
const PER_PAGE = 100;
export const MAX_PAGES = 10;

/**
 * All pages of a GitHub list (`per_page=100`): the next page while the reply links `rel="next"`, without a Link header
 * while a page is full. At most `MAX_PAGES`. { ok, items } | { ok:false, limited, headers } | { ok:false, why }: a failed
 * page, a rate limit or more pages than the cap is no list (the caller advances nothing). A thrown error (no answer) too.
 */
async function ghList(api, token, route) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(api, token, 'GET', `${route}${route.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`);
    if (limited(r)) return { ok: false, limited: true, headers: r.headers };
    if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, why: `HTTP ${r.status}${page > 1 ? ` on page ${page}` : ''}` };
    items.push(...r.json);
    const next = r.headers.link ? /<[^>]*>\s*;\s*rel="next"/.test(r.headers.link) : r.json.length >= PER_PAGE;
    if (!next) return { ok: true, items };
  }
  return { ok: false, why: `more than ${MAX_PAGES} pages of ${PER_PAGE}` };
}

/** Check the records of one brain; returns { rang, undelivered, limitedUntil, lines }. */
async function watchBase(base, entry, { token, api, now }) {
  const out = { rang: 0, undelivered: [], limitedUntil: null };
  let ctx = null;
  try { ctx = loadContext({ project: entry.project, requireBrain: false }); } catch (err) { log(base, `project ${entry.project}: ${err.message}`); return out; }
  ctx.thread = null; // the check is code: it sends as the instance, never as some thread
  const keepDays = ctx.policy?.issue_watch?.keep_days ?? 3;
  const all = readIssues(base);
  // Confirmed and closed: kept `keep_days` after the confirmation, then dropped (3c.2).
  for (const [key, r] of Object.entries(all)) {
    if (r?.status === 'confirmed' && r.state === 'closed' && now - Date.parse(r.confirmed_at || r.created_at || 0) > keepDays * 86400000) {
      updateIssue(base, key, null);
      log(base, `${key}: confirmed and closed, record dropped`);
    }
  }
  const live = Object.entries(readIssues(base)).filter(([, r]) => r?.repo && r.number && !(r.status === 'confirmed' && r.state === 'closed'));
  if (!live.length) return out;
  const byRepo = new Map();
  for (const [key, r] of live) byRepo.set(r.repo, [...(byRepo.get(r.repo) || []), [key, r]]);
  for (const [repo, recs] of byRepo) {
    const since = recs.map(([, r]) => r.last_checked_at).filter(Boolean).sort()[0] || new Date(now - 86400000).toISOString();
    const started = new Date(now - 60000).toISOString(); // one minute overlap; comment ids keep a ring from repeating
    // Any failure (a page, no answer, more pages than the cap): no record of this repo advances, the next round asks again.
    let list;
    try { list = await ghList(api, token, `/repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}`); } catch (err) { log(base, `${repo}: GitHub issues failed (${err.message}); nothing advanced`); continue; }
    if (list.limited) { out.limitedUntil = reset(list.headers); log(base, `${repo}: GitHub rate limit, next round after ${out.limitedUntil}`); return out; }
    if (!list.ok) { log(base, `${repo}: GitHub issues failed (${list.why}); nothing advanced`); continue; }
    const changed = new Map(list.items.filter((i) => !i.pull_request).map((i) => [i.number, i]));
    for (const [key, rec] of recs) {
      const iss = changed.get(rec.number);
      if (!iss) { updateIssue(base, key, { last_checked_at: started }); continue; }
      let comments = [];
      if (iss.comments > 0) {
        let c;
        try { c = await ghList(api, token, `/repos/${repo}/issues/${rec.number}/comments?since=${encodeURIComponent(rec.last_checked_at || since)}`); } catch (err) { log(base, `${key}: GitHub comments failed (${err.message}); nothing advanced`); continue; }
        if (c.limited) { out.limitedUntil = reset(c.headers); log(base, `${key}: GitHub rate limit, next round after ${out.limitedUntil}`); return out; }
        if (!c.ok) { log(base, `${key}: GitHub comments failed (${c.why}); nothing advanced`); continue; }
        const own = new Set((rec.own_comment_ids || []).map(Number));
        comments = c.items.map((x) => Number(x.id)).filter((id) => id > Number(rec.last_comment_id || 0) && !own.has(id)).sort((a, b) => a - b);
      }
      const state = iss.state && iss.state !== rec.state ? iss.state : null;
      const lastId = Math.max(Number(rec.last_comment_id || 0), ...comments);
      const advance = { last_comment_id: lastId, state: iss.state || rec.state, last_checked_at: started };
      if (!comments.length && !state) { updateIssue(base, key, advance); continue; }
      // A confirmed record is only kept in step (closing after the confirmation rings nobody).
      if (rec.status === 'confirmed') { updateIssue(base, key, advance); continue; }
      const r = ring(ctx, rec, ringText(rec, { comments, state }));
      for (const n of r.notes || []) log(base, `${key}: ${n}`);
      if (r.ok) {
        updateIssue(base, key, { ...advance, undelivered: null, last_ring: { at: nowIso(), message_id: r.id, to: r.to } });
        out.rang++;
        log(base, `${key}: rang ${r.to} (message ${r.id || '?'}; comments ${comments.join(',') || '-'}; state ${state || '-'})`);
      } else if (r.noAddress) {
        const u = { at: nowIso(), comments: [...new Set([...(rec.undelivered?.comments || []), ...comments])], state: state || rec.undelivered?.state || null, why: r.noAddress };
        updateIssue(base, key, { ...advance, undelivered: u });
        out.undelivered.push(key);
        log(base, `${key}: not rung (${r.noAddress}): ${rec.url} comments ${u.comments.join(',') || '-'} state ${u.state || '-'}`);
      } else if (r.queued) {
        // In the client's outbox, not in a mailbox: nothing advances; the same key replaces it on the next ring.
        log(base, `${key}: mail unavailable, queued; next round rings again`);
      } else {
        // Mail failed: nothing advances, the next round rings again (3c.2).
        log(base, `${key}: mail failed (${r.error}); the next round tries again`);
      }
    }
  }
  return out;
}

/** The lock of the check round (`<index>.lock`, stale after 30 min): a release function, or null while another holds it. */
function tryLock(file) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 30 * 60000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return null; }
  fs.closeSync(fd);
  return () => fs.rmSync(lock, { force: true });
}

function withLock(file, fn) {
  const release = tryLock(file);
  if (!release) return null;
  return Promise.resolve().then(fn).finally(release);
}

export const LOCK_WAIT_MS = 20000;

/**
 * The reporter's answer (confirm, reopen) under the lock of the check round: a round reads and writes the same records
 * (own_comment_ids), so the answer waits for it a short while (`WORKFLOW_ISSUE_WATCH_LOCK_WAIT_MS`), then gives up
 * with nothing posted.
 */
async function withLockWait(file, what, fn, env) {
  const wait = Number(env.WORKFLOW_ISSUE_WATCH_LOCK_WAIT_MS) || LOCK_WAIT_MS;
  const until = Date.now() + wait;
  let release;
  while (!(release = tryLock(file))) {
    if (Date.now() >= until) throw new Error(`a round of the issue check is running (lock ${shortPath(`${file}.lock`, env)}, waited ${wait / 1000} s): nothing posted; run error.mjs ${what} again in a minute`);
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return await fn(); } finally { release(); }
}

/**
 * One round over all records of this machine (wake job, D-0024). `force` ignores a rate-limit pause. No token: a log line
 * and the end (D-0024: without the token no issue was created). Returns { lines, rang, undelivered }.
 */
export async function watchIssues({ env = process.env, force = false, now = Date.now() } = {}) {
  const file = indexFile(env);
  const stateFile = path.join(path.dirname(file), 'issue-watch-state.json');
  const res = await withLock(file, async () => {
    const idx = readIndex(env);
    const bases = Object.entries(idx.brains).filter(([base]) => fs.existsSync(issuesFile(base)));
    const state = readJson(stateFile, {}) || {};
    if (!bases.length) return { lines: ['issue-watch: no records on this machine'], rang: 0, undelivered: [] };
    if (!force && state.retry_after && Date.parse(state.retry_after) > now) return { lines: [`issue-watch: GitHub rate limit, paused until ${state.retry_after}`], rang: 0, undelivered: [] };
    const { token, file: tokenFile } = tokenOf(env);
    if (!token) {
      const line = `issue-watch: no GitHub token (${shortPath(tokenFile, env)}): nothing checked`;
      for (const [base] of bases) log(base, line);
      return { lines: [line], rang: 0, undelivered: [] };
    }
    const api = env.WORKFLOW_GITHUB_API || DEFAULT_API_URL;
    const lines = [];
    let rang = 0;
    const undelivered = [];
    let limitedUntil = null;
    for (const [base, entry] of bases) {
      const r = await watchBase(base, entry, { token, api, now });
      rang += r.rang;
      undelivered.push(...r.undelivered.map((k) => `${toPosix(path.basename(base))}: ${k}`));
      if (r.limitedUntil) { limitedUntil = r.limitedUntil; break; }
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeAtomic(stateFile, { ...state, last_run_at: new Date(now).toISOString(), retry_after: limitedUntil });
    lines.push(`issue-watch: ${bases.length} brain(s), ${rang} ring(s)${undelivered.length ? `, ${undelivered.length} without mail address` : ''}${limitedUntil ? `, rate limit until ${limitedUntil}` : ''}`);
    return { lines, rang, undelivered };
  });
  return res || { lines: ['issue-watch: another round is running'], rang: 0, undelivered: [], busy: true };
}

function findRecord(ctx, url) {
  const base = baseOf(ctx);
  const all = readIssues(base);
  const hit = Object.entries(all).find(([key, r]) => r?.url === url || key === url);
  if (!hit) throw new Error(`no record of issue ${url} on this machine (local/${ISSUES_FILE}); error.mjs confirm|reopen answers issues error.mjs report created here`);
  return { base, key: hit[0], rec: hit[1] };
}

async function comment(env, rec, body) {
  const { token, file } = tokenOf(env);
  if (!token) throw new Error(`no GitHub token (${shortPath(file, env)}): the answer was not posted`);
  const api = env.WORKFLOW_GITHUB_API || DEFAULT_API_URL;
  return { token, api, post: await gh(api, token, 'POST', `/repos/${rec.repo}/issues/${rec.number}/comments`, { body }) };
}

/** The fix works in the reported scenario: comment, `status: confirmed`; the handover section drops it on the next save. */
export async function confirmIssue(ctx, url, text, env = process.env, scrubText = (t) => t) {
  findRecord(ctx, url); // no record: no wait for the lock
  return withLockWait(indexFile(env), 'confirm', () => confirmLocked(ctx, url, text, env, scrubText), env);
}
async function confirmLocked(ctx, url, text, env, scrubText) {
  const { base, key, rec } = findRecord(ctx, url);
  const { post } = await comment(env, rec, scrubText(text));
  if (post.status !== 201 || !post.json?.id) throw new Error(`comment on ${rec.url} failed (HTTP ${post.status})`);
  updateIssue(base, key, { own_comment_ids: [...(rec.own_comment_ids || []), post.json.id], status: 'confirmed', confirmed_at: nowIso(), undelivered: null });
  return `confirmed: ${rec.url} (comment ${post.json.id}); the section "## Otvorené hlásenia" leaves the handover at the next save.mjs handover`;
}

/** The fix does not work: the issue opens again with the evidence; the record watches again (`status: waiting`). */
export async function reopenIssue(ctx, url, text, env = process.env, scrubText = (t) => t) {
  findRecord(ctx, url);
  return withLockWait(indexFile(env), 'reopen', () => reopenLocked(ctx, url, text, env, scrubText), env);
}
async function reopenLocked(ctx, url, text, env, scrubText) {
  const { base, key, rec } = findRecord(ctx, url);
  const { token } = tokenOf(env);
  if (!token) throw new Error(`no GitHub token (${shortPath(tokenOf(env).file, env)}): the issue was not reopened`);
  const api = env.WORKFLOW_GITHUB_API || DEFAULT_API_URL;
  const patch = await gh(api, token, 'PATCH', `/repos/${rec.repo}/issues/${rec.number}`, { state: 'open' });
  if (patch.status !== 200) throw new Error(`reopening ${rec.url} failed (HTTP ${patch.status})`);
  const { post } = await comment(env, rec, scrubText(text));
  if (post.status !== 201 || !post.json?.id) throw new Error(`issue ${rec.url} reopened, but the comment failed (HTTP ${post.status}): post the evidence again with error.mjs reopen`);
  updateIssue(base, key, { own_comment_ids: [...(rec.own_comment_ids || []), post.json.id], status: 'waiting', state: 'open', confirmed_at: null, undelivered: null });
  return `reopened: ${rec.url} (comment ${post.json.id}); the check rings this topic on the maintainer's answer`;
}
