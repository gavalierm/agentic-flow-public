// A created or connected repository is usable in T3 without manual steps: trust, T3 project, welcome thread "vitaj"
// (Windows 2026-11-08: create and connect left no T3 project and no thread; the agent wrote the trust by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { trustFolder, setupT3, WELCOME_TITLE } from '../scripts/t3-setup.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-t3-'));

test('trustFolder accepts the trust dialog once, keeps the other entries, backs the file up (Windows keys with forward slashes)', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { x: 1 }, projects: { 'D:/Claude projekty/Shop/shop-seo': { lastCost: 2 } } }));
    const r = trustFolder('D:\\Claude projekty\\Shop\\shop-seo', { file, platform: 'win32' });
    assert.match(r.line, /trust: accepted for D:\/Claude projekty\/Shop\/shop-seo/);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(j.projects['D:/Claude projekty/Shop/shop-seo'], { lastCost: 2, hasTrustDialogAccepted: true });
    assert.deepEqual(j.oauthAccount, { x: 1 });
    assert.equal(Object.keys(j.projects).length, 1, 'the existing entry is updated, no second spelling');
    assert.ok(fs.existsSync(`${file}.workflow-bak`));
    assert.equal(trustFolder('d:\\claude projekty\\shop\\shop-seo', { file, platform: 'win32' }).line, 'trust: already accepted');
    trustFolder('D:\\New\\web', { file, platform: 'win32' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects['D:/New/web'].hasTrustDialogAccepted, true);
    assert.match(trustFolder('/x', { file: path.join(dir, 'missing.json') }).line, /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setupT3 adds the T3 project and starts the welcome thread; an existing project gets no second thread; without the CLI the steps are left for the T3 tools', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, '{}');
    const calls = [];
    const fake = (answers) => (bin, args, opts) => { calls.push({ bin, args, input: opts.input }); return answers.shift(); };
    const repo = path.join(dir, 'shop-web');
    let r = setupT3(repo, { name: 'shop', trustFile: file, run: fake([{ status: 0, stdout: 'Added project p1' }, { status: 0, stdout: '{"threadId":"t1"}' }]) });
    assert.deepEqual(r.pending, []);
    assert.ok(r.added);
    assert.match(r.lines.join('\n'), /trust: accepted[\s\S]*t3: project shop-web added[\s\S]*welcome thread "vitaj" started/);
    assert.deepEqual([calls[0].bin, ...calls[0].args], ['t3', 'project', 'add', '--title', 'shop-web', repo]);
    assert.deepEqual([calls[1].bin, ...calls[1].args], ['t3', 'thread', 'start', '--json', '--title', WELCOME_TITLE, repo, '-']);
    assert.match(calls[1].input, /Vitaj v projekte shop \(repo shop-web\)/);

    calls.length = 0;
    r = setupT3(repo, { name: 'shop', trustFile: file, run: fake([{ status: 1, stderr: "ERROR: ProjectAlreadyExistsError: An active project already exists for '/x'." }]) });
    assert.equal(calls.length, 1, 'no welcome thread for a project already in T3');
    assert.match(r.lines.join('\n'), /already in T3/);
    assert.deepEqual(r.pending, []);

    r = setupT3(repo, { name: 'shop', trustFile: file, run: () => ({ error: Object.assign(new Error('spawn t3 ENOENT'), { code: 'ENOENT' }) }) });
    assert.equal(r.pending.length, 2);
    assert.match(r.lines.join('\n'), /project NOT added \(t3 not found on this machine\): create it with the T3 tool t3_project_create \(title shop-web, workspaceRoot /);
    assert.match(r.lines.join('\n'), /welcome thread NOT started[\s\S]*t3_thread_launch[\s\S]*Vitaj v projekte shop/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project.mjs t3: steps left for the T3 tools keep the wizard open and block Stop until --registered', () => {
  const fx = setup();
  try {
    const cfg = path.join(fx.root, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.claude.json'), '{"projects":{}}');
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ project: { t3_project_add_command: path.join(fx.root, 'no-such-t3') } }));
    const env = { env: { CLAUDE_CONFIG_DIR: cfg } };
    assert.equal(fx.run('project.mjs', ['wizard', 'start', 'shop'], env).status, 0);
    const r = fx.run('project.mjs', ['t3', fx.project, '--name', 'shop'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /project: trust: accepted/);
    assert.match(r.out, /t3_project_create \(title project, workspaceRoot /);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8')).projects[fx.project].hasTrustDialogAccepted, true);
    const end = fx.run('project.mjs', ['wizard', 'end'], env);
    assert.notEqual(end.status, 0);
    assert.match(end.out, /wizard not closed: T3 setup not finished/);
    const stop = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' }, env);
    assert.equal(stop.json.decision, 'block');
    assert.match(stop.json.reason, /T3 setup not finished[\s\S]*t3_thread_launch/);
    assert.match(fx.run('project.mjs', ['t3', fx.project, '--registered'], env).out, /recorded as set up in T3/);
    assert.equal(fx.run('project.mjs', ['wizard', 'end'], env).status, 0);
    assert.doesNotMatch(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' }, env).json.reason || '', /T3 setup/);
  } finally { fx.cleanup(); }
});
