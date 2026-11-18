// ttl: 2027-05-18
// A project 2026-11-18: every thread of a brain counted the undelivered answers of another topic in its status line, and its
// error.mjs watch would have cleared them. A thread sees only those of a topic it holds; main also those of a closed topic.
import './tmp-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { undeliveredFor, issuesFile } from '../scripts/issue-watch.mjs';

test('undeliveredFor: own topic only; main also a topic without holder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-undeliv-'));
  const u = { at: '2026-11-13T17:07:13Z', comments: [1], why: 'x' };
  fs.mkdirSync(path.dirname(issuesFile(base)), { recursive: true });
  fs.writeFileSync(issuesFile(base), JSON.stringify({ a: { topic: 'audit', undelivered: u }, b: { topic: 'skill', undelivered: u }, c: { topic: 'gone', undelivered: u }, d: { topic: 'skill' } }));
  const hasHolder = (id) => id !== 'gone';
  const keys = (r) => r.map((x) => x.key).sort();
  assert.deepEqual(keys(undeliveredFor(base, { held: [{ id: 'skill' }], hasHolder })), ['b']);
  assert.deepEqual(keys(undeliveredFor(base, { held: [{ id: 'main' }], main: true, hasHolder })), ['c']);
  assert.deepEqual(keys(undeliveredFor(base, { held: [], hasHolder })), []);
  fs.rmSync(base, { recursive: true, force: true });
});
