// P-012: an operator task off the subject of the held topic. UserPromptSubmit starts a judge detached; PreToolUse refuses the
// first write of that turn once. The judge is a command (WORKFLOW_DRIFT_JUDGE_CMD) that prints the verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { readDrift } from '../scripts/drift.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));
const reasonOf = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const DRIFT = /does not fit the subject of topic alpha \("Alpha shop"\): other domain[^]*P-012/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function started(verdict) {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha shop', '--class', 'discussion']).status, 0);
  const mark = path.join(fx.root, 'judge-ran');
  const cmd = `cat > ${mark}.in; touch ${mark}; echo '${JSON.stringify(verdict)}'`;
  fx.env.WORKFLOW_DRIFT_JUDGE_CMD = cmd;
  fx.mark = mark;
  return fx;
}
const write = (fx, rel) => fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, rel), content: 'x' } });
async function verdictOf(fx) {
  for (let i = 0; i < 100; i++) {
    const v = readDrift(fx.brain, fx.thread, stateOf(fx).turn_started_at);
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const judgeRan = async (fx) => { await sleep(1200); return fs.existsSync(fx.mark); };

test('drift: a task off the topic subject refuses the first write once, the repeat passes', async () => {
  const fx = started({ fits: false, reason: 'other domain' });
  try {
    const prompt = 'založ nový web pre iného klienta <pasted_content id="p1">SECRET-PASTE</pasted_content>';
    fx.hook('user-prompt-submit.mjs', { prompt });
    const v = await verdictOf(fx);
    assert.equal(v?.fits, false);
    const seen = fs.readFileSync(`${fx.mark}.in`, 'utf8');
    assert.match(seen, /Alpha shop/);
    assert.match(seen, /založ nový web/);
    assert.doesNotMatch(seen, /SECRET-PASTE/, 'pasted material is not the task');
    assert.doesNotMatch(reasonOf(write(fx, 'scratch/notes.md')), DRIFT, 'a work file is no drift');
    const first = write(fx, 'config.txt');
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(first), DRIFT);
    assert.doesNotMatch(reasonOf(write(fx, 'config.txt')), DRIFT, 'once per turn: the repeat passes');
    // the next operator turn is judged again (slowly here: the old verdict must not count for it)
    fx.env.WORKFLOW_DRIFT_JUDGE_CMD = 'sleep 5; echo \'{"fits":false,"reason":"other domain"}\'';
    fx.hook('user-prompt-submit.mjs', { prompt: 'a ešte iný web pre iného klienta' });
    assert.doesNotMatch(reasonOf(write(fx, 'other.txt')), DRIFT, 'the old verdict belongs to the old turn');
  } finally { fx.cleanup(); }
});

test('drift: the workflow remedy (topic.mjs, save.mjs) passes, the first real write is still refused', async () => {
  const fx = started({ fits: false, reason: 'other domain' });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'založ nový web pre iného klienta' });
    assert.ok(await verdictOf(fx));
    const bash = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
    assert.doesNotMatch(reasonOf(bash('node /x/scripts/topic.mjs create beta --subject Beta')), DRIFT);
    assert.doesNotMatch(reasonOf(bash('node /x/scripts/save.mjs decision "x"')), DRIFT);
    assert.doesNotMatch(reasonOf(bash('grep -n x README.md')), DRIFT, 'a read is no write');
    assert.match(reasonOf(bash(`echo x > ${path.join(fx.project, 'out.txt')}`)), DRIFT);
  } finally { fx.cleanup(); }
});

test('drift: a task that fits passes', async () => {
  const fx = started({ fits: true, reason: 'same subject' });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'pridaj do obchodu košík' });
    assert.equal((await verdictOf(fx))?.fits, true);
    assert.doesNotMatch(reasonOf(write(fx, 'config.txt')), DRIFT);
  } finally { fx.cleanup(); }
});

test('drift: no verdict (late judge, failing judge) refuses nothing', async () => {
  const fx = started({ fits: false, reason: 'other domain' });
  try {
    fx.env.WORKFLOW_DRIFT_JUDGE_CMD = 'sleep 5; echo \'{"fits":false,"reason":"other domain"}\'';
    fx.hook('user-prompt-submit.mjs', { prompt: 'založ nový web pre iného klienta' });
    assert.doesNotMatch(reasonOf(write(fx, 'config.txt')), DRIFT, 'the verdict has not arrived');
    fx.env.WORKFLOW_DRIFT_JUDGE_CMD = 'exit 3';
    fx.hook('user-prompt-submit.mjs', { prompt: 'založ nový web pre iného klienta' });
    await sleep(800);
    assert.doesNotMatch(reasonOf(write(fx, 'config.txt')), DRIFT, 'a failed judge');
  } finally { fx.cleanup(); }
});

test('drift: topic main, a bell, a question, WORKFLOW_DRIFT_JUDGE=off and done start no judge', async () => {
  const fx = started({ fits: false, reason: 'other domain' });
  try {
    for (const prompt of ['you have mail in topic alpha', 'čo je to? prečo je tam iný web', 'done']) {
      fx.hook('user-prompt-submit.mjs', { prompt });
      assert.equal(await judgeRan(fx), false, prompt);
    }
    fx.env.WORKFLOW_DRIFT_JUDGE = 'off';
    fx.hook('user-prompt-submit.mjs', { prompt: 'založ nový web pre iného klienta' });
    assert.equal(await judgeRan(fx), false, 'off');
    delete fx.env.WORKFLOW_DRIFT_JUDGE;
  } finally { fx.cleanup(); }
  const main = started({ fits: false, reason: 'other domain' });
  try {
    const holder = main.read('topics/alpha/holder.json');
    assert.equal(main.run('topic.mjs', ['release', 'alpha']).status, 0);
    fs.mkdirSync(path.join(main.brain, 'topics', 'main'), { recursive: true });
    fs.writeFileSync(path.join(main.brain, 'topics', 'main', 'topic.json'), JSON.stringify({ id: 'main', subject: 'Main thread', kind: 'main', state: 'working' }));
    fs.writeFileSync(path.join(main.brain, 'topics', 'main', 'holder.json'), holder);
    assert.match(main.hook('user-prompt-submit.mjs', { prompt: 'založ nový web pre iného klienta' }).context, /topic main/, 'the thread holds main');
    assert.equal(await judgeRan(main), false, 'main topic');
    assert.doesNotMatch(reasonOf(write(main, 'config.txt')), DRIFT);
  } finally { main.cleanup(); }
});

test('drift: related work that is the subject of another open topic is judged with that topic and the refusal names it (flow-public#59)', async () => {
  const fx = started({ fits: true, reason: 'nový skill na prepis textov', belongs_to: 'beta' });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'beta', '--subject', 'Skill na prepis textov', '--class', 'discussion', '--no-claim']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'sprav nový skill na prepis textov' });
    const v = await verdictOf(fx);
    assert.equal(v?.fits, false, 'belongs_to another open topic is off this topic');
    assert.equal(v?.belongs_to, 'beta');
    const seen = fs.readFileSync(`${fx.mark}.in`, 'utf8');
    assert.match(seen, /# Other open topics[^]*beta: Skill na prepis textov/, 'the judge sees the other open topics');
    assert.doesNotMatch(seen, /\nalpha: /, 'the held topic is not listed among the others');
    const first = write(fx, 'skills/prepis/SKILL.md');
    assert.equal(first.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reasonOf(first), /belongs to the open topic beta \("Skill na prepis textov"\)[^]*recommended option/);
  } finally { fx.cleanup(); }
});

test('drift: belongs_to naming no open topic is ignored', async () => {
  const fx = started({ fits: true, reason: 'same subject', belongs_to: 'nope' });
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'pridaj do obchodu košík' });
    const v = await verdictOf(fx);
    assert.equal(v?.fits, true);
    assert.equal(v?.belongs_to, undefined);
  } finally { fx.cleanup(); }
});

test('drift: a task of the second topic the thread holds is no drift (flow-public#72)', async () => {
  const fx = started({ fits: false, reason: 'patrí druhej téme', belongs_to: 'beta' });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'beta', '--subject', 'Beta kolimátory', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'gamma', '--subject', 'Gamma iné', '--class', 'discussion', '--no-claim']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'zapíš dávku kolimátorov' });
    const v = await verdictOf(fx);
    assert.equal(v?.fits, true, 'belongs to a topic the thread also holds');
    const seen = fs.readFileSync(`${fx.mark}.in`, 'utf8');
    assert.match(seen, /# Other topics this agent holds \(id: subject\)\n(alpha: Alpha shop|beta: Beta kolimátory)/, 'the judge sees every held topic');
    assert.match(seen, /# Other open topics \(id: subject\)\ngamma: Gamma iné\n#/, 'held topics are not listed among the others');
    assert.doesNotMatch(reasonOf(write(fx, 'config.txt')), /does not fit the subject/);
  } finally { fx.cleanup(); }
});
