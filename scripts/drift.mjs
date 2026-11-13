// Topic drift (P-012): does the operator's new task fit the subject of the topic the thread holds? UserPromptSubmit starts
// a judge DETACHED (the hook never waits for a model); the judge writes its verdict for that turn to
// <brain>/local/drift/<thread>.json (a file of its own: a read-modify-write of the thread state by the running turn
// would overwrite a late verdict). PreToolUse reads the verdict and refuses the first write of the turn once.
// A missing, late or failed verdict refuses nothing (an outage must not block work).
// WORKFLOW_DRIFT_JUDGE=off disables the judge; WORKFLOW_DRIFT_JUDGE_CMD is a command (gets the prompt on stdin, prints the JSON).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './util.mjs';

const SELF = fileURLToPath(import.meta.url);
const JOB_ENV = 'WORKFLOW_DRIFT_JOB';

const SCHEMA = {
  type: 'object',
  properties: { fits: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['fits', 'reason'],
};

export function driftFile(brainDir, thread) {
  const name = encodeURIComponent(String(thread)).replace(/\*/g, '%2A');
  return path.join(brainDir, 'local', 'drift', `${name}.json`);
}

/** Verdict of the judge for the turn that started at `startedAt`, or null. */
export function readDrift(brainDir, thread, startedAt) {
  if (!brainDir || !thread || !startedAt) return null;
  const v = readJson(driftFile(brainDir, thread), null);
  return v && v.started_at === startedAt && typeof v.fits === 'boolean' ? v : null;
}

/** The operator's own words: pasted material is not the task. */
export function ownWords(prompt) {
  return String(prompt || '').replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function driftPrompt({ subject, state, next, handover, task }) {
  return [
    'You check whether a new task from an operator belongs to the topic an agent is working on. Answer only with the JSON object {"fits": boolean, "reason": string}.',
    'fits=true when the task continues, corrects, answers or extends the topic (also a short reply, a follow-up, a change request to the same thing, housekeeping of the same work).',
    'fits=false only when the task is clearly a different subject that should get its own topic (another product, domain or project, an unrelated job). When in doubt, fits=true.',
    'reason: one short sentence in the language of the task, naming what the task is about.',
    '',
    `# Topic subject\n${subject}`,
    `# Topic state\n${state || '-'}`,
    next ? `# Next step of the topic\n${next}` : '',
    handover ? `# Handover of the topic\n${String(handover).slice(0, 2000)}` : '',
    `# New task from the operator\n${task.slice(0, 3000)}`,
  ].filter(Boolean).join('\n');
}

/** Run the judge; returns { fits, reason } or null when it ran no verdict (off, CLI missing or failing). */
export function judgeDrift(job, { run = spawnSync } = {}) {
  if (process.env.WORKFLOW_DRIFT_JUDGE === 'off') return null;
  const prompt = driftPrompt(job);
  const custom = process.env.WORKFLOW_DRIFT_JUDGE_CMD;
  const res = custom
    ? run('sh', ['-c', custom], { input: prompt, encoding: 'utf8', timeout: 90_000 })
    : run('claude', ['-p', '--model', 'haiku', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA)], { input: prompt, encoding: 'utf8', timeout: 90_000, cwd: '/' });
  if (!res || res.status !== 0 || !res.stdout) return null;
  try {
    let data = JSON.parse(res.stdout);
    if (data && data.structured_output) data = data.structured_output;
    else if (data && typeof data.result === 'string') data = JSON.parse(data.result.replace(/^```(json)?|```$/g, '').trim());
    if (typeof data.fits !== 'boolean') return null;
    return { fits: data.fits, reason: String(data.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  } catch {
    return null;
  }
}

/**
 * Start the judge detached and return at once. `job`: { brainDir, thread, startedAt, topic, subject, state, next, handover, task }.
 * Returns false when no judge starts (off, nothing to compare).
 */
export function startDriftJudge(job) {
  if (process.env.WORKFLOW_DRIFT_JUDGE === 'off' || !job.brainDir || !job.thread || !job.subject || !job.task) return false;
  try {
    const child = spawn(process.execPath, [SELF], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, [JOB_ENV]: JSON.stringify(job) } });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function main() {
  const job = JSON.parse(process.env[JOB_ENV] || '{}');
  if (!job.brainDir || !job.thread || !job.startedAt) return;
  const verdict = judgeDrift(job);
  if (!verdict) return;
  writeJson(driftFile(job.brainDir, job.thread), { started_at: job.startedAt, fits: verdict.fits, reason: verdict.reason, topic: job.topic, subject: job.subject });
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  try { main(); } catch { /* a failed judge refuses nothing */ }
}
