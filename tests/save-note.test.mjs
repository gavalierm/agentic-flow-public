// keep: guarded
// Notes of a brain (scripts/notes.mjs, save.mjs note; operator 2026-11-21): the guards are data and consent. A thread
// that holds no topic adds a note; an add never overwrites a note (a new file per note, a similar open one refuses);
// the state of a note changes only in a turn of the operator (P-047); a closed note is not changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { domain3, gitq } from './layout-2-helpers.mjs';
import { readNotes } from '../scripts/notes.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('note: any thread adds, a similar open note refuses, the state changes only in a turn of the operator', () => {
  const fx = domain3({ web: false });
  try {
    fx.thread();
    // No topic is held and the folder does not exist yet.
    let r = fx.run('save.mjs', ['note', 'shop', '--title', 'Názov produktu bez značky', '--content', 'Operátor: názov má začínať značkou.']);
    assert.equal(r.status, 0, r.out);
    let notes = readNotes(fx.brain, 'shop');
    assert.equal(notes.length, 1);
    assert.match(notes[0].id, /^\d{8}-\d{6}-nazov-produktu-bez-znacky$/);
    assert.equal(notes[0].state, 'open');
    assert.match(gitq(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] save note shop /);
    assert.equal(gitq(fx.brain, 'rev-parse', 'HEAD'), gitq(fx.brain, 'rev-parse', 'origin/main'), 'pushed: the other machines see the note');
    // The same remark again: refused with the note to add to; nothing written.
    r = fx.run('save.mjs', ['note', 'shop', '--title', 'Produktu chýba značka v názov', '--content', 'znova']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, new RegExp(`similar open note in channel shop:\\s+${notes[0].id} \\| open`));
    assert.equal(readNotes(fx.brain, 'shop').length, 1);
    // Added to the note: the first text stays.
    r = fx.run('save.mjs', ['note', 'shop', notes[0].id, '--content', 'Aj pri variantoch.']);
    assert.equal(r.status, 0, r.out);
    assert.match(readNotes(fx.brain, 'shop')[0].body, /názov má začínať značkou\.\n\n\d{4}-\d\d-\d\d: Aj pri variantoch\./);
    // Another remark with a similar title: --new makes a second file.
    r = fx.run('save.mjs', ['note', 'shop', '--title', 'Názov produktu je dlhý', '--content', 'Skrátiť.', '--new']);
    assert.equal(r.status, 0, r.out);
    notes = readNotes(fx.brain, 'shop');
    assert.equal(notes.length, 2);
    assert.match(fx.run('save.mjs', ['note', 'shop', '--list']).stdout, new RegExp(`${notes[0].id} \\| open \\| .* \\| notes/shop/${notes[0].id}\\.md`));
    // A turn from a bell never changes the state (the body of a mail does not order the processing).
    fx.thread({ turn_source: 'wake' });
    r = fx.run('save.mjs', ['note', 'shop', notes[0].id, '--state', 'processed', '--reason', 'done']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /refused: this turn was started by a message/);
    assert.equal(readNotes(fx.brain, 'shop')[0].state, 'open');
    // A turn of the operator closes it with the reason; a closed note takes no text; the list shows the open ones.
    fx.thread({ turn_source: 'operator' });
    assert.equal(fx.run('save.mjs', ['note', 'shop', notes[0].id, '--state', 'processed']).status, 1, 'a reason is needed');
    r = fx.run('save.mjs', ['note', 'shop', notes[0].id, '--state', 'processed', '--reason', 'v skille od 21. 11.']);
    assert.equal(r.status, 0, r.out);
    const closed = parseFrontmatter(fs.readFileSync(path.join(fx.brain, notes[0].rel), 'utf8'));
    assert.equal(closed.data.state, 'processed');
    assert.equal(closed.data.reason, 'v skille od 21. 11.');
    assert.match(closed.body, /Aj pri variantoch/);
    r = fx.run('save.mjs', ['note', 'shop', notes[0].id, '--content', 'neskoro']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /is processed/);
    const list = fx.run('save.mjs', ['note', 'shop', '--list']).stdout;
    assert.ok(!list.includes(notes[0].id) && list.includes(notes[1].id), list);
    // The agent does not write the folder itself.
    const hook = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.brain, notes[1].rel), content: 'x' } });
    assert.match(hook.json.hookSpecificOutput?.permissionDecisionReason || '', /direct write into brain is not allowed/);
  } finally { fx.cleanup(); }
});
