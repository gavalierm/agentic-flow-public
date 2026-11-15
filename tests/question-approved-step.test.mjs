// ttl: 2026-12-15
// report-06d22fbc: a question turn must not turn a step the operator already approved into a question.
// agent-alice/D-0094 (P-076): the line leads the turn, nothing refuses the first write any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION_TURN_LINE } from '../hooks/user-prompt-submit.mjs';

test('question line: an approved step is done and announced, not asked about', () => {
  assert.equal(typeof QUESTION_TURN_LINE, 'string');
  assert.match(QUESTION_TURN_LINE, /already approved in this topic/);
  assert.match(QUESTION_TURN_LINE, /do it and say so, do not ask about it \(P-059\)/);
  assert.match(QUESTION_TURN_LINE, /do not make it \(P-063\)/);
  assert.doesNotMatch(QUESTION_TURN_LINE, /refused/);
});
