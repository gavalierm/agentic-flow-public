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

// operator 2026-11-17: an operator's proposal the agent verified and agrees with is approved; no „súhlasíš s návrhom?“.
test('an operator proposal the agent verified and agrees with is approved (P-059)', async () => {
  const fs = await import('node:fs');
  const rules = fs.readFileSync(new URL('../rules/01-scope.md', import.meta.url), 'utf8');
  assert.match(rules, /ktorú si overil a s ktorou súhlasíš, je schválená/);
  assert.match(QUESTION_TURN_LINE, /proposal of the operator asked as a question.*approved once you verified it and agree/);
});
