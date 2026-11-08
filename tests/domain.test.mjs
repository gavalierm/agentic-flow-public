// v3 domain (D-0002, operator 2026-11-04: "agents must not write to top-level directories, their environment is
import os from 'node:os';
// limited to the project"): a `.agentic-domain` marker bounds where agents write; writes outside are denied, not asked.
// Exceptions only from the domain brain policy `domain.allow_outside` (paths and the word "sudo").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { shellWrites } from '../hooks/pre-tool-use.mjs';
import { resolveDomain, allowOutside } from '../scripts/config.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

function domainFx(allow) {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  if (allow) {
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ domain: { allow_outside: allow } }));
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy for test');
  }
  const outside = fs.mkdtempSync(path.join(path.dirname(fx.root), 'wf-outside-'));
  return { fx, outside, cleanup: () => { fx.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); } };
}

test('domain: resolved from the marker above the project; allow_outside expands ~/ and ignores roots and relative paths', () => {
  const d = domainFx(['~/services/x', '/', 'rel/dir', 'sudo']);
  try {
    const dom = resolveDomain(d.fx.project, '/home/u');
    assert.equal(dom.root, d.fx.root);
    assert.equal(dom.brain, d.fx.brain);
    assert.deepEqual(dom.allowOutside, ['/home/u/services/x']);
    assert.equal(dom.sudo, true);
    assert.deepEqual(allowOutside({}), { paths: [], sudo: false });
  } finally { d.cleanup(); }
});

test('domain: sibling repos inside pass; Write, redirects and tool output dirs outside are denied with the scratch route', () => {
  const d = domainFx();
  const { fx } = d;
  try {
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'web', 'a.txt'), content: 'x' } });
    assert.equal(decision(r), null, 'a sibling repo of the domain');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(d.outside, 'a.txt'), content: 'x' } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /outside the domain .*scratch\/ \(gitignored, no confirmation, P-052\).*domain\.allow_outside/);
    assert.doesNotMatch(reason(r), /belongs to the workflow project/);
    // another workflow project (adopted from this thread): its work goes to a thread of that project (agentic-flow-public#9)
    const other = path.join(d.outside, 'Home assistant', 'home-assistant');
    fs.mkdirSync(path.join(other, 'config'), { recursive: true });
    fs.writeFileSync(path.join(other, '.workflow.json'), '{}\n');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `git -C "${other}" rm -q CLAUDE.md; mv x "${other}/config/"` } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /belongs to the workflow project .*Home assistant\/home-assistant: that work runs in a thread of that project.*topic\.mjs create <topic> --kind code --project/);
    // alice 2026-11-04: `wrangler deploy --dry-run --outdir /tmp/claude-1007/wr` wrote to the system temp dir
    for (const command of [`npx wrangler deploy --dry-run --outdir ${d.outside}/wr`, `echo x > ${d.outside}/f`, `cp a.txt ${d.outside}/`, `mkdir -p ${d.outside}/n`, `rm -rf ${d.outside}/old`, `tsc --outDir=${d.outside}/o`]) {
      r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } });
      assert.equal(decision(r), 'deny', command);
    }
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'npx wrangler deploy --dry-run --outdir scratch/wr' } });
    assert.equal(decision(r), null, 'tool output into scratch passes');
  } finally { d.cleanup(); }
});

test('domain: allow_outside paths pass; the marker itself is never written; sudo only with "sudo" in allow_outside', () => {
  const d = domainFx();
  try {
    const marker = path.join(d.fx.root, '.agentic-domain');
    let r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: marker, content: '{"brain":"brain"}' } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /defines the domain boundary/);
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo '{}' > ${marker}` } });
    assert.equal(decision(r), 'deny');
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'sudo systemctl restart x' } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /sudo is not allowed/);
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'echo "sudo is a word" && grep sudo notes.md' } });
    assert.notEqual(decision(r), 'deny', 'sudo as data is not executed');
  } finally { d.cleanup(); }
  const a = domainFx(['sudo']);
  try {
    fs.writeFileSync(path.join(a.fx.brain, 'policy.json'), JSON.stringify({ domain: { allow_outside: [a.outside, 'sudo'] } }));
    let r = a.fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(a.outside, 'svc', 'x.conf'), content: 'x' } });
    assert.equal(decision(r), null, 'an allow_outside path');
    r = a.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'sudo systemctl status x' } });
    assert.notEqual(decision(r), 'deny', 'sudo allowed by the policy');
  } finally { a.cleanup(); }
});

test('P-018: a directory a shell command creates (program side effect) is the thread\'s own and is removed without asking (alice 2026-11-04: rm -rf .wrangler)', () => {
  const fx = setup();
  try {
    const call = (id, command) => ({ tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
    const run = call('t1', 'npx wrangler deploy --dry-run --outdir scratch/wr');
    fx.hook('pre-tool-use.mjs', run);
    fs.mkdirSync(path.join(fx.project, '.wrangler', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, '.wrangler', 'tmp', 'bundle.js'), 'x');
    fx.hook('post-tool-use.mjs', run);
    let r = fx.hook('pre-tool-use.mjs', call('t2', 'rm -rf .wrangler'));
    assert.equal(decision(r), null, JSON.stringify(r.json));
    fs.mkdirSync(path.join(fx.project, 'notes'));
    fs.writeFileSync(path.join(fx.project, 'notes', 'n.md'), 'x');
    r = fx.hook('pre-tool-use.mjs', call('t3', 'rm -rf notes'));
    assert.equal(decision(r), 'ask', 'untracked data the thread did not make still asks');
  } finally { fx.cleanup(); }
});

test('shellWrites: output options, redirects, cp/mv/tee/mkdir targets; devices and reads are not writes', () => {
  assert.deepEqual(shellWrites('npx wrangler deploy --outdir /tmp/wr', '/w'), ['/tmp/wr']);
  assert.deepEqual(shellWrites('cd sub && echo x > f 2>/dev/null', '/w'), ['/w/sub/f']);
  assert.deepEqual(shellWrites('cat /etc/hosts | tee /tmp/h', '/w'), ['/tmp/h']);
  assert.deepEqual(shellWrites('cat /etc/hosts; ls /tmp >&2', '/w'), []);
});

test('shellWrites: -o of find and test is the logical OR, not an output file; gcc/curl -o still is', () => {
  assert.deepEqual(shellWrites('cd /x && find . -path ./.git -prune -o -type f -print | head', '/w'), []);
  assert.deepEqual(shellWrites('[ -f a -o -f b ] && test -d c -o -d d', '/w'), []);
  assert.deepEqual(shellWrites('gcc main.c -o /tmp/a.out', '/w'), ['/tmp/a.out']);
  assert.deepEqual(shellWrites('curl -s -o out.json https://x', '/w'), ['/w/out.json']);
});

test('shellWrites: temp dir variables, mktemp and PowerShell write cmdlets resolve to their target (alice 2026-11-07)', () => {
  const t = os.tmpdir();
  assert.deepEqual(shellWrites('echo x > ${TMPDIR}/a', '/w'), [path.join(t, 'a')]);
  assert.deepEqual(shellWrites('echo x > %TEMP%/a.bat', '/w'), [path.join(t, 'a.bat')]);
  assert.deepEqual(shellWrites('mktemp -d', '/w'), [path.join(t, 'mktemp')]);
  assert.deepEqual(shellWrites('mktemp -p scratch', '/w'), []);
  assert.deepEqual(shellWrites('"x" | Out-File -FilePath $env:TMP/o.txt -Encoding utf8', '/w'), [path.join(t, 'o.txt')]);
  assert.deepEqual(shellWrites('Set-Content $env:TEMP/a.ps1 x', '/w'), [path.join(t, 'a.ps1')]);
  assert.deepEqual(shellWrites('New-Item -ItemType File -Path n.txt -Force', '/w'), ['/w/n.txt']);
  assert.deepEqual(shellWrites('Copy-Item -Path a.ps1 -Destination ([IO.Path]::GetTempPath())', '/w'), [t]);
  assert.deepEqual(shellWrites('Get-Content $env:TEMP/a', '/w'), []);
});

test('code topic in a domain: git worktree <domain>/.worktrees/<repo>/<id> on topic/<id>; done merges it and removes the worktree and branch', async () => {
  const { spawnSync } = await import('node:child_process');
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    const r0 = fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--kind', 'code']);
    assert.equal(r0.status, 0, r0.out);
    const wt = path.join(fx.root, '.worktrees', 'project', 'feat');
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'a worktree, not a clone');
    assert.equal(fx.git(wt, 'branch', '--show-current'), 'topic/feat');
    const topic = JSON.parse(fx.read('topics/feat/topic.json'));
    assert.equal(topic.repo, 'project');
    assert.equal(topic.copy, '../.worktrees/project/feat');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'feature.txt'), content: 'x' } });
    assert.equal(decision(r), null, 'the worktree is inside the domain');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feat']]) spawnSync('git', args, { cwd: wt });
    r = fx.run('done.mjs', ['--topic', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /note: agentic\/HANDOVER\.md did not change in topic\/feat; .*save\.mjs handover --repo project/, 'the repo HANDOVER is the project state (D-0002)');
    assert.ok(fs.existsSync(path.join(fx.project, 'feature.txt')));
    assert.ok(!fs.existsSync(wt));
    assert.doesNotMatch(fx.git(fx.project, 'worktree', 'list'), /feat/);
    assert.doesNotMatch(fx.git(fx.project, 'branch'), /topic\/feat/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'EnterWorktree', tool_input: {} });
    assert.equal(decision(r), 'deny', 'harness worktrees outside the domain are not used');
  } finally { fx.cleanup(); }
});

test('project knowledge: <repo>/agentic/ records of the domain are found and bind decisions like brain records', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    const dir = path.join(fx.root, 'srv', 'agentic');
    fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'runbooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'HANDOVER.md'), '# Handover srv\n\nState of the server for whoever takes it over.\n');
    fs.writeFileSync(path.join(dir, 'runbooks', 'caddy-reload.md'), '---\ntitle: Caddy reload\ndescription: How to reload caddy safely\n---\nsteps\n');
    fs.writeFileSync(path.join(dir, 'decisions', 'd-0001-caddy.md'), '---\nid: D-0001\ntitle: Caddy as proxy\nstatus: valid\nrelates_to: [srv/Caddyfile]\n---\nwhy\n');
    let r = fx.run('find.mjs', ['caddy', 'reload']);
    assert.match(r.stdout, /\.\.\/srv\/agentic\/runbooks\/caddy-reload\.md: How to reload caddy safely/);
    r = fx.run('find.mjs', ['srv-handover']);
    assert.match(r.stdout, /\.\.\/srv\/agentic\/HANDOVER\.md/);
    r = fx.run('find.mjs', ['--relates-to', 'srv/Caddyfile']);
    assert.match(r.stdout, /d-0001-caddy\.md/);
  } finally { fx.cleanup(); }
});

test('services: ~/services/<repo> is written only by a release checkout, unless allow_outside lists it (D-0003)', () => {
  const d = domainFx();
  try {
    const home = d.outside;
    const env = { env: { HOME: home, WORKFLOW_SERVICES_DIR: path.join(home, 'services') } };
    let r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(home, 'services', 'agentic-comms', 'bin', 'x.mjs'), old_string: 'a', new_string: 'b' } }, env);
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /installed release/);
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo x > ${home}/services/agentic-comms/x` } }, env);
    assert.equal(decision(r), 'deny');
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `git -C ${home}/services/agentic-comms checkout v1.0.0` } }, env);
    assert.notEqual(decision(r), 'deny', 'release checkout passes');
    // operator 2026-11-05: an explicit allow_outside entry for ~/services/<repo> must work (it was ignored)
    fs.writeFileSync(path.join(d.fx.brain, 'policy.json'), JSON.stringify({ domain: { allow_outside: [`${home}/services/agentic-flow`] } }));
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `rm -rf ${home}/services/agentic-flow` } }, env);
    assert.notEqual(decision(r), 'deny', 'allow_outside entry lets the operator-approved path be removed');
    r = d.fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo x > ${home}/services/agentic-comms/x` } }, env);
    assert.equal(decision(r), 'deny', 'a sibling not listed stays protected');
  } finally { d.cleanup(); }
});

test('mail v3: a persona repo agent-<name> keeps the mail name <name>; the installed client in ~/services is found first', async () => {
  const { mailProjectName, commsSettings, servicesClient } = await import('../scripts/comms.mjs');
  assert.equal(mailProjectName({ projectName: 'agent-alice', persona: true }), 'alice');
  assert.equal(mailProjectName({ projectName: 'agent-alice', persona: false }), 'agent-alice');
  assert.equal(mailProjectName({ projectName: 'myserver', persona: false }), 'myserver');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  const prev = process.env.HOME;
  try {
    process.env.HOME = home;
    const client = servicesClient();
    fs.mkdirSync(path.dirname(client), { recursive: true });
    fs.writeFileSync(client, '');
    const s = commsSettings({ projectDir: path.join(home, 'agentic', 'alice', 'agent-alice'), projectName: 'agent-alice', persona: true, config: {}, brainDir: null });
    assert.equal(s.client, client);
    assert.equal(s.project, 'alice');
  } finally { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveProject: a session project that became a domain root resolves to the domain brain project', async () => {
  const { domainRootProject, resolveProject } = await import('../scripts/config.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-domroot-'));
  try {
    const persona = path.join(root, 'agent-x');
    fs.mkdirSync(persona);
    fs.writeFileSync(path.join(persona, '.workflow.json'), '{"brain":"."}');
    assert.equal(domainRootProject(root), root, 'no marker: unchanged');
    fs.writeFileSync(path.join(root, '.agentic-domain'), '{"brain":"agent-x"}');
    assert.equal(domainRootProject(root), persona);
    assert.equal(domainRootProject(persona), persona, 'a project with its own config stays');
    const saved = { w: process.env.WORKFLOW_PROJECT_DIR, c: process.env.CLAUDE_PROJECT_DIR };
    delete process.env.WORKFLOW_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try { assert.equal(resolveProject(), persona); } finally {
      if (saved.w === undefined) delete process.env.WORKFLOW_PROJECT_DIR; else process.env.WORKFLOW_PROJECT_DIR = saved.w;
      if (saved.c === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.c;
    }
    fs.writeFileSync(path.join(root, '.agentic-domain'), '{"brain":"../elsewhere"}');
    assert.equal(domainRootProject(root), root, 'brain outside the domain root: unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
