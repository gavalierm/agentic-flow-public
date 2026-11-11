// A code repo that is public on GitHub keeps no workflow knowledge: save --repo would push project records, decisions
// and runbooks publicly, and project-<repo> belongs in the private brain without --brain (alice 2026-11-11, adoption
// of a public static web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject } from './helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

test('public repo: save --repo is refused toward brain, project-<repo> is kept in brain without --brain', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    const srv = path.join(fx.root, 'srv');
    initProject(srv);
    fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'main', visibility: 'public' }) + '\n');
    git(srv, 'commit', '-qam', 'public');
    const head = git(srv, 'rev-parse', 'HEAD');
    let r = fx.run('save.mjs', ['memory', 'service', 'ftp', '--content', 'FTP deploy.', '--repo', 'srv']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /srv is public on GitHub[\s\S]*brain/);
    assert.equal(git(srv, 'rev-parse', 'HEAD'), head, 'nothing committed into the public repo');
    r = fx.run('save.mjs', ['memory', 'project', 'srv', '--content', 'Opis srv.']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(fx.brain, 'memory', 'project-srv.md')));
  } finally { fx.cleanup(); }
});
