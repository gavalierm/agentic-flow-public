// ttl: 2026-12-17
// flow-public#99: rm -rf of an untracked clone of another repo in the brain root (`?? comms/`) was refused as a shell write
// into the brain (P-013): the target was classified in its own repo ("tracked and clean"). The root of a nested repo is a
// path of the outer repo: untracked there, so the step is a data-protection consent (P-018), as for any untracked folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { persona2 } from './layout-2-helpers.mjs';

test('rm of an untracked nested clone in the brain: a consent with its target, not a brain write refusal', () => {
  const fx = persona2();
  try {
    const clone = path.join(fx.dir, 'comms');
    fs.mkdirSync(clone);
    for (const a of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']]) spawnSync('git', a, { cwd: clone });
    fx.hook('user-prompt-submit.mjs', { prompt: 'zmaž ten klon' }, { env: { WORKFLOW_DRIFT_JUDGE: 'off' } });
    assert.match(spawnSync('git', ['status', '--porcelain'], { cwd: fx.dir, encoding: 'utf8' }).stdout, /\?\? comms\//);
    const d = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `rm -rf ${clone}` } }).json.hookSpecificOutput || {};
    assert.equal(d.permissionDecision, 'deny');
    assert.doesNotMatch(d.permissionDecisionReason, /shell write into brain/);
    assert.match(d.permissionDecisionReason, /not recoverable from git/);
    assert.ok(d.permissionDecisionReason.includes(`"${clone}"`), d.permissionDecisionReason);
  } finally { fx.cleanup(); }
});
