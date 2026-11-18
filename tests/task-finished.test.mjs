// keep: core
// A finished background task spends its waker (operator 2026-11-13). The harness notification carries the status in its
// head and the agent's result after it, so the closing tag may be thousands of characters away (2026-11-16: 3 354
// characters; four finished agents kept their wakers for 2 h and the turn closed "čakám" with no continuation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedTasks, withoutFinished } from '../scripts/waker.mjs';

const note = (id, status, result) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/x/${id}.output</output-file>\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n<result>${result}</result>\n</task-notification>`;

test('finishedTasks: a final status in the head counts also with a long result; a running one and a status inside a result do not', () => {
  const long = 'riadok výsledku pracovníka\n'.repeat(300);
  const text = [note('a1', 'completed', long), note('a2', 'running', '<status>completed</status>'), note('a3', 'failed', 'x')].join('\n');
  assert.deepEqual([...finishedTasks(text)].sort(), ['a1', 'a3']);
  // JSON-escaped as in the session transcript
  assert.deepEqual([...finishedTasks(JSON.stringify({ content: note('a4', 'completed', long) }))], ['a4']);
});

test('finishedTasks: "completed" of an agent waiting on its own background work or resumed is interim; the last notification decides', () => {
  const interim = note('b1', 'completed', 'čakám').replace('Agent "x" finished', 'Agent "x" is waiting on its own background work')
    .replace('A task-notification fires each time this agent stops.', 'This agent stopped with background work of its own still running. It may resume on its own; the result below may be interim.');
  const resumed = note('b1', 'completed', 'hotovo').replace('this agent stops.', 'this agent stops. The agent is being resumed with them and will notify again.');
  assert.deepEqual([...finishedTasks(interim)], []);
  assert.deepEqual([...finishedTasks([note('b1', 'completed', 'x'), interim].join('\n'))], []);
  assert.deepEqual([...finishedTasks([interim, resumed].join('\n'))], []);
  assert.deepEqual([...finishedTasks([interim, note('b1', 'completed', 'hotovo')].join('\n'))], ['b1']);
});

test('withoutFinished: a waker whose tasks all ended goes, one with a running task stays', () => {
  const wakers = [{ kind: 'agent', tasks: ['a1'] }, { kind: 'agent', tasks: ['a1', 'a2'] }, { kind: 'scheduler', recurring: true }];
  assert.deepEqual(withoutFinished(wakers, new Set(['a1'])), wakers.slice(1));
});
