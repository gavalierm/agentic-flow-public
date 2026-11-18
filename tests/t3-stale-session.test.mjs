// keep: guarded
// T3-WORKAROUND(t3-stale-session), pingdotgg/t3code#38764 (operator 2026-11-18): a prompt T3 routes to an older Claude
// session of the thread gets the turns another session wrote since that session's last prompt; a new session does not get
// what came before it; one session costs nothing.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleSessionCatchUp } from '../scripts/t3-stale-session.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const line = (o) => `${JSON.stringify(o)}\n`;
const user = (at, content, extra = {}) => line({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra });
const agent = (at, content, extra = {}) => line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content }, ...extra });

test('a prompt routed to the older session gets the turns of the newer one once; a new session starts clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stale-'));
  const ta = path.join(dir, `${A}.jsonl`);
  const tb = path.join(dir, `${B}.jsonl`);
  fs.writeFileSync(ta, user('2026-11-18T21:34:50.000Z', 'pre-clear task') + agent('2026-11-18T21:35:00.000Z', [{ type: 'text', text: 'pre-clear reply' }]));

  // One session: registered, nothing to show.
  let r = staleSessionCatchUp({ session_id: A, transcript_path: ta }, {}, { now: new Date('2026-11-18T21:34:50.000Z') });
  assert.equal(r.block, '');
  let state = { ...r.patch };

  // Fresh context: session B starts; what A wrote before is not its context.
  const long = `${'x'.repeat(3000)} Povedz A alebo B.`;
  fs.writeFileSync(tb,
    user('2026-11-18T21:39:16.000Z', 'KAZDY PROMPT?')
    + agent('2026-11-18T21:39:20.000Z', [{ type: 'thinking', thinking: 'hidden' }])
    + agent('2026-11-18T21:39:21.000Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }])
    + user('2026-11-18T21:39:22.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output' }])
    + user('2026-11-18T21:39:23.000Z', '<task-notification>done</task-notification>')
    + agent('2026-11-18T21:39:24.000Z', [{ type: 'text', text: 'subagent text' }], { isSidechain: true })
    + agent('2026-11-18T21:39:40.000Z', [{ type: 'text', text: long }]));
  r = staleSessionCatchUp({ session_id: B, transcript_path: tb }, state, { now: new Date('2026-11-18T21:39:16.000Z') });
  assert.equal(r.block, '', 'a new session gets nothing from before it');
  state = { ...state, ...r.patch };
  fs.utimesSync(tb, new Date('2026-11-18T21:39:41Z'), new Date('2026-11-18T21:39:41Z'));

  // T3 routes the next prompt to A: it gets B's operator prompt and reply, with the reply's end (the options).
  r = staleSessionCatchUp({ session_id: A, transcript_path: ta }, state, { now: new Date('2026-11-18T21:43:07.000Z') });
  assert.match(r.block, /T3 session split/);
  assert.match(r.block, /\[21:39 operator\] KAZDY PROMPT\?/);
  assert.match(r.block, /Povedz A alebo B\.$/m);
  for (const hidden of ['hidden', 'tool output', 'task-notification', 'subagent text', 'pre-clear']) assert.ok(!r.block.includes(hidden), hidden);
  state = { ...state, ...r.patch };

  // The next prompt in A: nothing new.
  r = staleSessionCatchUp({ session_id: A, transcript_path: ta }, state, { now: new Date('2026-11-18T21:44:00.000Z') });
  assert.equal(r.block, '');
  assert.deepEqual(Object.keys(r.patch.t3_sessions).sort(), [A, B]);
});

test('a transcript name linked to the same file (pre-0.1.10 /clear redirect) is not another session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stale-'));
  const tb = path.join(dir, `${B}.jsonl`);
  const ta = path.join(dir, `${A}.jsonl`);
  fs.writeFileSync(tb, user('2026-11-18T22:00:00.000Z', 'same conversation'));
  fs.symlinkSync(`${B}.jsonl`, ta);
  const state = { t3_sessions: { [A]: { transcript: ta, seen_at: '2026-11-18T21:00:00.000Z' }, [B]: { transcript: tb, seen_at: '2026-11-18T21:00:00.000Z' } } };
  const r = staleSessionCatchUp({ session_id: B, transcript_path: tb }, state, { now: new Date('2026-11-18T22:01:00.000Z') });
  assert.equal(r.block, '');
});
