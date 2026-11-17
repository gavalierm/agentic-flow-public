// keep: core
// Reply protocol of the mail (P-061, incident 2026-11-11: three replies to one message, the last one a new request,
// while the recipient's operator was still deciding): a reply names its state (hotovo | otázka | čakám), a message takes
// one final reply, a reply is never answered by a reply, and an interim state is not reminded as "unanswered".
// Mail model 2 (P-072): the answer is one `resolve` of the mail (it delivers the reply and settles the original, no separate
// ack); what the recipient owes and the sender awaits is the mail's `obligations`, nothing is kept in the thread state.
// Needs agentic-comms of mail model 2 next to the plugin (else the integration tests are skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';

const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

const stateFile = (brain, thread) => path.join(brain, 'local', 'threads', `${thread}.json`);
const readState = (brain, thread) => (fs.existsSync(stateFile(brain, thread)) ? JSON.parse(fs.readFileSync(stateFile(brain, thread), 'utf8')) : {});

/** Two threads: b2 (bob, project-b/beta) asks a1 (alice, project/alpha) with an assist; a1 has picked it up. */
async function exchange() {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
  assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
  const send = (text) => {
    const r = fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--text', text]);
    assert.equal(r.status, 0, r.out);
    return /sent (\S+) \(assist\)/.exec(r.stdout)[1];
  };
  const ask = (text = 'which variant, A or B?') => {
    const id = send(text);
    assert.equal(fx.run('comms.mjs', ['receive', '--id', id]).status, 0);
    return id;
  };
  const reply = (id, state, text, extra = []) => fx.run('comms.mjs', ['send', '--reply-to', id, ...(state ? ['--state', state] : []), ...extra, '--text', text]);
  const replyId = (r) => /^replied (\S+) -> reply to /m.exec(r.stdout)?.[1];
  const statusA = () => fx.run('comms.mjs', ['status']).stdout;
  const statusB = () => fx.runB('comms.mjs', ['status']).stdout;
  const done = async () => { await comms.stop(); fx.cleanup(); };
  return { fx, comms, send, ask, reply, replyId, statusA, statusB, done };
}

test('reply has no state: send --reply-to without --state is refused and nothing is sent; čakám needs --wait-for and a waker', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const bare = x.reply(id, null, 'variant A');
    assert.notEqual(bare.status, 0, 'a reply without a state must not pass');
    assert.match(bare.stderr, /--state is required with --reply-to: hotovo\|otázka\|čakám/);
    assert.match(x.fx.runB('comms.mjs', ['message', '--id', id]).stdout, /\| picked \| picked .* \| no answer/, 'nothing reached the service');
    assert.match(x.reply(id, 'neskôr', 'x').stderr, /--state is required/);

    const noWhat = x.reply(id, 'čakám', 'build runs');
    assert.notEqual(noWhat.status, 0); assert.match(noWhat.stderr, /--wait-for/);
    const noWaker = x.reply(id, 'čakám', 'build runs', ['--wait-for', 'build 42']);
    assert.notEqual(noWaker.status, 0); assert.match(noWaker.stderr, /without a waker/);
    assert.equal(x.fx.run('timer.mjs', ['--in', '30m', '--then', 'check build 42']).status, 0);
    const waits = x.reply(id, 'čakám', 'build runs', ['--wait-for', 'build 42']);
    assert.equal(waits.status, 0, waits.out);
    assert.match(waits.stdout, /\| state čakám \| waiting$/m);
    // The final answer is still due: the mail's owed says so (an interim answer is not reminded by Stop, P-042).
    assert.match(x.statusA(), new RegExp(`^owed, final reply due: ${id} assist from project-b/beta \\(čakám\\)$`, 'm'));
    x.fx.hook('stop.mjs', {});
    assert.doesNotMatch((readState(x.fx.brain, 'a1').pending_signals || []).join(' '), /picked mail unanswered/);
    // The sender awaits it; the mail checks the state later (no timer of the sender bound to the message).
    assert.match(x.statusB(), new RegExp(`^awaiting: ${id} assist -> project/alpha \\| waiting \\| answer čakám \\| next check `, 'm'));
    assert.match(x.reply(id, 'hotovo', 'x', ['--wait-for', 'y']).stderr, /--wait-for belongs to --state čakám/);
    assert.match(x.fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--state', 'hotovo', '--text', 'x']).stderr, /belong to a reply/);
  } finally { await x.done(); }
});

test('second reply and reply to a reply are refused: one final reply per message, a change replaces it with --cancels', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const first = x.reply(id, 'hotovo', 'decision A');
    assert.equal(first.status, 0, first.out);
    const firstId = x.replyId(first);
    assert.ok(firstId, first.stdout);
    const second = x.reply(id, 'hotovo', 'correction of my reply: decision B');
    assert.notEqual(second.status, 0, 'a second reply after the final one must not pass');
    assert.match(second.stderr, new RegExp(`je už vybavená \\(reply ${firstId}\\)`));
    assert.match(second.stderr, /--cancels/);
    assert.notEqual(x.reply(id, 'otázka', 'reopened').status, 0, 'no interim state after the final reply either');

    // b2 holds exactly one reply and cannot answer it with a reply (no chain, no hidden new request)
    const got = x.fx.runB('comms.mjs', ['receive']);
    assert.equal((got.stdout.match(/\| reply_to /g) || []).length, 1, got.stdout);
    assert.match(got.stdout, new RegExp(`\\| reply_to ${id} \\| state hotovo \\|`));
    const chain = x.fx.runB('comms.mjs', ['send', '--reply-to', firstId, '--state', 'hotovo', '--text', 'then also do X']);
    assert.notEqual(chain.status, 0, 'a reply to a reply must not pass');
    assert.match(chain.stderr, /odpoveď sa nevybavuje/);

    // the change of the decision: the author of the final reply replaces it (resolve with cancels on the original)
    const old = x.fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project-b/beta', '--cancels', firstId, '--text', 'decision changed to B']);
    assert.notEqual(old.status, 0, '--cancels on a new message is refused');
    assert.match(old.stderr, /--cancels replaces your final reply and belongs to it/);
    const change = x.reply(id, 'hotovo', 'decision changed to B', ['--cancels', firstId]);
    assert.equal(change.status, 0, change.out);
    assert.match(change.stdout, new RegExp(`\\| cancels ${firstId} \\| done/reply$`, 'm'));
    assert.match(x.fx.runB('comms.mjs', ['receive']).stdout, new RegExp(`\\| cancels ${firstId} \\|`));
    assert.match(x.fx.runB('comms.mjs', ['message', '--id', firstId]).stdout, /\| cancelled by /);
    const foreign = x.fx.runB('comms.mjs', ['send', '--reply-to', id, '--state', 'hotovo', '--cancels', firstId, '--text', 'x']);
    assert.notEqual(foreign.status, 0, 'only the author of the reply replaces it');
  } finally { await x.done(); }
});

// One operation (P-072): the final reply settles the original in the mail (no separate ack); reading the reply settles it
// on the sender's side; an interim reply leaves the original owed by the recipient and awaited by the sender.
test('final reply settles the original; the read reply is done; an interim reply stays owed and awaited; an interim answer needs the pickup', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const fin = x.reply(id, 'hotovo', 'decision A');
    assert.equal(fin.status, 0, fin.out);
    assert.doesNotMatch(fin.stdout, /acked/, 'no separate ack');
    assert.match(x.statusA(), /^obligations: nothing owed, nothing awaited$/m);
    assert.match(x.fx.runB('comms.mjs', ['receive']).stdout, /decision A/);
    assert.match(x.fx.runB('comms.mjs', ['list']).stdout, /no waiting messages/);
    const late = x.fx.runB('comms.mjs', ['ack', '--id', x.replyId(fin)]);
    assert.equal(late.status, 0, late.out);
    assert.match(late.stdout, /already done\/read/);

    const id2 = x.ask('second question');
    assert.equal(x.reply(id2, 'otázka', 'operator decides').status, 0);
    assert.match(x.statusA(), new RegExp(`^owed, final reply due: ${id2} .*\\(otázka\\)$`, 'm'));
    assert.equal(x.fx.runB('comms.mjs', ['receive']).status, 0);
    assert.match(x.statusB(), new RegExp(`^awaiting: ${id2} assist -> project/alpha \\| waiting \\| answer otázka`, 'm'));
    // an ack does not close an open interim answer (1b: ack only from picked)
    const ack = x.fx.run('comms.mjs', ['ack', '--id', id2]);
    assert.notEqual(ack.status, 0, ack.out);
    assert.match(ack.stdout, /an interim answer otázka is open: its final answer is due/);

    // not picked yet: an interim answer is refused with the way to read it first; a final one passes without it
    const id3 = x.send('third question');
    const early = x.reply(id3, 'otázka', 'operator decides');
    assert.notEqual(early.status, 0, early.out);
    assert.match(early.stderr, new RegExp(`${id3} is not picked yet: read it first`));
    const last = x.reply(id3, 'hotovo', 'decision B');
    assert.equal(last.status, 0, last.out);
    assert.match(x.fx.run('comms.mjs', ['list']).stdout, /no waiting messages/);
  } finally { await x.done(); }
});

// I9: a sender whose topic is closed cannot read the answer; the original is answered all the same (no settle fallback).
test('the answer to a sender whose topic is closed settles the original and says it was not delivered', { skip }, async () => {
  const x = await exchange();
  try {
    const id = x.ask();
    const id2 = x.ask('another');
    assert.equal(x.comms.cli(['register-topic', '--project', 'project-b', '--topic', 'beta', '--close'], 'bob').code, 0);
    const r = x.reply(id, 'hotovo', 'done');
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /the answer was not delivered \(the sender's topic is closed\)/);
    assert.match(x.fx.run('comms.mjs', ['message', '--id', id]).stdout, /\| done\/reply \| .* \(not delivered: sender-closed\)/);
    const s = x.fx.run('comms.mjs', ['settle', '--id', id2]);
    assert.equal(s.status, 0, s.out);
    assert.match(s.stdout, new RegExp(`^settled: ${id2} \\(done/settled\\)$`, 'm'));
    assert.match(x.statusA(), /^obligations: nothing owed, nothing awaited$/m);
  } finally { await x.done(); }
});

// --- Stop hook: the reply protocol of spec 10.3 (skeleton, state against facts, dialog, one block per turn) ---------------
// The text of the result is never read (10.4); a state comes from the handover and the alarms, not from the state line.
const topicRecord = (fx, id) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'topics', id, 'topic.json'), 'utf8'));
const stopRaw = (fx, msg, extra = {}) => fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg, rawHandover: true, ...extra }).json;
const turnOf = (fx, source) => { const st = readState(fx.brain, 'a1'); fs.writeFileSync(stateFile(fx.brain, 'a1'), JSON.stringify({ ...st, turn_source: source, turn_started_at: new Date().toISOString() })); };

test('Stop 10.3 item 1: skeleton — state line, Handover line of every held topic (also "→ žiadny"), blocks as many items as the handover sections', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    assert.match(stopRaw(fx, 'Hotové.').reason, /no state line/);
    assert.match(stopRaw(fx, 'Hotové.\n\n**Stav:** hotovo').reason, /no \*\*Handover:\*\* section.*alpha/);
    assert.match(stopRaw(fx, 'Hotové.\n\nHandover: alpha – nič\nStav: hotovo').reason, /old form of the protocol/);
    assert.equal(stopRaw(fx, 'Hotové.\n\n**Handover:**\n1. alpha → žiadny\n\n**Stav:** hotovo').decision, undefined);
    // a block item the handover does not hold is refused; saved in Otvorené otázky it passes (the operator started the turn)
    const ask = 'Návrh je hotový.\n\n**Otázky na operátora:**\n1. Nasadiť variant A?\n\n**Handover:**\n1. alpha → žiadny\n\n**Stav:** otázka';
    assert.match(stopRaw(fx, ask).reason, /\*\*Otázky na operátora:\*\* has 1 item\(s\) and the section Otvorené otázky of the held topics 0/);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--questions', 'Nasadiť variant A?']).status, 0);
    assert.equal(stopRaw(fx, ask).decision, undefined);
    const st = readState(fx.brain, 'a1');
    assert.ok(!st.timer && !(st.timers || []).length, 'otázka arms no timer (spec 10.2: otázka has no alarm)');
    assert.equal(topicRecord(fx, 'alpha').turn.state, 'otázka');
    assert.equal(topicRecord(fx, 'alpha').turn.alarm_at, null);
    // a thread without a held topic has neither block (10.1)
    const fy = setup({ thread: 'z9' });
    try {
      fy.hook('user-prompt-submit.mjs', { prompt: 'ahoj' });
      assert.match(fy.hook('stop.mjs', { last_assistant_message: '**Otázky na operátora:**\n1. Aká téma?\n\n**Handover:** žiadny\n\n**Stav:** otázka', rawHandover: true }).json.reason, /needs a held topic/);
    } finally { fy.cleanup(); }
  } finally { fx.cleanup(); }
});

test('Stop 10.3 item 2: the state against the facts; an open question is otázka also with a next step, the turn still closes with the step and resume_at (O2)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--next', 'dopísať testy', '--questions', 'Zlúčiť do main?']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    const end = (state) => `Hotová časť.\n\n**Otázky na operátora:**\n1. Zlúčiť do main?\n\n**Handover:**\n1. alpha → dopísať testy\n\n**Stav:** ${state}`;
    assert.match(stopRaw(fx, end('hotovo')).reason, /declares "\*\*Stav:\*\* hotovo" but the facts give "otázka" \(topic alpha: 1 next step\(s\), 1 open question\(s\)/);
    // Operator 2026-11-17: the open question is the state; the step still continues (the continuation does not hang on it).
    assert.match(stopRaw(fx, end('čakám (na pokračovanie)')).reason, /the facts give "otázka"/, 'an open question is not hidden by the step');
    const before = Date.now();
    assert.equal(stopRaw(fx, end('otázka')).decision, undefined);
    const close = readState(fx.brain, 'a1').last_close;
    assert.equal(close.next, 'dopísať testy');
    const due = Date.parse(close.resume_at) - before;
    assert.ok(due >= 5_000 && due <= 20_000, `resume_at in ${due} ms (10 s, P-079)`);
    const turn = topicRecord(fx, 'alpha').turn;
    assert.equal(turn.state, 'otázka');
    assert.ok(Date.parse(turn.alarm_at) >= before, 'the continuation alarm is the end of the turn');
    // the second attempt of a turn passes (at most one block per turn)
    assert.equal(stopRaw(fx, end('hotovo'), { stop_hook_active: true }).decision, undefined);
  } finally { fx.cleanup(); }
});

test('Stop 10.3: a last message of only the skeleton is blocked on the first attempt; the second attempt passes (one block per turn, O3)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    const skeleton = '**Handover:**\n1. alpha → žiadny\n\n**Stav:** hotovo';
    assert.match(stopRaw(fx, skeleton).reason, /only its skeleton/);
    // after the block the agent ends again with only the skeleton: no second block in this turn, the turn closes
    assert.equal(stopRaw(fx, skeleton, { stop_hook_active: true }).decision, undefined);
    assert.equal(topicRecord(fx, 'alpha').turn.state, 'hotovo');
    assert.equal(readState(fx.brain, 'a1').state_only_blocked_at, undefined, 'no per-turn mark of a second block');
    // a second attempt that breaks the skeleton otherwise passes too
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    assert.equal(stopRaw(fx, 'Hotové.', { stop_hook_active: true }).decision, undefined);
  } finally { fx.cleanup(); }
});

test('Stop: state written only when it changed (risk 4.7), in the commit of the logs', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--questions', 'A?']).status, 0);
    const msg = '**Otázky na operátora:**\n1. A?\n\n**Handover:**\n1. alpha → žiadny\n\n**Stav:** otázka';
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    fs.mkdirSync(path.join(fx.brain, 'local', 'log-buffer'), { recursive: true });
    fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'touch a' }, tool_response: { stdout: '' } });
    fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'touch b' }, tool_response: { stdout: '' } });
    const head0 = fx.git(fx.brain, 'rev-parse', 'HEAD');
    assert.equal(stopRaw(fx, msg).decision, undefined);
    const log = fx.git(fx.brain, 'log', '--format=%s', `${head0}..HEAD`).split('\n').filter(Boolean);
    assert.equal(log.length, 1, log.join('\n'));
    assert.match(log[0], /turn alpha otázka; logs flush s1/);
    assert.match(fx.git(fx.brain, 'show', '--name-only', '--format=', 'HEAD'), /topics\/alpha\/topic\.json/);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), fx.git(fx.brain, 'rev-parse', 'origin/main'), 'pushed');
    // the same state again: no write
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const head1 = fx.git(fx.brain, 'rev-parse', 'HEAD');
    assert.equal(stopRaw(fx, msg).decision, undefined);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), head1);
  } finally { fx.cleanup(); }
});

test('Stop 10.3 item 3: the dialog only in a turn the operator did not start, at otázka, outside mode discussion', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'T', '--questions', 'Variant A alebo B?']).status, 0);
    const ask = 'Porovnanie hotové.\n\n**Otázky na operátora:**\n1. Variant A alebo B?\n\n**Handover:**\n1. alpha → žiadny\n\n**Stav:** otázka';
    fx.hook('user-prompt-submit.mjs', { prompt: 'porovnaj varianty' });
    assert.equal(stopRaw(fx, ask).decision, undefined, 'the operator reads the reply: no dialog');
    turnOf(fx, 'wake');
    assert.match(stopRaw(fx, ask).reason, /ask the first item of \*\*Otázky na operátora:\*\* with AskUserQuestion now/);
    const st = readState(fx.brain, 'a1');
    fs.writeFileSync(stateFile(fx.brain, 'a1'), JSON.stringify({ ...st, dialog_at: new Date(Date.now() + 1000).toISOString() }));
    assert.equal(stopRaw(fx, ask).decision, undefined, 'a dialog asked in the turn: only that it was asked counts');
    // A mail turn that goes on with a next step needs no dialog: it would hold the continuation (operator 2026-11-17).
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--next', 'zostaviť register']).status, 0);
    turnOf(fx, 'wake');
    const goesOn = 'Pošta spracovaná.\n\n**Otázky na operátora:**\n1. Variant A alebo B?\n\n**Handover:**\n1. alpha → zostaviť register\n\n**Stav:** otázka';
    assert.equal(stopRaw(fx, goesOn).decision, undefined, 'otázka with a next step: no dialog');
  } finally { fx.cleanup(); }
});

// Spec 10.8: the three false findings of 1.7/1.8.
test('Stop 10.8: "Ostáva:" in the text is no step; "pokračovať v diskusii" cannot be saved and hotovo passes; otázka in discussion needs no dialog', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'ops']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'zhrň obsah' });
    assert.equal(stopRaw(fx, 'Obsah:\n- kapitola 1\n\nOstáva: príloha B, ktorú dokument už nemá.\n\n**Handover:**\n1. alpha → žiadny\n\n**Stav:** hotovo').decision, undefined, '1: a label in the text is no step (10.4)');

    assert.equal(fx.run('topic.mjs', ['create', 'talk', '--subject', 'Talk', '--class', 'discussion', '--here']).status, 0);
    const refused = fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--next', 'pokračovať v diskusii']);
    assert.notEqual(refused.status, 0, '2: a step in mode discussion is not saved (10.6)');
    fx.hook('user-prompt-submit.mjs', { prompt: 'len diskutujeme' });
    const both = (state, q = '') => `Bod 1 ostáva otvorený.\n\n${q}**Handover:**\n1. alpha → žiadny\n2. talk → žiadny\n\n**Stav:** ${state}`;
    assert.equal(stopRaw(fx, both('hotovo')).decision, undefined, '2: hotovo passes, no step was saved');

    assert.equal(fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--questions', 'Ideme cestou A?']).status, 0);
    turnOf(fx, 'wake');
    assert.equal(stopRaw(fx, both('otázka', '**Otázky na operátora:**\n1. Ideme cestou A?\n\n')).decision, undefined, '3: otázka in mode discussion without a dialog passes');
  } finally { fx.cleanup(); }
});
