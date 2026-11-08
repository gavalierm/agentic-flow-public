// P-003 (operator 2026-11-03): a reply that says something happened "omylom" / "by mistake" names an error; the Stop hook
// queues the workflow:error line for the next prompt (a block until 2026-11-08: the word list also hit quoted mistakes).
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

test('Stop hook: a named mistake does not block; it is queued once as a signal for the next prompt (2026-11-08)', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const msg = 'Téma vznikla omylom v brain alice.\n\nStav: hotovo';
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    const next = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context;
    assert.match(next, /mistake named in the last reply: "Téma vznikla omylom v brain alice\.".*workflow:error.*P-003/);
    assert.equal(next.match(/mistake named/g).length, 1, 'the same sentence is queued once');
    assert.doesNotMatch(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context || '', /mistake named/);
  } finally { fx.cleanup(); }
});
