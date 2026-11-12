// P-013, P-018, P-025, P-031: PreToolUse hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { accountEmailCall, bashTargets, executedText, forcedAddIgnored, foregroundWait, gitBashPath, gitWriteDirs, historyOperation, maskShell, recursiveModeChange, stripHeredocs, shellWriteTargets } from '../hooks/pre-tool-use.mjs';
import { runsText, withoutDataHeredocs } from '../scripts/bypass.mjs';
import { inPlaceEdits } from '../scripts/own-files.mjs';

const MAIL = 'owner@example.test';

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
  for (const c of ['grep -h foo a.md b.md', 'grep -hn "x y" reports/*.md', 'cd d && grep -rh foo .', 'grep --no-filename -e x a b', 'grep -iA3 -h pat a b | head',
    'grep -h foo a b | tail -12', 'grep -hc foo a b', 'grep -h x a b; sort c']) {
    assert.match(grepNoFilename(c) || '', /grep -H/, c);
  }
  for (const c of ['grep -h foo a.md', 'cat a b | grep -h foo', 'grep -H foo a b', 'grep foo a b', 'grep -hH foo a b', 'echo "grep -h x a b"', 'grep -h "a b" c.md',
    // aggregated output: no line is assigned to a file (audit 2.5 c: 12 of 14 hints)
    "grep -rhoE '<form[^>]*>' --include=*.html . | sort | uniq -c | head", 'grep -ho foo a b', 'grep --only-matching -h foo a b',
    'grep -h "^### P-" rules/*.md | sed "s/x//" | sort -n | tail -3', 'grep -h foo a b | wc -l', "grep -h foo a b | awk '{print $1}'", 'grep -h foo a b | /usr/bin/uniq -c']) {
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

test('P-052, audit 2.5a: Write into the harness scratchpad of this session goes to scratch/ with a note naming the path, Edit follows it; another session stays refused', () => {
  const fx = setup();
  try {
    const tmp = { env: { WORKFLOW_TEMP_DIRS: fx.root } };
    const sid = '0f3c2a9e-1111-4222-8333-944455556666';
    const pad = (s) => path.join(fx.root, 'claude-1000', '-p', s, 'scratchpad');
    const into = path.join(fx.project, 'scratch', 'n', 'a.md');
    let r = fx.hook('pre-tool-use.mjs', { session_id: sid, tool_name: 'Write', tool_input: { file_path: path.join(pad(sid), 'n', 'a.md'), content: 'x' } }, tmp);
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(r.json));
    assert.deepEqual(r.json.hookSpecificOutput.updatedInput, { file_path: into, content: 'x' });
    // Read is not in the PreToolUse matcher: the model learns the new path from this note (pilot pilot-0236-a).
    assert.ok(r.json.hookSpecificOutput.additionalContext?.includes(into.split(path.sep).join('/')), JSON.stringify(r.json));
    fs.mkdirSync(path.dirname(into), { recursive: true });
    fs.writeFileSync(into, 'x');
    r = fx.hook('pre-tool-use.mjs', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: path.join(pad(sid), 'n', 'a.md'), old_string: 'x', new_string: 'y' } }, tmp);
    assert.equal(r.json.hookSpecificOutput?.updatedInput?.file_path, into, JSON.stringify(r.json));
    r = fx.hook('pre-tool-use.mjs', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: path.join(pad(sid), 'none.md'), old_string: 'x', new_string: 'y' } }, tmp);
    assert.equal(r.json.hookSpecificOutput?.updatedInput, undefined, 'a file in neither place is not redirected');
    const other = '9a8b7c6d-1111-4222-8333-944455556666';
    r = fx.hook('pre-tool-use.mjs', { session_id: sid, tool_name: 'Write', tool_input: { file_path: path.join(pad(other), 'b.md'), content: 'x' } }, tmp);
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

// Regression 2026-11-03: a recursive chown/chmod over the project or home.
test('recursive chown/chmod asks, also inside sudo bash -c; absolute scratch paths pass', () => {
  const s = '/p/scratch';
  assert.ok(recursiveModeChange(`sudo bash -c 'sed -i s/a/b/ .git/config\nchown -R u:u .'`, '/srv/x', s));
  assert.ok(recursiveModeChange('chmod -R 755 ~/agenti', '/srv/x', s));
  assert.ok(recursiveModeChange('sudo chown --recursive u:u /srv/u', '/', s));
  assert.ok(recursiveModeChange('cd /p/scratch && chown -R u .', '/', s));
  assert.equal(recursiveModeChange('chown u:u /srv/u/.git/config', '/', s), null, 'one file is not recursive');
  assert.equal(recursiveModeChange('chmod -R u+w /p/scratch/clone', '/', s), null);
  assert.equal(recursiveModeChange('grep -R chown src', '/', s), null);
  // alice 2026-11-12: a brief written by a heredoc named `chmod -R` and the operator had to approve it
  assert.equal(recursiveModeChange("cat > t.txt <<'EOF'\nnapr. chmod -R v scratch\nEOF\nls", '/', s), null, 'data heredoc is no command');
  assert.equal(recursiveModeChange('git commit -m "ask on chmod -R 755 ."', '/', s), null, 'quoted message is no command');
  assert.ok(recursiveModeChange("bash <<'EOF'\nchmod -R 755 /srv\nEOF", '/', s), 'heredoc given to a shell runs');
});

// P-061: an agent that waits arms a waker; foreground waiting is denied (Bob 2026-11-01 waited on the operator).
test('P-061: foregroundWait: sleeps, loops and watch in the foreground; data and short pauses pass', () => {
  assert.equal(foregroundWait('sleep 30'), 'sleep 30');
  assert.equal(foregroundWait('sleep 2m && ls'), 'sleep 2m');
  assert.equal(foregroundWait('until [ -s f ]; do sleep 5; done'), 'loop with sleep');
  assert.equal(foregroundWait('watch -n 5 ls'), 'watch');
  assert.equal(foregroundWait("bash -c 'sleep 60'"), 'sleep 60');
  assert.equal(foregroundWait('sleep 3; ls'), null);
  assert.equal(foregroundWait("comms send --text 'sleep 60 is bad'"), null);
  assert.equal(foregroundWait('cat <<EOF\nsleep 99\nEOF'), null);
});

test('P-061: foregroundWait: a loop sent to the background with & or bounded by timeout N (N <= 10 s) is not waiting; the real wait stays denied', () => {
  // allowed shapes (audit 2.5 b: 4 of 20 denials in the logs)
  assert.equal(foregroundWait("nohup bash -c 'while true; do node bin/wake.mjs run --instance pilot; sleep 2; done' >> log 2>&1 &"), null);
  assert.equal(foregroundWait('(while true; do node w.mjs; sleep 2; done >> pilot-wake.log 2>&1 &) ; echo started'), null);
  assert.equal(foregroundWait("timeout 8 sh -c 'until grep -q released f; do sleep 1; done'"), null);
  assert.equal(foregroundWait("timeout 10s bash -c 'while true; do sleep 1; done'"), null);
  // real waiting stays denied
  assert.equal(foregroundWait("timeout 60 sh -c 'until grep -q released f; do sleep 1; done'"), 'loop with sleep');
  assert.equal(foregroundWait('while true; do sleep 2; done && echo ok'), 'loop with sleep');
  assert.equal(foregroundWait('while true; do sleep 2; done; ls &'), 'loop with sleep');
  assert.equal(foregroundWait('until [ -s f ]; do sleep 5; done; while true; do sleep 2; done &'), 'loop with sleep');
});

test('P-061: pre-tool-use denies a foreground wait, allows it in the background', () => {
  const fx = setup();
  try {
    const hook = (tool_input) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input }).json;
    const deny = hook({ command: 'until [ -s /tmp/x ]; do sleep 30; done' });
    assert.equal(deny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /P-061/);
    assert.notEqual(hook({ command: 'until [ -s /tmp/x ]; do sleep 30; done', run_in_background: true }).hookSpecificOutput?.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

// agentic-flow-public#15: `git add -f .claude/skills` staged the ignored .workflow-generated.json; a forced add names files.
test('git add -f of a folder with ignored files is denied, a named file and a plain add pass', () => {
  const fx = setup();
  try {
    const p = fx.project;
    if (!fs.existsSync(path.join(p, '.git'))) spawnSync('git', ['init', '-q'], { cwd: p });
    const skills = path.join(p, '.claude', 'skills');
    fs.mkdirSync(path.join(skills, 'a'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'a', 'SKILL.md'), 'x\n');
    fs.writeFileSync(path.join(skills, '.workflow-generated.json'), '{}\n');
    fs.appendFileSync(path.join(p, '.gitignore'), '\n.claude/skills/.workflow-generated.json\n');
    const run = (command) => fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    for (const c of ['git add -f .claude/skills', `git -C ${p} add --force .claude`, 'git add .claude && git add -f .claude/skills']) {
      const r = run(c);
      assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny', `${c}: ${r.stderr}`);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /adds ignored files too \(\.claude\/skills\/\.workflow-generated\.json\)/);
    }
    for (const c of ['git add .claude/skills', 'git add -f .claude/skills/a/SKILL.md']) {
      assert.doesNotMatch(JSON.stringify(run(c).json || {}), /adds ignored files/, c);
    }
  } finally { fx.cleanup(); }
});

// Issue #28: Git Bash on Windows gives /d/<projekt>/... ; the write check must see D:/... (P-052).
test('P-052: Git Bash /<drive>/ paths become <DRIVE>:/ on win32 only', () => {
  assert.equal(gitBashPath('/d/proj/scratch/x.md', 'win32'), 'D:/proj/scratch/x.md');
  assert.equal(gitBashPath('/c', 'win32'), 'C:/');
  assert.equal(gitBashPath('/d/proj/scratch/x.md', 'linux'), '/d/proj/scratch/x.md', 'a POSIX path is unchanged off Windows');
  assert.equal(gitBashPath('/home/u/x', 'win32'), '/home/u/x', 'a longer first segment is not a drive');
  assert.equal(gitBashPath('D:\\proj\\x', 'win32'), 'D:\\proj\\x');
});

test('P-052: a Git Bash scratch path resolves inside the project scratch on win32', () => {
  const abs = path.win32.resolve('C:\\Users\\u\\cwd', gitBashPath('/d/proj/scratch/x.md', 'win32'));
  assert.equal(abs, 'D:\\proj\\scratch\\x.md');
});

test('P-052: a Bash write to a Git Bash /d/ path is checked as D:/ on win32 (shellWriteTargets, bashTargets)', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const w = shellWriteTargets('echo x > /d/proj/scratch/a.md', 'D:/proj').map((t) => t.path);
    assert.ok(w.some((p) => p.includes('D:/proj/scratch/a.md')), JSON.stringify(w));
    assert.ok(!w.some((p) => p.startsWith('/d/')), 'no Git Bash form left');
  } finally { Object.defineProperty(process, 'platform', real); }
});

// Claude Code's built-in privacy check asks the operator when a shell or web call holds the account email next to a
// network word; the workflow tells the agent first, once per identical call (2026-11-04).
test('account email: the account email next to a network word is flagged like the built-in check', () => {
  assert.equal(accountEmailCall('Bash', { command: `printf 'To: ${MAIL}' | ssh -T r@x` }, MAIL), true);
  assert.equal(accountEmailCall('Bash', { command: `cat > a.py <<'EOF'\nH="http://127.0.0.1"\nTO="Owner@Example.test"\nEOF` }, MAIL), true);
  assert.equal(accountEmailCall('WebFetch', { url: `https://x.test/?m=owner%40example.test` }, MAIL), true);
  assert.equal(accountEmailCall('Bash', { command: `sed -i 's/${MAIL}/x/' a.txt` }, MAIL), false, 'no network word');
  assert.equal(accountEmailCall('Bash', { command: 'ssh r@x uptime' }, MAIL), false, 'no email');
  assert.equal(accountEmailCall('Write', { file_path: 'a.py', content: `H="https://x"\n${MAIL}` }, MAIL), false, 'Write is not checked');
  assert.equal(accountEmailCall('Bash', { command: `ssh r@x ${MAIL}` }, ''), false, 'no signed-in email');
});

test('account email: the hook denies the first call and lets the same call through on retry', () => {
  const fx = setup();
  try {
    const cfg = path.join(fx.root, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: MAIL } }));
    const call = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -d 'to=${MAIL}' http://127.0.0.1:9/x` } };
    const first = fx.hook('pre-tool-use.mjs', call, { env: { CLAUDE_CONFIG_DIR: cfg } });
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny', first.stderr);
    assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /account email/);
    const again = fx.hook('pre-tool-use.mjs', call, { env: { CLAUDE_CONFIG_DIR: cfg } });
    assert.doesNotMatch(JSON.stringify(again.json), /account email/);
  } finally { fx.cleanup(); }
});

// Audit "false approvals" 2026-11-12 (heredoc part): quoted text and heredoc bodies are data unless a shell gets them.
test('executedText: quoted text after a script runner or wrapper is data, a shell behind a wrapper still runs it', () => {
  const s = '/p/scratch';
  const ask = ['git reset --hard', 'git push --force'];
  const hist = (c) => historyOperation(executedText(c).replace(/\s+/g, ' '), ask);
  // data: alice 2026-11-12 09:37, sh prove-commit.sh ... -m "...chmod -R ... sudo bash -c ..." asked the operator
  assert.equal(recursiveModeChange('sh .claude/skills/fix/prove-commit.sh ../flow t.mjs -m "fix: chmod -R 755 text"', '/', s), null);
  assert.equal(recursiveModeChange("bash scratch/s.sh --x 'chown -R u .'", '/', s), null);
  assert.equal(recursiveModeChange('sudo git commit -m "chmod -R 755 x"', '/', s), null);
  assert.equal(hist('env A=1 git commit -m "git reset --hard"'), null);
  assert.equal(hist('nohup node x.mjs --text "git push --force" &'), null);
  assert.equal(hist('time node x.mjs "git reset --hard"'), null);
  assert.equal(hist('ls | xargs echo "git reset --hard"'), null);
  assert.equal(hist("bash scripts/run.sh <<'EOF'\ngit reset --hard is text\nEOF"), null, 'script reads the body as data');
  assert.equal(hist("sudo tee /etc/x <<'EOF'\ngit reset --hard\nEOF"), null);
  // delimiter with - or .: still a data heredoc
  assert.equal(hist("cat > f <<'END-OF-TEXT'\ngit reset --hard\nEND-OF-TEXT"), null);
  assert.equal(recursiveModeChange("cat > f <<'EOF.md'\nchmod -R 777 /srv\nEOF.md", '/', s), null);
  // executed: a shell behind a wrapper, keyword or assignment
  assert.ok(recursiveModeChange('timeout 5 bash -c "chmod -R 777 /srv"', '/', s));
  assert.ok(recursiveModeChange("nice -n 5 bash -c 'chmod -R 777 /srv'", '/', s));
  assert.ok(recursiveModeChange("if true; then bash -c 'chmod -R 777 /srv'; fi", '/', s));
  assert.ok(recursiveModeChange("ls | xargs -I{} sh -c 'chmod -R 777 /srv'", '/', s));
  assert.ok(recursiveModeChange("X=1 bash <<'EOF'\nchmod -R 777 /srv\nEOF", '/', s));
  assert.ok(recursiveModeChange("timeout 5 bash <<'EOF'\nchmod -R 777 /srv\nEOF", '/', s));
  assert.ok(hist('sudo sh -c "git reset --hard"'));
  assert.ok(hist("ssh host <<EOF\ngit reset --hard\nEOF"));
  assert.ok(hist("cat <<EOF | bash\ngit reset --hard\nEOF"), 'a body piped into a shell runs');
});

test('runsText: shell with -c or stdin, ssh/eval, behind wrappers; not a script file', () => {
  assert.equal(runsText(['sh', 'run.sh', '-m', 'Q']), false);
  assert.equal(runsText(['bash', '-c', 'Q']), true);
  assert.equal(runsText(['bash', '-lc', 'Q']), true);
  assert.equal(runsText(['bash', '-']), true);
  assert.equal(runsText(['timeout', '5', 'sh', '-c', 'Q']), true);
  assert.equal(runsText(['ssh', 'host']), true);
  assert.equal(runsText(['git', 'commit', '-m', 'Q']), false);
  // a wrapper option with a value does not hide the shell behind it
  assert.equal(runsText(['sudo', '-u', 'root', 'bash', '-c', 'Q']), true);
  assert.equal(runsText(['timeout', '-s', 'KILL', '5', 'sh', '-c', 'Q']), true);
  assert.equal(runsText(['sudo', '-u', 'root', 'git', 'commit', '-m', 'Q']), false);
  assert.ok(withoutDataHeredocs("bash <<'EOF'\nx\nEOF").includes('x'));
  assert.ok(!withoutDataHeredocs("cat > f <<'EOF'\nx\nEOF").includes('x'));
});

test('P-061: foregroundWait: the words watch/until/while in other words, escaped backticks and a dry run are no wait', () => {
  assert.equal(foregroundWait('for f in post-tool-watch reminder-handover; do echo $f; done'), null, 'post-tool-watch is a name');
  assert.equal(foregroundWait('git log --oneline -- hooks/post-tool-watch.mjs'), null);
  assert.equal(foregroundWait('git log --until=2026-11-01 --oneline | head -3; sleep 2'), null, '--until is an option');
  assert.equal(foregroundWait('claude send "run \\`sleep 120\\` now"'), null, 'escaped backticks are text');
  assert.equal(foregroundWait('grep -c "sleep 60" f'), null, '-c of grep is no shell');
  assert.equal(foregroundWait('git commit -c HEAD -m "sleep 60"'), null);
  assert.equal(foregroundWait("cat > f <<'END-OF'\nsleep 60\nEND-OF"), null);
  assert.equal(foregroundWait('watch ls'), 'watch');
  assert.equal(foregroundWait('echo "x `sleep 60`"'), 'sleep 60', 'a real command substitution stays');
  assert.equal(foregroundWait("bash <<'EOF'\nsleep 60\nEOF"), 'sleep 60', 'heredoc given to a shell runs');
  assert.equal(foregroundWait("ssh host <<EOF\nsleep 60\nEOF"), 'sleep 60');
  assert.equal(foregroundWait('ok=1; while true; do sleep 2; done'), 'loop with sleep');
});

test('forcedAddIgnored: a dry run (-n) of git add -f touches nothing and does not deny', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'sk'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, '.gitignore'), 'sk/ig.txt\n');
    fs.writeFileSync(path.join(fx.project, 'sk/ig.txt'), 'x');
    fs.writeFileSync(path.join(fx.project, 'sk/ok.txt'), 'x');
    assert.ok(forcedAddIgnored('git add -f sk', fx.project), 'control: forced add of a folder with ignored files denies');
    assert.equal(forcedAddIgnored('git add -n -f sk', fx.project), null);
    assert.equal(forcedAddIgnored('git add --dry-run --force sk', fx.project), null);
  } finally { fx.cleanup(); }
});

// Audit "false approvals" 2026-11-12 (truth part): `git tag --sort=-creatordate | head -3` in a foreign topic_owned repo was denied as a change.
test('git tag listing and stash list are no repository change (topic_owned false deny)', () => {
  const cwd = '/x/repo';
  assert.deepEqual(gitWriteDirs('git tag --sort=-creatordate | head -3', cwd), []);
  assert.deepEqual(gitWriteDirs('git tag -l "v0.*"', cwd), []);
  assert.deepEqual(gitWriteDirs('git tag', cwd), []);
  assert.deepEqual(gitWriteDirs('git stash list', cwd), []);
  assert.deepEqual(gitWriteDirs('git tag v1.0.0', cwd), [cwd]);
  assert.deepEqual(gitWriteDirs('git tag -d v1.0.0', cwd), [cwd]);
  assert.deepEqual(gitWriteDirs('git stash', cwd), [cwd]);
  assert.deepEqual(gitWriteDirs('git tag -l --sort=x && git commit -m a', cwd), [cwd]);
});

// Audit "false approvals" 2026-11-12 (P-018 part): `git clean -nd` (a dry run in a flag cluster) asked as a history rewrite.
test('a dry-run git clean in a flag cluster is no history rewrite (P-018)', () => {
  const asks = ['git reset --hard', 'git clean', 'git push --force', 'git branch -D'];
  const except = ['git restore --staged', 'git clean -n', 'git clean --dry-run'];
  const op = (c) => historyOperation(executedText(c).replace(/\s+/g, ' '), asks, except);
  for (const c of ['git clean -nd', 'git clean -ndx', 'git clean -dn', 'git clean -n -d', 'git clean --dry-run -d']) assert.equal(op(c), null, c);
  for (const c of ['git clean -fd', 'git clean -d', 'git clean -nd && git clean -fd']) assert.ok(op(c), c);
});

// Audit 2026-11-12 (P-018 part): a heredoc body with a delimiter like END-X or a comment held commands and redirects that were not there.
test('heredoc bodies with any delimiter and comments are no commands or redirects (P-018)', () => {
  for (const delim of ["'END-X'", "'EOF'", '"E_1"', '\\EOF', "'a.b'"]) {
    const bare = delim.replace(/['"\\]/g, '');
    const cmd = `cat > note.txt <<${delim}\nrm a b c d e f\necho z > victim\n${bare}\nls`;
    assert.deepEqual(bashTargets(cmd, '/w'), ['/w/note.txt'], delim);
  }
  assert.deepEqual(bashTargets('cat <<< "x" > out.txt', '/w'), ['/w/out.txt']);
  assert.deepEqual(bashTargets("ls # then rm a > b\necho don't\nrm c", '/w'), ['/w/c']);
  assert.equal(maskShell("echo 'a # b' # c").trim(), "echo 'a\u0005#\u0005b'");
});

// Audit 2026-11-12 (P-018 part): `rm -f x 2> /dev/null`, `cp -t dst a b`, `>>` and one file named six times asked as an overwrite of many files.
test('redirect operands, -t, appends and repeated targets are no overwrites of many files (P-018)', () => {
  assert.deepEqual(bashTargets('rm -f x 2> /dev/null', '/w'), ['/w/x']);
  assert.deepEqual(bashTargets('rm -f x > /dev/null', '/w'), ['/w/x']);
  assert.deepEqual(bashTargets('cp -t dst a b', '/w'), ['/w/dst/a', '/w/dst/b']);
  assert.deepEqual(bashTargets('cp --target-directory=dst a b', '/w'), ['/w/dst/a', '/w/dst/b']);
  assert.deepEqual(bashTargets('mv -t dst a b', '/w').filter((t) => t.includes('/dst/')), ['/w/dst/a', '/w/dst/b']);
  assert.deepEqual(bashTargets('cp -a src/. dst/', '/w'), []);
  assert.deepEqual(bashTargets('echo 1 >> log; echo 2 > out', '/w', { skipAppend: true }), ['/w/out']);
  const fx = setup();
  try {
    for (const f of ['u1', 'u2', 'u3', 'u4']) fs.writeFileSync(path.join(fx.project, f), 'x\n');
    fs.mkdirSync(path.join(fx.project, 'dst'));
    const decision = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }).json.hookSpecificOutput?.permissionDecision;
    // appending to a file the thread did not make loses nothing; one file named six times is one file
    assert.notEqual(decision('echo more >> u1'), 'ask');
    assert.notEqual(decision('echo 1 >> u2; echo 2 >> u2; echo 3 >> u2; echo 4 >> u2; echo 5 >> u2; echo 6 >> u2'), 'ask');
    assert.notEqual(decision('cp -t dst README.md u3'), 'ask');
    assert.notEqual(decision('rm -f nothere 2> /dev/null'), 'ask');
    assert.notEqual(decision('cp -a src/. dst/'), 'ask');
    // the cleanup of what the thread made with mkdir, touch and tee is its own
    assert.notEqual(decision('mkdir -p made/sub && touch made/sub/f && touch t1'), 'ask');
    fs.mkdirSync(path.join(fx.project, 'made', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'made', 'sub', 'f'), '');
    fs.writeFileSync(path.join(fx.project, 't1'), '');
    assert.notEqual(decision('rm -rf made'), 'ask');
    assert.notEqual(decision('rm t1'), 'ask');
    // overwriting a file the thread did not make still asks
    assert.equal(decision('echo new > u4'), 'ask');
    assert.equal(decision('rm u3'), 'ask');
  } finally { fx.cleanup(); }
});

const W = (c) => shellWriteTargets(c, '/w', { HOME: '/h' }).map((t) => t.path);

// Audit "false approvals" 2026-11-12 (write part): a heredoc with delimiter END-OF-BRIEF, '.' or \EOF was not removed and `cp a /tmp/b` in its text asked about /tmp.
test('text in a heredoc with any delimiter is no command or path', () => {
  assert.deepEqual(W("cat <<'END-OF-BRIEF'\ncp a /tmp/b\ntee /tmp/z\nEND-OF-BRIEF"), []);
  assert.deepEqual(W("cat > /w/f <<'.'\ncp a /tmp/b\n."), ['/w/f']);
  assert.deepEqual(W('cat > /w/f <<\\EOF\ncp a /tmp/b\nEOF'), ['/w/f']);
  assert.deepEqual(W('cat > /w/f <<"EOF 2"\ntee /tmp/b\nEOF 2'), ['/w/f']);
  assert.equal(stripHeredocs('cat <<< "x" > f'), 'cat <<< "x" > f');
});

// Audit 2026-11-12 (write part): `git commit -m x # note > /tmp/x` took the comment for a redirect to /tmp/x.
test('a shell comment is no command', () => {
  assert.deepEqual(W('git commit -m x # note > /tmp/x'), []);
  assert.deepEqual(W('ls # rm /tmp/x'), []);
  assert.ok(!maskShell('ls # rm /tmp/x').includes('/tmp/x'));
});

// Audit 2026-11-12 (write part): `grep -- --output /etc`, `tar -czf a -C /etc`, `touch -r /etc/hosts f`, `mktemp -u`, `curl -o -` and `tee >(cmd)` asked about a write outside the project.
test('options of read-only commands are data, not output files', () => {
  for (const c of [
    'grep -rn -- "--output" /etc/x', 'grep -rn -e "--log-file" /etc/nginx', 'echo --output /etc/x', 'ls -o /etc',
    'rg -n -- --prefix /usr/local/lib/x', 'tar -czf /w/a.tgz -C /etc ssh', 'tar -tf a.tar -C /srv', 'unzip -l a.zip -d /srv',
    'git archive --prefix=/x/ -o /w/a.tar HEAD', 'npm ls --prefix /usr/local', 'npm run test --prefix /srv/x', 'rsync -o /etc/hosts ./h',
    'touch -r /etc/hosts /w/f', 'touch -d "2020-01-01" /w/f', 'mktemp -u', 'curl -sS -o - https://x', 'sshfs -o ro,reconnect h:/d /w/m',
    'cat f | tee >(wc -l) > /dev/null', 'sed -nE "s/a/b/p" /etc/hosts',
  ]) assert.deepEqual(W(c).filter((p) => !p.startsWith('/w/')), [], c);
});

// Audit 2026-11-12 (write part): `timeout 5 curl -o /srv/x` and `sudo -u root cp a /etc/b` hid the real program from the write check; `timeout 5 ls -o /etc` asked as a write.
test('wrapped programs are looked through', () => {
  assert.deepEqual(W('timeout 5 curl -o /srv/x https://x'), ['/srv/x']);
  assert.deepEqual(W('sudo -u root cp a /etc/b'), ['/etc/b']);
  assert.deepEqual(W('env -u X cp a /etc/b'), ['/etc/b']);
  assert.deepEqual(W('xargs -I{} cp {} /etc/'), ['/etc']);
  assert.deepEqual(W('timeout 5 ls -o /etc'), []);
});

// Audit 2026-11-12 (write part): control for the above, real writes still count as targets.
test('real writes stay targets', () => {
  assert.deepEqual(W('tar -xf a.tar -C /srv/x'), ['/srv/x']);
  assert.deepEqual(W('unzip a.zip -d /srv/x'), ['/srv/x']);
  assert.deepEqual(W('npm install --prefix /srv/x'), ['/srv/x']);
  assert.deepEqual(W('mktemp /srv/x.XXXXXX'), ['/srv/x.XXXXXX']);
  assert.deepEqual(W('sort -o /srv/out in'), ['/srv/out']);
  assert.deepEqual(W('curl -o /srv/out https://x'), ['/srv/out']);
});

// Audit 2026-11-12 (write part): `perl -MFile::Basename -e ... /etc/hosts` asked as an in-place edit (-M is a module, not -i).
test('perl -M is a module, not an in-place edit', () => {
  assert.deepEqual(inPlaceEdits(['perl', '-MFile::Basename', '-e', 'print 1', '/etc/hosts']), []);
  assert.deepEqual(inPlaceEdits(['perl', '-Mstrict', '-ne', 'print', '/etc/hosts']), []);
  assert.deepEqual(inPlaceEdits(['perl', '-pi', '-e', 's/a/b/', '/etc/hosts']), ['/etc/hosts']);
  assert.deepEqual(inPlaceEdits(['sed', '-i', 's/a/b/', '/etc/hosts']), ['/etc/hosts']);
});

// Audit 2026-11-12 (other part): skarper 2026-11-10, `rm docs/firma/x.md && rmdir docs/firma docs` asked because rmdir counted as a removal of content.
test('rmdir of a folder holding an untracked file asks nothing (it cannot remove content); rm of the file still asks', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'docs', 'firma'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'docs', 'firma', 'a.md'), 'x\n');
    const ask = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }).json.hookSpecificOutput?.permissionDecision;
    assert.equal(ask('rmdir docs/firma docs'), undefined);
    assert.equal(ask('rm docs/firma/a.md'), 'ask', 'a foreign untracked file still asks');
    assert.equal(ask('rm -r docs && rmdir docs'), 'ask');
  } finally { fx.cleanup(); }
});

// Audit 2026-11-12 (other part): `export TMPDIR=scratch/tmp; mkdir -p $TMPDIR` asked as a write into the system /tmp, because
// expandTemp replaced $TMPDIR before the assignment in the same command was applied.
test('$TMPDIR assigned in the same command is that value, not the system temp dir', () => {
  const W2 = (c) => shellWriteTargets(c, '/w', { HOME: '/h' }).map((t) => t.path);
  assert.deepEqual(W2('export TMPDIR=/w/scratch/t; mkdir -p $TMPDIR'), ['/w/scratch/t']);
  assert.deepEqual(W2('TMP=scratch/t && mkdir -p ${TMP}/a'), ['/w/scratch/t/a']);
  assert.deepEqual(W2('mkdir -p $TMPDIR/a'), [path.join(os.tmpdir(), 'a')], 'control: an unassigned $TMPDIR is still the system temp dir');
  assert.deepEqual(W2('export TMPDIR=/w/s; mkdir -p $TEMP/a'), [path.join(os.tmpdir(), 'a')], 'only the variable assigned is replaced');
});
