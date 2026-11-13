// P-063 (report-f10bd0ef): after the operator says the agent misread them, the first worker start of the turn is refused once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const MISREAD = /saying you misread them[^]*P-063/;

function started() {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
  return fx;
}

test('misread turn: the first worker start is refused once, a repeat passes; an instruction turn and a dialog answer stay open (P-063)', () => {
  const fx = started();
  try {
    const agent = () => fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'navrhni fázy práce', description: 'x' } });
    const prepare = () => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'node bin/delegate.mjs prepare --task "x"' } });

    const said = fx.hook('user-prompt-submit.mjs', { prompt: 'nepochopil si, chcel som návrh, ako budeme pracovať' });
    assert.equal(stateOf(fx).turn_intent, 'misread');
    assert.match(said.context, /refused once in this turn \(P-063\)/);
    const first = agent();
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(first), MISREAD);
    assert.doesNotMatch(reasonOf(agent()), MISREAD, 'once per turn: the repeat passes');

    fx.hook('user-prompt-submit.mjs', { prompt: 'to som nemyslel' });
    assert.match(reasonOf(prepare()), MISREAD, 'a brief from delegate.mjs prepare starts a worker too');

    fx.hook('user-prompt-submit.mjs', { prompt: 'to som nemyslel' });
    const q = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ktorý výklad?' }] } };
    fx.hook('pre-tool-use.mjs', q);
    fx.hook('post-tool-use.mjs', { ...q, tool_response: { answers: { 'Ktorý výklad?': 'organizácia spolupráce' } } });
    assert.doesNotMatch(reasonOf(agent()), MISREAD, 'the operator chose the reading in the dialog');

    fx.hook('user-prompt-submit.mjs', { prompt: 'navrhni postup práce' });
    assert.equal(stateOf(fx).turn_intent, null);
    assert.doesNotMatch(reasonOf(agent()), MISREAD, 'an instruction turn is open');
  } finally { fx.cleanup(); }
});
