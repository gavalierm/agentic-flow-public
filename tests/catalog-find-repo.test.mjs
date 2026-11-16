// ttl: 2026-12-16
// One search for an agent (operator 2026-11-16): catalog.mjs find covers the sources of the catalog and the files of the
// repo in INDEX.md (vystupy/ …, source `repo`), also in a repo without a catalog source; show prints the INDEX.md row of
// a file of the repo. A welcome thread found no list of the posts in vystupy/ before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, encoding: 'utf8' });
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const cat = (dir, ...a) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'catalog.mjs'), ...a, '--project', dir], { cwd: dir, encoding: 'utf8', env: cleanEnv() });

test('catalog.mjs find lists files of the repo from INDEX.md beside the sources; show gives the row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-find-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, '.brain/policy.json', JSON.stringify({ data_layout: 2 }));
    write(dir, 'vystupy/grafiky/fb-prispevky/2026-11-14-jesenna-akcia.md', '---\ndescription: FB príspevok jesenná akcia\ndate: 2026-11-14\n---\n# Jesenná akcia\n');
    write(dir, 'vystupy/grafiky/fb-prispevky/2026-11-07-novinky.md', '# Novinky týždňa\n');
    write(dir, 'zdroje/znacka/paleta.md', '# Paleta značky\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'f');
    // zdroje/ is a source of the catalog: its file is not listed twice.
    let r = cat(dir, 'find', 'prispevky');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /katalóg \(materialy, repo \(INDEX\.md\)\): 2 zhôd/);
    assert.match(r.stdout, /repo\/vystupy\/grafiky\/fb-prispevky\/2026-11-14-jesenna-akcia\.md \[súbor repa, git\]: FB príspevok jesenná akcia; 2026-11-14/);
    r = cat(dir, 'find', 'jesenna', '--source', 'repo');
    assert.match(r.stdout, /1 zhôd/);
    r = cat(dir, 'show', 'repo/vystupy/grafiky/fb-prispevky/2026-11-14-jesenna-akcia.md');
    assert.equal(JSON.parse(r.stdout).desc, 'FB príspevok jesenná akcia');
    // Without a catalog source (no zdroje/): find still searches the files of the repo.
    fs.rmSync(path.join(dir, 'zdroje'), { recursive: true });
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'g');
    r = cat(dir, 'find', 'novinky');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /repo\/vystupy\/grafiky\/fb-prispevky\/2026-11-07-novinky\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
