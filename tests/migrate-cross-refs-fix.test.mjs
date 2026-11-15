// ttl: 2026-12-15
// After the move of a project repo --check listed references of the domain brain and the other repos to its moved paths,
// but no command of the workflow could rewrite them (a decision is only replaced, a handover only by its holder;
// report-ed8bbae2). --check --fix rewrites them in each repository with one commit, keeps the prefixed form, leaves a
// path the referring repo has itself and a removed file, and skips a file with uncommitted changes.
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

test('--check --fix rewrites references of the domain brain and the other repos to moved paths of a project repo', () => {
  const fx = setup2({ thread: 'crf1' });
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
    commitFiles(blog, {
      'docs/plan.md': '# Own plan\n',
      'readme.md': 'Own: docs/plan.md; web: web/docs/plan.md and ../web/docs/plan.md.\n',
      'later.md': 'See web/docs/plan.md.\n',
    });
    fs.appendFileSync(path.join(blog, 'later.md'), 'draft\n');
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/plan.md\tdokument\t\t\ndocs/hosting.md\tpomocne\t\t\n');
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.ok(fs.existsSync(path.join(web, 'vystupy', 'dokumenty', 'plan.md')), a.out);
    const c = fx.run('migrate.mjs', [web, '--check']);
    assert.match(c.stdout, /notes\.md:2: reference to web docs\/plan\.md, .*rewrite it: migrate\.mjs .* --check --fix/);
    const f = fx.run('migrate.mjs', [web, '--check', '--fix']);
    assert.match(f.stdout, /brain: references rewritten in vystupy\/dokumenty\/notes\.md \(1\), committed /, f.out);
    assert.match(f.stdout, /blog: references rewritten in readme\.md \(2\), committed /, f.out);
    assert.match(f.stdout, /blog: skipped \(uncommitted changes\): later\.md/, f.out);
    assert.equal(gitq(fx.brain, 'show', 'HEAD:vystupy/dokumenty/notes.md'), '---\nrelates_to: [vystupy/dokumenty/plan.md]\n---\nHosting: docs/hosting.md.');
    assert.equal(gitq(blog, 'show', 'HEAD:readme.md'), 'Own: docs/plan.md; web: web/vystupy/dokumenty/plan.md and ../web/vystupy/dokumenty/plan.md.');
    assert.equal(gitq(blog, 'status', '--porcelain'), 'M later.md');
    // Left reported: the removed file and the skipped one.
    assert.match(f.stdout, /notes\.md:4: reference to web docs\/hosting\.md, .*now removed\); remove or replace it in brain/);
    assert.match(f.stdout, /blog\/later\.md:1: reference to web docs\/plan\.md/);
    assert.doesNotMatch(f.stdout, /notes\.md:2: reference|blog\/readme\.md:1: reference/);
  } finally { fx.cleanup(); }
});
