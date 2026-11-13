// Implementation in a subagent (D-0020, D-0021): a discussion topic gets its code copy after the operator approved it
// (topic.mjs copy --operator-approved), delegate.mjs prepare --implement builds the brief with the class model and the
// marker, the PreToolUse hook holds the Agent call to that model, and a worker does not commit in a topic copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

const USER = `t${'@'}t`;
const copyOf = (fx, id) => path.join(fx.root, 'project-topics', id);
const posix = (p) => p.split(path.sep).join('/');
const topicJson = (fx, id) => JSON.parse(fx.read(`topics/${id}/topic.json`));
const commitCopy = (copy, message) => {
  for (const args of [['config', 'user.name', 't'], ['config', 'user.email', USER], ['add', '-A'], ['commit', '-q', '-m', message]]) spawnSync('git', args, { cwd: copy });
};
const wake = (fx) => {
  fs.mkdirSync(path.join(fx.brain, 'local', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ turn_source: 'wake' }));
};
const create = (fx, id, cls) => assert.equal(fx.run('topic.mjs', ['create', id, '--subject', `Topic ${id}`, '--class', cls]).status, 0);
const decision = (r) => r.json.hookSpecificOutput?.permissionDecision;
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const agent = (fx, input) => fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'workflow:worker', description: 'x', ...input } });
const MARKER = /^implement: topic ([a-z0-9-]+), class ([a-z]+), model (\S+), code copy (.+) \(branch (\S+)\)$/m;

// --- A: code copy of a discussion topic ---------------------------------------------------------------------------

test('copy of a discussion topic needs --operator-approved; it is recorded in topic.json, class and kind stay', () => {
  const fx = setup();
  try {
    create(fx, 'd1', 'discussion');
    let r = fx.run('topic.mjs', ['copy', 'd1']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /discussion: its implementation is approved by the operator \(D-0020\).*topic\.mjs copy d1 --operator-approved/);
    assert.ok(!fs.existsSync(copyOf(fx, 'd1')), 'no copy without the approval');
    assert.equal(topicJson(fx, 'd1').copy, undefined);
    r = fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /code copy: .*project-topics[\\/]d1 \(branch topic\/d1\); recorded in topics\/d1\/topic\.json/);
    assert.match(r.stdout, /next: delegate\.mjs prepare --implement web\|code\|ops/);
    assert.ok(fs.existsSync(path.join(copyOf(fx, 'd1'), '.git')));
    assert.equal(fx.git(copyOf(fx, 'd1'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'topic/d1');
    const t = topicJson(fx, 'd1');
    assert.equal(t.copy, '../project-topics/d1');
    assert.equal(t.class, 'discussion');
    assert.equal(t.kind, 'discussion');
    assert.equal(t.copy_approved.thread, 'a1');
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /topic copy d1 \(operator approved\) by a1/);
    r = fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /\(existing\)$/m, 'a second call keeps the copy and writes nothing');
  } finally { fx.cleanup(); }
});

test('copy of a discussion topic is refused in a wake turn and for a thread that does not hold it; a code topic copies as before', () => {
  const fx = setup();
  try {
    create(fx, 'd1', 'discussion');
    let r = fx.run('topic.mjs', ['copy', 'd1', '--operator-approved'], { env: { WORKFLOW_THREAD_ID: 'b9' } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /only its holder makes its code copy \(P-037\)/);
    wake(fx);
    r = fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /refused: this turn was started by a message.*P-047/);
    assert.ok(!fs.existsSync(copyOf(fx, 'd1')));
    fs.rmSync(path.join(fx.brain, 'local', 'threads', 'a1.json'));
    create(fx, 'feat', 'code');
    r = fx.run('topic.mjs', ['copy', 'feat']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /code copy: .*project-topics[\\/]feat \(branch topic\/feat\) \(existing\)$/m);
  } finally { fx.cleanup(); }
});

test('done and done --topic merge the copy of a discussion topic like a code copy; a discussion without one merges nothing', () => {
  const fx = setup();
  try {
    create(fx, 'd1', 'discussion');
    assert.equal(fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']).status, 0);
    fs.writeFileSync(path.join(copyOf(fx, 'd1'), 'impl.txt'), 'one\n');
    commitCopy(copyOf(fx, 'd1'), 'impl one');
    let r = fx.run('done.mjs', ['--verified', 'impl.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'impl.txt'), 'utf8'), 'one\n');
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/d1 \(done d1\)/);
    fs.writeFileSync(path.join(copyOf(fx, 'd1'), 'impl.txt'), 'two\n');
    commitCopy(copyOf(fx, 'd1'), 'impl two');
    r = fx.run('done.mjs', ['--topic', '--verified', 'impl.txt two']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'impl.txt'), 'utf8'), 'two\n');
    assert.equal(JSON.parse(fx.read('topics/archive/d1/topic.json')).merged, true);
    assert.ok(!fs.existsSync(copyOf(fx, 'd1')), 'the copy is removed with the topic');
    create(fx, 'd2', 'discussion');
    r = fx.run('done.mjs', ['--topic', '--verified', 'talked']);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fx.read('topics/archive/d2/topic.json')).merged, false);
  } finally { fx.cleanup(); }
});

// --- B: delegate.mjs prepare --implement --------------------------------------------------------------------------

test('prepare --implement: the brief of a code topic carries the marker, the worker rules and the class model; evidence in topic.json', () => {
  const fx = setup();
  try {
    create(fx, 'feat', 'code');
    const copy = posix(copyOf(fx, 'feat'));
    const r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'Implement the feature']);
    assert.equal(r.status, 0, r.out);
    const m = r.stdout.match(MARKER);
    assert.ok(m, r.stdout);
    assert.deepEqual(m.slice(1), ['feat', 'code', 'opus', copy, 'topic/feat']);
    assert.match(r.stdout, /## Implementácia \(D-0020\)/);
    assert.match(r.stdout, /Meň iba súbory v kópii kódu .*project-topics\/feat \(vetva topic\/feat\)/);
    assert.match(r.stdout, /Necommituj, nepushuj, nezlučuj/);
    assert.match(r.stdout, /Nezapisuj do brain/);
    assert.match(r.stdout, /súhrn zmien .* spustené testy/);
    assert.match(r.stderr, /^agent: Agent tool .*model: "opus".*class code of topic feat, P-053/m);
    assert.ok(!r.stdout.includes('agent: Agent tool'), 'the agent line is not part of the prompt');
    const t = topicJson(fx, 'feat');
    assert.equal(t.implementations.length, 1);
    assert.equal(t.implementations[0].class, 'code');
    assert.equal(t.implementations[0].model, 'opus');
    assert.match(t.implementations[0].at, /^\d{4}-\d\d-\d\dT/);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /topic implement feat: class code, model opus/);
    // A copy that is gone is made again; --task-file works with --implement.
    fs.rmSync(copyOf(fx, 'feat'), { recursive: true, force: true });
    fs.mkdirSync(path.join(fx.project, 'scratch'), { recursive: true });
    const file = path.join(fx.project, 'scratch', 'brief.md');
    fs.writeFileSync(file, 'Implement the second part\n');
    const again = fx.run('delegate.mjs', ['prepare', '--task-file', file, '--implement']);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /Implement the second part/);
    assert.match(again.stdout, MARKER);
    assert.ok(fs.existsSync(path.join(copyOf(fx, 'feat'), '.git')), 'the missing copy was made');
    assert.equal(topicJson(fx, 'feat').implementations.length, 2);
    // The read-ban refusal still applies.
    const ban = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'Nečítaj súbory projektu, iba zoznam.md']);
    assert.equal(ban.status, 1, ban.out);
    assert.match(ban.stderr, /flow-public#48/);
    assert.equal(topicJson(fx, 'feat').implementations.length, 2, 'a refused brief records nothing');
  } finally { fx.cleanup(); }
});

test('prepare --implement: class of an ops topic, a discussion names the class; every refusal', () => {
  const fx = setup();
  try {
    let r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /holds no work topic/);
    create(fx, 'd1', 'discussion');
    r = fx.run('delegate.mjs', ['prepare', '--implement', 'web', '--task', 'x']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /topic d1 \(class discussion\) has no code copy: .*topic\.mjs copy d1 --operator-approved/);
    assert.equal(fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']).status, 0);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'x']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /name the class of the work, --implement web\|code\|ops \(D-0021\): web = website.*; code = code.*; ops = operations/);
    r = fx.run('delegate.mjs', ['prepare', '--implement', 'discussion', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /--implement discussion is not a class of an implementation/);
    r = fx.run('delegate.mjs', ['prepare', '--implement', 'web', '--task', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.match(MARKER).slice(1, 4), ['d1', 'web', 'sonnet']);
    assert.deepEqual(topicJson(fx, 'd1').implementations.map((i) => [i.class, i.model]), [['web', 'sonnet']]);
    create(fx, 'ops1', 'ops');
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /holds 2 topics \(d1, ops1\): pick one with --topic <id>/);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--topic', 'nope', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /does not hold topic nope/);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--topic', 'ops1', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /topic ops1 \(class ops\) has no code copy: make it: topic\.mjs copy ops1,/);
    assert.equal(fx.run('topic.mjs', ['copy', 'ops1']).status, 0, 'an ops topic needs no approval for its copy');
    r = fx.run('delegate.mjs', ['prepare', '--implement', 'code', '--topic', 'ops1', '--task', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /--implement code contradicts the class of topic ops1 \(ops\)/);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--topic', 'ops1', '--task', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.match(MARKER).slice(1, 4), ['ops1', 'ops', 'sonnet']);
    r = fx.run('delegate.mjs', ['prepare', '--implement', '--topic', 'ops1', '--task', 'x'], { env: { WORKFLOW_AGENT_ID: 'w1' } });
    assert.equal(r.status, 1); assert.match(r.stderr, /refused in subagent/);
  } finally { fx.cleanup(); }
});

test('prepare --implement: a class without subagent_model in policy is a blocker, no fallback model', () => {
  const fx = setup();
  try {
    create(fx, 'feat', 'code');
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { classes: { code: { subagent_model: '' } } } }) + '\n');
    fx.git(fx.brain, 'add', 'policy.json'); fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy');
    const r = fx.run('delegate.mjs', ['prepare', '--implement', '--task', 'x']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /policy topics\.classes\.code\.subagent_model is not set.*no fallback model/);
    assert.equal(topicJson(fx, 'feat').implementations, undefined);
  } finally { fx.cleanup(); }
});

// --- C: hook on the Agent call of the main agent ------------------------------------------------------------------

test('hook: an Agent call naming the topic copy needs the marker and the class model; Explore and other prompts pass', () => {
  const fx = setup();
  try {
    create(fx, 'feat', 'code');
    const copy = posix(copyOf(fx, 'feat'));
    const plain = fx.run('delegate.mjs', ['prepare', '--task', `Implement it in ${copy}`]);
    assert.equal(plain.status, 0, plain.out);
    let r = agent(fx, { prompt: plain.stdout, model: 'opus' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /names the code copy of topic feat .* without its implement: marker.*delegate\.mjs prepare --implement --topic feat --task-file <file>.*model: "opus" \(class code\)/);
    const brief = fx.run('delegate.mjs', ['prepare', '--implement', '--task', `Implement it in ${copy}`]);
    assert.equal(brief.status, 0, brief.out);
    r = agent(fx, { prompt: brief.stdout, model: 'sonnet' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /model "sonnet" is not the model of class code \(topic feat\): pass model: "opus"/);
    r = agent(fx, { prompt: brief.stdout });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /has no model: without it the worker runs on CLAUDE_CODE_SUBAGENT_MODEL \(the cheap model\); pass model: "opus"/);
    r = agent(fx, { prompt: brief.stdout, model: 'opus' });
    assert.notEqual(decision(r), 'deny', reason(r));
    // The hook computes the class itself: a marker edited to a cheaper class is refused.
    const forged = brief.stdout.replace('class code, model opus', 'class web, model sonnet');
    r = agent(fx, { prompt: forged, model: 'sonnet' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /marker names class web, topic feat implements as class code/);
    r = agent(fx, { subagent_type: 'Explore', prompt: `Find the tests in ${copy}` });
    assert.notEqual(decision(r), 'deny', 'a read-only agent type passes');
    const other = fx.run('delegate.mjs', ['prepare', '--task', `Read ${copy}-old/notes.txt`]);
    r = agent(fx, { prompt: other.stdout });
    assert.notEqual(decision(r), 'deny', 'a path that only starts with the copy path is another path');
    const none = fx.run('delegate.mjs', ['prepare', '--task', 'Summarize the release notes']);
    r = agent(fx, { prompt: none.stdout });
    assert.notEqual(decision(r), 'deny', 'a prompt without the copy path is untouched');
  } finally { fx.cleanup(); }
});

test('hook: a discussion copy takes the class of its recorded implementation; a hand-written marker alone is refused', () => {
  const fx = setup();
  try {
    create(fx, 'd1', 'discussion');
    assert.equal(fx.run('topic.mjs', ['copy', 'd1', '--operator-approved']).status, 0);
    const copy = posix(copyOf(fx, 'd1'));
    const hand = `implement: topic d1, class web, model sonnet, code copy ${copy} (branch topic/d1)\nwork in ${posix(path.join(fx.project, 'scratch'))}/`;
    let r = agent(fx, { prompt: hand, model: 'sonnet' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /topic d1 has no class of an implementation .*delegate\.mjs prepare --implement <web\|code\|ops> --topic d1/);
    const brief = fx.run('delegate.mjs', ['prepare', '--implement', 'web', '--task', 'Build the page']);
    assert.equal(brief.status, 0, brief.out);
    r = agent(fx, { prompt: brief.stdout, model: 'opus' });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /pass model: "sonnet"/);
    r = agent(fx, { prompt: brief.stdout, model: 'sonnet' });
    assert.notEqual(decision(r), 'deny', reason(r));
  } finally { fx.cleanup(); }
});

// --- D: git of a worker in a topic copy ---------------------------------------------------------------------------

test('hook: a worker does not commit, push, merge, rebase or tag in a topic copy; outside it and the main agent pass', () => {
  const fx = setup();
  try {
    create(fx, 'feat', 'code');
    const copy = copyOf(fx, 'feat');
    const bash = (command, cwd, sub = true) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command }, cwd, ...(sub ? { agent_id: 'w1', agent_type: 'workflow:worker' } : {}) });
    for (const command of ['git commit -qm x', 'git push origin topic/feat', 'git merge main', 'git rebase main', 'git tag v1']) {
      const r = bash(command, copy);
      assert.equal(decision(r), 'deny', command);
      assert.match(reason(r), /a worker does not commit, push, merge, rebase or tag in a topic code copy .*the topic thread commits after review \(D-0020\)/, command);
    }
    let r = bash(`git -C ${copy} commit -qm x`, fx.project);
    assert.equal(decision(r), 'deny', 'git -C into the copy');
    r = bash(`cd ${copy} && git add -A && git commit -qm x`, fx.project);
    assert.equal(decision(r), 'deny', 'cd into the copy');
    r = bash('git status && git diff && git tag --sort=-creatordate', copy);
    assert.notEqual(decision(r), 'deny', 'reading git passes');
    r = bash('git commit -qm x', fx.project);
    assert.notEqual(decision(r), 'deny', 'outside a topic copy nothing changes');
    r = bash('git commit -qm x', copy, false);
    assert.notEqual(decision(r), 'deny', 'the main agent commits in the copy');
  } finally { fx.cleanup(); }
});
