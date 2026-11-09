// Error report to the workflow maintainer (P-003 step 5), decided by code, not by the agent: mail to the maintainer topic
// when this mail service has it, else an issue in the public workflow repo, else a draft for the operator. Only a
// delivered message or a created issue counts as reported (operator 2026-11-07: an instance without the maintainer topic
// said "reported" while the message stayed held on its own server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commsSettings, runClient, parseAddress } from './comms.mjs';
import { DEFAULT_TOKEN_FILE, DEFAULT_API_URL, gh } from './github.mjs';
import { PLUGIN_ROOT, toPosix } from './util.mjs';
import { SCRATCH_DIR, channelOf } from './config.mjs';

// Defaults; `policy.maintainer` ({comms, repo}) of the brain overrides (another maintainer, a fork).
export const MAINTAINER = { comms: 'maintainer/workflow-dev', repo: 'https://github.com/gavalierm/agentic-flow-public.git' };

export function maintainerOf(policy = {}) {
  const m = policy && typeof policy.maintainer === 'object' ? policy.maintainer : {};
  return { comms: m.comms === undefined ? MAINTAINER.comms : m.comms, repo: m.repo === undefined ? MAINTAINER.repo : m.repo };
}

export function repoSlug(url) {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Text for a public issue: machine paths, project and brain names, addresses and secrets of this instance removed. */
export function scrub(text, ctx = {}, env = process.env) {
  let s = String(text || '');
  const home = env.HOME || os.homedir();
  const swap = (from, to) => { if (from && from.length > 1) s = s.split(from).join(to); };
  // Paths first, as sentinels the name pass below cannot touch; longer brain path before the project it may contain.
  const [B, P] = ['\u0001B\u0001', '\u0001P\u0001'];
  for (const [dir, mark] of [[ctx.brainDir, B], [ctx.projectDir, P]].sort((a, b) => String(b[0] || '').length - String(a[0] || '').length)) {
    if (dir) { swap(toPosix(dir), mark); swap(dir, mark); }
  }
  if (home) { swap(toPosix(home), '~'); swap(home, '~'); }
  // Bare project and brain names, longest first (`shop-brain` before `shop`).
  const names = [ctx.projectDir, ctx.brainDir].filter(Boolean).map((d) => path.basename(d)).filter((n) => n.length > 3).sort((a, b) => b.length - a.length);
  for (const name of names) s = s.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '<project>');
  s = s.split(B).join('<brain>').split(P).join('<project>');
  return s
    .replace(/\/home\/[\w.-]+|\/Users\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+/g, '~')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/ghp_[A-Za-z0-9]{20,}|github[_]pat_\w+|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[bap]-[\w-]+|AKIA[0-9A-Z]{16}/g, '<secret>')
    .replace(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d+){2,3}\b/g, '<ip>');
}

function version() {
  try { return `v${JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version}`; } catch { return '?'; }
}

/**
 * Reporter environment for the audit of a report, one `meta: k=v ...` line (the maintainer's issue list reads it): workflow
 * version and channel, os with its version, arch, node, git, harness, shell, T3. No host, user or path (scrub rules).
 */
export function reportMeta(ctx = {}, env = process.env, { run = spawnSync, platform = process.platform } = {}) {
  const out = (cmd, args) => {
    try { const r = run(cmd, args, { encoding: 'utf8', timeout: 5000, env }); return r.status === 0 ? String(r.stdout || '').trim().split('\n')[0] : null; } catch { return null; }
  };
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(ctx.projectDir || '.', '.claude', 'settings.json'), 'utf8')); } catch { /* no claude settings */ }
  let osName = null;
  if (platform === 'linux') {
    try { osName = (fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?$/m) || [])[1] || null; } catch { /* keep null */ }
  } else {
    try { osName = os.version(); } catch { /* keep null */ }
  }
  const harness = env.CLAUDECODE ? 'claude-code' : (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID) ? 'codex' : null;
  const fields = {
    workflow: version(),
    channel: channelOf(settings),
    os: platform,
    os_name: osName,
    os_release: os.release(),
    arch: process.arch,
    node: process.version,
    git: (out('git', ['--version']) || '').replace(/^git version /, '') || null,
    harness,
    harness_version: harness === 'claude-code' ? (out('claude', ['--version']) || '').replace(/\s*\(Claude Code\)/, '') || null : null,
    shell: path.basename(env.SHELL || env.ComSpec || '') || null,
    t3: env.T3CODE_THREAD_ID ? 'yes' : 'no',
  };
  return `meta: ${Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}=${String(v).trim().replace(/\s+/g, '_')}`).join(' ')}`;
}

export function reportsFile(ctx) {
  return path.join(ctx.brainDir || ctx.projectDir, 'local', 'error-reports.json');
}
export function readReports(ctx) {
  try { return JSON.parse(fs.readFileSync(reportsFile(ctx), 'utf8')) || {}; } catch { return {}; }
}
function writeReport(ctx, id, rec) {
  const all = readReports(ctx);
  all[id] = { ...(all[id] || {}), ...rec };
  try { fs.mkdirSync(path.dirname(reportsFile(ctx)), { recursive: true }); fs.writeFileSync(reportsFile(ctx), `${JSON.stringify(all, null, 2)}\n`); } catch { /* the record only helps the late fallback */ }
}

// A maintainer topic this mail server held once is remembered per brain and mail is skipped for a week: every report
// otherwise left the operator another "new topic? / redirect" notice first (agentic-flow-public#20, 12 notices).
export const UNREACHABLE_DAYS = 7;
export function unreachableFile(ctx) {
  return path.join(ctx.brainDir || ctx.projectDir, 'local', 'maintainer-unreachable.json');
}
function serverKey(s, addr) {
  return `${s.instance || toPosix(s.configFile || '') || 'default'}|${addr.project}/${addr.topic}`;
}
function readUnreachable(ctx) {
  try { return JSON.parse(fs.readFileSync(unreachableFile(ctx), 'utf8')) || {}; } catch { return {}; }
}
function rememberUnreachable(ctx, key) {
  const all = readUnreachable(ctx);
  all[key] = new Date().toISOString();
  try { fs.mkdirSync(path.dirname(unreachableFile(ctx)), { recursive: true }); fs.writeFileSync(unreachableFile(ctx), `${JSON.stringify(all, null, 2)}\n`); } catch { /* only saves a notice */ }
}

/** Mail to the maintainer topic; delivered = accepted pending in a registered topic (not held, not queued in the outbox). */
export function mailReport(ctx, text, maintainer = maintainerOf(ctx.policy)) {
  if (!maintainer.comms) return { ok: false, why: 'no maintainer topic configured' };
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, why: `mail not configured (${s.reason || 'off'})` };
  const addr = parseAddress(maintainer.comms, s.project);
  if (!addr || addr.persona) return { ok: false, why: `bad maintainer address ${maintainer.comms}` };
  const key = serverKey(s, addr);
  const seen = readUnreachable(ctx)[key];
  if (seen && Date.now() - Date.parse(seen) < UNREACHABLE_DAYS * 86400000) return { ok: false, why: `maintainer topic ${maintainer.comms} not on this mail server (held ${seen.slice(0, 10)}; mail skipped)` };
  const res = runClient(ctx, ['send', '--text', '-', '--level', 'assist', '--project', addr.project, '--topic', addr.topic], { input: text });
  if (!res.ok) return { ok: false, why: `mail ${res.error || 'failed'}` };
  const d = res.data || {};
  if (d.queued) return { ok: false, why: 'mail unavailable (queued in the outbox)', id: d.id };
  if (d.state === 'held') rememberUnreachable(ctx, key);
  if (d.state !== 'pending' || !d.id) return { ok: false, why: `maintainer topic ${maintainer.comms} not on this mail server (message ${d.state || '?'}${d.notice_id ? `, notice ${d.notice_id}` : ''})`, id: d.id, notice: d.state === 'held' ? d.notice_id || null : null };
  return { ok: true, id: d.id, expires_at: d.expires_at || null, to: `${addr.project}/${addr.topic}` };
}

/** Issue in the maintainer repo with this machine's GitHub access: token file, else the gh CLI. */
export async function issueReport(ctx, title, body, maintainer = maintainerOf(ctx.policy), env = process.env) {
  const slug = repoSlug(maintainer.repo);
  if (!slug) return { ok: false, why: 'no maintainer repo configured' };
  const t = scrub(title, ctx, env).slice(0, 120);
  const b = `${scrub(body, ctx, env)}\n\n---\nreported by error.mjs report (the maintainer topic was not reachable)`;
  const tokenFile = env.WORKFLOW_GITHUB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  let token = null;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch { /* try gh */ }
  if (token) {
    try {
      const r = await gh(env.WORKFLOW_GITHUB_API || DEFAULT_API_URL, token, 'POST', `/repos/${slug}/issues`, { title: t, body: b });
      if (r.status === 201 && r.json.html_url) return { ok: true, url: r.json.html_url, slug };
      return { ok: false, why: `GitHub issue in ${slug} failed (HTTP ${r.status})` };
    } catch (err) { return { ok: false, why: `GitHub issue in ${slug} failed (${err.message})` }; }
  }
  const cli = spawnSync(env.WORKFLOW_GH_CLI || 'gh', ['issue', 'create', '-R', slug, '--title', t, '--body-file', '-'], { input: b, encoding: 'utf8', timeout: 30000 });
  const url = /https:\/\/\S+\/issues\/\d+/.exec(cli.stdout || '');
  if (cli.status === 0 && url) return { ok: true, url: url[0], slug };
  return { ok: false, why: cli.error ? `no GitHub access (no ${toPosix(tokenFile).replace(env.HOME || os.homedir(), '~')}, no gh)` : `gh issue create in ${slug} failed: ${(cli.stderr || '').trim().split('\n')[0]}` };
}

function draft(ctx, title, body, why) {
  const file = path.join(ctx.projectDir, SCRATCH_DIR, `error-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${title}\n\n${body}\n\nnot reported: ${why.join('; ')}\n`);
  return file;
}

/**
 * One report: mail, else issue, else draft. Returns the line for the agent; `reported` only after delivery or a created
 * issue. `fromId`: a mailed report that got no reply or bounced (no-reply / undelivered bell) goes on as an issue.
 */
export async function report(ctx, { text, title, fromId } = {}, env = process.env) {
  const m = maintainerOf(ctx.policy);
  const why = [];
  let held = null;
  if (fromId) {
    const rec = readReports(ctx)[fromId];
    if (!rec) return { reported: false, line: `no error report ${fromId} recorded on this machine; send it again: error.mjs report --text "..."` };
    if (rec.issue) return { reported: true, line: `error report ${fromId} already reported: ${rec.issue}` };
    text = rec.text; title = rec.title;
    why.push(`mail ${fromId} not picked up by the maintainer`);
  } else {
    // The environment travels with the text: the mail, the issue and the draft carry it, and so does --from later.
    text = `${String(text || '').trimEnd()}\n\n${reportMeta(ctx, env)}`;
    const mail = mailReport(ctx, text, m);
    if (mail.ok) {
      writeReport(ctx, mail.id, { text, title, at: new Date().toISOString(), to: mail.to });
      return { reported: true, line: `reported: mail ${mail.id} -> ${mail.to}; without pickup by ${mail.expires_at || 'the deadline'} the bell says no reply / undelivered: then error.mjs report --from ${mail.id} (P-003)` };
    }
    why.push(mail.why);
    held = mail.notice || null;
  }
  const issue = await issueReport(ctx, title, text, m, env);
  // The held copy only leaves the operator a "new topic?" notice about nothing (operator 2026-11-07: an instance asked
  // what to do with three such notices); the sender withdraws its own message, also when the report ends as a draft.
  let tail = '';
  if (held) tail = runClient(ctx, ['decide', '--notice', held, '--decision', 'discard']).ok ? `; held mail copy discarded (notice ${held})` : `; held mail copy stays (notice ${held}): the operator may discard it`;
  if (issue.ok) {
    if (fromId) writeReport(ctx, fromId, { issue: issue.url });
    return { reported: true, line: `reported: issue ${issue.url} (${why.join('; ')})${tail}; tell the operator the link (P-003)` };
  }
  why.push(issue.why);
  const file = draft(ctx, title, text, why);
  return { reported: false, line: `NOT reported: ${why.join('; ')}${tail}. Tell the operator it was not reported and give them ${toPosix(file)} (do not write "reported", P-019)` };
}
