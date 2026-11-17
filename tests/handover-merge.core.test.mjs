// keep: core
// P-018 (report 20261117T195322961Z): `save.mjs handover <topic> --questions "a; b"` without the other options wrote '-'
// into Zadanie, Hotové, Ďalší krok and Súbory (11.6 kB -> 413 B). An option not given keeps its section; an option given
// empty empties it; --file still writes the whole handover. --done adds to Hotové (the topic's history), it does not replace it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { sectionItems } from '../scripts/brain-checks.mjs';

test('save handover with one option keeps the other sections; an empty option empties its section', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'h1', '--subject', 'H', '--class', 'ops']).status, 0);
    let r = fx.run('save.mjs', ['handover', 'h1', '--task', 'Úloha A', '--done', 'krok 1; krok 2', '--next', 'krok 3', '--files', 'a.md']);
    assert.equal(r.status, 0, r.out);
    const file = () => fs.readFileSync(fs.readdirSync(path.join(fx.brain), { recursive: true }).map((f) => path.join(fx.brain, f)).find((f) => /h1[\\/]handover\.md$/.test(f)), 'utf8');
    r = fx.run('save.mjs', ['handover', 'h1', '--questions', 'otázka x; otázka y']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /kept from the current handover: Zadanie, Hotové, Ďalší krok, Súbory/);
    const text = file();
    assert.match(text, /## Zadanie\nÚloha A\n/);
    assert.deepEqual(sectionItems(text, '## Hotové'), ['krok 1', 'krok 2']);
    assert.deepEqual(sectionItems(text, '## Ďalší krok'), ['krok 3']);
    assert.deepEqual(sectionItems(text, '## Otvorené otázky'), ['otázka x', 'otázka y']);
    r = fx.run('save.mjs', ['handover', 'h1', '--next', '']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(sectionItems(file(), '## Ďalší krok'), [], 'an empty option empties its section');
    assert.deepEqual(sectionItems(file(), '## Hotové'), ['krok 1', 'krok 2']);
    // Hotové is history: --done adds after the current items, an item already there once (thread parametre-produktov).
    r = fx.run('save.mjs', ['handover', 'h1', '--done', 'krok 2; krok 4']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Hotové: 1 item\(s\) added/);
    assert.deepEqual(sectionItems(file(), '## Hotové'), ['krok 1', 'krok 2', 'krok 4']);
    r = fx.run('save.mjs', ['handover', 'h1', '--done-replace', 'krok 1 opravený; krok 4']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(sectionItems(file(), '## Hotové'), ['krok 1 opravený', 'krok 4'], '--done-replace rewrites Hotové');
    r = fx.run('save.mjs', ['handover', 'h1', '--done', '']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(sectionItems(file(), '## Hotové'), [], '--done "" empties Hotové');
  } finally { fx.cleanup(); }
});
