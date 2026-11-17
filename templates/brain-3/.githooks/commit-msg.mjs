// Thin shim (P-040): calls the check script of the installed workflow plugin with the commit message file.
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = process.env.WORKFLOW_PLUGIN_ROOT || path.join(os.homedir(), '.claude', 'skills', 'workflow');
const script = path.join(root, 'bin', 'brain-precommit.mjs');
if (!fs.existsSync(script)) {
  process.stderr.write(`brain commit-msg: workflow plugin not found at ${root} (clone it to ~/.claude/skills/workflow or set WORKFLOW_PLUGIN_ROOT)\n`);
  process.exit(1);
}
// In this process (P-079): the check runs as its own main (argv[1] is the script); its exit code is the hook's.
process.argv = [process.argv[0], script, 'commit-msg', ...process.argv.slice(2)];
await import(pathToFileURL(script).href);
