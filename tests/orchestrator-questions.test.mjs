// D-0031: a thread of a topic another thread created (its orchestrator) never asks the operator: topic.mjs create records
// the orchestrator (the creating thread and the topic it holds), PreToolUse refuses AskUserQuestion and Stop refuses a reply
// with **Otázky na operátora:** or "Stav: otázka" in such a thread, pointing to mail to the orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { topicThreadMessage } from '../scripts/topic.mjs';

const ASK = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ktorú možnosť zvolíme pre ďalší postup tejto témy, A alebo B, a prečo by sme mali pokračovať práve takto?', options: [{ label: 'A', description: 'možnosť A' }, { label: 'B', description: 'možnosť B' }] }] } };
const topicJson = (fx, id) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'topics', id, 'topic.json'), 'utf8'));
const child = (fx) => ({ env: { WORKFLOW_THREAD_ID: 'child-1' } });
const QUESTION_REPLY = 'Výsledok: návrh.\n\n**Otázky na operátora:**\n- [ ] Zvolíme A? (odporúčam A)\n\nStav: otázka';

function orchestrated() {
  const fx = setup({ thread: 'orch-1' });
  assert.equal(fx.run('topic.mjs', ['create', 'lead', '--subject', 'Lead', '--class', 'discussion', '--here']).status, 0);
  const r = fx.run('topic.mjs', ['create', 'sub', '--subject', 'Sub', '--class', 'discussion', '--for-thread', 'child-1']);
  assert.equal(r.status, 0, r.out);
  return fx;
}

test('D-0031: topic.mjs create for another thread records the orchestrator; a topic the thread takes itself does not', () => {
  const fx = orchestrated();
  try {
    assert.deepEqual(topicJson(fx, 'sub').orchestrator, { topic: 'lead', thread: 'orch-1' });
    assert.equal(topicJson(fx, 'lead').orchestrator, undefined, 'claimed by its creator: no orchestrator');
    assert.match(topicThreadMessage(topicJson(fx, 'sub'), { task: 'urob X' }), /Orchestrátor: lead\. Operátora sa nepýtaj.*comms send --to lead/);
  } finally { fx.cleanup(); }
});

test('D-0031: PreToolUse refuses AskUserQuestion in the thread of an orchestrated topic; the orchestrator itself may ask', () => {
  const fx = orchestrated();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child(fx));
    const out = fx.hook('pre-tool-use.mjs', ASK, child(fx)).json?.hookSpecificOutput || {};
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /comms send --to lead --level blocker.*\*\*Stav:\*\* čakám \(na odpoveď orchestrátora\)/);
    // A decision id lives in one brain only: copied into a handover of another project, save refused it (pilot 2026-11-13).
    assert.doesNotMatch(out.permissionDecisionReason, /D-\d{4}/);
    assert.match(out.permissionDecisionReason, /\(P-064\)$/);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.notEqual(fx.hook('pre-tool-use.mjs', ASK).json?.hookSpecificOutput?.permissionDecision, 'deny', 'the orchestrator asks the operator');
  } finally { fx.cleanup(); }
});

test('D-0031: Stop blocks **Otázky na operátora:** / "Stav: otázka" in an orchestrated topic thread', () => {
  const fx = orchestrated();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child(fx));
    const out = fx.hook('stop.mjs', { last_assistant_message: QUESTION_REPLY }, child(fx)).json || {};
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /orchestrator, topic lead.*comms send --to lead/);
    const waiting = fx.hook('stop.mjs', { last_assistant_message: 'Otázku som poslal orchestrátorovi, pokračujem s A.\n\nStav: čakám (na odpoveď orchestrátora)' }, child(fx)).json || {};
    assert.notEqual(waiting.decision, 'block', waiting.reason);
  } finally { fx.cleanup(); }
});

test('D-0031: a topic from before the record falls back to its creator thread and the topic it holds', () => {
  const fx = orchestrated();
  try {
    const file = path.join(fx.brain, 'topics', 'sub', 'topic.json');
    const t = topicJson(fx, 'sub');
    delete t.orchestrator;
    fs.writeFileSync(file, JSON.stringify(t, null, 2));
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child(fx));
    const out = fx.hook('pre-tool-use.mjs', ASK, child(fx)).json?.hookSpecificOutput || {};
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /--to lead /);
  } finally { fx.cleanup(); }
});

// P-064 (orchestrator 2026-11-13, option A): a step a hook leaves to a confirmation goes to the orchestrator, not the operator.
test('P-064: an ask in an orchestrated topic thread is refused toward the orchestrator; its consent lets the exact call pass once', () => {
  const fx = orchestrated();
  try {
    const call = { tool_name: 'Bash', tool_input: { command: 'git clean -fdx' } };
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' }, child(fx));
    const denied = fx.hook('pre-tool-use.mjs', call, child(fx)).json?.hookSpecificOutput || {};
    assert.equal(denied.permissionDecision, 'deny', 'not left to the operator');
    assert.match(denied.permissionDecisionReason, /comms send --to lead --level blocker.*topic\.mjs consent sub --tool Bash/);
    // Only the orchestrator grants.
    const other = fx.run('topic.mjs', ['consent', 'sub', '--tool', 'Bash', '--target', 'git clean -fdx'], { env: { WORKFLOW_THREAD_ID: 'child-1' } });
    assert.notEqual(other.status, 0);
    assert.match(other.out, /only the orchestrator/);
    const granted = fx.run('topic.mjs', ['consent', 'sub', '--tool', 'Bash', '--target', 'git clean -fdx', '--reason', 'own test']);
    assert.equal(granted.status, 0, granted.out);
    // Another call stays refused; the granted one passes once.
    assert.equal(fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git clean -fd' } }, child(fx)).json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(fx.hook('pre-tool-use.mjs', call, child(fx)).json?.hookSpecificOutput?.permissionDecision, 'allow');
    assert.equal(fx.hook('pre-tool-use.mjs', call, child(fx)).json?.hookSpecificOutput?.permissionDecision, 'deny', 'a consent is spent');
    // The orchestrator's own thread still gets the ask (it talks to the operator).
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(fx.hook('pre-tool-use.mjs', call).json?.hookSpecificOutput?.permissionDecision, 'ask');
  } finally { fx.cleanup(); }
});
