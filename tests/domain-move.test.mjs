// Domain move (carol 2026-11-09): a persona created in ~/agentic while the operator keeps domains elsewhere is moved under
// the saved projects root with everything that points at the old path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, setup } from './helpers.mjs';
import { historyName } from '../scripts/domain-move.mjs';

const BIN = path.join(PLUGIN_ROOT, 'bin', 'domain-move.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };

function personaFx() {
  // created under the test temp dir; cleanup() removes it
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-move-')));
  const home = path.join(base, 'home');
  const domain = path.join(home, 'agentic', 'Carol');
  const dir = path.join(domain, 'agent-carol');
  const origin = path.join(base, 'agent-carol.git');
  const domains = path.join(base, 'Domains');
  fs.mkdirSync(domains, { recursive: true });
  fs.mkdirSync(domain, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const env = cleanEnv({ HOME: home, WORKFLOW_ROOT_FILE: path.join(base, 'projects-root'), WORKFLOW_THREAD_ID: 'm1' });
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), dir, '--remote', origin, '--persona'], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain-init: ${r.stderr}${r.stdout}`);
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, '.workflow.json'), '{"brain": "."}\n');
  git(dir, 'add', '.workflow.json'); git(dir, 'commit', '-q', '--no-verify', '-m', 'persona config');
  fs.writeFileSync(path.join(domain, '.agentic-domain'), '{"brain":"agent-carol"}\n');
  const brainWrite = (rel, content) => {
    const w = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain.mjs'), 'write', rel, '--project', dir, '--stdin', '--message', 'fixture'], { cwd: dir, env: { ...env, WORKFLOW_PROJECT_DIR: dir }, input: content, encoding: 'utf8' });
    if (w.status !== 0) throw new Error(`brain write: ${w.stderr}${w.stdout}`);
  };
  brainWrite('skills/x/SKILL.md', `---\nname: x\ndescription: "Použi, keď test."\n---\n1. sh ${domain}/agent-carol/scripts/a.sh a ~/agentic/Carol/b; nie ${domain}-old\n`);
  brainWrite('logs/2026-11-09.md', `ran ${domain}/agent-carol\n`);
  const policy = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8'));
  policy.domain = { allow_outside: ['~/agentic'] };
  brainWrite('policy.json', JSON.stringify(policy, null, 2) + '\n');
  // Claude Code history of the persona and its trust entry
  const hist = path.join(home, '.claude', 'projects', historyName(dir));
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 's.jsonl'), '{}\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, env: { ...env, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
  return { base, home, domain, dir, domains, env, run, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// Carol 2026-11-09: a persona created in ~/agentic had to move under the saved projects root.
test('domain move: plan, move with symlink, history, trust and brain paths, then finish swaps the history', () => {
  const f = personaFx();
  try {
    let r = f.run(f.domain, '--dry');
    assert.notEqual(r.status, 0, 'no saved root and no --to');
    assert.match(r.stdout + r.stderr, /no projects root saved for this machine.*project\.mjs root/);
    fs.writeFileSync(path.join(f.base, 'projects-root'), `${f.domains}\n`);
    r = f.run(f.domain, '--dry');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`plan: .*home/agentic/Carol -> .*Domains/Carol`));
    assert.match(r.stdout, /project .*agent-carol \(brain \.\): adapter, T3 workspaceRoot/);
    assert.ok(fs.existsSync(path.join(f.domain, '.agentic-domain')) && !fs.lstatSync(f.domain).isSymbolicLink(), '--dry changes nothing');

    r = f.run(f.domain);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const dest = path.join(f.domains, 'Carol');
    const newDir = path.join(dest, 'agent-carol');
    assert.ok(fs.lstatSync(f.domain).isSymbolicLink(), 'the old path stays as a symlink');
    assert.equal(fs.realpathSync(f.domain), dest);
    assert.ok(fs.existsSync(path.join(dest, '.agentic-domain')));
    const skill = fs.readFileSync(path.join(newDir, 'skills', 'x', 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`sh ${dest}/agent-carol/scripts/a\\.sh`), 'absolute path rewritten');
    assert.match(skill, new RegExp(` a ${dest}/b;`), 'a ~/ path too; the new root is outside home, so it is absolute');
    assert.match(skill, new RegExp(`nie ${f.domain}-old`), 'a longer name is not a prefix match');
    assert.match(fs.readFileSync(path.join(newDir, 'logs', '2026-11-09.md'), 'utf8'), new RegExp(`ran ${f.domain}/agent-carol`), 'logs stay as written');
    assert.equal(git(newDir, 'status', '--porcelain').trim(), '', 'rewrites are committed by the brain writer');
    assert.match(r.stdout, /policy domain\.allow_outside still allows ~\/agentic \(the old place\)/);
    const hdir = path.join(f.home, '.claude', 'projects');
    const newHist = path.join(hdir, historyName(newDir));
    assert.ok(fs.lstatSync(newHist).isSymbolicLink(), 'new history name points at the old history while old threads run');
    assert.ok(fs.existsSync(path.join(newHist, 's.jsonl')));
    const trust = JSON.parse(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8')).projects;
    assert.ok(trust[newDir]?.hasTrustDialogAccepted, 'trust copied to the new folder');
    assert.match(r.stdout, /adapter agent-carol: settings regenerated/);
    assert.match(r.stdout, new RegExp(`t3_project_update \\(project with workspaceRoot ${f.dir}\\): workspaceRoot ${newDir}`));
    assert.match(r.stdout, /after the T3 server restart: node .*domain-move\.mjs finish .*home\/agentic\/Carol/);

    r = f.run(f.domain);
    assert.notEqual(r.status, 0, 'a second move of the symlink is refused');
    assert.match(r.stdout + r.stderr, /is a symlink \(already moved\?\)/);

    r = f.run('finish', f.domain);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.lstatSync(newHist).isSymbolicLink(), 'the new history is the real folder');
    assert.ok(fs.lstatSync(path.join(hdir, historyName(f.dir))).isSymbolicLink(), 'the old history name is a symlink');
    assert.ok(fs.existsSync(path.join(hdir, historyName(f.dir), 's.jsonl')));
    r = f.run('finish', f.domain);
    assert.match(r.stdout, /nothing to swap/, 'finish is idempotent');
  } finally { f.cleanup(); }
});

test('domain move: the write hook asks the operator before a move, the plan runs without asking', () => {
  const fx = setup();
  try {
    const decision = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }).json.hookSpecificOutput?.permissionDecision || null;
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs ~/agentic/Carol'), 'ask');
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs finish ~/agentic/Carol'), 'ask');
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs ~/agentic/Carol --dry'), null);
    // operator 2026-11-09: the name of the script in a quoted text is no move
    assert.equal(decision('node ~/.claude/skills/workflow/bin/save.mjs handover t --task "vydané: domain-move.mjs presun domény"'), null);
    assert.equal(decision('git log --grep domain-move.mjs; echo domain-move.mjs'), null);
  } finally { fx.cleanup(); }
});

// Audit "false approvals" 2026-11-12: domain-move.mjs without a domain argument only prints its usage and moves nothing; it asked anyway.
test('domain move: the script without a domain argument (usage only) asks nothing', () => {
  const fx = setup();
  try {
    const decision = (command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }).json.hookSpecificOutput?.permissionDecision || null;
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs'), null);
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs finish'), null);
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs --to /x'), null);
    assert.equal(decision('node ~/.claude/skills/workflow/bin/domain-move.mjs ~/agentic/Carol --to /x'), 'ask');
  } finally { fx.cleanup(); }
});
