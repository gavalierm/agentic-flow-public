// P-061, report-32db110e: waiting for another topic is a condition checked by code (timer.mjs --topic), not a blind
// long timer; a timer over 30 min without a condition is refused unless --blind (a step bound to the clock itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');

test('timer --topic waits for another topic by a code check; a blind timer over 30m is refused', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ messages: [] }));
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  const timer = () => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8')).timer;
  // The check runs in the project as a shell command of the thread, like untilMet in the prompt hook.
  const check = (cmd) => { const r = spawnSync('sh', ['-c', cmd], { cwd: fx.project, env: fx.env, encoding: 'utf8' }); return r.status; };
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion', '--no-claim']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'počkaj na beta' });
    // The blind wait of the report: 120 min without a check.
    const blind = fx.run('timer.mjs', ['--in', '120m', '--then', 'continue after beta']);
    assert.notEqual(blind.status, 0, blind.out);
    assert.match(blind.out, /waits blind: waiting for another topic → --topic <id>/);
    assert.equal(fx.run('timer.mjs', ['--in', '120m', '--then', 'daily report', '--blind']).status, 0, 'a clock-bound step may say --blind');
    assert.equal(fx.run('timer.mjs', ['--in', '30m', '--then', 'check build']).status, 0, 'up to 30m stays plain');
    assert.notEqual(fx.run('timer.mjs', ['--in', '10m', '--topic', 'nikto', '--then', 'x']).status, 0, 'unknown topic is refused');
    const set = fx.run('timer.mjs', ['--in', '10m', '--topic', 'beta', '--then', 'continue after beta']);
    assert.equal(set.status, 0, set.out);
    const t = timer();
    assert.match(t.until, /topic\.mjs" closed beta$/);
    assert.ok(Date.parse(t.deadline) > Date.now() + 23 * 3600_000, 'default deadline 24h');
    assert.equal(check(t.until), 1, 'open topic: not met');
    fs.mkdirSync(path.join(fx.brain, 'topics', 'archive'), { recursive: true });
    fs.renameSync(path.join(fx.brain, 'topics', 'beta'), path.join(fx.brain, 'topics', 'archive', 'beta'));
    assert.equal(check(t.until), 0, 'closed topic: met');
  } finally { fx.cleanup(); }
});
