// ttl: 2026-12-14
// A code topic of a domain repo (.tema.json project/repo) started from the persona brain: `thread <id>` starts the
// thread in the T3 project of the repo as create --project does, and done --topic merges the copy into that repo, not
// into the persona repo of the thread's cwd (alice 2026-11-14: index-name got a thread in the persona project and
// done --topic said 'topic/index-name - not something we can merge').
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { persona2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';

function fixture() {
  const p = persona2();
  fs.writeFileSync(path.join(p.root, '.agentic-domain'), '{"brain":"bob"}');
  const srv = path.join(p.root, 'srv');
  initProject(srv, { brainRel: '../bob' });
  // Stub of `t3 thread start --json`: records its arguments, prints a thread id.
  const log = path.join(p.root, 'thread-start.log');
  const stub = path.join(p.root, 'fake-t3.sh');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${log}'\ncat > /dev/null\necho '{"threadId":"t-new"}'\n`, { mode: 0o755 });
  const policyFile = path.join(p.dir, '.brain', 'policy.json');
  const policy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : {};
  policy.topics = { ...(policy.topics || {}), thread_start_command: `${stub} --json` };
  fs.writeFileSync(policyFile, JSON.stringify(policy, null, 2) + '\n');
  gitq(p.dir, 'add', '-A');
  gitq(p.dir, 'commit', '-q', '--no-verify', '-m', 'thread start stub');
  return { ...p, srv, log };
}

test('thread <id> of a topic created with --project starts the thread in the repo project; done --topic from the persona cwd merges into the repo', () => {
  const fx = fixture();
  try {
    let r = fx.run('topic.mjs', ['create', 'gamma', '--class', 'code', '--subject', 's', '--project', 'srv', '--here']);
    assert.equal(r.status, 0, r.out);
    const topic = JSON.parse(fs.readFileSync(path.join(fx.dir, 'temy', 'gamma', '.tema.json'), 'utf8'));
    assert.equal(topic.repo, 'srv');
    r = fx.run('topic.mjs', ['release', 'gamma']);
    assert.equal(r.status, 0, r.out);
    // From the persona brain (cwd and session project bob), without --project.
    r = fx.run('topic.mjs', ['thread', 'gamma', '--task', 'do it']);
    assert.equal(r.status, 0, r.out);
    const started = fs.readFileSync(fx.log, 'utf8');
    assert.match(started, new RegExp(`${fx.srv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -\\s*$`), `thread started in the repo project: ${started}`);
    assert.doesNotMatch(started, new RegExp(`${fx.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -`), 'not in the persona project');
    // The topic thread works in the copy and closes the topic from the persona cwd (its T3 project was the persona's).
    const wt = path.join(fx.root, '.worktrees', 'srv', 'gamma');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    gitq(wt, 'add', '-A');
    gitq(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat');
    r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'feature.txt present'], { env: { WORKFLOW_THREAD_ID: 't-new' } });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /not something we can merge/);
    assert.ok(fs.existsSync(path.join(fx.srv, 'feature.txt')), 'the copy merged into the repo of the topic');
    assert.ok(!fs.existsSync(path.join(fx.dir, 'feature.txt')), 'not into the persona repo');
    assert.ok(!fs.existsSync(wt), 'worktree removed');
  } finally { fx.cleanup(); }
});
