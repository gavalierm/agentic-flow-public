// P-061 (operator 2026-11-08): the reply protocol. The Stop hook reads only the declared state line and the
// Operátor items, never the wording of a promise: "Commitnem pri tvojej najbližšej správe" without a state ended
// bob's bell turn and broke the loop of work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { parseReply, repeatsAnswered } from '../scripts/protocol.mjs';
import { setTimer } from '../scripts/waker.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));

test('parseReply: the state is the last line only; diacritics and markdown are tolerated; the question is the first item under Operátor', () => {
  assert.deepEqual(parseReply('Vydané.\n\nStav: hotovo'), { state: 'hotovo', question: null, waitFor: null, operator: null, questions: null, tasks: null, legacyOperator: false, emptySection: null, step: null });
  assert.equal(parseReply('Hotové.\n**Stav:** cakam').state, 'čakám');
  assert.equal(parseReply('x\nstav: Otázka.\n\n').state, 'otázka');
  assert.equal(parseReply('Stav: hotovo\nA ešte niečo urobím neskôr.').state, null, 'the state must be the last line');
  assert.equal(parseReply('Stav: možno').state, null);
  assert.equal(parseReply('Commitnem a pushnem pri tvojej najbližšej správe.').state, null, 'a promise is no state');
  assert.equal(parseReply('').state, null);
  assert.equal(parseReply(undefined).state, null);
  const q = parseReply('Návrh je hotový.\n\n**Otázky na operátora:** Vydať teraz? Odporúčam áno.\n\nStav: otázka');
  assert.deepEqual(q, { state: 'otázka', question: 'Vydať teraz?', waitFor: null, operator: ['Vydať teraz? Odporúčam áno.'], questions: ['Vydať teraz? Odporúčam áno.'], tasks: null, legacyOperator: false, emptySection: null, step: null });
  assert.equal(parseReply('**Pre teba:** Vydať teraz?\n\nStav: otázka').question, 'Vydať teraz?', 'the marker before v0.9.43 still opens the block (legacy)');
  const list = parseReply('Hotové.\n\n**Otázky na operátora:**\n- [ ] Potvrď zmazanie starého priečinka (odporúčam áno)\n- [ ] Spusti wake install\n\nĎalší text.\n\nStav: otázka');
  assert.deepEqual(list.operator, ['Potvrď zmazanie starého priečinka (odporúčam áno)', 'Spusti wake install'], 'checklist items up to an empty line');
  assert.equal(list.question, 'Potvrď zmazanie starého priečinka (odporúčam áno)', 'a confirmation is an item without a question mark');
  assert.deepEqual(parseReply('x\n\n**Otázky na operátora:** nič\n\nStav: hotovo').operator, [], '"nič" is no item');
  assert.equal(parseReply('Login čaká na kód, stačí napísať „pokračuj“.\n\nStav: hotovo').step, 'napísať „pokračuj', 'asking the operator to write "pokračuj" is a step (bob 2026-11-11)');
  assert.equal(parseReply('Napíš pokračuj a dokončím to.\n\nStav: hotovo').step, 'Napíš pokračuj');
  assert.equal(parseReply('Pokračujem v oprave.\n\nStav: hotovo').step, null, 'own continuation is no ask');
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

test('Stop: "otázka" is asked in the dialog; a reply after the dialog needs an item under Operátor and rings in hours', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Vydať teraz?\n\nStav: otázka' }).json.reason, /with AskUserQuestion now/);
    fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Vydať teraz?\n\nStav: otázka' }).json.reason, /no item under \*\*Otázky na operátora:\*\*/);
    const ok = 'Návrh je hotový.\n\n**Otázky na operátora:** Vydať teraz? Odporúčam áno.\n\nStav: otázka';
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
  assert.deepEqual(parseReply('Stav: čakám'), { state: 'čakám', question: null, waitFor: null, operator: null, questions: null, tasks: null, legacyOperator: false, emptySection: null, step: null });
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

test('parseReply: a step written as prose under a label is outside the protocol; "Ostáva: nič" and code blocks are not', () => {
  const carol = '- **Pošta:** testovaciu správu som poslal.\n- **Ostáva:** `~/Work/agenti/carol` naďalej existuje. Zmažem ho až na tvoje potvrdenie.\n\nStav: hotovo';
  assert.match(parseReply(carol).step, /^Ostáva: .*tvoje potvrdenie/);
  assert.match(parseReply('Hotové.\n\nĎalší krok: vydať v0.9.43.\n\nStav: hotovo').step, /^Ďalší krok: vydať/);
  assert.equal(parseReply('Hotové.\n\n**Ostáva:** nič.\n\nStav: hotovo').step, null);
  assert.equal(parseReply('Hotové.\n\n```\nOstáva: x\n```\n\nStav: hotovo').step, null, 'quoted code is no step');
  assert.equal(parseReply('Ostáva overiť nič iné, všetko prešlo.\n\nStav: hotovo').step, null, 'a sentence without a label is no step');
});

test('Stop: a step written as prose or an Operátor item under "hotovo" blocks once (carol 2026-11-09); the protocol form passes', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'presuň personu' });
    const carol = '- **Ostáva:** `~/Work/agenti/carol` naďalej existuje. Zmažem ho až na tvoje potvrdenie.\n\nStav: hotovo';
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: carol });
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /writes a step as prose \("Ostáva:.*Úlohy pre operátora/s);
    const item = 'Presun je hotový.\n\n**Úlohy pre operátora:**\n- [ ] Potvrď zmazanie ~/Work/agenti/carol (odporúčam áno)\n\nStav: hotovo';
    const r2 = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: item });
    assert.equal(r2.json.decision, 'block');
    assert.match(r2.json.reason, /under \*\*Otázky na operátora:\*\* \/ \*\*Úlohy pre operátora:\*\* but declares "Stav: hotovo".*Stav: otázka/s);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: item.replace('Stav: hotovo', 'Stav: čakám (na odpoveď)') }).json.decision, undefined, 'čakám may carry an operator item (D-0011)');
    // Ending anyway: the item still waits on the operator, so the thread gets the operator timer, in hours.
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: item }).json.decision, undefined);
    const t = stateOf(fx).timer;
    assert.ok(t?.auto && Date.parse(t.at) - Date.now() > 3 * 3600_000, 'an Operátor item under hotovo rings in hours');
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: item.replace('Stav: hotovo', 'Stav: otázka') }).json.decision, undefined, 'the protocol form passes');
  } finally { fx.cleanup(); }
});

test('Stop: "napíš pokračuj" under hotovo blocks once; the operator is no waker (bob 2026-11-11)', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'dokonči login' });
    const bob = 'Kód je uložený, ale súbor sa mi v tomto ťahu nedá prečítať. Stačí napísať „pokračuj“ a dokončím prihlásenie.\n\nStav: hotovo';
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: bob });
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /writes a step as prose \("napísať „pokračuj".*save handover --next/s);
  } finally { fx.cleanup(); }
});

test('parseReply: questions and tasks are parsed separately, one alone, the legacy heading, an empty section', () => {
  const both = parseReply('Hotové.\n\n**Otázky na operátora:**\n- [ ] Vydať teraz? (odporúčam áno)\n\n**Úlohy pre operátora:**\n- [ ] Prihlás sa na stroji B\n- [ ] Klikni na Povoliť\n\nStav: otázka');
  assert.deepEqual(both.questions, ['Vydať teraz? (odporúčam áno)']);
  assert.deepEqual(both.tasks, ['Prihlás sa na stroji B', 'Klikni na Povoliť']);
  assert.deepEqual(both.operator, [...both.questions, ...both.tasks]);
  assert.equal(both.question, 'Vydať teraz?');
  assert.equal(both.legacyOperator, false);
  assert.equal(both.emptySection, null);
  const onlyTasks = parseReply('x\n\nÚlohy pre operátora:\n- Spusti install\n\nStav: otázka');
  assert.equal(onlyTasks.questions, null);
  assert.deepEqual(onlyTasks.tasks, ['Spusti install']);
  assert.equal(onlyTasks.question, 'Spusti install', 'the first task when there is no question');
  const ascii = parseReply('x\n\n**otazky na operatora:** Ktorý variant?\n\n**Ulohy pre operatora:** Re-auth\n\nStav: otázka');
  assert.deepEqual(ascii.questions, ['Ktorý variant?']);
  assert.deepEqual(ascii.tasks, ['Re-auth']);
  assert.equal(parseReply('Hotovo.\n\nStav: hotovo').operator, null);
  const legacy = parseReply('x\n\n**Operátor:**\n- [ ] Potvrď\n\nStav: otázka');
  assert.deepEqual(legacy.operator, ['Potvrď']);
  assert.equal(legacy.legacyOperator, true);
  assert.equal(legacy.questions, null);
  assert.equal(parseReply('x\n\n**Úlohy pre operátora:** nič\n\nStav: hotovo').emptySection, '**Úlohy pre operátora:**');
  assert.equal(parseReply('x\n\n**Otázky na operátora:**\n\nStav: hotovo').emptySection, '**Otázky na operátora:**');
});

test('Stop: the old heading and an empty section block once with their own reason; tasks alone under "hotovo" are blocked', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const stop = (msg, active = false) => fx.hook('stop.mjs', { stop_hook_active: active, last_assistant_message: msg });
    const legacy = 'Návrh je hotový.\n\n**Operátor:** Vydať teraz? Odporúčam áno.\n\nStav: otázka';
    const r = stop(legacy);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /old heading \*\*Operátor:\*\*: split it into \*\*Otázky na operátora:\*\*.*\*\*Úlohy pre operátora:\*\*.*omit the heading that has no item/s);
    assert.equal(stop(legacy, true).json.decision, undefined, 'blocked once per turn');
    const empty = stop('Hotové.\n\n**Úlohy pre operátora:** nič\n\nStav: hotovo');
    assert.equal(empty.json.decision, 'block');
    assert.match(empty.json.reason, /heading \*\*Úlohy pre operátora:\*\* with no item: omit a section/);
    const tasks = 'Presun je hotový.\n\n**Úlohy pre operátora:**\n- [ ] Prihlás sa na stroji B\n\nStav: hotovo';
    const t = stop(tasks);
    assert.equal(t.json.decision, 'block');
    assert.match(t.json.reason, /but declares "Stav: hotovo".*Stav: otázka/s);
  } finally { fx.cleanup(); }
});

// P-059 (operator 2026-11-11, D-0010): what the operator decided stands for further steps of the same kind.
const OLD_Q = 'Pozri si zoznam aj článok v oboch témach a na mobile a napíš, čo sedí a čo nie.';
test('repeatsAnswered: the observed repeated questions repeat the answered one, an unrelated one does not', () => {
  const answered = [{ q: OLD_Q, at: '2026-11-11T10:00:00.000Z' }];
  assert.ok(repeatsAnswered('Pozri si tri stránky na tuneli v oboch témach a na mobile a napíš pripomienky, alebo potvrď nasadenie na priklad.sk', answered));
  assert.ok(repeatsAnswered('Po pozretí náhľadu: môžem zmeny zlúčiť do main a nasadiť na priklad.sk, alebo treba ešte niečo upraviť?', answered));
  assert.equal(repeatsAnswered('Ktorý z dvoch účtov Cloudflare mám použiť?', answered), null);
  assert.equal(repeatsAnswered('Pozri si náhľad', []), null);
});

const REPEAT = 'Hotové.\n\n**Otázky na operátora:**\n- [ ] Po pozretí náhľadu: môžem zmeny zlúčiť do main a nasadiť na priklad.sk, alebo treba ešte niečo upraviť?\n\nStav: otázka';
const FIRST = 'Mockup beží.\n\n**Otázky na operátora:**\n- [ ] Pozri si zoznam aj článok v oboch témach a na mobile a napíš, čo sedí a čo nie.\n\nStav: otázka';
const OTHER = 'Hotové.\n\n**Otázky na operátora:**\n- [ ] Ktorý z dvoch účtov Cloudflare mám použiť?\n\nStav: otázka';
const stopOf = (fx, msg, active = false) => fx.hook('stop.mjs', { stop_hook_active: active, last_assistant_message: msg }).json;
const dialog = (fx) => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'x' }] } });

test('Stop: a question repeating one the operator answered blocks once; an unrelated one and a bell turn do not move it', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    dialog(fx);
    assert.equal(stopOf(fx, FIRST).decision, undefined, 'the first question is not a repeat');
    assert.equal(stateOf(fx).last_questions.length, 1);
    fx.hook('user-prompt-submit.mjs', { prompt: 'schvalujem' });
    assert.equal(stateOf(fx).answered_questions[0].q.slice(0, 20), 'Pozri si zoznam aj č');
    assert.deepEqual(stateOf(fx).last_questions, []);
    dialog(fx);
    const r = stopOf(fx, REPEAT);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /already answered a question of this kind[^]*Pozri si zoznam[^]*P-059/);
    assert.equal(stopOf(fx, REPEAT, true).decision, undefined, 'once per turn');
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    dialog(fx);
    assert.equal(stopOf(fx, OTHER).decision, undefined, 'an unrelated question');
  } finally { fx.cleanup(); }
});

test('a turn started by a mail bell does not answer the last questions', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    dialog(fx);
    stopOf(fx, FIRST);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(stateOf(fx).last_questions.length, 1);
    assert.ok(!(stateOf(fx).answered_questions || []).length);
  } finally { fx.cleanup(); }
});

test('an answered AskUserQuestion question is recorded in answered_questions; one answered in this turn is no earlier answer', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    const input = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Pozri si náhľad na tuneli a potvrď?' }] } };
    fx.hook('pre-tool-use.mjs', input);
    assert.ok(!(stateOf(fx).answered_questions || []).length, 'not answered before the dialog ends');
    fx.hook('post-tool-use.mjs', input);
    assert.equal(stateOf(fx).answered_questions[0].q, 'Pozri si náhľad na tuneli a potvrď?');
    assert.ok(stateOf(fx).dialog_answered_at >= stateOf(fx).turn_started_at, 'the answer is recorded in this turn (D-0011)');
    assert.equal(stopOf(fx, REPEAT).decision, undefined, 'answered in this very turn');
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    dialog(fx);
    assert.equal(stopOf(fx, REPEAT).decision, 'block', 'in the next turn it is an earlier answer');
  } finally { fx.cleanup(); }
});

test('a dialog repeating an answered question is refused once per turn; a dialog closed without an answer answers nothing', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    const ask = (question, answers) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question }] }, ...(answers ? { tool_response: { answers } } : {}) });
    const decision = (r) => r.json.hookSpecificOutput?.permissionDecision;
    const A = 'Môžem návrh A uložiť ako scratch/final-a.txt?';
    const B = 'Môžem návrh B uložiť ako scratch/final-b.txt?';
    fx.hook('pre-tool-use.mjs', ask(A));
    fx.hook('post-tool-use.mjs', ask(A, { [A]: '' }));
    assert.ok(!(stateOf(fx).answered_questions || []).length, 'closed without an answer');
    assert.notEqual(decision(fx.hook('pre-tool-use.mjs', ask(A))), 'deny', 'asked again after no answer');
    fx.hook('post-tool-use.mjs', ask(A, { [A]: 'áno' }));
    assert.equal(stateOf(fx).answered_questions[0].q, A);
    const r = fx.hook('pre-tool-use.mjs', ask(B));
    assert.equal(decision(r), 'deny', 'same kind, same turn');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /already answered a question of this kind[^]*návrh A[^]*P-059/);
    assert.notEqual(decision(fx.hook('pre-tool-use.mjs', ask(B))), 'deny', 'once per turn');
    assert.equal(stopOf(fx, REPEAT).decision, undefined, 'the Stop hook does not challenge the same turn again');
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.notEqual(decision(fx.hook('pre-tool-use.mjs', ask('Ktorý z dvoch účtov Cloudflare mám použiť?'))), 'deny', 'an unrelated question');
    assert.equal(decision(fx.hook('pre-tool-use.mjs', ask(B))), 'deny', 'a new turn is challenged again');
  } finally { fx.cleanup(); }
});
