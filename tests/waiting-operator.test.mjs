// P-061 (V1, phase 2): the dialog AskUserQuestion holds the turn, so the thread cannot pick up mail. PreToolUse flags the open
// turn record in the mail (`comms turn --waiting-operator true`, bound to the turn's opened_at), PostToolUse clears it; the
// mail then answers a sender `otázka` instead of "no reply" (agentic-comms tests/waiting-operator.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

function stubbed(state = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const logFile = path.join(fx.root, 'stub-log.jsonl');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: logFile });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fx.flagCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((a) => a[0] === 'turn' && a.includes('--waiting-operator'));
  return fx;
}

const ASK = { tool_name: 'AskUserQuestion', tool_input: { questions: [] } };

test('PreToolUse AskUserQuestion flags the open turn waiting_operator (bound to opened_at); PostToolUse clears it', () => {
  const fx = stubbed({ opened_at: '2026-11-11T10:00:00.000Z' });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.deepEqual(fx.flagCalls(), [], 'no flag before a dialog');
    fx.hook('pre-tool-use.mjs', ASK);
    const [on] = fx.flagCalls();
    assert.equal(on[on.indexOf('--waiting-operator') + 1], 'true');
    assert.equal(on[on.indexOf('--opened-at') + 1], '2026-11-11T10:00:00.000Z', 'bound to the open turn record');
    fx.hook('post-tool-use.mjs', { ...ASK, tool_response: 'ok' });
    const calls = fx.flagCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][calls[1].indexOf('--waiting-operator') + 1], 'false');
    // other tools and subagent dialogs never touch the flag
    fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: 'ok' });
    fx.hook('pre-tool-use.mjs', { ...ASK, agent_id: 'sub-1' });
    assert.equal(fx.flagCalls().length, 2);
  } finally { fx.cleanup(); }
});

test('an outage or an older mail client never blocks the dialog', () => {
  const fx = stubbed({ down: true });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const out = fx.hook('pre-tool-use.mjs', ASK).json?.hookSpecificOutput?.permissionDecision;
    assert.notEqual(out, 'deny');
    assert.ok(JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8')).dialog_at, 'the dialog time is still kept');
  } finally { fx.cleanup(); }
});

test('integration with the real mail: the flag lands on the open turn record and goes away with the dialog', { skip: commsClient() ? false : 'agentic-comms not found' }, async () => {
  const fx = setup();
  const comms = await startComms(fx, { senders: ['alice'] });
  try {
    const flag = () => JSON.parse(fs.readFileSync(path.join(comms.dataDir, 'turns', `${fx.thread}.json`), 'utf8')).waiting_operator;
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.ok(!flag());
    fx.hook('pre-tool-use.mjs', ASK);
    assert.equal(flag(), true);
    fx.hook('post-tool-use.mjs', { ...ASK, tool_response: 'ok' });
    assert.equal(flag(), false);
    fx.hook('pre-tool-use.mjs', ASK);
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotovo.\n\nStav: hotovo' });
    assert.equal(flag(), false, 'the end of the turn clears the flag');
  } finally { await comms.stop(); fx.cleanup(); }
});
