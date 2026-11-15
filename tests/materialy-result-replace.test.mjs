// ttl: 2026-12-15
// materialy.mjs add --result refused an existing result of the topic ("už existuje: výsledok sa neprepíše"), and Write/Edit
// into the brain are forbidden, so an updated result could only go in as a second copy (--as <name>-v2). --replace writes the
// new version of the same result with a commit; without it the refusal names --replace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup2, gitq } from './layout-2-helpers.mjs';

test('add --result --replace overwrites an existing result of the topic with a commit; without it the refusal names --replace', () => {
  const fx = setup2({ thread: 'mr1' });
  try {
    const src = path.join(fx.root, 'in', 'audit.html');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'v1\n');
    assert.equal(fx.run('topic.mjs', ['create', 'audit', '--subject', 'Audit', '--class', 'discussion']).status, 0);
    let r = fx.run('materialy.mjs', ['add', src, '--result', '--topic', 'audit']);
    assert.equal(r.status, 0, r.out);
    const rel = 'temy/audit/audit.html';
    assert.equal(fx.read(rel), 'v1\n');

    fs.writeFileSync(src, 'v2\n');
    r = fx.run('materialy.mjs', ['add', src, '--result', '--topic', 'audit']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /--replace/);
    assert.equal(fx.read(rel), 'v1\n');

    const before = Number(gitq(fx.brain, 'rev-list', '--count', 'HEAD'));
    r = fx.run('materialy.mjs', ['add', src, '--result', '--topic', 'audit', '--replace']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.read(rel), 'v2\n');
    assert.equal(Number(gitq(fx.brain, 'rev-list', '--count', 'HEAD')), before + 1, 'one commit');
    assert.equal(gitq(fx.brain, 'status', '--porcelain', '--', rel).trim(), '', 'committed');
  } finally {
    fx.cleanup();
  }
});
