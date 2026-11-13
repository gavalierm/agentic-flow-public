// P-061: the line before the state line, `Handover: <téma> – <ďalší krok>` or `Handover: žiadny`, tells the operator what
// continues after /clear or in a new session (the operator could not tell). The Stop hook blocks a reply without it,
// with one that names no held topic, or with a topic the thread does not hold; once per turn like every other state check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { parseReply, handoverMatches, HANDOVER_LINE } from '../scripts/protocol.mjs';
import { HANDOVER_REASON } from '../hooks/stop.mjs';

const stop = (fx, msg, active = false) => fx.hook('stop.mjs', { stop_hook_active: active, last_assistant_message: msg, rawHandover: true }).json;

test('parseReply: handover is the last non-empty line before the state line, markdown stripped; null when missing', () => {
  assert.equal(parseReply('Hotové.\n\nHandover: žiadny (po /clear nič nepokračuje)\nStav: hotovo').handover, 'Handover: žiadny (po /clear nič nepokračuje)');
  assert.equal(parseReply('Hotové.\n\n**Handover:** alpha – vydať v1\n\nStav: hotovo').handover, 'Handover: alpha – vydať v1');
  assert.equal(parseReply('Hotové.\n\nStav: hotovo').handover, null);
  assert.equal(parseReply('Handover: žiadny\nA ešte text.\nStav: hotovo').handover, null, 'it must be the line right before the state line');
  assert.equal(parseReply('Handover: alpha – krok').handover, null, 'no state line, no handover');
  assert.ok(HANDOVER_LINE.startsWith('Handover:'));
});

test('handoverMatches: every held topic is named as a whole word; without a held topic only žiadny or - passes', () => {
  assert.equal(handoverMatches('Handover: alpha – vydať', ['alpha']), true);
  assert.equal(handoverMatches('Handover: alpha-2 – vydať', ['alpha']), false, 'alpha is not alpha-2');
  assert.equal(handoverMatches('Handover: alpha – vydať', ['alpha', 'beta']), false);
  assert.equal(handoverMatches('Handover: žiadny (po /clear nič nepokračuje)', []), true);
  assert.equal(handoverMatches('Handover: -', []), true);
  assert.equal(handoverMatches('Handover: alpha – vydať', []), false);
  assert.equal(handoverMatches('Handover: žiadny', ['alpha']), false);
  assert.equal(handoverMatches(null, []), false);
});

test('Stop: a reply without the Handover line blocks once with the fact; the right line without a held topic and a wrong topic', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    // No topic held: the line is missing -> block, and the reason says the thread holds none.
    const missing = stop(fx, 'Hotové.\n\nStav: hotovo');
    assert.equal(missing.decision, 'block');
    assert.match(missing.reason, /no Handover line/);
    assert.match(missing.reason, /this thread holds no topic.*Handover: žiadny/);
    assert.equal(stop(fx, 'Hotové.\n\nStav: hotovo', true).decision, undefined, 'blocks once, no loop');
    // The right line without a held topic passes; so does "-".
    assert.equal(stop(fx, 'Hotové.\n\nHandover: žiadny (po /clear nič nepokračuje)\nStav: hotovo').decision, undefined);
    assert.equal(stop(fx, 'Hotové.\n\nHandover: -\nStav: hotovo').decision, undefined);
    // A topic named while none is held is wrong.
    const wrongNone = stop(fx, 'Hotové.\n\nHandover: alpha – vydať\nStav: hotovo');
    assert.equal(wrongNone.decision, 'block');
    assert.match(wrongNone.reason, /wrong Handover line \("Handover: alpha – vydať"\)/);
    // Holding alpha: "žiadny" and a wrong topic block with the held topic and its saved step; the right line passes.
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const none = stop(fx, 'Hotové.\n\nHandover: žiadny\nStav: hotovo');
    assert.equal(none.decision, 'block');
    assert.match(none.reason, /name every topic this thread holds: alpha \(saved next step: none\)/);
    const wrong = stop(fx, 'Hotové.\n\nHandover: beta – vydať\nStav: hotovo');
    assert.equal(wrong.decision, 'block');
    assert.match(wrong.reason, /alpha/);
    assert.equal(stop(fx, 'Hotové.\n\nHandover: alpha – nič neostáva, uzavrieť tému\nStav: hotovo').decision, undefined);
    assert.equal(stop(fx, 'Hotové.\n\n**Handover:** alpha – nič neostáva\n\nStav: hotovo').decision, undefined, 'markdown is tolerated');
  } finally { fx.cleanup(); }
});

test('HANDOVER_REASON: names the held topics with their saved next step', () => {
  const r = HANDOVER_REASON([{ id: 'alpha', next: 'vydať v1' }, { id: 'beta', next: '' }], null);
  assert.match(r, /alpha \(saved next step: "vydať v1"\); beta \(saved next step: none\)/);
});
