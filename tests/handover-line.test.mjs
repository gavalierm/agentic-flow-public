// P-061, D-0040: the section before the state line, `**Handover:**` with one numbered line `<téma> → <ďalší krok>` per held
// topic or `**Handover:** žiadny`, tells the operator what continues after /clear or in a new session (the operator could
// not tell). The Stop hook blocks a reply without it, with one that names no held topic, with a topic the thread does not
// hold, or with the old single line `Handover: <téma> – <krok>`; once per turn like every other state check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { parseReply, handoverMatches, HANDOVER_LINE, HANDOVER_NONE_LINE } from '../scripts/protocol.mjs';
import { HANDOVER_REASON } from '../hooks/stop.mjs';

const stop = (fx, msg, active = false) => fx.hook('stop.mjs', { stop_hook_active: active, last_assistant_message: msg, rawHandover: true }).json;

test('parseReply: the handover section is the numbered lines under **Handover:** right before the state line; null when missing', () => {
  const one = parseReply('Hotové.\n\n**Handover:**\n1. alpha → vydať v1\n2. beta -> overiť\n\n**Stav:** hotovo').handover;
  assert.deepEqual(one.items, [{ topic: 'alpha', next: 'vydať v1' }, { topic: 'beta', next: 'overiť' }]);
  assert.equal(one.none, false);
  assert.equal(one.old, false);
  assert.equal(parseReply('Hotové.\n\n**Handover:** žiadny\n\n**Stav:** hotovo').handover.none, true);
  assert.equal(parseReply('Hotové.\n\n**Stav:** hotovo').handover, null);
  assert.equal(parseReply('**Handover:** žiadny\nA ešte text.\n**Stav:** hotovo').handover, null, 'it must come right before the state line');
  assert.equal(parseReply('**Handover:** žiadny').handover, null, 'no state line, no handover');
  assert.ok(HANDOVER_LINE.startsWith('**Handover:**'));
  assert.equal(HANDOVER_NONE_LINE, '**Handover:** žiadny');
});

test('parseReply: the old form (the line "Handover: <téma> – <krok>", unnumbered lines, a plain state line) is marked', () => {
  const old = parseReply('Hotové.\n\nHandover: alpha – vydať v1\nStav: hotovo');
  assert.equal(old.handover.old, true);
  assert.deepEqual(old.oldForm, ['state', 'handover']);
  assert.deepEqual(parseReply('Hotové.\n\n**Handover:** alpha → vydať\n\n**Stav:** hotovo').oldForm, ['handover'], 'a topic after the heading is no section');
  assert.deepEqual(parseReply('Hotové.\n\n**Handover:**\n- alpha → vydať\n\n**Stav:** hotovo').oldForm, ['handover-items']);
  assert.deepEqual(parseReply('Hotové.\n\n**Handover:**\n1. alpha → vydať\n\n**Stav:** hotovo').oldForm, []);
  // Items for the operator are numbered: a checklist, a dash or a text after the heading is the old form.
  const numbered = parseReply('x\n\n**Otázky na operátora:**\n1. A alebo B? Odporúčam A.\n2. Vydať?\n\n**Úlohy pre operátora:**\n1. Prihlás sa.\n\n**Handover:** žiadny\n\n**Stav:** otázka');
  assert.deepEqual(numbered.questions, ['A alebo B? Odporúčam A.', 'Vydať?']);
  assert.deepEqual(numbered.tasks, ['Prihlás sa.']);
  assert.equal(numbered.question, 'A alebo B?');
  assert.deepEqual(numbered.oldForm, []);
  assert.deepEqual(parseReply('x\n\n**Otázky na operátora:**\n- [ ] A?\n\n**Handover:** žiadny\n\n**Stav:** otázka').oldForm, ['items']);
  assert.deepEqual(parseReply('x\n\n**Úlohy pre operátora:** Prihlás sa.\n\n**Handover:** žiadny\n\n**Stav:** otázka').oldForm, ['items']);
});

test('handoverMatches: every held topic has a line "<topic> → <step>"; without a held topic only žiadny passes', () => {
  const h = (s) => parseReply(`x\n\n${s}\n\n**Stav:** hotovo`).handover;
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha → vydať'), ['alpha']), true);
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha-2 → vydať'), ['alpha']), false, 'alpha is not alpha-2');
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha → vydať'), ['alpha', 'beta']), false);
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha → vydať\n2. beta → overiť'), ['alpha', 'beta']), true);
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha vydať'), ['alpha']), false, 'a line without the arrow');
  assert.equal(handoverMatches(h('**Handover:** žiadny'), []), true);
  assert.equal(handoverMatches(h('**Handover:**\n1. alpha → vydať'), []), false);
  assert.equal(handoverMatches(h('**Handover:** žiadny'), ['alpha']), false);
  assert.equal(handoverMatches(h('Handover: alpha – vydať'), ['alpha']), false, 'the old line');
  assert.equal(handoverMatches(null, []), false);
});

test('Stop: a reply without the Handover section blocks once with the fact; the right section without a held topic and a wrong topic', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    // No topic held: the section is missing -> block, and the reason says the thread holds none.
    const missing = stop(fx, 'Hotové.\n\n**Stav:** hotovo');
    assert.equal(missing.decision, 'block');
    assert.match(missing.reason, /no \*\*Handover:\*\* section/);
    assert.match(missing.reason, /this thread holds no topic.*\*\*Handover:\*\* žiadny/);
    assert.equal(stop(fx, 'Hotové.\n\n**Stav:** hotovo', true).decision, undefined, 'blocks once, no loop');
    assert.equal(stop(fx, 'Hotové.\n\n**Handover:** žiadny\n\n**Stav:** hotovo').decision, undefined);
    // A topic named while none is held is wrong.
    const wrongNone = stop(fx, 'Hotové.\n\n**Handover:**\n1. alpha → vydať\n\n**Stav:** hotovo');
    assert.equal(wrongNone.decision, 'block');
    assert.match(wrongNone.reason, /wrong \*\*Handover:\*\* section \("Handover:", lines: alpha → …\)/);
    // Holding alpha: "žiadny" and a wrong topic block with the held topic and its saved step; the right section passes.
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const none = stop(fx, 'Hotové.\n\n**Handover:** žiadny\n\n**Stav:** hotovo');
    assert.equal(none.decision, 'block');
    assert.match(none.reason, /a line for every topic this thread holds: alpha \(saved next step: none\)/);
    const wrong = stop(fx, 'Hotové.\n\n**Handover:**\n1. beta → vydať\n\n**Stav:** hotovo');
    assert.equal(wrong.decision, 'block');
    assert.match(wrong.reason, /alpha/);
    assert.equal(stop(fx, 'Hotové.\n\n**Handover:**\n1. alpha → nič neostáva, uzavrieť tému\n\n**Stav:** hotovo').decision, undefined);
    assert.equal(stop(fx, 'Hotové.\n\n**Handover:**\n1. `alpha` → nič neostáva\n**Stav:** hotovo').decision, undefined, 'markdown around the topic is tolerated');
  } finally { fx.cleanup(); }
});

test('Stop: the old form blocks once with a message that names each old part and shows the new form (D-0040)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const old = stop(fx, 'Hotové.\n\nHandover: alpha – vydať v1\nStav: hotovo');
    assert.equal(old.decision, 'block');
    assert.match(old.reason, /old form of the protocol/);
    assert.match(old.reason, /the state line is bold: "\*\*Stav:\*\* hotovo\|otázka\|čakám/);
    assert.match(old.reason, /not the line "Handover: <topic> – <step>".*"1\. <topic> → <next step>"/);
    assert.match(old.reason, /\*\*Handover:\*\*\\n1\. <téma> → <ďalší krok>\\n\\n\*\*Stav:\*\* otázka/, 'the example of the new form');
    assert.equal(stop(fx, 'Hotové.\n\nHandover: alpha – vydať v1\nStav: hotovo', true).decision, undefined, 'blocks once, no loop');
    // A bold state line with the old handover line: only that part is named.
    const line = stop(fx, 'Hotové.\n\nHandover: alpha – vydať v1\n\n**Stav:** hotovo');
    assert.match(line.reason, /old form of the protocol: the handover is its own section/);
    assert.doesNotMatch(line.reason, /the state line is bold/);
    // A checklist for the operator is named as such.
    const list = stop(fx, 'Návrh.\n\n**Otázky na operátora:**\n- [ ] A alebo B?\n\n**Handover:**\n1. alpha → rozhodnutie\n\n**Stav:** otázka');
    assert.match(list.reason, /old form of the protocol: the items under \*\*Otázky na operátora:\*\*.*are a numbered list/);
    // The new form passes.
    assert.equal(stop(fx, 'Hotové.\n\n**Handover:**\n1. alpha → vydať v1\n\n**Stav:** hotovo').decision, undefined);
  } finally { fx.cleanup(); }
});

test('HANDOVER_REASON: names the held topics with their saved next step', () => {
  const r = HANDOVER_REASON([{ id: 'alpha', next: 'vydať v1' }, { id: 'beta', next: '' }], null);
  assert.match(r, /alpha \(saved next step: "vydať v1"\); beta \(saved next step: none\)/);
});
