// keep: guarded
// flow-public#108: a worker allowed a live write test on one test record ran the write with a plan of live records; the
// limit stood only in the words of the brief. Policy harness.subagent_deny_commands ([{ match, reason }], the shape of
// deny_commands) names the commands that stay with the thread: the PreToolUse hook refuses them in a subagent only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const run = (fx, command, sub) => fx.hook('pre-tool-use.mjs', { ...(sub ? { agent_id: 'sub-1', agent_type: 'workflow:worker' } : {}), tool_name: 'Bash', tool_input: { command }, cwd: fx.project }).json?.hookSpecificOutput || {};

test('subagent_deny_commands: a listed command is refused in a subagent with its reason, the thread runs it, other commands pass', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ harness: { subagent_deny_commands: [
      { match: 'upload\\.mjs\\b.*--apply', reason: 'the live write test is run by the thread' },
      { match: 'wipe\\.sh' },
    ] } }));
    // The rights sections of the policy count only as committed (scripts/config.mjs brainPolicy).
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy for test');
    const live = run(fx, 'node tools/upload.mjs --plan plan.json --apply', true);
    assert.equal(live.permissionDecision, 'deny');
    assert.match(live.permissionDecisionReason, /^the live write test is run by the thread \(policy harness\.subagent_deny_commands of the brain\)$/);
    assert.match(run(fx, 'sh wipe.sh', true).permissionDecisionReason, /return the exact command .* the thread that started you runs it \(policy harness\.subagent_deny_commands/);
    assert.notEqual(run(fx, 'node tools/upload.mjs --plan plan.json', true).permissionDecision, 'deny', 'dry run of a worker');
    assert.notEqual(run(fx, 'node tools/upload.mjs --plan plan.json --apply', false).permissionDecision, 'deny', 'the thread');
  } finally { fx.cleanup(); }
});
