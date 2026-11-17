// keep: core
// P-052 (report 2026-11-17): the system prompt of Claude Code tells the model to use its scratchpad in the system temp dir.
// A Write there already went to the work dir; a shell command with that path was refused (one more turn, and the agent
// had to explain itself). Now the path in the command becomes the work dir; a plain /tmp write stays refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const SID = '576b2a62-edfd-4633-9de5-0c808c48a3d9';

test('a shell command into the harness scratchpad runs in the work dir; /tmp stays refused', () => {
  const fx = setup();
  const sys = path.join(fx.root, 'systmp');
  const pad = path.join(sys, 'claude-1007', '-x-project', SID, 'scratchpad');
  const opts = { env: { WORKFLOW_TEMP_DIRS: sys } };
  try {
    let r = fx.hook('pre-tool-use.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: `curl -s https://example.test > ${pad}/access.txt && wc -l ${pad}/access.txt` } }, opts);
    const h = r.json.hookSpecificOutput;
    assert.notEqual(h?.permissionDecision, 'deny', JSON.stringify(r.json));
    assert.ok(!h.updatedInput.command.includes('scratchpad'), h.updatedInput.command);
    assert.match(h.updatedInput.command, /\/scratch\/access\.txt && wc -l .*\/scratch\/access\.txt$/);
    assert.match(h.additionalContext, /harness scratchpad is not used here/);
    // Another session's scratchpad is not this one's.
    r = fx.hook('pre-tool-use.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: `echo x > ${pad.replace(SID, '00000000-0000-0000-0000-000000000000')}/a.txt` } }, opts);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: `echo x > ${sys}/x` } }, opts);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /system temp dir/);
    // A scratchpad that holds a file keeps the refusal (a real file there is not moved).
    fs.mkdirSync(pad, { recursive: true });
    fs.writeFileSync(path.join(pad, 'old.txt'), 'x');
    r = fx.hook('pre-tool-use.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: `cp ${pad}/old.txt ${pad}/new.txt` } }, opts);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
