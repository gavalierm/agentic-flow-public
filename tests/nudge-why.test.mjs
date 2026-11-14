// Operator nudge (operator 2026-11-14): bin/nudge-why.mjs names from the records why the operator had to wake the thread
// (a timer due and not rung, a turn ended "čakám" without a waker, a tool call without its result), and the nudge line of
// the prompt hook carries its command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { diagnose, format, readTranscript } from '../scripts/nudge-why.mjs';
import { nudgeLine } from '../hooks/user-prompt-submit.mjs';

const NOW = Date.parse('2026-11-14T07:00:00Z');
const iso = (h, m = 0) => new Date(Date.UTC(2026, 10, 14, h, m)).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const call = (at, id, name, input) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (at, id) => ({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const prompt = (at, text) => ({ type: 'user', timestamp: at, message: { role: 'user', content: text } });

function threadFixture(fx, state, transcriptRows, wakeLog = '') {
  const threads = path.join(fx.brain, 'local', 'threads');
  fs.mkdirSync(threads, { recursive: true });
  fs.writeFileSync(path.join(threads, `${fx.thread}.json`), JSON.stringify(state));
  const transcript = path.join(fx.root, 'session.jsonl');
  fs.writeFileSync(transcript, jsonl(transcriptRows));
  const log = path.join(fx.root, 'wake.log');
  fs.writeFileSync(log, wakeLog);
  return fx.run('nudge-why.mjs', ['--transcript', transcript, '--wake-log', log, '--comms-dir', path.join(fx.root, 'no-comms'), '--now', new Date(NOW).toISOString()]);
}

test('nudge-why: a timer due and not rung while a tool call waited for its result (approval window)', () => {
  const fx = setup();
  try {
    const r = threadFixture(fx, {
      last_end_state: 'čakám', last_end_at: iso(1, 0), last_close: { next: 'check topic x', resume_at: iso(1, 30) },
      timer: { at: iso(1, 46), then: 'check topic x', set_at: iso(1, 21) },
    }, [
      prompt(iso(1, 10), 'continue'),
      call(iso(1, 24), 'tu1', 'Bash', { command: 'rm -rf /some/dir', description: 'remove leftover dirs' }),
      result(iso(6, 49), 'tu1'),
      prompt(iso(6, 51), 'up'),
    ], `[wake ${iso(1, 42)}] rang 1004 expired → ${fx.thread}: "no reply m1" (1/6 za hodinu); vlákno má otvorený ťah, zvonček zaradený\n`);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /timer 1: .* due, not rung .*the turn was open then \(Bash: remove leftover dirs/);
    assert.match(r.stdout, /^cause: timer-not-rung \(workflow error\): /m);
    assert.match(r.stdout, /^cause: approval-window \(workflow error\): the turn stood on an approval window of Bash: remove leftover dirs/m);
    assert.match(r.stdout, /^- bell: .*rang 1004 .*zvonček zaradený/m);
    assert.match(r.stdout, /^verdict: workflow error: fix it \(skill fix\)/m);
  } finally { fx.cleanup(); }
});

test('nudge-why: a turn ended "Stav: čakám" without a waker', () => {
  const fx = setup();
  try {
    const r = threadFixture(fx, { last_end_state: 'čakám', last_end_at: iso(2, 0), last_close: { next: null, resume_at: null } }, [
      prompt(iso(1, 50), 'do the work'),
      call(iso(1, 55), 'tu1', 'Read', { file_path: '/x' }),
      result(iso(1, 55), 'tu1'),
      prompt(iso(6, 30), 'up'),
    ]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^- last turn: ended .*, Stav: čakám, waker: none/m);
    assert.match(r.stdout, /^cause: no-waker \(workflow error\): the turn ended .* with "Stav: čakám" and no waker/m);
    assert.match(r.stdout, /^- timers: none$/m);
    assert.doesNotMatch(r.stdout, /cause: approval-window|cause: timer-not-rung/);
  } finally { fx.cleanup(); }
});

test('nudge-why: the last tool call has no result (a dialog still open)', () => {
  const fx = setup();
  try {
    const r = threadFixture(fx, { last_end_state: 'hotovo', last_end_at: iso(0, 30), last_close: {} }, [
      prompt(iso(1, 0), 'next task'),
      call(iso(1, 5), 'tu1', 'AskUserQuestion', { questions: [{ question: 'Which option?' }] }),
    ]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^- transcript: AskUserQuestion: Which option\?: called .*, no result yet \(dialog open/m);
    assert.match(r.stdout, /^cause: dialog: the turn stood on a dialog of AskUserQuestion: Which option\? since .* and still open/m);
  } finally { fx.cleanup(); }
});

test('nudge-why: a call made after the nudge (this script\'s own run) is not a waiting call; a pending timer is no cause', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-'));
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, jsonl([prompt(iso(6, 0), 'up'), call(iso(6, 1), 'tu9', 'Bash', { command: 'node bin/nudge-why.mjs' })]));
    const res = diagnose({ thread: 't', state: { last_end_state: 'čakám', last_end_at: iso(5, 0), last_close: { resume_at: iso(8, 0) }, timer: { at: iso(8, 0), then: 'x' } }, transcript: readTranscript(f), now: NOW });
    assert.deepEqual(res.causes.map((c) => c.kind), ['unknown']);
    assert.match(format({ thread: 't', ...res }), /verdict: no workflow error/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nudge line: runs nudge-why with the thread and transcript, names the cause, then mail and the handover step', () => {
  const line = nudgeLine('t1', '/s/x.jsonl');
  assert.match(line, /^operator nudge: .*First run node ".*\/bin\/nudge-why\.mjs" --thread "t1" --transcript "\/s\/x\.jsonl" and name in one sentence/);
  assert.match(line, /fix it \(skill fix\) or queue the fix/);
  assert.match(line, /Then handle mail .* next step of the handover/);
  const fx = setup();
  try {
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'up', transcript_path: path.join(fx.root, 's.jsonl') });
    assert.match(r.context, /operator nudge: .*bin\/nudge-why\.mjs" --thread "a1" --transcript ".*s\.jsonl"/);
  } finally { fx.cleanup(); }
});
