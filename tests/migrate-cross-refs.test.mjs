// ttl: 2026-12-14
// The move of a project repo left references to its old paths in the domain brain (relates_to, a skill text) and in the
// other repos of the domain, and --check said ok. --check (and the apply) reports each one (repo/file:line) as a problem;
// a bare path the referring repo has itself is its own file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

function commitFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '--no-verify', '-m', `${BRAIN_COMMIT_TAG} fixture`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

test('--check reports references of the domain brain and the other repos to moved paths of a project repo', () => {
  const fx = setup2({ thread: 'cr1' });
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), JSON.stringify({ brain: 'brain' }) + '\n');
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, {
      'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n',
      'docs/plan.md': '# Plan\n',
      'docs/hosting.md': '# Hosting\n',
    });
    commitFiles(fx.brain, {
      'vystupy/dokumenty/notes.md': '---\nrelates_to: [docs/plan.md]\n---\nHosting: docs/hosting.md.\n',
    });
    const blog = path.join(fx.root, 'blog');
    initProject(blog);
    commitFiles(blog, { 'docs/plan.md': '# Own plan\n', 'readme.md': 'Own: docs/plan.md; web: web/docs/plan.md.\n' });
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/plan.md\tdokument\t\t\ndocs/hosting.md\tpomocne\t\t\n');
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.ok(fs.existsSync(path.join(web, 'vystupy', 'dokumenty', 'plan.md')), a.out);
    const c = fx.run('migrate.mjs', [web, '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /brain\/vystupy\/dokumenty\/notes\.md:2: reference to web docs\/plan\.md, which the move changed \(now vystupy\/dokumenty\/plan\.md\)/);
    assert.match(c.stdout, /brain\/vystupy\/dokumenty\/notes\.md:4: reference to web docs\/hosting\.md, which the move changed \(now removed\)/);
    assert.match(c.stdout, /blog\/readme\.md:1: reference to web docs\/plan\.md/);
    assert.equal((c.stdout.match(/blog\/readme\.md:1:/g) || []).length, 1, 'the own docs/plan.md of blog is not a reference');
  } finally { fx.cleanup(); }
});
