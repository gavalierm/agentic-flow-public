// Project wizard (skill workflow:project): probe branches, restore, connect with adoption of an older brain,
// tidy of the agreed removals, create, inventory (operator 2026-11-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';
import { classifyNames, decide, probe, restore, connect, create, inventory, issueMailKey } from '../scripts/project.mjs';
import { resolveDomain } from '../scripts/config.mjs';

// The scripts run in this process: same clean environment as the spawned ones.
const clean = cleanEnv();
for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
Object.assign(process.env, clean);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-project-'));
  const root = path.join(base, 'agentic');
  const remotes = path.join(base, 'remotes');
  fs.mkdirSync(root); fs.mkdirSync(remotes);
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, 'tkn\n');
  const remoteFor = (owner, repo) => path.join(remotes, `${repo}.git`);
  // A bare remote with files committed on main (and optional extra branches).
  const seed = (repo, files, branches = {}) => {
    const work = path.join(base, `seed-${repo}`);
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    const put = (fl) => { for (const [f, c] of Object.entries(fl)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c); } };
    put(files); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'seed');
    for (const [b, fl] of Object.entries(branches)) { git(work, 'checkout', '-qb', b); put(fl); git(work, 'add', '-A'); git(work, 'commit', '-qm', b); git(work, 'checkout', '-q', 'main'); }
    git(base, 'clone', '-q', '--bare', work, remoteFor('o', repo));
    return work;
  };
  return { base, root, remotes, tokenFile, remoteFor, seed, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// Fake GitHub for owner "owner1": repos from the remotes directory, root listing from the bare repo,
// PATCH renames the bare repo, POST creates an empty one. The bearer token "agt" is the agent account "agent1";
// the owner invites it as a collaborator and it accepts. calls are "<who> <method> <url>".
async function fakeGithub(sb) {
  const calls = [];
  const invitations = new Map();
  let nextId = 1;
  const repos = () => fs.readdirSync(sb.remotes).filter((n) => n.endsWith('.git')).map((n) => n.slice(0, -4));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const who = req.headers.authorization === 'Bearer agt' ? 'agent1' : 'owner1';
      calls.push(`${who} ${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/user') return send(200, { login: who });
      if (url.pathname === '/user/repos' && req.method === 'GET') return send(200, Number(url.searchParams.get('page')) > 1 ? [] : repos().map((name) => ({ name, private: true, pushed_at: '2026-10-30T00:00:00Z', default_branch: 'main', description: `${name} desc` })));
      if (url.pathname === '/user/repos' && req.method === 'POST') {
        const { name } = JSON.parse(body);
        spawnSync('git', ['init', '-q', '--bare', '-b', 'main', sb.remoteFor('owner1', name)]);
        return send(201, { name });
      }
      const collab = url.pathname.match(/^\/repos\/owner1\/([^/]+)\/collaborators\/([^/]+)$/);
      if (collab && req.method === 'PUT' && who === 'owner1') {
        const id = nextId++;
        invitations.set(id, { id, invitee: collab[2], repository: { full_name: `owner1/${collab[1]}` } });
        return send(201, { id });
      }
      if (url.pathname === '/user/repository_invitations' && req.method === 'GET') return send(200, [...invitations.values()].filter((i) => i.invitee === who));
      const acc = url.pathname.match(/^\/user\/repository_invitations\/(\d+)$/);
      if (acc && req.method === 'PATCH' && invitations.get(Number(acc[1]))?.invitee === who) { invitations.delete(Number(acc[1])); return send(204); }
      const m = url.pathname.match(/^\/repos\/owner1\/([^/]+)(\/contents\/)?$/);
      if (m) {
        const dir = sb.remoteFor('owner1', m[1]);
        if (!fs.existsSync(dir)) return send(404, {});
        if (req.method === 'PATCH') {
          const { name } = JSON.parse(body);
          fs.renameSync(dir, sb.remoteFor('owner1', name));
          return send(200, { name });
        }
        if (m[2]) {
          const r = spawnSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' });
          return r.status === 0 ? send(200, r.stdout.trim().split('\n').filter(Boolean).map((name) => ({ name }))) : send(409, {});
        }
        return send(200, { name: m[1], private: !m[1].startsWith('pub-') });
      }
      send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, invitations, apiUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const LEGACY_BRAIN = {
  'RULES.md': '# Pravidlá\nManuál: /opt/old-global/skills/manual.sh\n',
  'CLAUDE.md': '@RULES.md\n',
  'memory/zadanie.md': '# Zadanie\nStatický web.\n',
  'errors/REGISTER.md': '# Chyby\n',
  'decisions/D0001-web.md': '---\nid: D0001\n---\n# Web\n',
  'decisions/README.md': '# Rozhodnutia\n',
  'artifacts/img.png': '\x89PNG\r\n\x1a\n\0\0\r\n',
  '.githooks/pre-commit': '#!/bin/sh\n/opt/old-global/hook.sh\n',
};

test('classifyNames and decide: workflow project, workflow brain, older setup, plain code, nothing', () => {
  assert.equal(classifyNames(['.workflow.json', 'src']), 'workflow-project');
  assert.equal(classifyNames(['.githooks', 'topics', 'logs', 'exceptions', 'memory']), 'workflow-brain');
  assert.equal(classifyNames(['RULES.md', 'memory']), 'legacy');
  assert.equal(classifyNames(['index.html']), 'code');
  assert.equal(classifyNames([]), 'empty');
  assert.equal(decide([{ kind: 'workflow-project' }], [{ kind: 'legacy' }]), 'restore');
  assert.equal(decide([], [{ kind: 'code' }, { kind: 'legacy' }]), 'adopt');
  assert.equal(decide([], [{ kind: 'code' }, { kind: 'workflow-brain' }]), 'connect');
  assert.equal(decide([], []), 'create');
});

test('connect a public code repo: .workflow.json says visibility public and the line names the brain route', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, remoteFor: sb.remoteFor };
    sb.seed('pub-web', { 'index.html': '<h1>x</h1>\n' });
    const r = await connect({ project: 'pub', repo: 'pub-web', ...opts });
    assert.match(r.lines.join('\n'), /visibility: owner1\/pub-web is PUBLIC: its knowledge stays in brain/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.root, 'Pub', 'pub-web', '.workflow.json'), 'utf8')).visibility, 'public');
    sb.seed('pub2', { 'a.js': '1\n' });
    const r2 = await connect({ project: 'pub', repo: 'pub2', ...opts });
    assert.doesNotMatch(r2.lines.join('\n'), /PUBLIC/, 'a private repo gets no mark');
  } finally { await hub.close(); sb.cleanup(); }
});

test('adopt an older project: probe finds it, connect renames and adopts the brain on its current branch, tidy removes the agreed files, restore pulls', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile };
    assert.equal((await probe('kubo', opts)).branch, 'create');
    sb.seed('kubo-web', { 'index.html': '<h1>x</h1>\n', 'CLAUDE.md': 'old\n' });
    sb.seed('old-brain-kubo', { 'RULES.md': 'main\n' }, { dev: LEGACY_BRAIN });
    const p = await probe('kubo', opts);
    assert.equal(p.branch, 'adopt');
    assert.deepEqual(p.github.map((r) => [r.name, r.kind]), [['kubo-web', 'legacy'], ['old-brain-kubo', 'legacy']]);

    await assert.rejects(connect({ project: 'kubo', repo: 'kubo-web', brain: 'old-brain-kubo', ...opts, remoteFor: sb.remoteFor }), /must be named kubo-brain; run again with --rename-brain/);
    const r = await connect({ project: 'kubo', repo: 'kubo-web', brain: 'old-brain-kubo', renameBrain: true, adopt: true, brainBranch: 'dev', ...opts, remoteFor: sb.remoteFor });
    // Project folder: code repository and one brain of the project side by side.
    const webDir = path.join(sb.root, 'Kubo', 'kubo-web');
    const brainDir = path.join(sb.root, 'Kubo', 'kubo-brain');
    assert.ok(r.lines.includes('brain repository renamed: old-brain-kubo -> kubo-brain'), r.lines.join('\n'));
    assert.ok(hub.calls.includes('owner1 PATCH /repos/owner1/old-brain-kubo'));
    // History and data stay; the old hook is replaced by the workflow one and committed.
    assert.match(fs.readFileSync(path.join(brainDir, 'memory/zadanie.md'), 'utf8'), /Statický web/);
    assert.ok(fs.existsSync(path.join(brainDir, '.githooks', 'pre-commit.mjs')));
    assert.doesNotMatch(fs.readFileSync(path.join(brainDir, '.githooks', 'pre-commit'), 'utf8'), /old-global/);
    assert.match(git(brainDir, 'log', '-1', '--format=%s'), /\[brain-script\] adopt brain into the workflow/);
    assert.equal(git(brainDir, 'status', '--porcelain'), '');
    assert.equal(git(brainDir, 'rev-parse', 'HEAD'), git(sb.remoteFor('o', 'kubo-brain'), 'rev-parse', 'main'));
    assert.equal(git(brainDir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(webDir, '.workflow.json'), 'utf8')).brain, '../kubo-brain');
    // The project folder is a domain (D-0002): without the marker a code topic went to ../kubo-web-topics/ next to
    // the project instead of Kubo/.worktrees/ (home-assistant adopted on Windows, 2026-11-07).
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.root, 'Kubo', '.agentic-domain'), 'utf8')), { brain: 'kubo-brain' });
    assert.equal(resolveDomain(webDir)?.root, path.join(sb.root, 'Kubo'));
    const p2 = await probe('kubo', opts);
    assert.equal(p2.branch, 'restore');
    assert.deepEqual(p2.local.map((l) => [l.name, l.kind]), [['Kubo/kubo-brain', 'workflow-brain'], ['Kubo/kubo-web', 'workflow-project']]);
    // A second code repository of the project shares the brain.
    sb.seed('kubo-app', { 'app.js': '1\n' });
    const r2 = await connect({ project: 'kubo', repo: 'kubo-app', ...opts, remoteFor: sb.remoteFor });
    assert.ok(r2.lines.includes('brain: already cloned'), r2.lines.join('\n'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.root, 'Kubo', 'kubo-app', '.workflow.json'), 'utf8')).brain, '../kubo-brain');
    // url.<base>.insteadOf rewrites the address `git remote get-url` returns (ssh -> https on Windows, flow-public#13):
    // the existing brain clone is still the same repository.
    const remotesDir = path.dirname(sb.remoteFor('o', 'kubo-brain'));
    git(brainDir, 'config', `url.file://${remotesDir}/.insteadOf`, `${remotesDir}/`);
    assert.match(git(brainDir, 'remote', 'get-url', 'origin'), /^file:\/\//);
    sb.seed('kubo-api', { 'api.js': '1\n' });
    const r4 = await connect({ project: 'kubo', repo: 'kubo-api', ...opts, remoteFor: sb.remoteFor });
    assert.ok(r4.lines.includes('brain: already cloned'), r4.lines.join('\n'));
    git(brainDir, 'config', '--remove-section', `url.file://${remotesDir}/`);

    // Inventory marks dead absolute paths.
    const inv = inventory(brainDir);
    assert.deepEqual(inv.items.find((i) => i.path === 'RULES.md').dead, ['/opt/old-global/skills/manual.sh']);
    assert.equal(inv.items.find((i) => i.path === 'errors/REGISTER.md').group, 'errors');

    // tidy: the agreed removals in one brain commit, through the brain script.
    const plan = path.join(sb.base, 'plan.json');
    fs.writeFileSync(path.join(sb.base, 'zadanie.md'), '---\nkey: project-zadanie\norigin: operator\n---\nStatický web.\n');
    fs.writeFileSync(path.join(sb.base, 'd1.md'), '---\nkey: D-0001\nid: D-0001\ntitle: web\nstatus: valid\nrelates_to: [project-kubo]\naliases: [D0001]\ncreated: 2026-10-28\n---\nWeb.\n');
    fs.writeFileSync(plan, JSON.stringify({ remove: ['RULES.md', 'CLAUDE.md', 'decisions/D0001-web.md', 'decisions/README.md'], move: [{ from: 'errors/REGISTER.md', to: 'data/old-errors.md' }], write: [{ path: 'memory/zadanie.md', file: 'zadanie.md' }, { path: 'decisions/d-0001-web.md', file: 'd1.md' }], reason: 'agreed with the operator' }));
    const t = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'project.mjs'), 'tidy', '--project', webDir, '--plan', plan], { cwd: webDir, encoding: 'utf8', env: cleanEnv() });
    assert.equal(t.status, 0, t.stderr + t.stdout);
    assert.ok(!fs.existsSync(path.join(brainDir, 'RULES.md')));
    assert.ok(fs.existsSync(path.join(brainDir, 'data', 'old-errors.md')));
    assert.match(fs.readFileSync(path.join(brainDir, 'memory', 'zadanie.md'), 'utf8'), /^---\nkey: project-zadanie/);
    assert.match(git(brainDir, 'log', '-1', '--format=%s'), /adopt: tidy the older setup/);
    assert.ok(fs.existsSync(path.join(brainDir, 'decisions', 'd-0001-web.md')) && !fs.existsSync(path.join(brainDir, 'decisions', 'README.md')));
    // A workflow decision (with a key) is never deleted.
    const delDecision = path.join(sb.base, 'plan3.json');
    fs.writeFileSync(delDecision, JSON.stringify({ remove: ['decisions/d-0001-web.md'], reason: 'x' }));
    const t3 = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'project.mjs'), 'tidy', '--project', webDir, '--plan', delDecision], { cwd: webDir, encoding: 'utf8', env: cleanEnv() });
    assert.equal(t3.status, 1); assert.match(t3.stderr + t3.stdout, /decisions are never deleted/);
    assert.equal(git(brainDir, 'status', '--porcelain'), '', 'a refused commit leaves the brain clean');
    const noReason = path.join(sb.base, 'plan2.json');
    fs.writeFileSync(noReason, JSON.stringify({ remove: ['memory/zadanie.md'] }));
    const t2 = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'project.mjs'), 'tidy', '--project', webDir, '--plan', noReason], { cwd: webDir, encoding: 'utf8', env: cleanEnv() });
    assert.equal(t2.status, 1); assert.match(t2.stderr, /needs "reason"/);

    // A project folder adopted before the marker existed gets it on restore.
    fs.rmSync(path.join(sb.root, 'Kubo', '.agentic-domain'));
    const rs = restore('kubo', { root: sb.root });
    assert.ok(rs.lines.includes('domain marker written: Kubo/.agentic-domain (brain kubo-brain)'), rs.lines.join('\n'));
    assert.equal(resolveDomain(webDir)?.root, path.join(sb.root, 'Kubo'));
    assert.ok(rs.lines.includes('kubo-web: settings regenerated') && rs.lines.includes('kubo-app: settings regenerated'), rs.lines.join('\n'));
    assert.equal(rs.lines.filter((l) => /^kubo-brain: (up to date|updated)$/.test(l)).length, 1, rs.lines.join('\n'));
    assert.ok(rs.lines.some((l) => /^kubo-web: (uncommitted changes, not pulled|up to date|updated)/.test(l)), rs.lines.join('\n'));
  } finally { await hub.close(); sb.cleanup(); }
});

test('connect refuses an existing directory that is not the clone, and a brain branch that rewrites main', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, remoteFor: sb.remoteFor };
    sb.seed('web1', { 'index.html': 'x\n' });
    sb.seed('web1-brain', { 'RULES.md': 'a\n' }, { dev: { 'RULES.md': 'b\n' } });
    // main moves on after dev split off: dev is not a fast-forward of main.
    const work = path.join(sb.base, 'seed-web1-brain');
    fs.writeFileSync(path.join(work, 'x.md'), 'main only\n'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'main only');
    git(work, 'push', '-q', sb.remoteFor('o', 'web1-brain'), 'main');
    await assert.rejects(connect({ project: 'web1', brain: 'web1-brain', adopt: true, brainBranch: 'dev', ...opts }), /has content that dev lacks/);
    assert.ok(!fs.existsSync(path.join(sb.root, 'web1-brain', 'x.md')) || git(path.join(sb.root, 'Web1', 'web1-brain'), 'status', '--porcelain') === '', 'a refused merge leaves no half state');
    // main with only merge commits of dev (older habit): merged, content of dev.
    const w3 = sb.seed('web3-brain', { 'RULES.md': 'a\n' }, { dev: { 'RULES.md': 'b\n', 'img.png': '\x89PNG\r\n\x1a\n\0\0\r\n' } });
    git(w3, 'merge', '--no-ff', '-qm', 'Merge dev', 'dev');
    git(w3, 'checkout', '-q', 'dev'); fs.writeFileSync(path.join(w3, 'RULES.md'), 'c\n'); fs.writeFileSync(path.join(w3, '.gitattributes'), '* text eol=lf\n'); git(w3, 'add', '-A'); git(w3, 'commit', '-qm', 'dev later'); git(w3, 'checkout', '-q', 'main');
    git(w3, 'push', '-q', sb.remoteFor('o', 'web3-brain'), 'main', 'dev');
    sb.seed('web3', { 'index.html': 'x\n' });
    const r3 = await connect({ project: 'web3', brain: 'web3-brain', adopt: true, brainBranch: 'dev', ...opts });
    assert.ok(r3.lines.includes('brain main merged with dev (main had only merge commits)'), r3.lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(sb.root, 'Web3', 'web3-brain', 'RULES.md'), 'utf8'), 'c\n');
    // The older attributes line (binary files as text) is replaced; images stay byte for byte.
    assert.ok(r3.lines.includes('brain: .gitattributes: binary files kept as they are'), r3.lines.join('\n'));
    assert.equal(git(path.join(sb.root, 'Web3', 'web3-brain'), 'status', '--porcelain'), '');
    // An older lower case project folder is reused, not duplicated by a capitalized one.
    fs.mkdirSync(path.join(sb.root, 'web2', 'web2'), { recursive: true });
    sb.seed('web2', { 'a.txt': 'a\n' });
    await assert.rejects(connect({ project: 'web2', ...opts }), /exists and is not a clone/);
    const { remoteKey } = await import('../scripts/project.mjs');
    const user = `git${'@'}git.example`; // built, so the public leak scan does not read it as an address
    assert.equal(remoteKey(`${user}:O/Repo.git`), remoteKey('https://git.example/o/repo'));
    assert.equal(remoteKey(`ssh://${user}/o/repo.git/`), 'git.example/o/repo');
    assert.notEqual(remoteKey(`${user}:o/repo.git`), remoteKey('https://git.example/o/other.git'));
    // An older flat project (a repository at ~/agentic/<name>) is not turned into a project folder.
    sb.seed('flat', { 'a.txt': 'a\n' });
    git(sb.root, 'clone', '-q', sb.remoteFor('o', 'flat'), 'flat');
    await assert.rejects(connect({ project: 'flat', ...opts }), /is a repository, not a project folder.*--set-aside/s);
    // --set-aside renames it (the agent may not, outside its domain: issue #8) and builds the project folder.
    const ra = await connect({ project: 'flat', setAside: true, ...opts });
    assert.ok(ra.lines.includes('set aside: flat -> flat.pre-adopt'), ra.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(sb.root, 'flat.pre-adopt', '.git')), 'old clone kept');
    assert.ok(fs.existsSync(path.join(sb.root, 'Flat', 'flat', '.git')), 'project cloned into the domain');
    // Named older folders (a wrapper with a space) are set aside too; all names are checked before any rename.
    sb.seed('home-assistant', { 'a.txt': 'a\n' });
    fs.mkdirSync(path.join(sb.root, 'Home assistant', 'old'), { recursive: true });
    await assert.rejects(connect({ project: 'home-assistant', setAside: 'Home assistant,missing', ...opts }), /missing does not exist/);
    assert.ok(fs.existsSync(path.join(sb.root, 'Home assistant')), 'nothing renamed when one name is wrong');
    await assert.rejects(connect({ project: 'home-assistant', setAside: '../x', ...opts }), /takes folder names/);
    await assert.rejects(connect({ project: 'home-assistant', setAside: 'Web3', ...opts }), /is a workflow domain/);
    const rh = await connect({ project: 'home-assistant', setAside: 'Home assistant', ...opts });
    assert.ok(rh.lines.includes('set aside: Home assistant -> Home assistant.pre-adopt'), rh.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(sb.root, 'Home assistant.pre-adopt', 'old')));
    assert.ok(fs.existsSync(path.join(sb.root, 'Home-assistant', 'home-assistant', '.git')));
  } finally { await hub.close(); sb.cleanup(); }
});

test('domain is the folder name the operator chose: spaces allowed, set aside the old folder of that name first (operator 2026-11-07)', async () => {
  const { checkDomainName, domainDir } = await import('../scripts/config.mjs');
  const { sessionRoot } = await import('../scripts/project.mjs');
  assert.equal(checkDomainName('Home assistant'), 'Home assistant');
  for (const bad of ['', ' ', 'a/b', 'a\\b', 'x:y', 'trail ', ' lead', 'dot.', '..', 'q?']) assert.throws(() => checkDomainName(bad), /one folder name/, bad);
  assert.equal(sessionRoot('/d/C p/Home assistant/home-assistant', '/d/C p/Home assistant/home-assistant-brain'), path.resolve('/d/C p'), 'domain with a space');
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, remoteFor: sb.remoteFor };
    assert.equal(domainDir(sb.root, 'home-assistant', 'Home assistant'), path.join(sb.root, 'Home assistant'));
    sb.seed('home-assistant', { 'a.txt': 'a\n' });
    fs.mkdirSync(path.join(sb.root, 'Home assistant', 'config'), { recursive: true });
    await assert.rejects(connect({ project: 'home-assistant', domain: 'Home assistant', ...opts }), /is not a workflow domain.*--set-aside "Home assistant"/s);
    await assert.rejects(connect({ project: 'home-assistant', domain: 'bad/name', ...opts }), /one folder name/);
    const r = await connect({ project: 'home-assistant', domain: 'Home assistant', setAside: 'Home assistant', ...opts });
    assert.ok(r.lines.includes('set aside: Home assistant -> Home assistant.pre-adopt'), r.lines.join('\n'));
    assert.equal(r.projectDir, path.join(sb.root, 'Home assistant', 'home-assistant'));
    assert.ok(fs.existsSync(path.join(sb.root, 'Home assistant', 'home-assistant', '.git')));
    assert.ok(!fs.existsSync(path.join(sb.root, 'Home-assistant')), 'no second domain by the project name');
    // later calls without --domain find it: same name up to spaces and dashes, a workflow project inside
    assert.equal(domainDir(sb.root, 'home-assistant'), path.join(sb.root, 'Home assistant'));
  } finally { await hub.close(); sb.cleanup(); }
});

test('create: private project and brain repositories, purpose in the README, settings; refuses a taken name', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, remoteFor: sb.remoteFor };
    await assert.rejects(create({ name: 'novy', ...opts }), /--purpose/);
    const r = await create({ name: 'novy', repo: 'novy-web', purpose: 'Web pre klienta.', ...opts });
    assert.ok(r.lines.includes('repository created: owner1/novy-web (private)'));
    assert.ok(r.lines.includes('repository created: owner1/novy-brain (private)'));
    assert.ok(r.lines.includes('project: pushed'), r.lines.join('\n'));
    assert.match(git(sb.remoteFor('o', 'novy-web'), 'show', 'main:README.md'), /Web pre klienta\./);
    assert.ok(fs.existsSync(path.join(sb.root, 'Novy', 'novy-brain', 'topics')));
    assert.ok(fs.existsSync(path.join(sb.root, 'Novy', 'novy-web', '.claude', 'settings.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.root, 'Novy', 'novy-web', '.workflow.json'), 'utf8')).brain, '../novy-brain');
    assert.equal(resolveDomain(path.join(sb.root, 'Novy', 'novy-web'))?.brain, path.join(sb.root, 'Novy', 'novy-brain'));
    await assert.rejects(create({ name: 'novy', purpose: 'x', ...opts }), /already exists/);
    assert.throws(() => restore('Novy', { root: sb.root }), /lowercase/);
  } finally { await hub.close(); sb.cleanup(); }
});

test('project roots: names match across case, spaces and dashes; a root next to the session project; branch from disk without GitHub', async () => {
  const { matchKey, sessionRoot, projectRoots } = await import('../scripts/project.mjs');
  assert.equal(matchKey('Home assistant'), matchKey('home-assistant'));
  // <root>/<name>/<repo> next to <root>/<name>/<name>-brain: the root is two levels up; a flat or persona project: one.
  assert.equal(sessionRoot('/d/Claude projekty/flow/flow-rozvoj', '/d/Claude projekty/flow/flow-brain'), path.resolve('/d/Claude projekty'));
  assert.equal(sessionRoot('/r/shop', '/r/shop-brain'), path.resolve('/r'));
  assert.equal(sessionRoot('/r/alice/agent-alice', '/r/alice/agent-alice'), path.resolve('/r/alice'));
  assert.equal(sessionRoot('/r/Shop/shop-web', '/r/Shop/shop-brain'), path.resolve('/r'), 'a capitalized project folder');
  assert.deepEqual(projectRoots({ explicit: ['/x'], env: { WORKFLOW_ROOT_FILE: '/nonexistent-root-file' }, projectDir: '/r/shop', brainDir: '/r/shop-brain', home: '/nonexistent-home' }), [path.resolve('/x'), path.resolve('/r')]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-roots-'));
  try {
    const d = path.join(base, 'Claude projekty');
    fs.mkdirSync(path.join(d, 'home-assistant', 'brain'), { recursive: true });
    fs.writeFileSync(path.join(d, 'home-assistant', 'AGENTS.md'), 'x\n');
    fs.mkdirSync(path.join(d, 'Home assistant', 'config'), { recursive: true });
    const p = await probe('home-assistant', { roots: [path.join(base, 'empty'), d], github: false });
    assert.deepEqual(p.local.map((l) => l.name).sort(), ['Home assistant', 'home-assistant']);
    assert.equal(p.branch, 'adopt', 'the older setup on disk decides without GitHub');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('domain folder: upper case first letter for new domains, an older lower case one is reused (operator 2026-11-07)', async () => {
  const { domainDirName, domainDir } = await import('../scripts/config.mjs');
  assert.equal(domainDirName('bob'), 'Bob');
  assert.equal(domainDirName('web-shop'), 'Web-shop');
  assert.equal(domainDirName('3d'), '3d');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-domdir-'));
  try {
    assert.equal(domainDir(path.join(root, 'missing'), 'kubo'), path.join(root, 'missing', 'Kubo'));
    assert.equal(domainDir(root, 'kubo'), path.join(root, 'Kubo'));
    fs.mkdirSync(path.join(root, 'alice'));
    assert.equal(domainDir(root, 'alice'), path.join(root, 'alice'), 'no second Alice next to alice');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('projects root of the machine: saved by project.mjs root, read by projectRoots before ~/agentic (carol 2026-11-09)', async () => {
  const { machineRoot, setMachineRoot, projectRoots } = await import('../scripts/project.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mroot-'));
  try {
    const env = { HOME: base, WORKFLOW_ROOT_FILE: path.join(base, 'cfg', 'projects-root') };
    const domains = path.join(base, 'Domény');
    fs.mkdirSync(domains);
    const home = path.join(base, 'agentic');
    fs.mkdirSync(home);
    assert.equal(machineRoot(env), null, 'nothing saved');
    assert.deepEqual(projectRoots({ env, home }), [home]);
    assert.throws(() => setMachineRoot(path.join(base, 'missing'), env), /is not a folder/);
    assert.equal(setMachineRoot('~/Domény', env), domains, '~/ expands to HOME');
    assert.equal(machineRoot(env), domains);
    assert.deepEqual(projectRoots({ env, home }), [domains, home], 'the saved root goes first: new projects and personas go there');
    assert.deepEqual(projectRoots({ env: { ...env, WORKFLOW_PROJECTS_ROOT: '/e' }, home }), [path.resolve('/e'), domains, home]);
    const cli = (...a) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'project.mjs'), ...a], { cwd: base, env: cleanEnv({ HOME: base, WORKFLOW_ROOT_FILE: env.WORKFLOW_ROOT_FILE }), encoding: 'utf8' });
    let r = cli('root');
    assert.match(r.stdout, new RegExp(`projects root: ${toPosixRe(domains)} \\(saved in `));
    const other = path.join(base, 'Iné');
    fs.mkdirSync(other);
    r = cli('root', other);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /projects root .*Iné saved for this machine/);
    assert.equal(fs.readFileSync(env.WORKFLOW_ROOT_FILE, 'utf8').trim(), other);
    r = cli('root', path.join(base, 'missing'));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /is not a folder/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
const toPosixRe = (p) => p.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// project create: a new repository gets the machine's agent account as a collaborator before the first push.
// The SSH key belongs to the agent account; without it the push says "Repository not found" (Alice 2026-11-09).
test('create: the agent account is invited to both new repositories and accepts; no agent token, no invitation', async () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.base, 'agent-token'), 'agt\n');
  const hub = await fakeGithub(sb);
  const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, remoteFor: sb.remoteFor };
  try {
    const r = await create({ name: 'novy', repo: 'novy-web', purpose: 'Web.', agentTokenFile: path.join(sb.base, 'agent-token'), ...opts });
    assert.ok(r.lines.includes('agent account agent1: push access to owner1/novy-web'), r.lines.join('\n'));
    assert.ok(r.lines.includes('agent account agent1: push access to owner1/novy-brain'), r.lines.join('\n'));
    assert.ok(hub.calls.includes('owner1 PUT /repos/owner1/novy-web/collaborators/agent1'), hub.calls.join('\n'));
    assert.equal(hub.invitations.size, 0, 'both invitations accepted');
    assert.ok(r.lines.includes('project: pushed'), r.lines.join('\n'));

    const before = hub.calls.length;
    const r2 = await create({ name: 'druhy', purpose: 'Web.', agentTokenFile: path.join(sb.base, 'missing'), ...opts });
    assert.ok(!r2.lines.some((l) => l.startsWith('agent account')), r2.lines.join('\n'));
    assert.ok(!hub.calls.slice(before).some((c) => c.includes('collaborators')));
  } finally { await hub.close(); sb.cleanup(); }
});

// A new brain of connect or create gets its sender key and <brain>/local/comms.json: without them the project's topics
// were not registered and its mail stayed in local/outbox (alice 2026-11-11, adoption with a new brain).
test('issueMailKey: issues a key for the project, writes the brain mail config once and checks the service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mailkey-'));
  try {
    const log = path.join(dir, 'client.log');
    const client = path.join(dir, 'comms.mjs');
    fs.writeFileSync(client, `import fs from 'node:fs';\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');\nif (a[0] === 'key') console.log(JSON.stringify({ sender: a[a.indexOf('--sender') + 1], key: 'k-new' }));\nelse console.log(JSON.stringify({ ok: true, instance_id: 'i1' }));\n`);
    const session = path.join(dir, 'session-brain');
    fs.mkdirSync(path.join(session, 'local'), { recursive: true });
    fs.writeFileSync(path.join(session, 'local', 'comms.json'), JSON.stringify({ instance: 'pilot', key: 'k-session', instance_id: 'i1' }));
    const brainDir = path.join(dir, 'Shop', 'shop-brain');
    const projectDir = path.join(dir, 'Shop', 'shop-web');
    fs.mkdirSync(brainDir, { recursive: true });
    let line = issueMailKey({ projectDir, brainDir, sessionBrain: session, client });
    assert.match(line, /mail: key issued for sender shop-web .*service answers/);
    const file = path.join(brainDir, 'local', 'comms.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { instance: 'pilot', key: 'k-new', instance_id: 'i1' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], ['key', 'add', '--instance', 'pilot', '--sender', 'shop-web']);
    assert.doesNotMatch(line, /k-new/, 'the key is never printed');
    line = issueMailKey({ projectDir, brainDir, sessionBrain: session, client });
    assert.match(line, /mail: config exists/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'no second key');
    fs.rmSync(path.join(brainDir, 'local'), { recursive: true });
    line = issueMailKey({ projectDir, brainDir, sessionBrain: path.join(dir, 'none'), client });
    assert.match(line, /mail: NOT set up \(this session has no mail config[^)]*\): issue a key with node .* key add --instance <instance> --sender shop-web/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
