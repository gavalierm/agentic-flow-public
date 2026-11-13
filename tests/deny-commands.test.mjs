// P-030: a command form the project's brain forbids (policy `harness.deny_commands`: [{ match, reason }]) is denied by
// PreToolUse with its reason (the skill that replaces it); the whole command text counts, heredoc body included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { deniedCommand } from '../hooks/pre-tool-use.mjs';

const RULE = {
  match: "^(?=[\\s\\S]*flow-repo)(?=(?:[\\s\\S]*[;&|(\\n])?\\s*python3?\\b)[\\s\\S]*(?:write_text|write_bytes|open\\([^)]*['\"](?:[wax]|r\\+)[bt+]*['\"])",
  reason: 'python3 writing into the flow repo: use skill multi-replace',
};
const HEREDOC = "cd /work/flow-repo && python3 - <<'EOF'\nfrom pathlib import Path\np = Path('hooks/a.mjs')\np.write_text(p.read_text().replace('a', 'b'))\nEOF";

test('deniedCommand: the first matching entry gives its reason; a bad regex is skipped', () => {
  assert.equal(deniedCommand(HEREDOC, []), null);
  assert.equal(deniedCommand(HEREDOC, undefined), null);
  assert.match(deniedCommand(HEREDOC, [RULE]), /^python3 writing into the flow repo: use skill multi-replace \(policy harness\.deny_commands of the brain\)$/);
  assert.match(deniedCommand(HEREDOC, [{ match: '(' }, { match: 'no-such-command' }, RULE]), /multi-replace/, 'a regex that does not compile is skipped');
  assert.equal(deniedCommand(`python3 -c "print(open('/work/flow-repo/a.mjs').read())"`, [RULE]), null, 'reading passes');
  assert.equal(deniedCommand('git commit -m "python3 flow-repo write_text"', [RULE]), null, 'python3 inside a message is no command');
  assert.match(deniedCommand('ls\npython3 x.py flow-repo; open("f", "w")', [RULE]), /multi-replace/);
  assert.match(deniedCommand('python3 x', [{ match: 'python3' }]), /^command form forbidden by the project/);
});

test('PreToolUse denies a command the brain policy forbids; without the policy it is not denied for it', () => {
  const fx = setup();
  try {
    const bash = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
    let r = bash(HEREDOC);
    assert.doesNotMatch(r.json?.hookSpecificOutput?.permissionDecisionReason || '', /deny_commands/);
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ harness: { deny_commands: [RULE] } }));
    r = bash(HEREDOC);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', r.out);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /use skill multi-replace \(policy harness\.deny_commands of the brain\)/);
    r = bash("python3 -c \"print(open('/work/flow-repo/a.mjs').read())\"");
    assert.doesNotMatch(r.json?.hookSpecificOutput?.permissionDecisionReason || '', /deny_commands/);
  } finally { fx.cleanup(); }
});
