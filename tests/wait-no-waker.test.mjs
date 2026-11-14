// P-061: "Stav: čakám" without an armed waker does not pass (pilot nudge-why 2026-11-14); with a waker it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { setTimer } from '../scripts/waker.mjs';

test('Stop blocks "čakám" without a waker once, names the waker kinds, and passes once a timer is armed', () => {
  const fx = setup();
  const file = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const msg = 'Poslal som otázku.\n\n**Handover:** žiadny\n\n**Stav:** čakám (na odpoveď Carol)';
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg });
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /no waker is armed: arm one for that event \(.*timer\.mjs/);
    // Ending so anyway: the thread is not left idle, code arms its timer with the wait target.
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: msg }).json.decision, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).timer.auto, true);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    setTimer(fx.brain, fx.thread, { delayMs: 30 * 60_000, then: 'check the reply' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
  } finally { fx.cleanup(); }
});
