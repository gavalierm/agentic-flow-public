// Automatic code topics in the repo's project (D-0035, D-0038, operator 2026-11-13): the report intake (cron, every
// minute) and the issue watch of a persona (topic.mjs auto, cron) create a code topic that works in the project of the
// repo it changes (policy topics.auto of the brain): its thread starts in that project, its code copy is the worktree
// topic/<id> of that repo, its mail is registered there, its questions go to the policy orchestrator; nothing is created
// in the persona's own project. A report names no repo: default_project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initProject } from './helpers.mjs';
import { fixture, fakeT3, TOPIC, CRON } from './fixtures/intake-fx.mjs';

function domainFx() {
  const fx = fixture();
  const t3 = fakeT3(fx);
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  fx.flow = path.join(fx.root, 'agentic-flow');
  fx.comms = path.join(fx.root, 'agentic-comms');
  initProject(fx.flow);
  initProject(fx.comms);
  const policy = JSON.parse(fs.readFileSync(path.join(fx.brain, 'policy.json'), 'utf8'));
  policy.topics.auto = {
    projects: { '../agentic-flow': ['agentic-flow', 'agentic-flow-public'], '../agentic-comms': ['agentic-comms', 'agentic-comms-public'] },
    default_project: '../agentic-flow',
    orchestrator: 'workflow-dev',
  };
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify(policy));
  // The orchestrator topic, held by its thread.
  fs.mkdirSync(path.join(fx.brain, 'topics', 'workflow-dev'), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, 'topics', 'workflow-dev', 'topic.json'), JSON.stringify({ id: 'workflow-dev', subject: 'w', class: 'code', kind: 'code', state: 'working' }));
  fs.writeFileSync(path.join(fx.brain, 'topics', 'workflow-dev', 'holder.json'), JSON.stringify({ thread: 'orch-1' }));
  fx.git(fx.brain, 'add', '-A');
  fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy auto, workflow-dev');
  return { fx, t3 };
}

function assertInRepo(fx, t3, id, repoDir, repoName) {
  const topic = JSON.parse(fx.read(`topics/${id}/topic.json`));
  assert.equal(topic.class, 'code');
  assert.equal(topic.repo, repoName);
  assert.equal(topic.project, repoName, 'registered under the repo mail project');
  assert.deepEqual(topic.orchestrator, { topic: 'workflow-dev', thread: 'orch-1', project: 'project' }, 'questions go to the workflow orchestrator');
  assert.equal(topic.created_by, undefined);
  const copy = path.join(fx.root, '.worktrees', repoName, id);
  assert.ok(fs.existsSync(path.join(copy, '.git')), 'worktree of the repo');
  assert.equal(fx.git(copy, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `topic/${id}`);
  assert.equal(JSON.parse(fx.read(`topics/${id}/holder.json`)).thread, 'mcp:launch:rt1');
  const [call] = t3.calls();
  assert.ok(call.argv.includes(repoDir), `thread starts in the repo project: ${call.argv.join(' ')}`);
  assert.ok(!call.argv.includes(fx.project), 'not in the persona project');
  assert.match(call.input, /Orchestrátor: project\/workflow-dev/);
  assert.match(call.input, new RegExp(`Kópia kódu: \\.\\./\\.worktrees/${repoName}/${id}`));
  const reg = fx.calls().filter((c) => c[0] === 'register-topic');
  assert.ok(reg.length && reg.every((c) => c[c.indexOf('--project') + 1] === repoName), JSON.stringify(reg));
  // Nothing in the persona's project: no worktree of it, no legacy clone.
  assert.ok(!fs.existsSync(path.join(fx.root, '.worktrees', 'project')));
  assert.ok(!fs.existsSync(path.join(fx.root, 'project-topics')));
}

test('auto topics: a report (no repo named) gets its topic, thread and worktree in agentic-flow; the message moves there', () => {
  const { fx, t3 } = domainFx();
  try {
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`${TOPIC}: message m-1 delivered to thread mcp:launch:rt1 \\(created, agentic-flow/${TOPIC}, copy `));
    assertInRepo(fx, t3, TOPIC, fx.flow, 'agentic-flow');
    assert.match(t3.calls()[0].input, new RegExp(`čaká v pošte témy agentic-flow/${TOPIC}`));
    const decides = fx.calls().filter((c) => c[0] === 'decide');
    assert.deepEqual(decides.map((c) => c.slice(0, 7)), [['decide', '--notice', 'n-1', '--decision', 'redirect', '--target', `agentic-flow/${TOPIC}`]]);
    assert.equal(fx.state().message['m-1'].project, 'agentic-flow');
    const again = fx.intake();
    assert.equal(again.status, 0, again.out);
    assert.equal(t3.calls().length, 1);
  } finally { fx.cleanup(); }
});

test('auto topics: an issue of agentic-comms-public gets its topic in agentic-comms (topic.mjs auto, cron)', () => {
  const { fx, t3 } = domainFx();
  try {
    const id = 'issue-agentic-comms-public-7';
    const r = fx.run('topic.mjs', ['auto', id, '--project', fx.project, '--repo', 'owner/agentic-comms-public', '--subject=Issue x', '--task=vybav issue', '--persona', 'alice'], { env: CRON });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`^mail: agentic-comms/${id}$`, 'm'));
    assertInRepo(fx, t3, id, fx.comms, 'agentic-comms');
    // A second ring: the held topic is registered again, no new thread.
    const again = fx.run('topic.mjs', ['auto', id, '--project', fx.project, '--repo', 'owner/agentic-comms-public', '--subject=Issue x', '--persona', 'alice'], { env: CRON });
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /held, thread mcp:launch:rt1/);
    assert.equal(t3.calls().length, 1);
  } finally { fx.cleanup(); }
});

test('auto topics: an issue of agentic-flow-public goes to agentic-flow; a failed thread start names the orchestrator as fallback', () => {
  const { fx, t3 } = domainFx();
  try {
    const id = 'issue-agentic-flow-public-3';
    t3.fail(true);
    const r = fx.run('topic.mjs', ['auto', id, '--project', fx.project, '--repo', 'owner/agentic-flow-public', '--subject=Issue y', '--persona', 'alice'], { env: CRON });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^fallback: project\/workflow-dev$/m, 'not the archived persona main thread');
    t3.fail(false);
    const again = fx.run('topic.mjs', ['auto', id, '--project', fx.project, '--repo', 'owner/agentic-flow-public', '--subject=Issue y', '--persona', 'alice'], { env: CRON });
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, new RegExp(`^mail: agentic-flow/${id}$`, 'm'));
    assert.match(again.stdout, /thread, thread mcp:launch:rt1/);
    assert.ok(t3.calls().every((c) => c.argv.includes(fx.flow)));
  } finally { fx.cleanup(); }
});

test('auto topics: without policy topics.auto the intake keeps its topic in its own project without a copy', () => {
  const fx = fixture();
  try {
    fakeT3(fx);
    const r = fx.intake();
    assert.equal(r.status, 0, r.out);
    const topic = JSON.parse(fx.read(`topics/${TOPIC}/topic.json`));
    assert.equal(topic.copy, undefined);
    assert.equal(topic.orchestrator, undefined);
    assert.deepEqual(fx.calls().filter((c) => c[0] === 'decide').map((c) => c[4]), ['deliver']);
  } finally { fx.cleanup(); }
});
