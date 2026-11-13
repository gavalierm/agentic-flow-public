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

// report-23c6fb63 (2026-11-13): the shell stood in the clone after a cd of an earlier call; the command named only
// relative paths, so a rule over the clone's path passed it and 5 files were changed by python3.
test('deny_commands counts the shell directory: a python3 write in the clone without its path is denied', () => {
  const run = "python3 - <<'PY'\ndef rep(p,a,b):\n    s=open(p).read(); assert s.count(a)==1; open(p,'w').write(s.replace(a,b))\nrep('scripts/drift.mjs','a','b')\nPY";
  assert.equal(deniedCommand(run, [RULE]), null, 'no path, no directory');
  assert.match(deniedCommand(run, [RULE], '/work/flow-repo'), /multi-replace/);
  assert.equal(deniedCommand(run, [RULE], '/work/other'), null, 'another directory passes');
  assert.equal(deniedCommand('git commit -m "python3 write_text"', [RULE], '/work/flow-repo'), null, 'python3 inside a message is no command');
  const fx = setup();
  try {
    const dir = path.join(fx.project, 'flow-repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ harness: { deny_commands: [RULE] } }));
    const r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: run } });
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny', r.out);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /deny_commands/);
  } finally { fx.cleanup(); }
});

// report-14a1f628 (2026-11-13): the refusal is about the command form and names another way (Edit, multi-replace); it
// locked the file it named, so the Edit the refusal names was denied as a bypass (P-054) until the end of the turn.
test('a deny_commands refusal locks nothing: the Edit of the same file passes afterwards', () => {
  const fx = setup();
  try {
    const file = path.join(fx.project, 'flow-repo', 'hooks', 'a.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\n');
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ harness: { deny_commands: [RULE] } }));
    const r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cd ${path.dirname(path.dirname(file))} && python3 - <<'EOF'\np='hooks/a.mjs'\ns=open(p).read()\nopen(p,'w').write(s.replace('a', 'b'))\nEOF\nhead -1 hooks/a.mjs` } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', r.out);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /deny_commands/);
    const edit = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
    assert.doesNotMatch(JSON.stringify(edit.json || {}), /P-054/, 'Edit is the way the refusal names, not a bypass');
  } finally { fx.cleanup(); }
});
