// ttl: 2026-12-17
// flow-public#102: the operator's yes in a dialog that named the repo path and described the step in words did not pair with
// `cd <repo> && git commit --no-verify …` (the target was its first two words "cd <repo>"). A leading change of directory
// names the repo the step works in; the refusal lists the exact targets the dialog must name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup } from './helpers.mjs';
import { threadStateFile } from '../scripts/config.mjs';

const state = (fx) => JSON.parse(fs.readFileSync(threadStateFile(fx.brain, fx.thread), 'utf8'));
const pre = (fx, command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }, { env: { WORKFLOW_DRIFT_JUDGE: 'off' } }).json.hookSpecificOutput || {};

test('cd <repo> && git commit --no-verify: the refusal names the repo path, a dialog naming the repo lets it pass', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'commitni to' }, { env: { WORKFLOW_DRIFT_JUDGE: 'off' } });
    const cmd = `cd ${fx.project} && git commit --no-verify -m "x"`;
    let d = pre(fx, cmd);
    assert.equal(d.permissionDecision, 'deny');
    assert.ok(d.permissionDecisionReason.includes(`the dialog names exactly: "${fx.project}"`), d.permissionDecisionReason);
    const st = state(fx);
    fs.writeFileSync(threadStateFile(fx.brain, fx.thread), JSON.stringify({ ...st, dialog_lifts: [{ text: `Mám commitnúť v repe ${fx.project} bez git hookov? Áno`, at: new Date(Date.parse(st.turn_started_at) + 1000).toISOString() }] }));
    d = pre(fx, cmd);
    assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason);
  } finally { fx.cleanup(); }
});
