// P-013, P-018, P-025, P-031: PreToolUse hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('writes into brain are denied; tracked clean files pass silently; untracked or ignored targets ask', () => {
  const fx = setup();
  try {
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.brain, 'memory', 'x.md'), content: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /workflow:save/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(fx.brain, 'memory', 'x.md')}` } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'README.md'), content: 'new' } });
    assert.deepEqual(r.json, {});
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'brand-new.md'), content: 'new' } });
    assert.deepEqual(r.json, {}, 'creating a new file is not destructive');
    fs.writeFileSync(path.join(fx.project, 'notes.md'), 'untracked\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'notes.md'), content: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /notes\.md is untracked/);
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'n.md'), 'x\n');
    fs.appendFileSync(path.join(fx.project, '.gitignore'), 'local/\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm local/n.md' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /local\/n\.md/);
  } finally { fx.cleanup(); }
});

test('non-trivial edit of a modified file asks; small edit passes; history operations and many files ask', () => {
  const fx = setup();
  try {
    const file = path.join(fx.project, 'src', 'app.js');
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: file, old_string: big, new_string: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /removing 59 of 101 lines/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'line 1\nline 2', new_string: 'x' } });
    assert.deepEqual(r.json, {});
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    for (const f of 'abcdef') fs.writeFileSync(path.join(fx.project, f), 'x\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm a b c d e f' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /6 files/);
    // Own work files, files the command creates and missing ones are not counted (audit M2 2026-11-11).
    fs.mkdirSync(path.join(fx.project, 'scratch', 'wt'), { recursive: true });
    for (const f of 'abcdef') fs.writeFileSync(path.join(fx.project, 'scratch', 'wt', f), 'x\n');
    for (const command of ['rm scratch/wt/a scratch/wt/b scratch/wt/c scratch/wt/d scratch/wt/e scratch/wt/f', 'echo 1 > n1; echo 2 > n2; echo 3 > n3; echo 4 > n4; echo 5 > n5; echo 6 > n6', 'rm -f g1 g2 g3 g4 g5 g6']) {
      r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'ask', command);
    }
  } finally { fx.cleanup(); }
});

test('subagent cannot call brain scripts; decision binding adds one line once', () => {
  const fx = setup();
  try {
    let r = fx.hook('pre-tool-use.mjs', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'node /x/bin/save.mjs memory operator o --content x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    r = fx.hook('pre-tool-use.mjs', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'node /x/bin/find.mjs xs' } });
    assert.deepEqual(r.json, {});
    assert.equal(fx.run('save.mjs', ['decision', 'Keep app.js tiny', '--what', 'x', '--reason', 'y', '--relates-to', 'src/app.js']).status, 0);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(fx.project, 'src', 'app.js'), old_string: 'console', new_string: 'x' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(r.context.split('\n').length, 1);
    assert.match(r.context, /decision D-0001 relates to src\/app\.js/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(fx.project, 'src', 'app.js'), old_string: 'console', new_string: 'x' } });
    assert.deepEqual(r.json, {}, 'signal once per file per thread');
  } finally { fx.cleanup(); }
});

test('redirects to /dev/null, /dev/stderr and >&2 are not file targets (P-018)', () => {
  const fx = setup();
  try {
    for (const command of ['ls >/dev/null', 'echo x > /dev/null 2>&1', 'echo x >&2', 'cat a >> /dev/stderr', 'cd /tmp; ls >/dev/null']) {
      const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.deepEqual(r.json, {}, command);
    }
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm /dev/null' } });
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'ask', 'deleting a device still asks');
  } finally { fx.cleanup(); }
});

test('shell targets: cd changes the base, heredoc and quotes are not syntax, cp source is only read', async () => {
  const { bashTargets } = await import('../hooks/pre-tool-use.mjs');
  assert.deepEqual(bashTargets('cd ../b && echo x > f', '/w/a'), ['/w/b/f']);
  assert.deepEqual(bashTargets("cat > a.txt <<'EOF'\nx > y; rm z\nEOF\necho ok", '/w/a'), ['/w/a/a.txt']);
  assert.deepEqual(bashTargets('echo "a > b; rm c"', '/w/a'), []);
  assert.deepEqual(bashTargets('cp /etc/hosts out/h', '/w/a'), ['/w/a/out/h']);
  assert.deepEqual(bashTargets('sudo rm /tmp/x 2>/dev/null', '/w/a'), ['/tmp/x']);
  // into a directory: the target is <dir>/<source name>; a source in a variable has no known name (Bob 2026-11-01)
  assert.deepEqual(bashTargets('F=/etc/x.conf; sudo cp $F /var/backups/', '/w/a'), ['/var/backups/x.conf']);
  assert.deepEqual(bashTargets('sudo cp $G /var/backups/', '/w/a'), []);
  assert.deepEqual(bashTargets('mv a.txt b/', '/w/a'), ['/w/a/a.txt', '/w/a/b/a.txt']);
  assert.deepEqual(bashTargets('mv a.txt b.txt', '/w/a'), ['/w/a/a.txt', '/w/a/b.txt']);
});

test('history operations match whole commands; safe forms pass', async () => {
  const { historyOperation } = await import('../hooks/pre-tool-use.mjs');
  const asks = ['git checkout --', 'git restore', 'git clean'];
  const except = ['git restore --staged', 'git clean -n'];
  assert.equal(historyOperation('git checkout --orphan fresh', asks, except), null);
  assert.equal(historyOperation('git checkout -- a.txt', asks, except), 'git checkout --');
  assert.equal(historyOperation('git restore --staged a', asks, except), null);
  assert.equal(historyOperation('git restore a', asks, except), 'git restore');
  assert.equal(historyOperation('git clean -n', asks, except), null);
  assert.equal(historyOperation('cd x && git clean -fd', asks, except), 'git clean');
});

test('a file the thread created is rewritten and deleted without confirmation; foreign untracked still asks', () => {
  const fx = setup();
  try {
    const f = path.join(fx.project, 'draft.md');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: f, content: 'a' } });
    assert.deepEqual(r.json, {});
    fs.writeFileSync(f, 'a\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: f, content: 'b' } });
    assert.deepEqual(r.json, {}, 'own new file');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm draft.md' } });
    assert.deepEqual(r.json, {}, 'own new file deleted');
    fs.writeFileSync(path.join(fx.project, 'foreign.md'), 'x\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'foreign.md'), content: 'y' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    // A stray file a shell redirect of this thread created (e.g. `> 0`) is cleaned up without confirmation.
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'echo x > 0' } });
    assert.deepEqual(r.json, {});
    fs.writeFileSync(path.join(fx.project, '0'), 'x\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm 0' } });
    assert.deepEqual(r.json, {}, 'own stray file deleted');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm foreign.md' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask', 'foreign untracked still asks');
  } finally { fx.cleanup(); }
});

test('P-055: t3_thread_send (also MCP-namespaced) is denied with the mail route; other MCP tools pass', () => {
  const fx = setup();
  try {
    for (const name of ['mcp__t3-code__t3_thread_send', 't3_thread_send']) {
      const r = fx.hook('pre-tool-use.mjs', { tool_name: name, tool_input: { threadId: 'x', text: 'do it' } });
      assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /--reply-to.*P-055/);
    }
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'mcp__t3-code__t3_thread_read', tool_input: { threadId: 'x' } });
    assert.deepEqual(r.json, {});
  } finally { fx.cleanup(); }
});

test('subagent: a script only named as an argument or in quotes is not executed; real calls are denied (P-025, P-044)', async () => {
  const { executedScripts, commsSubagentCheck } = await import('../hooks/pre-tool-use.mjs');
  assert.deepEqual(executedScripts('cat /x/bin/comms.mjs | wc -l; grep -n y bin/topic.mjs'), []);
  assert.deepEqual(executedScripts('echo "node bin/comms.mjs send"'), []);
  assert.deepEqual(executedScripts('cd /x && node --no-warnings bin/save.mjs memory a').map((e) => e.script), ['bin/save.mjs']);
  assert.deepEqual(executedScripts('bash -c "node /x/bin/save.mjs memory"').map((e) => e.script), ['/x/bin/save.mjs']);
  assert.deepEqual(executedScripts('X=1 ./bin/topic.mjs claim t').map((e) => e.script), ['./bin/topic.mjs']);
  assert.equal(commsSubagentCheck('sed -n 1,40p /x/bin/comms.mjs'), null);
  assert.match(commsSubagentCheck('node /x/bin/comms.mjs send --level info'), /comms send/);
  assert.equal(commsSubagentCheck('node /x/bin/comms.mjs receive --topic t'), null);
  // Syntax check, help and read-only subcommands are not sending (audit M2 2026-11-11).
  for (const c of ['node --check /x/bin/comms.mjs', 'node -c scripts/comms.mjs', 'node /x/bin/comms.mjs --help', 'node /x/bin/comms.mjs', 'node /x/bin/comms.mjs status', 'node /x/bin/comms.mjs notices --all']) assert.equal(commsSubagentCheck(c), null, c);
  assert.match(commsSubagentCheck('node /x/bin/comms.mjs ack --id 1'), /comms ack/);
  assert.deepEqual(executedScripts('node --check bin/save.mjs'), []);
  const fx = setup();
  try {
    let r = fx.hook('pre-tool-use.mjs', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'wc -l /x/bin/topic.mjs /x/bin/comms.mjs' } });
    assert.deepEqual(r.json, {});
    r = fx.hook('pre-tool-use.mjs', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'node /x/bin/topic.mjs claim t' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('grep -h over several files, a glob or recursively adds a hint; one file, stdin or -H stay silent', async () => {
  const { grepNoFilename } = await import('../hooks/pre-tool-use.mjs');
  for (const c of ['grep -h foo a.md b.md', 'grep -hn "x y" reports/*.md', 'cd d && grep -rh foo .', 'grep --no-filename -e x a b', 'grep -iA3 -h pat a b | head']) {
    assert.match(grepNoFilename(c) || '', /grep -H/, c);
  }
  for (const c of ['grep -h foo a.md', 'cat a b | grep -h foo', 'grep -H foo a b', 'grep foo a b', 'grep -hH foo a b', 'echo "grep -h x a b"', 'grep -h "a b" c.md']) {
    assert.equal(grepNoFilename(c), null, c);
  }
  const fx = setup();
  try {
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'grep -h x README.md src/app.js' } });
    assert.match(r.json.hookSpecificOutput.additionalContext, /drops file names/);
  } finally { fx.cleanup(); }
});

test('claude plugin install|enable and marketplace add without --scope project|local are denied; mcp add only with scope user', async () => {
  const { pluginScopeCall } = await import('../hooks/pre-tool-use.mjs');
  for (const c of ['claude plugin install x@y', 'claude plugin install x --scope user', 'claude plugins i x', 'claude plugin marketplace add o/r',
    'cd a && claude plugin install x --scope project && claude plugin enable y', 'claude mcp add -s user srv cmd', 'FOO=1 /usr/local/bin/claude plugin enable z']) {
    assert.ok(pluginScopeCall(c), c);
  }
  for (const c of ['claude plugins i x -s project', 'claude plugin install x --scope=local', 'claude plugin list', 'claude plugin install --help',
    'git commit -m "claude plugin install x"', 'claude mcp add srv cmd', 'claude mcp add --scope project srv cmd', 'echo claude']) {
    assert.equal(pluginScopeCall(c), null, c);
  }
  const fx = setup();
  try {
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'claude plugin install foo@bar' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /--scope project/);
    assert.ok(r.json.hookSpecificOutput.permissionDecisionReason.includes(fx.project));
    const ok = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'claude plugin install foo@bar --scope project' } });
    assert.notEqual(ok.json.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
