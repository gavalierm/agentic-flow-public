// ttl: 2026-12-14
// Topics closed in temy/ before the hidden archive (D-0060) stayed there: done.mjs --archive-closed moves those with only
// handover.md and .tema.json to .brain/archive/topics/<id>/ in one commit with INDEX.md and lists the closed ones with
// other work; --dry-run moves nothing; --project takes a domain brain without .workflow.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';

const HANDOVER = (task) => `## Zadanie\n${task}\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n`;
const TEMA = (id, state) => JSON.stringify({ id, subject: id, state, holder: {} }, null, 2) + '\n';

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

test('--archive-closed moves closed topics with only the handover, lists the others, --dry-run moves nothing', () => {
  const fx = setup2({ thread: 'ac1' });
  try {
    commitFiles(fx.brain, {
      'temy/old-a/handover.md': HANDOVER('A'), 'temy/old-a/.tema.json': TEMA('old-a', 'closed'),
      'temy/old-b/handover.md': HANDOVER('B'), 'temy/old-b/.tema.json': TEMA('old-b', 'closed'),
      'temy/kept/handover.md': HANDOVER('K'), 'temy/kept/.tema.json': TEMA('kept', 'closed'), 'temy/kept/analyza.md': '# Analýza\n',
      'temy/live/handover.md': HANDOVER('L'), 'temy/live/.tema.json': TEMA('live', 'working'),
    });
    fs.mkdirSync(path.join(fx.brain, 'temy', 'old-b', 'tmp'));
    const head = gitq(fx.brain, 'rev-parse', 'HEAD');
    const dry = fx.run('done.mjs', ['--archive-closed', '--project', fx.brain, '--dry-run']);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.stdout, /would move to \.brain\/archive\/topics\/: old-a, old-b/);
    assert.match(dry.stdout, /kept: 1 file\(s\): analyza\.md/);
    assert.equal(gitq(fx.brain, 'rev-parse', 'HEAD'), head, 'dry run commits nothing');
    const r = fx.run('done.mjs', ['--archive-closed', '--project', fx.brain]);
    assert.equal(r.status, 0, r.out);
    assert.equal(gitq(fx.brain, 'rev-list', '--count', `${head}..HEAD`), '1', 'one commit');
    for (const id of ['old-a', 'old-b']) {
      assert.ok(fx.exists(`.brain/archive/topics/${id}/handover.md`), r.out);
      assert.ok(!fx.exists(`temy/${id}`));
    }
    assert.ok(fx.exists('temy/kept/analyza.md') && fx.exists('temy/live/handover.md'));
    assert.doesNotMatch(fx.read('INDEX.md'), /old-a/);
    assert.match(r.stdout, /moved to \.brain\/archive\/topics\/: old-a, old-b/);
  } finally { fx.cleanup(); }
});
