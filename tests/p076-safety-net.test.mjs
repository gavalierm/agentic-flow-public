// ttl: 2026-12-15
// P-076 (agent-alice/D-0094): skills and rules lead the work, a hook is only the safety net. The refusals that cost repeated
// work on 2026-11-15 are loosened: the handover has no line limit (1), a copied state of another topic is a warning judged
// per point of the step (2), a question turn refuses nothing (3), the rule judge reads the project exceptions (4), a bell
// turn runs done --topic and promote its own handover orders (5), the operator's yes pairs with the call by the target of
// the dialog, also before the first call, once (6), a brief names the work folder of any held topic (7), every hook
// refusal is counted by kind and consolidate lists the most frequent (8), and a refusal names the way that passes (9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { setup2, persona2 } from './layout-2-helpers.mjs';
import { deniedCommand } from '../hooks/pre-tool-use.mjs';

const stateOf = (brain, thread = 'a1') => JSON.parse(fs.readFileSync(path.join(brain, 'local', 'threads', `${thread}.json`), 'utf8'));
const pre = (fx, tool_name, tool_input) => fx.hook('pre-tool-use.mjs', { tool_name, tool_input, cwd: fx.project }).json?.hookSpecificOutput || {};

test('point 1: a handover over 15 lines is written; only a missing section is refused', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'ho', '--subject', 'Ho', '--class', 'discussion']).status, 0);
    const r = fx.run('save.mjs', ['handover', 'ho', '--task', 'T', '--done', 'a; b; c; d; e; f; g; h; i', '--next', 'n', '--files', 'f1; f2', '--questions', 'q1; q2']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /lines, limit/);
    const text = fx.read('topics/ho/handover.md');
    assert.ok(text.trim().split('\n').length > 15, text);
    assert.match(text, /^- i$/m);
  } finally { fx.cleanup(); }
});

test('point 2: a state word in another point than the topic passes silently; a copied state is a warning, the handover is written', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'own', '--subject', 'Own', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'other-x', '--subject', 'Iná práca', '--class', 'discussion', '--no-claim']).status, 0);
    // the false refusal of the day: "done" (a command) in point 2, the topic in point 1
    let r = fx.run('save.mjs', ['handover', 'own', '--task', 'T', '--done', 'x', '--next', '1) dohľad nad other-x 2) done --topic']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /warning:/);
    assert.match(fx.read('topics/own/handover.md'), /1\) dohľad nad other-x 2\) done --topic/);
    // points split by ";" too
    r = fx.run('save.mjs', ['handover', 'own', '--task', 'T', '--done', 'x', '--next', 'dohľad nad other-x; potom ďalší krok']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /warning:/);
    // one point holds both: a warning, never a refusal
    r = fx.run('save.mjs', ['handover', 'own', '--task', 'T', '--done', 'x', '--next', '1) other-x zostáva otvorená 2) dohľad']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /warning: --next "other-x zostáva otvorená" describes the state of topic other-x/);
    assert.match(fx.read('topics/own/handover.md'), /other-x zostáva otvorená/);
  } finally { fx.cleanup(); }
});

test('point 3: in a question turn the first write passes; the line in the context stays, without a refusal', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const ups = fx.hook('user-prompt-submit.mjs', { prompt: 'prečo je v README slovo hello?' });
    assert.equal(stateOf(fx.brain).turn_intent, 'question');
    const out = pre(fx, 'Edit', { file_path: path.join(fx.project, 'README.md'), old_string: 'hello', new_string: 'hi' });
    assert.notEqual(out.permissionDecision, 'deny', out.permissionDecisionReason);
    assert.match(ups.context, /do not make it \(P-063\)/);
    assert.doesNotMatch(ups.context, /refused once \(P-063\)/);
  } finally { fx.cleanup(); }
});

test('point 4: the rule judge reads the project exceptions: a conflict with a principle under an exception is no conflict', () => {
  const fx = setup();
  try {
    const promptFile = path.join(fx.root, 'judge-prompt.txt');
    const verdict = JSON.stringify({ overlaps: [], conflicts: [{ id: 'P-010', how: 'other index limit' }], code_instead: '' });
    const judge = { env: { WORKFLOW_RULE_JUDGE: 'on', WORKFLOW_RULE_JUDGE_CMD: `cat > '${promptFile}'; echo '${verdict}'` } };
    const rule = ['rule', 'small-index', '--content', 'Index pamäte tohto projektu smie mať 30 riadkov.', '--enforced-by', 'src/app.js'];
    let r = fx.run('save.mjs', rule, judge);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /conflicts with P-010/);
    assert.equal(fx.run('save.mjs', ['exception', 'P-010', '--wording', 'Index pamäte smie mať 30 riadkov.', '--reason', 'malý projekt'], judge).status, 0);
    r = fx.run('save.mjs', rule, judge);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('rules/small-index.md'));
    // the judge saw the principle in the wording of the exception
    const prompt = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt, /### P-010 \(výnimka projektu: project\)\nIndex pamäte smie mať 30 riadkov\./);
  } finally { fx.cleanup(); }
});

test('point 5: a bell turn runs done --topic its own handover orders; a handover without the step still refuses', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'd', '--task', 'T', '--done', 'x', '--next', 'po kontrole done --topic']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic d' });
    assert.equal(stateOf(fx.brain).turn_source, 'wake');
    const r = fx.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /continuation is set/);
    assert.ok(fx.exists('topics/archive/d/topic.json'));
  } finally { fx.cleanup(); }
  const fx2 = setup();
  try {
    assert.equal(fx2.run('topic.mjs', ['create', 'e', '--subject', 'E', '--class', 'discussion']).status, 0);
    assert.equal(fx2.run('save.mjs', ['handover', 'e', '--task', 'T', '--done', 'x', '--next', 'čakať na odpoveď']).status, 0);
    fx2.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic e' });
    assert.equal(stateOf(fx2.brain).turn_source, 'wake');
    const r = fx2.run('done.mjs', ['--topic', '--knowledge', 'nic nové', '--verified', 'tests pass']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /P-047/);
  } finally { fx2.cleanup(); }
});

test('point 5: a bell turn runs save.mjs promote its own handover orders (layout 2)', () => {
  const p = persona2();
  try {
    const stub = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
    const stubState = path.join(p.root, 'stub-state.json');
    fs.writeFileSync(stubState, '{}');
    Object.assign(p.env, { WORKFLOW_COMMS_CLIENT: stub, STUB_COMMS_STATE: stubState, STUB_COMMS_LOG: path.join(p.root, 'stub-log.jsonl') });
    assert.equal(p.run('topic.mjs', ['create', 't1', '--subject', 'Topic one', '--class', 'discussion']).status, 0);
    fs.writeFileSync(path.join(p.dir, 'temy', 't1', 'analyza.md'), '# Analyza\n\ntext\n');
    p.git(p.dir, 'add', '-A'); p.git(p.dir, 'commit', '-q', '--no-verify', '-m', 'topic file');
    const h = p.run('save.mjs', ['handover', 't1', '--task', 'T', '--done', 'analyza', '--next', 'save.mjs promote analyza.md']);
    assert.equal(h.status, 0, h.out);
    const file = path.join(p.dir, 'local', 'threads', 'p1.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no state yet */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...st, turn_source: 'wake', turn_started_at: new Date(Date.now() - 60_000).toISOString() }));
    const r = p.run('save.mjs', ['promote', 'analyza.md']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(p.dir, 'vystupy', 'dokumenty', 'analyza.md')));
  } finally { p.cleanup(); }
});

test('point 6: the yes of a dialog naming the branch lets git branch -d pass once, also when the dialog came first', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    fx.git(fx.project, 'branch', 'topic/x');
    fx.git(fx.project, 'branch', 'topic/y');
    const q = 'Zmazať vetvu topic/x?';
    fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, header: 'Vetva', options: [{ label: 'Áno' }, { label: 'Nie' }] }] }, tool_response: { answers: { [q]: 'Áno' } } });
    let out = pre(fx, 'Bash', { command: 'git branch -d topic/x' });
    assert.equal(out.permissionDecision, 'allow', out.permissionDecisionReason);
    assert.match(out.permissionDecisionReason, /granted by the operator's answer/);
    // once: the same call again needs a new yes
    out = pre(fx, 'Bash', { command: 'git branch -d topic/x' });
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /D-0042/);
    // the dialog named topic/x, not topic/y
    out = pre(fx, 'Bash', { command: 'git branch -d topic/y' });
    assert.equal(out.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('point 7: a worker brief of a thread with two topics may name the work folder of the second topic', () => {
  const fx = setup2();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Prvá', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 't2', '--subject', 'Druhá', '--class', 'discussion']).status, 0);
    const second = path.join(fx.brain, 'temy', 't2', 'tmp').split(path.sep).join('/');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'x', prompt: `Zisti x. Pracovné súbory iba do ${second}/, nie /tmp.` } });
    assert.notEqual(r.decision, 'deny', r.reason);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'x', prompt: 'Zisti x.' } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /no work-file path \(one of .*temy\/t1\/tmp\/.*temy\/t2\/tmp\/\)/);
  } finally { fx.cleanup(); }
});

test('point 8: every hook refusal is logged with time, hook, kind and reason; consolidate lists the most frequent kinds', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    for (const name of ['a.txt', 'b.txt']) {
      const out = pre(fx, 'Write', { file_path: path.join(fx.root, 'elsewhere', name), content: 'x\n' });
      assert.equal(out.permissionDecision, 'deny');
    }
    const lines = fs.readFileSync(path.join(fx.brain, 'local', 'denials.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.ok(l.t && l.event === 'PreToolUse' && l.reason, JSON.stringify(l));
      assert.equal(l.kind, 'target <path> is outside the project');
    }
    const r = fx.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^most frequent hook refusals in 7 d \(P-076: .*\): 2× PreToolUse P-052 "target <path> is outside the project"$/m);
    const d = fx.run('denials.mjs', []);
    assert.match(d.stdout, /^kinds: 2× PreToolUse P-052 "target <path> is outside the project"$/m);
  } finally { fx.cleanup(); }
});

test('point 9: a refusal names the way that passes: deny_commands without a reason, a global harness path', () => {
  assert.match(deniedCommand("sed -i 's/a/b/' f.txt", [{ match: 'sed -i' }]), /Edit \(after Read\).*Write/);
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const out = pre(fx, 'Write', { file_path: path.join(os.homedir(), '.claude', 'wf-test-p076-never-written.txt'), content: 'x\n' });
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /global path of the harness/);
    assert.match(out.permissionDecisionReason, /put the file in the work files .*Úlohy pre operátora/);
  } finally { fx.cleanup(); }
});
