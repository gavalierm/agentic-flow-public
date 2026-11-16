// ttl: 2026-12-14
// topic.mjs create and thread refuse a --task that is empty or only whitespace (observed 2026-11-14, v1.5.2:
// --task "$(cat <missing file>)" gave an empty string, the topic and its thread started without instructions);
// nothing is created: no topic, thread or worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const listing = (dir) => {
  const outList = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); outList.push(p); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return outList.filter((p) => p.includes('empty-t')).sort();
};

test('topic.mjs create/thread refuse an empty or whitespace --task and create nothing', () => {
  const fx = setup();
  try {
    const head = fx.git(fx.brain, 'rev-parse', 'HEAD');
    const cases = [
      ['create', 'empty-t', '--subject', 'S', '--class', 'code', '--task', ''],
      ['create', 'empty-t', '--subject', 'S', '--class', 'code', '--task', '  \n\t '],
      ['create', 'empty-t', '--subject', 'S', '--class', 'code', '--task', '--new-thread'],
      ['create', 'empty-t', '--subject', 'S', '--class', 'code', '--task=  '],
      ['thread', 'empty-t', '--task', ' '],
    ];
    for (const args of cases) {
      const r = fx.run('topic.mjs', args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, /--task is empty/, r.out);
      assert.match(r.out, /nothing created/, r.out);
    }
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(listing(fx.root), []);
    // a topic with a task, and one without --task at all, are still created
    const ok = fx.run('topic.mjs', ['create', 'with-task', '--subject', 'S', '--class', 'discussion', '--task', 'do x', '--here']);
    assert.equal(ok.status, 0, ok.out);
  } finally { fx.cleanup(); }
});
