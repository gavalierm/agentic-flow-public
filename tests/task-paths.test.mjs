// ttl: 2026-12-19
// alice 2026-11-19: the prompt of the daily report named docs/ai-news/ of an older brain layout; the hook now refuses a
// recurring task whose absolute paths have no folder (a URL, a placeholder and a file still to be written pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingTaskPaths } from '../scripts/waker.mjs';

test('recurring task prompt: paths without a folder are found, URLs and placeholders are not', () => {
  const have = new Set(['/b/skills/x', '/b/local', '/h']);
  const exists = (d) => have.has(d);
  const prompt = 'node /b/skills/x/collect.mjs; read /b/docs/ai/brief.md; write /b/local/new.json and /b/docs/r/YYYY-MM-DD.md, ~/x.md; see https://example.com/a/b';
  assert.deepEqual(missingTaskPaths(prompt, { home: '/h', exists }), ['/b/docs/ai/brief.md']);
  assert.deepEqual(missingTaskPaths('node /b/skills/x/collect.mjs', { exists }), []);
});
