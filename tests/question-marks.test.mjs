// D-0039: a question to the operator reads without the thread: no internal marks the operator did not use, what each option
// does, one recommended option with its reason; refused once per turn, a repeat passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { dialogMarks, dialogGaps } from '../hooks/pre-tool-use.mjs';

const MARKS = /without the thread[^]*D-0039/;
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const decisionOf = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const QUESTION = 'Oprava kontroly otázok je hotová v kópii kódu a testy prešli; rozhodujem, či ju teraz zlúčiť do vývojovej vetvy.';
const GOOD = { questions: [{ question: QUESTION, options: [
  { label: 'Zlúčiť teraz (odporúčané)', description: 'Oprava pôjde do najbližšieho vydania, lebo testy prešli a nič na ňu nečaká.' },
  { label: 'Počkať', description: 'Oprava ostane v kópii, kým neskončí iná práca na hookoch.' },
] }] };
const MARKED = { questions: [{ question: `${QUESTION} Commit 4805a2d podľa D-0039, téma alpha-topic.`, options: [
  { label: 'Zlúčiť s --force (Recommended)', description: 'Prepíše hooks/pre-tool-use.mjs, lebo testy prešli.' },
  { label: 'Počkať', description: 'Nič nezmení.' },
], }] };

test('dialogMarks and dialogGaps: the marks and the missing structure, a mark of the operator and a URL pass (D-0039)', () => {
  const kinds = dialogMarks(MARKED, '', ['alpha-topic']).map((m) => `${m.kind}:${m.mark}`);
  assert.deepEqual(kinds.sort(), ['command flag:--force', 'commit hash:4805a2d', 'decision or rule ID:D-0039', 'file path:hooks/pre-tool-use.mjs', 'topic ID:alpha-topic']);
  assert.deepEqual(dialogMarks(MARKED, 'urob D-0039 s --force v 4805a2d, hooks/pre-tool-use.mjs a alpha-topic', ['alpha-topic']), []);
  assert.deepEqual(dialogMarks({ questions: [{ question: 'Pošta 20261113T172429929Z-0000cad0, súbor ../x a ~/y. Odkaz https://example.com/a/b.html, áno/nie, verzia 0.9.95.' }] }).map((m) => m.mark),
    ['20261113T172429929Z-0000cad0', '../x', '~/y']);
  assert.deepEqual(dialogMarks({ questions: [{ question: QUESTION, options: [{ label: 'A', preview: 'commit 4805a2d, --force' }] }] }), [], 'previews are not checked');
  assert.deepEqual(dialogGaps(GOOD), []);
  assert.equal(dialogGaps({ questions: [{ question: 'Zlúčiť?', options: [{ label: 'Áno (Recommended)', description: 'Zlúči.' }, { label: 'Nie' }] }] }).length, 3, 'short question, no description, no reason');
  assert.match(dialogGaps({ questions: [{ question: QUESTION, options: [{ label: 'Áno (Recommended)', description: 'Zlúči, lebo testy prešli.' }, { label: 'Nie (odporúčané)', description: 'Nezlúči, lebo čaká.' }] }] }).join(), /2 options are marked recommended/);
});

test('AskUserQuestion: internal marks and a dialog without structure are refused once per turn; a mark from the operator prompt and a good dialog pass (D-0039)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha-topic', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    const ask = (tool_input) => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input });
    const prompt = (p) => fx.hook('user-prompt-submit.mjs', { prompt: p });

    prompt('priprav zlúčenie');
    const first = ask(MARKED);
    assert.equal(decisionOf(first), 'deny');
    assert.match(reasonOf(first), MARKS);
    for (const m of ['4805a2d (commit hash)', 'D-0039 (decision or rule ID)', '--force (command flag)', 'hooks/pre-tool-use.mjs (file path)', 'alpha-topic (topic ID)']) assert.ok(reasonOf(first).includes(m), m);
    assert.doesNotMatch(reasonOf(ask(MARKED)), MARKS, 'once per turn: the repeat passes');

    prompt('zlúč commit 4805a2d podľa D-0039 s --force do hooks/pre-tool-use.mjs, téma alpha-topic');
    assert.doesNotMatch(reasonOf(ask(MARKED)), MARKS, 'the marks the operator wrote in this prompt pass');
    prompt('a teraz?');
    assert.doesNotMatch(reasonOf(ask(MARKED)), MARKS, 'the marks of the last prompt pass too');
    prompt('niečo iné');
    prompt('ešte iné');
    assert.match(reasonOf(ask(MARKED)), MARKS, 'an older prompt does not count');

    prompt('pokračuj');
    const bare = ask({ questions: [{ question: QUESTION, options: [{ label: 'Zlúčiť (odporúčané)', description: 'Zlúči, lebo testy prešli.' }, { label: 'Počkať' }] }] });
    assert.equal(decisionOf(bare), 'deny');
    assert.match(reasonOf(bare), /"Počkať" without a description/);
    prompt('pokračuj');
    const norec = ask({ questions: [{ question: QUESTION, options: [{ label: 'Zlúčiť', description: 'Zlúči.' }, { label: 'Počkať', description: 'Počká.' }] }] });
    assert.equal(decisionOf(norec), 'deny');
    assert.match(reasonOf(norec), /0 options are marked recommended/);

    prompt('pokračuj');
    const good = ask(GOOD);
    assert.doesNotMatch(reasonOf(good), MARKS);
    assert.notEqual(decisionOf(good), 'deny');
  } finally { fx.cleanup(); }
});
