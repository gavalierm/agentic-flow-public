// ttl: 2026-12-14
// Gaps of migrate.mjs --check found after a domain brain archived its closed topics (2026-11-14): a repo moved before
// the deploy ignores existed kept an ignore file without the internal folders and --check said ok; the hidden topic
// archive (.brain/archive/topics/<id>/) counted as missing files of the move; historic handovers in the archive counted
// as references to changed paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

const HANDOVER = (task) => `## Zadanie\n${task}\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n`;

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

test('--check reports a deploy ignore file of a moved repo without the internal folders; --check --fix fills it', () => {
  const fx = setup2({ thread: 'cg1' });
  try {
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, {
      '.assetsignore': 'node_modules\n',
      'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n',
      'docs/audit.md': '# Audit\n',
      'index.html': '<p>x</p>\n',
    });
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/audit.md\tdokument\t\taudit\n');
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.equal(a.status, 0, a.out);
    // A repo moved before the move filled deploy ignores: the file has only its own entry.
    commitFiles(web, { '.assetsignore': 'node_modules\n' });
    const c = fx.run('migrate.mjs', [web, '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /\.assetsignore: misses .*vystupy.*\.brain.*INDEX\.md.*--check --fix/);
    const f = fx.run('migrate.mjs', [web, '--check', '--fix']);
    assert.equal(f.status, 0, f.out);
    assert.match(f.stdout, /deploy ignore: \.assetsignore \+= /);
    const lines = gitq(web, 'show', 'HEAD:.assetsignore').split('\n');
    for (const e of ['node_modules', 'vystupy', '.brain', 'INDEX.md']) assert.ok(lines.includes(e), `${e} committed:\n${lines.join('\n')}`);
    assert.equal(gitq(web, 'status', '--porcelain'), '');
    assert.match(fx.run('migrate.mjs', [web, '--check']).stdout, /check: ok/);
  } finally { fx.cleanup(); }
});

test('--check of a brain takes the hidden topic archive as the place of an archived topic', () => {
  const fx = setup2({ brainLayout: 1, thread: 'cg2' });
  try {
    commitFiles(fx.brain, {
      'topics/archive/beta/topic.json': JSON.stringify({ id: 'beta', subject: 'Beta', state: 'closed', closed: '2026-11-01T00:00:00Z' }, null, 2) + '\n',
      'topics/archive/beta/handover.md': HANDOVER('Beta'),
      'topics/gamma/topic.json': JSON.stringify({ id: 'gamma', subject: 'Gamma', state: 'closed', closed: '2026-11-02T00:00:00Z' }, null, 2) + '\n',
      'topics/gamma/handover.md': HANDOVER('Gamma'),
    });
    gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
    const a = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.equal(a.status, 0, a.out);
    const z = fx.run('done.mjs', ['--archive-closed', '--project', fx.brain]);
    assert.equal(z.status, 0, z.out);
    assert.ok(fx.exists('.brain/archive/topics/beta/handover.md') && fx.exists('.brain/archive/topics/gamma/handover.md'), z.out);
    const c = fx.run('migrate.mjs', [fx.brain, '--check']);
    assert.doesNotMatch(c.stdout, /beta|gamma/, c.out);
    assert.equal(c.status, 0, c.out);
  } finally { fx.cleanup(); }
});

test('--check of a project repo skips the topic archive of the domain brain in the references scan', () => {
  const fx = setup2({ thread: 'cg3' });
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), JSON.stringify({ brain: 'brain' }) + '\n');
    const web = path.join(fx.root, 'web');
    initProject(web);
    commitFiles(web, {
      'agentic/memory/site.md': '---\nkey: site\norigin: operator\n---\nWeb.\n',
      'docs/plan.md': '# Plan\n',
    });
    commitFiles(fx.brain, {
      '.brain/archive/topics/old/handover.md': HANDOVER('Plan v docs/plan.md'),
      '.brain/archive/topics/old/.tema.json': JSON.stringify({ id: 'old', state: 'closed', files: ['docs/plan.md'] }) + '\n',
      'vystupy/dokumenty/notes.md': 'Plan: docs/plan.md.\n',
    });
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\ndocs/plan.md\tdokument\t\t\n');
    const a = fx.run('migrate.mjs', [web, '--apply', '--confirmed', tsv]);
    assert.ok(fs.existsSync(path.join(web, 'vystupy', 'dokumenty', 'plan.md')), a.out);
    const c = fx.run('migrate.mjs', [web, '--check']);
    assert.match(c.stdout, /brain\/vystupy\/dokumenty\/notes\.md:1: reference to web docs\/plan\.md/, 'a live reference is still reported');
    assert.doesNotMatch(c.stdout, /archive/, c.out);
  } finally { fx.cleanup(); }
});
