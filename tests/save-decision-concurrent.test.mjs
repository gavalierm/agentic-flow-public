// Two threads saving a decision at once both got D-0033: save.mjs took the next ID before the brain lock, so the second
// writer used an ID the first had just committed (report-392ea415, 2026-11-13). The ID is now assigned under the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { brainLockPath } from '../scripts/brain.mjs';

test('decision: a decision committed while save.mjs waits for the brain lock is not given the same ID', async () => {
  const fx = setup();
  try {
    const lock = brainLockPath(fx.brain);
    fs.mkdirSync(lock);
    const pending = fx.runAsync('save.mjs', ['decision', 'Library B', '--what', 'B', '--reason', 'x', '--relates-to', 'src/app.js']);
    // The other writer holds the lock and commits D-0001 meanwhile.
    await new Promise((r) => setTimeout(r, 2500));
    fs.mkdirSync(path.join(fx.brain, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'decisions', 'd-0001-library-a.md'),
      '---\nkey: D-0001\nid: D-0001\ntitle: Library A\nstatus: valid\nrelates_to:\n  - src/app.js\ncreated: 2026-11-13\n---\n**Rozhodnuté:** A\n\n**Zamietnuté alternatívy:** -\n\n**Dôvod:** x\n');
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', '[brain-script] save decision D-0001 library-a');
    fs.rmSync(lock, { recursive: true, force: true });
    const r = await pending;
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /decision D-0002/, r.out);
    assert.ok(fx.exists('decisions/d-0002-library-b.md'), 'the waiting writer took the next free ID');
    assert.ok(!fx.exists('decisions/d-0001-library-b.md'), 'no second D-0001');
  } finally { fx.cleanup(); }
});
