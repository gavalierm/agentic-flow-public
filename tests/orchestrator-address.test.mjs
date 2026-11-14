// The orchestrator of an automatic topic in another project (policy topics.auto, "orchestrator": "workflow-dev", D-0035,
// P-064) lives in the mail project of the brain, not in the project of the topic: every text that tells the topic thread
// where to send a question or a result names the full address <brain mail project>/workflow-dev, and a bare
// `comms send --to workflow-dev` from that thread goes there too, not to <topic project>/workflow-dev (where the mail held it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initProject } from './helpers.mjs';
import { fixture, fakeT3, CRON } from './fixtures/intake-fx.mjs';

const THREAD = 'mcp:launch:rt1';
const ID = 'issue-agentic-flow-public-9';

function autoFx() {
  const fx = fixture();
  const t3 = fakeT3(fx);
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  fx.flow = path.join(fx.root, 'agentic-flow');
  initProject(fx.flow);
  const policy = JSON.parse(fs.readFileSync(path.join(fx.brain, 'policy.json'), 'utf8'));
  policy.topics.auto = { projects: { '../agentic-flow': ['agentic-flow', 'agentic-flow-public'] }, default_project: '../agentic-flow', orchestrator: 'workflow-dev' };
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify(policy));
  fs.mkdirSync(path.join(fx.brain, 'topics', 'workflow-dev'), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, 'topics', 'workflow-dev', 'topic.json'), JSON.stringify({ id: 'workflow-dev', subject: 'w', class: 'code', kind: 'code', state: 'working' }));
  fs.writeFileSync(path.join(fx.brain, 'topics', 'workflow-dev', 'holder.json'), JSON.stringify({ thread: 'orch-1' }));
  fx.git(fx.brain, 'add', '-A');
  fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy auto, workflow-dev');
  const r = fx.run('topic.mjs', ['auto', ID, '--project', fx.project, '--repo', 'owner/agentic-flow-public', '--subject=Issue z', '--task=vybav issue', '--persona', 'persona'], { env: CRON });
  assert.equal(r.status, 0, r.out);
  return { fx, t3 };
}

const FULL = 'project/workflow-dev';
const WRONG = /agentic-flow\/workflow-dev|--to workflow-dev\b/;

test('orchestrator-address: the first message of an automatic topic thread names the full orchestrator address', () => {
  const { fx, t3 } = autoFx();
  try {
    const input = t3.calls()[0].input;
    assert.match(input, new RegExp(`Orchestrátor: ${FULL}\\.`));
    assert.match(input, new RegExp(`comms send --to ${FULL},`));
    assert.doesNotMatch(input, WRONG);
  } finally { fx.cleanup(); }
});

test('orchestrator-address: hook reasons (question, consent) and the fallback name the full orchestrator address', async () => {
  const { threadOrchestrator, ORCHESTRATOR_QUESTION_REASON, ORCHESTRATOR_CONSENT_REASON } = await import('../scripts/topic.mjs');
  const { autoFallback } = await import('../scripts/intake.mjs');
  const { loadContext } = await import('../scripts/config.mjs');
  const { fx } = autoFx();
  try {
    const o = threadOrchestrator(fx.brain, THREAD);
    assert.equal(o?.to, FULL);
    assert.equal(o.of, ID);
    for (const text of [ORCHESTRATOR_QUESTION_REASON(o), ORCHESTRATOR_CONSENT_REASON(o, 'why', 'Bash')]) {
      assert.match(text, new RegExp(`comms send --to ${FULL} `));
      assert.doesNotMatch(text, WRONG);
    }
    assert.equal(autoFallback(loadContext({ project: fx.project }), 'persona'), FULL);
  } finally { fx.cleanup(); }
});

test('orchestrator-address: a new thread for a held topic names the full address of its holder', async () => {
  const { startThreadForTopic } = await import('../scripts/topic.mjs');
  const { loadContext } = await import('../scripts/config.mjs');
  const { fx } = autoFx();
  try {
    const ctx = loadContext({ project: fx.project });
    ctx.thread = 'main-1';
    const held = startThreadForTopic(ctx, ID);
    assert.equal(held.ok, false);
    assert.match(held.reason, new RegExp(`comms send --to agentic-flow/${ID}\\)`), 'a topic of another project: that project');
    const own = startThreadForTopic(ctx, 'workflow-dev');
    assert.match(own.reason, new RegExp(`comms send --to ${FULL}\\)`), 'a topic of the brain project: the brain mail project');
  } finally { fx.cleanup(); }
});
