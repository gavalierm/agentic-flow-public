// MCP servers of the project (`.mcp.json`): Claude Code expands `${VAR}` there from the environment it was started with.
// A value only in the `env` of `.claude/settings.json` or `.claude/settings.local.json` reached Bash, but the server got the
// literal `${VAR}` and answered 401 (report-ef63d010, 2026-11-13). The boot names such references, so the agent does not
// debug the server; it never prints a value (P-018).
import fs from 'node:fs';
import path from 'node:path';

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Names `${NAME}` without a default (`${NAME:-x}`) referenced by each server of `.mcp.json`. */
export function mcpRefs(mcp) {
  const out = [];
  const servers = mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers ? mcp.mcpServers : {};
  for (const [name, server] of Object.entries(servers)) {
    const vars = new Set();
    for (const m of JSON.stringify(server ?? {}).matchAll(REF)) if (!m[2]) vars.add(m[1]);
    if (vars.size) out.push({ server: name, vars: [...vars].sort() });
  }
  return out;
}

/** Keys of `env` in the project settings files, by file. */
function settingsEnv(projectDir) {
  const out = {};
  for (const f of ['settings.json', 'settings.local.json']) {
    const env = readJson(path.join(projectDir, '.claude', f))?.env;
    if (env && typeof env === 'object') for (const k of Object.keys(env)) (out[k] ||= []).push(`.claude/${f}`);
  }
  return out;
}

/**
 * One boot line per server whose `${VAR}` will not be expanded: the name only in settings `env` (the hook sees it, the
 * expansion of `.mcp.json` did not), or not in the environment at all. Null without `.mcp.json` or without such a name.
 */
export function mcpEnvNote(projectDir, env = process.env) {
  if (!projectDir) return null;
  const mcp = readJson(path.join(projectDir, '.mcp.json'));
  if (!mcp) return null;
  const inSettings = settingsEnv(projectDir);
  const lines = [];
  for (const { server, vars } of mcpRefs(mcp)) {
    const bad = vars.filter((v) => inSettings[v] || !(v in env));
    if (!bad.length) continue;
    const why = bad.map((v) => (inSettings[v] ? `${v} (only in ${inSettings[v].join(', ')} env)` : `${v} (unset)`)).join(', ');
    lines.push(`mcp: server ${server} in .mcp.json gets the literal \${…} for ${why}; .mcp.json is expanded from the environment Claude Code started with, not from settings env (skill workflow:secrets)`);
  }
  return lines.length ? lines.join('\n') : null;
}
