// keep: core
// Mail model 2, now 3 (D-0087, D-0089, D-0090, P-072, P-073): the workflow is a thin client of the mail. It keeps no state of a
// message (no list of picked messages, no reply wait, no timer or waker bound to a message, no file with a message's
// state): what the thread owes and awaits is the mail's `obligations`; Stop reminds from `owed`, the mail's wait for an
// answer is the sender's waker; a mail of another model (`/health` without `model 3`) fails loudly and nothing is written
// or queued; the first run hands the local waits of model 1 over to the mail and cleans the thread states (4b step 5);
// after an outage the mail's answer replaces the backup (3c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient, PLUGIN_ROOT } from './helpers.mjs';
import { wakerFromTool } from '../scripts/waker.mjs';
import { MAIL_STATE_FIELDS } from '../scripts/comms-migrate.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const skipMail = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
const MISMATCH = 'comms model ? ≠ 3: update mail and workflow together';

function stubbed(state = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const logFile = path.join(fx.root, 'stub-log.jsonl');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: logFile });
  fx.stub = {
    set(s) { fs.writeFileSync(stateFile, JSON.stringify(s)); },
    get() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); },
    calls(cmd) { return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => !cmd || a[0] === cmd) : []; },
  };
  fx.stub.set(state);
  return fx;
}
const threadFile = (brain, thread = 'a1') => path.join(brain, 'local', 'threads', `${thread}.json`);
const readState = (brain, thread = 'a1') => (fs.existsSync(threadFile(brain, thread)) ? JSON.parse(fs.readFileSync(threadFile(brain, thread), 'utf8')) : {});
const writeState = (brain, patch, thread = 'a1') => { fs.mkdirSync(path.dirname(threadFile(brain, thread)), { recursive: true }); fs.writeFileSync(threadFile(brain, thread), JSON.stringify({ ...readState(brain, thread), ...patch })); };

// Keys of the thread state that may name a message: what a turn received (3b) and what a hook showed once.
const SHOWN_KEYS = ['received_from', 'mail_replies', 'watch_seen', 'mail_held_signaled', 'pending_signals', 'operator_prompts', 'updated'];
// Files of <brain>/local the mail client writes (outbox, its backup of the mail's answer) or that name no message.
const CLIENT_FILES = /^(outbox\/|comms\/(obligations-cache|count-cache|model-check|model-2|notices-count)\.json$)/;

/** The workflow holds no state of message `ids`: no field, timer, waker or file of its own names one (P-072, D-0090). */
function assertNoMessageState(brain, ids) {
  const st = readState(brain);
  for (const f of MAIL_STATE_FIELDS) assert.equal(st[f], undefined, `thread state field ${f} (state of a message)`);
  const timers = [st.timer, ...(st.timers || [])].filter(Boolean);
  for (const t of timers) {
    assert.equal(t.for, undefined, `timer bound to a message: ${JSON.stringify(t)}`);
    for (const id of ids) assert.ok(!String(t.then).includes(id), `timer for message ${id}: ${t.then}`);
  }
  for (const w of st.wakers || []) assert.ok(w.kind !== 'mail' && !w.for, `waker bound to a message: ${JSON.stringify(w)}`);
  for (const [k, v] of Object.entries(st)) {
    if (SHOWN_KEYS.includes(k)) continue;
    for (const id of ids) assert.ok(!JSON.stringify(v ?? null).includes(id), `thread state ${k} holds message ${id}: ${JSON.stringify(v).slice(0, 200)}`);
  }
  const local = path.join(brain, 'local');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of fs.existsSync(local) ? walk(local) : []) {
    const rel = path.relative(local, f).split(path.sep).join('/');
    if (rel.startsWith('threads/') || CLIENT_FILES.test(rel)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const id of ids) assert.ok(!text.includes(id), `local/${rel} holds message ${id} (a file of message state)`);
  }
}

test('the workflow keeps no state of a message: receive, send, the answers, settle, ack, withdraw and the bells leave none', () => {
  const fx = stubbed({
    messages: [{ id: 'm-in1', level: 'assist', topic: 'alpha', sender: 'bob' }, { id: 'm-in2', level: 'blocker', topic: 'alpha', sender: 'bob' }],
    message: {
      'm-in1': { id: 'm-in1', status: 'picked', level: 'assist', project: 'project', topic: 'alpha', to: 'project/alpha', picked_at: '2026-11-01T10:00:00.000Z' },
      'm-in2': { id: 'm-in2', status: 'picked', level: 'blocker', project: 'project', topic: 'alpha', to: 'project/alpha', picked_at: '2026-11-01T10:00:00.000Z' },
      'm-out1': { id: 'm-out1', status: 'waiting', level: 'assist', to: 'project-b/beta', answer_state: 'otázka', answer_at: '2026-11-01T10:00:00.000Z', wait_due_at: '2026-11-01T14:00:00.000Z' },
      'm-out2': { id: 'm-out2', status: 'picked', level: 'blocker', to: 'project-b/beta', picked_at: '2026-11-01T10:00:00.000Z' },
    },
    send_id: 'm-out1', sends: [], resolves: [],
  });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    assert.equal(fx.run('comms.mjs', ['receive', '--id', 'm-in1']).status, 0);
    assert.equal(fx.run('comms.mjs', ['receive', '--id', 'm-in2']).status, 0);
    const sent = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project-b/beta', '--text', 'otázka']);
    assert.equal(sent.status, 0, sent.out);
    assert.doesNotMatch(sent.stdout, /timer set/, 'no timer for the answer: the mail rings (1e)');
    assert.equal(fx.run('comms.mjs', ['send', '--level', 'blocker', '--to', 'project-b/beta', '--text', 'rýchlo'], { env: {} }).status, 0);
    // a waker from the tool call: mail sent is no waker of the thread (the mail's wait is)
    assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'node comms.mjs send --level assist --to project-b/beta --text x' }, tool_response: { stdout: 'sent m-out1 (assist) -> project-b/beta' } }), null);
    assert.equal(fx.run('timer.mjs', ['--in', '30m', '--then', 'pozrieť build']).status, 0);
    assert.equal(fx.run('comms.mjs', ['send', '--reply-to', 'm-in1', '--state', 'čakám', '--wait-for', 'build', '--text', 'beží build']).status, 0);
    assert.equal(fx.run('comms.mjs', ['send', '--reply-to', 'm-in1', '--state', 'hotovo', '--text', 'hotové']).status, 0);
    assert.equal(fx.run('comms.mjs', ['settle', '--id', 'm-in2']).status, 0);
    assert.equal(fx.run('comms.mjs', ['ack', '--id', 'm-in2']).status, 0);
    assert.equal(fx.run('comms.mjs', ['withdraw', '--id', 'm-out2']).status, 0);
    assert.equal(fx.run('comms.mjs', ['message', '--id', 'm-out1']).status, 0);
    // every answer is one resolve of the mail in the original's mailbox, no reply through send, no separate ack (P-072)
    const resolves = fx.stub.get().resolves.map((r) => r.argv.slice(0, 1).concat(r.argv.filter((a, i, all) => all[i - 1] === '--id' || all[i - 1] === '--state' || all[i - 1] === '--project' || all[i - 1] === '--topic')));
    assert.deepEqual(resolves, [
      ['resolve', 'm-in1', 'čakám', 'project', 'alpha'], ['resolve', 'm-in1', 'hotovo', 'project', 'alpha'],
      ['settle', 'm-in2', 'project', 'alpha'], ['ack', 'm-in2', 'project', 'alpha'], ['withdraw', 'm-out2'],
    ]);
    assert.ok(!fx.stub.get().sends.some((s) => s.argv.includes('--reply-to')), 'no reply through send');
    // bells about sent messages and the turn's end
    fx.hook('user-prompt-submit.mjs', { prompt: 'no reply m-out1' });
    fx.hook('user-prompt-submit.mjs', { prompt: 'recipient closed m-out2' });
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' });
    assertNoMessageState(fx.brain, ['m-in1', 'm-in2', 'm-out1', 'm-out2']);
  } finally { fx.cleanup(); }
});

test('Stop reminds from the mail\'s owed; the prompt shows it as the mail has it now; the mail\'s wait is the sender\'s waker', () => {
  const fx = stubbed({
    owed: [{ id: 'm-p1', level: 'assist', status: 'picked', from_project: 'project-b', from_topic: 'beta' }, { id: 'm-w1', level: 'assist', status: 'waiting', answer_state: 'otázka' }],
    awaiting: [],
  });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'pracuj' });
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' });
    const queued = (readState(fx.brain).pending_signals || []).join(' ');
    assert.match(queued, /picked mail unanswered: m-p1 assist; end each: it asks for an answer or a result: comms send --reply-to <id>/);
    assert.doesNotMatch(queued, /m-w1/, 'an interim answer is not reminded');
    // another thread answered it meanwhile: the prompt shows the mail's owed, not the queued copy
    fx.stub.set({ owed: [], awaiting: [] });
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.doesNotMatch(r.context, /picked mail unanswered/);
    // the mail waits for an answer to mail this thread sent: "čakám" needs no timer of the thread (1e)
    fx.stub.set({ awaiting: [{ id: 'm-a1', to: 'project-b/beta', level: 'assist', status: 'pending', wait_due_at: new Date(Date.now() + 3600_000).toISOString(), wait_n: 0 }] });
    fx.hook('user-prompt-submit.mjs', { prompt: 'pošli otázku' });
    const wait = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Poslal som otázku.\n\nStav: čakám (na odpoveď z beta)' });
    assert.equal(wait.json.decision, undefined, JSON.stringify(wait.json));
    const st = readState(fx.brain);
    assert.ok(![st.timer, ...(st.timers || [])].some((t) => t?.auto), 'no auto timer: the mail rings the thread');
    // without the mail's wait the same turn end is a turn waiting without a waker
    fx.stub.set({ awaiting: [] });
    fx.hook('user-prompt-submit.mjs', { prompt: 'pošli otázku' });
    const none = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Poslal som otázku.\n\nStav: čakám (na odpoveď z beta)' });
    assert.equal(none.json.decision, 'block', JSON.stringify(none.json));
    // recent rows: one line, once (the cursor goes back to the mail as since)
    fx.stub.set({ recent: [{ seq: 5, kind: 'settled', id: 'm-s1', line: 'settled m-s1' }] });
    assert.match(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context, /mail: settled m-s1 \(comms message --id <id> for details\)/);
    assert.equal(readState(fx.brain).mail_cursor, 5);
    assert.doesNotMatch(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context, /settled m-s1/);
    assert.ok(fx.stub.calls('obligations').some((a) => a[a.indexOf('--since') + 1] === '5'), 'since = the cursor shown');
  } finally { fx.cleanup(); }
});

test('a mail of another model fails loudly: nothing is written or queued, the status line says it (4a, I10)', () => {
  const fx = stubbed({ model: null, sends: [], resolves: [] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    const send = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project-b/beta', '--text', 'x']);
    assert.equal(send.status, 3, send.out);
    assert.match(send.stderr, new RegExp(MISMATCH.replace(/[?()]/g, '\\$&')));
    const reply = fx.run('comms.mjs', ['send', '--reply-to', 'm1', '--state', 'hotovo', '--text', 'x']);
    assert.equal(reply.status, 3, reply.out);
    assert.equal(fx.run('comms.mjs', ['settle', '--id', 'm1']).status, 3);
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(r.context, new RegExp(`mail: \\? \\(${MISMATCH.replace(/[?()]/g, '\\$&')}\\)`));
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' });
    // only /health was asked: no send, resolve, obligations, turn or receive reached the client; nothing queued
    assert.deepEqual([...new Set(fx.stub.calls().map((a) => a[0]))], ['health']);
    assert.deepEqual(fx.stub.get().sends, []);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'local', 'outbox')) || !fs.readdirSync(path.join(fx.brain, 'local', 'outbox')).length);
    fx.stub.set({ model: 2 });
    fs.rmSync(path.join(fx.brain, 'local', 'comms'), { recursive: true, force: true });
    assert.match(fx.run('comms.mjs', ['status']).stdout, /^service: comms model 2 ≠ 3: update mail and workflow together$/m);
  } finally { fx.cleanup(); }
});

test('first run of mail model 2: local waits go to the mail, the thread states lose the message state of model 1 (4b step 5)', { skip: skipMail }, async () => {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
    const sent = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project-b/beta', '--text', 'otázka']);
    const mine = /sent (\S+) \(assist\)/.exec(sent.stdout)[1];
    const foreign = /sent (\S+) \(assist\)/.exec(fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--text', 'x']).stdout)[1];
    // a state of model 1: a reply-window timer of my message, reply_wait of a foreign one, picked lists, a mail waker
    const due = new Date(Date.now() + 7 * 3600_000).toISOString();
    fs.rmSync(path.join(fx.brain, 'local', 'comms', 'model-2.json'), { force: true });
    writeState(fx.brain, {
      picked_assist: [{ id: foreign, from: 'bob' }], picked_at: { [foreign]: '2026-11-01T10:00:00.000Z' }, reply_wait: { [foreign]: { state: 'otázka', n: 1 } },
      timer: { at: due, then: `check the reply to ${mine}`, set_at: '2026-11-01T10:00:00.000Z', for: mine },
      timers: [{ at: new Date(Date.now() + 9 * 3600_000).toISOString(), then: 'vlastný krok', set_at: '2026-11-01T10:00:00.000Z' }],
      wakers: [{ kind: 'mail', for: mine, at: '2026-11-01T10:00:00.000Z', until: due }], pending_signals: ['picked assist unanswered: x', 'iný riadok'],
    });
    fs.writeFileSync(path.join(fx.brain, 'local', 'comms-closed.json'), '["old"]\n');
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const st = readState(fx.brain);
    for (const f of MAIL_STATE_FIELDS) assert.equal(st[f], undefined, f);
    assert.deepEqual([st.timer, ...(st.timers || [])].filter(Boolean).map((t) => t.then), ['vlastný krok'], 'only the timer of no message stays');
    assert.deepEqual(st.wakers || [], []);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'local', 'comms-closed.json')));
    const marker = JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'comms', 'model-2.json'), 'utf8'));
    assert.deepEqual(marker.adopted, [mine], 'the wait of my message went to the mail');
    assert.deepEqual(marker.dropped, [foreign], 'the mail refuses a wait of a message this brain did not send: dropped');
    assert.match(comms.cli(['message', '--id', mine]).out, new RegExp(`"wait_due_at": "${due.slice(0, 19)}`));
    assertNoMessageState(fx.brain, [mine, foreign]);
  } finally { await comms.stop(); fx.cleanup(); }
});

test('after an outage the mail\'s answer replaces the backup: owed offline from the backup, then live (3b, 3c)', { skip: skipMail }, async () => {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
    const id = /sent (\S+) \(assist\)/.exec(fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--text', 'x']).stdout)[1];
    assert.equal(fx.run('comms.mjs', ['receive', '--id', id]).status, 0);
    assert.match(fx.run('comms.mjs', ['status']).stdout, new RegExp(`^owed, picked without an answer: ${id} assist`, 'm'));
    await comms.stop();
    assert.match(fx.run('comms.mjs', ['status']).stdout, new RegExp(`^owed, picked without an answer \\(offline, \\d+ s\\): ${id} assist`, 'm'));
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' });
    assert.match((readState(fx.brain).pending_signals || []).join(' '), new RegExp(`picked mail unanswered \\(offline, \\d+ s\\): ${id} assist`));
    const settle = fx.run('comms.mjs', ['settle', '--id', id]);
    assert.match(settle.stdout, /queued in <brain>\/local\/outbox/, settle.out);
    // the backup minus the id with a queued operation
    assert.doesNotMatch(fx.run('comms.mjs', ['status']).stdout, /^owed/m);
    await comms.start();
    const live = fx.run('comms.mjs', ['status']).stdout;
    assert.match(live, /^obligations: nothing owed, nothing awaited$/m);
    assert.equal(fs.readdirSync(path.join(fx.brain, 'local', 'outbox')).filter((f) => f.endsWith('.json')).length, 0, 'the outbox went first');
    assert.match(fx.runB('comms.mjs', ['message', '--id', id]).stdout, /\| done\/settled \|/);
    assertNoMessageState(fx.brain, [id]);
  } finally { await comms.stop(); fx.cleanup(); }
});

test('send --maintainer goes to the maintainer thread; --to thread/<id> goes as a thread address (--to-thread); a reply to a message delivered to a thread resolves in that thread (a shop repo 2026-11-16)', () => {
  const fx = stubbed({
    message: { 'm-th1': { id: 'm-th1', status: 'picked', level: 'assist', to_thread: 'th-reporter', picked_at: '2026-11-01T10:00:00.000Z' } },
    sends: [], resolves: [],
  });
  try {
    let r = fx.run('comms.mjs', ['send', '--maintainer', '--level', 'assist', '--text', 'bežná správa']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /sent \S+ \(assist\) -> maintainer/);
    const send = fx.stub.calls('send').at(-1);
    assert.ok(send.includes('--maintainer') && !send.includes('--project'), JSON.stringify(send));
    // Operator 2026-11-18: thread/<id> is a thread address (the server takes it only from the maintainer's thread).
    r = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'thread/abc', '--text', 'x']);
    assert.equal(r.status, 0, r.out);
    const toThread = fx.stub.calls('send').at(-1);
    assert.deepEqual(toThread.slice(toThread.indexOf('--to-thread'), toThread.indexOf('--to-thread') + 2), ['--to-thread', 'abc'], JSON.stringify(toThread));
    assert.ok(!toThread.includes('--project') && !toThread.includes('--maintainer'));
    assert.equal(fx.run('comms.mjs', ['send', '--maintainer', '--to', 'thread/abc', '--level', 'assist', '--text', 'x']).status, 1);
    assert.equal(fx.run('comms.mjs', ['send', '--maintainer', '--to', 'x/y', '--level', 'assist', '--text', 'x']).status, 1);
    r = fx.run('comms.mjs', ['send', '--reply-to', 'm-th1', '--state', 'hotovo', '--text', 'ďakujem']);
    assert.equal(r.status, 0, r.out);
    const res = fx.stub.calls('resolve').at(-1);
    assert.deepEqual(res.slice(res.indexOf('--thread'), res.indexOf('--thread') + 2), ['--thread', 'th-reporter'], JSON.stringify(res));
  } finally { fx.cleanup(); }
});
