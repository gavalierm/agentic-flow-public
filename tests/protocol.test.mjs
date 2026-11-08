// P-061 (operator 2026-11-08): the reply protocol. The Stop hook reads only the declared state line and the
// "Pre teba" question, never the wording of a promise: "Commitnem pri tvojej najbližšej správe" without a state ended
// bob's bell turn and broke the loop of work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { parseReply } from '../scripts/protocol.mjs';
import { setTimer } from '../scripts/waker.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));

test('parseReply: the state is the last line only; diacritics and markdown are tolerated; the question sits under Pre teba', () => {
  assert.deepEqual(parseReply('Vydané.\n\nStav: hotovo'), { state: 'hotovo', question: null, waitFor: null });
  assert.equal(parseReply('Hotové.\n**Stav:** cakam').state, 'čakám');
  assert.equal(parseReply('x\nstav: Otázka.\n\n').state, 'otázka');
  assert.equal(parseReply('Stav: hotovo\nA ešte niečo urobím neskôr.').state, null, 'the state must be the last line');
  assert.equal(parseReply('Stav: možno').state, null);
  assert.equal(parseReply('Commitnem a pushnem pri tvojej najbližšej správe.').state, null, 'a promise is no state');
  assert.equal(parseReply('').state, null);
  assert.equal(parseReply(undefined).state, null);
  const q = parseReply('Návrh je hotový.\n\n**Pre teba:** Vydať teraz? Odporúčam áno.\n\nStav: otázka');
  assert.deepEqual(q, { state: 'otázka', question: 'Vydať teraz?', waitFor: null });
  assert.equal(parseReply('**Pre teba:** schváľ port.\n\nStav: otázka').question, null, 'no question mark, no question');
});

test('Stop: a reply without a state blocks once in every turn; ending anyway closes the turn', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Opravené, testy prešli.' });
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /no state line.*Stav: hotovo/s);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: 'Opravené, testy prešli.' }).json.decision, undefined);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Opravené, testy prešli.\n\nStav: hotovo' }).json.decision, undefined);
    assert.equal(stateOf(fx).timer, undefined, '"hotovo" arms no timer');
  } finally { fx.cleanup(); }
});

test('Stop: "otázka" is asked in the dialog; a text fallback after a dialog needs a question under Pre teba and rings in hours', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Vydať teraz?\n\nStav: otázka' }).json.reason, /with AskUserQuestion now/);
    fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Vydať teraz?\n\nStav: otázka' }).json.reason, /no question under \*\*Pre teba:\*\*/);
    const ok = 'Návrh je hotový.\n\n**Pre teba:** Vydať teraz? Odporúčam áno.\n\nStav: otázka';
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: ok }).json.decision, undefined);
    const t = stateOf(fx).timer;
    assert.ok(t?.auto && Date.parse(t.at) - Date.now() > 3 * 3600_000, 'waiting on the operator rings in hours');
  } finally { fx.cleanup(); }
});

test('Stop: "hotovo" while the handover has a next step blocks, also in a bell turn; a waker or done step passes', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'alpha', '--task', 'Oprava', '--done', 'Oprava je v dev.', '--next', 'Vydať v0.9.29.']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Odpovedal som.\n\nStav: hotovo' });
    assert.match(r.json.reason, /handover of topic alpha has a next step: "Vydať v0\.9\.29\."/);
    setTimer(fx.brain, fx.thread, { delayMs: 30 * 60_000, then: 'release' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Vydanie po pilote.\n\nStav: čakám (na pilot)' }).json.decision, undefined);
  } finally { fx.cleanup(); }
});

// Operator 2026-11-08: "Stav: čakám" must also say what it waits for.
test('parseReply: čakám carries what it waits for, in parentheses or after "na"; other states take no text', () => {
  assert.equal(parseReply('Pracovník beží.\n\nStav: čakám (na návrh od pracovníka)').waitFor, 'na návrh od pracovníka');
  assert.equal(parseReply('**Stav:** cakam na build.').waitFor, 'na build');
  assert.deepEqual(parseReply('Stav: čakám'), { state: 'čakám', question: null, waitFor: null });
  assert.equal(parseReply('Stav: čakám ()').waitFor, null, 'empty parentheses name nothing');
  assert.equal(parseReply('Stav: hotovo (všetko)').state, null, 'only čakám may carry text');
});

test('Stop: "Stav: čakám" without what it waits for blocks once, even with a waker armed', () => {
  const fx = setup();
  try {
    setTimer(fx.brain, fx.thread, { delayMs: 60_000, then: 'check the build' });
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Build beží.\n\nStav: čakám' });
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /not what it waits for.*"Stav: čakám \(na <what>\)"/);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Build beží.\n\nStav: čakám (na build)' }).json.decision, undefined);
  } finally {
    fx.cleanup();
  }
});
