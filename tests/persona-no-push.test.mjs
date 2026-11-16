// ttl: 2026-12-16
// A migration runs the adapter of a persona (its brain is the repo it moved) before its check: the adapter's commit of the
// generated files pushed the move too (agent-bob 2026-11-16, release-2.0 step 4: push only after the check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).stdout.trim();

test('WORKFLOW_NO_PUSH: the persona commit of the adapter stays local', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-np-'));
  const old = process.env.WORKFLOW_NO_PUSH;
  try {
    const origin = path.join(base, 'p.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    const brain = path.join(base, 'p');
    const init = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brain, '--remote', origin], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const before = git(origin, 'rev-parse', 'main');
    fs.writeFileSync(path.join(brain, '.workflow.json'), JSON.stringify({ brain: '.' }) + '\n');
    const { commitPersonaFiles } = await import('../scripts/persona.mjs');
    process.env.WORKFLOW_NO_PUSH = '1';
    const line = commitPersonaFiles({ brainDir: brain, policy: {}, files: ['.workflow.json'] });
    assert.match(line, /committed \(\w+, not pushed\)/, line);
    assert.equal(git(origin, 'rev-parse', 'main'), before, 'origin unchanged');
    assert.equal(git(brain, 'rev-list', '--count', 'origin/main..HEAD'), '1');
  } finally {
    if (old === undefined) delete process.env.WORKFLOW_NO_PUSH; else process.env.WORKFLOW_NO_PUSH = old;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
