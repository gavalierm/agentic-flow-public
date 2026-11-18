// keep: core
// Flow v2 spec 10.2 (plan B1, O1): the state of a topic is computed from facts only (next step, items of Otvorené otázky
// and Úlohy pre operátora, running alarms), over several topics, with the earliest alarm; of the mail only the awaiting
// answers with a next check enter. The fields of v2 (`turn`, `mode`, `repos`) go into the topic record in one op with
// the holder and keep every other field, `state` (working | paused | closed) included.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeState, summaryState, turnAlarms, earliestAlarm, turnFields, DONE, QUESTION, WAITING } from '../scripts/topic-state.mjs';
import { fieldsOp, holderOp, topicOp, mergeTopicOps } from '../scripts/topic-files.mjs';

test('10.2 table: an item in Otázky or Úlohy = otázka (also with a next step, operator 2026-11-17), else next step or alarm = čakám, else hotovo', () => {
  const timer = [{ kind: 'timer', at: '2026-11-15T10:00:00Z' }];
  const cases = [
    [{}, DONE],
    [{ next: [], questions: [], tasks: [], alarms: [] }, DONE],
    [{ questions: ['Ktorá verzia?'] }, QUESTION],
    [{ tasks: ['Schváľ zverejnenie'] }, QUESTION],
    [{ questions: 1, tasks: 2 }, QUESTION],
    [{ next: ['spusti testy'] }, WAITING],
    [{ next: ['a', 'b'], questions: ['q'], tasks: ['t'] }, QUESTION],
    [{ alarms: timer }, WAITING],
    [{ alarms: timer, questions: ['q'] }, QUESTION],
    [{ next: 0, questions: 0, tasks: 0, alarms: 0 }, DONE],
  ];
  for (const [facts, want] of cases) assert.equal(computeState(facts), want, JSON.stringify(facts));
});

test('several held topics: otázka when one asks, else čakám when one waits, else hotovo', () => {
  assert.equal(summaryState([]), DONE);
  assert.equal(summaryState([DONE, DONE]), DONE);
  assert.equal(summaryState([DONE, QUESTION]), QUESTION);
  assert.equal(summaryState([QUESTION, WAITING, DONE]), QUESTION);
  assert.equal(summaryState([{ questions: ['q'] }, { next: ['krok'] }]), QUESTION);
  assert.equal(summaryState([WAITING, DONE]), WAITING);
  assert.equal(summaryState([{ tasks: ['t'] }, {}]), QUESTION);
});

test('alarms: timer, background task and mail check with their times; the continuation is the end of the turn unless a timer or a task runs', () => {
  const end = '2026-11-15T12:00:00.000Z';
  const timers = [{ at: '2026-11-15T13:00:00Z' }];
  const background = [{ at: '2026-11-15T12:30:00Z', id: 'bg1' }];
  const awaiting = [{ id: 'm1', wait_due_at: '2026-11-15T12:10:00Z' }, { id: 'm2', wait_due_at: null }];
  // Only the continuation: its time is the end of the turn.
  let alarms = turnAlarms({ next: ['krok'], turnEnd: end });
  assert.deepEqual(alarms, [{ kind: 'continue', at: end }]);
  assert.equal(earliestAlarm(alarms).at, end);
  // A timer or a background task holds the continuation back: it wakes the thread, the step runs after it.
  alarms = turnAlarms({ next: ['krok'], timers, turnEnd: end });
  assert.deepEqual(alarms.map((a) => a.kind), ['timer']);
  alarms = turnAlarms({ next: ['krok'], background, turnEnd: end });
  assert.deepEqual(alarms.map((a) => a.kind), ['task']);
  // Mail does not hold it back (3.3.3); the earliest of all alarms is the one written.
  alarms = turnAlarms({ next: ['krok'], awaiting, turnEnd: end });
  assert.deepEqual(alarms.map((a) => a.kind).sort(), ['continue', 'mail']);
  assert.equal(earliestAlarm(alarms).at, end);
  alarms = turnAlarms({ timers, background, awaiting, turnEnd: end });
  assert.deepEqual(alarms.map((a) => a.kind).sort(), ['mail', 'task', 'timer'], 'no step: no continuation');
  assert.deepEqual(earliestAlarm(alarms), { kind: 'mail', at: '2026-11-15T12:10:00.000Z', id: 'm1' });
  assert.equal(earliestAlarm([]), null);
  // turn fields to write: state from facts, alarm_at the earliest time (null without an alarm).
  assert.deepEqual(turnFields({ next: ['krok'], alarms: turnAlarms({ next: ['krok'], awaiting, turnEnd: end }) }), { state: WAITING, alarm_at: end });
  assert.deepEqual(turnFields({ questions: ['q'] }), { state: QUESTION, alarm_at: null });
  assert.deepEqual(turnFields({}), { state: DONE, alarm_at: null });
});

test('mail enters the state only as an awaiting answer with a next check: inbox, owed and a wait without a check do not', () => {
  const obligations = {
    inbox: { n: 2, items: [{ id: 'i1', level: 'steer' }] },
    owed: [{ id: 'o1', level: 'blocker' }],
    awaiting: [{ id: 'a1', status: 'picked', wait_due_at: null }, { id: 'a2', status: 'no answer', wait_due_at: undefined }],
    recent: [{ id: 'r1', text: 'no reply r1' }],
  };
  const alarms = turnAlarms({ ...obligations, turnEnd: '2026-11-15T12:00:00Z' });
  assert.deepEqual(alarms, []);
  assert.equal(computeState({ alarms }), DONE);
  const waiting = turnAlarms({ awaiting: [{ id: 'a3', wait_due_at: '2026-11-15T14:00:00Z' }] });
  assert.equal(computeState({ alarms: waiting }), WAITING);
});

function brain(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ts-'));
  if (layout === 2) {
    fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
  }
  return dir;
}
const write = (dir, ops) => { for (const op of mergeTopicOps(dir, ops)) { fs.mkdirSync(path.dirname(path.join(dir, op.path)), { recursive: true }); fs.writeFileSync(path.join(dir, op.path), op.content); } };

test('fields of v2 (turn, mode, repos) go in one op with the holder and keep the other fields, state included (O1)', () => {
  const dir = brain(2);
  try {
    const rel = path.join('temy', 't1', '.tema.json');
    fs.mkdirSync(path.join(dir, 'temy', 't1'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ id: 't1', class: 'code', kind: 'code', state: 'working', repo: 'app', mode: 'off', turn: { state: DONE, alarm_at: null, continues: { n: 1 } }, holder: { thread: 'a1' } }));
    const ops = [fieldsOp(dir, 't1', { turn: { state: WAITING, alarm_at: '2026-11-15T12:00:00.000Z' } }), holderOp(dir, 't1', { thread: 'b2', machine: 'm' })];
    const merged = mergeTopicOps(dir, ops);
    assert.equal(merged.length, 1, 'one op for one .tema.json');
    write(dir, ops);
    const tema = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    assert.deepEqual(tema.turn, { state: WAITING, alarm_at: '2026-11-15T12:00:00.000Z', continues: { n: 1 } }, 'turn merges key by key');
    assert.equal(tema.state, 'working', 'state working|paused|closed stays');
    assert.equal(tema.repo, 'app');
    assert.equal(tema.mode, 'off');
    assert.deepEqual(tema.holder, { thread: 'b2', machine: 'm' });
    // A turn key set to null stays null; mode and repos are top-level fields; a topic op of the same write comes first.
    write(dir, [topicOp(dir, 't1', { ...JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')), state: 'paused' }), fieldsOp(dir, 't1', { mode: 'discussion', repos: { main: 'app', list: ['app'] }, turn: { continues: null, stuck: ['krok'] } })]);
    const after = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    assert.equal(after.state, 'paused');
    assert.equal(after.mode, 'discussion');
    assert.deepEqual(after.repos, { main: 'app', list: ['app'] });
    assert.deepEqual(after.turn, { state: WAITING, alarm_at: '2026-11-15T12:00:00.000Z', continues: null, stuck: ['krok'] });
    assert.deepEqual(after.holder, { thread: 'b2', machine: 'm' });
    assert.throws(() => fieldsOp(dir, 't1', { status: 'x' }), /unknown topic field status/);
    assert.throws(() => fieldsOp(dir, 't1', { turn: { stav: 'x' } }), /unknown turn field stav/);
    assert.throws(() => fieldsOp(dir, 't1', { mode: 'talk' }), /mode talk/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('layout 1: fields merge into topic.json with a topic op of the same write, holder.json stays apart', () => {
  const dir = brain(1);
  try {
    const rel = path.join('topics', 't1', 'topic.json');
    fs.mkdirSync(path.join(dir, 'topics', 't1'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ id: 't1', state: 'working' }));
    const ops = [topicOp(dir, 't1', { id: 't1', state: 'working', subject: 'S' }), fieldsOp(dir, 't1', { turn: { state: QUESTION, alarm_at: null } }), holderOp(dir, 't1', { thread: 'a1' })];
    const merged = mergeTopicOps(dir, ops);
    assert.equal(merged.filter((op) => op.path === rel.split(path.sep).join('/')).length, 1);
    write(dir, ops);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')), { id: 't1', state: 'working', subject: 'S', turn: { state: QUESTION, alarm_at: null } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'topics', 't1', 'holder.json'), 'utf8')), { thread: 'a1' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
