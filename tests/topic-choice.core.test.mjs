// keep: core
// P-012 (operator 2026-11-17: "ak sa téma nezhoduje alebo sa zmenila, nech flow spraví výzvu, či zmeniť tému alebo pokračovať
// v už existujúcej"): a thread without a topic is asked where the work goes at its first step of work (a write, also into the
// work files, a skill script, an Artifact, a worker), the open topic the judge names first; the workflow's own scripts pass;
// the step passes only after the operator answered a dialog, and "Bez témy" is not asked again. A task off the held topic
// is refused likewise until the operator answered (no plain repeat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { driftFile } from '../scripts/drift.mjs';
import { threadStateFile } from '../scripts/config.mjs';

const OFF = { env: { WORKFLOW_DRIFT_JUDGE: 'off' } };
const state = (fx) => JSON.parse(fs.readFileSync(threadStateFile(fx.brain, fx.thread), 'utf8'));
const patchState = (fx, patch) => fs.writeFileSync(threadStateFile(fx.brain, fx.thread), JSON.stringify({ ...state(fx), ...patch }));
const verdict = (fx, v) => { const f = driftFile(fx.brain, fx.thread); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ started_at: state(fx).turn_started_at, ...v })); };
const pre = (fx, tool, input) => fx.hook('pre-tool-use.mjs', { tool_name: tool, tool_input: input }, OFF).json.hookSpecificOutput || {};
const answered = (fx) => patchState(fx, { dialog_answered_at: new Date(Date.parse(state(fx).turn_started_at) + 1000).toISOString() });

test('a thread without a topic: the first step of work asks where it goes; workflow scripts pass; after the answer "Bez témy" it is not asked again', () => {
  const fx = setup();
  try {
    // Another thread holds the topic the task continues.
    const r0 = fx.run('topic.mjs', ['create', 'uprava-skillu', '--subject', 'Úprava skillu nahodenie produktu', '--class', 'ops'], { env: { WORKFLOW_THREAD_ID: 'other' } });
    assert.equal(r0.status, 0, r0.out);
    fx.hook('user-prompt-submit.mjs', { prompt: 'priprav stroj na skill nahodenie-produktu a over prístup' }, OFF);
    assert.ok(state(fx).topic_gate, 'the operator task of a thread without a topic is gated');
    let d = pre(fx, 'Bash', { command: 'node .claude/skills/nahodenie-produktu/check-access.mjs --init' });
    assert.equal(d.permissionDecision, 'deny', 'a skill script is work');
    assert.match(d.permissionDecisionReason, /holds no topic and this step runs a skill script/);
    assert.match(d.permissionDecisionReason, /AskUserQuestion/);
    assert.match(d.permissionDecisionReason, /"Nová téma"/);
    assert.match(d.permissionDecisionReason, /"Bez témy" \(what the work leaves stays only in/);
    assert.match(d.permissionDecisionReason, /uprava-skillu \("Úprava skillu/, 'the open topics are named');
    // The judge named the open topic: it is the recommended option, with what to do about its holder.
    verdict(fx, { fits: false, no_topic: true, reason: 'príprava stroja na skill', belongs_to: 'uprava-skillu', topic: null });
    d = pre(fx, 'Write', { file_path: path.join(fx.project, 'notes.md'), content: 'x' });
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /"Pokračovať v téme uprava-skillu" \(recommended: príprava stroja na skill; held by another thread/);
    // A plain repeat does not pass; the workflow's own scripts do (claim or create the chosen topic).
    assert.equal(pre(fx, 'Write', { file_path: path.join(fx.project, 'notes.md'), content: 'x' }).permissionDecision, 'deny');
    assert.notEqual(pre(fx, 'Bash', { command: 'node ~/.claude/skills/workflow/bin/topic.mjs create nova --subject "Nová" --class ops' }).permissionDecision, 'deny');
    assert.notEqual(pre(fx, 'Bash', { command: 'ls -la' }).permissionDecision, 'deny', 'reading is no work');
    assert.match(pre(fx, 'Artifact', { file_path: path.join(fx.project, 'page.html') }).permissionDecisionReason || '', /this step shows a page to the operator/);
    assert.match(pre(fx, 'mcp__t3-code__html_preview', { path: path.join(fx.project, 'page.html') }).permissionDecisionReason || '', /this step shows a page to the operator/);
    assert.match(pre(fx, 'Agent', { description: 'x', prompt: `work files only in ${path.join(fx.project, 'scratch')}/` }).permissionDecisionReason || '', /this step starts a worker/);
    // The operator answered "Bez témy": the step passes and the thread is not asked again.
    answered(fx);
    assert.notEqual(pre(fx, 'Write', { file_path: path.join(fx.project, 'notes.md'), content: 'x' }).permissionDecision, 'deny');
    assert.ok(state(fx).no_topic_ok);
    fx.hook('user-prompt-submit.mjs', { prompt: 'a ďalšiu dávku' }, OFF);
    assert.ok(!state(fx).topic_gate);
    assert.notEqual(pre(fx, 'Bash', { command: 'node .claude/skills/nahodenie-produktu/publish-batch.mjs d1' }).permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('a task off the held topic: refused until the operator answered the dialog (switch, new topic or continue), not by a plain repeat', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'beta', '--subject', 'Beta web', '--class', 'ops']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'mimochodom zálohuj server' }, OFF);
    assert.ok(!state(fx).topic_gate, 'a thread with a topic has the drift judge, not the gate');
    verdict(fx, { fits: false, reason: 'zálohovanie servera', topic: 'beta', subject: 'Beta web' });
    const write = () => pre(fx, 'Write', { file_path: path.join(fx.project, 'backup.sh'), content: 'x' });
    let d = write();
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /AskUserQuestion.*"Nová téma" \(recommended.*"Pokračovať v téme beta" \(never the recommended one\)/);
    assert.equal(write().permissionDecision, 'deny', 'a repeat without the answer is refused');
    answered(fx);
    assert.notEqual(write().permissionDecision, 'deny', 'after the answer the step passes');
  } finally { fx.cleanup(); }
});
