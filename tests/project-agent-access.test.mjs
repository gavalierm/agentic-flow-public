// project create: a new repository gets the machine's agent account as a collaborator before the first push.
// The SSH key belongs to the agent account; without it the push says "Repository not found" (Alice 2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './helpers.mjs';
import { create } from '../scripts/project.mjs';

const clean = cleanEnv();
for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k];
Object.assign(process.env, clean);

async function fakeGithub(remotes) {
  const calls = [];
  const invitations = new Map();
  let nextId = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const who = req.headers.authorization === 'Bearer agt' ? 'agent1' : 'owner1';
      calls.push(`${who} ${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/user') return send(200, { login: who });
      if (url.pathname === '/user/repos' && req.method === 'POST') {
        const { name } = JSON.parse(body);
        spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(remotes, `${name}.git`)]);
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
      const repo = url.pathname.match(/^\/repos\/owner1\/([^/]+)$/);
      if (repo) return fs.existsSync(path.join(remotes, `${repo[1]}.git`)) ? send(200, { name: repo[1] }) : send(404, {});
      send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, invitations, apiUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('create: the agent account is invited to both new repositories and accepts; no agent token, no invitation', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-access-'));
  const root = path.join(base, 'agentic');
  const remotes = path.join(base, 'remotes');
  fs.mkdirSync(root); fs.mkdirSync(remotes);
  fs.writeFileSync(path.join(base, 'token'), 'tkn\n');
  fs.writeFileSync(path.join(base, 'agent-token'), 'agt\n');
  const hub = await fakeGithub(remotes);
  const opts = { root, apiUrl: hub.apiUrl, tokenFile: path.join(base, 'token'), remoteFor: (o, r) => path.join(remotes, `${r}.git`) };
  try {
    const r = await create({ name: 'novy', repo: 'novy-web', purpose: 'Web.', agentTokenFile: path.join(base, 'agent-token'), ...opts });
    assert.ok(r.lines.includes('agent account agent1: push access to owner1/novy-web'), r.lines.join('\n'));
    assert.ok(r.lines.includes('agent account agent1: push access to owner1/novy-brain'), r.lines.join('\n'));
    assert.ok(hub.calls.includes('owner1 PUT /repos/owner1/novy-web/collaborators/agent1'), hub.calls.join('\n'));
    assert.equal(hub.invitations.size, 0, 'both invitations accepted');
    assert.ok(r.lines.includes('project: pushed'), r.lines.join('\n'));

    const before = hub.calls.length;
    const r2 = await create({ name: 'druhy', purpose: 'Web.', agentTokenFile: path.join(base, 'missing'), ...opts });
    assert.ok(!r2.lines.some((l) => l.startsWith('agent account')), r2.lines.join('\n'));
    assert.ok(!hub.calls.slice(before).some((c) => c.includes('collaborators')));
  } finally { await hub.close(); fs.rmSync(base, { recursive: true, force: true }); }
});
