// Skill health (operator 2026-11-07): skill-check finds broken and machine-specific skills; save refuses a broken one;
// an operator skill changes without approval only when its meaning stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { checkSkill, meaningDiff } from '../scripts/skill-check.mjs';

const skill = (body, extra = 'origin: routine\n', name = 'x') => `---\nname: ${name}\ndescription: Použi, keď robíš x.\n${extra}---\n${body}\n`;
const codes = (f) => f.map((x) => `${x.level}:${x.code}`);

test('checkSkill: format, references, paths, anti-patterns, growth', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sc-'));
  try {
    fs.mkdirSync(path.join(home, 'agentic', 'Bob', 'agent-bob'), { recursive: true });
    const check = (text, opts = {}) => checkSkill({ name: 'x', dir: null, text, owner: 'agentic', projectDir: path.join(home, 'agentic', 'Bob', 'agent-bob'), home, ...opts });
    assert.deepEqual(check(skill('1. `node ~/agentic/Bob/agent-bob/x.mjs` nie, P-003, workflow:save')).filter((f) => f.level === 'error'), []);
    assert.deepEqual(check(skill('DNSSEC: ECDSA Curve P-256 (algoritmus 13), P-384 nie')).filter((f) => f.level === 'error'), [], 'a NIST curve name is not a principle reference');
    assert.ok(check(skill('podľa P-999')).some((f) => f.level === 'error' && /P-999 does not exist/.test(f.message)));
    assert.ok(codes(check(skill('a', 'origin: routine\n', 'y'))).includes('error:name'));
    assert.ok(codes(check('---\nname: x\n---\nbody\n')).includes('error:description'));
    assert.ok(codes(check(skill('a', ''))).includes('error:origin'));
    let f = check(skill('Pozri workflow:nope a P-999.'));
    assert.equal(f.filter((x) => x.code === 'reference').length, 2);
    f = check(skill('Spusti `sh ~/agentic/bob/agent-bob/.claude/skills/x/run.sh`.'));
    assert.match(f.find((x) => x.code === 'path').message, /before the domain rename; now ~\/agentic\/Bob/);
    f = check(skill('Spusti `sh ~/agentic/Bob/agent-bob/.claude/skills/x/gone.sh`.'));
    assert.ok(codes(f).includes('error:path'), 'a missing skill script is an error');
    f = check(skill('Spusti `sh ~/agentic/Bob/agent-bob/.claude/skills/x/run.sh`.'), { pendingScripts: ['run.sh'] });
    assert.ok(!codes(f).includes('error:path'), 'its own script is deployed at session start');
    assert.ok(codes(check(skill('Log: ~/.t3/logs/events.<vlákno>.log'))).every((c) => c !== 'warn:path'), 'a placeholder is not a path');
    assert.ok(codes(check(skill('Pošli `comms.mjs send --level info`.'))).includes('error:anti-pattern'));
    assert.ok(codes(check(skill('Potom `git push --force origin main`.'))).includes('warn:anti-pattern'));
    assert.ok(!codes(check(skill('`t3_thread_send` do pilotného vlákna hook zamietne.'))).includes('warn:anti-pattern'), 'naming a ban is a mention');
    assert.ok(codes(check(skill('1. a\\n2. b\\nnie c, lebo d'))).includes('error:format'));
    assert.ok(codes(check(skill('a', 'origin: error\n'))).includes('warn:nie-line'));
    assert.ok(codes(check(skill(['a', '## Doplnenie 1', 'b', '## Doplnenie 2', 'c', '## Doplnenie 3', 'd'].join('\n')))).includes('warn:growth'));
    assert.ok(codes(check(skill('`${CLAUDE_PLUGIN_ROOT}/bin/x.mjs`'))).includes('error:anti-pattern'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('meaningDiff: rewording and merged additions keep meaning; a changed command, nie line or new text does not', () => {
  const before = skill('1. Spusti `npm test`.\n## Doplnenie 1\nPotom `git push origin dev` (P-018).\nnie bez testov, lebo padá CI');
  assert.deepEqual(meaningDiff(before, skill('1. Najprv spusti `npm test`, potom `git push origin dev` (P-018).\nnie bez testov, lebo padá CI')), []);
  assert.deepEqual(meaningDiff(skill('`sh ~/agentic/alice/x.sh`'), skill('`sh ~/agentic/Alice/x.sh`')), [], 'the case of a domain is a path fix');
  assert.ok(meaningDiff(before, skill('1. Spusti `npm test -- --x`.\nPotom `git push origin dev` (P-018).\nnie bez testov, lebo padá CI')).some((d) => d.startsWith('lost code:npm test')));
  assert.ok(meaningDiff(before, skill('1. Spusti `npm test`. Potom `git push origin dev` (P-018).')).some((d) => d.startsWith('lost nie:')));
  assert.ok(meaningDiff(before, skill(`${before.split('---\n')[2]}\n${'Nový krok s ďalším obsahom. '.repeat(8)}`)).some((d) => d.startsWith('added text')));
});

test('save skill: a broken skill is not saved; operator skill: cosmetic edit passes, a change of meaning needs --approved', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'x-api', '--description', 'Použi, keď voláš X API', '--content', 'Pozri workflow:nope.', '--origin', 'routine']);
    assert.equal(r.status, 1); assert.match(r.stderr, /skill check: .*workflow:nope does not exist; nothing saved/);
    const dir = path.join(fx.brain, 'skills', 'operator', 'deploy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill('1. Spusti `npm test`.\n## Doplnenie 1\nPotom `git push origin dev`.', '', 'deploy'));
    fx.git(fx.brain, 'add', '-A'); fx.git(fx.brain, 'commit', '-qm', 'operator skill', '--no-verify');
    r = fx.run('save.mjs', ['skill', 'deploy', '--replace', '--content', '1. Spusti `npm test`, potom `git push origin dev`.']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('skills/operator/deploy/SKILL.md'), /potom `git push origin dev`/);
    r = fx.run('save.mjs', ['skill', 'deploy', '--sed', 's/npm test/npm run lint/']);
    assert.equal(r.status, 1); assert.match(r.stderr, /changes its meaning \(lost code:npm test.*--approved/);
    r = fx.run('save.mjs', ['skill', 'deploy', '--sed', 's/npm test/npm run lint/', '--approved', 'áno, lint']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('skills/operator/deploy/SKILL.md'), /npm run lint/);
  } finally { fx.cleanup(); }
});

test('skill-check.mjs: report per skill, unmanaged hand-written skill, exit 1 on error', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'bad', 'SKILL.md'), skill('Pozri P-999.', 'origin: routine\n', 'bad'));
    fs.mkdirSync(path.join(fx.project, '.claude', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, '.claude', 'skills', 'mine', 'SKILL.md'), skill('ok', '', 'mine'));
    const r = fx.run('skill-check.mjs');
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /bad \(agentic\): 1 error/);
    assert.match(r.stdout, /mine \(unmanaged\): 0 error, 1 warn\n {2}warn line 1 \[unmanaged\] .*skills\/operator\/mine/);
    assert.match(fx.run('consolidate.mjs', ['report']).stdout, /skill health .*bad 1e\/0w/);
  } finally { fx.cleanup(); }
});
