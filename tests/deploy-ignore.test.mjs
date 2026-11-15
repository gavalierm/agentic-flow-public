// ttl: 2026-12-14
// A project repo with a static web deployed by an ignore file (.assetsignore): the move into layout 2 created vystupy/,
// .brain/ and INDEX.md and the ignore file did not exclude them, so the next deploy would publish an internal audit.
// The move (and every write of the workflow into such a repo) adds the missing entries in the same commit and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';
import { brainWrite } from '../scripts/brain.mjs';

function commitFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `${BRAIN_COMMIT_TAG} fixture`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

test('migrate --apply adds vystupy, .brain and INDEX.md to .assetsignore in the move commit', () => {
  const fx = setup2({ thread: 'di1' });
  try {
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, {
      '.assetsignore': '# not deployed\n.git\ndocs\n',
      '.dockerignore': 'node_modules\n/vystupy/\n',
      'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n',
      'docs/audit.md': '# Audit\n',
      'index.html': '<p>x</p>\n',
    });
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/audit.md\tdokument\t\taudit\n');
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.equal(a.status, 0, a.out);
    assert.ok(fs.existsSync(path.join(web, 'vystupy', 'dokumenty', 'audit.md')), a.out);
    const lines = (f) => fs.readFileSync(path.join(web, f), 'utf8').split('\n');
    for (const e of ['vystupy', '.brain', 'INDEX.md']) assert.ok(lines('.assetsignore').includes(e), `${e} in .assetsignore:\n${lines('.assetsignore').join('\n')}`);
    assert.ok(!lines('.dockerignore').includes('vystupy'), 'an entry present as /vystupy/ is not added again');
    assert.ok(lines('.dockerignore').includes('INDEX.md'));
    assert.doesNotMatch(gitq(web, 'status', '--porcelain'), /\.(assets|docker)ignore/, 'no ignore file left uncommitted');
    assert.ok(gitq(web, 'show', 'HEAD:.assetsignore').split('\n').includes('vystupy'), 'in the move commit');
    assert.match(a.stdout, /deploy ignore: \.assetsignore \+= .*vystupy.*INDEX\.md/);
  } finally { fx.cleanup(); }
});

test('a workflow write that first creates zdroje/ in a layout 2 repo adds it to the deploy ignore file', () => {
  const fx = setup2({ thread: 'di2', projectLayout: 2 });
  try {
    commitFiles(fx.project, { '.vercelignore': 'node_modules\n' });
    const res = brainWrite({ brainDir: fx.project, thread: 'di2', policy: {} }, { ops: [{ path: 'zdroje/seo/report.txt', content: 'x\n' }], message: 'add source', internal: true });
    assert.ok(res.committed);
    const text = fs.readFileSync(path.join(fx.project, '.vercelignore'), 'utf8').split('\n');
    assert.ok(text.includes('zdroje') && text.includes('INDEX.md'), text.join('\n'));
    assert.equal(gitq(fx.project, 'status', '--porcelain'), '');
    assert.ok(res.warnings.some((w) => /deploy ignore: \.vercelignore \+= /.test(w)), res.warnings.join('\n'));
  } finally { fx.cleanup(); }
});
