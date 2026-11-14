// Sources (D-0036): a source must outlive the work files. save took any --sources (the one derived record of the machine
// pointed into gitignored scratch/), dropped --sources of an observed record silently, and a decision had no origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, memoryRecord } from './helpers.mjs';

function plant(fx, rel, text) {
  fs.mkdirSync(path.dirname(path.join(fx.brain, rel)), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, rel), text);
  fx.git(fx.brain, 'add', '-A');
  fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'fixture');
}

test('save memory: a source in scratch/ or a missing one is refused; git file, URL, P-NNN pass; observed keeps sources', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'scratch', 'notes.md'), 'work file\n');
    let r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'x', '--origin', 'derived', '--sources', 'scratch/notes.md']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /sources: scratch\/notes\.md: git does not track it/);
    assert.match(r.stderr, /materialy\/<topic>\/ first/);
    assert.equal(fx.exists('memory/tool-probe.md'), false, 'nothing saved');
    r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'x', '--origin', 'derived', '--sources', 'gone.md']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /gone\.md: no such file/);
    r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'x', '--origin', 'derived', '--sources', 'src/app.js,https://example.org/doc,P-008']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('memory/tool-probe.md'), /^sources: \[src\/app\.js, "?https:\/\/example\.org\/doc"?, P-008\]$/m);
    r = fx.run('save.mjs', ['memory', 'tool', 'port', '--content', 'Port 80 open.', '--origin', 'observed', '--sources', 'https://example.org/status']);
    assert.equal(r.status, 0, r.out);
    const obs = fx.read('memory/tool-port.md');
    assert.match(obs, /^sources: \["?https:\/\/example\.org\/status"?\]$/m, 'observed keeps its sources');
    assert.doesNotMatch(obs, /^fingerprint:/m, 'no fingerprint for observed');
    r = fx.run('save.mjs', ['memory', 'tool', 'said', '--content', 'x', '--sources', 'src/app.js']);
    assert.equal(r.status, 1, 'an operator record has no sources');
    assert.match(r.stderr, /--sources belong to a derived or observed record/);
  } finally { fx.cleanup(); }
});

test('save memory: an old source that does not last is named, not refused', () => {
  const fx = setup();
  try {
    plant(fx, 'memory/tool-old.md', memoryRecord('tool-old', 'Old.', 'sources: [scratch/zip/a.swift]\nfingerprint: abc123\n').replace('origin: operator', 'origin: derived'));
    const r = fx.run('save.mjs', ['memory', 'tool', 'old', '--content', 'Old, rewritten.', '--origin', 'derived', '--sources', 'scratch/zip/a.swift']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /sources of tool-old that do not last .*scratch\/zip\/a\.swift: no such file/);
  } finally { fx.cleanup(); }
});

test('save decision: origin operator by default, agent on request, sources checked', () => {
  const fx = setup();
  try {
    let r = fx.run('save.mjs', ['decision', 'Pick one', '--what', 'a', '--reason', 'b', '--relates-to', 'P-008', '--sources', 'scratch/plan.md']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /sources: scratch\/plan\.md: no such file/);
    r = fx.run('save.mjs', ['decision', 'Pick one', '--what', 'a', '--reason', 'b', '--relates-to', 'P-008', '--origin', 'boss']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /decision origin must be operator \| agent/);
    r = fx.run('save.mjs', ['decision', 'Pick one', '--what', 'a', '--reason', 'b', '--relates-to', 'P-008', '--sources', 'src/app.js']);
    assert.equal(r.status, 0, r.out);
    const file = fs.readdirSync(path.join(fx.brain, 'decisions')).find((f) => f.includes('pick-one'));
    const text = fx.read(`decisions/${file}`);
    assert.match(text, /^origin: operator$/m);
    assert.match(text, /^sources: \[src\/app\.js\]$/m);
    r = fx.run('save.mjs', ['decision', 'Pick two', '--what', 'a', '--reason', 'b', '--relates-to', 'P-008', '--origin', 'agent']);
    assert.equal(r.status, 0, r.out);
    const two = fs.readdirSync(path.join(fx.brain, 'decisions')).find((f) => f.includes('pick-two'));
    assert.match(fx.read(`decisions/${two}`), /^origin: agent$/m);
    assert.doesNotMatch(fx.read(`decisions/${two}`), /^sources:/m);
  } finally { fx.cleanup(); }
});

test('consolidate lists sources that do not last and scratch/ paths in bodies', () => {
  const fx = setup();
  try {
    plant(fx, 'memory/tool-old.md', memoryRecord('tool-old', 'Read scratch/zip/notes.md for the rest.', 'sources: [scratch/zip/a.swift]\nfingerprint: abc123\n').replace('origin: operator', 'origin: derived'));
    plant(fx, 'memory/tool-ok.md', memoryRecord('tool-ok', 'Fine.', 'sources: [src/app.js]\n').replace('origin: operator', 'origin: derived'));
    const r = fx.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^sources that do not last .*tool-old\.md: scratch\/zip\/a\.swift: no such file/m);
    assert.match(r.stdout, /^work files named in a body .*tool-old\.md: scratch\/zip\/notes\.md/m);
    assert.doesNotMatch(r.stdout, /tool-ok\.md: src\/app\.js/, 'a lasting source is not listed');
  } finally { fx.cleanup(); }
});
