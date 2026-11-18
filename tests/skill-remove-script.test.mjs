// ttl: 2027-05-18
// save.mjs skill --remove-script drops a script of an existing skill in the brain and the deployed copy (a project
// 2026-11-18: scripts moved to another skill stayed in the old one; only --remove of the whole skill existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('skill --remove-script removes the file; a script still named in the body or a missing file is refused', () => {
  const fx = setup({ thread: 'rs1', remote: false });
  try {
    for (const f of ['keep.sh', 'gone.sh']) fs.writeFileSync(path.join(fx.root, f), `#!/bin/sh\necho ${f}\n`);
    const body = 'Spusti `sh keep.sh` a potom `sh gone.sh`.\n\nnie ručne, lebo sa zabudne krok';
    let r = fx.run('save.mjs', ['skill', 'rs-demo', '--description', 'Použi, keď skúšaš odstránenie skriptu.', '--origin', 'routine', '--content', body, '--script', `${path.join(fx.root, 'keep.sh')},${path.join(fx.root, 'gone.sh')}`]);
    assert.equal(r.status, 0, r.out);
    const dir = path.dirname(path.join(fx.brain, fs.readdirSync(fx.brain, { recursive: true }).map(String).find((f) => f.endsWith(path.join('rs-demo', 'SKILL.md')))));
    r = fx.run('save.mjs', ['skill', 'rs-demo', '--origin', 'routine', '--remove-script', 'gone.sh']);
    assert.notEqual(r.status, 0, 'body still names gone.sh');
    assert.ok(fs.existsSync(path.join(dir, 'gone.sh')));
    r = fx.run('save.mjs', ['skill', 'rs-demo', '--origin', 'routine', '--remove-script', 'nope.sh']);
    assert.notEqual(r.status, 0, 'no such file');
    r = fx.run('save.mjs', ['skill', 'rs-demo', '--origin', 'routine', '--sed', 's/ a potom `sh gone.sh`//', '--remove-script', 'gone.sh']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(dir, 'gone.sh')));
    assert.ok(fs.existsSync(path.join(dir, 'keep.sh')));
    assert.match(r.out, /removed from skill rs-demo: gone\.sh/);
    const deployed = fs.readdirSync(fx.project, { recursive: true }).map(String).filter((f) => f.includes('rs-demo'));
    assert.ok(deployed.some((f) => f.endsWith('keep.sh')) && !deployed.some((f) => f.endsWith('gone.sh')), deployed.join(', '));
  } finally { fx.cleanup?.(); }
});
