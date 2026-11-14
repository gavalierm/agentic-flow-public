// P-030, P-028: sequences, failures, rotation, signal via Stop -> next prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setup } from './helpers.mjs';
import { normalizeCommand, sequencesFrom, rotateLines, isReadonly, readLog, bufferAppend, failureId, sessionsByName, rotationOps } from '../scripts/logs.mjs';
import { loadPolicy } from '../scripts/config.mjs';
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

test('P-030: normalization (program + first subcommand, compound commands and shell groups split, own scripts skipped), sequence building, line rotation', () => {
  assert.deepEqual(normalizeCommand('git fetch origin && git rebase -i origin/main && npm test -- --watch', policy), ['git fetch', 'git rebase', 'npm test']);
  assert.deepEqual(normalizeCommand('NODE_ENV=test node bin/x.mjs --flag | head -3', policy), ['node x.mjs', 'head']);
  // Workflow's own scripts never count toward a skill proposal (pilot: `node .../comms.mjs send` + `ack` flagged 5x).
  assert.deepEqual(normalizeCommand('node /root/.claude/skills/workflow/bin/comms.mjs send --level info && node /root/.claude/skills/workflow/bin/comms.mjs ack --id 1', policy), []);
  assert.deepEqual(normalizeCommand('node ${CLAUDE_PLUGIN_ROOT}/bin/topic.mjs claim a', policy), []);
  assert.deepEqual(normalizeCommand('node a.mjs && node b.mjs', policy), ['node a.mjs', 'node b.mjs'], 'different scripts are different procedures');
  assert.deepEqual(normalizeCommand('cd /tmp; ls -la; cat a.txt', policy), ['cd', 'ls', 'cat']);
  // shell groups are skipped, the program of a $(...) assignment is kept
  assert.deepEqual(normalizeCommand('out=$(npm test 2>&1) || { echo x; exit 1; }; ls', { logs: { subcommand_programs: ['npm'] } }), ['npm test', 'echo', 'ls']);
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
    assert.equal(fx.run('error.mjs', ['resolve', failureId(logView(fx, 'failures.log').trim())]).status, 0);
    assert.equal(logView(fx, 'failures.log').trim(), '');
    // P-003 step 5: every error is reported to the workflow maintainer
    assert.match(fx.run('error.mjs', ['check', 'curl']).stdout, /report the error to the workflow maintainer: error\.mjs report --title/);
    // the maintainer's own thread is not told to mail itself
    assert.equal(fx.run('topic.mjs', ['create', 'workflow-dev', '--subject', 'Workflow', '--class', 'discussion']).status, 0);
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

// D-0034: the old shared sequences.log is frozen since the day files; rotation trims it instead of reading it forever.
test('rotation trims the old shared sequences.log by whole days and removes it once empty; trims of two machines merge without conflict', () => {
  const fx = setup({ second: true });
  try {
    const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const shared = `${day(40)} a+b s0\n${day(35)} c+d s0\n${day(1)} e+f s0\n`;
    assert.equal(fx.run('brain.mjs', ['write', 'logs/sequences.log', '--message', 'seed', '--content', shared]).status, 0);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    // machine B removes a different old line on its own (another day's cut); machine A rotates
    assert.equal(fx.runB('brain.mjs', ['write', 'logs/sequences.log', '--message', 'trim b', '--content', `${day(40)} a+b s0\n${day(1)} e+f s0\n`]).status, 0);
    bufferAppend(fx.brain, 's1', { kind: 'cmd', commands: ['npm ci', 'npm test'] });
    const r = fx.run('log.mjs', ['flush', '--session', 's1'], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /conflict/);
    // logs/*.log merge=union: a trim of another day merges without conflict and keeps lines of both; the next flush trims them
    assert.match(fx.read('logs/sequences.log'), /a\+b/);
    bufferAppend(fx.brain, 's1b', { kind: 'cmd', commands: ['npm ci', 'npm test'] });
    const again = fx.run('log.mjs', ['flush', '--session', 's1b'], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } });
    assert.equal(again.status, 0, again.out);
    assert.equal(fx.read('logs/sequences.log').trim(), `${day(1)} e+f s0`);
    assert.match(logView(fx, 'sequences.log'), /e\+f[\s\S]*npm-ci\+npm-test/);
    // all lines past the window: the file goes
    assert.equal(fx.run('brain.mjs', ['write', 'logs/sequences.log', '--message', 'seed', '--content', `${day(40)} a+b s0\n`]).status, 0);
    bufferAppend(fx.brain, 's2', { kind: 'cmd', commands: ['npm ci', 'npm test'] });
    assert.equal(fx.run('log.mjs', ['flush', '--session', 's2'], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } }).status, 0);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'logs', 'sequences.log')), 'emptied shared log removed');
  } finally { fx.cleanup(); }
});

test('P-030: quoted text, heredoc bodies and reading commands are not sequence steps', () => {
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
    const id = failureId(view.trim().split('\n').find((l) => /curl b/.test(l)));
    assert.equal(fx.run('error.mjs', ['resolve', id], { env: { WORKFLOW_MACHINE_ID: 'pc-a' } }).status, 0);
    assert.doesNotMatch(logView(fx, 'failures.log'), /curl b/);
    assert.match(fx.read('local/logs/failures.log'), /curl a/);
    assert.match(fx.git(fx.origin, 'show', `main:logs/pc-b/${day}.log`), /^failures .*curl b/m);
    assert.match(fx.git(fx.origin, 'show', `main:logs/pc-a/${day}.log`), /^drop failures .*curl b/m);
  } finally { fx.cleanup(); }
});

// D-0034: the fast readLog, rotation and session count give the same result as the plain implementation they replaced.
const refDayFiles = (brain) => {
  const out = [];
  const root = path.join(brain, 'logs');
  for (const machine of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const f of fs.readdirSync(path.join(root, machine))) { const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f); if (m) out.push({ machine, date: m[1], file: path.join(root, machine, f) }); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.machine.localeCompare(b.machine));
};
const refRotate = (lines, days) => { const cutoff = Date.now() - days * 864e5; return lines.filter((l) => { const d = Date.parse(l.slice(0, 10)); return Number.isNaN(d) || d >= cutoff; }); };
const refReadLog = (brain, logName, { rotationDays = null } = {}) => {
  const kind = logName.replace(/\.log$/, '');
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const entries = read(path.join(brain, 'logs', logName)).split('\n').filter(Boolean).map((text) => ({ text, machine: null }));
  const drops = []; const undrops = []; let seq = 0;
  for (const d of refDayFiles(brain)) {
    for (const raw of read(d.file).split('\n')) {
      const sp = raw.indexOf(' '); if (sp < 0) continue;
      const head = raw.slice(0, sp); const rest = raw.slice(sp + 1); seq += 1;
      if (head === kind) entries.push({ text: rest, machine: d.machine, date: d.date, seq });
      else if (head === 'drop' && rest.startsWith(`${kind} `)) drops.push({ what: rest.slice(kind.length + 1), machine: d.machine, date: d.date, seq });
      else if (head === 'undrop' && rest.startsWith(`${kind} `)) undrops.push(rest.slice(kind.length + 1));
    }
  }
  const gone = (e) => (kind === 'failures'
    ? drops.filter((x) => x.what === e.text).length > undrops.filter((u) => u === e.text).length
    : drops.some((x) => x.what === e.text.split(' ')[1] && (!e.machine || (e.machine === x.machine ? e.seq < x.seq : e.date < x.date))));
  const lines = entries.filter((e) => !gone(e)).map((e) => e.text);
  return rotationDays ? refRotate(lines, rotationDays) : lines;
};
const refSessions = (lines) => { const m = new Map(); for (const l of lines) { const [, name, sid] = l.split(' '); if (!name) continue; if (!m.has(name)) m.set(name, new Set()); m.get(name).add(sid || '-'); } return m; };

function randomBrain(seed) {
  let s = seed >>> 0; // mulberry32: the low bits of a plain LCG repeat, so some kinds of line never came up
  const rnd = (n) => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = (a) => a[rnd(a.length)];
  const day = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
  const names = ['a+b', 'git-x+git-y', 'npm-ci+npm-test', 'c+d+e', 'x', 'yy+zz', 'k+l', 'ab+b'];
  const heads = () => pick([day(rnd(45)), day(rnd(45)), day(30), day(29), day(31), day(rnd(45)).replace(/-/g, '/'), 'junk-head!', 'Nov 1 2026', '2026-13-45', '9999-99-99']);
  const seqLine = () => pick([`${heads()} ${pick(names)} s${rnd(6)}`, `${heads()} ${pick(names)}`, `${heads()}  ${pick(names)} s1`, `${day(rnd(45))} ${pick(names)} s${rnd(6)} extra`, 'short', `${day(3)}`, `${day(2)} `]);
  const failLine = () => `${day(rnd(20))}T10:0${rnd(9)}:00Z main s${rnd(4)} cmd${rnd(5)} :: err`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-readlog-'));
  const brain = path.join(root, 'brain');
  fs.mkdirSync(path.join(brain, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'logs', 'sequences.log'), Array.from({ length: 300 }, seqLine).join('\n') + '\n\n');
  fs.writeFileSync(path.join(brain, 'logs', 'failures.log'), Array.from({ length: 20 }, failLine).join('\n') + '\n');
  const fails = [];
  for (const machine of ['pc-a', 'pc-b']) {
    for (let back = 40; back >= 0; back -= 1 + rnd(4)) {
      const lines = [];
      for (let i = 0; i < 15; i++) {
        const r = rnd(12);
        if (r < 5) lines.push(`sequences ${seqLine()}`);
        else if (r === 5) { const f = failLine(); fails.push(f); lines.push(`failures ${f}`); }
        else if (r === 6) lines.push(`drop sequences ${pick(names)}`);
        else if (r === 7 && fails.length) lines.push(`drop failures ${pick(fails)}`);
        else if (r === 8 && fails.length) lines.push(`undrop failures ${pick(fails)}`);
        else lines.push(pick(['', 'junk', 'sequences ', 'drop sequencesx a+b', 'procedures p1 t', `drop procedures ${pick(names)}`]));
      }
      fs.mkdirSync(path.join(brain, 'logs', machine), { recursive: true });
      fs.writeFileSync(path.join(brain, 'logs', machine, `${day(back)}.log`), lines.join('\n') + '\n');
    }
  }
  return { root, brain, names };
}

test('D-0034: readLog, rotation and session counts give the same lines as the plain implementation (drop, undrop, rotation)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { root, brain, names } = randomBrain(seed);
    try {
      for (const [name, opts] of [['sequences.log', { rotationDays: 30 }], ['sequences.log', {}], ['failures.log', {}], ['procedures.log', { rotationDays: 30 }]]) {
        const got = readLog(brain, name, opts);
        assert.deepEqual(got, refReadLog(brain, name, opts), `seed ${seed} ${name}`);
        assert.equal(fs.readFileSync(path.join(brain, 'local', 'logs', name), 'utf8'), got.length ? got.join('\n') + '\n' : '', `view seed ${seed} ${name}`);
      }
      const lines = readLog(brain, 'sequences.log', { rotationDays: 30 });
      assert.deepEqual(rotateLines(lines, 7), refRotate(lines, 7), `rotate seed ${seed}`);
      const ref = refSessions(lines);
      const only = new Set([...names.slice(seed % 4, seed % 4 + 3), 'none+such']);
      assert.deepEqual(sessionsByName(lines, { only }), new Map([...ref].filter(([k]) => only.has(k))), `sessions seed ${seed}`);
      assert.deepEqual(sessionsByName(lines), ref, `all sessions seed ${seed}`);
      const day = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const shared = fs.readFileSync(path.join(brain, 'logs', 'sequences.log'), 'utf8').split('\n').filter(Boolean);
      const kept = shared.filter((l) => !/^\d{4}-\d{2}-\d{2}$/.test(l.slice(0, 10)) || l.slice(0, 10) >= day);
      assert.deepEqual(rotationOps(brain, 30, 'nobody'), kept.length === shared.length ? [] : [{ path: 'logs/sequences.log', content: kept.join('\n') + '\n' }], `rotationOps seed ${seed}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('D-0034: the view in local/logs/ is rewritten only when its sources change or it was changed', () => {
  const { root, brain } = randomBrain(7);
  try {
    const today0 = new Date().toISOString().slice(0, 10);
    const view = path.join(brain, 'local', 'logs', 'sequences.log');
    readLog(brain, 'sequences.log', { rotationDays: 30 });
    const t0 = fs.statSync(view).mtimeMs;
    const unchanged = readLog(brain, 'sequences.log', { rotationDays: 30 });
    assert.equal(fs.statSync(view).mtimeMs, t0, 'no change: the view is not written again');
    assert.equal(fs.readFileSync(view, 'utf8'), unchanged.join('\n') + '\n');
    const dayFile = path.join(brain, 'logs', 'pc-a', `${today0}.log`);
    fs.appendFileSync(dayFile, `sequences ${today0} fresh+seq s9\n`);
    const appended = readLog(brain, 'sequences.log', { rotationDays: 30 });
    assert.ok(appended.includes(`${today0} fresh+seq s9`));
    assert.equal(fs.readFileSync(view, 'utf8'), appended.join('\n') + '\n', 'an appended line reaches the view');
    fs.appendFileSync(dayFile, 'drop sequences fresh+seq\n');
    const dropped = readLog(brain, 'sequences.log', { rotationDays: 30 });
    assert.ok(!dropped.some((l) => l.includes('fresh+seq')));
    assert.equal(fs.readFileSync(view, 'utf8'), dropped.join('\n') + '\n', 'a drop reaches the view');
    fs.writeFileSync(view, 'edited\n');
    readLog(brain, 'sequences.log', { rotationDays: 30 });
    assert.equal(fs.readFileSync(view, 'utf8'), dropped.join('\n') + '\n', 'an edited view is rewritten');
    fs.rmSync(view);
    readLog(brain, 'sequences.log', { rotationDays: 30 });
    assert.equal(fs.readFileSync(view, 'utf8'), dropped.join('\n') + '\n', 'a removed view is rewritten');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
