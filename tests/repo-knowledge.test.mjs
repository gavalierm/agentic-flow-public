// Knowledge of one repo lives in <repo>/agentic/ (D-0002, P-007 step 4): save --repo writes and commits it in the repo,
// never in brain; find, dedup and decision numbers cover the repos and their topic worktrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject } from './helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

function domainFx({ branch = 'main' } = {}) {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  const srv = path.join(fx.root, 'srv');
  initProject(srv);
  if (branch) {
    fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: branch }) + '\n');
    git(srv, 'commit', '-qam', 'knowledge branch');
  }
  return { fx, srv };
}

test('repo knowledge: save --repo commits into the repo on its knowledge branch, brain stays untouched', () => {
  const { fx, srv } = domainFx({ branch: null });
  try {
    const brainHead = git(fx.brain, 'rev-parse', 'HEAD');
    let r = fx.run('save.mjs', ['memory', 'service', 'caddy', '--content', 'Caddy proxies srv.', '--repo', 'srv']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /no knowledge branch: set "knowledge_branch"/);
    fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'main' }) + '\n');
    git(srv, 'commit', '-qam', 'knowledge branch');
    fs.writeFileSync(path.join(srv, 'src', 'app.js'), 'console.log(2);\n');
    r = fx.run('save.mjs', ['memory', 'service', 'caddy', '--content', 'Caddy proxies srv.', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /written: srv\/agentic\/memory\/service-caddy\.md \(srv [0-9a-f]+\) \[main, not pushed\]/);
    assert.equal(git(srv, 'log', '-1', '--format=%s'), '[brain-script] save memory service-caddy');
    assert.deepEqual(git(srv, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['agentic/memory/service-caddy.md']);
    assert.match(git(srv, 'status', '--porcelain'), /M src\/app\.js/, 'foreign uncommitted change stays uncommitted');
    assert.equal(git(fx.brain, 'rev-parse', 'HEAD'), brainHead);
    r = fx.run('find.mjs', ['service-caddy']);
    assert.match(r.stdout, /\.\.\/srv\/agentic\/memory\/service-caddy\.md/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: a knowledge branch not checked out is written through a temporary worktree that is removed', () => {
  const { fx, srv } = domainFx({ branch: null });
  try {
    fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'know' }) + '\n');
    git(srv, 'commit', '-qam', 'knowledge branch');
    git(srv, 'branch', 'know');
    const r = fx.run('save.mjs', ['handover', '--repo', 'srv', '--content', '# Stav srv\n\nBeží.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /written: srv\/agentic\/HANDOVER\.md .*\[know, not pushed\]/);
    assert.equal(git(srv, 'show', 'know:agentic/HANDOVER.md'), '# Stav srv\n\nBeží.');
    assert.equal(fs.existsSync(path.join(srv, 'agentic')), false, 'the checked out main is untouched');
    assert.equal(git(srv, 'worktree', 'list').split('\n').length, 1, 'no worktree left');
  } finally { fx.cleanup(); }
});

test('repo knowledge: project-<repo> is refused in brain, one key lives in one place, --brain keeps it with a reason', () => {
  const { fx } = domainFx();
  try {
    let r = fx.run('save.mjs', ['memory', 'project', 'srv', '--content', 'Opis srv.']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /project-srv describes repo srv: .*add --repo srv/);
    r = fx.run('save.mjs', ['memory', 'project', 'srv', '--content', 'Opis srv.', '--brain', 'kept for the test']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['memory', 'project', 'srv', '--content', 'Opis srv.', '--repo', 'srv']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /project-srv already exists in brain: memory\/project-srv\.md.*save\.mjs move memory\/project-srv\.md --repo srv/);
    r = fx.run('save.mjs', ['memory', 'service', 'web', '--content', 'Web.', '--relates-to', 'srv/web.conf']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /note: looks like repo srv/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: decisions are numbered per repo over the main checkout and every topic worktree', () => {
  const { fx, srv } = domainFx();
  try {
    let r = fx.run('save.mjs', ['decision', 'Caddy as proxy', '--what', 'Caddy', '--reason', 'simple', '--relates-to', 'srv/Caddyfile', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /decision srv\/D-0001/);
    const wt = path.join(fx.root, '.worktrees', 'srv', 't1');
    git(srv, 'worktree', 'add', '-q', '-b', 'topic/t1', wt);
    fs.mkdirSync(path.join(wt, 'agentic', 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'agentic', 'decisions', 'd-0002-tls.md'), '---\nkey: D-0002\nid: D-0002\ntitle: TLS by caddy\nstatus: valid\nrelates_to: [srv/Caddyfile]\n---\nx\n');
    r = fx.run('find.mjs', ['D-0002']);
    assert.match(r.stdout, /\.worktrees\/srv\/t1\/agentic\/decisions\/d-0002-tls\.md/);
    r = fx.run('find.mjs', ['D-0001']);
    assert.equal(r.stdout.split('\n').filter((l) => l.includes('srv/')).length, 1, 'a file the worktree did not change is listed once');
    r = fx.run('save.mjs', ['decision', 'Logs to journald', '--what', 'journald', '--reason', 'one place', '--relates-to', 'srv/caddy.service', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /decision srv\/D-0003/);
    assert.equal(fs.readdirSync(path.join(fx.brain, 'decisions')).filter((f) => f.endsWith('.md')).length, 0);
  } finally { fx.cleanup(); }
});

test('repo knowledge: inside a held code topic of the repo the save goes to its worktree branch', () => {
  const { fx, srv } = domainFx();
  try {
    const wt = path.join(fx.root, '.worktrees', 'srv', 't1');
    git(srv, 'worktree', 'add', '-q', '-b', 'topic/t1', wt);
    fs.mkdirSync(path.join(fx.brain, 'topics', 't1'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'topics', 't1', 'topic.json'), JSON.stringify({ id: 't1', kind: 'code' }));
    fs.writeFileSync(path.join(fx.brain, 'topics', 't1', 'holder.json'), JSON.stringify({ thread: fx.thread }));
    const r = fx.run('save.mjs', ['memory', 'service', 'caddy', '--content', 'Caddy.', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[topic t1 worktree, topic\/t1: reaches the repo through done --topic\]/);
    assert.equal(git(wt, 'log', '-1', '--format=%s'), '[brain-script] save memory service-caddy');
    assert.equal(fs.existsSync(path.join(srv, 'agentic')), false);
  } finally { fx.cleanup(); }
});

test('repo knowledge: a commit the repo refuses leaves nothing behind', () => {
  const { fx, srv } = domainFx();
  try {
    fs.writeFileSync(path.join(srv, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho tests failed >&2\nexit 1\n', { mode: 0o755 });
    const r = fx.run('save.mjs', ['memory', 'service', 'caddy', '--content', 'Caddy.', '--repo', 'srv']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /commit into srv \(main\) failed: tests failed/);
    assert.equal(fs.existsSync(path.join(srv, 'agentic', 'memory', 'service-caddy.md')), false);
    assert.equal(git(srv, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});

test('repo knowledge: save move writes the record into the repo and removes it from brain; skills keep one name per domain', () => {
  const { fx, srv } = domainFx();
  try {
    let r = fx.run('save.mjs', ['decision', 'Caddy as proxy', '--what', 'Caddy', '--reason', 'simple', '--relates-to', 'srv/Caddyfile', '--brain', 'test of the move']);
    assert.equal(r.status, 0, r.out);
    const rel = `decisions/${fs.readdirSync(path.join(fx.brain, 'decisions')).find((f) => f.startsWith('d-0001'))}`;
    r = fx.run('save.mjs', ['move', rel, '--repo', 'srv', '--dry-run']);
    assert.match(r.out, /dry run: decisions\/d-0001-caddy-as-proxy\.md -> srv\/agentic\/decisions\/d-0001-caddy-as-proxy\.md/);
    assert.ok(fs.existsSync(path.join(fx.brain, rel)));
    r = fx.run('save.mjs', ['move', rel, '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(fx.brain, rel)), false);
    assert.match(git(srv, 'show', 'HEAD:agentic/decisions/d-0001-caddy-as-proxy.md'), /moved_from: brain\/D-0001/);
    r = fx.run('save.mjs', ['skill', 'caddy-reload', '--description', 'Použi, keď reloaduješ caddy', '--content', 'Reload.', '--origin', 'routine', '--repo', 'srv']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['skill', 'caddy-reload', '--description', 'Použi, keď reloaduješ caddy', '--content', 'Reload.', '--origin', 'routine']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /skill caddy-reload exists in repo srv/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: bare --repo is the session repo; a folder of nested domains (pilot) is no repo', () => {
  const { fx } = domainFx();
  try {
    const pilot = path.join(fx.root, 'pilot');
    fs.mkdirSync(path.join(pilot, 'a'), { recursive: true });
    fs.writeFileSync(path.join(pilot, 'a', '.agentic-domain'), '{"brain":"b"}');
    fs.mkdirSync(path.join(pilot, 'agentic', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(pilot, 'agentic', 'memory', 'tool-x.md'), '---\nkey: tool-x\norigin: operator\n---\nx\n');
    let r = fx.run('find.mjs', ['tool-x']);
    assert.doesNotMatch(r.stdout, /pilot/);
    r = fx.run('save.mjs', ['memory', 'tool', 'x', '--content', 'x', '--repo', 'pilot']);
    assert.match(r.out, /no such repo in domain .*\(repos: project, srv\)/);
    fs.writeFileSync(path.join(fx.project, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'main' }) + '\n');
    git(fx.project, 'commit', '-qam', 'knowledge branch');
    r = fx.run('save.mjs', ['memory', 'tool', 'x', '--content', 'x', '--repo']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /written: project\/agentic\/memory\/tool-x\.md/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: the hook denies Write, Edit and shell writes into <repo>/agentic/ with the save route; reading passes', () => {
  const { fx, srv } = domainFx();
  try {
    const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
    const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
    fs.mkdirSync(path.join(srv, 'agentic'), { recursive: true });
    fs.writeFileSync(path.join(srv, 'agentic', 'HANDOVER.md'), '# srv\n');
    git(srv, 'add', '-A'); git(srv, 'commit', '-qm', 'handover');
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(srv, 'agentic', 'memory', 'x.md'), content: 'x' } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /srv\/agentic\/ is written only by save .*--repo srv/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(srv, 'agentic', 'HANDOVER.md'), old_string: 'srv', new_string: 'x' } });
    assert.equal(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(srv, 'agentic', 'HANDOVER.md')}` } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /written only by save/);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `cat ${path.join(srv, 'agentic', 'HANDOVER.md')}` } });
    assert.notEqual(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(srv, 'src', 'other.js'), content: 'x' } });
    assert.doesNotMatch(reason(r), /written only by save/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: start deploys skills of the session repo and of a held code topic, shows the repo line and its HANDOVER', () => {
  const { fx, srv } = domainFx();
  try {
    const skill = (dir, name) => {
      fs.mkdirSync(path.join(dir, 'agentic', 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(dir, 'agentic', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Použi, keď test ${name}.\n---\nKrok.\n`);
    };
    skill(fx.project, 'project-run');
    const wt = path.join(fx.root, '.worktrees', 'srv', 't1');
    git(srv, 'worktree', 'add', '-q', '-b', 'topic/t1', wt);
    skill(wt, 'srv-deploy');
    fs.writeFileSync(path.join(wt, 'agentic', 'HANDOVER.md'), '# Stav srv\n\nBeží na porte 8080.\n');
    fs.mkdirSync(path.join(fx.brain, 'topics', 't1'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'topics', 't1', 'topic.json'), JSON.stringify({ id: 't1', kind: 'code' }));
    fs.writeFileSync(path.join(fx.brain, 'topics', 't1', 'holder.json'), JSON.stringify({ thread: fx.thread }));
    let r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    for (const name of ['project-run', 'srv-deploy']) assert.ok(fs.existsSync(path.join(fx.project, '.claude', 'skills', name, 'SKILL.md')), name);
    assert.match(r.context, /repo vedomosti: project 1 záznamov, bez HANDOVER/);
    assert.match(r.context, /repo vedomosti: srv \(téma t1\) 1 záznamov, HANDOVER\nHANDOVER srv \(stav projektu\):\n# Stav srv\n\nBeží na porte 8080\./);
    // One name has one home: a brain skill of the same name is an error at start, nothing is overwritten silently.
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'srv-deploy'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'srv-deploy', 'SKILL.md'), '---\nname: srv-deploy\ndescription: Použi, keď brain.\n---\nx\n');
    r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(r.context, /repo skill name\(s\) collide with brain, workflow or another repo skill: srv\/srv-deploy/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: consolidate reports repos (counts, HANDOVER limit, stale derived, a key both in brain and in a repo)', () => {
  const { fx, srv } = domainFx();
  try {
    fs.writeFileSync(path.join(srv, 'web.conf'), 'port 80\n');
    git(srv, 'add', '-A'); git(srv, 'commit', '-qm', 'conf');
    let r = fx.run('save.mjs', ['memory', 'service', 'web', '--content', 'Web na 80.', '--repo', 'srv', '--origin', 'derived', '--sources', 'web.conf']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['memory', 'tool', 'curl', '--content', 'Curl.']);
    assert.equal(r.status, 0, r.out);
    // Written by hand (an older save, a merge): consolidate finds what save itself refuses.
    fs.writeFileSync(path.join(srv, 'agentic', 'memory', 'tool-curl.md'), '---\nkey: tool-curl\norigin: operator\n---\nCurl.\n');
    fs.writeFileSync(path.join(srv, 'agentic', 'HANDOVER.md'), '# Stav\n' + 'riadok\n'.repeat(160));
    git(srv, 'add', '-A'); git(srv, 'commit', '-qm', 'by hand');
    fs.writeFileSync(path.join(srv, 'web.conf'), 'port 8080\n');
    r = fx.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /repo knowledge: srv memory 2, decisions 0, runbooks 0, skills 0, HANDOVER/);
    assert.match(r.out, /in brain and in a repo .*: tool-curl: memory\/tool-curl\.md \+ \.\.\/srv\/agentic\/memory\/tool-curl\.md/);
    assert.match(r.out, /srv\/agentic\/HANDOVER\.md 16\d lines > 150/);
    assert.match(r.out, /stale derived .*\.\.\/srv\/agentic\/memory\/service-web\.md/);
  } finally { fx.cleanup(); }
});

test('repo knowledge: operator and person records stay in brain (save --repo and move refuse them)', () => {
  const { fx } = domainFx();
  try {
    let r = fx.run('save.mjs', ['memory', 'person', 'jakub', '--content', 'Jakub.', '--repo', 'srv']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /person records stay in brain/);
    r = fx.run('save.mjs', ['memory', 'operator', 'codeword', '--content', 'Slovo.']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('save.mjs', ['move', 'memory/operator-codeword.md', '--repo', 'srv', '--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /memory\/operator-codeword\.md: operator records stay in brain/);
  } finally { fx.cleanup(); }
});
