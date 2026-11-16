// keep: core
// P-026, operator 2026-11-16 ("handover by mal byť kvalitnejší pred kompakciou"): the handover is saved before the window
// fills, the PreCompact hook shapes the summary as a state, and the start after compaction weighs a stale handover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { COMPACT_PROMPT, compactInstructions, contextTokens, compactNudge, handoverAgeLine } from '../scripts/compact.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';
import { topicDir } from '../scripts/topic.mjs';
import { layoutOf } from '../scripts/layout.mjs';
import { COMPACT_PROMPT as CODEX_PROMPT, UNSUPPORTED_EVENTS } from '../adapters/codex/generate.mjs';

const line = (o) => JSON.stringify(o);
const assistant = (usage, extra = {}) => line({ type: 'assistant', message: { role: 'assistant', usage }, ...extra });

test('contextTokens: the last main-thread assistant usage, summed; a sidechain and a later user line do not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-compact-'));
  try {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, [
      assistant({ input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }),
      assistant({ input_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000, output_tokens: 600 }),
      assistant({ input_tokens: 9, cache_read_input_tokens: 9, output_tokens: 9 }, { isSidechain: true }),
      line({ type: 'user', message: { role: 'user', content: 'x "usage" "assistant"' } }),
    ].join('\n') + '\n');
    assert.equal(contextTokens(f), 152602);
    assert.equal(contextTokens(path.join(dir, 'none.jsonl')), null);
    assert.equal(contextTokens(null), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compactNudge: at 80 % of the window once, only with a held topic', () => {
  const held = [{ id: 'work' }];
  assert.equal(compactNudge({ tokens: 150000, window: 200000, held }), null);
  const r = compactNudge({ tokens: 165000, window: 200000, held });
  assert.match(r.line, /~165k of 200k tokens.*save\.mjs handover work/);
  assert.deepEqual(r.patch, { compact_nudged: true });
  assert.equal(compactNudge({ tokens: 190000, window: 200000, held, state: { compact_nudged: true } }), null);
  assert.equal(compactNudge({ tokens: 190000, window: 200000, held: [] }), null);
  assert.equal(compactNudge({ tokens: null, window: 200000, held }), null);
});

test('the summary prompt keeps operator messages verbatim and has no line limit; Codex uses the same text and no PreCompact hook', () => {
  assert.match(COMPACT_PROMPT, /Správy operátora: každá správa operátora doslova/);
  assert.match(COMPACT_PROMPT, /trvalý pokyn/);
  assert.doesNotMatch(COMPACT_PROMPT, /najviac 3 riadky/);
  assert.equal(compactInstructions(), COMPACT_PROMPT);
  assert.equal(CODEX_PROMPT, COMPACT_PROMPT);
  assert.ok(UNSUPPORTED_EVENTS.includes('PreCompact'));
});

test('PreCompact hook: plain stdout with the prompt and the age of the handover, exit 0, the time in the thread state; the start after it weighs a stale handover', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'work', '--subject', 'Work', '--class', 'ops']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'work', '--task', 'Do the thing', '--done', 'step 1', '--next', 'step 2', '--files', 'src/app.js', '--questions', '']).status, 0);
    const res = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hooks', 'pre-compact.mjs')], { cwd: fx.project, env: { ...fx.env, CLAUDE_PROJECT_DIR: fx.project }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: fx.project, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }) });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.startsWith(COMPACT_PROMPT));
    assert.match(res.stdout, /Téma work: jej handover je uložený \S+ \(pred 0 min\)/);
    const st = readThreadState(fx.brain, fx.thread);
    assert.equal(st.compact_trigger, 'manual');
    assert.ok(st.compacted_at);

    // fresh handover: it stands
    assert.match(fx.hook('session-start.mjs', { source: 'compact' }).context, /Handover témy work je uložený \S+, tesne pred kompakciou: platí\./);
    // stale handover: the newer summary wins and the handover is updated
    const file = path.join(topicDir(fx.brain, 'work'), layoutOf(fx.brain).handover);
    const old = new Date(Date.now() - 90 * 60000);
    fs.utimesSync(file, old, old);
    writeThreadState(fx.brain, fx.thread, { ...readThreadState(fx.brain, fx.thread), compacted_at: new Date().toISOString() });
    const c = fx.hook('session-start.mjs', { source: 'compact' }).context;
    assert.match(c, /Handover témy work je uložený \S+, 90 min pred kompakciou: .*platí zhrnutie; handover podľa neho hneď aktualizuj \(save\.mjs handover work\)/);
    assert.equal(handoverAgeLine(fx.brain, 'none', null), null);

    // post-tool-use: near the window the main thread is told once; session start clears the mark
    const tr = path.join(fx.root, 't.jsonl');
    fs.writeFileSync(tr, assistant({ input_tokens: 1, cache_read_input_tokens: 170000, output_tokens: 10 }) + '\n');
    const tool = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: 'ok', transcript_path: tr };
    assert.match(fx.hook('post-tool-use.mjs', tool).context, /context: ~170k of 200k tokens.*save\.mjs handover work/);
    assert.doesNotMatch(fx.hook('post-tool-use.mjs', tool).context, /auto-compaction/);
    assert.doesNotMatch(fx.hook('post-tool-use.mjs', { ...tool, agent_id: 'w1' }).context, /auto-compaction/);
    fx.hook('session-start.mjs', { source: 'compact' });
    assert.equal(readThreadState(fx.brain, fx.thread).compact_nudged, false);
  } finally { fx.cleanup(); }
});

test('PreCompact hook without a brain still prints the prompt and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-compact-nobrain-'));
  try {
    const res = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hooks', 'pre-compact.mjs')], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), COMPACT_PROMPT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
