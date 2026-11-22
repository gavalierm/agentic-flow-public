// keep: core
// P-013, P-018, P-025, P-031: PreToolUse hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { accountEmailCall, bashTargets, executedText, forcedAddIgnored, foregroundWait, gitBashPath, gitWriteDirs, historyOperation, maskShell, recursiveModeChange, stripHeredocs, shellWriteTargets } from '../hooks/pre-tool-use.mjs';
import { analyze, namesPath, runsText, withoutDataHeredocs } from '../scripts/bypass.mjs';
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
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /notes\.md is untracked/);
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'n.md'), 'x\n');
    fs.appendFileSync(path.join(fx.project, '.gitignore'), 'local/\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm local/n.md' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
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
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /removing 59 of 101 lines/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'line 1\nline 2', new_string: 'x' } });
    assert.deepEqual(r.json, {});
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    for (const f of 'abcdef') fs.writeFileSync(path.join(fx.project, f), 'x\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm a b c d e f' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /6 files/);
    // Own work files, files the command creates and missing ones are not counted (audit M2 2026-11-11).
    fs.mkdirSync(path.join(fx.project, 'scratch', 'wt'), { recursive: true });
    for (const f of 'abcdef') fs.writeFileSync(path.join(fx.project, 'scratch', 'wt', f), 'x\n');
    for (const command of ['rm scratch/wt/a scratch/wt/b scratch/wt/c scratch/wt/d scratch/wt/e scratch/wt/f', 'echo 1 > n1; echo 2 > n2; echo 3 > n3; echo 4 > n4; echo 5 > n5; echo 6 > n6', 'rm -f g1 g2 g3 g4 g5 g6']) {
      r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.notEqual(r.json.hookSpecificOutput?.permissionDecision, 'deny', command);
    }
  } finally { fx.cleanup(); }
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
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    // A stray file a shell redirect of this thread created (e.g. `> 0`) is cleaned up without confirmation.
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'echo x > 0' } });
    assert.deepEqual(r.json, {});
    fs.writeFileSync(path.join(fx.project, '0'), 'x\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm 0' } });
    assert.deepEqual(r.json, {}, 'own stray file deleted');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm foreign.md' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', 'foreign untracked still asks');
  } finally { fx.cleanup(); }
});

// Regression 2026-11-03: a recursive chown/chmod over the project or home.
// P-061: an agent that waits arms a waker; foreground waiting is denied (Bob 2026-11-01 waited on the operator).
// Bug 2026-11-15 (v1.7.0): `error.mjs watch` (prints the issue answers that did not ring) was denied as watch(1);
// the word is a wait only as a command, `gh run watch`, `tail -f` or a --watch flag.
test('foreground wait: real waits only', () => {
  for (const c of ['node /h/.claude/skills/workflow/bin/error.mjs watch 2>&1 | head -10', 'node bin/error.mjs watch', 'node bin/issues.mjs list', 'node bin/comms.mjs list', 'tail -n 20 log.txt', 'tail -n 3 x; grep -f pats y', 'grep -n watch hooks/x.mjs']) {
    assert.equal(foregroundWait(c), null, c);
  }
  for (const c of ['watch -n 5 ls', 'watch ls', 'sudo watch -n 1 df', 'cd x && watch -n 5 ls', "bash -c 'watch -n 5 ls'", 'gh run watch', 'gh run watch 123 --exit-status', 'tail -f log.txt', 'tail -n 5 -F log.txt', 'tail --follow=name log.txt', 'kubectl get pods --watch', 'tsc --watch', 'gh pr checks 12 --watch', 'until test -f x; do sleep 1; done', 'while true; do ls; sleep 5; done', 'sleep 60']) {
    assert.ok(foregroundWait(c), c);
  }
});
// agentic-flow-public#15: `git add -f .claude/skills` staged the ignored .workflow-generated.json; a forced add names files.
// Issue #28: Git Bash on Windows gives /d/<projekt>/... ; the write check must see D:/... (P-052).
// Claude Code's built-in privacy check asks the operator when a shell or web call holds the account email next to a
// network word; the workflow tells the agent first, once per identical call (2026-11-04).
// Audit "false approvals" 2026-11-12 (heredoc part): quoted text and heredoc bodies are data unless a shell gets them.
// alice 2026-11-12: a write inside text given to a local shell was no write (`bash -c 'echo x > /etc/x'`, `bash <<EOF` into /etc)
// Audit "false approvals" 2026-11-12 (truth part): `git tag --sort=-creatordate | head -3` was denied as a change.
// Audit "false approvals" 2026-11-12 (P-018 part): `git clean -nd` (a dry run in a flag cluster) asked as a history rewrite.
// Audit 2026-11-12 (P-018 part): a heredoc body with a delimiter like END-X or a comment held commands and redirects that were not there.
// Audit 2026-11-12 (P-018 part): `rm -f x 2> /dev/null`, `cp -t dst a b`, `>>` and one file named six times asked as an overwrite of many files.
const W = (c) => shellWriteTargets(c, '/w', { HOME: '/h' }).map((t) => t.path);

// Audit "false approvals" 2026-11-12 (write part): a heredoc with delimiter END-OF-BRIEF, '.' or \EOF was not removed and `cp a /tmp/b` in its text asked about /tmp.
// Audit 2026-11-12 (write part): `git commit -m x # note > /tmp/x` took the comment for a redirect to /tmp/x.
// Audit 2026-11-12 (write part): `grep -- --output /etc`, `tar -czf a -C /etc`, `touch -r /etc/hosts f`, `mktemp -u`, `curl -o -` and `tee >(cmd)` asked about a write outside the project.
// Audit 2026-11-12 (write part): `timeout 5 curl -o /srv/x` and `sudo -u root cp a /etc/b` hid the real program from the write check; `timeout 5 ls -o /etc` asked as a write.
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
// Audit 2026-11-12 (other part): skarper 2026-11-10, `rm docs/firma/x.md && rmdir docs/firma docs` asked because rmdir counted as a removal of content.
// Audit 2026-11-12 (other part): `export TMPDIR=scratch/tmp; mkdir -p $TMPDIR` asked as a write into the system /tmp, because
// expandTemp replaced $TMPDIR before the assignment in the same command was applied.

test('BSD sed -i "" is judged by its file, a sed script is no path, an answer names targets written with ~ and *', () => {
  // carol 2026-11-22 (macOS): the empty suffix word was read as the session folder (a "shell write into brain"), the
  // script as a path, and the lock stayed after the operator allowed the targets in a dialog.
  const home = os.homedir();
  const cwd = os.tmpdir();
  assert.deepEqual(inPlaceEdits(['sed', '-i', '""', '-e', '/^#x$/d', '~/.zshrc']), ['~/.zshrc']);
  assert.deepEqual(analyze('Bash', { command: 'sed -i "" -e "/^# Added by X$/d" ~/.zshrc' }, cwd).paths, [path.join(home, '.zshrc')]);
  const q = 'Povoliť ciele ~/.zshrc, ~/.gemini* a "~/Library/App Support/X"?\nÁno, povoľ';
  assert.ok(namesPath(q, path.join(home, '.zshrc'), cwd));
  assert.ok(namesPath(q, path.join(home, '.gemini-cli', 'x.json'), cwd), 'the start before * names what begins with it');
  assert.ok(namesPath(q, path.join(home, 'Library', 'App Support', 'X', 'a.txt'), cwd), 'a quoted folder names what is in it');
  assert.ok(!namesPath(q, path.join(home, '.ssh', 'id'), cwd), 'another path stays closed');
  assert.ok(!namesPath('Povoliť všetko v ~/ a v / ?\nÁno', path.join(home, '.ssh', 'id'), cwd), 'the home folder and the root name no target');
});
