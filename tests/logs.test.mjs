// P-030, P-028: sequences, failures, rotation, signal via Stop -> next prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { normalizeCommand, sequencesFrom, rotateLines } from '../scripts/logs.mjs';
import { loadPolicy } from '../scripts/config.mjs';
import { readLog, bufferAppend } from '../scripts/logs.mjs';
const logView = (fx, name) => { const l = readLog(fx.brain, name, { rotationDays: 30 }); return l.length ? l.join('\n') + '\n' : ''; };

const policy = loadPolicy(null);

// P-030: a sequence counts distinct sessions and only the maximal one is reported.
const flushSeq = (fx, session, runs) => {
  for (const commands of runs) bufferAppend(fx.brain, session, { kind: 'cmd', commands });
  const r = fx.run('log.mjs', ['flush', '--session', session]);
  assert.equal(r.status, 0, r.out);
  return r.out.split('\n').filter((l) => l.startsWith('sequence '));
};

test('P-030: repeats inside one session are one routine; three sessions reach the threshold', () => {
  const fx = setup();
  try {
    const step = ['npm ci', 'npm test'];
    assert.deepEqual(flushSeq(fx, 's1', [step, ['x'], step, ['x'], step, ['x'], step]), []);
    assert.deepEqual(flushSeq(fx, 's2', [step]), []);
    assert.equal(flushSeq(fx, 's3', [step]).length, 1);
  } finally { fx.cleanup(); }
});

test('P-030: only the maximal sequence is reported, not its sub-sequences', () => {
  const fx = setup();
  try {
    const run = ['git fetch', 'git rebase', 'npm test'];
    flushSeq(fx, 's1', [run]);
    flushSeq(fx, 's2', [run]);
    const signals = flushSeq(fx, 's3', [run]);
    assert.equal(signals.length, 1, signals.join('\n'));
    assert.match(signals[0], /^sequence git-fetch\+git-rebase\+npm-test 3x:/);
  } finally { fx.cleanup(); }
});

test('normalization: program + first subcommand, compound commands split, read-only commands skipped', () => {
  assert.deepEqual(normalizeCommand('git fetch origin && git rebase -i origin/main && npm test -- --watch', policy), ['git fetch', 'git rebase', 'npm test']);
  assert.deepEqual(normalizeCommand('NODE_ENV=test node bin/x.mjs --flag | head -3', policy), ['node x.mjs', 'head']);
  // Workflow's own scripts never count toward a skill proposal (pilot: `node .../comms.mjs send` + `ack` flagged 5x).
  assert.deepEqual(normalizeCommand('node /root/.claude/skills/workflow/bin/comms.mjs send --level info && node /root/.claude/skills/workflow/bin/comms.mjs ack --id 1', policy), []);
  assert.deepEqual(normalizeCommand('node ${CLAUDE_PLUGIN_ROOT}/bin/topic.mjs claim a', policy), []);
  assert.deepEqual(normalizeCommand('node a.mjs && node b.mjs', policy), ['node a.mjs', 'node b.mjs'], 'different scripts are different procedures');
  assert.deepEqual(normalizeCommand('cd /tmp; ls -la; cat a.txt', policy), ['cd', 'ls', 'cat']);
  assert.deepEqual(sequencesFrom(['a', 'b', 'c'], { min: 2, max: 5 }), ['a+b', 'b+c', 'a+b+c']);
  const old = `${new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10)} x s`;
  const fresh = `${new Date().toISOString().slice(0, 10)} y s`;
  assert.deepEqual(rotateLines([old, fresh], 30), [fresh]);
});

test('third occurrence of a sequence signals once on the next prompt; read-only commands are not counted; failures logged with agent id', () => {
  const fx = setup();
  try {
    const bash = (command, session, extra = {}) => fx.hook('post-tool-use.mjs', { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '' }, ...extra });
    for (const s of ['s1', 's2', 's3']) {
      bash('git status', s);
      bash('git fetch origin && git rebase origin/main', s);
      bash('npm test', s);
      bash('cat README.md', s);
      const stop = fx.hook('stop.mjs', { session_id: s, stop_hook_active: false });
      assert.deepEqual(stop.json, {}, 'Stop never prolongs the turn');
    }
    const log = logView(fx, 'sequences.log');
    assert.equal(log.split('\n').filter((l) => l.includes(' git-fetch+git-rebase+npm-test ')).length, 3);
    assert.doesNotMatch(log, /git-status|cat/);
    const prompt = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.equal(prompt.context.split('\n').length, 2);
    assert.match(prompt.context.split('\n')[1], /sequence git-fetch\+git-rebase\+npm-test 3x/);
    assert.equal(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context.split('\n').length, 1, 'signal once');
    assert.match(fx.git(fx.brain, 'log', '--format=%s', '-1', '--', 'logs'), /^\[brain-script\] logs flush s3$/);
    // failures from a subagent
    fx.hook('post-tool-use.mjs', { session_id: 's4', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'curl -H x https://api.example' }, error: 'Exit code 22\n401 Unauthorized', agent_id: 'sub9' });
    fx.hook('stop.mjs', { session_id: 's4' });
    assert.match(logView(fx, 'failures.log'), /sub9 s4 curl -H x .* :: Exit code 22/);
    assert.match(fx.run('error.mjs', ['list']).stdout, /1\. .*sub9/);
    assert.equal(fx.run('error.mjs', ['resolve', '1']).status, 0);
    assert.equal(logView(fx, 'failures.log').trim(), '');
    // P-003 step 5: every error is reported to the workflow maintainer
    assert.match(fx.run('error.mjs', ['check', 'curl']).stdout, /report the error to the workflow maintainer: error\.mjs report --title/);
    // the maintainer's own thread is not told to mail itself
    assert.equal(fx.run('topic.mjs', ['create', 'workflow-dev', '--subject', 'Workflow']).status, 0);
    assert.match(fx.run('error.mjs', ['check', 'curl']).stdout, /this thread holds workflow-dev: do not mail the report to yourself/);
  } finally { fx.cleanup(); }
});

test('rotation: sequences older than 30 days are dropped; failures older than 7 days raise a signal', () => {
  const fx = setup();
  try {
    const old = new Date(Date.now() - 31 * 864e5).toISOString();
    assert.equal(fx.run('brain.mjs', ['write', 'logs/sequences.log', '--message', 'seed', '--content', `${old.slice(0, 10)} a+b s0\n`]).status, 0);
    assert.equal(fx.run('brain.mjs', ['write', 'logs/failures.log', '--message', 'seed', '--content', `${new Date(Date.now() - 8 * 864e5).toISOString()} main s0 curl :: 500\n`]).status, 0);
    fx.hook('post-tool-use.mjs', { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm ci && npm test' }, tool_response: { stdout: '' } });
    fx.hook('stop.mjs', { session_id: 's1' });
    assert.doesNotMatch(logView(fx, 'sequences.log'), /a\+b/);
    assert.match(logView(fx, 'sequences.log'), /npm-ci\+npm-test/);
    const prompt = fx.hook('user-prompt-submit.mjs', { prompt: 'x' });
    assert.match(prompt.context, /1 unprocessed failure\(s\) older than 7 days/);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'local', 'log-buffer', 's1.jsonl')), 'buffer cleared after flush');
  } finally { fx.cleanup(); }
});

test('P-030: quoted text, heredoc bodies and reading commands are not sequence steps', async () => {
  const { normalizeCommand, isReadonly } = await import('../scripts/logs.mjs');
  const policy = JSON.parse(fs.readFileSync(new URL('../policy/policy.json', import.meta.url)));
  const steps = (c) => normalizeCommand(c, policy).filter((x) => !isReadonly(x, policy));
  assert.deepEqual(steps(`cd /x && git add -A && git commit -q -m "a; the b\n\nc; d" && git push`), ['git add', 'git commit', 'git push']);
  assert.deepEqual(steps(`grep -n x f; cd y && sed -n 1,5p a && sed -i s/a/b/ f`), ['sed']);
  assert.deepEqual(steps(`python3 - <<EOF\nimport x; the=1\nEOF\nnpm test`), ['python3', 'npm test']);
  // shell keywords are syntax, text filters only read (Bob 2026-11-03: `for+echo`, `tr+echo` proposed as skills)
  assert.deepEqual(steps('for f in a b; do echo $f; npm test; done'), ['npm test']);
  assert.deepEqual(steps('if [ -f x ]; then rm x; fi; while read l; do printf "%s" $l | cut -c1-5 | tr a b; done < f'), ['rm']);
});

// Audit 2.3a: Stop commits the log locally; push waits for the next brain write or logs.stop_push_minutes.
test('Stop commits logs locally and pushes only when the oldest unpushed commit is older than logs.stop_push_minutes', () => {
  const fx = setup();
  try {
    const bash = (s) => fx.hook('post-tool-use.mjs', { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', stderr: '' } });
    const ahead = () => Number(fx.git(fx.brain, 'rev-list', '--count', 'origin/main..HEAD'));
    bash('p1'); bash('p1');
    assert.deepEqual(fx.hook('stop.mjs', { session_id: 'p1' }).json, {});
    assert.match(fx.git(fx.brain, 'log', '--format=%s', '-1'), /logs flush p1$/);
    assert.equal(ahead(), 1, 'Stop leaves the log commit local');
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ logs: { stop_push_minutes: 0 } }));
    bash('p2'); bash('p2');
    fx.hook('stop.mjs', { session_id: 'p2' });
    assert.equal(ahead(), 0, 'with the interval elapsed Stop pushes');
  } finally { fx.cleanup(); }
});

test('sequence normalization skips shell groups and keeps the program of $(...) assignments', async () => {
  const { normalizeCommand } = await import('../scripts/logs.mjs');
  assert.deepEqual(normalizeCommand('out=$(npm test 2>&1) || { echo x; exit 1; }; ls', { logs: { subcommand_programs: ['npm'] } }), ['npm test', 'echo', 'ls']);
});

test('two machines flush into their own day files: no conflict, the combined view has both, a drop only appends', () => {
  const fx = setup({ second: true });
  try {
    bufferAppend(fx.brain, 'sa', { kind: 'fail', command: 'curl a', error: 'Exit 1' });
    bufferAppend(fx.brainB, 'sb', { kind: 'fail', command: 'curl b', error: 'Exit 2' });
    assert.equal(fx.run('log.mjs', ['flush', '--session', 'sa'], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } }).status, 0);
    const r = fx.runB('log.mjs', ['flush', '--session', 'sb'], { env: { WORKFLOW_MACHINE_ID: 'pc-b' } });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /conflict|unpushed/);
    fx.git(fx.brain, 'pull', '-q', '--rebase', 'origin', 'main');
    const view = logView(fx, 'failures.log');
    assert.match(view, /curl a/);
    assert.match(view, /curl b/);
    const day = new Date().toISOString().slice(0, 10);
    const n = view.trim().split('\n').findIndex((l) => /curl b/.test(l)) + 1;
    assert.equal(fx.run('error.mjs', ['resolve', String(n)], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } }).status, 0);
    assert.doesNotMatch(logView(fx, 'failures.log'), /curl b/);
    assert.match(fx.read('local/logs/failures.log'), /curl a/);
    assert.match(fx.git(fx.origin, 'show', `main:logs/pc-b/${day}.log`), /^failures .*curl b/m);
    assert.match(fx.git(fx.origin, 'show', `main:logs/pc-a/${day}.log`), /^drop failures .*curl b/m);
  } finally { fx.cleanup(); }
});
