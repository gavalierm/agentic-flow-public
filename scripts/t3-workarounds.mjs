// T3 workaround registry check (PLAN decision 35): every T3 upgrade verifies the workarounds in docs/t3-workarounds.json.
// Automatic checks read what the installed T3 writes or prints; behaviour that needs a thread is a pilot step (MANUAL).
// Status per line: OK, FAIL (the workaround's T3 dependency changed), PENDING (nothing to judge yet), MANUAL (pilot step),
// REMOVE (the upstream fix is merged: check the T3 version and drop the workaround).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESUME_RE, versionAtLeast } from './t3-clear.mjs';
import { THREAD_GONE } from './thread-title.mjs';

export const REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 't3-workarounds.json');
export const MARKER_RE = /T3-WORKAROUND\(([a-z0-9-]+)\)/g;

export function readRegistry(file = REGISTRY) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).workarounds;
}

/** T3 server version and start time from <t3-home>/server-runtime.json (null fields when missing). */
export function t3Runtime(t3Home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(t3Home, 'server-runtime.json'), 'utf8'));
    return { version: d.serverVersion ?? null, startedAt: d.startedAt ?? null };
  } catch { return { version: null, startedAt: null }; }
}

/** Provider log lines written since `since` (ISO): the resume cursor must still be readable in the query.open events. */
export function checkProviderLog(t3Home, since) {
  const dir = path.join(t3Home, 'logs', 'provider');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^events\..+\.log$/.test(n)); } catch { return ['FAIL', `provider log dir ${dir} missing (path changed?)`]; }
  const sinceMs = since ? Date.parse(since) : 0;
  let lines = 0, opens = 0, resumes = 0, parsed = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    if (fs.statSync(file).mtimeMs < sinceMs) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = /^\[([^\]]+)\]/.exec(line);
      if (!line || (sinceMs && !(t && Date.parse(t[1]) >= sinceMs))) continue;
      lines++;
      if (!line.includes('query.open')) continue;
      opens++;
      if (!line.includes('"resume"')) continue;
      resumes++;
      if (new RegExp(RESUME_RE.source).test(line)) parsed++;
    }
  }
  const scope = since ? `since T3 start ${since}` : 'in all logs';
  if (!lines) return ['PENDING', `no provider log lines ${scope}; run a thread, then check again`];
  if (!opens) return ['FAIL', `${lines} provider log lines ${scope}, none with query.open (event renamed?)`];
  if (!resumes) return ['PENDING', `${opens} query.open ${scope}, none resumed; resume a thread (send to an idle one), then check again`];
  if (parsed < resumes) return ['FAIL', `${resumes - parsed} of ${resumes} resumed query.open ${scope} do not match the cursor format (t3-clear.mjs RESUME_RE)`];
  return ['OK', `${parsed} resumed query.open ${scope} readable`];
}

/** Upstream state of the fix PR (GitHub API, no token: public repo). */
export async function checkUpstream(up, fetchImpl = globalThis.fetch) {
  if (!up?.fix_pr) return null;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${up.repo}/pulls/${up.fix_pr}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentic-flow-t3-workarounds' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return ['PENDING', `upstream ${up.repo}#${up.fix_pr}: GitHub HTTP ${r.status}`];
    const d = await r.json();
    if (d.merged_at) return ['REMOVE', `upstream fix ${up.repo}#${up.fix_pr} merged ${d.merged_at}; if the installed T3 contains it, remove the workaround`];
    return ['OK', `upstream fix ${up.repo}#${up.fix_pr} not merged (${d.state}); workaround still needed`];
  } catch (err) {
    return ['PENDING', `upstream ${up.repo}#${up.fix_pr}: ${err.message}`];
  }
}

/** `t3 thread show --json <thread>` must print the thread's title (thread-title.mjs reads .thread.title). */
export function checkCliShow(t3Bin, thread, run = spawnSync) {
  if (!thread) return ['PENDING', 'no thread id (pass --thread or keep a provider log)'];
  const r = run(t3Bin, ['thread', 'show', '--json', thread], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return ['FAIL', `${t3Bin} thread show --json ${thread}: ${(r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]}`];
  try {
    const d = JSON.parse(r.stdout);
    if (typeof (d?.thread?.title ?? d?.title) === 'string') return ['OK', `${t3Bin} thread show --json prints the title`];
  } catch { /* not JSON */ }
  return ['FAIL', `${t3Bin} thread show --json ${thread}: no thread.title in the output`];
}

/** A missing thread must be named as gone (thread-title.mjs THREAD_GONE): the limit of automatic topics leaves its holder out. */
export function checkCliGone(t3Bin, run = spawnSync) {
  const r = run(t3Bin, ['thread', 'show', '--json', '00000000-0000-4000-8000-000000000000'], { encoding: 'utf8', timeout: 15000 });
  if (r.error) return ['FAIL', `${t3Bin} thread show: ${r.error.message}`];
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0 && THREAD_GONE.test(text)) return ['OK', `${t3Bin} thread show names a missing thread as gone ("${text.split('\n')[0].slice(0, 80)}")`];
  return ['FAIL', `${t3Bin} thread show of a missing thread: exit ${r.status}, "${text.split('\n')[0].slice(0, 80)}" does not match THREAD_GONE (thread-title.mjs)`];
}

/** `t3 thread start --help`: --effort listed means the t3_thread_configure line can go (T3 issue #29863). */
export function checkCliEffort(t3Bin, run = spawnSync) {
  const r = run(t3Bin, ['thread', 'start', '--help'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return ['FAIL', `${t3Bin} thread start --help: ${(r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]}`];
  const help = `${r.stdout || ''}${r.stderr || ''}`;
  if (!/--provider\b/.test(help) || !/--model\b/.test(help)) return ['FAIL', `${t3Bin} thread start --help lists no --provider/--model (topic.mjs passes them)`];
  if (/--effort\b/.test(help)) return ['REMOVE', `${t3Bin} thread start takes --effort: pass it from the class in topic.mjs and drop the t3_thread_configure line`];
  return ['OK', `${t3Bin} thread start has --provider and --model, no --effort; the t3_thread_configure line stays`];
}

/** The installed T3 against the version that fixed the bug (`fixed_in`): the workaround code turns itself off from it. */
export function checkFixedIn(w, version) {
  if (!w.fixed_in) return ['FAIL', 'automatic check "fixed-in" without fixed_in in the registry'];
  if (!version) return ['PENDING', `T3 version unknown (server-runtime.json); the workaround is off from T3 ${w.fixed_in}`];
  if (versionAtLeast(version, w.fixed_in)) return ['OK', `T3 ${version} contains the fix (${w.fixed_in}): the workaround is off here; remove its code once no machine runs T3 < ${w.fixed_in}`];
  return ['OK', `T3 ${version} < ${w.fixed_in}: the workaround stays active; upgrade T3 to drop it`];
}

/** Thread id of the newest provider log (events.mcp-<uuid>.log -> mcp:<uuid>). */
export function newestThread(t3Home) {
  const dir = path.join(t3Home, 'logs', 'provider');
  try {
    const n = fs.readdirSync(dir).filter((f) => /^events\..+\.log$/.test(f)).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f;
    return n ? n.slice(7, -4).replace(/^([a-z]+)-(?=[0-9a-f]{8}-)/, '$1:') : null;
  } catch { return null; }
}

/** Run all checks; returns { version, results: [{ id, status, message }] }. */
export async function checkAll({ t3Home = path.join(os.homedir(), '.t3', 'userdata'), t3Bin = 't3', thread, since, upstream = true, fetchImpl, run, registry = REGISTRY } = {}) {
  const rt = t3Runtime(t3Home);
  const from = since ?? rt.startedAt;
  const results = [];
  const add = (id, r) => { if (r) results.push({ id, status: r[0], message: r[1] }); };
  for (const w of readRegistry(registry)) {
    for (const a of w.auto) {
      if (a === 'provider-log') add(w.id, checkProviderLog(t3Home, from));
      else if (a === 'upstream') add(w.id, upstream ? await checkUpstream(w.upstream, fetchImpl) : ['PENDING', 'upstream check skipped']);
      else if (a === 'cli-show') add(w.id, checkCliShow(t3Bin, thread ?? newestThread(t3Home), run));
      else if (a === 'cli-gone') add(w.id, checkCliGone(t3Bin, run));
      else if (a === 'cli-effort') add(w.id, checkCliEffort(t3Bin, run));
      else if (a === 'fixed-in') add(w.id, checkFixedIn(w, rt.version));
      else add(w.id, ['FAIL', `unknown automatic check "${a}"`]);
    }
    if (w.pilot) add(w.id, ['MANUAL', w.pilot]);
  }
  return { version: rt.version, results };
}

export function formatResults({ version, results }) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const lines = results.map((r) => `${r.status} ${r.id}: ${r.message}`);
  lines.push(`t3 ${version ?? 'unknown'}: ${['OK', 'FAIL', 'PENDING', 'REMOVE', 'MANUAL'].map((s) => `${count(s)} ${s.toLowerCase()}`).join(', ')}; MANUAL and PENDING go to the workflow maintainer (error.mjs report) for the pilot check`);
  return lines.join('\n');
}
