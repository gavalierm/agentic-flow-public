// P-054: a step refused in this turn is not reached another way (operator 2026-11-07: "agent at an obstacle tends to
// route around it"). Example: python3 rewrote a file after a denied sed -i (2026-11-01); git grep -- docs after a denied
// read of docs/principles (2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { analyze, bypassOf, segments, callKey, gitHookBypass, transcriptDenials, withDenial, stateDenials } from '../scripts/bypass.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bypass-')); }

test('analyze: paths a call reaches and whether it may write them', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'docs', 'principles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    const f = path.join(dir, 'a.md');
    assert.deepEqual(analyze('Bash', { command: `cat ${f}` }, dir), { paths: [f], write: false });
    assert.equal(analyze('Bash', { command: `python3 -c "open('${f}','w').write('y')" ${f}` }, dir).write, true);
    assert.equal(analyze('Bash', { command: `sed -n 1p ${f}` }, dir).write, false);
    assert.equal(analyze('Bash', { command: `sed -i s/x/y/ ${f}` }, dir).write, true);
    assert.equal(analyze('Bash', { command: `cat a.md > b.md` }, dir).write, true);
    assert.deepEqual(analyze('Bash', { command: 'git grep foo -- docs' }, dir).paths, [path.join(dir, 'docs')]);
    assert.deepEqual(analyze('Bash', { command: 'cd docs && ls principles' }, dir).paths, [path.join(dir, 'docs', 'principles')]);
    assert.deepEqual(analyze('Read', { file_path: f }, dir), { paths: [f], write: false });
    assert.deepEqual(analyze('Bash', { command: `node /opt/x/save.mjs memory k` }, dir).paths, [], 'the script a interpreter runs is the tool, not a target');
    assert.deepEqual(analyze('Bash', { command: `ls ${dir}` }, dir).paths, [], 'the working folder itself is too wide');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bypassOf: same path another way is caught; a read after a refused write is not', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'a.md');
    fs.writeFileSync(f, 'x');
    fs.mkdirSync(path.join(dir, 'docs', 'principles'), { recursive: true });
    const deniedWrite = { tool: 'Bash', input: { command: `sed -i s/x/y/ ${f}` } };
    deniedWrite.key = callKey(deniedWrite.tool, deniedWrite.input);
    const hit = bypassOf({ tool: 'Bash', toolInput: { command: `python3 -c "import sys" ${f}` }, cwd: dir, denials: [deniedWrite] });
    assert.equal(hit?.path, f);
    assert.equal(bypassOf({ tool: 'Edit', toolInput: { file_path: f, old_string: 'x', new_string: 'y' }, cwd: dir, denials: [deniedWrite] })?.path, f);
    assert.equal(bypassOf({ tool: 'Read', toolInput: { file_path: f }, cwd: dir, denials: [deniedWrite] }), null, 'reading a file whose write was refused is finding the cause');
    assert.equal(bypassOf({ tool: deniedWrite.tool, toolInput: deniedWrite.input, cwd: dir, denials: [deniedWrite] }), null, 'the same call again is decided by the same check');
    const deniedRead = { tool: 'Bash', input: { command: `cat ${f}` } };
    assert.equal(bypassOf({ tool: 'Read', toolInput: { file_path: f }, cwd: dir, denials: [deniedRead] })?.path, f);
    const deniedDocs = { tool: 'Grep', input: { pattern: 'x', path: path.join(dir, 'docs', 'principles') } };
    assert.ok(bypassOf({ tool: 'Bash', toolInput: { command: 'git grep x -- docs' }, cwd: dir, denials: [deniedDocs] }), 'the parent folder holds the refused one');
    assert.equal(bypassOf({ tool: 'Read', toolInput: { file_path: path.join(dir, 'other.md') }, cwd: dir, denials: [deniedRead] }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bypassOf: words of a quoted commit message are not paths, a separator inside quotes does not split the command', () => {
  const dir = tmp();
  try {
    const repo = path.join(dir, 'myserver');
    fs.mkdirSync(path.join(repo, 'agentic'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    assert.deepEqual(segments(`git commit -m "a; b && c | d" && echo ok; ls 'x;y'`), ['git commit -m "a; b && c | d" ', ' echo ok', " ls 'x;y'"]);
    const denied = { tool: 'Bash', key: 'k', paths: [path.join(repo, 'agentic')], write: true, reason: 'myserver/agentic/ is written only by save (P-013)' };
    // bob 2026-11-08: the commit touched only code; "; " in the message made "agentic/" a path of the refused folder.
    const commit = `cd ${repo} && git commit -qam "pre-commit: commit iba v agentic/ preskočí testy; .workflow.json knowledge_branch main\n\nCo-Authored-By: X <x@y>" && echo code-commit-ok && git push -q origin main`;
    assert.equal(bypassOf({ tool: 'Bash', toolInput: { command: commit }, cwd: dir, denials: [denied] }), null);
    const write = `cd ${repo} && mkdir -p agentic && echo test > agentic/.hooktest; git add agentic/.hooktest`;
    assert.ok(bypassOf({ tool: 'Bash', toolInput: { command: write }, cwd: dir, denials: [denied] }), 'a real write into the refused folder is still caught');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transcriptDenials: harness refusals of the current turn only', () => {
  const dir = tmp();
  try {
    const t = path.join(dir, 's.jsonl');
    const use = (id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const res = (id, text, ts) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
    const prompt = (ts) => ({ type: 'user', timestamp: ts, message: { content: 'next' } });
    const lines = [
      use('a', 'cat /x/old'), res('a', 'Permission to use Bash with command cat /x/old has been denied.', '2026-11-07T10:00:00Z'),
      prompt('2026-11-07T10:01:00Z'),
      use('b', 'cat /x/new'), res('b', 'Permission to use Bash with command cat /x/new has been denied.', '2026-11-07T10:02:00Z'),
      use('c', 'false'), res('c', 'Exit code 1', '2026-11-07T10:03:00Z'),
    ];
    fs.writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.deepEqual(transcriptDenials(t).map((d) => d.input.command), ['cat /x/new'], 'the last operator prompt bounds the turn');
    assert.deepEqual(transcriptDenials(t, '2026-11-07T09:00:00Z').map((d) => d.input.command), ['cat /x/old', 'cat /x/new']);
    assert.deepEqual(transcriptDenials(path.join(dir, 'missing.jsonl')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('thread state keeps only the denials of the current turn', () => {
  const s = withDenial({ turn_started_at: '2026-11-07T10:00:00Z', denials: [{ at: '2026-11-07T09:00:00Z', key: 'old' }] }, { key: 'new' });
  assert.deepEqual(stateDenials(s).map((d) => d.key), ['new']);
});

test('hook: a refused bulk read of docs/principles locks nothing; the refusal text keeps the operator out of the waker role (P-061)', () => {
  const fx = setup();
  try {
    const dir = path.join(fx.project, 'docs', 'principles');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['P-001.md', 'README.md']) fs.writeFileSync(path.join(dir, f), `# ${f}\n`);
    const bulk = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${dir}/*` } });
    assert.equal(bulk.json.hookSpecificOutput?.permissionDecision, 'deny', bulk.stderr);
    const edit = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md'), old_string: 'x', new_string: 'y' } });
    assert.doesNotMatch(JSON.stringify(edit.json || {}), /P-054/, 'one file is the way the guard names');
    const target = path.join(fx.brain, 'memory', 'note.md');
    fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: 'x' } });
    const around = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node -e "1" ${target}` } });
    const reason = around.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /bypass \(P-054\).*Stav: otázka.*Stav: hotovo/);
    const viaSave = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node /x/workflow/bin/save.mjs memory project note --content "$(sed -n 1p ${target})"` } });
    assert.doesNotMatch(JSON.stringify(viaSave.json || {}), /P-054/, 'save.mjs is the way the refusal names, not a bypass');
    assert.doesNotMatch(reason, /until the operator's next prompt/);
  } finally { fx.cleanup(); }
});

test('gitHookBypass: --no-verify and a changed core.hooksPath, not a read of it', () => {
  assert.equal(gitHookBypass('git -C ../brain commit --no-verify -m x'), '--no-verify');
  assert.equal(gitHookBypass('git push --no-verify origin dev'), '--no-verify');
  assert.equal(gitHookBypass('git config core.hooksPath /dev/null'), 'core.hooksPath');
  assert.equal(gitHookBypass('git -c core.hooksPath=/x commit -m y'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config --unset core.hooksPath'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath'), null);
  assert.equal(gitHookBypass('git commit -m "x"'), null);
});

test('hook: a brain write refused by Edit is not done by node -e in the same turn; the next prompt lifts it', () => {
  const fx = setup();
  try {
    const target = path.join(fx.brain, 'memory', 'note.md');
    const edit = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: 'x' } });
    assert.equal(edit.json.hookSpecificOutput?.permissionDecision, 'deny', edit.stderr);
    assert.match(edit.json.hookSpecificOutput.permissionDecisionReason, /direct write into brain/);
    const around = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${target}` } };
    const second = fx.hook('pre-tool-use.mjs', around);
    assert.equal(second.json.hookSpecificOutput?.permissionDecision, 'deny', second.stderr);
    assert.match(second.json.hookSpecificOutput.permissionDecisionReason, /bypass \(P-054\)/);
    const read = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: target } });
    assert.doesNotMatch(JSON.stringify(read.json), /P-054/, 'reading is allowed');
    fx.hook('user-prompt-submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'ok, urob to inak' });
    const after = fx.hook('pre-tool-use.mjs', around);
    assert.doesNotMatch(JSON.stringify(after.json), /P-054/, 'a new operator prompt is a new turn');
  } finally { fx.cleanup(); }
});

test('hook: harness refusal in the transcript blocks the same file through another tool', () => {
  const fx = setup();
  try {
    const f = path.join(fx.project, 'notes.txt');
    fs.writeFileSync(f, 'x');
    const t = path.join(fx.root, 's.jsonl');
    const lines = [
      { type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: `sed -n 1,5p ${f}` } }] } },
      { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: `Permission to use Bash with command sed -n 1,5p ${f} has been denied.` }] } },
    ];
    fs.writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const read = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: t, tool_input: { file_path: f } });
    assert.equal(read.json.hookSpecificOutput?.permissionDecision, 'deny', read.stderr);
    assert.match(read.json.hookSpecificOutput.permissionDecisionReason, /P-054/);
  } finally { fx.cleanup(); }
});

test('hook: settings that enforce the workflow and git past its hooks ask the operator', () => {
  const fx = setup();
  try {
    const s = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(fx.project, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' } });
    assert.equal(s.json.hookSpecificOutput?.permissionDecision, 'ask', s.stderr);
    assert.match(s.json.hookSpecificOutput.permissionDecisionReason, /enforce the workflow/);
    const g = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' } });
    assert.equal(g.json.hookSpecificOutput?.permissionDecision, 'ask', g.stderr);
  } finally { fx.cleanup(); }
});

test('hook: a write refused outside the project (P-052) locks only the outside target, not the project files of the call', () => {
  const fx = setup();
  try {
    const src = path.join(fx.project, 'src', 'a.js');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'x\n');
    const outside = path.join(os.tmpdir(), `wf-p052-${process.pid}.mjs`);
    const refused = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat > ${outside} <<'X'\nx\nX\nnode ${outside} ${src}` } });
    assert.equal(refused.json.hookSpecificOutput?.permissionDecision, 'deny', refused.stderr);
    assert.match(refused.json.hookSpecificOutput.permissionDecisionReason, /outside the project/);
    const work = path.join(fx.project, 'scratch', 'p.mjs');
    const next = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node ${work} ${src}` } });
    assert.doesNotMatch(JSON.stringify(next.json || {}), /P-054/, 'the way the refusal names (scratch/) may touch the project files');
    const again = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${outside}` } });
    assert.match(JSON.stringify(again.json || {}), /P-054|outside the project/, 'the outside target stays refused');
  } finally { fx.cleanup(); }
});
