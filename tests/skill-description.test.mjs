// ttl: 2026-12-14
// save.mjs skill <name> --description alone (with --origin) on an existing skill changes only the description and
// updated:, body and scripts stay, one commit (workflow-dev 2026-11-14: it was refused with "--content required").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';

const BODY = 'Spusti `sh probe.sh` a výsledok over.\n\nnie ručne, lebo sa zabudne krok';
const commits = (dir) => Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim());
const skillFile = (brain) => {
  const hits = fs.readdirSync(brain, { recursive: true }).map(String).filter((f) => f.endsWith(path.join('desc-demo', 'SKILL.md')));
  assert.equal(hits.length, 1, hits.join(', '));
  return path.join(brain, hits[0]);
};

test('skill --description alone edits only the description of an existing skill; a new skill still needs --content', () => {
  const fx = setup({ thread: 'sd1', remote: false });
  try {
    const script = path.join(fx.root, 'probe.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho probe\n');
    let r = fx.run('save.mjs', ['skill', 'desc-demo', '--description', 'Použi, keď skúšaš popis skillu.', '--origin', 'routine', '--content', BODY, '--script', script]);
    assert.equal(r.status, 0, r.out);
    const file = skillFile(fx.brain);
    const before = fs.readFileSync(file, 'utf8');
    const scriptBefore = fs.readFileSync(path.join(path.dirname(file), 'probe.sh'), 'utf8');
    const n = commits(fx.brain);
    r = fx.run('save.mjs', ['skill', 'desc-demo', '--description', 'Použi, keď meníš iba popis skillu.', '--origin', 'routine']);
    assert.equal(r.status, 0, r.out);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /^description: "?Použi, keď meníš iba popis skillu\."?$/m);
    assert.match(after, /^updated: /m);
    assert.equal(after.split(/^---$/m).slice(2).join('---'), before.split(/^---$/m).slice(2).join('---'), 'body unchanged');
    assert.equal(fs.readFileSync(path.join(path.dirname(file), 'probe.sh'), 'utf8'), scriptBefore);
    assert.equal(commits(fx.brain), n + 1);
    assert.match(r.out, /deployed to /);
    // With --sed: description and the edit in one save.
    r = fx.run('save.mjs', ['skill', 'desc-demo', '--description', 'Použi, keď skúšaš popis so sed.', '--origin', 'routine', '--sed', 's/over\\./over znova./']);
    assert.equal(r.status, 0, r.out);
    assert.match(fs.readFileSync(file, 'utf8'), /Použi, keď skúšaš popis so sed\.[\s\S]*over znova\./);
    // A skill that does not exist: --description alone is refused.
    r = fx.run('save.mjs', ['skill', 'desc-none', '--description', 'Použi, keď nič.', '--origin', 'routine']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /desc-none does not exist; a new skill needs --content/);
  } finally { fx.cleanup(); }
});
