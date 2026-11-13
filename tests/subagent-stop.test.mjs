// P-028, issue #28: a worker result must carry a Failures section (the hook blocks without it), and its Failures body
// is written to failures.log, where error.mjs list reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hasFailuresSection, failuresText } from '../hooks/subagent-stop.mjs';
import { loadPolicy } from '../scripts/config.mjs';
import { checkResult } from '../bin/delegate.mjs';
import { setup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const policy = loadPolicy(null);

test('P-028, flow-public#34: a failed source call (web, MCP) with "Failures: none" blocks; listed failures, Bash errors and no transcript pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-substop-'));
  try {
    const file = path.join(dir, 'agent.jsonl');
    const use = (id, name, input) => JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id, content, is_error) => JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
    fs.writeFileSync(file, [use('w1', 'WebFetch', { url: 'https://example.test/a', prompt: 'x' }), result('w1', 'Request failed with status code 403', true), use('b1', 'Bash', { command: 'grep x y' }), result('b1', 'Exit code 1', true), use('w2', 'WebFetch', { url: 'https://example.test/b' }), result('w2', 'page text', false)].join('\n') + '\n');
    const none = { agent_type: 'workflow:worker', agent_id: 'a1', last_assistant_message: 'Pobočka X sa nenašla.\n\nFailures: none' };
    const blocked = run({ ...none, agent_transcript_path: file }, policy);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /1 source call\(s\) failed \(WebFetch https:\/\/example\.test\/a: Request failed with status code 403\).*not read apart from facts not found/);
    assert.deepEqual(run({ ...none, last_assistant_message: 'Zdroj A sa nepodarilo prečítať.\n\nFailures: WebFetch A -> 403', agent_transcript_path: file }, policy), {});
    assert.deepEqual(run(none, policy), {}, 'no transcript, nothing to check');
    fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
    fs.copyFileSync(file, path.join(dir, 's1', 'subagents', 'agent-a1.jsonl'));
    assert.equal(run({ ...none, session_id: 's1', transcript_path: path.join(dir, 's1.jsonl') }, policy).decision, 'block', 'the transcript next to the session when the input has no agent_transcript_path');
    fs.writeFileSync(file, [use('b1', 'Bash', { command: 'grep x y' }), result('b1', 'Exit code 1', true), use('m1', 'mcp__gsc__query', { site: 's' }), result('m1', 'rows', false)].join('\n') + '\n');
    assert.deepEqual(run({ ...none, agent_transcript_path: file }, policy), {}, 'a Bash exit code and a source that was read are no unread source');
    // flow-public#52: the browser did not start (Bash), curl returned a page without its JavaScript content.
    fs.writeFileSync(file, [use('b2', 'Bash', { command: 'agent-browser open https://shop.test/p1' }), result('b2', 'Exit code 1\nError: spawn UNKNOWN', true), use('b3', 'Bash', { command: 'curl -sL https://shop.test/p1' }), result('b3', '<html>', false)].join('\n') + '\n');
    const browser = run({ ...none, agent_transcript_path: file }, policy);
    assert.equal(browser.decision, 'block', 'a browser that did not start is a source not read');
    assert.match(browser.reason, /Bash agent-browser open https:\/\/shop\.test\/p1: Exit code 1 Error: spawn UNKNOWN/);
    assert.deepEqual(run({ ...none, last_assistant_message: 'Tabuľka veľkostí sa nepodarilo prečítať.\n\nFailures: agent-browser spawn UNKNOWN, curl bez JavaScriptu', agent_transcript_path: file }, policy), {});
    fs.writeFileSync(file, [use('b4', 'Bash', { command: 'grep -r agent-browser-notes docs' }), result('b4', 'Exit code 1', true)].join('\n') + '\n');
    assert.deepEqual(run({ ...none, agent_transcript_path: file }, policy), {}, 'a word inside another name is no browser');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P-028: missing Failures blocks the subagent; present section, exempt agents and stop_hook_active pass', () => {
  const blocked = run({ agent_id: 'x', agent_type: 'workflow:worker', last_assistant_message: 'All done.', stop_hook_active: false }, policy);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Failures/);
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'Done.\n\nFailures: none', stop_hook_active: false }, policy), {});
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'Done.\n\n## Failures\n- curl without header -> 401; works with header', stop_hook_active: false }, policy), {});
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: '**Failures:** none' }, policy), {});
  assert.deepEqual(run({ agent_type: 'Explore', last_assistant_message: 'found it' }, policy), {});
  assert.deepEqual(run({ agent_type: 'general-purpose', last_assistant_message: 'found it' }, policy), {}, 'only the workflow worker has the result rules');
  assert.deepEqual(run({ agent_type: 'claude-code-guide', last_assistant_message: 'x' }, policy), {});
  assert.equal(run({ agent_type: 'worker', last_assistant_message: 'x' }, policy).decision, 'block');
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'x', stop_hook_active: true }, policy), {});
  assert.equal(hasFailuresSection('no failures were seen'), false, 'word inside a sentence is not a section');
  // The length limit of the policy is enforced by the hook, not by a manual check (audit M4 2026-11-11).
  const long = run({ agent_type: 'workflow:worker', last_assistant_message: 'x'.repeat(3001) + '\nFailures: none' }, policy);
  assert.equal(long.decision, 'block');
  assert.match(long.reason, /3016 chars, the limit is 3000/);
  assert.deepEqual(run({ agent_type: 'workflow:worker', last_assistant_message: 'x'.repeat(2900) + '\nFailures: none' }, policy), {});
});

test('P-028: delegate check enforces the Failures section and the char limit', () => {
  assert.deepEqual(checkResult('result\nFailures: none', 2000), []);
  assert.equal(checkResult('result', 2000).length, 1);
  assert.equal(checkResult('x'.repeat(2001) + '\nFailures: none', 2000).length, 1);
});

test('failuresText returns the section body, and nothing for "none" or a missing section', () => {
  assert.equal(failuresText('Hotovo.\n\nFailures: none'), '');
  assert.equal(failuresText('Hotovo.\n\n**Failures:** none.'), '');
  assert.equal(failuresText('Hotovo.'), '');
  assert.equal(failuresText('Hotovo.\n\nFailures: curl bez hlavičky -> 401'), 'curl bez hlavičky -> 401');
  assert.equal(failuresText('x\n## Failures\n- curl -> 401\n- ok s X'), '- curl -> 401\n- ok s X');
});

test('P-028: a worker result with Failures is logged for error list; "none" and other agents are not', () => {
  const fx = setup();
  try {
    const worker = (session, agent, msg) => fx.hook('subagent-stop.mjs', { session_id: session, agent_id: agent, agent_type: 'workflow:worker', last_assistant_message: msg });
    assert.deepEqual(worker('w1', 'sub7', 'Hotovo.\n\nFailures: curl bez hlavičky X -> 401; funguje s X').json, {});
    assert.match(fx.run('error.mjs', ['list']).stdout, /1\. \S+ sub7 w1 worker-result :: curl bez hlavičky X -> 401; funguje s X/);
    worker('w2', 'sub8', 'Hotovo.\n\nFailures: none');
    assert.doesNotMatch(fx.run('error.mjs', ['list']).stdout, /sub8/);
    fx.hook('subagent-stop.mjs', { session_id: 'w3', agent_id: 'sub9', agent_type: 'Explore', last_assistant_message: 'Failures: something' });
    assert.doesNotMatch(fx.run('error.mjs', ['list']).stdout, /sub9/);
  } finally { fx.cleanup(); }
});
