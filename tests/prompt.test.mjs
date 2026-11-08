// P-023 e, P-038, P-047, P-003, P-013: UserPromptSubmit hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('status line is exactly one line with the fixed template', () => {
  const fx = setup();
  try {
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj, pokračujeme' });
    assert.equal(r.status, 0);
    assert.equal(r.context.split('\n').length, 1);
    assert.equal(r.context, 'thread a1 | topic - (none) | mail: 0');
    fx.run('topic.mjs', ['create', 'fix-workflow', '--subject', 'Fix']);
    assert.equal(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context, 'thread a1 | topic fix-workflow (working, mode operator) | mail: 0');
  } finally { fx.cleanup(); }
});

test('wake template sets the wake flag in the thread state; an operator prompt resets it', () => {
  const fx = setup();
  try {
    const state = path.join(fx.brain, 'local', 'threads', 'a1.json');
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'You have mail in topic fix-workflow' });
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).turn_source, 'wake');
    assert.equal(r.context.split('\n').length, 2);
    assert.equal(r.context.split('\n')[1], 'wake: no new mail; end the turn with only your state line (P-061)', 'no new mail: no mail line');
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).turn_source, 'operator');
  } finally { fx.cleanup(); }
});

test('error and save phrases add one hint line referencing the skill, never content', () => {
  const fx = setup();
  try {
    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'To nefunguje, skript padá.' });
    assert.equal(r.context.split('\n').length, 2);
    assert.match(r.context.split('\n')[1], /workflow:error/);
    // Unchanged status line is not repeated (P-023 e): the hint is the only line.
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'Volám sa Anna.' });
    assert.match(r.context, /^[^\n]*workflow:save[^\n]*$/);
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'Zapamätaj si, že X.' });
    assert.match(r.context, /^[^\n]*workflow:save[^\n]*$/);
  } finally { fx.cleanup(); }
});

test('rules changed during the session are injected once, in full; unchanged rules are not repeated (P-021)', () => {
  const fx = setup();
  try {
    fx.hook('session-start.mjs', { source: 'startup' });
    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj' });
    assert.doesNotMatch(r.context, /Platné pravidlá od tohto ťahu/);
    fs.mkdirSync(path.join(fx.brain, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'rules', 'x.md'), '---\nkey: rule-x\ntitle: x\n---\nNové pravidlo projektu X.\n');
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(r.context, /Platné pravidlá od tohto ťahu/);
    assert.match(r.context, /Nové pravidlo projektu X\./);
    assert.doesNotMatch(r.context, /verzi|v[0-9]+\./i, 'no version talk');
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'ešte' });
    assert.doesNotMatch(r.context, /Platné pravidlá od tohto ťahu/, 'only once');
  } finally { fx.cleanup(); }
});
