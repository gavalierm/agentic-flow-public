#!/usr/bin/env node
// Harness adapter (P-017, P-015, P-048): generates native settings of a harness from policy.json.
//   adapter.mjs claude-code [--project <dir>] [--brain ../<brain-name>] [--channel stable|dev]
//   adapter.mjs codex       [--project <dir>] [--brain ../<brain-name>]
//   adapter.mjs --version
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, writeJson, shortSha, parseArgs, fail } from '../scripts/util.mjs';
import { enabledPluginsFor, channelOf, WORKFLOW_CONFIG, resolveTargetProject, ensureWorkflowConfig, brainExists, loadPolicy, expandBrainPath, PERSONA_BRAIN, SCRATCH_DIR, NO_BRAIN_NOTE } from '../scripts/config.mjs';
import { commitPersonaFiles } from '../scripts/persona.mjs';
import { syncBrainSkills, ensureGitignore } from '../scripts/skills-sync.mjs';
import { generateCodex } from '../adapters/codex/generate.mjs';

export const MANAGED_KEYS = ['enabledPlugins', 'autoMemoryEnabled', 'autoCompactWindow', 'permissions'];

/** Pure function: policy + brain relative path (null: no brain) -> project .claude/settings.json content. */
export function claudeSettings(policy, brainRel, channel = 'stable') {
  const deny = [];
  for (const p of policy.harness?.deny_paths || []) {
    // A bare deny pattern matches at any depth under the cwd (gitignore; Claude Code permissions docs): in a persona,
    // `Edit(rules/**)` and `Edit(README.md)` also denied rules/ and scripts/README.md of a code copy inside the project
    // (assist 2026-11-08). `/` anchors them at the project root, which is the persona's brain.
    for (const e of expandBrainPath(p, brainRel)) deny.push(`Edit(${brainRel === PERSONA_BRAIN && !/^[/~.]/.test(e) ? '/' : ''}${e})`);
  }
  deny.push('Edit(.claude/skills/**)');
  // Native ask: the whole command or the command followed by arguments (`git checkout --orphan` is not
  // `git checkout --`). Commands with safe forms (ask_commands_except) are left to the PreToolUse hook,
  // a native ask rule cannot express the exception (P-018, P-015). Restores are also left to the hook: it passes a
  // restore of the thread's own edits, a native rule would ask anyway (alice 2026-11-02: git checkout -- of own edits).
  const except = policy.harness?.ask_commands_except || [];
  const hookDecides = ['git checkout --', 'git restore'];
  const ask = (policy.harness?.ask_commands || [])
    .filter((c) => !hookDecides.includes(c) && !except.some((e) => e.startsWith(`${c} `)))
    .flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);
  return {
    enabledPlugins: enabledPluginsFor(channel),
    autoMemoryEnabled: policy.harness?.native_memory === true,
    autoCompactWindow: policy.compaction?.auto_compact_window_tokens ?? 200000,
    permissions: { deny, ask },
  };
}

/** P-053: default model of workers (subagents without an explicit model). */
export const SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';
export function subagentEnv(policy, existingEnv = {}) {
  const env = { ...(existingEnv && typeof existingEnv === 'object' ? existingEnv : {}) };
  const model = policy.subagents?.default_model;
  if (model) env[SUBAGENT_MODEL_ENV] = model;
  else delete env[SUBAGENT_MODEL_ENV];
  return env;
}

export function generateClaudeCode({ projectDir, brainRel: brainRelArg = null, channel: channelArg = null }) {
  const notes = [];
  const written = [];
  // .workflow.json
  const { brainInfo, written: cfgWritten } = ensureWorkflowConfig(projectDir, brainRelArg);
  if (cfgWritten) written.push(WORKFLOW_CONFIG);
  const brainDir = brainInfo && !brainInfo.error ? brainInfo.brain : null;
  const hasBrain = brainExists(brainDir);
  const policy = loadPolicy(hasBrain ? brainDir : null);

  // .claude/settings.json: managed keys replaced, other keys preserved.
  const settingsFile = path.join(projectDir, '.claude', 'settings.json');
  const existing = readJson(settingsFile, {});
  if (existing.permissions?.defaultMode) notes.push('removed permissions.defaultMode: it does not apply from project settings (P-015)');
  // Channel: explicit, else kept from existing settings, else stable (regeneration never switches a dev project back).
  const channel = channelArg || channelOf(existing) || 'stable';
  const generated = claudeSettings(policy, brainInfo?.brainRel ?? null, channel);
  notes.push(`channel ${channel}`);
  if (channel === 'dev' && !devPluginDirs().length) notes.push('channel dev: CLAUDE_CODE_PLUGIN_DIRS has no workflow plugin; sessions of this project load no workflow until the variable points to the dev clone (README, Vývojová verzia)');
  const merged = { ...existing };
  for (const k of MANAGED_KEYS) delete merged[k];
  const settings = { ...generated, ...merged, enabledPlugins: { ...(existing.enabledPlugins || {}), ...generated.enabledPlugins } };
  const env = subagentEnv(policy, existing.env);
  if (Object.keys(env).length) settings.env = env; else delete settings.env;
  // Keep a stable key order: managed keys first.
  const ordered = {};
  for (const k of MANAGED_KEYS) ordered[k] = settings[k];
  for (const [k, v] of Object.entries(settings)) if (!(k in ordered)) ordered[k] = v;
  writeJson(settingsFile, ordered);
  written.push('.claude/settings.json');

  fs.mkdirSync(path.join(projectDir, 'local'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, SCRATCH_DIR), { recursive: true });
  if (ensureGitignore(projectDir, ['.claude/skills/', 'local/', `${SCRATCH_DIR}/`])) written.push('.gitignore');
  if (hasBrain && brainInfo.persona) notes.push(commitPersonaFiles({ brainDir, policy, files: [WORKFLOW_CONFIG, '.claude/settings.json', '.gitignore'] }));

  if (hasBrain) {
    const sync = syncBrainSkills({ projectDir, brainDir });
    notes.push(`brain skills copied to .claude/skills/: ${sync.copied.length ? sync.copied.join(', ') : 'none'}`);
  } else if (!brainInfo) {
    notes.push(NO_BRAIN_NOTE.replace('<harness>', 'claude-code'));
  } else {
    notes.push(`brain not found at ${brainInfo.brainRel}; propose to the operator: node <plugin>/bin/brain-init.mjs ${brainInfo.brainRel} --project . (P-024)`);
  }
  return { written, notes, settings: ordered, brainRel: brainInfo?.brainRel ?? null, hasBrain, channel };
}

/** Workflow plugin directories listed in CLAUDE_CODE_PLUGIN_DIRS (absolute or ~ paths). */
export function devPluginDirs(value = process.env.CLAUDE_CODE_PLUGIN_DIRS || '') {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return value.split(path.delimiter).filter(Boolean).map((p) => (p.startsWith('~') ? path.join(home, p.slice(1)) : p)).filter((p) => {
    const m = readJson(path.join(p, '.claude-plugin', 'plugin.json'), null);
    return m?.name === 'workflow';
  });
}

if (process.argv[1]?.endsWith('adapter.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const [harness] = args._;
  if (args.version) {
    process.stdout.write(`workflow ${shortSha(PLUGIN_ROOT)}\n`);
    process.exit(0);
  }
  try {
    if (harness === 'claude-code') {
      const projectDir = resolveTargetProject(args.project);
      const res = generateClaudeCode({ projectDir, brainRel: typeof args.brain === 'string' ? args.brain : null, channel: typeof args.channel === 'string' ? args.channel : null });
      process.stdout.write(`generated in ${projectDir}:\n${res.written.map((w) => `- ${w}`).join('\n')}\n${res.notes.map((n) => `note: ${n}`).join('\n')}\n`);
      process.stdout.write(res.brainRel === '.' ? 'restart the session so the plugin loads\n' : `commit .claude/settings.json${res.brainRel ? ' and .workflow.json' : ''}; restart the session so the plugin loads\n`);
    } else if (harness === 'codex') {
      const projectDir = resolveTargetProject(args.project);
      const res = generateCodex({ projectDir, brainRel: typeof args.brain === 'string' ? args.brain : null });
      process.stdout.write(`generated in ${projectDir}:\n${res.written.map((w) => `- ${w}`).join('\n')}\n${res.notes.map((n) => `note: ${n}`).join('\n')}\n`);
      process.stdout.write(`commit .codex/config.toml, AGENTS.md${res.brainRel ? ' and .workflow.json' : ''} (hooks.json and .agents/skills/ stay local); confirm trust and hooks (/hooks) in Codex\n`);
    } else {
      fail('usage: adapter.mjs claude-code [--channel stable|dev] | codex [--project <dir>] [--brain ../<brain-name>] | --version');
    }
  } catch (err) {
    fail(err.message);
  }
}
