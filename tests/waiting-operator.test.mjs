// P-061 (V1, phase 2): the dialog AskUserQuestion holds the turn, so the thread cannot pick up mail. PreToolUse flags the open
// turn record in the mail (`comms turn --waiting-operator true`, bound to the turn's opened_at), PostToolUse clears it; the
// mail then answers a sender `otázka` instead of "no reply" (agentic-comms tests/waiting-operator.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient, PLUGIN_ROOT } from './helpers.mjs';
import { WATCH_INTERVAL_MS } from '../hooks/post-tool-use.mjs';

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

test('P-061: PreToolUse AskUserQuestion flags the open turn waiting_operator (bound to opened_at); PostToolUse clears it', () => {
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

test('P-061: an outage or an older mail client never blocks the dialog', () => {
  const fx = stubbed({ down: true });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const out = fx.hook('pre-tool-use.mjs', ASK).json?.hookSpecificOutput?.permissionDecision;
    assert.notEqual(out, 'deny');
    assert.ok(JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8')).dialog_at, 'the dialog time is still kept');
  } finally { fx.cleanup(); }
});

test('P-061: integration with the real mail: the flag lands on the open turn record and goes away with the dialog', { skip: commsClient() ? false : 'agentic-comms not found' }, async () => {
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

// D-0015, D-0022: while the thread discusses with the operator (the operator started the turn, or the last turn ended
// `Stav: otázka`), its turn shows no steer/assist line; a blocker passes. The turn record tells the mail (`--discussion`),
// so it holds back their rings; an older client that refuses the option gets the call again without it.

const MAIL = [{ id: 'st9', level: 'steer' }, { id: 'ax9', level: 'assist' }, { id: 'bk9', level: 'blocker' }];
const BASH = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } };
const QUESTION = 'Návrh je hotový.\n\n**Otázky na operátora:** Variant A alebo B? Odporúčam A.\n\nStav: otázka';
const opt = (a, k) => (a.includes(`--${k}`) ? a[a.lastIndexOf(`--${k}`) + 1] : undefined);
const turnCalls = (fx) => {
  const log = path.join(fx.root, 'stub-log.jsonl');
  return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((a) => a[0] === 'turn' && !a.includes('--waiting-operator'));
};
const threadFile = (fx) => path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
const watchDue = (fx) => {
  const st = JSON.parse(fs.readFileSync(threadFile(fx), 'utf8'));
  fs.writeFileSync(threadFile(fx), JSON.stringify({ ...st, watch_at: Date.now() - WATCH_INTERVAL_MS - 1 }));
};

test('D-0022: discussionMail keeps blockers and replies; turnDiscussion: operator turn, after otázka, keepalive keeps it', async () => {
  const { discussionMail, turnDiscussion } = await import('../scripts/comms.mjs');
  const mail = { available: true, count: 4, blockers: 1, steers: 1, items: [...MAIL, { id: 'r9', level: 'assist', reply_to: 'm0' }] };
  const kept = discussionMail(mail);
  assert.deepEqual(kept.items.map((it) => it.id), ['bk9', 'r9']);
  assert.equal(kept.count, 2);
  assert.equal(kept.blockers, 1);
  assert.equal(kept.steers, 0);
  assert.deepEqual(discussionMail({ available: true, count: 3, blockers: 2 }).count, 2, 'older server without items: its blockers');
  assert.equal(turnDiscussion('operator', {}), true);
  assert.equal(turnDiscussion('wake', { last_end_state: 'otázka' }), true);
  assert.equal(turnDiscussion('wake', { last_end_state: 'hotovo' }), false);
  assert.equal(turnDiscussion('keepalive', { discussion: true }, 'keepalive'), true);
  assert.equal(turnDiscussion('keepalive', { discussion: true }, 'continue'), false);
});

test('D-0015, D-0022: a discussion shows only the blocker (prompt and tool lines), tells the mail; after hotovo steer and assist show', () => {
  const fx = stubbed({ messages: MAIL });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(r.context, /mail: 1 waiting: bk9 blocker/);
    assert.doesNotMatch(r.context, /st9|ax9/);
    assert.equal(opt(turnCalls(fx).at(-1), 'discussion'), 'open', 'the operator turn tells the mail');
    watchDue(fx);
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, 'mail waiting: bk9 blocker; read with comms receive --id <id> (P-042)');
    fx.hook('pre-tool-use.mjs', ASK);
    fx.hook('post-tool-use.mjs', { ...ASK, tool_response: 'ok' });
    let stop = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: QUESTION });
    assert.equal(stop.json?.decision, undefined, stop.out);
    let last = turnCalls(fx).at(-1);
    assert.equal(opt(last, 'state'), 'closed');
    assert.equal(opt(last, 'discussion'), 'open', 'a turn ending otázka keeps the discussion open');
    // A bell after the question: the discussion goes on, still only the blocker.
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.match(r.context, /bk9 blocker/);
    assert.doesNotMatch(r.context, /st9|ax9/);
    assert.equal(opt(turnCalls(fx).at(-1), 'discussion'), 'open');
    stop = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotovo.\n\nStav: hotovo' });
    assert.equal(stop.json?.decision, undefined, stop.out);
    last = turnCalls(fx).at(-1);
    assert.equal(opt(last, 'discussion'), 'closed', 'hotovo closes the discussion');
    // The discussion ended: the next bell shows steer and assist again.
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.match(r.context, /st9 steer/);
    assert.match(r.context, /ax9 assist/);
    assert.equal(opt(turnCalls(fx).at(-1), 'discussion'), 'closed');
    watchDue(fx);
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.match(r.context, /st9 steer/, 'the tool line names the steer again');
  } finally { fx.cleanup(); }
});

test('D-0015: an older mail client that refuses --discussion gets the turn call again without it; the hooks do not fail', () => {
  const fx = stubbed({ messages: MAIL, turn_unknown: ['discussion'], opened_at: '2026-11-11T10:00:00.000Z' });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.equal(r.status, 0, r.out);
    const [first, retry] = turnCalls(fx);
    assert.equal(opt(first, 'discussion'), 'open');
    assert.equal(retry.includes('--discussion'), false);
    assert.equal(JSON.parse(fs.readFileSync(threadFile(fx), 'utf8')).turn_opened_at, '2026-11-11T10:00:00.000Z', 'the retry recorded the turn');
    const stop = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotovo.\n\nStav: hotovo' });
    assert.equal(stop.status, 0, stop.out);
    const closed = turnCalls(fx).filter((a) => opt(a, 'state') === 'closed');
    assert.equal(closed.length, 2);
    assert.equal(closed[1].includes('--discussion'), false);
    assert.equal(opt(closed[1], 'opened-at'), '2026-11-11T10:00:00.000Z', 'the other options stay');
  } finally { fx.cleanup(); }
});

test('D-0015: integration with the real mail: the turn record carries the discussion (an older mail still records the turn)', { skip: commsClient() ? false : 'agentic-comms not found' }, async () => {
  const fx = setup();
  const comms = await startComms(fx, { senders: ['alice'] });
  try {
    const rec = () => JSON.parse(fs.readFileSync(path.join(comms.dataDir, 'turns', `${fx.thread}.json`), 'utf8'));
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.equal(rec().state, 'open');
    if ('discussion' in rec()) assert.equal(rec().discussion, true);
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotovo.\n\nStav: hotovo' });
    assert.equal(rec().state, 'closed');
    if ('discussion' in rec()) assert.equal(rec().discussion, false);
  } finally { await comms.stop(); fx.cleanup(); }
});
