// P-063 (agentic-flow-public#30): a turn the operator starts with a question gets its first side effect refused once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { isQuestionPrompt } from '../hooks/user-prompt-submit.mjs';
import { questionSideEffect, MCP_WRITE_VERBS } from '../hooks/pre-tool-use.mjs';

const policy = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'policy', 'policy.json'), 'utf8'));
const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const QUESTION = /started this turn with a question[^]*P-063/;

function started() {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
  return fx;
}

test('isQuestionPrompt: a question or a request to explain is a question; an instruction or a request to act is not (P-063)', () => {
  for (const p of ['čo je to? asi to má ísť na /novy', 'Nerozumiem v čom je problém', 'Chcem pochopiť koncept druhý mozog', 'Prečo sa to stalo', 'zisti, či sa aplikuje RAG', 'What is this redirect?']) {
    assert.equal(isQuestionPrompt(p, policy), true, p);
  }
  for (const p of ['pridaj presmerovanie na /novy', 'Môžeš pridať presmerovanie?', 'Prečo to nefunguje? oprav to', 'začni', 'áno', 'nasaď https://x.sk/?a=1', 'can you fix it?', '<pasted_content id="p1">čo je to?</pasted_content>']) {
    assert.equal(isQuestionPrompt(p, policy), false, p);
  }
});

test('question turn: the first write outside scratch/ is refused once, a repeat passes; scratch/ and an instruction turn stay open (P-063)', () => {
  const fx = started();
  try {
    const write = (rel) => fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, rel), content: 'x' } });
    const asked = fx.hook('user-prompt-submit.mjs', { prompt: 'čo je to? asi to má ísť na /novy' });
    assert.equal(stateOf(fx).turn_intent, 'question');
    assert.match(asked.context, /the operator asks[^]*P-063/);
    assert.doesNotMatch(reasonOf(write('scratch/notes.md')), QUESTION, 'a work file is no side effect');
    const first = write('config.txt');
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(first), QUESTION);
    assert.match(reasonOf(first), /Write config\.txt/);
    assert.doesNotMatch(reasonOf(write('config.txt')), QUESTION, 'once per turn: the repeat passes');

    fx.hook('user-prompt-submit.mjs', { prompt: 'pridaj presmerovanie na /novy' });
    assert.equal(stateOf(fx).turn_intent, null);
    assert.doesNotMatch(reasonOf(write('config.txt')), QUESTION, 'an instruction turn is open');

    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(stateOf(fx).turn_intent, null, 'a bell is no operator question');
  } finally { fx.cleanup(); }
});

test('question turn: a page action and a shell write are side effects, a screenshot and a read are not; a dialog answer ends the question (P-063)', () => {
  const fx = started();
  try {
    const call = (tool_name, tool_input) => fx.hook('pre-tool-use.mjs', { tool_name, tool_input });
    fx.hook('user-prompt-submit.mjs', { prompt: 'Prečo je tam iné presmerovanie?' });
    assert.doesNotMatch(reasonOf(call('mcp__claude-in-chrome__computer', { action: 'screenshot' })), QUESTION);
    assert.doesNotMatch(reasonOf(call('Bash', { command: 'grep -n novy README.md' })), QUESTION);
    assert.match(reasonOf(call('mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 2] })), QUESTION);

    fx.hook('user-prompt-submit.mjs', { prompt: 'kde je to nastavené?' });
    assert.match(reasonOf(call('Bash', { command: `echo x > ${path.join(fx.project, 'out.txt')}` })), QUESTION);

    fx.hook('user-prompt-submit.mjs', { prompt: 'kde je to nastavené?' });
    const q = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Zmeniť presmerovanie na /novy?' }] } };
    fx.hook('pre-tool-use.mjs', q);
    fx.hook('post-tool-use.mjs', { ...q, tool_response: { answers: { 'Zmeniť presmerovanie na /novy?': 'áno' } } });
    assert.equal(stateOf(fx).turn_intent, null);
    assert.doesNotMatch(reasonOf(call('Write', { file_path: path.join(fx.project, 'config.txt'), content: 'x' })), QUESTION, 'the operator decided in the dialog');
  } finally { fx.cleanup(); }
});

test('questionSideEffect and hooks.json: MCP tools that act reach the hook, reading ones do not count (P-063)', () => {
  const ctx = { projectDir: '/p' };
  assert.equal(questionSideEffect('mcp__claude_ai_Gmail__send_message', {}, '/p', ctx), 'send_message');
  assert.equal(questionSideEffect('mcp__playwright__browser_click', {}, '/p', ctx), 'browser_click');
  assert.equal(questionSideEffect('mcp__claude_ai_Gmail__search_threads', {}, '/p', ctx), null);
  assert.equal(questionSideEffect('mcp__claude_ai_Gmail__list_labels', {}, '/p', ctx), null);
  assert.equal(questionSideEffect('mcp__t3-code__preview_navigate', {}, '/p', ctx), null);
  assert.equal(questionSideEffect('mcp__t3-code__t3_thread_update', { action: 'rename', title: 'x' }, '/p', ctx), 't3_thread_update (rename)', 'an action that is no click still changes');
  assert.equal(questionSideEffect('mcp__t3-code__t3_thread_update', { action: 'archive' }, '/p', ctx), 't3_thread_update (archive)', 'an unknown action is judged by the tool name');
  assert.equal(questionSideEffect('mcp__claude-in-chrome__computer', { action: 'scroll' }, '/p', ctx), null);
  assert.equal(questionSideEffect('mcp__claude-in-chrome__computer', { action: 'zoom' }, '/p', ctx), null);
  const hooks = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const matcher = hooks.hooks.PreToolUse[0].matcher;
  assert.ok(matcher.includes(`(${MCP_WRITE_VERBS.join('|')})`), 'the matcher carries the same verbs');
  const full = new RegExp(`^(?:${matcher})$`);
  for (const t of ['mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__form_input', 'mcp__playwright__browser_click', 'mcp__claude_ai_Gmail__send_message', 'mcp__t3-code__preview_act', 'mcp__t3-code__t3_thread_send']) assert.match(t, full, t);
});
