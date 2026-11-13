// Taking over a project from another owner's repositories: probe and connect --owner (repositories the operator reaches
// as a collaborator, agent access only where the operator may invite), restore attaches the brain and issues the mail
// key, attach commits hooks git keeps as 100644 as 100755 so the brain stays clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, cleanEnv, initProject, setup } from './helpers.mjs';
import { connect } from '../scripts/project.mjs';

// The scripts run in this process: same clean environment as the spawned ones.
const clean = cleanEnv();
for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
Object.assign(process.env, clean);

const BIN = (name) => path.join(PLUGIN_ROOT, 'bin', name);
const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const OTHER = 'other-owner';
const HOOKS = ['.githooks/pre-commit', '.githooks/commit-msg'];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const modeOf = (dir, rel) => git(dir, 'ls-tree', 'HEAD', '--', rel).split(' ')[0];

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-foreign-'));
  const root = path.join(base, 'agentic');
  const remotes = path.join(base, 'remotes');
  const home = path.join(base, 'home');
  for (const d of [root, remotes, home]) fs.mkdirSync(d);
  const tokenFile = path.join(base, 'token');
  const agentTokenFile = path.join(base, 'agent-token');
  fs.writeFileSync(tokenFile, 'tkn\n');
  fs.writeFileSync(agentTokenFile, 'agt\n');
  const remoteFor = (owner, repo) => path.join(remotes, owner, `${repo}.git`);
  const seed = (owner, repo, files) => {
    const work = path.join(base, `seed-${owner}-${repo}`);
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c); }
    git(work, 'add', '-A'); git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
    fs.mkdirSync(path.join(remotes, owner), { recursive: true });
    git(base, 'clone', '-q', '--bare', work, remoteFor(owner, repo));
  };
  // A workflow brain of another owner (made by brain-init, pushed to its bare remote).
  const seedBrain = (owner, repo) => {
    fs.mkdirSync(path.join(remotes, owner), { recursive: true });
    git(base, 'init', '-q', '--bare', '-b', 'main', remoteFor(owner, repo));
    const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), path.join(base, `seed-${repo}`), '--remote', remoteFor(owner, repo)], { env: cleanEnv(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  return { base, root, remotes, home, tokenFile, agentTokenFile, remoteFor, seed, seedBrain, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// Fake GitHub: the token "tkn" is the operator "owner1", "agt" the agent account "agent1". /user/repos lists owner1's
// repositories (affiliation owner) and, with affiliation collaborator, those of other owners (push, admin only where
// listed in `admin`). Inviting into another owner's repository needs admin (403 otherwise, as GitHub); the agent sees
// it only after it accepted an invitation. POST /user/repos creates in owner1 only. calls: "<who> <method> <url>".
async function fakeGithub(sb, { admin = [] } = {}) {
  const calls = [];
  const invitations = new Map();
  const granted = new Set();
  let nextId = 1;
  const reposOf = (owner) => { const d = path.join(sb.remotes, owner); return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.git')).map((n) => n.slice(0, -4)) : []; };
  const invite = (owner, repo, invitee) => { const id = nextId++; invitations.set(id, { id, invitee, repository: { full_name: `${owner}/${repo}` } }); return id; };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const who = req.headers.authorization === 'Bearer agt' ? 'agent1' : 'owner1';
      calls.push(`${who} ${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/user') return send(200, { login: who });
      if (url.pathname === '/user/repos' && req.method === 'GET') {
        if (Number(url.searchParams.get('page')) > 1 || who !== 'owner1') return send(200, []);
        const aff = String(url.searchParams.get('affiliation') || '').split(',');
        const owners = [...(aff.includes('owner') ? ['owner1'] : []), ...(aff.includes('collaborator') ? fs.readdirSync(sb.remotes).filter((o) => o !== 'owner1') : [])];
        return send(200, owners.flatMap((owner) => reposOf(owner).map((name) => ({ name, owner: { login: owner }, private: true, pushed_at: '2026-10-30T00:00:00Z', default_branch: 'main', description: '', permissions: { admin: owner === 'owner1' || admin.includes(`${owner}/${name}`), push: true } }))));
      }
      if (url.pathname === '/user/repos' && req.method === 'POST') {
        const { name } = JSON.parse(body);
        fs.mkdirSync(path.join(sb.remotes, 'owner1'), { recursive: true });
        spawnSync('git', ['init', '-q', '--bare', '-b', 'main', sb.remoteFor('owner1', name)]);
        return send(201, { name });
      }
      const collab = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)$/);
      if (collab && req.method === 'PUT') {
        if (who !== 'owner1' || (collab[1] !== 'owner1' && !admin.includes(`${collab[1]}/${collab[2]}`))) return send(403, { message: 'Must have admin rights to Repository.' });
        return send(201, { id: invite(collab[1], collab[2], collab[3]) });
      }
      if (url.pathname === '/user/repository_invitations' && req.method === 'GET') return send(200, [...invitations.values()].filter((i) => i.invitee === who));
      const acc = url.pathname.match(/^\/user\/repository_invitations\/(\d+)$/);
      if (acc && req.method === 'PATCH' && invitations.get(Number(acc[1]))?.invitee === who) {
        granted.add(`${who} ${invitations.get(Number(acc[1])).repository.full_name}`);
        invitations.delete(Number(acc[1]));
        return send(204);
      }
      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/contents\/)?$/);
      if (m) {
        const dir = sb.remoteFor(m[1], m[2]);
        if (!fs.existsSync(dir)) return send(404, {});
        if (who === 'agent1' && m[1] !== 'owner1' && !granted.has(`agent1 ${m[1]}/${m[2]}`)) return send(404, { message: 'Not Found' });
        if (m[3]) {
          const r = spawnSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' });
          return r.status === 0 ? send(200, r.stdout.trim().split('\n').filter(Boolean).map((name) => ({ name }))) : send(409, {});
        }
        return send(200, { name: m[2], private: true, permissions: { push: true, admin: m[1] === 'owner1' || admin.includes(`${m[1]}/${m[2]}`) } });
      }
      send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, invite, apiUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// The CLI in a child process, asynchronous: the fake GitHub answers from this process.
function cli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN('project.mjs'), ...args], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, out: stdout + stderr }));
  });
}

test('probe --owner lists the repositories of another owner the operator reaches, with its access; without it only the operator\'s', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb, { admin: [`${OTHER}/shop-admin`] });
  try {
    sb.seed(OTHER, 'shop', { 'index.js': '1\n' });
    sb.seed(OTHER, 'shop-admin', { 'index.js': '1\n' });
    sb.seed('owner1', 'shop-site', { 'index.html': '<h1>x</h1>\n' });
    const env = cleanEnv({ HOME: sb.home, GITHUB_API_URL: hub.apiUrl, WORKFLOW_PROJECTS_ROOT: sb.root });
    const foreign = await cli(['probe', 'shop', '--owner', OTHER, '--token-file', sb.tokenFile], { cwd: sb.base, env });
    assert.equal(foreign.status, 0, foreign.out);
    assert.match(foreign.out, new RegExp(`github \\(${OTHER}\\):`));
    assert.match(foreign.out, new RegExp(`- ${OTHER}/shop: code, private, access push,`));
    assert.match(foreign.out, new RegExp(`- ${OTHER}/shop-admin: code, private, access admin,`));
    assert.doesNotMatch(foreign.out, /owner1\/shop-site/, 'the operator\'s own repositories are not listed for another owner');
    assert.match(foreign.out, /branch: connect/);
    assert.ok(hub.calls.some((c) => /affiliation=owner,collaborator,organization_member/.test(c)), hub.calls.join('\n'));

    const own = await cli(['probe', 'shop', '--token-file', sb.tokenFile], { cwd: sb.base, env });
    assert.equal(own.status, 0, own.out);
    assert.match(own.out, /github \(owner1\):\n- owner1\/shop-site: code, private, default main/);
    assert.doesNotMatch(own.out, new RegExp(OTHER));

    const bare = await cli(['probe', 'shop', '--owner', '--token-file', sb.tokenFile], { cwd: sb.base, env });
    assert.notEqual(bare.status, 0);
    assert.match(bare.out, /--owner takes a GitHub account or organization/);
  } finally { await hub.close(); sb.cleanup(); }
});

test('connect --owner: code repository of another owner, agent access it cannot give is a NOT line, brain in the operator\'s account', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb);
  try {
    sb.seed(OTHER, 'shop', { 'index.js': '1\n' });
    const opts = { root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, agentTokenFile: sb.agentTokenFile, remoteFor: sb.remoteFor };
    const r = await connect({ project: 'shop', owner: OTHER, ...opts });
    const text = r.lines.join('\n');
    assert.equal(r.owner, OTHER);
    assert.match(text, new RegExp(`agent account agent1: NO push access to ${OTHER}/shop \\(the operator's token cannot invite it, HTTP 403: Must have admin rights to Repository\\.; only the owner or an admin can\\): ask ${OTHER} to add agent1 as a collaborator with write access, then run connect again`));
    assert.match(text, new RegExp(`brain: in the operator's account, owner1/shop-brain \\(${OTHER} has no shop-brain\\)`));
    assert.match(text, /repository created: owner1\/shop-brain \(private\)/);
    assert.match(text, /agent account agent1: push access to owner1\/shop-brain$/m);
    assert.equal(git(r.projectDir, 'remote', 'get-url', 'origin'), sb.remoteFor(OTHER, 'shop'));
    assert.equal(git(r.brainDir, 'remote', 'get-url', 'origin'), sb.remoteFor('owner1', 'shop-brain'));
    assert.ok(!fs.existsSync(sb.remoteFor(OTHER, 'shop-brain')), 'nothing is created under the other owner');
    assert.ok(hub.calls.includes(`owner1 PUT /repos/${OTHER}/shop/collaborators/agent1`), hub.calls.join('\n'));

    await assert.rejects(connect({ project: 'nope', owner: OTHER, ...opts }), new RegExp(`${OTHER}/nope not found with the operator's token`));
    await assert.rejects(connect({ project: 'shop', owner: 'bad owner', ...opts }), /--owner takes a GitHub account or organization name/);
  } finally { await hub.close(); sb.cleanup(); }
});

test('connect --owner: the owner\'s brain is cloned from it; access given as admin, an owner\'s invitation accepted', async () => {
  const sb = sandbox();
  const hub = await fakeGithub(sb, { admin: [`${OTHER}/web`] });
  try {
    sb.seed(OTHER, 'web', { 'index.js': '1\n' });
    sb.seedBrain(OTHER, 'web-brain');
    hub.invite(OTHER, 'web-brain', 'agent1');
    const r = await connect({ project: 'web', owner: OTHER, root: sb.root, apiUrl: hub.apiUrl, tokenFile: sb.tokenFile, agentTokenFile: sb.agentTokenFile, remoteFor: sb.remoteFor });
    const text = r.lines.join('\n');
    assert.match(text, new RegExp(`agent account agent1: push access to ${OTHER}/web$`, 'm'));
    assert.match(text, new RegExp(`brain: from ${OTHER}/web-brain`));
    assert.match(text, new RegExp(`agent account agent1: push access to ${OTHER}/web-brain \\(invitation of the owner accepted\\)`));
    assert.equal(git(r.brainDir, 'remote', 'get-url', 'origin'), sb.remoteFor(OTHER, 'web-brain'));
    assert.ok(!hub.calls.some((c) => c.startsWith('owner1 POST /user/repos')), 'no brain created');
    assert.equal(git(r.brainDir, 'status', '--porcelain'), '');
  } finally { await hub.close(); sb.cleanup(); }
});

// Domain <root>/Shop: code repository shop and brain shop-brain (origin a bare repository) whose hooks git keeps as
// 100644 (made where git records no modes); an earlier attach made them executable, so the clone is dirty. Another
// machine pushed a commit to the brain meanwhile.
function shopDomain(fx) {
  const projects = path.join(fx.root, 'domains');
  const base = path.join(projects, 'Shop');
  const bare = path.join(fx.root, 'shop-brain.git');
  const projectDir = path.join(base, 'shop');
  const brainDir = path.join(base, 'shop-brain');
  git(fx.root, 'init', '-q', '--bare', '-b', 'main', bare);
  initProject(projectDir, { brainRel: '../shop-brain' });
  const seed = path.join(fx.root, 'seed-shop-brain');
  const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), seed, '--remote', bare], { env: fx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  git(seed, 'update-index', '--chmod=-x', ...HOOKS);
  git(seed, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'hooks kept without mode');
  git(seed, 'push', '-q', 'origin', 'main');
  git(fx.root, 'clone', '-q', bare, brainDir);
  for (const h of HOOKS) fs.chmodSync(path.join(brainDir, h), 0o755);
  fs.mkdirSync(path.join(seed, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'memory', 'other-machine.md'), 'x\n');
  git(seed, 'add', '--', 'memory/other-machine.md');
  git(seed, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'other machine');
  git(seed, 'push', '-q', 'origin', 'main');
  // The session's mail config (the brain of the project restore runs from).
  fs.mkdirSync(path.join(fx.brain, 'local'), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, 'local', 'comms.json'), JSON.stringify({ instance: 'test-instance', key: 'k-session', instance_id: 'stub' }));
  // The installed mail client: the stub.
  const services = path.join(fx.root, 'services');
  fs.mkdirSync(path.join(services, 'agentic-comms', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(services, 'agentic-comms', 'bin', 'comms.mjs'), `import ${JSON.stringify(pathToFileURL(STUB).href)};\n`);
  const home = path.join(fx.root, 'home');
  fs.mkdirSync(home);
  const state = path.join(fx.root, 'comms-state.json');
  const log = path.join(fx.root, 'comms-log.jsonl');
  const env = { HOME: home, WORKFLOW_PROJECTS_ROOT: projects, WORKFLOW_SERVICES_DIR: services, STUB_COMMS_STATE: state, STUB_COMMS_LOG: log };
  return { base, bare, projectDir, brainDir, state, log, env };
}

test('restore attaches the brain (hooks committed as 100755, synced with origin) and issues the mail key', () => {
  const fx = setup();
  try {
    const d = shopDomain(fx);
    fs.writeFileSync(d.state, JSON.stringify({ key: 'k-shop' }));
    assert.notEqual(git(d.brainDir, 'status', '--porcelain'), '', 'precondition: the hook modes make the brain dirty');
    const r = fx.run('project.mjs', ['restore', 'shop', '--no-t3'], { env: d.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /shop-brain: brain attached \(core\.hooksPath \.githooks; .*committed git hooks as executable \(100755\): pre-commit, commit-msg/);
    assert.match(r.out, /shop-brain: attach commit pushed \(brain synced with origin\)/);
    assert.match(r.out, /shop-brain: mail: key issued for sender shop \(<brain>\/local\/comms\.json\), service answers/);
    assert.doesNotMatch(r.out, /k-shop/, 'the key is never printed');
    assert.equal(git(d.brainDir, 'status', '--porcelain'), '');
    for (const h of HOOKS) assert.equal(modeOf(d.brainDir, h), '100755', h);
    assert.equal(git(d.brainDir, 'config', 'core.hooksPath'), '.githooks');
    assert.match(git(d.brainDir, 'log', '-1', '--format=%s'), /^\[brain-script\] brain template: git hooks executable \(100755\)$/);
    assert.ok(fs.existsSync(path.join(d.brainDir, 'memory', 'other-machine.md')), 'the other machine\'s commit is in');
    assert.equal(git(d.bare, 'rev-parse', 'main'), git(d.brainDir, 'rev-parse', 'HEAD'), 'origin has the attach commit');
    const cfg = JSON.parse(fs.readFileSync(path.join(d.brainDir, 'local', 'comms.json'), 'utf8'));
    assert.deepEqual(cfg, { instance: 'test-instance', key: 'k-shop', instance_id: 'stub' });
    const calls = fs.readFileSync(d.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((a) => a.join(' ') === 'key add --instance test-instance --sender shop'), JSON.stringify(calls));

    const again = fx.run('project.mjs', ['restore', 'shop', '--no-t3'], { env: d.env });
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /shop-brain: mail: config exists/);
    assert.doesNotMatch(again.out, /committed git hooks/);
  } finally { fx.cleanup(); }
});

test('restore without mail ends with a line and the command for later, not an error', () => {
  const fx = setup();
  try {
    const d = shopDomain(fx);
    fs.writeFileSync(d.state, JSON.stringify({ down: true }));
    const r = fx.run('project.mjs', ['restore', 'shop', '--no-t3'], { env: d.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /shop-brain: brain attached/);
    const later = `later, when mail runs: node ${path.join(PLUGIN_ROOT, 'bin', 'project.mjs')} mail ${d.projectDir}`;
    assert.match(r.out, /shop-brain: mail: NOT set up \(key add failed: comms unavailable\)/);
    assert.ok(r.out.includes(later), r.out);
    assert.ok(!fs.existsSync(path.join(d.brainDir, 'local', 'comms.json')));

    const none = fx.run('project.mjs', ['restore', 'shop', '--no-t3'], { env: { ...d.env, WORKFLOW_SERVICES_DIR: path.join(fx.root, 'no-services') } });
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /shop-brain: mail: NOT set up \(mail client .* not found\)/);
    assert.ok(none.out.includes(later), none.out);
  } finally { fx.cleanup(); }
});

test('brain-init --attach on a brain with hooks kept as 100644: mode 100755 in git, git status clean; core.fileMode false changes nothing', () => {
  const fx = setup();
  try {
    git(fx.brain, 'update-index', '--chmod=-x', ...HOOKS);
    git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'hooks kept without mode');
    git(fx.brain, 'push', '-q', 'origin', 'main');
    const clone = path.join(fx.root, 'brain-c');
    git(fx.root, 'clone', '-q', fx.origin, clone);
    const r = spawnSync(process.execPath, [BIN('brain-init.mjs'), clone, '--attach'], { env: fx.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /committed git hooks as executable \(100755\): pre-commit, commit-msg/);
    assert.equal(git(clone, 'status', '--porcelain'), '');
    for (const h of HOOKS) assert.equal(modeOf(clone, h), '100755', h);
    assert.match(git(clone, 'log', '-1', '--format=%s'), /^\[brain-script\] /);
    const head = git(clone, 'rev-parse', 'HEAD');
    const twice = spawnSync(process.execPath, [BIN('brain-init.mjs'), clone, '--attach'], { env: fx.env, encoding: 'utf8' });
    assert.equal(twice.status, 0, twice.stderr);
    assert.equal(git(clone, 'rev-parse', 'HEAD'), head, 'a second attach commits nothing');

    // Where git records no modes (Windows, core.fileMode false) the attach commits nothing.
    const win = path.join(fx.root, 'brain-w');
    git(fx.root, 'clone', '-q', fx.origin, win);
    git(win, 'config', 'core.fileMode', 'false');
    const before = git(win, 'rev-parse', 'HEAD');
    const w = spawnSync(process.execPath, [BIN('brain-init.mjs'), win, '--attach'], { env: fx.env, encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(git(win, 'rev-parse', 'HEAD'), before);
    assert.equal(modeOf(win, HOOKS[0]), '100644');
    assert.equal(git(win, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});
