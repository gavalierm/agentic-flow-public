// keep: core
// P-040: brain pre-commit / commit-msg shims reject manual commits and invalid content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

function commit(fx, message, { script = false } = {}) {
  const env = { ...fx.env };
  if (script) env.WORKFLOW_BRAIN_SCRIPT = '1';
  const r = spawnSync('git', ['commit', '-q', '-m', message], { cwd: fx.brain, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

function stage(fx, rel, content) {
  const file = path.join(fx.brain, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  spawnSync('git', ['add', '-f', rel], { cwd: fx.brain });
}

test('manual commit without the script marker is rejected', () => {
  const fx = setup();
  try {
    stage(fx, 'memory/operator-operator.md', '---\nkey: operator-operator\norigin: operator\n---\nx\n');
    const r = commit(fx, '[brain-script] manual');
    assert.equal(r.status, 1);
    assert.match(r.out, /not made by the brain script/);
  } finally { fx.cleanup(); }
});

test('file in local/, handover without a section, exception without ID, agentic skill without origin are rejected', () => {
  const fx = setup();
  try {
    stage(fx, 'local/index/x.md', 'x');
    let r = commit(fx, '[brain-script] x', { script: true });
    assert.equal(r.status, 1); assert.match(r.out, /local\//);
    spawnSync('git', ['reset', '-q'], { cwd: fx.brain });

    // no line limit (agent-alice/D-0094): the sections are checked, not the count of lines
    stage(fx, 'topics/t/handover.md', ['## Zadanie', 'a', '## Hotové', '-', '## Ďalší krok', '-', '## Otvorené otázky', '-', '1', '2', '3', '4', '5', '6', '7', '8'].join('\n') + '\n');
    r = commit(fx, '[brain-script] x', { script: true });
    assert.equal(r.status, 1); assert.match(r.out, /handover missing section "## Súbory"/); assert.doesNotMatch(r.out, /lines, limit/);
    spawnSync('git', ['reset', '-q'], { cwd: fx.brain });

    stage(fx, 'exceptions/project.md', '### Node everywhere\nZnenie: x\nDôvod: y\n');
    r = commit(fx, '[brain-script] x', { script: true });
    assert.equal(r.status, 1); assert.match(r.out, /no principle ID/);
    spawnSync('git', ['reset', '-q'], { cwd: fx.brain });

    stage(fx, 'exceptions/machine-x.md', '### P-034\nZnenie: x\n');
    r = commit(fx, '[brain-script] x', { script: true });
    assert.equal(r.status, 1); assert.match(r.out, /Dôvod/);
    spawnSync('git', ['reset', '-q'], { cwd: fx.brain });

    stage(fx, 'skills/agentic/foo/SKILL.md', '---\nname: foo\ndescription: Použi, keď foo\n---\nx\n');
    r = commit(fx, '[brain-script] x', { script: true });
    assert.equal(r.status, 1); assert.match(r.out, /origin/);
    spawnSync('git', ['reset', '-q'], { cwd: fx.brain });

    stage(fx, 'skills/agentic/foo/SKILL.md', '---\nname: foo\ndescription: Použi, keď foo\norigin: error\n---\nx\n');
    r = commit(fx, '[brain-script] ok', { script: true });
    assert.equal(r.status, 0, r.out);
  } finally { fx.cleanup(); }
});
