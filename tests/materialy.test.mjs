// materialy/<téma>/ (P-062): the 50 MB limit (Write deny, record, check) and the catalog taking materialy/ as a source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { catalogConfig } from '../scripts/catalog/config.mjs';
import { maxBytes, bigWriteDeny, recordBigFile, oversized, validTopic } from '../scripts/materialy.mjs';

const MB = 1024 * 1024;
const pre = (fx, tool_input) => fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input });
const decision = (r) => r.json.hookSpecificOutput?.permissionDecision;
const big = (fx, rel, mb) => { const f = path.join(fx.project, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(mb * MB, 1)); return f; };

test('limit: 50 MB by default, policy materialy_max_mb changes it, a nonsense value falls back', () => {
  assert.equal(maxBytes({}), 50 * MB);
  assert.equal(maxBytes({ limits: { materialy_max_mb: 10 } }), 10 * MB);
  assert.equal(maxBytes({ limits: { materialy_max_mb: 'x' } }), 50 * MB);
  assert.equal(maxBytes({ limits: { materialy_max_mb: 0 } }), 50 * MB);
  assert.ok(validTopic('ux-audit') && !validTopic('../x') && !validTopic('a/b') && !validTopic(''));
});

test('bigWriteDeny: only inside materialy/ of the project and only over the limit', () => {
  const p = '/proj';
  assert.equal(bigWriteDeny(p, {}, '/proj/materialy/t/a.bin', 50 * MB), null, 'exactly the limit passes');
  assert.match(bigWriteDeny(p, {}, '/proj/materialy/t/a.bin', 50 * MB + 1), /nad limitom 50 MB.*materialy\.mjs record/);
  assert.equal(bigWriteDeny(p, {}, '/proj/scratch/a.bin', 80 * MB), null, 'scratch is not limited');
  assert.equal(bigWriteDeny(p, {}, '/proj/materialyx/a.bin', 80 * MB), null, 'a sibling folder is not materialy/');
});

test('PreToolUse: Write of a big content into materialy/ is denied, a small one and scratch pass', () => {
  const fx = setup({ remote: false });
  try {
    const content = 'x'.repeat(51 * MB);
    const r = pre(fx, { file_path: path.join(fx.project, 'materialy', 'tema', 'velky.txt'), content });
    assert.equal(decision(r), 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /nad limitom 50 MB/);
    const ok = setup({ remote: false });
    try {
      assert.notEqual(decision(pre(ok, { file_path: path.join(ok.project, 'materialy', 'tema', 'maly.txt'), content: 'ahoj' })), 'deny');
      assert.notEqual(decision(pre(ok, { file_path: path.join(ok.project, 'scratch', 'velky.txt'), content })), 'deny');
    } finally { ok.cleanup(); }
  } finally { fx.cleanup(); }
});

test('record: writes materialy/<téma>/<name>.zaznam.json with from, date, size, sha256 and does not touch the file', () => {
  const fx = setup({ remote: false });
  try {
    const file = big(fx, 'scratch/export.bin', 1);
    const before = fs.readFileSync(file);
    const r = fx.run('materialy.mjs', ['record', file, '--from', 'https://example.test/export.bin', '--topic', 'tema']);
    assert.equal(r.status, 0, r.out);
    const rec = JSON.parse(fs.readFileSync(path.join(fx.project, 'materialy', 'tema', 'export.bin.zaznam.json'), 'utf8'));
    assert.equal(rec.name, 'export.bin');
    assert.equal(rec.from, 'https://example.test/export.bin');
    assert.match(rec.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rec.size, MB);
    assert.equal(rec.sha256.length, 64);
    assert.equal(rec.stored_at, 'scratch/export.bin');
    assert.deepEqual(fs.readFileSync(file), before);
    // a file already in materialy/ and a bad topic are refused
    assert.throws(() => recordBigFile(fx.project, 'tema', path.join(fx.project, 'materialy', 'tema', 'export.bin.zaznam.json')), /už v materialy/);
    assert.throws(() => recordBigFile(fx.project, '../x', file), /neplatná téma/);
    const bad = fx.run('materialy.mjs', ['record', file]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /chýba téma/);
  } finally { fx.cleanup(); }
});

test('check: lists files in materialy/ over the limit and fails; nothing over the limit is ok', () => {
  const fx = setup({ remote: false });
  try {
    big(fx, 'materialy/tema/maly.bin', 1);
    const policy = { limits: { materialy_max_mb: 2 } };
    assert.deepEqual(oversized(fx.project, policy), []);
    big(fx, 'materialy/tema/sub/velky.bin', 3);
    assert.deepEqual(oversized(fx.project, policy).map((b) => b.path), ['materialy/tema/sub/velky.bin']);
    assert.equal(oversized(path.join(fx.root, 'nikde'), policy).length, 0, 'no materialy/ is fine');
    const ok = fx.run('materialy.mjs', ['check']);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /nič nad 50 MB/);
    big(fx, 'materialy/tema/obrovsky.bin', 51);
    const r = fx.run('materialy.mjs', ['check']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nad limitom: materialy\/tema\/obrovsky\.bin \(51 MB\)/);
  } finally { fx.cleanup(); }
});

test('catalog: materialy/ is a source of its own (rw) without catalog.sources; opt-out and a repo without it stay off', () => {
  const fx = setup({ remote: false });
  try {
    assert.equal(catalogConfig(fx.project).enabled, false, 'no materialy/, no source: off');
    fs.mkdirSync(path.join(fx.project, 'materialy', 'tema'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'materialy', 'tema', 'zadanie.md'), 'zadanie\n');
    const cfg = catalogConfig(fx.project);
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.sources.map((s) => [s.name, s.mode, s.path]), [['materialy', 'rw', path.join(fx.project, 'materialy')]]);
    // the scan indexes it
    const scan = fx.run('catalog.mjs', ['scan']);
    assert.equal(scan.status, 0, scan.out);
    const idx = fs.readFileSync(path.join(fx.project, 'local', 'catalog', 'index', 'materialy.jsonl'), 'utf8');
    assert.match(idx, /tema\/zadanie\.md/);
    // writing into it is not a catalog refusal
    const w = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'materialy', 'tema', 'novy.md'), content: 'x' } });
    assert.notEqual(decision(w), 'deny');
    // opt-out
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), JSON.stringify({ catalog: { materialy: false } }));
    assert.equal(catalogConfig(fx.project).enabled, false);
    // an explicit source of the same name wins, other sources are kept next to it
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), JSON.stringify({ catalog: { sources: { data: { path: path.join(fx.root, 'data') }, materialy: { path: path.join(fx.root, 'inde'), mode: 'ro' } } } }));
    const both = catalogConfig(fx.project);
    assert.deepEqual(both.sources.map((s) => s.name).sort(), ['data', 'materialy']);
    assert.equal(both.sources.find((s) => s.name === 'materialy').mode, 'ro');
  } finally { fx.cleanup(); }
});
