// ttl: 2026-12-16
// project.mjs connect into a domain that exists (doma-pc 2026-11-16: the marketing repo of Shop joins the domain
// Shop): the repo is cloned beside the domain's brain and points at it; no <name>-brain is cloned or created, the
// older folder of the setup is set aside; a --brain other than the domain's is refused before anything changes. The repo
// gets the data version of the brain (a repo without one reads as data 1 and the session start refused it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect } from '../scripts/project.mjs';
import { layoutRefusal } from '../scripts/layout.mjs';
import { checkRepo } from '../scripts/migrate-3.mjs';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

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
    fs.mkdirSync(dom, { recursive: true });
    const init = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), path.join(dom, 'shop-brain')], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(init.status, 0, init.stdout + init.stderr);
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
    // The repo carries the data of the brain (2.1): the session start does not refuse it as a clone not pulled.
    const fb = path.join(dom, 'facebook');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fb, '.brain', 'policy.json'), 'utf8')).data_layout, '2.1');
    assert.equal(layoutRefusal(path.join(dom, 'shop-brain'), fb), null);
    assert.ok(res.lines.some((l) => /^data: \.brain\/policy\.json with data 2\.1 of the brain, committed and pushed$/.test(l)), res.lines.join('\n'));
    assert.ok(git(origin, 'log', '-1', '--format=%s', 'main').includes('data 2.1'));
    // The check of data 2.1 takes a repo born in 2.1 as it is: no move to record.
    const check = checkRepo(fb, { brainDir: path.join(dom, 'shop-brain') });
    assert.deepEqual(check.problems, []);
    assert.ok(check.notes.some((n) => /born in data 2\.1/.test(n)));
  } finally { srv.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('inventory: a tracked name with diacritics and spaces is read as it is (doma-pc 2026-11-16: ENOENT on a quoted path)', async () => {
  const { inventory } = await import('../scripts/project.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-inv-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.quotepath', 'true');
    const name = 'Carousel/Detské oblečenie – carousel 1 svetlý.png';
    fs.mkdirSync(path.join(dir, 'Carousel'));
    fs.writeFileSync(path.join(dir, name), 'png');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'f');
    const inv = inventory(dir);
    assert.ok(JSON.stringify(inv).includes('svetlý.png'), JSON.stringify(inv));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
