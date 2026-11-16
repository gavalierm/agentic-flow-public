// Error report to the workflow maintainer (spec 7.3 to 7.5, P-003 step 5), decided by code, not by the agent: mail, sent
// once, under the key report-<fp> of the maintainer's project (its intake delivers it to the maintainer topic). No pickup
// (no reply, undelivered) puts it into Úlohy pre operátora and it is never sent again; mail that cannot be sent leaves a
// draft in the held topic (git) and a task with its path. No issue: the operator files one if they see fit (7.5, the
// text may carry client data). Only a delivered message counts as reported (operator 2026-11-07).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commsSettings, runClient, parseAddress } from './comms.mjs';
import { PLUGIN_ROOT, toPosix } from './util.mjs';
import { channelOf } from './config.mjs';
import { parseFrontmatter, asList } from './frontmatter.mjs';
import { LAYOUT, dataPath, dataRel } from './layout.mjs';
import { workDir } from './topic-files.mjs';
import { heldTopics } from './topic.mjs';
import { brainWrite } from './brain.mjs';
import { isMainTopic } from './comms.mjs';

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

/**
 * Names of people the brain knows (memory of type person or operator: name and aliases), for scrub. D-0009 (operator
 * 2026-11-11): flow-public#27 carried the first name of the instance's operator. A generic name ("operator") is no name.
 */
export function peopleNames(brainDir) {
  if (!brainDir) return [];
  let files = [];
  try { files = fs.readdirSync(dataPath(brainDir, 'memory')).filter((f) => f.endsWith('.md')); } catch { return []; }
  const names = new Set();
  for (const f of files) {
    let data;
    try { ({ data } = parseFrontmatter(fs.readFileSync(dataPath(brainDir, 'memory', f), 'utf8'))); } catch { continue; }
    if (!['person', 'operator'].includes(data.type)) continue;
    for (const n of [data.name, ...asList(data.aliases)]) {
      for (const w of String(n || '').split(/[\s,]+/)) if (/^\p{Lu}\p{L}{2,}$/u.test(w)) names.add(w);
    }
  }
  return [...names];
}

/** A name with its Slovak and Czech case endings ("Štepán", "Štepánovi"; "Hana", "Hany"). */
function nameRe(name) {
  const stem = name.length >= 4 && /[aeiouyáéíóúý]$/iu.test(name) ? name.slice(0, -1) : name;
  return new RegExp(`(?<!\\p{L})${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}*`, 'gu');
}

/**
 * Text for a public issue: machine paths, project and brain names, names of known people, addresses and secrets of this
 * instance removed. Client data in the wording (categories, figures) code cannot tell: the agent writes the report in
 * general terms (skill error, step 5, D-0009). Idempotent: the mail path scrubs the report and the issue path scrubs it
 * again (a project named `project` turned `<project>` into `<<project>>`), so placeholders already in the text stay.
 */
const PLACEHOLDERS = ['<project>', '<brain>', '<person>', '<email>', '<secret>', '<ip>'];
export function scrub(text, ctx = {}, env = process.env) {
  let s = String(text || '');
  PLACEHOLDERS.forEach((p, i) => { s = s.split(p).join(`\u0002${i}\u0002`); });
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
  for (const name of peopleNames(ctx.brainDir).sort((a, b) => b.length - a.length)) s = s.replace(nameRe(name), '<person>');
  s = s.split(B).join('<brain>').split(P).join('<project>');
  s = s
    .replace(/\/home\/[\w.-]+|\/Users\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+/g, '~')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/ghp_[A-Za-z0-9]{20,}|github[_]pat_\w+|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[bap]-[\w-]+|AKIA[0-9A-Z]{16}/g, '<secret>')
    // A private IPv4 has four parts; three (a Windows release such as 10.0.x in the meta line, #24) is no address.
    .replace(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, '<ip>');
  PLACEHOLDERS.forEach((p, i) => { s = s.split(`\u0002${i}\u0002`).join(p); });
  return s;
}

export function version() {
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
  return dataPath(ctx.brainDir || ctx.projectDir, 'local', 'error-reports.json');
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
  return dataPath(ctx.brainDir || ctx.projectDir, 'local', 'maintainer-unreachable.json');
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

/**
 * Topic of a report at the maintainer (3b, D-0022): `report-<fp>`, fp = first 8 hex of sha256(lower-case scrubbed title |
 * workflow version). No client data; the same report of another instance on the same version lands in the same topic, a
 * release with the fix starts a new one.
 */
export function reportTopic(title, ctx = {}, env = process.env, ver = version()) {
  const t = scrub(String(title || ''), ctx, env).trim().toLowerCase();
  return `report-${crypto.createHash('sha256').update(`${t}|${ver}`).digest('hex').slice(0, 8)}`;
}

/**
 * Mail of a report to the maintainer project, topic `topic` (default the maintainer topic itself); delivered = accepted
 * pending in a registered topic (not queued in the outbox). Held with `project_known` (the maintainer's project is on this
 * server, its intake delivers it to the maintainer topic, spec 7.3): counted as mailed, `pending_topic`. Held without it
 * (an older server, or no maintainer here): not reachable, remembered for a week.
 */
export function mailReport(ctx, text, maintainer = maintainerOf(ctx.policy), { topic = null } = {}) {
  if (!maintainer.comms) return { ok: false, why: 'no maintainer topic configured' };
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, why: `mail not configured (${s.reason || 'off'})` };
  const addr = parseAddress(maintainer.comms, s.project);
  if (!addr || addr.persona) return { ok: false, why: `bad maintainer address ${maintainer.comms}` };
  const key = serverKey(s, addr);
  const seen = readUnreachable(ctx)[key];
  if (seen && Date.now() - Date.parse(seen) < UNREACHABLE_DAYS * 86400000) return { ok: false, why: `maintainer topic ${maintainer.comms} not on this mail server (held ${seen.slice(0, 10)}; mail skipped)` };
  const to = { project: addr.project, topic: topic || addr.topic };
  const res = runClient(ctx, ['send', '--text', '-', '--level', 'assist', '--project', to.project, '--topic', to.topic], { input: text });
  if (!res.ok) return { ok: false, why: `mail ${res.error || 'failed'}` };
  const d = res.data || {};
  // A brain without its mail key queues everything (agentic-flow-public#62: a domain brain attached without project.mjs mail).
  if (d.queued) return { ok: false, why: `mail unavailable (queued in the outbox)${s.configFile ? '' : `; this brain has no mail key (<brain>/${LAYOUT.local}/comms.json): project.mjs mail <project dir>`}`, id: d.id };
  if (d.status === 'held' && d.project_known === true && d.id) return { ok: true, id: d.id, expires_at: d.expires_at || null, to: `${to.project}/${to.topic}`, pending_topic: true, notice: d.notice_id || null };
  if (d.status === 'held') rememberUnreachable(ctx, key);
  if (d.status !== 'pending' || !d.id) return { ok: false, why: `maintainer topic ${maintainer.comms} not on this mail server (message ${d.status || '?'}${d.notice_id ? `, notice ${d.notice_id}` : ''})`, id: d.id, notice: d.status === 'held' ? d.notice_id || null : null };
  return { ok: true, id: d.id, expires_at: d.expires_at || null, to: `${to.project}/${to.topic}` };
}

/**
 * Mail of a report straight to the topic whose thread did the work (`--to`, report-3fdc7bf3: a report about a data
 * migration went to a new report topic and an issue while its thread was reachable by mail). Delivered = accepted pending
 * in a registered topic; anything else (no such topic here, held, queued) is not delivered and the report goes on to the
 * maintainer. A held copy leaves a notice the caller withdraws.
 */
export function mailTopicReport(ctx, text, to) {
  const s = commsSettings(ctx);
  if (!s.enabled) return { ok: false, why: `mail not configured (${s.reason || 'off'})` };
  const addr = parseAddress(to, s.project);
  if (!addr || addr.persona) return { ok: false, why: `bad topic address ${to} (use [<project>/]<topic>)` };
  const res = runClient(ctx, ['send', '--text', '-', '--level', 'assist', '--project', addr.project, '--topic', addr.topic], { input: text });
  if (!res.ok) return { ok: false, why: `mail to ${to} ${res.error || 'failed'}` };
  const d = res.data || {};
  if (d.queued) return { ok: false, why: `mail to ${to} unavailable (queued in the outbox)`, queued: d.id || null };
  if (d.status !== 'pending' || !d.id) return { ok: false, why: `topic ${addr.project}/${addr.topic} not reachable by mail (message ${d.status || '?'})`, notice: d.status === 'held' ? d.notice_id || null : null };
  return { ok: true, id: d.id, expires_at: d.expires_at || null, to: `${addr.project}/${addr.topic}` };
}

/** The heading of the operator's tasks in the handover (spec 7.4, 7.5; the section B2 adds to save handover). */
export const OPERATOR_TASKS = 'Úlohy pre operátora';

/** The line that gives the agent the operator task: its text and the step that records it in the handover. */
function taskLine(ctx, item) {
  const topic = heldWork(ctx);
  return `task for the operator (${OPERATOR_TASKS}): ${item}; record it: save.mjs handover ${topic || '<topic>'} --tasks "${item.replace(/"/g, "'")}"`;
}

/** The work topic this thread holds (a draft goes into its folder), else null. */
function heldWork(ctx) {
  if (!ctx.brainDir || !ctx.thread) return null;
  try { return heldTopics(ctx.brainDir, ctx.thread).find((t) => !isMainTopic(t))?.id || null; } catch { return null; }
}

/**
 * Spec 7.5: mail cannot be sent, so the report is kept as a draft in the folder of the held topic (topics/<id>/, in git,
 * written by the brain writer); a thread without a work topic keeps it in its work dir. Returns the path to name.
 */
function draft(ctx, title, body, why) {
  const name = `error-report-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}.md`; // P-049: lowercase
  const content = `# ${title}\n\n${body}\n\nnot sent: ${why.join('; ')}\n`;
  const topic = heldWork(ctx);
  if (topic) {
    const rel = dataRel(ctx.brainDir, 'topics', topic, name);
    try {
      brainWrite(ctx, { internal: true, ops: [{ path: rel, content }], message: `error report draft in topic ${topic} (mail unavailable)` });
      return toPosix(path.join(ctx.brainDir, rel));
    } catch (err) { why.push(`draft not written into topic ${topic} (${err.message.split('\n')[0]}), kept in the work dir`); }
  }
  const file = path.join(workDir(ctx), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return toPosix(file);
}

/**
 * One report, sent once (spec 7.4): mail (to the thread that did the work with `to`, else under report-<fp> to the
 * maintainer), else a draft and an operator task. Returns the line for the agent; `reported` only after delivery.
 * `fromId`: a mailed report that got no reply or bounced (no-reply / undelivered bell): it goes into the operator's tasks,
 * never sent again and never an issue.
 */
export async function report(ctx, { text, title, fromId, to } = {}, env = process.env) {
  const m = maintainerOf(ctx.policy);
  if (fromId) {
    const rec = readReports(ctx)[fromId];
    const what = rec ? `${rec.title} (${fromId} -> ${rec.to})` : `mail ${fromId}`;
    if (rec) writeReport(ctx, fromId, { not_picked: new Date().toISOString() });
    return { reported: false, line: `error report ${fromId} not picked up; it is sent once and never again (spec 7.4). ${taskLine(ctx, `hlásenie chyby workflow nebolo prevzaté: ${what}`)} (P-003)` };
  }
  const why = [];
  let held = null;
  // The environment travels with the text: the mail and the draft carry it. D-0009 holds for mail too: the maintainer's
  // topic and the record get the scrubbed text.
  title = scrub(String(title || ''), ctx, env).trim();
  text = scrub(`${String(text || '').trimEnd()}\n\n${reportMeta(ctx, env)}`, ctx, env);
  if (to) {
    // The thread that did the work hears it first; the maintainer only when it is not reachable.
    const direct = mailTopicReport(ctx, `title: ${title}\n\n${text}`, to);
    if (direct.ok) {
      writeReport(ctx, direct.id, { text, title, at: new Date().toISOString(), to: direct.to });
      return { reported: true, line: `reported: mail ${direct.id} -> ${direct.to} (the thread that did the work); sent once: without pickup by ${direct.expires_at || 'the deadline'} the bell says no reply / undelivered, then error.mjs report --from ${direct.id} gives the operator task (P-003)` };
    }
    why.push(direct.why);
    if (direct.notice) runClient(ctx, ['decide', '--notice', direct.notice, '--decision', 'discard']);
  }
  const mail = mailReport(ctx, `title: ${title}\n\n${text}`, m, { topic: reportTopic(title, ctx, env) });
  if (mail.ok) {
    writeReport(ctx, mail.id, { text, title, at: new Date().toISOString(), to: mail.to, ...(mail.pending_topic ? { pending_topic: true } : {}) });
    const pre = why.length ? `${why.join('; ')}; ` : '';
    return { reported: true, line: `${pre}reported: mail ${mail.id} -> ${mail.to}${mail.pending_topic ? ' (the maintainer intake delivers it to its topic)' : ''}; sent once: without pickup by ${mail.expires_at || 'the deadline'} the bell says no reply / undelivered, then error.mjs report --from ${mail.id} gives the operator task (P-003)` };
  }
  why.push(mail.why);
  held = mail.notice || null;
  // The held copy only leaves the operator a "new topic?" notice about nothing (operator 2026-11-07): the sender withdraws it.
  let tail = '';
  if (held) tail = runClient(ctx, ['decide', '--notice', held, '--decision', 'discard']).ok ? `; held mail copy discarded (notice ${held})` : `; held mail copy stays (notice ${held}): the operator may discard it`;
  const file = draft(ctx, title, text, why);
  const repo = repoSlug(m.repo);
  const item = `hlásenie chyby workflow sa nedalo odoslať (${title}): koncept ${file}${repo ? `; issue v ${repo} založ, ak uznáš (text môže niesť údaje klienta)` : ''}`;
  return { reported: false, line: `NOT reported: ${why.join('; ')}${tail}. ${taskLine(ctx, item)}; do not write "reported" (spec 7.5, P-019)` };
}
