// ttl: 2026-12-16
// project.mjs connect into a domain that exists (doma-pc 2026-11-16: the marketing repo of Shop joins the domain
// Shop): the repo is cloned beside the domain's brain and points at it; no <name>-brain is cloned or created, the
// older folder of the setup is set aside; a --brain other than the domain's is refused before anything changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect } from '../scripts/project.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('connect --domain of an existing domain: the repo joins its brain, no brain of its own', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-join-'));
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/user') return res.end(JSON.stringify({ login: 'op' }));
    if (req.url === '/repos/op/facebook') return res.end(JSON.stringify({ name: 'facebook', private: true }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const root = path.join(base, 'root');
    const dom = path.join(root, 'Shop');
    fs.mkdirSync(path.join(dom, 'shop-brain'), { recursive: true });
    git(path.join(dom, 'shop-brain'), 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dom, '.agentic-domain'), JSON.stringify({ brain: 'shop-brain' }));
    const origin = path.join(base, 'facebook.git');
    const work = path.join(base, 'w');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'clone', '-q', origin, work);
    fs.writeFileSync(path.join(work, 'README.md'), '# fb\n');
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'fb'); git(work, 'push', '-q', 'origin', 'main');
    // The older setup in the projects root, set aside (nothing deleted).
    fs.mkdirSync(path.join(root, 'FACEBOOK', 'brain'), { recursive: true });
    const token = path.join(base, 'token');
    fs.writeFileSync(token, 'x\n');
    const opts = { project: 'facebook', domain: 'Shop', root, apiUrl: `http://127.0.0.1:${srv.address().port}`, tokenFile: token, agentTokenFile: path.join(base, 'none'), remoteFor: () => origin };
    await assert.rejects(connect({ ...opts, brain: 'facebook-brain' }), /domain Shop has the brain shop-brain .*--brain facebook-brain does not fit it/);
    assert.ok(fs.existsSync(path.join(root, 'FACEBOOK')), 'nothing changed by the refusal');
    const res = await connect({ ...opts, setAside: 'FACEBOOK' });
    assert.ok(res.joined);
    assert.equal(res.brainDir, path.join(dom, 'shop-brain'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dom, 'facebook', '.workflow.json'), 'utf8')).brain, '../shop-brain');
    assert.ok(!fs.existsSync(path.join(dom, 'facebook-brain')), 'no brain of its own');
    assert.ok(fs.existsSync(path.join(root, 'FACEBOOK.pre-adopt', 'brain')));
    assert.ok(res.lines.some((l) => /set aside: FACEBOOK -> FACEBOOK\.pre-adopt/.test(l)), res.lines.join('\n'));
    assert.ok(res.lines.some((l) => /joins its brain shop-brain/.test(l)));
    assert.ok(!calls.some((c) => /facebook-brain|POST/.test(c)), calls.join('\n'));
  } finally { srv.close(); fs.rmSync(base, { recursive: true, force: true }); }
});
