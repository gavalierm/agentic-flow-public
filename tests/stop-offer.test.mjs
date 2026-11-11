// flow-public#25 (2026-11-10): the operator asked how to hand a task to another agent; the Stop hook said "do the work now"
// and "if you can do it yourself, do it", and the agent created and deployed a skill nobody asked for. Every message that
// pushes to act is bound to the asked work; a change the operator did not ask for stays an offer under Operátor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { AUTO_TIMER_THEN } from '../hooks/stop.mjs';

const OFFER = /did not ask for[^]*operátora[^]*Stav: otázka/;

test('Stop after an operator question: a proposed change is kept as an offer, never pushed to be done', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'Ako odovzdám zadanie ďalšiemu agentovi? Prompt alebo skript?' });
    const item = 'Najjednoduchšie poštou (assist).\n\n**Otázky na operátora:**\n- [ ] Vytvoriť skill na odovzdanie zadania (odporúčam)\n\nStav: hotovo';
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: item });
    assert.equal(r.json.decision, 'block');
    assert.doesNotMatch(r.json.reason, /if you can do it yourself, do it/, 'no unconditional push to do the item');
    assert.match(r.json.reason, OFFER);
    const prose = 'Najjednoduchšie poštou (assist).\n\nĎalší krok: vytvorím skill na odovzdanie zadania.\n\nStav: hotovo';
    const p = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: prose });
    assert.doesNotMatch(p.json.reason, /a step of yours is done now|do the work now/);
    assert.match(p.json.reason, OFFER);
    const none = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Poštou (assist).' });
    assert.match(none.json.reason, OFFER, 'the state help binds "do it now" to the asked work');
  } finally { fx.cleanup(); }
});

test('the auto timer chooses a recommended option only inside the asked work', () => {
  assert.match(AUTO_TIMER_THEN, /offered change the operator did not ask for: that waits/);
});
