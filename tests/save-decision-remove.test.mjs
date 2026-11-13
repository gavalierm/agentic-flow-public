// Removal of decisions and log lines on an explicit operator order (P-008, P-013). The shell (git rm, sed) is denied by
// the brain hook, and save.mjs had no way for that order, so the agent was stuck (report-526ff5ce, 2026-11-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { checkStaged } from '../bin/brain-precommit.mjs';
import { BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

function twoDecisions(fx) {
  for (const t of ['Library A', 'Library B']) {
    const r = fx.run('save.mjs', ['decision', t, '--what', t, '--reason', 'x', '--relates-to', 'src/app.js']);
    assert.equal(r.status, 0, r.out);
  }
}

test('decision --remove: removed and committed on an operator order; without it refused; plain git rm still refused', () => {
  const fx = setup();
  try {
    twoDecisions(fx);
    let r = fx.run('save.mjs', ['decision', '--remove', 'D-0001']);
    assert.equal(r.status, 1); assert.match(r.stderr, /operator/);
    r = fx.run('save.mjs', ['decision', '--remove', 'D-0001', '--reason', 'no longer needed']);
    assert.equal(r.status, 1, 'a reason that is not an operator order is refused'); assert.match(r.stderr, /--supersedes/);
    r = fx.run('save.mjs', ['decision', '--remove', 'D-0009', '--reason', 'operator 2026-11-13: test']);
    assert.equal(r.status, 1); assert.match(r.stderr, /not found/);
    r = fx.run('save.mjs', ['decision', '--remove', 'D-0001', '--reason', 'operator 2026-11-13: wrong decision']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /D-0001 removed/);
    assert.ok(!fx.exists('decisions/d-0001-library-a.md'), 'the decision file is gone');
    assert.ok(fx.exists('decisions/d-0002-library-b.md'), 'the other decision stays');
    assert.equal(fx.git(fx.brain, 'status', '--porcelain').trim(), '', 'the removal is committed');
    // Without save.mjs the precommit still refuses deleting a decision (P-008).
    fx.git(fx.brain, 'rm', '-q', 'decisions/d-0002-library-b.md');
    const errors = checkStaged(fx.brain, { env: { [BRAIN_SCRIPT_ENV]: '1' } });
    assert.ok(errors.some((e) => /d-0002.*decision --remove/.test(e)), errors.join('\n'));
  } finally { fx.cleanup(); }
});

test('log.mjs remove: lines containing the text leave every log file on an operator order; nothing else changes', () => {
  const fx = setup();
  try {
    const day = path.join(fx.brain, 'logs', 'other-machine', '2026-11-12.log');
    fs.mkdirSync(path.dirname(day), { recursive: true });
    fs.writeFileSync(day, 'failures 10:00 s1 secret thing failed\nprocedures 10:01 s1 keep-me\n');
    fs.writeFileSync(path.join(fx.brain, 'logs', 'procedures.log'), '2026-11-01 secret-proc\n');
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', '[brain-script] fixture logs');
    let r = fx.run('log.mjs', ['remove', '--match', 'secret']);
    assert.equal(r.status, 1); assert.match(r.stderr, /operator/);
    r = fx.run('log.mjs', ['remove', '--match', 'absent-text', '--reason', 'operator 2026-11-13: test']);
    assert.equal(r.status, 1); assert.match(r.stderr, /no log line/);
    r = fx.run('log.mjs', ['remove', '--match', 'secret', '--reason', 'operator 2026-11-13: private data']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /removed 2 log line/);
    assert.equal(fx.read('logs/other-machine/2026-11-12.log'), 'procedures 10:01 s1 keep-me\n');
    assert.ok(!fx.exists('logs/procedures.log'), 'an emptied log file is removed');
    assert.equal(fx.git(fx.brain, 'status', '--porcelain').trim(), '', 'the removal is committed');
  } finally { fx.cleanup(); }
});
