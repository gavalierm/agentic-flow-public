// P-063 (report-e640905d): the operator asked to "settle" an effect into the last chosen layer and the agent made it stay open
// longer without saying its reading. An operator instruction turn gets a line: say the reading of a two-way word before the
// first change, ask when the task does not tell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const LINE = /two readings with different results, say in one sentence which reading you take before the first change[^]*P-063/;

test('instruction turn: the reading line comes also without a work topic; a bare continuation, a question, a misread and a bell get none (P-063)', () => {
  const fx = setup();
  try {
    assert.match(fx.hook('user-prompt-submit.mjs', { prompt: 'sprav, nech sa efekt po odchode kurzora ustáli vo vrstve' }).context, LINE, 'no topic');
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Web efekt', '--class', 'discussion']).status, 0);
    assert.match(fx.hook('user-prompt-submit.mjs', { prompt: 'sprav, nech sa efekt po odchode kurzora ustáli vo vrstve' }).context, LINE, 'work topic');
    const notice = '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Release workflow v1" completed (exit code 0)</summary>\n</task-notification>\n</system-reminder>';
    for (const prompt of ['ďalej', 'pokračuj', 'prosím, pokračuj', 'čo robí ten efekt?', 'nie tak, to som nemyslel', 'you have mail in topic alpha', notice]) {
      assert.doesNotMatch(fx.hook('user-prompt-submit.mjs', { prompt }).context || '', LINE, prompt);
    }
  } finally { fx.cleanup(); }
});
