// Layers of policy, rules and skills in a domain (D-0016, D-0025): plugin -> domain brain -> project layer (the project's
// own brain when it is another one, then <repo>/agentic/). The project layer may only tighten; outside a domain the
// project brain is the only layer, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject, PLUGIN_ROOT } from './helpers.mjs';
import { tightenPolicy, policyIgnoredLine } from '../scripts/policy-layers.mjs';
import { loadContext, loadPolicy, resolveDomain } from '../scripts/config.mjs';
import { ruleCorpus } from '../scripts/rule-gate.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-verify', '-m', msg); };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const putJson = (file, v) => put(file, `${JSON.stringify(v, null, 2)}\n`);
const real = (p) => fs.realpathSync(p);
const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const plugin = loadPolicy(null);

/**
 * Domain `<root>` (marker brain "brain", the domain brain), repo `repo-a` with its own brain `brain-a` (the project brain,
 * pushed to its own origin) and knowledge branch main.
 */
function domFx() {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const repoA = path.join(fx.root, 'repo-a');
  const brainA = path.join(fx.root, 'brain-a');
  initProject(repoA, { brainRel: '../brain-a' });
  putJson(path.join(repoA, '.workflow.json'), { brain: '../brain-a', knowledge_branch: 'main' });
  commit(repoA, 'knowledge branch');
  const originA = path.join(fx.root, 'origin-a.git');
  git(fx.root, 'init', '-q', '--bare', '-b', 'main', originA);
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brainA, '--remote', originA], { env: fx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
  git(brainA, 'config', 'user.name', 't');
  git(brainA, 'config', 'user.email', `t${'@'}t`);
  return { fx, repoA, brainA };
}

const ctxOf = (dir) => loadContext({ project: dir, requireBrain: false });

test('tightenPolicy: union adds, intersect only drops, limits only lower, other keys ignored with the report line', () => {
  const base = { harness: { denied_tools: ['a'], ask_commands_except: ['x', 'y'], native_memory: false }, limits: { handover_lines: 15 }, subagents: { default_model: 'haiku' } };
  const { policy, ignored } = tightenPolicy(base, {
    harness: { denied_tools: ['b'], ask_commands_except: ['x', 'z'], native_memory: true },
    limits: { handover_lines: 20, rules_chars: 5 },
    subagents: { default_model: 'opus' },
  });
  assert.deepEqual(policy.harness.denied_tools, ['a', 'b']);
  assert.deepEqual(policy.harness.ask_commands_except, ['x']);
  assert.equal(policy.harness.native_memory, false);
  assert.equal(policy.limits.handover_lines, 15);
  assert.equal(policy.subagents.default_model, 'haiku');
  assert.deepEqual(base.harness.denied_tools, ['a'], 'base is not changed');
  assert.deepEqual(ignored.map((i) => i.key).sort(), ['harness.ask_commands_except', 'harness.native_memory', 'limits.handover_lines', 'limits.rules_chars', 'subagents.default_model']);
  assert.match(policyIgnoredLine(ignored.map((i) => ({ ...i, source: 'brain-a/policy.json' }))), /^policy: project layer ignored \(only tightening\): .*limits\.handover_lines \(raises 15 to 20, brain-a\/policy\.json\)/);
  assert.equal(policyIgnoredLine([]), null);
  assert.deepEqual(tightenPolicy(base, { harness: { denied_tools: [] } }).policy.harness.denied_tools, ['a'], 'an empty list removes nothing');
});

test('policy layers: the project layer adds bans; plugin and domain bans stay; no allow is added', () => {
  const { fx, repoA, brainA } = domFx();
  try {
    putJson(path.join(fx.brain, 'policy.json'), { harness: { denied_tools: ['t3_thread_send', 'EnterWorktree', 'DomTool'] }, domain: { allow_outside: ['~/dom-x', 'sudo'] } });
    commit(fx.brain, 'domain policy');
    putJson(path.join(brainA, 'policy.json'), { harness: { denied_tools: ['ToolA'], ask_commands: [], ask_commands_except: ['git clean -n', 'git reset --hard HEAD'] }, domain: { allow_outside: ['~/dom-x', '~/dom-y'] } });
    commit(brainA, 'project policy');
    putJson(path.join(repoA, 'agentic', 'policy.json'), { harness: { ask_commands: ['npm publish'] } });
    commit(repoA, 'repo policy');
    const ctx = ctxOf(repoA);
    assert.equal(ctx.layers.inDomain, true);
    assert.deepEqual(ctx.policy.harness.denied_tools, ['t3_thread_send', 'EnterWorktree', 'DomTool', 'ToolA']);
    assert.deepEqual(ctx.policy.harness.ask_commands, [...plugin.harness.ask_commands, 'npm publish'], 'nothing removed, the repo ban added');
    assert.deepEqual(ctx.policy.harness.ask_commands_except, ['git clean -n'], 'no exception added, the unlisted ones dropped');
    assert.deepEqual(ctx.domain.allowOutside, [path.join(os.homedir(), 'dom-x')]);
    assert.equal(ctx.domain.sudo, false, 'the layer kept only ~/dom-x');
    assert.deepEqual(ctx.policyIgnored.map((i) => `${i.key} ${i.source}`), ['harness.ask_commands_except brain-a/policy.json', 'domain.allow_outside brain-a/policy.json']);
    assert.match(ctx.policyIgnored[0].why, /adds git reset --hard HEAD/);
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'ToolA', tool_input: {} }, { cwd: repoA });
    assert.equal(decision(r), 'deny', 'ban of the project brain');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'DomTool', tool_input: {} }, { cwd: repoA });
    assert.equal(decision(r), 'deny', 'ban of the domain brain');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { cwd: repoA });
    assert.equal(decision(r), 'deny', 'ask of the repo layer');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' } }, { cwd: repoA });
    assert.equal(decision(r), 'deny', 'the exception the layer tried to add is not applied');
  } finally { fx.cleanup(); }
});

test('policy layers: a limit can be lowered, not raised; model and command keys are ignored and reported at start and by the adapter', () => {
  const { fx, repoA, brainA } = domFx();
  try {
    putJson(path.join(brainA, 'policy.json'), { limits: { handover_lines: 10, rules_chars: 20000 }, subagents: { default_model: 'opus' }, thread_title: { command: 'echo x' } });
    commit(brainA, 'project policy');
    const ctx = ctxOf(repoA);
    assert.equal(ctx.policy.limits.handover_lines, 10);
    assert.equal(ctx.policy.limits.rules_chars, plugin.limits.rules_chars);
    assert.equal(ctx.policy.subagents.default_model, plugin.subagents.default_model);
    assert.deepEqual(ctx.policy.thread_title, plugin.thread_title);
    const line = /policy: project layer ignored \(only tightening\): limits\.rules_chars \(raises 10000 to 20000, brain-a\/policy\.json\), subagents\.default_model \(not a tightening key, brain-a\/policy\.json\), thread_title\.command \(not a tightening key, brain-a\/policy\.json\)/;
    const start = fx.hook('session-start.mjs', { source: 'startup' }, { cwd: repoA });
    assert.match(start.context, line);
    const r = fx.run('adapter.mjs', ['claude-code'], { cwd: repoA });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, line);
    const settings = JSON.parse(fs.readFileSync(path.join(repoA, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, plugin.subagents.default_model, 'the adapter writes the composed policy');
  } finally { fx.cleanup(); }
});

test('policy layers: outside a domain the project brain policy applies as before', () => {
  const fx = setup();
  try {
    putJson(path.join(fx.brain, 'policy.json'), { limits: { rules_chars: 20000 }, subagents: { default_model: 'opus' }, harness: { denied_tools: ['OnlyThis'] } });
    commit(fx.brain, 'policy');
    const ctx = ctxOf(fx.project);
    assert.equal(ctx.layers.inDomain, false);
    assert.equal(ctx.policy.limits.rules_chars, 20000);
    assert.equal(ctx.policy.subagents.default_model, 'opus');
    assert.deepEqual(ctx.policy.harness.denied_tools, ['OnlyThis']);
    assert.deepEqual(ctx.policyIgnored, []);
    assert.doesNotMatch(fx.hook('session-start.mjs', { source: 'startup' }).context, /project layer ignored/);
  } finally { fx.cleanup(); }
});

test('rules: plugin core, domain brain, project brain, repo; exceptions only from the domain brain; limits over the whole text', () => {
  const { fx, repoA, brainA } = domFx();
  const rule = (key, body) => `---\nkey: rule-${key}\ntitle: ${key}\n---\n${body}\n`;
  try {
    put(path.join(fx.brain, 'rules', 'dom-rule.md'), rule('dom-rule', 'Domain rule body.'));
    put(path.join(brainA, 'rules', 'a-rule.md'), rule('a-rule', 'Project rule body.'));
    put(path.join(repoA, 'agentic', 'rules', 'repo-rule.md'), rule('repo-rule', 'Repo rule body.'));
    put(path.join(fx.brain, 'exceptions', 'project.md'), '### P-026\nZnenie: dom wording of P-026.\nDôvod: test.\n');
    put(path.join(brainA, 'exceptions', 'project.md'), '### P-059\nZnenie: brain-a wording.\nDôvod: test.\n');
    put(path.join(repoA, 'agentic', 'exceptions', 'x.md'), '### P-061\nZnenie: repo wording.\nDôvod: test.\n');
    const r = fx.run('rules.mjs', [], { cwd: repoA });
    assert.equal(r.status, 0, r.out);
    const t = r.stdout;
    const at = (s) => { const i = t.indexOf(s); assert.ok(i >= 0, `missing ${s}`); return i; };
    assert.ok(at('### P-001') < at('Pravidlá domény') && at('Pravidlá domény') < at('Domain rule body.'));
    assert.ok(at('Domain rule body.') < at('Project rule body.') && at('Project rule body.') < at('Pravidlá repa repo-a') && at('Pravidlá repa repo-a') < at('Repo rule body.'));
    assert.match(t, /P-026[^\n]*\(výnimka: project\)\ndom wording of P-026\./);
    assert.doesNotMatch(t, /brain-a wording|repo wording/);
    assert.match(t, /Odmietnuté výnimky: .*brain-a\/exceptions\/project\.md: the project layer has no exceptions.*repo-a\/agentic\/exceptions\/x\.md: the project layer has no exceptions/);
    const check = fx.run('rules.mjs', ['--check'], { cwd: repoA });
    assert.match(check.stdout, new RegExp(`rules: \\d+ lines, ${t.length} chars`), 'the limit counts every layer');
    // the rule gate judges a new rule against every layer of the repo session (a repo rule as <repo>/<name>)
    const corpus = ruleCorpus({ brainDir: brainA, layers: ctxOf(repoA).layers }).filter((c) => c.source !== 'workflow');
    assert.deepEqual(corpus.map((c) => `${c.id} ${c.source}`), ['dom-rule project', 'a-rule project', 'repo-a/repo-rule repo']);
    // the domain brain's own session: its rules are the project rules, no repo layer
    const own = fx.run('rules.mjs', [], { cwd: fx.project }).stdout;
    assert.match(own, /Pravidlá projektu \(brain `rules\/`\):\n\n### dom-rule\nDomain rule body\./);
    assert.doesNotMatch(own, /Project rule body|Repo rule body|Odmietnuté/);
  } finally { fx.cleanup(); }
});

test('save rule --repo writes <repo>/agentic/rules/<name>.md into the repo, --enforced-by finds the repo file, --remove removes it', () => {
  const { fx, repoA } = domFx();
  try {
    put(path.join(repoA, 'tools', 'guard.sh'), '#!/bin/sh\n# guard-gen\n');
    commit(repoA, 'guard');
    const brainHead = git(fx.brain, 'rev-parse', 'HEAD');
    const args = ['rule', 'gen-files', '--content', 'Agent NESMIE ručne meniť generované súbory repa.', '--enforced-by', 'tools/guard.sh:guard-gen'];
    let r = fx.run('save.mjs', args);
    assert.notEqual(r.status, 0, 'without --repo the repo file is not found');
    assert.match(r.out, /tools\/guard\.sh not found in the workflow, the project or brain/);
    r = fx.run('save.mjs', [...args, '--repo', 'repo-a']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /written: repo-a\/agentic\/rules\/gen-files\.md \(repo-a [0-9a-f]+\) \[main, not pushed\]/);
    assert.deepEqual(git(repoA, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['agentic/rules/gen-files.md']);
    assert.match(fs.readFileSync(path.join(repoA, 'agentic', 'rules', 'gen-files.md'), 'utf8'), /key: rule-gen-files[\s\S]*tools\/guard\.sh:guard-gen/);
    assert.equal(git(fx.brain, 'rev-parse', 'HEAD'), brainHead, 'brain untouched');
    assert.match(fx.run('rules.mjs', [], { cwd: repoA }).stdout, /Pravidlá repa repo-a[^\n]*\n\n### gen-files\nAgent NESMIE ručne meniť generované súbory repa\./);
    r = fx.run('save.mjs', ['rule', 'gen-files', '--repo', 'repo-a', '--remove', '--reason', 'test removal']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(repoA, 'agentic', 'rules', 'gen-files.md')), false);
    assert.equal(git(repoA, 'log', '-1', '--format=%s'), '[brain-script] remove rule gen-files: test removal');
  } finally { fx.cleanup(); }
});

test('.workflow.json gets domain; a mismatch is an error with both paths; a code topic copy finds the same domain', () => {
  const { fx, repoA } = domFx();
  try {
    let r = fx.run('adapter.mjs', ['claude-code'], { cwd: repoA });
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoA, '.workflow.json'), 'utf8')).domain, '..');
    commit(repoA, 'domain');
    const wt = path.join(fx.root, '.worktrees', 'repo-a', 't1');
    git(repoA, 'worktree', 'add', '-q', '-b', 'topic/t1', wt);
    assert.equal(real(resolveDomain(wt).root), real(fx.root), 'the copy resolves domain against the main checkout');
    const other = path.join(fx.root, 'dom-other');
    put(path.join(other, '.agentic-domain'), '{"brain":"b"}');
    putJson(path.join(repoA, '.workflow.json'), { brain: '../brain-a', knowledge_branch: 'main', domain: 'dom-other' });
    assert.throws(() => resolveDomain(repoA), (err) => err.message.includes(path.join(repoA, 'dom-other')) && err.message.includes('no .agentic-domain') && err.message.includes(fx.root));
    putJson(path.join(repoA, '.workflow.json'), { brain: '../brain-a', knowledge_branch: 'main', domain: '../dom-other' });
    assert.throws(() => resolveDomain(repoA), (err) => err.message.includes(other) && err.message.includes(fx.root) && /fix "domain"/.test(err.message));
    r = fx.run('adapter.mjs', ['claude-code'], { cwd: repoA });
    assert.notEqual(r.status, 0);
    assert.ok(r.out.includes(other) && r.out.includes(fx.root), r.out);
    assert.match(fx.hook('session-start.mjs', { source: 'startup' }, { cwd: repoA }).context, /domain: domain "\.\.\/dom-other"/, 'a hook reports it, keeps the domain above');
  } finally { fx.cleanup(); }
});

test('skills: a domain brain skill reaches a project with its own brain; a project skill with the same name is an error', () => {
  const { fx, repoA, brainA } = domFx();
  const skill = (name) => `---\nname: ${name}\ndescription: Use when testing layers.\norigin: routine\n---\n# ${name}\n`;
  try {
    put(path.join(fx.brain, 'skills', 'agentic', 'dom-skill', 'SKILL.md'), skill('dom-skill'));
    put(path.join(brainA, 'skills', 'agentic', 'a-skill', 'SKILL.md'), skill('a-skill'));
    let r = fx.run('adapter.mjs', ['claude-code'], { cwd: repoA });
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(repoA, '.claude', 'skills', 'dom-skill', 'SKILL.md')), 'domain brain skill deployed');
    assert.ok(fs.existsSync(path.join(repoA, '.claude', 'skills', 'a-skill', 'SKILL.md')), 'project brain skill deployed');
    put(path.join(brainA, 'skills', 'agentic', 'dom-skill', 'SKILL.md'), skill('dom-skill'));
    r = fx.run('adapter.mjs', ['claude-code'], { cwd: repoA });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /project brain skill name\(s\) collide with domain brain skills: dom-skill/);
  } finally { fx.cleanup(); }
});
