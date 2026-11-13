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
    // a data heredoc body is text, not paths (alice 2026-11-08: "/** NIST ..." in a script being written locked scratch/)
    const doc = analyze('Bash', { command: `cat > ${f} <<'EOF'\n/** NIST curves */\nconst x = '/etc/passwd';\nEOF\nnode ${f}` }, dir);
    assert.equal(doc.write, true);
    assert.deepEqual(doc.paths, [f]);
    assert.ok(analyze('Bash', { command: `bash <<'EOF'\nrm /etc/hosts\nEOF` }, dir).paths.includes('/etc/hosts'), 'a body fed to a shell runs');
    assert.deepEqual(analyze('Bash', { command: 'git grep foo -- docs' }, dir).paths, [path.join(dir, 'docs')]);
    assert.deepEqual(analyze('Bash', { command: 'cd docs && ls principles' }, dir).paths, [path.join(dir, 'docs', 'principles')]);
    assert.deepEqual(analyze('Read', { file_path: f }, dir), { paths: [f], write: false });
    assert.deepEqual(analyze('Bash', { command: `node /opt/x/save.mjs memory k` }, dir).paths, [], 'the script a interpreter runs is the tool, not a target');
    assert.deepEqual(analyze('Bash', { command: `ls ${dir}` }, dir).paths, [], 'the working folder itself is too wide');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bypassOf: a write to the same path another way is caught; reads and refused reads lock nothing', () => {
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
    // A refused read locks nothing: one false positive of a read check locked the folder for the turn (2026-11-08).
    const deniedRead = { tool: 'Bash', input: { command: `cat ${f}` } };
    assert.equal(bypassOf({ tool: 'Read', toolInput: { file_path: f }, cwd: dir, denials: [deniedRead] }), null);
    assert.equal(bypassOf({ tool: 'Write', toolInput: { file_path: f, content: 'y' }, cwd: dir, denials: [deniedRead] }), null);
    const deniedDocs = { tool: 'Grep', input: { pattern: 'x', path: path.join(dir, 'docs', 'principles') } };
    assert.equal(bypassOf({ tool: 'Bash', toolInput: { command: 'git grep x -- docs' }, cwd: dir, denials: [deniedDocs] }), null);
    const deniedRm = { tool: 'Bash', input: { command: 'rm -r docs/principles' } };
    assert.ok(bypassOf({ tool: 'Bash', toolInput: { command: 'rm -r docs' }, cwd: dir, denials: [deniedRm] }), 'the parent folder holds the refused one');
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

test('bypassOf: a permission rule refusal locks like a hook, the operator locks reads too; own scratch/ is never locked', () => {
  const dir = tmp();
  try {
    const t = path.join(dir, 's.jsonl');
    const skill = path.join(dir, '.claude', 'skills', 'issues');
    const scratch = path.join(dir, 'scratch');
    fs.mkdirSync(skill, { recursive: true });
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(skill, 'issues.mjs'), 'x');
    const use = (id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const res = (id, source) => ({ type: 'user', timestamp: '2026-11-09T09:23:00Z', permissionDecision: { decision: 'reject', source }, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Permission to use Bash with command cp has been denied.' }] } });
    // alice 2026-11-09 09:23: the rule refused `cp <skill> scratch/`, the lock then refused Write scratch/issues.mjs and the turn asked the operator.
    const cp = `cp ${skill}/issues.mjs ${scratch}/issues.mjs`;
    fs.writeFileSync(t, [use('a', cp), res('a', 'config'), use('b', `cat ${skill}/issues.mjs`), res('b', 'user_reject')].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const [byRule, byOperator] = transcriptDenials(t, '2026-11-09T09:00:00Z');
    assert.deepEqual([byRule.rule, byRule.harness, byOperator.rule, byOperator.harness], [true, false, false, true]);
    const own = (p) => p === scratch || p.startsWith(scratch + path.sep);
    const write = { tool: 'Write', toolInput: { file_path: path.join(scratch, 'issues.mjs'), content: 'y' }, cwd: dir, own };
    assert.equal(bypassOf({ ...write, denials: [byRule] }), null, 'own scratch/ stays open');
    assert.ok(bypassOf({ ...write, own: undefined, denials: [byRule] }), 'only the own-work exception opens the refused cp target');
    const readSkill = { tool: 'Read', toolInput: { file_path: path.join(skill, 'issues.mjs') }, cwd: dir, own };
    assert.equal(bypassOf({ ...readSkill, denials: [byRule] }), null, 'the rule read a cp source as a write: reading it is no bypass');
    assert.ok(bypassOf({ tool: 'Bash', toolInput: { command: `sed -n 1p ${skill}/issues.mjs` }, cwd: dir, own, denials: [byOperator] }), 'the operator refused the read: reading it another way is');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('thread state keeps only the denials of the current turn', () => {
  const s = withDenial({ turn_started_at: '2026-11-07T10:00:00Z', denials: [{ at: '2026-11-07T09:00:00Z', key: 'old' }] }, { key: 'new' });
  assert.deepEqual(stateDenials(s).map((d) => d.key), ['new']);
});

test('hook: a bulk read of docs/principles is a hint and locks nothing; the refusal text keeps the operator out of the waker role (P-061)', () => {
  const fx = setup();
  try {
    const dir = path.join(fx.project, 'docs', 'principles');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['P-001.md', 'README.md']) fs.writeFileSync(path.join(dir, f), `# ${f}\n`);
    const bulk = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${dir}/*` } });
    assert.equal(bulk.json.hookSpecificOutput?.permissionDecision, undefined, bulk.stderr);
    assert.match(bulk.json.hookSpecificOutput?.additionalContext || '', /one principle at a time/, 'the bulk read is a hint, not a deny (2026-11-08)');
    const edit = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md'), old_string: 'x', new_string: 'y' } });
    assert.doesNotMatch(JSON.stringify(edit.json || {}), /P-054/, 'one file is the way the guard names');
    const target = path.join(fx.brain, 'memory', 'note.md');
    fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: 'x' } });
    const around = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node -e "1" ${target}` } });
    const reason = around.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /bypass \(P-054\).*with AskUserQuestion.*save handover --next.*\*\*Stav:\*\* čakám \(na nový ťah/);
    assert.doesNotMatch(reason, /end with Stav: hotovo/, 'hotovo with an undone step made bob ask the operator to write "pokračuj" (2026-11-11)');
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

// flow-public#43: the rule refused `cd <project> && mkdir -p scratch/s && cp <deployed> scratch/s/ && diff ...`, every path
// of the command counted as a refused write, and a script that read the deployed file and wrote scratch/ was locked.
test('hook: a permission rule refusal of a shell command locks what the command writes, not what it only reads (flow-public#43)', () => {
  const fx = setup();
  try {
    const dep = path.join(fx.project, 'deployed', 's', 'run.mjs');
    const copy = path.join(fx.brain, 'skills', 's', 'run.mjs');
    fs.mkdirSync(path.dirname(dep), { recursive: true });
    fs.writeFileSync(dep, 'x');
    const t = path.join(fx.root, 's.jsonl');
    const refused = (id, command, at) => [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
      { type: 'user', timestamp: at, permissionDecision: { decision: 'reject', source: 'config' }, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Permission to use Bash with command cp has been denied.' }] } },
    ];
    const start = { type: 'user', timestamp: new Date(Date.now() - 2000).toISOString(), message: { content: 'go' } };
    const toCopy = refused('u1', `cd ${fx.project} && mkdir -p scratch/s && cp ${dep} scratch/s/run.mjs && diff scratch/s/run.mjs ${copy}`, new Date(Date.now() - 1000).toISOString());
    fs.writeFileSync(t, [start, ...toCopy].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const bash = (command) => JSON.stringify(fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', transcript_path: t, tool_input: { command } }).json || {});
    const P054 = /bypass \(P-054\)/;
    assert.doesNotMatch(bash(`python3 ${fx.project}/fix.py ${dep} ${fx.project}/scratch/s/run.mjs`), P054, 'the cp source is read, the copy goes to scratch/: the way the refusal names');
    assert.doesNotMatch(bash(`cd ${fx.project} && git status && diff scratch/s/run.mjs ${copy}`), P054, 'git status and diff read');
    const back = refused('u2', `cp ${fx.project}/scratch/s/run.mjs ${dep}`, new Date().toISOString());
    fs.writeFileSync(t, [start, ...toCopy, ...back].map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.match(bash(`sed -i s/x/y/ ${dep}`), P054, 'the refused cp target written another way stays a bypass');
  } finally { fx.cleanup(); }
});

// flow-public#46: the operator refused a write in the permission dialog, then allowed it in AskUserQuestion; the target stayed
// closed until the next prompt, and after a compaction the context did not say which targets were closed.
test('hook: an operator answer in a dialog that names the refused target and allows it opens it; "Nie" and another question keep it closed, and a compaction lists it (flow-public#46)', () => {
  const run = (question, answer) => {
    const fx = setup();
    try {
      const dep = path.join(fx.project, 'deployed', 'run.mjs');
      fs.mkdirSync(path.dirname(dep), { recursive: true });
      fs.writeFileSync(dep, 'x');
      const t = path.join(fx.root, 's.jsonl');
      const lines = [
        { type: 'user', timestamp: new Date(Date.now() - 2000).toISOString(), message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: dep, content: 'y' } }] } },
        { type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] } },
      ];
      fs.writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const P054 = /bypass \(P-054\)/;
      const sed = () => P054.test(JSON.stringify(fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', transcript_path: t, tool_input: { command: `sed -i s/x/y/ ${dep}` } }).json || {}));
      const locked = sed();
      if (question) fx.hook('post-tool-use.mjs', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, options: [{ label: 'Áno' }, { label: 'Nie' }] }] }, tool_response: { answers: { [question]: answer } } });
      return { locked, after: sed(), compact: fx.hook('session-start.mjs', { source: 'compact', transcript_path: t }).context };
    } finally { fx.cleanup(); }
  };
  const allowed = run('Povolíš zápis do deployed/run.mjs?', 'Áno');
  assert.equal(allowed.locked, true, 'the refused target written another way is a bypass');
  assert.equal(allowed.after, false, 'the answer that allows the named target opens it');
  assert.doesNotMatch(allowed.compact, /refused in this turn/);
  assert.equal(run('Mám prepísať run.mjs?', 'Áno, prepíš').after, false, 'the file name names it too');
  const refused = run('Povolíš zápis do deployed/run.mjs?', 'Nie');
  assert.equal(refused.after, true, 'a refusing answer keeps it closed');
  assert.match(refused.compact, /refused in this turn \(P-054\): deployed\/run\.mjs; reaching them another way is a bypass/);
  assert.equal(run('Pokračovať vo vydaní?', 'Áno').after, true, 'a question that does not name the target keeps it closed');
});

// flow-public#47: a refused bypass quoted the earlier refusal ("has been denied") and counted as a new refusal of the operator.
test('hook: a workflow hook refusal in the transcript is no refusal of the operator: a later read of its paths is not locked (flow-public#47)', () => {
  for (const marked of [true, false]) {
    const fx = setup();
    try {
      const dep = path.join(fx.project, 'deployed', 'run.mjs');
      fs.mkdirSync(path.dirname(dep), { recursive: true });
      fs.writeFileSync(dep, 'x');
      const t = path.join(fx.root, 's.jsonl');
      const refused = { type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: `PreToolUse:Bash hook error: this call reaches ${dep}, which a Bash call refused earlier in this turn also reached (Permission to use Bash has been denied.)` }] } };
      if (marked) refused.permissionDecision = { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' };
      const lines = [
        { type: 'user', timestamp: new Date(Date.now() - 2000).toISOString(), message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: `cat ${dep}` } }] } },
        refused,
      ];
      fs.writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const why = marked ? 'permissionDecision.source hook' : 'the hook text without the marker';
      assert.deepEqual(transcriptDenials(t), [], why);
      // another read of the same path (the same call again is a retry, no bypass)
      const r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', transcript_path: t, tool_input: { command: `head -5 ${dep}` } });
      assert.doesNotMatch(JSON.stringify(r.json || {}), /bypass \(P-054\)/, why);
    } finally { fx.cleanup(); }
  }
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

test('hook: a write refused outside the project does not lock reading other targets of the call, a loop is no write (agentic-flow-public#16)', () => {
  const fx = setup();
  try {
    const skills = path.join(fx.root, 'other-brain', 'skills');
    for (const s of ['a', 'b']) { fs.mkdirSync(path.join(skills, s), { recursive: true }); fs.writeFileSync(path.join(skills, s, 'SKILL.md'), 'x\n'); }
    const out = path.join(os.tmpdir(), 'wf-p16');
    const refused = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `for s in a b; do grep -c x ${skills}/$s/SKILL.md ${skills}/a/SKILL.md > ${out}_$s.txt; done` } });
    assert.equal(refused.json.hookSpecificOutput?.permissionDecision, 'deny', refused.stderr);
    assert.match(refused.json.hookSpecificOutput.permissionDecisionReason, /outside the project/);
    const read = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cd ${skills}; for s in a b; do grep -oE 'x' $s/SKILL.md; done; grep -c x a/SKILL.md; test -e ${fx.project}` } });
    assert.doesNotMatch(JSON.stringify(read.json || {}), /P-054/, 'reading the skills the refused command also read is no bypass');
    assert.equal(analyze('Bash', { command: `for s in a b; do grep -c x ${skills}/a/SKILL.md; done` }, fx.root).write, false, 'for/do/done are shell keywords, not writing programs');
  } finally { fx.cleanup(); }
});

// Audit 2026-11-12 (other part): `git config core.hooksPath .githooks` (turns the repo hooks on) asked as a hook bypass.
test('gitHookBypass: a repo-relative core.hooksPath switches the repo hooks on, /dev/null, absolute, .. and --unset switch them off', () => {
  assert.equal(gitHookBypass('cd agent-playbook && git config core.hooksPath .githooks'), null);
  assert.equal(gitHookBypass('git config core.hooksPath .husky/_'), null);
  assert.equal(gitHookBypass('git -c core.hooksPath=.githooks commit -m y'), null);
  assert.equal(gitHookBypass('git config core.hooksPath /dev/null'), 'core.hooksPath');
  assert.equal(gitHookBypass('git -c core.hooksPath=/dev/null rm -rq bin'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath ../empty'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath hooks/../../empty'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath /tmp/none'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath ""'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config --unset core.hooksPath'), 'core.hooksPath');
  assert.equal(gitHookBypass('git config core.hooksPath'), null);
});
