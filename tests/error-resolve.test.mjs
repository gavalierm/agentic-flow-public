// error.mjs resolve by stable id: ids from one listing stay valid after each resolve (a series of numbers from one
// listing shifted and removed another session's failure, 2026-11-13); restore brings a wrongly dropped failure back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { readLog, bufferAppend } from '../scripts/logs.mjs';

const view = (fx) => readLog(fx.brain, 'failures.log');
const listed = (fx) => {
  const r = fx.run('error.mjs', ['list']);
  assert.equal(r.status, 0, r.out);
  return r.stdout.split('\n').map((l) => /^(\d+)\. (\S+) (.*)$/.exec(l)).filter(Boolean).map((m) => ({ n: m[1], id: m[2], line: m[3] }));
};

test('resolve: ids from one listing, one by one or several at once, never hit another failure; numbers are refused', () => {
  const fx = setup();
  try {
    for (const [s, c] of [['sa', 'curl a'], ['sb', 'curl b'], ['sc', 'curl c'], ['sd', 'curl d']]) {
      bufferAppend(fx.brain, s, { kind: 'fail', command: c, error: 'Exit 1' });
      assert.equal(fx.run('log.mjs', ['flush', '--session', s]).status, 0);
    }
    const one = listed(fx);
    assert.equal(one.length, 4);
    const id = (cmd) => one.find((x) => x.line.includes(cmd)).id;
    // a series against one listing: first a, then b (b's number was 2 before a went)
    assert.equal(fx.run('error.mjs', ['resolve', id('curl a')]).status, 0);
    const r = fx.run('error.mjs', ['resolve', id('curl b')]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(view(fx).map((l) => l.split(' ').slice(3).join(' ')), ['curl c :: Exit 1', 'curl d :: Exit 1']);
    // a bare number is refused and drops nothing
    const bad = fx.run('error.mjs', ['resolve', '1']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /not its number/);
    assert.equal(view(fx).length, 2);
    // an unknown id drops nothing, not even the known one beside it
    assert.notEqual(fx.run('error.mjs', ['resolve', id('curl c'), 'f0000000']).status, 0);
    assert.equal(view(fx).length, 2);
    // several at once
    assert.equal(fx.run('error.mjs', ['resolve', id('curl c'), id('curl d')]).status, 0);
    assert.deepEqual(view(fx), []);
  } finally { fx.cleanup(); }
});

test('restore: the failure a resolve commit dropped comes back through the workflow, a later resolve drops it again', () => {
  const fx = setup();
  try {
    bufferAppend(fx.brain, 'sa', { kind: 'fail', command: 'curl a', error: 'Exit 1' });
    assert.equal(fx.run('log.mjs', ['flush', '--session', 'sa']).status, 0);
    const [a] = listed(fx);
    assert.equal(fx.run('error.mjs', ['resolve', a.id]).status, 0);
    assert.deepEqual(view(fx), []);
    const commit = fx.git(fx.brain, 'log', '-1', '--format=%h', '--', 'logs').trim();
    const r = fx.run('error.mjs', ['restore', commit]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^restored: .*curl a/m);
    assert.deepEqual(view(fx), [a.line]);
    assert.equal(listed(fx)[0].id, a.id, 'the id stays the same');
    // restoring again changes nothing
    assert.notEqual(fx.run('error.mjs', ['restore', commit]).status, 0);
    assert.equal(fx.run('error.mjs', ['resolve', a.id]).status, 0);
    assert.deepEqual(view(fx), []);
  } finally { fx.cleanup(); }
});
