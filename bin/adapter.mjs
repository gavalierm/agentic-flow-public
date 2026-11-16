#!/usr/bin/env node
// Harness adapter (P-017, P-015, P-048): generates native settings of a harness from policy.json.
//   adapter.mjs claude-code [--project <dir>] [--brain ../<brain-name>] [--channel stable|dev]
//   adapter.mjs codex       [--project <dir>] [--brain ../<brain-name>]
//   adapter.mjs --version
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson, writeJson, shortSha, parseArgs, fail } from '../scripts/util.mjs';
import { loadContext, enabledPluginsFor, channelOf, WORKFLOW_CONFIG, resolveTargetProject, ensureWorkflowConfig, brainExists, expandBrainPath, PERSONA_BRAIN, NO_BRAIN_NOTE, projectPolicy, resolveDomain } from '../scripts/config.mjs';
import { policyIgnoredLine } from '../scripts/policy-layers.mjs';
import { commitPersonaFiles } from '../scripts/persona.mjs';
import { syncBrainSkills, ensureGitignore, crontabSkillNotes } from '../scripts/skills-sync.mjs';
import { adapterSkillSources } from '../scripts/repo-knowledge.mjs';
import { generateCodex } from '../adapters/codex/generate.mjs';
import { ensureIssueWatchJob, ensureTimerCheckJob, ensureOverviewJob } from '../scripts/wake-job.mjs';
import { dataPath, dataRel, workIgnoreLine } from '../scripts/layout.mjs';
import { workDir } from '../scripts/topic-files.mjs';
import { threadId } from '../scripts/config.mjs';

export const MANAGED_KEYS = ['enabledPlugins', 'autoMemoryEnabled', 'autoCompactWindow', 'permissions'];

/** Pure function: policy + brain relative path (null: no brain) -> project .claude/settings.json content. */
export function claudeSettings(policy, brainRel, channel = 'stable') {
  // No native deny (D-0011): 52 of 65 refusals of the `Edit(<path>)` patterns were false (reads, work after `cd`), the
  // PreToolUse hook refuses the same writes (brain P-013, `.claude/skills/` P-017, `~/.claude` P-014) for every tool.
  // `harness.deny_paths` stays in the policy for the hook and the Codex adapter.
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
    permissions: { ask },
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
  // The composed policy of the project (D-0025): settings come from what the domain and the project layer allow.
  const composed = projectPolicy({ projectDir, brainDir: hasBrain ? brainDir : null, domain: resolveDomain(projectDir) });
  const policy = composed.policy;
  const ignoredLine = policyIgnoredLine(composed.ignored);
  if (ignoredLine) notes.push(ignoredLine);

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
  // The operator's own allow rules (a narrow exception for one tool, flow-public#96) survive regeneration; the workflow
  // manages only `ask`. The agent never writes them: consent in a dialog does not become a rule (P-054).
  const allow = Array.isArray(existing.permissions?.allow) ? existing.permissions.allow.filter((r) => typeof r === 'string') : [];
  if (allow.length) settings.permissions = { ...generated.permissions, allow };
  const env = subagentEnv(policy, existing.env);
  if (Object.keys(env).length) settings.env = env; else delete settings.env;
  // Keep a stable key order: managed keys first.
  const ordered = {};
  for (const k of MANAGED_KEYS) ordered[k] = settings[k];
  for (const [k, v] of Object.entries(settings)) if (!(k in ordered)) ordered[k] = v;
  writeJson(settingsFile, ordered);
  written.push('.claude/settings.json');

  fs.mkdirSync(dataPath(projectDir, 'local'), { recursive: true });
  // Work files (P-052): layout 1 scratch/, layout 2 temy/<topic>/tmp/ of the held topic (main without one), both ignored.
  fs.mkdirSync(workDir({ projectDir, brainDir: hasBrain ? brainDir : null, thread: threadId() }), { recursive: true });
  if (ensureGitignore(projectDir, ['.claude/skills/', `${dataRel(projectDir, 'local')}/`, workIgnoreLine(projectDir)])) written.push('.gitignore');
  if (hasBrain && brainInfo.persona) notes.push(commitPersonaFiles({ brainDir, policy, files: [WORKFLOW_CONFIG, '.claude/settings.json', '.gitignore'] }));

  if (hasBrain) {
    // Repo skills (<repo>/agentic/skills) too: without them every deploy removed them until the next start or save (mojprojekt-web 2026-11-09).
    const sync = syncBrainSkills({ projectDir, brainDir, repoSources: adapterSkillSources(projectDir, brainDir), domainBrainDir: composed.layers.projectBrain ? composed.layers.domainBrain : null });
    notes.push(`brain skills copied to .claude/skills/: ${sync.copied.length ? sync.copied.join(', ') : 'none'}`);
    // Deploy references outside skills (D-0065): crontab lines with the old unprefixed skill path; warned, never changed.
    notes.push(...crontabSkillNotes(projectDir, sync).map((w) => `warning: ${w}`));
    notes.push(...sync.warnings.map((w) => `warning: ${w}`));
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
      // The reporter's issue check (D-0024): job issue-watch in this machine's wake.json; one job for all projects.
      try { process.stdout.write(`note: ${ensureIssueWatchJob(loadContext({ project: projectDir, requireBrain: false })).line}\n`); } catch (err) { process.stdout.write(`note: wake job issue-watch not written (${err.message})\n`); }
      // Conditional thread timers checked before their ring (P-061): job timer-check.
      try { process.stdout.write(`note: ${ensureTimerCheckJob(loadContext({ project: projectDir, requireBrain: false })).line}\n`); } catch (err) { process.stdout.write(`note: wake job timer-check not written (${err.message})\n`); }
      // The supervisor's overview without an agent (spec 3.9, plan B6): job overview, one for the machine.
      try { process.stdout.write(`note: ${ensureOverviewJob(loadContext({ project: projectDir, requireBrain: false })).line}\n`); } catch (err) { process.stdout.write(`note: wake job overview not written (${err.message})\n`); }
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
