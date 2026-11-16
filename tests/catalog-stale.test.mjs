// ttl: 2026-12-16
// The local catalog after a move of the data (doma-pc 2026-11-16): an index of materialy/ stayed while the data moved to
// zdroje/, so catalog.mjs find missed it; the check names it, the rescan puts it on the current path. catalog.mjs run by
// a relative path (on Windows every path) printed nothing: the main-module check compared file://<argv> literally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { catalogConfig } from '../scripts/catalog/config.mjs';
import { scanAll } from '../scripts/catalog/scan.mjs';
import { staleCatalog, rescanStale } from '../scripts/catalog/stale.mjs';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

test('a catalog indexed on the old path of its source is stale until it is scanned again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cat-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'materialy', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'materialy', 'a', 'x.md'), 'x\n');
    scanAll(catalogConfig(dir), { full: true });
    assert.deepEqual(staleCatalog(dir), []);
    // The move to data 2.0: materialy/ -> zdroje/.
    fs.mkdirSync(path.join(dir, '.brain'));
    fs.writeFileSync(path.join(dir, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
    fs.renameSync(path.join(dir, 'materialy'), path.join(dir, 'zdroje'));
    fs.writeFileSync(path.join(dir, 'zdroje', 'a', 'y.md'), 'y\n');
    const stale = staleCatalog(dir);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].name, 'materialy');
    assert.match(stale[0].indexed, /materialy$/);
    assert.match(stale[0].path, /zdroje$/);
    const lines = rescanStale(dir);
    assert.match(lines[0], /catalog materialy scanned again on \S+zdroje \(2 files\)/);
    assert.deepEqual(staleCatalog(dir), []);
    // catalog.mjs by a relative path answers (it ended silently with exit 0 before).
    const r = spawnSync(process.execPath, [path.join('bin', 'catalog.mjs'), 'status', '--project', dir], { cwd: PLUGIN_ROOT, encoding: 'utf8', env: cleanEnv() });
    assert.ok((r.stdout + r.stderr).trim().length > 0, 'catalog.mjs printed nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
