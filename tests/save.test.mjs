// P-013, P-007, P-031, P-009, P-008, P-032, P-035: save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

test('memory: fixed format with key/origin; same subject overwrites; similar key refused unless --new', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['memory', 'operator', 'operator', '--content', 'name: Anna', '--aliases', 'me']);
    assert.equal(r.status, 0, r.out);
    let rec = parseFrontmatter(fx.read('memory/operator-operator.md'));
    assert.equal(rec.data.key, 'operator-operator'); assert.equal(rec.data.origin, 'operator'); assert.deepEqual(rec.data.aliases, ['me']);
    assert.equal(rec.body.trim(), 'name: Anna');
    r = fx.run('save.mjs', ['memory', 'operator', 'operator', '--content', 'name: Beta']);
    assert.equal(r.status, 0, r.out);
    rec = parseFrontmatter(fx.read('memory/operator-operator.md'));
    assert.equal(rec.body.trim(), 'name: Beta');
    assert.deepEqual(rec.data.aliases, ['me'], 'aliases kept');
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1, 'one record per subject');
    // alias hit -> overwrite the same file
    assert.equal(fx.run('save.mjs', ['memory', 'operator', 'me', '--content', 'name: Gamma']).status, 0);
    assert.equal(fs.readdirSync(path.join(fx.brain, 'memory')).filter((f) => f.endsWith('.md')).length, 1);
    // similar key
    assert.equal(fx.run('save.mjs', ['memory', 'service', 'x service', '--content', 'tokens', '--aliases', 'xs']).status, 0);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging']);
    assert.equal(r.status, 1); assert.match(r.stderr, /similar key exists.*service-x-service/);
    r = fx.run('save.mjs', ['memory', 'service', 'x-service-staging', '--content', 'staging', '--new']);
    assert.equal(r.status, 0, r.out);
    // derived needs sources; diacritics normalized in key
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived']);
    assert.equal(r.status, 1); assert.match(r.stderr, /sources/);
    r = fx.run('save.mjs', ['memory', 'service', 'Pošta', '--content', 'x', '--origin', 'derived', '--sources', 'README.md']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('memory/service-posta.md'));
    assert.match(fx.read('memory/service-posta.md'), /fingerprint: [0-9a-f]{12}/);
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] save memory service-posta/);
  } finally { fx.cleanup(); }
});

test('decision gets a sequential ID, needs relates_to, supersedes marks the old one', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X']);
    assert.equal(r.status, 1); assert.match(r.stderr, /relates-to/);
    r = fx.run('save.mjs', ['decision', 'Library A', '--what', 'A', '--alternatives', 'B', '--reason', 'B lacks X', '--relates-to', 'src/app.js']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /decision D-0001/);
    r = fx.run('save.mjs', ['decision', 'Library C', '--what', 'C', '--reason', 'faster', '--relates-to', 'src/app.js', '--supersedes', 'D-0001']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /D-0002/);
    const old = parseFrontmatter(fx.read('decisions/d-0001-library-a.md'));
    assert.equal(old.data.status, 'superseded-by D-0002');
    assert.match(fx.run('find.mjs', ['--relates-to', 'src/app.js']).stdout, /d-0002-library-c/);
  } finally { fx.cleanup(); }
});

test('skill: new agentic skill carries origin; second save extends it; operator skill is not edited; workflow name refused', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'x-api', '--description', 'Použi, keď voláš X API', '--content', 'hlavička X\nnie bez hlavičky, lebo 401', '--origin', 'error']);
    assert.equal(r.status, 0, r.out);
    const s = parseFrontmatter(fx.read('skills/agentic/x-api/SKILL.md'));
    assert.equal(s.data.origin, 'error'); assert.equal(s.data.name, 'x-api');
    r = fx.run('save.mjs', ['skill', 'x-api', '--content', 'timeout 10 s', '--origin', 'error']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /extended existing skill/);
    assert.match(fx.read('skills/agentic/x-api/SKILL.md'), /## Doplnenie .*\ntimeout 10 s/);
    assert.equal(fs.readdirSync(path.join(fx.brain, 'skills', 'agentic')).filter((d) => d !== '.gitkeep').length, 1);
    fs.mkdirSync(path.join(fx.brain, 'skills', 'operator', 'release'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'operator', 'release', 'SKILL.md'), '---\nname: release\ndescription: x\n---\nx\n');
    r = fx.run('save.mjs', ['skill', 'release', '--content', 'y', '--origin', 'error']);
    assert.equal(r.status, 1); assert.match(r.stderr, /belongs to the operator: this edit changes its meaning/);
    r = fx.run('save.mjs', ['skill', 'save', '--description', 'x', '--content', 'y']);
    assert.equal(r.status, 1); assert.match(r.stderr, /workflow skill name/);
  } finally { fx.cleanup(); }
});

test('exception: immutable refused, written per layer; rule saved; handover only by holder and within 15 lines', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['exception', 'P-001', '--wording', 'x', '--reason', 'y']);
    assert.equal(r.status, 1); assert.match(r.stderr, /immutable/);
    r = fx.run('save.mjs', ['exception', 'P-034', '--wording', 'bash allowed here', '--reason', 'legacy', '--layer', 'machine', '--machine', 'Box One']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('exceptions/machine-box-one.md'), /### P-034\nZnenie: bash allowed here\nDôvod: legacy/);
    r = fx.run('save.mjs', ['rule', 'tests', '--content', 'Každá zmena v src/ MUSÍ mať test.', '--enforced-by', 'hooks/pre-tool-use.mjs']);
    assert.equal(r.status, 0, r.out); assert.match(fx.read('rules/tests.md'), /key: rule-tests/);
    // Overlapping rules: move the boundary into one rule, never a rule with precedence over another (operator 2026-11-02).
    r = fx.run('save.mjs', ['rule', 'override', '--content', 'Diery oprav hneď. Má prednosť pred sensitive-approval.']);
    assert.notEqual(r.status, 0); assert.match(r.out, /move the boundary into one rule/);
    // A rule must not grow the rules over the limit (operator 2026-11-03): refused, the agent condenses or uses code.
    r = fx.run('save.mjs', ['rule', 'long', '--content', 'x'.repeat(11000), '--enforced-by', 'hooks/pre-tool-use.mjs']);
    assert.equal(r.status, 1); assert.match(r.stderr, /rules would have \d+ chars > 10000: a rule must not grow the rules over the limit/);
    assert.ok(!fx.exists('rules/long.md'));
    const rep = fx.run('consolidate.mjs', ['report']);
    assert.match(rep.stdout, /^rules: \d+ chars, \d+ lines; project rules .*: tests \d+$/m, rep.out);
    r = fx.run('save.mjs', ['rule', 'tests', '--remove']);
    assert.equal(r.status, 1); assert.match(r.stderr, /needs --reason/);
    // P-007: steps or commands are a procedure; save refuses them as a rule and points to a skill (Bob 2026-11-02).
    r = fx.run('save.mjs', ['rule', 'deploy', '--content', 'Služby drž aktuálne:\n1. stiahni vydanie\n2. reštartuj službu']);
    assert.equal(r.status, 1); assert.match(r.stderr, /reads as a procedure \(2 step lines\).*save\.mjs skill/);
    r = fx.run('save.mjs', ['rule', 'deploy', '--content', 'Po vydaní spusti `git pull --ff-only` v klone.']);
    assert.equal(r.status, 1); assert.match(r.stderr, /reads as a procedure \(command `git pull/);
    assert.ok(!fx.exists('rules/deploy.md'));
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Zmenu služby MUSÍŠ nasadiť cez skill `aktualizacia-sluzieb`; do `~/.claude/` NESMIEŠ zapisovať.', '--enforced-by', 'hooks/pre-tool-use.mjs']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /rule check \(P-007\).*is a skill/);
    r = fx.run('save.mjs', ['rule', 'nope', '--remove', '--reason', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /does not exist/);
    r = fx.run('save.mjs', ['rule', 'tests', '--remove', '--reason', 'superseded by P-058']);
    assert.equal(r.status, 0, r.out); assert.equal(fx.exists('rules/tests.md'), false);
    assert.equal(fx.run('topic.mjs', ['create', 'w', '--subject', 'W']).status, 0);
    r = fx.run('save.mjs', ['handover', 'w', '--task', 'Task', '--done', 'a; b', '--next', 'c', '--files', 'f1; f2', '--questions', 'q1']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('topics/w/handover.md'), /## Hotové\n- a\n- b\n## Ďalší krok\nc/);
    r = fx.run('save.mjs', ['handover', 'w', '--task', 'Task', '--done', Array.from({ length: 12 }, (_, i) => `d${i}`).join('; '), '--next', 'c']);
    assert.equal(r.status, 1); assert.match(r.stderr, /limit 15/);
    r = fx.run('save.mjs', ['handover', 'w', '--task', 'T', '--next', 'c'], { env: { WORKFLOW_THREAD_ID: 'zz' } });
    assert.equal(r.status, 1); assert.match(r.stderr, /held by thread a1/);
  } finally { fx.cleanup(); }
});

test('skill --script: the script is stored next to SKILL.md in one brain commit; bad names refused', () => {
  const fx = setup();
  try {
    const src = path.join(fx.root, 'release.mjs');
    fs.writeFileSync(src, '#!/usr/bin/env node\nconsole.log("ok");\n');
    let r = fx.run('save.mjs', ['skill', 'release-x', '--description', 'Použi, keď vydávaš', '--content', 'node <skill>/release.mjs', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.read('skills/agentic/release-x/release.mjs'), fs.readFileSync(src, 'utf8'));
    assert.match(r.out, /script runs as: node \/.+\/\.claude\/skills\/release-x\/release\.mjs/);
    const printed = r.out.match(/script runs as: node (\S+)/)[1];
    assert.ok(fs.existsSync(printed), `the printed path exists right after the save (Bob 2026-11-08): ${printed}`);
    assert.match(r.out, /deployed to /);
    const sh = path.join(fx.root, 'sync.sh');
    fs.writeFileSync(sh, 'echo ok\n');
    const r2 = fx.run('save.mjs', ['skill', 'release-x', '--content', 'sh', '--origin', 'routine', '--script', sh]);
    assert.match(r2.out, /script runs as: sh \/.+\/\.claude\/skills\/release-x\/sync\.sh/, 'a shell script is not run by node');
    fs.writeFileSync(src, '#!/usr/bin/env node\nconsole.log("v2");\n');
    r = fx.run('save.mjs', ['skill', 'release-x', '--content', 'v2', '--origin', 'routine', '--script', src]);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('skills/agentic/release-x/release.mjs'), /v2/);
    const bad = path.join(fx.root, 'Bad Name.py');
    fs.writeFileSync(bad, 'x');
    r = fx.run('save.mjs', ['skill', 'release-x', '--content', 'y', '--origin', 'routine', '--script', bad]);
    assert.equal(r.status, 1); assert.match(r.stderr, /--script/);
    r = fx.run('save.mjs', ['skill', 'release-x', '--remove', '--reason', 'test']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.dirname(printed)), false, 'a removed skill leaves the project at once (pilot 2026-11-08)');
  } finally { fx.cleanup(); }
});

test('skill --remove: a superseded skill is removed with its scripts in one commit; needs a reason', () => {
  const fx = setup();
  try {
    const src = path.join(fx.root, 'check.mjs');
    fs.writeFileSync(src, 'console.log(1);\n');
    assert.equal(fx.run('save.mjs', ['skill', 'verify-x', '--description', 'Použi, keď overuješ', '--content', 'krok', '--origin', 'error', '--script', src]).status, 0);
    let r = fx.run('save.mjs', ['skill', 'verify-x', '--remove']);
    assert.equal(r.status, 1); assert.match(r.stderr, /--reason/);
    r = fx.run('save.mjs', ['skill', 'nope-x', '--remove', '--reason', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /does not exist/);
    r = fx.run('save.mjs', ['skill', 'verify-x', '--remove', '--reason', 'superseded by workflow:verify']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fx.exists('skills/agentic/verify-x/SKILL.md') && !fx.exists('skills/agentic/verify-x/check.mjs'), 'the skill files are gone');
    assert.ok(!fx.exists('skills/agentic/verify-x'), 'the emptied skill dir is gone too (the brain hook denies rmdir)');
  } finally { fx.cleanup(); }
});

test('skill --replace: the body is replaced by the corrected steps; without it the content is appended', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['skill', 'fix-x', '--description', 'Použi, keď opravuješ', '--content', 'old step', '--origin', 'error']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['skill', 'fix-x', '--content', 'extra', '--origin', 'error']);
    assert.match(fx.read('skills/agentic/fix-x/SKILL.md'), /old step[\s\S]*## Doplnenie [\d-]+\nextra/);
    // the whole skill sent as an addition is refused instead of duplicated under "## Doplnenie"
    r = fx.run('save.mjs', ['skill', 'fix-x', '--content', 'old step\nextra\nnew step', '--origin', 'error']);
    assert.equal(r.status, 1); assert.match(r.stderr, /repeats the body.*--replace/);
    assert.equal(fx.read('skills/agentic/fix-x/SKILL.md').match(/old step/g).length, 1);
    r = fx.run('save.mjs', ['skill', 'fix-x', '--content', 'new step', '--origin', 'error', '--replace']);
    assert.equal(r.status, 0, r.out);
    const text = fx.read('skills/agentic/fix-x/SKILL.md');
    assert.match(text, /\nnew step\n$/);
    assert.doesNotMatch(text, /old step|Doplnenie/);
    assert.match(text, /description: Použi, keď opravuješ|description: "Použi, keď opravuješ"/);
    // --sed: in-place edit of the body; description and origin kept; no match changes nothing (Bob 2026-11-02).
    r = fx.run('save.mjs', ['skill', 'fix-x', '--sed', 's/new (step)/fixed $1\\nsecond/']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /edited existing skill fix-x/);
    const edited = fx.read('skills/agentic/fix-x/SKILL.md');
    assert.match(edited, /\nfixed step\nsecond\n$/);
    assert.match(edited, /origin: error/); assert.match(edited, /Použi, keď opravuješ/);
    r = fx.run('save.mjs', ['skill', 'fix-x', '--sed', 's/absent/x/']);
    assert.equal(r.status, 1); assert.match(r.stderr, /pattern not found/);
    r = fx.run('save.mjs', ['skill', 'fix-x', '--sed', 's|fixed|a\\|b|', '--replace']);
    assert.equal(r.status, 1); assert.match(r.stderr, /do not combine/);
    assert.equal(fx.run('save.mjs', ['skill', 'fix-x', '--sed', 's|fixed|a\\|b|']).status, 0);
    assert.match(fx.read('skills/agentic/fix-x/SKILL.md'), /\na\|b step\n/);
    r = fx.run('save.mjs', ['skill', 'nope-x', '--sed', 's/a/b/']);
    assert.equal(r.status, 1); assert.match(r.stderr, /does not exist/);
  } finally { fx.cleanup(); }
});

test('rule names its enforcement: --enforced-by <file>[:<symbol>] is checked, --unenforced needs a reason, a rewrite keeps it (operator 2026-11-02)', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ zapisovať bez testu.']);
    assert.notEqual(r.status, 0); assert.match(r.out, /needs --enforced-by .* or --unenforced/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ zapisovať bez testu.', '--unenforced', 'code cannot see the intent of the change']);
    assert.notEqual(r.status, 0); assert.match(r.out, /a new rule needs --enforced-by/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ zapisovať bez testu.', '--enforced-by', 'hooks/missing.mjs']);
    assert.notEqual(r.status, 0); assert.match(r.out, /not found/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ zapisovať bez testu.', '--enforced-by', 'hooks/pre-tool-use.mjs:noSuchSymbol']);
    assert.notEqual(r.status, 0); assert.match(r.out, /noSuchSymbol does not occur/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ zapisovať bez testu.', '--enforced-by', 'hooks/pre-tool-use.mjs:topicOwnedCheck']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('rules/gate.md'), /enforced_by: \["hooks\/pre-tool-use.mjs:topicOwnedCheck"\]|enforced_by: \[hooks\/pre-tool-use.mjs:topicOwnedCheck\]/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ nič zapisovať bez testu.']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('rules/gate.md'), /topicOwnedCheck/, 'a rewrite keeps the recorded enforcement');
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'x', '--enforced-by', 'hooks/pre-tool-use.mjs', '--unenforced', 'both given at once here']);
    assert.notEqual(r.status, 0); assert.match(r.out, /exclude each other/);
    r = fx.run('save.mjs', ['rule', 'gate', '--content', 'Do src/ NESMIEŠ nič zapisovať bez testu.', '--unenforced', 'short']);
    assert.notEqual(r.status, 0); assert.match(r.out, /at least 20 characters/);
  } finally { fx.cleanup(); }
});

test('new rule gate (operator 2026-11-03): an overlap is extended in the existing rule, a conflict resolved first, code replaces a rule it can enforce', () => {
  const fx = setup();
  const judge = (o) => ({ WORKFLOW_RULE_JUDGE: 'on', WORKFLOW_RULE_JUDGE_CMD: `cat >/dev/null; echo '${JSON.stringify({ overlaps: [], conflicts: [], code_instead: '', ...o })}'` });
  const save = (name, content, env, extra = []) => fx.run('save.mjs', ['rule', name, '--content', content, '--enforced-by', 'hooks/stop.mjs', ...extra], { env });
  try {
    let r = save('waiting', 'Čakať bez budíka NESMIEŠ: na odpoveď operátora, na správu ani na pracovníka.', judge({}));
    assert.equal(r.status, 0, r.out);
    r = save('no-idle', 'Prázdne čakanie NESMIEŠ.', judge({ overlaps: [{ id: 'waiting', how: 'same subject' }, { id: 'P-061', how: 'alarm' }, { id: 'ghost', how: 'not a rule' }] }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rule no-idle overlaps waiting \(same subject\); P-061 \(alarm\): extend or narrow the existing rule instead of a new one \(save\.mjs rule waiting --content "<reworded>"; P-061 is a workflow principle: report it to maintainer\/workflow-dev/);
    assert.doesNotMatch(r.stderr, /ghost/, 'ids the judge made up are dropped');
    r = save('no-idle', 'Prázdne čakanie NESMIEŠ.', judge({ overlaps: [{ id: 'waiting', how: 'same subject' }] }), ['--distinct', 'waiting: short']);
    assert.equal(r.status, 1, 'a --distinct without a reason does not answer the overlap');
    r = save('no-idle', 'Prázdne čakanie NESMIEŠ.', judge({ overlaps: [{ id: 'waiting', how: 'same subject' }] }), ['--distinct', 'waiting: that one is about alarms, this one about idle loops']);
    assert.equal(r.status, 0, r.out);
    r = save('stop-on-steer', 'Na steer zastav prácu.', judge({ conflicts: [{ id: 'waiting', how: 'stop vs continue' }] }), ['--distinct', 'waiting: whatever the reason may be here']);
    assert.equal(r.status, 1); assert.match(r.stderr, /conflicts with waiting \(stop vs continue\): two rules must not order different behaviour; resolve the conflict in that rule first/);
    r = fx.run('save.mjs', ['rule', 'waiting', '--content', 'Čakať bez budíka NESMIEŠ, ani po steer.'], { env: judge({ conflicts: [{ id: 'no-idle', how: 'x' }] }) });
    assert.equal(r.status, 1, 'a rewrite that conflicts is refused too');
    r = fx.run('save.mjs', ['rule', 'waiting', '--content', 'Čakať bez budíka NESMIEŠ: na odpoveď, na správu ani na pracovníka.'], { env: judge({ conflicts: [{ id: 'no-idle', how: 'x' }] }) });
    assert.equal(r.status, 0, `condensing (no new words) is not judged again: ${r.stderr}`);
    const seen = path.join(fx.root, 'judge-prompt.txt');
    r = fx.run('save.mjs', ['rule', 'waiting', '--content', 'Čakať bez budíka NESMIEŠ: na odpoveď operátora, na správu ani na pracovníka, ani po steer.'], { env: { WORKFLOW_RULE_JUDGE: 'on', WORKFLOW_RULE_JUDGE_CMD: `cat > ${seen}; echo '{"overlaps":[],"conflicts":[],"code_instead":""}'` } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(seen, 'utf8'), /# Current wording of this rule[^\n]*\nČakať bez budíka NESMIEŠ: na odpoveď, na správu ani na pracovníka\.\nReport only overlaps and conflicts the proposed wording adds/);
    r = save('port', 'Port 3773 NESMIEŠ použiť.', judge({ code_instead: 'A hook can refuse the port.' }));
    assert.equal(r.status, 1); assert.match(r.stderr, /rule port can be enforced by code alone: A hook can refuse the port\. Do that/);
    r = save('port', 'Port 3773 NESMIEŠ použiť.', judge({ code_instead: 'A hook can refuse the port.' }), ['--needs-text', 'the agent picks the port before any hook sees it']);
    assert.equal(r.status, 0, r.out);
    // Without a judge the word-stem similarity still finds the rule on the same subject.
    r = save('alarm-wait', 'Čakať na odpoveď bez budíka NESMIEŠ, ani na správu.', { WORKFLOW_RULE_JUDGE: 'off' });
    assert.equal(r.status, 1); assert.match(r.stderr, /overlaps waiting \(shared terms: .*\[lexical\]/);
  } finally { fx.cleanup(); }
});

test('save from inside another workflow project refuses: the session project would get the write (alice 2026-11-04)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    let r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cwd is in project .* with its own brain.*--project/s);
    r = fx.run('save.mjs', ['memory', 'tool', 'xy', '--content', 'y', '--project', fx.project], { cwd: fx.projectB, env });
    assert.equal(r.status, 0, r.stderr);
    r = fx.run('topic.mjs', ['list'], { cwd: fx.projectB, env });
    assert.equal(r.status, 1, 'topic refuses too');
  } finally { fx.cleanup(); }
});

test('brain.mjs write/remove from another brain or project refuses; --project writes there (alice 2026-11-07)', () => {
  const fx = setup({ second: true });
  try {
    const env = { WORKFLOW_PROJECT_DIR: fx.project };
    const src = path.join(fx.root, 'note.md');
    fs.writeFileSync(src, 'x\n');
    const headA = () => spawnSync('git', ['-C', fx.brain, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const before = headA();
    for (const cwd of [fx.brainB, fx.projectB]) {
      const r = fx.run('brain.mjs', ['write', 'docs/note.md', '--file', src, '--message', 'm'], { cwd, env });
      assert.equal(r.status, 1, `write from ${cwd} must refuse: ${r.stdout}`);
      assert.match(r.stderr, /cwd is in (brain|project) .*--project/s);
    }
    let r = fx.run('brain.mjs', ['remove', 'docs/note.md', '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 1, 'remove refuses too');
    assert.equal(headA(), before, 'nothing landed in the session brain');
    r = fx.run('brain.mjs', ['write', 'docs/note.md', '--project', fx.projectB, '--file', src, '--message', 'm'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, r.stderr + r.stdout + (r.out || ''));
    assert.ok(fs.existsSync(path.join(fx.brainB, 'docs', 'note.md')), 'written into brain-b');
    assert.equal(headA(), before);
    r = fx.run('brain.mjs', ['status'], { cwd: fx.brainB, env });
    assert.equal(r.status, 0, 'read-only commands are not refused');
  } finally { fx.cleanup(); }
});
