// P-003 (operator 2026-11-03): a reply that says something happened "omylom" / "by mistake" names an error; the Stop hook
// blocks once, also in a bell turn, with the workflow:error reason; the second stop passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { mistakeClaim } from '../hooks/stop.mjs';

test('mistakeClaim: admitted mistakes are found with their sentence; other words pass', () => {
  // alice 2026-11-03: the pilot test topic was created in the wrong brain and the reply only said so.
  const alice = 'Hotové. Pri teste v pilote vznikla **omylom** téma tt-free v brain alice. Súhlasíš?';
  assert.equal(mistakeClaim(alice), 'Pri teste v pilote vznikla omylom téma tt-free v brain alice.');
  for (const t of ['Omylom som zmazal súbor.', 'Soubor jsem smazal omylem.', 'I accidentally pushed to main.', 'It was deleted by mistake.', 'nedopatrením prepísané', 'Nechtiac som to spustil.', 'Nedávno som omylom zmazal súbor.', 'Skill sa spustil omylom, nie zámerne.'])
    assert.ok(mistakeClaim(t), t);
  for (const t of ['Hotové, vydané.', 'Omylový stav nenastal.', 'Hook na „omylom“: keď odpoveď obsahuje „omylom“ alebo "by mistake", zablokuje ju.', 'Slovo `accidentally` je v zozname.', 'mistake handling is in P-003', '', undefined, 'neomylný', 'Over, či je spúšťač jasný a nespúšťa sa omylom.', 'Guard so that nothing is accidentally installed.', 'aby sa omylom nespustil', 'This prevents accidentally pushing to main.'])
    assert.equal(mistakeClaim(t), null, String(t));
});

test('Stop hook: a mistake blocks once with the P-003 reason, also in a bell turn; the second stop passes', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const msg = 'Téma vznikla omylom v brain alice.';
    const first = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json;
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /by mistake: "Téma vznikla omylom v brain alice\.".*P-003.*workflow:error/);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: msg }).json.decision, undefined);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    const bell = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json;
    assert.equal(bell.decision, 'block');
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.' }).json.decision, undefined);
  } finally { fx.cleanup(); }
});
