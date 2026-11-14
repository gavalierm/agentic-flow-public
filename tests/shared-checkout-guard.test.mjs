// D-0038: topic work writes only in the topic's worktree; the shared checkout of a code repo (its branch collects
// done --topic merges and releases) is denied to Write, Edit, shell writes and direct git changes of a thread.
// done --topic settles the own thread only when it holds no other open topic, and names the previous holder's thread
// after a takeover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision;
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

function domainFx({ worktrees = true } = {}) {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  if (worktrees) {
    fs.mkdirSync(path.join(fx.root, '.worktrees', 'project'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { auto: { projects: { '../project': ['project'] } } } }));
  }
  fs.writeFileSync(path.join(fx.project, 'tracked.txt'), 'a\n');
  return fx;
}

test('shared checkout: Write, Edit, shell writes and git changes are denied with the way to a new code topic', () => {
  const fx = domainFx();
  try {
    const file = path.join(fx.project, 'tracked.txt');
    const calls = [
      { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'new.txt'), content: 'x' } },
      { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } },
      { tool_name: 'Bash', tool_input: { command: 'echo x > new.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ tracked.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'cp tracked.txt copy.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'mv tracked.txt moved.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'rm tracked.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'git commit -qm x' } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} merge topic/x` } },
      { tool_name: 'Bash', tool_input: { command: `cd ${fx.project} && git checkout -b y` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} reset --soft HEAD~1` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} rebase main` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} stash` } },
    ];
    // One thread per call: a target refused earlier in a turn stays closed with another reason (P-054).
    for (const [i, call] of calls.entries()) {
      const r = fx.hook('pre-tool-use.mjs', { ...call, session_id: `s-${i}` }, { env: { WORKFLOW_THREAD_ID: `t${i}` }, cwd: call.tool_name === 'Bash' && /^git -C/.test(call.tool_input.command) ? fx.root : fx.project });
      assert.equal(decision(r), 'deny', `${call.tool_name} ${JSON.stringify(call.tool_input)}: ${r.stderr}`);
      assert.match(reason(r), /shared checkout .*D-0038/);
      assert.match(reason(r), /topic\.mjs create <id> --class code --project project --task "\.\.\."/);
    }
  } finally { fx.cleanup(); }
});

test('shared checkout: reads, scratch/, workflow scripts and the topic worktree pass; the reason names the held worktree', () => {
  const fx = domainFx();
  try {
    const reads = ['cat tracked.txt', 'git log --oneline -3', 'git status', 'git diff', 'grep -n a tracked.txt', 'git stash list',
      'echo x > scratch/note.txt', `node ${path.join(fx.project, 'bin', 'done.mjs')} --topic --verified x`, 'sh tools/release.sh'];
    for (const command of reads) {
      const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.notEqual(decision(r), 'deny', `${command}: ${reason(r)}`);
    }
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'a.md'), content: 'x' } });
    assert.notEqual(decision(r), 'deny', reason(r));

    const created = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']);
    assert.equal(created.status, 0, created.out);
    const wt = path.join(fx.root, '.worktrees', 'project', 'feat');
    assert.ok(fs.existsSync(path.join(wt, '.git')), created.out);
    for (const call of [
      { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'new.txt'), content: 'x' } },
      { tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(wt, 'new.txt')}` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${wt} commit -qm x` } },
    ]) {
      r = fx.hook('pre-tool-use.mjs', call);
      assert.notEqual(decision(r), 'deny', `${JSON.stringify(call.tool_input)}: ${reason(r)}`);
    }
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'src', 'a.js'), content: 'x' } });
    assert.equal(decision(r), 'deny');
    assert.ok(reason(r).includes(`worktree of the topic this thread holds: ${path.join(wt, 'src', 'a.js')}`), reason(r));
  } finally { fx.cleanup(); }
});

test('a topic worktree directory alone makes no shared checkout: a project repo and the brain write their own files', () => {
  const fx = domainFx({ worktrees: false });
  try {
    fs.mkdirSync(path.join(fx.root, '.worktrees', 'project'), { recursive: true });
    fs.mkdirSync(path.join(fx.root, '.worktrees', 'brain'), { recursive: true });
    for (const file of [path.join(fx.project, 'page.html'), path.join(fx.brain, 'materialy', 'x', 'a.md')]) {
      const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
      assert.doesNotMatch(reason(r), /shared checkout/, file);
    }
  } finally { fx.cleanup(); }
});

test('a repo without topic worktrees is no shared checkout', () => {
  const fx = domainFx({ worktrees: false });
  try {
    const call = { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'new.txt'), content: 'x' } };
    let r = fx.hook('pre-tool-use.mjs', call);
    assert.notEqual(decision(r), 'deny', reason(r));
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit -qm x' } });
    assert.notEqual(decision(r), 'deny', reason(r));
  } finally { fx.cleanup(); }
});

test('done --topic: a thread that holds another topic is not told to settle itself', () => {
  const fx = setup();
  try {
    for (const id of ['d1', 'd2']) assert.equal(fx.run('topic.mjs', ['create', id, '--subject', id, '--class', 'discussion']).status, 0);
    let r = fx.run('done.mjs', ['--topic', '--topic-id', 'd1', '--verified', 'x'], { env: { T3CODE_THREAD_ID: 'a1' } });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /settle this thread/);
    assert.match(r.stdout, /still holds topic d2, so it stays open/);
    r = fx.run('done.mjs', ['--topic', '--topic-id', 'd2', '--verified', 'x'], { env: { T3CODE_THREAD_ID: 'a1' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /settle this thread/);
  } finally { fx.cleanup(); }
});

test('done --topic after a takeover names the previous holder thread to settle', () => {
  const fx = setup();
  try {
    let r = fx.run('topic.mjs', ['create', 'taken', '--subject', 'Taken', '--class', 'discussion'], { env: { WORKFLOW_THREAD_ID: 'old1' } });
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['claim', 'taken', '--force', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('done.mjs', ['--topic', '--topic-id', 'taken', '--verified', 'x'], { env: { T3CODE_THREAD_ID: 'a1' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /thread: settle the previous holder thread old1 \(t3_thread_organize action settle threadId old1; an archived thread first unarchive\)/);
    assert.match(r.stdout, /settle this thread/);
    assert.doesNotMatch(r.stdout, /previous holder thread a1/);
  } finally { fx.cleanup(); }
});
