// A project repository becomes usable in T3: Claude Code trust for its folder, the T3 project and its welcome thread.
// These were manual steps at the end of the project skill and an agent skipped them after create/connect (Windows,
// 2026-11-08: no T3 project, no thread, trust written by hand into ~/.claude.json), so project.mjs does them itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnTarget } from './topic.mjs';
export { pendingT3Line } from './wizard.mjs';

export const WELCOME_TITLE = 'vitaj';

/** Claude Code keeps per-folder state in <config>/.claude.json (CLAUDE_CONFIG_DIR, else the home folder). */
export function claudeConfigFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/** Key of a folder in .claude.json `projects`: forward slashes on Windows (C:/Users/...), the path as is elsewhere. */
export function trustKey(dir, platform = process.platform) {
  return platform === 'win32' ? String(dir).replace(/\\/g, '/') : String(dir);
}

/**
 * Accept the trust dialog for a folder (hasTrustDialogAccepted), so the first session there starts the hooks without a
 * prompt. An existing entry is matched in any slash spelling (and any letter case on Windows); the file is backed up to
 * <file>.workflow-bak and replaced atomically. A missing or unreadable file is left alone (no Claude Code there).
 */
export function trustFolder(dir, { file = claudeConfigFile(), platform = process.platform } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, line: `trust: ${file} not found; accept the trust dialog at the first session in ${dir}` }; }
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false, line: `trust: ${file} is not valid JSON, not changed; accept the trust dialog at the first session in ${dir}` }; }
  const want = trustKey(dir, platform);
  const norm = (k) => { const s = String(k).replace(/\\/g, '/').replace(/\/+$/, ''); return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s; };
  const projects = data.projects && typeof data.projects === 'object' ? data.projects : (data.projects = {});
  const key = Object.keys(projects).find((k) => norm(k) === norm(want)) ?? want;
  if (projects[key]?.hasTrustDialogAccepted === true) return { ok: true, line: 'trust: already accepted' };
  projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(`${file}.workflow-bak`, raw);
  const tmp = `${file}.workflow-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return { ok: true, line: `trust: accepted for ${key} (backup ${path.basename(file)}.workflow-bak)` };
}

// Same text as TOPIC_QUESTION in boot.mjs (tests/welcome-topic.test.mjs keeps them equal).
export const WELCOME_TOPIC_QUESTION = 'Aká bude téma?';

export function welcomeMessage(name, repo) {
  return [
    `Vitaj v projekte ${name} (repo ${repo}).`,
    'Toto je uvítacie vlákno projektu: over stavový blok session (brain, pravidlá, témy) a v jednej odpovedi zhrň účel projektu, čo je v repe a v brain, a navrhni prvú tému práce. Nič nemeň.',
    // The Stop hook lets a reply without a topic end only with the start question (stop.mjs topicStart); any other
    // question got NO_TOPIC_REASON and the welcome thread created the proposed topic itself (Alice 2026-11-09).
    `Tému nezakladaj ani nezaberaj: voľbu má operátor. Odpoveď skonči položkou "**Operátor:** ${WELCOME_TOPIC_QUESTION} (návrh: <id> – <predmet>)", tú istú otázku polož dialógom AskUserQuestion s navrhnutou témou ako prvou voľbou, a "Stav: otázka".`,
  ].join('\n');
}

function runCli(command, extra, { run, platform, input }) {
  const cmd = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!cmd.length) return { ok: false, reason: 'command not set' };
  const t = spawnTarget(cmd[0], [...cmd.slice(1), ...extra], { platform });
  const r = run(t.file, t.args, { encoding: 'utf8', input, timeout: 30000, shell: t.shell });
  if (r.error) return { ok: false, reason: r.error.code === 'ENOENT' ? `${cmd[0]} not found on this machine` : r.error.message };
  return { ok: r.status === 0, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), reason: (String(r.stderr || '') || `exit ${r.status}`).trim().split('\n').find((l) => /error|exists/i.test(l)) || `exit ${r.status}` };
}

/**
 * The T3 project for a repository folder and, when the project is new, its welcome thread. Commands come from the brain
 * policy (`project.t3_project_add_command`, `topics.thread_start_command`). Without the CLI (T3 Code without `t3` in PATH)
 * the result lists the same steps for the T3 tools, and `pending` names them for the Stop hook.
 */
export function setupT3(dir, { name, repo = path.basename(dir), policy = {}, welcome = true, run = spawnSync, platform = process.platform, trustFile } = {}) {
  const lines = [trustFolder(dir, { file: trustFile, platform }).line];
  const pending = [];
  const addCmd = policy?.project?.t3_project_add_command ?? 't3 project add';
  const add = runCli(addCmd, ['--title', repo, dir], { run, platform });
  const exists = !add.ok && /already exists/i.test(`${add.stderr || ''}${add.stdout || ''}`);
  let added = false;
  if (add.ok) { added = true; lines.push(`t3: project ${repo} added`); }
  else if (exists) lines.push(`t3: project ${repo} already in T3`);
  else {
    pending.push(`t3_project_create (title ${repo}, workspaceRoot ${dir})`);
    lines.push(`t3: project NOT added (${add.reason}): create it with the T3 tool t3_project_create (title ${repo}, workspaceRoot ${dir})`);
  }
  if (!welcome || exists) return { lines, pending, added };
  const message = welcomeMessage(name || repo, repo);
  const startCmd = policy?.topics?.thread_start_command ?? 't3 thread start --json';
  const start = added ? runCli(startCmd, ['--title', WELCOME_TITLE, dir, '-'], { run, platform, input: message }) : { ok: false, reason: 'the T3 project is not added yet' };
  if (start.ok) lines.push(`t3: welcome thread "${WELCOME_TITLE}" started`);
  else {
    pending.push(`t3_thread_launch (project ${dir}, title ${WELCOME_TITLE}, message: ${message.split('\n')[0]} …)`);
    lines.push(`t3: welcome thread NOT started (${start.reason}): start it with the T3 tool t3_thread_launch in project ${dir}, title "${WELCOME_TITLE}", message:\n${message}`);
  }
  return { lines, pending, added };
}
