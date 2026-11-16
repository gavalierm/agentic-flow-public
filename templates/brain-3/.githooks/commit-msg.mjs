// Thin shim (P-040): calls the check script of the installed workflow plugin with the commit message file.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = process.env.WORKFLOW_PLUGIN_ROOT || path.join(os.homedir(), '.claude', 'skills', 'workflow');
const script = path.join(root, 'bin', 'brain-precommit.mjs');
if (!fs.existsSync(script)) {
  process.stderr.write(`brain commit-msg: workflow plugin not found at ${root} (clone it to ~/.claude/skills/workflow or set WORKFLOW_PLUGIN_ROOT)\n`);
  process.exit(1);
}
const res = spawnSync(process.execPath, [script, 'commit-msg', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
