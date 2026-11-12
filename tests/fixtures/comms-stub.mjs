#!/usr/bin/env node
// Stub of the agentic-comms client for workflow tests (WORKFLOW_COMMS_CLIENT). State in STUB_COMMS_STATE (JSON):
//   { messages: [{ id, level, ... }], ids: true|false (server lists ids, default true), down: bool,
//     turn: 'ok'|'unknown'|'old' (old: no opened_at, --opened-at is an unknown option), opened_at: '<iso>' (answer of open),
//     turn_unknown: ['<option>', ...] (turn options an older client refuses as unknown, e.g. 'discussion'),
//     message: { <id>: { ...GET /message fields } }
//     register_fail: true (register-topic exits 2: comms unavailable), by_topic: true (count with --topic lists only the
//     messages of that topic, thread-only count lists none), wake: { running, ... } (count field of comms >= 0.4.6),
//     send_held: true (send to an unregistered topic: state held + notice), send_id: '<id>' (id of a sent message) }
// Every call is appended to STUB_COMMS_LOG as one JSON line (argv). Interface as in hotfix-contract (count ids, send --ttl, turn).
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
const messages = state.messages || [];

if (state.down) {
  // The client queues a `closed` turn in its outbox during an outage (contract hotfix 2); `open` is never queued.
  if (cmd === 'turn') { print({ ok: false, unavailable: true, ...(opt('state') === 'closed' ? { queued: true } : {}) }); process.exit(0); }
  if (cmd === 'count') { print({ total: null, blocker: null, cached: false, unavailable: true, first_report: true }); process.exit(0); }
  process.stderr.write(JSON.stringify({ error: 'comms unavailable' }) + '\n');
  process.exit(2);
}

switch (cmd) {
  case 'health': print({ instance_id: 'stub' }); break;
  case 'register-topic':
    if (state.register_fail) { process.stderr.write(JSON.stringify({ error: 'comms unavailable' }) + '\n'); process.exit(2); }
    print({ created: true });
    break;
  case 'count': {
    const listed = state.by_topic ? (opt('topic') ? messages.filter((m) => m.topic === opt('topic')) : []) : messages;
    const res = { total: listed.length, blocker: listed.filter((m) => m.level === 'blocker').length, cached: false, unavailable: false };
    if (state.ids !== false) res.ids = listed.map((m) => m.id);
    if (state.wake) res.wake = state.wake; // comms >= 0.4.6: { running, pid, heartbeat_at } of this machine's wake
    res.items = listed.map((m) => ({ id: m.id, level: m.level, reply_to: m.reply_to || null, to_thread: m.to_thread || null, sender: m.sender || 'bob', created_at: m.created_at || '2026-11-01T10:00:00.000Z' }));
    print(res);
    break;
  }
  case 'receive': print({ messages }); break;
  case 'ack': {
    const ids = all('id');
    const acked = messages.filter((m) => ids.includes(m.id)).map((m) => m.id);
    state.messages = messages.filter((m) => !ids.includes(m.id));
    save();
    print({ acked });
    break;
  }
  case 'send':
    if (state.send_no_path && argv.includes('--reply-to')) { process.stderr.write(JSON.stringify({ error: 'na pôvodnú správu sa nedá odpovedať: nemá vlákno ani zdrojovú tému', code: 'ERROR', status: 400 }) + '\n'); process.exit(1); }
    if (state.send_closed && argv.includes('--reply-to')) { process.stderr.write(JSON.stringify({ error: 'odosielateľ pôvodnej správy už tému uzavrel: project/gone uzavretá 2026-11-02T21:39:48.512Z', code: 'ERROR', status: 410, details: { closed_at: '2026-11-02T21:39:48.512Z' } }) + '\n'); process.exit(1); }
    if (state.send_held) { print({ id: 'm-held', state: 'held', notice_id: 'n-1', expires_at: '2026-11-01T12:30:00.000Z' }); break; }
    print({ id: state.send_id || 'm-sent', state: 'pending', expires_at: opt('ttl') ? '2026-11-01T12:30:00.000Z' : null }); break;
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
  case 'decide': print({ notice_id: opt('notice'), decision: opt('decision') }); break;
  case 'message': {
    const m = (state.message || {})[opt('id')];
    if (!m) { process.stderr.write(JSON.stringify({ error: 'správa neexistuje' }) + '\n'); process.exit(1); }
    print(m);
    break;
  }
  default:
    process.stderr.write(`stub: unknown command ${cmd}\n`);
    process.exit(1);
}
