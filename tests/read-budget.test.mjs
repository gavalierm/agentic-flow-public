// P-001: the main thread learns how much tool output it took in and is pointed to a worker at each 80 KB step and at the
// second web call; subagents are not counted; a new or compacted session starts with an empty budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { readNudge, outputChars, READ_STEP_CHARS, IMAGE_CHARS } from '../hooks/post-tool-use.mjs';

const big = (n) => ({ type: 'text', file: { content: 'x'.repeat(n) } });
const READ = (n) => ({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'index.html' }, tool_response: big(n) });

test('outputChars counts text, an image as a fixed size, not its base64 data', () => {
  assert.ok(outputChars({ stdout: 'abc' }) < 30);
  const img = outputChars({ content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(370_000) } }] });
  assert.ok(img >= IMAGE_CHARS && img < IMAGE_CHARS + 200, `image counted as ${img}`);
});

test('readNudge: one line per 80 KB step, one web line at the second web call', () => {
  let r = readNudge(null, READ(50_000));
  assert.equal(r.line, null);
  r = readNudge(r.budget, READ(40_000));
  assert.match(r.line, /^context: the main thread took in ~90 KB of tool output this session; .*workflow:delegate.*\(P-001\)$/);
  r = readNudge(r.budget, READ(10_000));
  assert.equal(r.line, null, 'same step: silent');
  r = readNudge(r.budget, READ(READ_STEP_CHARS));
  assert.match(r.line, /~180 KB/);
  const web = { tool_name: 'WebSearch', tool_response: { results: [] } };
  r = readNudge(r.budget, web);
  assert.equal(r.line, null, 'first web call: silent');
  r = readNudge(r.budget, web);
  assert.match(r.line, /checking web sources is research.*workflow:delegate.*\(P-001\)/);
  r = readNudge(r.budget, web);
  assert.equal(r.line, null, 'web line once');
});

test('PostToolUse hook: main thread gets the line, a subagent does not, session start resets the budget', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    let r = fx.hook('post-tool-use.mjs', READ(READ_STEP_CHARS + 1));
    assert.match(r.context, /took in ~80 KB.*workflow:delegate/);
    r = fx.hook('post-tool-use.mjs', { ...READ(READ_STEP_CHARS * 3), agent_id: 'w1', agent_type: 'workflow:worker' });
    assert.equal(r.context, '', 'subagent reads on its own context');
    fx.hook('session-start.mjs', { session_id: 's1', hook_event_name: 'SessionStart', source: 'compact' });
    const st = JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8'));
    assert.equal(st.read_budget, null, 'compaction empties the budget');
    r = fx.hook('post-tool-use.mjs', READ(50_000));
    assert.equal(r.context, '');
  } finally {
    fx.cleanup();
  }
});
