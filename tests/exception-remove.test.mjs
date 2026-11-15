// ttl: 2026-12-15
// flow-1-8-1 (2026-11-15): an exception could be written (save.mjs exception P-XXX --wording) but not removed. `--remove
// --reason` takes its section out of the file of its layer in one commit through brainWrite and removes a file left empty;
// an exception the layer does not have fails with the layer and the file; a bell turn is refused as for a write (P-047).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('save.mjs exception --remove takes the section out in one commit, removes an empty file, refuses a missing one', () => {
  const fx = setup();
  try {
    const head = () => fx.git(fx.brain, 'rev-parse', 'HEAD');
    const subjects = (from) => fx.git(fx.brain, 'log', '--format=%s', `${from}..HEAD`).split('\n').filter(Boolean);
    for (const [id, wording] of [['P-010', 'Index pamäte smie mať 30 riadkov.'], ['P-021', 'Stavový riadok bez pošty.']]) {
      const w = fx.run('save.mjs', ['exception', id, '--wording', wording, '--reason', 'malý projekt']);
      assert.equal(w.status, 0, w.out);
    }
    assert.match(fx.read('exceptions/project.md'), /### P-010[\s\S]*### P-021/);

    // A reason is required.
    const bare = fx.run('save.mjs', ['exception', 'P-010', '--remove']);
    assert.notEqual(bare.status, 0, bare.out);
    assert.match(bare.stderr, /--remove needs --reason/);

    let before = head();
    const one = fx.run('save.mjs', ['exception', 'P-010', '--remove', '--reason', 'projekt narástol']);
    assert.equal(one.status, 0, one.out);
    assert.deepEqual(subjects(before), ['[brain-script] remove exception P-010 (project): projekt narástol']);
    const left = fx.read('exceptions/project.md');
    assert.doesNotMatch(left, /P-010|30 riadkov/);
    assert.match(left, /^### P-021\nZnenie: Stavový riadok bez pošty\.\nDôvod: malý projekt\n$/);

    // The last exception of the file: the file goes.
    before = head();
    const last = fx.run('save.mjs', ['exception', 'P-021', '--remove', '--reason', 'už netreba']);
    assert.equal(last.status, 0, last.out);
    assert.deepEqual(subjects(before), ['[brain-script] remove exception P-021 (project): už netreba']);
    assert.equal(fx.exists('exceptions/project.md'), false, 'empty file removed');
    assert.equal(fx.git(fx.brain, 'ls-files', 'exceptions/project.md'), '');

    // An exception the layer does not have: an error with the layer and its file, no commit.
    before = head();
    const missing = fx.run('save.mjs', ['exception', 'P-021', '--remove', '--reason', 'znova']);
    assert.notEqual(missing.status, 0, missing.out);
    assert.match(missing.stderr, /exception P-021 is not in layer project \(exceptions\/project\.md\)/);
    const machine = fx.run('save.mjs', ['exception', 'P-010', '--remove', '--reason', 'x', '--layer', 'machine', '--machine', 'box']);
    assert.notEqual(machine.status, 0, machine.out);
    assert.match(machine.stderr, /exception P-010 is not in layer machine \(exceptions\/machine-box\.md\)/);
    assert.equal(head(), before, 'nothing committed');

    // A bell turn cannot remove one (P-047), as it cannot write one.
    assert.equal(fx.run('save.mjs', ['exception', 'P-010', '--wording', 'w', '--reason', 'r']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'You have mail in topic alpha' });
    const bell = fx.run('save.mjs', ['exception', 'P-010', '--remove', '--reason', 'zo zvončeka']);
    assert.notEqual(bell.status, 0, bell.out);
    assert.match(bell.out, /P-047/);
    assert.match(fx.read('exceptions/project.md'), /### P-010/, 'exception kept');
  } finally { fx.cleanup(); }
});
