// keep: guarded
// A whole save of a skill (--replace) never takes another thread's change with it (report 2026-11-20: the second thread's
// save, 18 minutes after the first, replaced the whole skill and the first thread's changes left the brain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('skill --replace over a commit of another thread is refused until --base names it; own saves and --sed pass', () => {
  const fx = setup({ thread: 'sb1', remote: false });
  try {
    const other = { env: { WORKFLOW_THREAD_ID: 'sb2' } };
    const save = (extra, opts) => fx.run('save.mjs', ['skill', 'sb-demo', '--origin', 'routine', ...extra], opts);
    const body = (x) => `Urob krok ${x}.\n\nnie ručne, lebo sa zabudne krok`;
    let r = save(['--description', 'Použi, keď skúšaš základ uloženia skillu.', '--content', body('jeden')]);
    assert.equal(r.status, 0, r.out);
    const file = path.join(fx.brain, fs.readdirSync(fx.brain, { recursive: true }).map(String).find((f) => f.endsWith(path.join('sb-demo', 'SKILL.md'))));
    // own whole saves and an own in-place edit follow each other
    assert.equal(save(['--content', body('dva'), '--replace']).status, 0);
    assert.equal(save(['--sed', 's/dva/tri/']).status, 0);
    assert.equal(save(['--content', body('štyri'), '--replace']).status, 0);
    // the other thread knows the skill up to its own save: its whole save passes, then the first thread's does not
    r = save(['--content', body('cudzí'), '--replace', '--base', 'HEAD'], other);
    assert.equal(r.status, 0, r.out);
    r = save(['--content', body('päť'), '--replace']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /would be lost[\s\S]*--base ([0-9a-f]{7})/);
    assert.match(fs.readFileSync(file, 'utf8'), /cudzí/, 'nothing saved');
    // an in-place edit works on the current body, so it passes and does not hide the other thread's commit
    assert.equal(save(['--sed', 's/cudzí/cudzí a môj/']).status, 0);
    r = save(['--content', body('päť'), '--replace']);
    assert.notEqual(r.status, 0, r.out);
    const base = /--base ([0-9a-f]{7})/.exec(r.out)[1];
    r = save(['--content', body('zlúčené'), '--replace', '--base', base]);
    assert.equal(r.status, 0, r.out);
    assert.equal(save(['--content', body('šesť'), '--replace']).status, 0, 'the merged save is the new base');
  } finally { fx.cleanup?.(); }
});
