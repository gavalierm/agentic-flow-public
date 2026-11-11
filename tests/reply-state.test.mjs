// Reply protocol of the mail (P-061, incident 2026-11-11: three replies to one message, the last one a new request,
// while the recipient's operator was still deciding): a reply names its state (hotovo | otázka | čakám), a message takes
// one final reply, a reply is never answered by a reply, and an interim state is not reminded as "unanswered".
// Needs agentic-comms next to the plugin (else the integration tests are skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';
import { mailLines } from '../scripts/comms.mjs';
import { PICKED_ASSIST_LINE } from '../hooks/stop.mjs';
import { OPERATOR_TIMER_MS, REPLY_WINDOW_MS } from '../scripts/waker.mjs';

const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
const MIN = 60_000;

const stateFile = (brain, thread) => path.join(brain, 'local', 'threads', `${thread}.json`);
const readState = (brain, thread) => (fs.existsSync(stateFile(brain, thread)) ? JSON.parse(fs.readFileSync(stateFile(brain, thread), 'utf8')) : {});
const patchState = (brain, thread, patch) => {
  fs.mkdirSync(path.dirname(stateFile(brain, thread)), { recursive: true });
  fs.writeFileSync(stateFile(brain, thread), JSON.stringify({ ...readState(brain, thread), ...patch }));
};

/** Two threads: b2 (bob, project-b/beta) asks a1 (alice, project/alpha) with an assist; a1 has picked it up. */
async function exchange() {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
  assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta']).status, 0);
  const ask = (text = 'which variant, A or B?') => {
    const send = fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--text', text]);
    assert.equal(send.status, 0, send.out);
    const id = /sent (\S+) \(assist\)/.exec(send.stdout)[1];
    assert.equal(fx.run('comms.mjs', ['receive', '--id', id]).status, 0);
    return id;
  };
  const reply = (id, state, text, extra = []) => fx.run('comms.mjs', ['send', '--reply-to', id, ...(state ? ['--state', state] : []), ...extra, '--text', text]);
  const a = () => readState(fx.brain, 'a1');
  const b = () => readState(fx.brainB, 'b2');
  const done = async () => { await comms.stop(); fx.cleanup(); };
  return { fx, comms, ask, reply, a, b, done };
}

test('reply has no state: send --reply-to without --state is refused and nothing is sent; čakám needs --wait-for and a waker', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const bare = x.reply(id, null, 'variant A');
    assert.notEqual(bare.status, 0, 'a reply without a state must not pass');
    assert.match(bare.stderr, /--state is required with --reply-to: hotovo\|otázka\|čakám/);
    assert.deepEqual(x.a().picked_assist.map((w) => [w.id, w.state]), [[id, undefined]], 'the refused reply settles nothing');
    assert.match(x.fx.runB('comms.mjs', ['message', '--id', id]).stdout, /\| no answer/, 'nothing reached the service');
    assert.match(x.reply(id, 'neskôr', 'x').stderr, /--state is required/);

    const noWhat = x.reply(id, 'čakám', 'build runs');
    assert.notEqual(noWhat.status, 0); assert.match(noWhat.stderr, /--wait-for/);
    const noWaker = x.reply(id, 'čakám', 'build runs', ['--wait-for', 'build 42']);
    assert.notEqual(noWaker.status, 0); assert.match(noWaker.stderr, /without a waker/);
    assert.equal(x.fx.run('timer.mjs', ['--in', '30m', '--then', 'check build 42']).status, 0);
    const waits = x.reply(id, 'čakám', 'build runs', ['--wait-for', 'build 42']);
    assert.equal(waits.status, 0, waits.out);
    assert.match(waits.stdout, /\| state čakám/);
    assert.deepEqual(x.a().picked_assist.map((w) => [w.id, w.state, w.wait_for]), [[id, 'čakám', 'build 42']]);
    assert.match(x.reply(id, 'hotovo', 'x', ['--wait-for', 'y']).stderr, /--wait-for belongs to --state čakám/);
    assert.match(x.fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--state', 'hotovo', '--text', 'x']).stderr, /belong to a reply/);
  } finally { await x.done(); }
});

test('otázka is not reminded as unanswered: the picked assist stays marked, Stop queues no line; hotovo settles it', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const q = x.reply(id, 'otázka', 'the operator decides; I recommend A');
    assert.equal(q.status, 0, q.out);
    assert.match(q.stdout, new RegExp(`-> reply to ${id} \\| state otázka`));
    assert.deepEqual(x.a().picked_assist.map((w) => [w.id, w.state]), [[id, 'otázka']], 'kept and marked, not settled');
    patchState(x.fx.brain, 'a1', { turn_source: 'operator' });
    x.fx.hook('stop.mjs', {});
    assert.doesNotMatch((x.a().pending_signals || []).join('\n'), /picked assist unanswered/, 'an answered otázka is not reminded');
    assert.match(x.fx.run('comms.mjs', ['status']).stdout, new RegExp(`picked assist, final reply due: ${id} from bob \\(otázka\\)`));

    // a second message without any reply is still reminded, alone
    const id2 = x.ask('second question');
    x.fx.hook('stop.mjs', {});
    const lines = (x.a().pending_signals || []).filter((s) => s.startsWith('picked assist unanswered'));
    assert.deepEqual(lines, [PICKED_ASSIST_LINE([{ id: id2 }])]);
    assert.doesNotMatch(lines[0], new RegExp(id));

    const fin = x.reply(id, 'hotovo', 'the operator chose A');
    assert.equal(fin.status, 0, fin.out);
    assert.deepEqual(x.a().picked_assist.map((w) => w.id), [id2], 'the final reply settles the picked assist');
  } finally { await x.done(); }
});

test('second reply and reply to a reply are refused: one final reply per message, a change is a new message with --cancels', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const first = x.reply(id, 'hotovo', 'decision A');
    assert.equal(first.status, 0, first.out);
    const firstId = /sent (\S+) \(assist\)/.exec(first.stdout)[1];
    const second = x.reply(id, 'hotovo', 'correction of my reply: decision B');
    assert.notEqual(second.status, 0, 'a second reply after the final one must not pass');
    assert.match(second.stderr, new RegExp(`má konečnú odpoveď ${firstId}`));
    assert.match(second.stderr, /--cancels/);
    assert.notEqual(x.reply(id, 'otázka', 'reopened').status, 0, 'no interim state after the final reply either');

    // b2 holds exactly one reply and cannot answer it with a reply (no chain, no hidden new request)
    x.comms.expireCache(x.fx.brainB);
    const got = x.fx.runB('comms.mjs', ['receive']);
    assert.equal((got.stdout.match(/\| reply_to /g) || []).length, 1, got.stdout);
    assert.match(got.stdout, new RegExp(`\\| reply_to ${id} \\| state hotovo \\|`));
    const chain = x.fx.runB('comms.mjs', ['send', '--reply-to', firstId, '--state', 'hotovo', '--text', 'then also do X']);
    assert.notEqual(chain.status, 0, 'a reply to a reply must not pass');
    assert.match(chain.stderr, /na odpoveď sa neodpovedá/);

    // the change of the decision: a new message from the author of the final reply
    const change = x.fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project-b/beta', '--cancels', firstId, '--text', 'decision changed to B']);
    assert.equal(change.status, 0, change.out);
    assert.match(change.stdout, new RegExp(`\\| cancels ${firstId}`));
    x.comms.expireCache(x.fx.brainB);
    assert.match(x.fx.runB('comms.mjs', ['receive']).stdout, new RegExp(`\\| cancels ${firstId} \\|`));
    assert.match(x.fx.runB('comms.mjs', ['message', '--id', firstId]).stdout, /\| cancelled by /);
    const foreign = x.fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--cancels', firstId, '--text', 'x']);
    assert.notEqual(foreign.status, 0, 'only the sender of the reply cancels it');
  } finally { await x.done(); }
});

test('sender side: the mail line names the interim state, the timer is re-armed for a state check (otázka 4 h, doubling) and the final reply clears it', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const armed = x.b().timer;
    assert.equal(armed.for, id);
    assert.ok(Date.parse(armed.at) - Date.now() <= REPLY_WINDOW_MS.assist, 'reply window after sending the assist');

    assert.equal(x.reply(id, 'otázka', 'the operator decides; I recommend A').status, 0);
    x.comms.expireCache(x.fx.brainB);
    const list = x.fx.runB('comms.mjs', ['list']).stdout;
    const rid = /^(\S+) \| assist \| reply otázka \| alice \|/m.exec(list)?.[1];
    assert.ok(rid, list);
    const prompt = x.fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }, { cwd: x.fx.projectB, env: x.fx.envB });
    assert.match(prompt.context, new RegExp(`${rid} reply otázka`));

    assert.match(x.fx.runB('comms.mjs', ['receive', '--id', rid]).stdout, new RegExp(`reply_to ${id} \\| state otázka`));
    let t = x.b().timer;
    assert.equal(t.for, id);
    assert.match(t.then, new RegExp(`check the state of ${id}: comms message --id ${id} \\(reply otázka`));
    assert.match(t.then, /do not resend or escalate/);
    const left = () => Date.parse(x.b().timer.at) - Date.now();
    assert.ok(left() > OPERATOR_TIMER_MS - MIN && left() <= OPERATOR_TIMER_MS, 'operator timer (4 h) replaces the 60 min reply window');
    assert.equal(x.fx.runB('comms.mjs', ['ack', '--id', rid]).status, 0);

    // the check finds the same interim state: the delay doubles, nothing is resent
    const check = x.fx.runB('comms.mjs', ['message', '--id', id]);
    assert.match(check.stdout, new RegExp(`^${id} \\| assist \\| to project/alpha \\| picked \\S+ \\| answer otázka since `, 'm'));
    assert.ok(left() > 2 * OPERATOR_TIMER_MS - MIN && left() <= 2 * OPERATOR_TIMER_MS, 'doubled');

    // a1 moves to čakám (interim to interim), then closes with hotovo; b2's timer follows and is cleared at the end
    assert.equal(x.fx.run('timer.mjs', ['--in', '30m', '--then', 'check build 42']).status, 0);
    assert.equal(x.reply(id, 'čakám', 'operator chose A, the build runs', ['--wait-for', 'build 42']).status, 0);
    x.comms.expireCache(x.fx.brainB);
    const rid2 = /^(\S+) \| assist \| reply čakám \|/m.exec(x.fx.runB('comms.mjs', ['list']).stdout)?.[1];
    assert.ok(rid2);
    assert.match(x.fx.runB('comms.mjs', ['receive', '--id', rid2]).stdout, /state čakám \(na build 42\)/);
    assert.ok(left() > REPLY_WINDOW_MS.assist - MIN && left() <= REPLY_WINDOW_MS.assist, 'čakám: 60 min');
    assert.match(x.b().timer.then, /the recipient waits for build 42/);
    x.fx.runB('comms.mjs', ['ack', '--id', rid2]);

    assert.equal(x.reply(id, 'hotovo', 'built, variant A').status, 0);
    x.comms.expireCache(x.fx.brainB);
    const rid3 = /^(\S+) \| assist \| alice \|/m.exec(x.fx.runB('comms.mjs', ['list']).stdout)?.[1];
    assert.ok(rid3, 'a final reply is a plain line');
    x.fx.runB('comms.mjs', ['receive', '--id', rid3]);
    assert.equal(x.b().timer, undefined, 'the final reply clears the timer');
    assert.deepEqual(x.b().reply_wait, {});
  } finally { await x.done(); }
});

test('mail line: an interim reply is `<id> reply <state>`, a final or old reply plain `<id> reply`', () => {
  assert.deepEqual(mailLines([
    { id: 'm1', level: 'assist', reply_to: 'q1', reply_state: 'otázka' },
    { id: 'm2', level: 'assist', reply_to: 'q2', reply_state: 'čakám' },
    { id: 'm3', level: 'assist', reply_to: 'q3', reply_state: 'hotovo' },
    { id: 'm4', level: 'blocker', reply_to: 'q4' },
    { id: 'm5', level: 'assist', reply_to: null, reply_state: null },
  ]), ['m1 reply otázka', 'm2 reply čakám', 'm3 reply', 'm4 reply', 'm5 assist']);
});

test('hotovo guard (phase 2): the previous turn ended "otázka" and this one was not started by the operator: hotovo is refused, otázka passes', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    // The turn that asks the operator ends "Stav: otázka" (the Stop hook records how the turn ended).
    x.fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    x.fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    const stop = x.fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Návrh je hotový.\n\n**Otázky na operátora:** Variant A alebo B? Odporúčam A.\n\nStav: otázka' });
    assert.equal(stop.json?.decision, undefined, stop.out);
    assert.equal(x.a().last_end_state, 'otázka');
    // A mail bell starts the next turn: the operator did not speak.
    x.fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(x.a().turn_source, 'wake');
    const bad = x.reply(id, 'hotovo', 'variant A');
    assert.notEqual(bad.status, 0, 'hotovo must not pass');
    assert.match(bad.stderr, /previous turn of this thread ended "Stav: otázka".*true state is otázka/s);
    assert.match(x.fx.runB('comms.mjs', ['message', '--id', id]).stdout, /\| no answer/, 'nothing was sent');
    assert.equal(x.reply(id, 'otázka', 'operator decides; I recommend A').status, 0);
    // The operator spoke: the next turn is theirs, hotovo is true.
    x.fx.hook('user-prompt-submit.mjs', { prompt: 'variant A' });
    assert.equal(x.a().turn_source, 'operator');
    assert.equal(x.reply(id, 'hotovo', 'variant A, decided by the operator').status, 0);
  } finally { await x.done(); }
});

test('hotovo guard (phase 2): the operator answers a dialog in a turn a mail bell started: hotovo passes', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    x.fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    x.fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    x.fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Návrh je hotový.\n\n**Otázky na operátora:** Variant A alebo B? Odporúčam A.\n\nStav: otázka' });
    assert.equal(x.a().last_end_state, 'otázka');
    x.fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(x.a().turn_source, 'wake');
    // The dialog of this turn returns only with the operator's answer.
    x.fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    x.fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_response: {} });
    const ok = x.reply(id, 'hotovo', 'variant A, answered by the operator in the dialog');
    assert.equal(ok.status, 0, ok.stderr);
  } finally { await x.done(); }
});
