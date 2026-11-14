// P-003: the error hint only for an operator's report, not for a quoted phrase or a conditional (pilot nudge-why 2026-11-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('a quoted phrase, a conditional or a word inside another word is not an error report; a plain report is', () => {
  const fx = setup();
  try {
    const hint = (prompt) => /workflow:error/.test(fx.hook('user-prompt-submit.mjs', { prompt }).context);
    assert.equal(hint('Zúž to na skutočné hlásenie (napr. "to je chyba", "nefunguje"), nie na každý výskyt.'), false);
    assert.equal(hint('Frázu „to je chyba“ ber ako hlásenie.'), false);
    assert.equal(hint('Ak je to chyba hooku, oprav ho.'), false);
    assert.equal(hint('Check whether this is a bug in the hook.'), false);
    assert.equal(hint('The unbroken chain of commits stays as it is.'), false);
    assert.equal(hint('To nefunguje, skript padá.'), true);
    assert.equal(hint('To je chyba, časovač nezazvonil.'), true);
    assert.equal(hint('Zle si to spravil.'), true);
  } finally { fx.cleanup(); }
});
