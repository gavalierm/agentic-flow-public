#!/usr/bin/env node
// Stub of the agentic-comms client of mail model 2 for workflow tests (WORKFLOW_COMMS_CLIENT). State in STUB_COMMS_STATE (JSON):
//   { messages: [{ id, level, topic?, reply_to?, ... }] (the pending inbox), down: bool,
//     model: 2 (default; null: a mail without `model` in /health, e.g. 0.4.x; another number: another model),
//     owed: [{ id, level, status: picked|waiting, ... }], awaiting: [{ id, to, level, status, wait_due_at, ... }],
//     recent: [{ seq, kind, id, line }] (rows after --since), topics: { '<p>/<t>': { state, registered } } (obligations.topics),
//     backup: { ... } (obligations while down: the client's backup, offline), by_topic: true (the inbox lists only the
//     messages of the --topics given), wake: { running, ... },
//     turn: 'ok'|'unknown'|'old' (old: no opened_at, --opened-at is an unknown option), opened_at: '<iso>' (answer of open),
//     turn_unknown: ['<option>', ...] (turn options an older client refuses as unknown, e.g. 'discussion'),
//     message: { <id>: { ...GET /message fields } }
//     register_fail: true (register-topic exits 2: comms unavailable),
//     send_held: true (send to an unregistered topic: status held + notice), send_id: '<id>' (id of a sent message),
//     project_known: true (the held answer carries project_known), send_closed_topic: ['<p>/<t>', ...]
//     (send to that topic: 410 closed), send_fail: true (send exits 1), sends: [] (each send: argv + stdin, appended),
//     resolves: [] (each resolve / settle / ack / withdraw: argv + stdin, appended), resolve_409: { <id>: { status, resolution } }
//     (resolve of that id: 409 with that state), queued: true (mail unavailable: the client queued the write in its outbox),
//     notices: [{ id, kind, state, project, topic, message_id }] (decide marks the notice decided and a deliver turns
//     message[<message_id>].status to pending, a discard to discarded), decide_fail: true (decide exits 1), decide_expired: true (decide exits 1 with
//     409 and details.expired_at: the held message expired), send_held_to: ['<p>/<t>' | '@<persona>', ...] (send to that
//     address: held + notice), send_queued: true (mail unavailable: the client queued the send in its outbox, exit 0),
//     key: '<key>' (key add answers it, default k-stub) }
// Every call is appended to STUB_COMMS_LOG as one JSON line (argv).
import fs from 'node:fs';

const file = process.env.STUB_COMMS_STATE;
const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const argv = process.argv.slice(2);
if (process.env.STUB_COMMS_LOG) fs.appendFileSync(process.env.STUB_COMMS_LOG, JSON.stringify(argv) + '\n');
const [cmd] = argv;
const opt = (k) => { const i = argv.lastIndexOf(`--${k}`); return i === -1 ? undefined : argv[i + 1]; };
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const refuse = (status, error, details = undefined) => { process.stderr.write(JSON.stringify({ error, code: 'REJECTED', status, ...(details ? { details } : {}) }) + '\n'); process.exit(1); };
const messages = state.messages || [];
const model = state.model === undefined ? 2 : state.model;
const stdin = () => (argv.includes('-') ? fs.readFileSync(0, 'utf8') : null);

if (state.down) {
  // The client queues a `closed` turn in its outbox during an outage; `open` is never queued.
  if (cmd === 'turn') { print({ ok: false, unavailable: true, ...(opt('state') === 'closed' ? { queued: true } : {}) }); process.exit(0); }
  if (cmd === 'count') { print({ total: null, blocker: null, cached: false, unavailable: true, first_report: true }); process.exit(0); }
  // obligations during an outage: the client's backup (offline), or nothing to show yet.
  if (cmd === 'obligations') { print(state.backup ? { ...state.backup, recent: [], offline: true, unavailable: true, cached: true, age_s: 120 } : { offline: true, unavailable: true, cached: false }); process.exit(0); }
  process.stderr.write(JSON.stringify({ error: 'comms unavailable', code: 'UNAVAILABLE' }) + '\n');
  process.exit(2);
}

switch (cmd) {
  case 'health': print({ ok: true, instance_id: 'stub', version: model === 2 ? '0.5.0' : '0.4.21', ...(model == null ? {} : { model }) }); break;
  case 'key': print({ sender: opt('sender'), key: state.key || 'k-stub' }); break;
  case 'register-topic':
    if (state.register_fail) { process.stderr.write(JSON.stringify({ error: 'comms unavailable' }) + '\n'); process.exit(2); }
    print({ created: true });
    break;
  case 'obligations': {
    const topics = String(opt('topics') || '').split(',').filter(Boolean);
    const listed = state.by_topic ? messages.filter((m) => topics.some((t) => t.split('/').pop() === m.topic)) : messages;
    const since = Number(opt('since') || 0);
    const recent = (state.recent || []).filter((r) => !since || r.seq > since);
    print({
      inbox: { n: listed.length, ids: listed.map((m) => ({ id: m.id, level: m.level, reply_to: m.reply_to || null, reply_state: m.reply_state || null, code_answer: m.code_answer || null, expired_at: m.expired_at || null })) },
      owed: state.owed || [], awaiting: state.awaiting || [], recent,
      cursor: Math.max(since, ...recent.map((r) => r.seq), 0),
      topics: topics.map((t) => { const [p, id] = t.split('/'); const rec = (state.topics || {})[t]; return { project: p, topic: id, registered: !!rec, state: rec ? rec.state || 'open' : null }; }),
      server: { version: '0.5.0', model: 2, instance_id: 'stub' },
      ...(state.wake ? { wake: state.wake } : {}),
    });
    break;
  }
  case 'count': {
    const res = { total: messages.length, blocker: messages.filter((m) => m.level === 'blocker').length, ids: messages.map((m) => m.id) };
    res.items = messages.map((m) => ({ id: m.id, level: m.level, reply_to: m.reply_to || null, to_thread: m.to_thread || null, sender: m.sender || 'bob', created_at: m.created_at || '2026-11-01T10:00:00.000Z' }));
    print(res);
    break;
  }
  case 'receive': {
    const ids = all('id');
    print({ messages: ids.length ? messages.filter((m) => ids.includes(m.id)) : messages });
    break;
  }
  case 'resolve': case 'settle': case 'ack': case 'withdraw': {
    const id = opt('id');
    if (state.resolves) { state.resolves.push({ argv, text: stdin() }); save(); }
    if (state.queued) { print({ queued: true, client_op_id: 'op-stub', outbox_file: 'stub-outbox/1.json', message: 'comms unavailable' }); break; }
    const st = (state.resolve_409 || {})[id];
    if (st) refuse(409, `správa ${id} je už vybavená (${st.resolution || st.status})`, { id, ...st });
    if (cmd === 'withdraw') { print({ id, status: 'done', resolution: 'withdrawn' }); break; }
    const text = cmd === 'resolve' && argv.includes('--text');
    const resolution = cmd === 'ack' ? 'acked' : cmd === 'settle' || !text ? 'settled' : 'reply';
    const final = cmd !== 'resolve' || opt('state') === 'hotovo';
    print({ id, status: final ? 'done' : 'waiting', resolution: final ? resolution : null, answer_state: cmd === 'resolve' ? opt('state') : 'hotovo', answer_id: text ? `r-${id}` : null, answer_delivered: text ? true : null });
    break;
  }
  case 'send':
    if (state.sends) { state.sends.push({ argv, text: stdin() }); save(); }
    if (state.send_queued) { print({ queued: true, outbox_file: 'stub-outbox/1.json', message: 'comms unavailable; queued in the outbox' }); break; }
    if (state.send_fail) refuse(500, 'stub send failed');
    // send --maintainer (operator 2026-11-16): the server names the maintainer's T3 thread, or refuses with 404.
    if (argv.includes('--maintainer')) {
      if (state.no_maintainer) refuse(404, 'na tomto serveri nie je nastavené vlákno správcu (instance.json maintainer.thread)');
      print({ id: state.send_id || 'm-sent', status: 'pending', level: opt('level'), to_thread: state.maintainer_thread || 'thread-maint', expires_at: '2026-11-01T12:30:00.000Z', wait_due_at: '2026-11-01T11:00:00.000Z' }); break;
    }
    if ((state.send_closed_topic || []).includes(`${opt('project')}/${opt('topic')}`)) refuse(410, `téma ${opt('project')}/${opt('topic')} je uzavretá`);
    if ((state.send_held_to || []).includes(opt('persona') ? `@${opt('persona')}` : `${opt('project')}/${opt('topic')}`)) { print({ id: `m-held-${(state.sends || []).length}`, status: 'held', notice_id: 'n-held', expires_at: '2026-11-01T12:30:00.000Z', project_known: true }); break; }
    if (state.send_held) { print({ id: 'm-held', status: 'held', notice_id: 'n-1', expires_at: '2026-11-01T12:30:00.000Z', ...(state.project_known ? { project_known: true } : {}) }); break; }
    print({ id: state.send_id || 'm-sent', status: 'pending', level: opt('level'), expires_at: opt('ttl') ? '2026-11-01T12:30:00.000Z' : null, wait_due_at: opt('level') === 'steer' ? null : '2026-11-01T11:00:00.000Z' }); break;
  case 'turn':
    if (state.turn === 'unknown') { process.stderr.write('unknown command: turn\n'); process.exit(1); }
    {
      const unknown = (state.turn_unknown || []).find((k) => argv.includes(`--${k}`));
      if (unknown) { process.stderr.write(JSON.stringify({ error: `neznáma voľba --${unknown}` }) + '\n'); process.exit(1); }
    }
    if (state.turn === 'old') {
      if (argv.includes('--opened-at')) { process.stderr.write(JSON.stringify({ error: 'neznáma voľba --opened-at' }) + '\n'); process.exit(1); }
      print({ ok: true, state: opt('state') });
      break;
    }
    if (opt('state') === 'open') print({ ok: true, turn: { state: 'open', opened_at: state.opened_at || '2026-11-01T10:00:00.000Z' } });
    else print({ ok: true, ...(opt('opened-at') && state.opened_at && opt('opened-at') !== state.opened_at ? { stale: true } : {}) });
    break;
  case 'decide': {
    if (state.decide_expired) { const n = (state.notices || []).find((x) => x.id === opt('notice')); refuse(409, `správa ${n?.message_id} vypršala bez doručenia`, { message_id: n?.message_id, expired_at: '2026-11-01T12:30:00.000Z', decision: opt('decision') }); }
    if (state.decide_fail) refuse(409, 'stub decide failed');
    const n = (state.notices || []).find((x) => x.id === opt('notice'));
    if (n) {
      n.state = 'decided'; n.decision = opt('decision');
      const m = (state.message || {})[n.message_id];
      if (m && opt('decision') === 'deliver') m.status = 'pending';
      if (m && opt('decision') === 'discard') m.status = 'discarded';
      if (m && opt('decision') === 'redirect') { const [p, t] = String(opt('target') || '').split('/'); Object.assign(m, { status: 'pending', project: p, topic: t }); }
      save();
    }
    print({ notice_id: opt('notice'), decision: opt('decision') });
    break;
  }
  case 'notices': print({ notices: (state.notices || []).filter((n) => argv.includes('--all') || n.state === 'open') }); break;
  case 'message': {
    const m = (state.message || {})[opt('id')];
    if (!m) refuse(404, 'správa neexistuje');
    print(m);
    break;
  }
  case 'flush': print({ sent: [], dropped: [], rejected: [], remaining: 0, lines: [] }); break;
  default:
    process.stderr.write(`stub: unknown command ${cmd}\n`);
    process.exit(1);
}
