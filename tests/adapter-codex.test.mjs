// keep: core
// P-017, P-015, P-042, P-038: Codex adapter and its hook translator (M7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { claudeSettings } from '../bin/adapter.mjs';
import { codexConfig, codexHooks, agentsBlock, AGENTS_BEGIN, AGENTS_END, CONFIG_HEADER } from '../adapters/codex/generate.mjs';
import { toToml, parseToml } from '../adapters/codex/toml.mjs';
import { loadPolicy } from '../scripts/config.mjs';

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const ABSOLUTE = [/\/home\/\w/, /\/Users\/\w/, /\/root\/\w/, /\/tmp\/\w/, /[A-Za-z]:\/\w/, /[A-Za-z]:\\[A-Za-z]{2,}/];

function codexHook(fx, event, input, env = {}) {
  const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'adapters', 'codex', 'hook.mjs'), event], {
    cwd: fx.project, env: { ...fx.env, ...env }, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: fx.project, ...input }),
  });
  let json = {};
  try { json = JSON.parse(res.stdout.trim() || '{}'); } catch { json = { raw: res.stdout }; }
  return { status: res.status, json, stderr: res.stderr, context: json.hookSpecificOutput?.additionalContext || '' };
}

test('generated config.toml, hooks.json, AGENTS.md and .agents/skills match policy and source; local files gitignored', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'x-api'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'x-api', 'SKILL.md'), '---\nname: x-api\ndescription: Použi pri X\norigin: error\n---\nx\n');
    fs.writeFileSync(path.join(fx.project, 'AGENTS.md'), '# Projekt\n\nVlastné pokyny.\n');
    const r = fx.run('adapter.mjs', ['codex']);
    assert.equal(r.status, 0, r.out);

    // config.toml: valid TOML equal to the policy translation
    const tomlText = read(fx.project, '.codex/config.toml');
    assert.ok(tomlText.startsWith(CONFIG_HEADER));
    const config = parseToml(tomlText);
    assert.deepEqual(config, codexConfig(loadPolicy(fx.brain), '../brain'));
    assert.equal(config.features.hooks, true);
    assert.equal(config.features.memories, false);
    assert.equal(config.model_auto_compact_token_limit, 200000);
    assert.match(config.compact_prompt, /stav/);
    assert.equal(config.default_permissions, 'workflow');
    assert.equal(config.permissions.workflow.filesystem['../brain/**'], 'deny');
    assert.equal(config.permissions.workflow.filesystem['~/.claude/**'], 'deny');
    assert.equal(config.permissions.workflow.filesystem[':workspace_roots']['.agents/skills/**'], 'deny');

    // hooks.json: every Claude event except PostToolUseFailure, node commands, existing scripts, SessionStart unlimited
    const hooks = JSON.parse(read(fx.project, '.codex/hooks.json'));
    assert.deepEqual(hooks, codexHooks(PLUGIN_ROOT));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const g of groups) for (const h of g.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.args, undefined, 'Codex hooks.json has no args field');
        const m = /^node "([^"]+)"( [a-z-]+)?$/.exec(h.command);
        assert.ok(m, `${event}: ${h.command}`);
        assert.ok(fs.existsSync(m[1]), `${event}: script exists`);
        assert.ok(typeof h.timeout === 'number');
      }
    }
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /adapters\/codex\/hook\.mjs" session-start$/);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].additionalContextLimit, 0);
    assert.match(hooks.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs" pre-tool-use$/);
    assert.match(hooks.hooks.Stop[0].hooks[0].command, /hook\.mjs" stop$/);
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /hooks\/user-prompt-submit\.mjs"$/);
    assert.ok(hooks.hooks.Stop[0].hooks[0].command.includes(PLUGIN_ROOT), 'local file carries the plugin path');

    // AGENTS.md: existing content preserved, managed block equals the assembled rules
    const agents = read(fx.project, 'AGENTS.md');
    assert.ok(agents.startsWith('# Projekt\n\nVlastné pokyny.\n'));
    assert.ok(agents.includes(AGENTS_BEGIN) && agents.trimEnd().endsWith(AGENTS_END));
    assert.match(agents, /### P-001/); assert.match(agents, /WORKFLOW_THREAD_ID/); assert.match(agents, /lehotu \(TTL\)/);
    const rules = fx.run('rules.mjs', ['--harness', 'codex']).stdout;
    assert.ok(agents.includes(agentsBlock(rules, '../brain')));

    // committed files: no absolute paths (P-004); local files listed in .gitignore
    for (const rel of ['.codex/config.toml', 'AGENTS.md', '.workflow.json']) {
      const text = read(fx.project, rel);
      for (const re of ABSOLUTE) assert.doesNotMatch(text, re, `${rel}: absolute path`);
    }
    const gi = read(fx.project, '.gitignore');
    for (const e of ['.codex/hooks.json', '.agents/skills/', 'local/']) assert.match(gi, new RegExp(`^${e.replace(/[./]/g, '\\$&')}$`, 'm'));
    const status = fx.git(fx.project, 'status', '--porcelain');
    assert.ok(!/\.codex\/hooks\.json|\.agents\//.test(status), status);

    // .agents/skills: workflow skills with the plugin path substituted + brain skills, no symlinks
    const skillsDir = path.join(fx.project, '.agents', 'skills');
    for (const s of ['save', 'topic', 'done', 'comms', 'delegate', 'x-api']) {
      assert.ok(fs.existsSync(path.join(skillsDir, s, 'SKILL.md')), s);
      assert.ok(!fs.lstatSync(path.join(skillsDir, s)).isSymbolicLink());
    }
    const save = read(skillsDir, 'save/SKILL.md');
    assert.ok(!save.includes('${CLAUDE_PLUGIN_ROOT}'));
    assert.ok(save.includes(`${PLUGIN_ROOT}/bin/save.mjs`));

    // second run is idempotent; a foreign config.toml is refused
    const again = fx.run('adapter.mjs', ['codex']);
    assert.equal(again.status, 0, again.out);
    assert.equal(read(fx.project, 'AGENTS.md'), agents);
    assert.equal(read(fx.project, '.codex/config.toml'), tomlText);
    fs.writeFileSync(path.join(fx.project, '.codex', 'config.toml'), 'model = "x"\n');
    const foreign = fx.run('adapter.mjs', ['codex']);
    assert.equal(foreign.status, 1); assert.match(foreign.stderr, /not generated by workflow/);
  } finally { fx.cleanup(); }
});

test('codex PreToolUse: apply_patch into brain denied, project file allowed, ask becomes deny with a way out', () => {
  const fx = setup();
  try {
    const patch = (op, file) => ({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** ${op}: ${file}\n+x\n*** End Patch` } });
    let r = codexHook(fx, 'pre-tool-use', patch('Add File', '../brain/memory/x.md'));
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /brain/);
    r = codexHook(fx, 'pre-tool-use', patch('Update File', '.agents/skills/save/SKILL.md'));
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    r = codexHook(fx, 'pre-tool-use', patch('Add File', 'src/new.js'));
    assert.deepEqual(r.json, {});
    fs.writeFileSync(path.join(fx.project, 'untracked.txt'), 'a\nb\n');
    r = codexHook(fx, 'pre-tool-use', patch('Delete File', 'untracked.txt'));
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /untracked.*Codex cannot ask/s);
    r = codexHook(fx, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /rewrites or drops git history/);
    r = codexHook(fx, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.deepEqual(r.json, {});
  } finally { fx.cleanup(); }
});
