// Persona repo naming is enforced in code: agent-<name>, never a fallback name (operator 2026-11-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';
import { personaRepoName, assertPersonaRemote } from '../scripts/persona-name.mjs';
import { createPersona } from '../scripts/persona-create.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Fake GitHub: `existing` repo names answer 200, everything else 404; POST /user/repos records the name.
async function fakeGithub(existing = []) {
  const created = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/user') return send(200, { login: 'owner1' });
      if (req.method === 'GET' && req.url.startsWith('/repos/owner1/')) {
        return existing.includes(req.url.split('/').pop()) ? send(200, {}) : send(404, {});
      }
      if (req.method === 'POST' && req.url === '/user/repos') {
        const { name } = JSON.parse(body);
        created.push(name);
        return send(201, { name });
      }
      send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { created, apiUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pcreate-'));
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'tkn\n');
  const bare = (repo) => { const d = path.join(root, `${repo}.git`); git(root, 'init', '-q', '--bare', '-b', 'main', d); return d; };
  return { root, tokenFile, bare, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('personaRepoName: always agent-<name>; invalid or pre-prefixed names are rejected', () => {
  assert.equal(personaRepoName('bob'), 'agent-bob');
  for (const bad of ['agent-bob', 'Bob', 'r', '', 'bob brain', '../x', 'zed_x', undefined]) {
    assert.throws(() => personaRepoName(bad), undefined, String(bad));
  }
});

test('assertPersonaRemote: only agent-* repositories (ssh url or path)', () => {
  assert.equal(assertPersonaRemote('git@example.com:o/agent-bob.git'), 'agent-bob');
  assert.equal(assertPersonaRemote('/tmp/x/agent-bob.git'), 'agent-bob');
  assert.throws(() => assertPersonaRemote('git@example.com:o/bob.git'), /agent-<name>/);
  assert.throws(() => assertPersonaRemote('git@example.com:o/bob-brain.git'), /agent-<name>/);
});

test('createPersona: creates agent-<name> in domain <Name>/ with the domain marker, pushed to origin (v3)', async () => {
  const gh = await fakeGithub();
  const sb = sandbox();
  try {
    const origin = sb.bare('agent-bob');
    const res = await createPersona('bob', { root: sb.root, tokenFile: sb.tokenFile, apiUrl: gh.apiUrl, remoteFor: () => origin });
    assert.deepEqual(gh.created, ['agent-bob']);
    assert.equal(res.repo, 'agent-bob');
    assert.equal(res.dir, path.join(sb.root, 'Bob', 'agent-bob'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.root, 'Bob', '.agentic-domain'), 'utf8')), { brain: 'agent-bob' });
    assert.ok(fs.existsSync(path.join(res.dir, '.git')));
    assert.match(git(origin, 'log', '--oneline', 'main'), /init brain/);
  } finally { await gh.close(); sb.cleanup(); }
});

test('createPersona: existing agent-<name> fails, no repo is created, no fallback name, no directory', async () => {
  const gh = await fakeGithub(['agent-bob']);
  const sb = sandbox();
  try {
    await assert.rejects(
      createPersona('bob', { root: sb.root, tokenFile: sb.tokenFile, apiUrl: gh.apiUrl, remoteFor: () => sb.bare('x') }),
      /already exists/,
    );
    assert.deepEqual(gh.created, []);
    assert.equal(fs.existsSync(path.join(sb.root, 'agent-bob')), false);
    assert.equal(fs.existsSync(path.join(sb.root, 'bob')), false);
    assert.equal(fs.existsSync(path.join(sb.root, 'Bob')), false);
  } finally { await gh.close(); sb.cleanup(); }
});

test('createPersona: unverifiable existence (HTTP 500) fails before creating anything', async () => {
  const gh = await fakeGithub();
  const sb = sandbox();
  try {
    await assert.rejects(createPersona('bob', { root: sb.root, tokenFile: sb.tokenFile, apiUrl: gh.apiUrl + '/nope' }), /HTTP/);
    assert.deepEqual(gh.created, []);
  } finally { await gh.close(); sb.cleanup(); }
});

test('brain-init --persona: rejects a directory or remote without the agent- prefix', () => {
  const sb = sandbox();
  try {
    const env = cleanEnv({});
    const run = (...a) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), ...a], { cwd: sb.root, env, encoding: 'utf8' });
    let r = run(path.join(sb.root, 'bob'), '--persona');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /agent-<name>/);
    r = run(path.join(sb.root, 'agent-bob'), '--persona', '--remote', sb.bare('bob'));
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(path.join(sb.root, 'agent-bob')), false);
    r = run(path.join(sb.root, 'agent-bob'), '--persona', '--remote', sb.bare('agent-bob'));
    assert.equal(r.status, 0, r.stderr);
  } finally { sb.cleanup(); }
});
