// D-0020, D-0021: a topic gets its class at creation. The class decides the kind (web and code get a code copy, ops and
// discussion do not) and the model of the topic's thread (`t3 thread start --provider --model`); the CLI has no --effort
// (T3 issue #29863), so topic create and topic thread print one line to set it with t3_thread_configure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, setup } from './helpers.mjs';
import { startTopicThread, topicThreadMessage, topicClass, resolveClass, TOPIC_CLASSES } from '../scripts/topic.mjs';
import { loadPolicy } from '../scripts/config.mjs';

const basePolicy = () => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'policy', 'policy.json'), 'utf8'));

/** Fake `t3 thread start`: logs argv and stdin, prints a thread id. */
function fakeT3(fx) {
  const log = path.join(fx.root, 't3-calls.json');
  const file = path.join(fx.root, 'fake-t3.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }));\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:cls1' }));\n`);
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${file}` } }));
  return { call: () => JSON.parse(fs.readFileSync(log, 'utf8')), clear: () => fs.rmSync(log, { force: true }) };
}

test('policy: four classes with kind, thread provider/model/effort and subagent model (D-0021)', () => {
  const c = basePolicy().topics.classes;
  assert.deepEqual(Object.keys(c).sort(), ['code', 'discussion', 'ops', 'web']);
  assert.deepEqual(c.web, { kind: 'code', thread: { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'medium' }, subagent_model: 'sonnet' });
  assert.deepEqual(c.code, { kind: 'code', thread: { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' }, subagent_model: 'opus' });
  assert.deepEqual(c.ops, { kind: 'discussion', thread: { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'medium' }, subagent_model: 'sonnet' });
  assert.deepEqual(c.discussion, { kind: 'discussion', thread: { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' }, subagent_model: null });
  assert.deepEqual(Object.keys(TOPIC_CLASSES).sort(), Object.keys(c).sort());
});

test('policy: a brain policy.json changes one class model, the rest of the class stays (deep merge)', () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-class-'));
  try {
    fs.writeFileSync(path.join(brain, 'policy.json'), JSON.stringify({ topics: { classes: { web: { thread: { model: 'claude-opus-5-5' } } } } }));
    const ctx = { policy: loadPolicy(brain) };
    assert.deepEqual(topicClass(ctx, 'web').thread, { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' });
    assert.equal(topicClass(ctx, 'web').kind, 'code');
    assert.equal(topicClass(ctx, 'code').thread.model, 'claude-opus-5-5');
    assert.equal(topicClass(ctx, 'ops').thread.model, 'claude-sonnet-5-5');
  } finally { fs.rmSync(brain, { recursive: true, force: true }); }
});

test('topic create: --class is required, --kind alone or against the class is refused', () => {
  const fx = setup();
  try {
    const none = fx.run('topic.mjs', ['create', 'no-class', '--subject', 'X']);
    assert.equal(none.status, 1);
    for (const c of ['web', 'code', 'ops', 'discussion']) assert.match(none.out, new RegExp(`${c} = `), c);
    assert.match(none.out, /server, DNS, cron/);
    assert.match(none.out, /Research is not a class/);
    const kindOnly = fx.run('topic.mjs', ['create', 'kind-only', '--subject', 'X', '--kind', 'code']);
    assert.equal(kindOnly.status, 1);
    assert.match(kindOnly.out, /--kind alone is not enough.*web = .*code = .*ops = .*discussion = /);
    const against = fx.run('topic.mjs', ['create', 'against', '--subject', 'X', '--class', 'ops', '--kind', 'code']);
    assert.equal(against.status, 1);
    assert.match(against.out, /--kind code contradicts --class ops \(kind discussion\)/);
    assert.match(fx.run('topic.mjs', ['create', 'odd', '--subject', 'X', '--class', 'research']).out, /unknown class "research"/);
    assert.ok(!fx.exists('topics/no-class') && !fx.exists('topics/kind-only') && !fx.exists('topics/against') && !fx.exists('topics/odd'), 'nothing written');
    assert.throws(() => resolveClass({}, null), /needs a class/);
    assert.equal(resolveClass({}, 'web', 'code').kind, 'code');
  } finally { fx.cleanup(); }
});

test('topic create: the class is in topic.json and decides the kind; a claim by this thread writes no model', () => {
  const fx = setup();
  try {
    const kinds = { web: 'code', code: 'code', ops: 'discussion', discussion: 'discussion' };
    for (const [cls, kind] of Object.entries(kinds)) {
      const r = fx.run('topic.mjs', ['create', `t-${cls}`, '--subject', cls, '--class', cls, '--no-claim', '--no-copy']);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`topic t-${cls} created \\(class ${cls}, ${kind}\\)`));
      const topic = JSON.parse(fx.read(`topics/t-${cls}/topic.json`));
      assert.equal(topic.class, cls);
      assert.equal(topic.kind, kind);
      assert.equal(!!topic.copy, kind === 'code', `${cls}: code copy path only for kind code`);
    }
    // the creating thread holds it itself: its model is not known to the code (no record of it), nothing is written
    assert.equal(fx.run('topic.mjs', ['create', 'mine', '--subject', 'Mine', '--class', 'ops']).status, 0);
    const holder = JSON.parse(fx.read('topics/mine/holder.json'));
    assert.equal(holder.thread, 'a1');
    assert.ok(!('model' in holder) && !('effort' in holder), JSON.stringify(holder));
    // a matching --kind is accepted
    assert.equal(fx.run('topic.mjs', ['create', 'same', '--subject', 'S', '--class', 'code', '--kind', 'code', '--no-claim', '--no-copy']).status, 0);
  } finally { fx.cleanup(); }
});

test('startTopicThread: --provider and --model of the class, none for a topic without a class; effort line', () => {
  const calls = [];
  const run = (file, args, opts) => { calls.push({ file, args, input: opts.input }); return { status: 0, stdout: JSON.stringify({ threadId: 'mcp:new:7' }), stderr: '' }; };
  const ctx = { projectDir: path.join(os.tmpdir(), 'no-such-project'), policy: { topics: { thread_start_command: 't3 thread start --json', classes: basePolicy().topics.classes } } };
  const web = startTopicThread(ctx, { id: 'site-copy', subject: 'S', kind: 'code', class: 'web' }, run, { platform: 'linux' });
  assert.equal(web.ok, true);
  assert.equal(calls[0].file, 't3');
  assert.deepEqual(calls[0].args, ['thread', 'start', '--json', '--title', 'site-copy', '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', ctx.projectDir, '-']);
  assert.equal(web.model, 'claude-sonnet-5-5');
  assert.match(web.effortNote, /t3_thread_configure, threadId mcp:new:7, modelSelection \{"instanceId":"claudeAgent","model":"claude-sonnet-5-5","options":\[\{"id":"effort","value":"medium"\}\]\}/);
  assert.match(calls[0].input.split('\n')[0], /^Téma site-copy \(code\), trieda web, je pridelená tomuto vláknu\.$/);
  const code = startTopicThread(ctx, { id: 'release-x', subject: 'R', kind: 'code', class: 'code' }, run, { platform: 'linux' });
  assert.deepEqual(calls[1].args.slice(5, 9), ['--provider', 'claudeAgent', '--model', 'claude-opus-5-5']);
  assert.match(code.effortNote, /"value":"high"/);
  // a topic from before the classes: the thread starts on the project's default model, as before
  const old = startTopicThread(ctx, { id: 'old-one', subject: 'O', kind: 'discussion' }, run, { platform: 'linux' });
  assert.deepEqual(calls[2].args, ['thread', 'start', '--json', '--title', 'old-one', ctx.projectDir, '-']);
  assert.equal(old.model, null);
  assert.equal(old.effortNote, null);
  assert.equal(topicThreadMessage({ id: 'old-one', subject: 'O', kind: 'discussion' }).split('\n')[0], 'Téma old-one (discussion) je pridelená tomuto vláknu.');
});

test('topic create and topic thread: the new thread gets the class model, holder.json records it, the output says how to set the effort', () => {
  const fx = setup();
  try {
    const t3 = fakeT3(fx);
    const env = { env: { T3CODE_THREAD_ID: 'a1' } };
    const r = fx.run('topic.mjs', ['create', 'site-copy', '--subject', 'Site', '--class', 'web', '--new-thread', '--no-copy'], env);
    assert.equal(r.status, 0, r.out);
    const argv = t3.call().argv;
    assert.deepEqual(argv.slice(0, 6), ['--title', 'site-copy', '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5']);
    const holder = JSON.parse(fx.read('topics/site-copy/holder.json'));
    assert.equal(holder.thread, 'mcp:launch:cls1');
    assert.equal(holder.model, 'claude-sonnet-5-5');
    assert.equal(holder.effort, null);
    const lines = r.out.split('\n').filter((l) => /t3_thread_configure/.test(l));
    assert.equal(lines.length, 1, r.out);
    assert.match(lines[0], /threadId mcp:launch:cls1, modelSelection \{"instanceId":"claudeAgent","model":"claude-sonnet-5-5","options":\[\{"id":"effort","value":"medium"\}\]\}/);
    // topic thread: the class comes from topic.json
    t3.clear();
    assert.equal(fx.run('topic.mjs', ['create', 'plan-x', '--subject', 'Plan', '--class', 'discussion', '--no-claim']).status, 0);
    const th = fx.run('topic.mjs', ['thread', 'plan-x'], env);
    assert.equal(th.status, 0, th.out);
    assert.deepEqual(t3.call().argv.slice(2, 6), ['--provider', 'claudeAgent', '--model', 'claude-opus-5-5']);
    assert.match(t3.call().input, /^Téma plan-x \(discussion\), trieda discussion, je pridelená/);
    assert.equal(JSON.parse(fx.read('topics/plan-x/holder.json')).model, 'claude-opus-5-5');
    assert.match(th.out, /t3_thread_configure, threadId mcp:launch:cls1, .*"value":"medium"/);
    // --for-thread (started by the T3 tool, not the CLI): no model was passed, holder.json says null
    assert.equal(fx.run('topic.mjs', ['create', 'given', '--subject', 'G', '--class', 'ops', '--for-thread', 'mcp:launch:given']).status, 0);
    const given = JSON.parse(fx.read('topics/given/holder.json'));
    assert.equal(given.thread, 'mcp:launch:given');
    assert.equal(given.model, null);
    assert.equal(given.effort, null);
  } finally { fx.cleanup(); }
});
