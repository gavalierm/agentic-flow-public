// P-061 (agentic-flow-public#32): an open dialog covers the text of the turn, so a dialog about a long plan must carry its content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setup } from './helpers.mjs';
import { dialogText, LONG_TURN_TEXT, MIN_DIALOG_TEXT } from '../hooks/pre-tool-use.mjs';
import { transcriptTurnText } from '../scripts/bypass.mjs';

const THIN = /the dialog shows only \d+[^]*P-061/;
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const line = (type, content, timestamp, extra = {}) => JSON.stringify({ type, timestamp, message: { role: type, content }, ...extra });
const PLAN = `Plán zberu: ${'krok so zdrojom a výstupom; '.repeat(60)}`;
const THIN_DIALOG = { questions: [{ question: 'Ktorým krokom začať?', options: [{ label: 'Krok 1' }, { label: 'Krok 2' }] }] };
const RICH_DIALOG = { questions: [{ question: 'Plán má 3 kroky: zber pobočiek z máp (1 úloha na volanie), overenie súradníc, report. Ktorým krokom začať?', options: [
  { label: 'Zber pobočiek', description: 'Stiahne pobočky z máp po jednej úlohe na volanie a uloží ich do materiálov.' },
  { label: 'Overenie súradníc', description: 'Najprv overí súradnice predajní, aby sa zber neopakoval.' },
] }] };

function transcript(fx, entries) {
  const file = path.join(fx.root || path.dirname(fx.project), `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, entries.join('\n') + '\n');
  return file;
}

test('transcriptTurnText: only the assistant text of this turn; tool results and the earlier turns do not count', () => {
  const fx = setup();
  try {
    const file = transcript(fx, [
      line('user', 'starý prompt', '2020-01-01T00:00:00.000Z'),
      line('assistant', [{ type: 'text', text: 'stará odpoveď' }], '2020-01-01T00:00:01.000Z'),
      line('user', 'nový prompt', '2030-01-01T00:00:00.000Z'),
      line('assistant', [{ type: 'text', text: 'plán' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], '2030-01-01T00:00:01.000Z'),
      line('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'výstup nástroja' }], '2030-01-01T00:00:02.000Z'),
      line('assistant', [{ type: 'text', text: 'pokračovanie' }], '2030-01-01T00:00:03.000Z'),
      line('assistant', [{ type: 'text', text: 'pracovník' }], '2030-01-01T00:00:04.000Z', { isSidechain: true }),
    ]);
    assert.equal(transcriptTurnText(file, '2029-01-01T00:00:00.000Z'), 'plán\npokračovanie');
    assert.equal(transcriptTurnText(file, ''), 'plán\npokračovanie', 'without a turn start the last operator prompt bounds it');
    assert.equal(transcriptTurnText(undefined, ''), '');
    assert.ok(dialogText(RICH_DIALOG).length >= MIN_DIALOG_TEXT && dialogText(THIN_DIALOG).length < MIN_DIALOG_TEXT && PLAN.length >= LONG_TURN_TEXT);
  } finally { fx.cleanup(); }
});

test('AskUserQuestion after a long plan written as text: a dialog that shows little is refused once, a repeat and a dialog with the content pass (P-061)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    const ask = (tool_input, transcript_path) => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input, transcript_path });
    const turn = (text) => {
      fx.hook('user-prompt-submit.mjs', { prompt: 'priprav plán zberu' });
      const at = new Date(Date.now() + 1000).toISOString();
      return transcript(fx, [line('assistant', [{ type: 'text', text: 'stará odpoveď '.repeat(200) }], '2020-01-01T00:00:00.000Z'), line('user', 'priprav plán zberu', at), line('assistant', [{ type: 'text', text }], at)]);
    };

    let t = turn(PLAN);
    const first = ask(THIN_DIALOG, t);
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(first), THIN);
    assert.doesNotMatch(reasonOf(ask(THIN_DIALOG, t)), THIN, 'once per turn: the repeat passes');

    t = turn(PLAN);
    assert.doesNotMatch(reasonOf(ask(RICH_DIALOG, t)), THIN, 'the dialog carries the plan');
    t = turn(PLAN);
    assert.doesNotMatch(reasonOf(ask({ questions: [{ question: 'Začať?', options: [{ label: 'Áno', preview: PLAN.slice(0, 400) }, { label: 'Nie' }] }] }, t)), THIN, 'the plan in a preview');
    t = turn('Vydané vo v0.9.72. Vydať aj poštu?');
    assert.doesNotMatch(reasonOf(ask(THIN_DIALOG, t)), THIN, 'a short turn needs no summary; the earlier turn does not count');
  } finally { fx.cleanup(); }
});

test('AskUserQuestion: the turn text reaches the transcript after PreToolUse starts, the check waits for this call (P-061, flow-public#32 pilot)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'priprav plán zberu' });
    const at = new Date(Date.now() + 1000).toISOString();
    const file = transcript(fx, [line('user', 'priprav plán zberu', at)]);
    // The pilot: the plan and the dialog call reached the transcript 20 ms after the hook had read it, so the dialog passed.
    const later = [line('assistant', [{ type: 'text', text: PLAN }], at), line('assistant', [{ type: 'tool_use', id: 'toolu_late', name: 'AskUserQuestion', input: THIN_DIALOG }], at)].join('\n') + '\n';
    spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").appendFileSync(process.argv[1], process.argv[2]), 300)', file, later], { stdio: 'ignore', detached: true }).unref();
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: THIN_DIALOG, transcript_path: file, tool_use_id: 'toolu_late' });
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(r), THIN);
  } finally { fx.cleanup(); }
});
