// Hook decisions (deny, ask, block) are logged in <brain>/local/denials.jsonl, so a false positive is counted, not only
// felt by an interrupted agent (operator 2026-11-08, hooks review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { logDecision, readDenials, summarize, inputHead, denialsFile } from '../scripts/denials.mjs';
import { permissionOutput, contextOutput } from '../scripts/hooks-io.mjs';

test('logDecision: deny, ask and block are logged with the principle, allow and hints are not; secrets are masked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-den-'));
  try {
    const tok = `ghp_${'a'.repeat(30)}`;
    assert.equal(logDecision(dir, { event: 'PreToolUse', tool: 'Bash', toolInput: { command: `curl -H "x: ${tok}" /srv/data/a/very/long/path/that/stays/readable/file.md` }, out: permissionOutput('deny', 'no (P-052)') }), true);
    assert.equal(logDecision(dir, { event: 'Stop', out: { decision: 'block', reason: 'state line missing (P-061)' } }), true);
    assert.equal(logDecision(dir, { event: 'PreToolUse', tool: 'Read', toolInput: { file_path: 'a' }, out: contextOutput('PreToolUse', 'hint (P-001)') }), false);
    assert.equal(logDecision(dir, { event: 'PreToolUse', tool: 'Read', toolInput: {}, out: {} }), false);
    logDecision(dir, { event: 'PreToolUse', tool: 'Write', toolInput: { file_path: 'CLAUDE.md' }, out: permissionOutput('deny', 'stale (P-007, P-013)') });
    assert.equal(logDecision(null, { event: 'Stop', out: { decision: 'block', reason: 'x' } }), false, 'no brain: nothing, no throw');
    const all = readDenials(dir);
    assert.equal(all.length, 3);
    assert.equal(all[2].principle, 'P-007', 'the first cited principle is the check');
    assert.deepEqual(all[2].cited, ['P-007', 'P-013']);
    assert.equal(all[0].principle, 'P-052');
    assert.doesNotMatch(all[0].input, /ghp_/);
    assert.match(all[0].input, /very\/long\/path/, 'a path is not a secret');
    assert.deepEqual(summarize(all).map((g) => g.key), ['P-052 PreToolUse deny', 'P-061 Stop block', 'P-007 PreToolUse deny']);
    assert.equal(inputHead('Write', { file_path: '/p/x.md', content: 'secret' }), '/p/x.md');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hooks write their denials into the brain local log; denials.mjs groups them', () => {
  const fx = setup();
  try {
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'CLAUDE.md'), content: '# x\n' } }).json;
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'no state line' });
    fx.hook('subagent-stop.mjs', { agent_type: 'workflow:worker', last_assistant_message: 'done' });
    const lines = fs.readFileSync(denialsFile(fx.brain), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => `${l.event} ${l.decision}`), ['PreToolUse deny', 'Stop block', 'SubagentStop block']);
    assert.equal(lines[0].tool, 'Write');
    assert.equal(lines[2].agent, 'workflow:worker');
    assert.equal(fx.git(fx.brain, 'status', '--porcelain', '--', 'local').trim(), '', 'local/ is not committed');
    const out = fx.run('denials.mjs', ['--days', '1']).stdout;
    assert.match(out, /^denials: 3 in 1 d/);
    assert.match(out, /PreToolUse deny\n.*CLAUDE\.md/);
  } finally { fx.cleanup(); }
});
