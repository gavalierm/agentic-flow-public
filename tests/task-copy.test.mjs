// ttl: 2026-12-15
// Spec 3.7, 4.2.3, plan B13 (O16), B5: implementing subagents of one topic run at once only in separate task worktrees
// (topic/<topic>--<task> from the topic branch, task name obsah reserved), each commit of the topic branch and of a task
// branch is pushed by the post-commit hook of the worktree (the repo's own hooks still run), a failed push is one line of
// PostToolUse, task-merge merges into topic/<topic> and removes worktree and branch, a takeover lists the pushed branches.
// delegate.mjs prepare --implement --task-copy names the task worktree; from a persona it finds the copy by the topic record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, initProject } from './helpers.mjs';
import { persona2 } from './layout-2-helpers.mjs';

/** setup() in a domain (marker in the root, brain `brain`) whose project repo has a bare origin. */
function codeDomain() {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const origin = path.join(fx.root, 'project.git');
  fx.git(fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
  fx.git(fx.project, 'remote', 'add', 'origin', origin);
  fx.git(fx.project, 'push', '-q', '-u', 'origin', 'main');
  return { ...fx, projectOrigin: origin };
}

const commit = (fx, dir, file, text, msg) => {
  fs.writeFileSync(path.join(dir, file), text);
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', msg);
  return fx.git(dir, 'rev-parse', 'HEAD');
};
const remoteHead = (fx, branch) => { try { return fx.git(fx.projectOrigin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; } };

test('task worktrees: separate branches from the topic branch, every commit pushed, merge into the topic branch, takeover lists the branches', () => {
  const fx = codeDomain();
  try {
    let r = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']);
    assert.equal(r.status, 0, r.out);
    const copy = path.join(fx.root, '.worktrees', 'project', 'feat');
    assert.match(r.stdout, new RegExp(`code copy: ${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(branch topic/feat\\)`));
    // O16: a commit of the topic branch is on origin at once.
    let sha = commit(fx, copy, 'base.txt', 'base\n', 'topic work');
    assert.equal(remoteHead(fx, 'topic/feat'), sha, 'topic branch pushed by the post-commit hook');

    // Two task worktrees beside the copy, each on its own branch from the topic branch.
    r = fx.run('topic.mjs', ['task-copy', 'a']);
    assert.equal(r.status, 0, r.out);
    const a = path.join(fx.root, '.worktrees', 'project', 'feat--a');
    assert.match(r.stdout, /task copy: .*feat--a \(branch topic\/feat--a from topic\/feat\)/);
    assert.equal(fx.run('topic.mjs', ['task-copy', 'b']).status, 0);
    const b = path.join(fx.root, '.worktrees', 'project', 'feat--b');
    assert.equal(fx.git(a, 'rev-parse', 'HEAD'), sha); assert.equal(fx.git(b, 'rev-parse', 'HEAD'), sha);
    const shaA = commit(fx, a, 'a.txt', 'a\n', 'task a');
    commit(fx, b, 'b.txt', 'b\n', 'task b');
    assert.equal(remoteHead(fx, 'topic/feat--a'), shaA, 'task branch pushed');
    assert.ok(remoteHead(fx, 'topic/feat--b'));
    assert.equal(fx.git(fx.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout of the repo stays on its branch');

    // The repo's own hooks still run in a task worktree (the push hook passes them on).
    const preCommit = path.join(fx.project, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\nif git diff --cached --name-only | grep -q forbidden; then echo "repo check: forbidden file" >&2; exit 1; fi\nexit 0\n');
    fs.chmodSync(preCommit, 0o755);
    fs.writeFileSync(path.join(a, 'forbidden.txt'), 'x\n');
    fx.git(a, 'add', 'forbidden.txt');
    assert.throws(() => fx.git(a, 'commit', '-q', '-m', 'bad'), /repo check: forbidden file/);
    fx.git(a, 'rm', '-q', '--cached', 'forbidden.txt');
    fs.rmSync(path.join(a, 'forbidden.txt'));

    // Reserved and invalid task names.
    r = fx.run('topic.mjs', ['task-copy', 'obsah']);
    assert.equal(r.status, 1); assert.match(r.stderr, /task name obsah is reserved: .*spec 4\.6/);
    r = fx.run('topic.mjs', ['task-copy', 'Zlé meno']);
    assert.equal(r.status, 1); assert.match(r.stderr, /must be lowercase letters, digits and single hyphens/);

    // Spec 4.2.3: a takeover lists the pushed topic branch and task branches beside "Hotové".
    r = fx.run('topic.mjs', ['claim', 'feat', '--force', '--operator-approved'], { env: { WORKFLOW_THREAD_ID: 'c3' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^takeover check \(spec 4\.2\.3\)/m);
    assert.match(r.stdout, /^pushed branches of project: topic\/feat \w+ \S+ topic work; topic\/feat--a \w+ \S+ task a; topic\/feat--b \w+ \S+ task b$/m);
    assert.equal(fx.run('topic.mjs', ['claim', 'feat', '--force']).status, 0, 'the creating thread takes its own topic back');

    // task-merge: refused while the task worktree has changes that are not committed.
    fs.writeFileSync(path.join(b, 'loose.txt'), 'x\n');
    r = fx.run('topic.mjs', ['task-merge', 'b']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /has changes that are not committed \(loose\.txt\)/);
    fs.rmSync(path.join(b, 'loose.txt'));
    // After the check: merged into topic/feat, pushed, worktree and branch removed (also on origin).
    r = fx.run('topic.mjs', ['task-merge', 'a']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /merged topic\/feat--a into topic\/feat \(1 commit\(s\), \w+\)/);
    assert.match(r.stdout, /topic\/feat pushed/);
    assert.ok(!fs.existsSync(a), 'task worktree removed');
    assert.throws(() => fx.git(fx.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/topic/feat--a'));
    assert.equal(remoteHead(fx, 'topic/feat--a'), null, 'task branch removed from origin');
    assert.equal(fx.git(fx.projectOrigin, 'show', 'topic/feat:a.txt'), 'a');
    assert.equal(fx.run('topic.mjs', ['task-merge', 'b']).status, 0);
    assert.equal(fx.git(fx.projectOrigin, 'show', 'topic/feat:b.txt'), 'b');

    // O16: a push that fails is reported once by PostToolUse after the commit.
    fx.git(fx.project, 'remote', 'set-url', 'origin', path.join(fx.root, 'missing.git'));
    sha = commit(fx, copy, 'c.txt', 'c\n', 'offline work');
    const post = () => fx.hook('post-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `git -C ${copy} commit -qm x` }, tool_response: { stdout: '', stderr: '' } }).context;
    assert.match(post(), /^push: topic\/feat of .*feat not pushed \(.+\); the commit is only on this machine/m);
    assert.doesNotMatch(post(), /^push: /m, 'reported once');
  } finally { fx.cleanup(); }
});

test('delegate prepare --implement --task-copy names the task worktree; the hook checks the brief of a task worktree too', () => {
  const fx = codeDomain();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    const r = fx.run('delegate.mjs', ['prepare', '--implement', '--task-copy', 'c', '--task', 'Pridaj funkciu do src/app.js']);
    assert.equal(r.status, 0, r.out);
    const c = path.join(fx.root, '.worktrees', 'project', 'feat--c');
    assert.ok(r.stdout.includes(`implement: topic feat, class code, model opus, code copy ${c} (branch topic/feat--c)`), r.stdout);
    assert.ok(fs.existsSync(path.join(c, '.git')), 'task worktree made');
    const agent = (prompt, model) => fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { prompt, subagent_type: 'workflow:worker', ...(model ? { model } : {}) } }).json?.hookSpecificOutput || {};
    const bare = agent(`Zmeň súbory v ${c}; pracovné súbory do ${fx.project}/scratch/.`);
    assert.equal(bare.permissionDecision, 'deny');
    assert.match(bare.permissionDecisionReason, /names the code copy of topic feat .*feat--c.* without its implement: marker/);
    assert.notEqual(agent(r.stdout, 'opus').permissionDecision, 'deny');
    assert.equal(fx.run('delegate.mjs', ['prepare', '--task-copy', 'c', '--task', 'x']).status, 1, '--task-copy only with --implement');
    // spec 3.7: in the task worktree the worker commits itself; the brief of the topic copy keeps "no commit" (D-0020)
    assert.match(r.stdout, /Zmeny commituj sám v tomto worktree tasku \(`git commit`; každý commit pushne hook post-commit\)\. Nepushuj, nezlučuj \(merge, rebase\), netaguj ani neresetuj/);
    assert.doesNotMatch(r.stdout, /Necommituj/);
    assert.match(r.stderr, /the worker commits in the task worktree, the merge \(topic\.mjs task-merge c\)/);
    const topicBrief = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'Pridaj funkciu do src/app.js']);
    assert.equal(topicBrief.status, 0, topicBrief.out);
    assert.match(topicBrief.stdout, /- Necommituj, nepushuj, nezlučuj \(merge, rebase\) ani netaguj/);
  } finally { fx.cleanup(); }
});

test('spec 3.7: a worker commits in a task worktree (only commit); in the topic copy itself every git write stays refused (D-0020)', () => {
  const fx = codeDomain();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--class', 'code']).status, 0);
    assert.equal(fx.run('topic.mjs', ['task-copy', 'c']).status, 0);
    const copy = path.join(fx.root, '.worktrees', 'project', 'feat');
    const task = path.join(fx.root, '.worktrees', 'project', 'feat--c');
    const worker = (command, cwd) => fx.hook('pre-tool-use.mjs', { agent_id: 'sub-1', agent_type: 'workflow:worker', tool_name: 'Bash', tool_input: { command }, cwd }).json?.hookSpecificOutput || {};
    for (const cmd of [`git -C ${task} commit -qam x`, `cd ${task} && git add -A && git commit -m x`]) {
      assert.notEqual(worker(cmd, fx.project).permissionDecision, 'deny', cmd);
    }
    assert.notEqual(worker('git commit -m x', task).permissionDecision, 'deny', 'commit with the task worktree as cwd');
    for (const sub of ['push', 'merge topic/feat', 'rebase topic/feat', 'tag v1', 'reset --hard HEAD~1']) {
      const out = worker(`git -C ${task} ${sub}`, fx.project);
      assert.equal(out.permissionDecision, 'deny', sub);
      assert.match(out.permissionDecisionReason, /a worker commits in a task worktree .*feat--c.* but does not push, merge, rebase, tag or reset there: .*task-merge.*spec 3\.7/, sub);
    }
    for (const sub of ['commit -qam x', 'push', 'merge topic/feat--c', 'tag v1']) {
      const out = worker(`git -C ${copy} ${sub}`, fx.project);
      assert.equal(out.permissionDecision, 'deny', sub);
      assert.match(out.permissionDecisionReason, /a worker does not commit, push, merge, rebase or tag in a topic code copy .*D-0020/, sub);
    }
    // a topic copy switched to a task-like branch is still the topic copy (its folder is no task worktree)
    fx.git(copy, 'checkout', '-q', '-b', 'topic/feat--x');
    assert.equal(worker(`git -C ${copy} commit -qam x`, fx.project).permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('delegate prepare --implement from a persona: the copy of the repo the topic record names, not a worktree of the brain', () => {
  const fx = persona2();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"bob"}');
    const app = path.join(fx.root, 'app');
    initProject(app, { brainRel: '../bob' });
    let r = fx.run('topic.mjs', ['create', 'fix', '--subject', 'Oprava app', '--class', 'code', '--project', app]);
    assert.equal(r.status, 0, r.out);
    const copy = path.join(fx.root, '.worktrees', 'app', 'fix');
    assert.ok(fs.existsSync(path.join(copy, '.git')), r.out);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'Oprav chybu v src/app.js']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /is the brain/);
    assert.ok(r.stdout.includes(`implement: topic fix, class code, model opus, code copy ${copy} (branch topic/fix)`), r.stdout);
  } finally { fx.cleanup(); }
});
