// Catalog (MVP): SessionStart lines and budget, PreToolUse deny for a read-only source and the once-per-session reminder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalogFixture } from './catalog-helpers.mjs';
import { scanAll } from '../scripts/catalog/scan.mjs';

const catalogLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('katalóg'));
const pre = (fx, tool_name, tool_input, opts) => fx.hook('pre-tool-use.mjs', { tool_name, tool_input, ...opts });
const decision = (r) => r.json.hookSpecificOutput?.permissionDecision;

test('boot: one line per source with counts and the find command; scan happens in the hook; at most 2 lines of 220 chars', () => {
  const fx = catalogFixture();
  try {
    const r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    const lines = catalogLines(r.context);
    assert.equal(lines.length, 1, r.context);
    assert.match(lines[0], /^katalóg data: 2 súborov \(csv 1, text 1\)/);
    assert.match(lines[0], /hľadaj: node \S+\/bin\/catalog\.mjs find <slová> \(nikdy ls\/grep po zdroji\)/);
    assert.ok(lines[0].length <= 220);
    assert.ok(r.context.length <= 9500);
    assert.equal(fx.indexRows().length, 2, 'the hook scanned');
    assert.doesNotMatch(lines[0], /objednavky|readme/, 'no file names in the boot text');
    // more sources: still at most two lines
    for (const n of ['b', 'c', 'd']) fs.mkdirSync(path.join(fx.root, `src-${n}`));
    for (const n of ['b', 'c', 'd']) fs.writeFileSync(path.join(fx.root, `src-${n}`, 'f.txt'), n);
    fx.config({ sources: { data: { path: fx.data }, b: { path: path.join(fx.root, 'src-b') }, c: { path: path.join(fx.root, 'src-c') }, d: { path: path.join(fx.root, 'src-d') } } });
    const many = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(catalogLines(many.context).length, 2);
  } finally { fx.cleanup(); }
});

test('boot: changes show up as a count, an unavailable source and a failing scan are lines, never a failed boot', () => {
  const fx = catalogFixture();
  try {
    fx.hook('session-start.mjs', { source: 'startup' });
    fx.write('nove.txt', 'nove\n');
    let r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(catalogLines(r.context)[0], /3 súborov.*1 zmenených/);
    const off = `${fx.data}-off`;
    fs.renameSync(fx.data, off);
    r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0);
    assert.match(catalogLines(r.context)[0], /zdroj nedostupný.*index z \d{4}-\d{2}-\d{2}/);
    fs.renameSync(off, fx.data);
    // a catalog directory that cannot be written (a file in its place) must not break the boot
    fs.rmSync(path.join(fx.project, 'local', 'catalog'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'catalog'), 'not a directory');
    r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.context, /## /, 'the boot text is there');
    assert.match(catalogLines(r.context).join('\n'), /scan zlyhal/);
  } finally { fx.cleanup(); }
});

test('boot: compact does not repeat an unchanged catalog line; a change brings it back', () => {
  const fx = catalogFixture();
  try {
    assert.equal(catalogLines(fx.hook('session-start.mjs', { source: 'startup' }).context).length, 1);
    assert.equal(catalogLines(fx.hook('session-start.mjs', { source: 'compact' }).context).length, 0);
    fx.write('dalsi.txt', 'x\n');
    assert.equal(catalogLines(fx.hook('session-start.mjs', { source: 'compact' }).context).length, 1);
  } finally { fx.cleanup(); }
});

test('boot: a repo without a source gets no catalog line, no directory and no gitignore change', () => {
  const fx = catalogFixture();
  try {
    fs.rmSync(path.join(fx.project, 'local', 'workflow.json'));
    const r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(catalogLines(r.context).length, 0);
    assert.equal(fs.existsSync(path.join(fx.project, 'local', 'catalog')), false);
    const gi = path.join(fx.project, '.gitignore');
    assert.doesNotMatch(fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '', /catalog/);
  } finally { fx.cleanup(); }
});

test('boot: the scan stays within the hook budget on a big source and the next scan continues', () => {
  const fx = catalogFixture({ files: false, extra: { scan: { hook_budget_ms: 1, hash_budget_ms: 1 } } });
  try {
    for (let i = 0; i < 40; i++) fx.write(`d${i % 4}/f${i}.txt`, `obsah ${i}\n`);
    const t0 = Date.now();
    const r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 4000, 'the hook does not wait for the whole source');
    let total = 0;
    for (let i = 0; i < 40 && total < 40; i++) { fx.hook('session-start.mjs', { source: 'startup' }); total = fx.indexRows().length; }
    assert.equal(total, 40, 'repeated starts finish the listing');
  } finally { fx.cleanup(); }
});

test('PreToolUse: writes into a read-only source are denied (Write, Edit, redirect, mv, cp, rm, sed -i); outputs elsewhere and rw sources pass', () => {
  const fx = catalogFixture();
  try {
    const inData = path.join(fx.data, 'export', 'objednavky.csv');
    const out = path.join(fx.project, 'scratch', 'vysledok.csv');
    // a denied command must not name the output: the hook then keeps that target closed for the turn (P-054)
    const other = path.join(fx.project, 'scratch', 'vstup.csv');
    for (const [tool, input] of [
      ['Write', { file_path: path.join(fx.data, 'novy.csv'), content: 'x' }],
      ['Edit', { file_path: inData, old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: inData, edits: [] }],
      ['Bash', { command: `echo x > ${inData}` }],
      ['Bash', { command: `cat ${other} >> ${fx.data}/export/new.csv` }],
      ['Bash', { command: `mv ${inData} ${other}.old` }],
      ['Bash', { command: `cp ${other} ${fx.data}/kopia.csv` }],
      ['Bash', { command: `rm ${inData}` }],
      ['Bash', { command: `sed -i s/a/b/ ${inData}` }],
    ]) {
      const r = pre(fx, tool, input);
      assert.equal(decision(r), 'deny', `${tool} ${JSON.stringify(input).slice(0, 80)}`);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /zápis do zdroja dát data \(iba čítanie\).*scratch/);
      // the first refusal names the file that switched the source on: a parallel thread can add one (Skarper 2026-11-09)
      if (tool === 'Write') assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /catalog\.sources\.data v local\/workflow\.json/);
    }
    // the positive cases run in a fresh fixture: a target a refusal reached stays closed for the turn (P-054)
    const ok = catalogFixture();
    try {
      const okIn = path.join(ok.data, 'export', 'objednavky.csv');
      const okOut = path.join(ok.project, 'scratch', 'vysledok.csv');
      for (const [tool, input] of [
        ['Write', { file_path: okOut, content: 'x' }],
        ['Bash', { command: `cp ${okIn} ${okOut}` }],
        ['Bash', { command: `cat ${okIn} > ${okOut}` }],
        ['Bash', { command: `wc -l ${okIn}` }],
      ]) {
        assert.notEqual(decision(pre(ok, tool, input)), 'deny', `${tool} ${JSON.stringify(input).slice(0, 80)}`);
      }
    } finally { ok.cleanup(); }
    fx.config({ sources: { data: { path: fx.data, mode: 'rw' } } });
    // the catalog allows it; a source outside the project is still subject to the domain rule (domain.allow_outside)
    const rw = pre(fx, 'Write', { file_path: path.join(fx.data, 'novy.csv'), content: 'x' });
    assert.doesNotMatch(rw.json.hookSpecificOutput?.permissionDecisionReason || '', /zdroja dát/, 'a rw source is not a catalog refusal');
  } finally { fx.cleanup(); }
});

test('PreToolUse: no deny and no reminder for a repo without a source', () => {
  const fx = catalogFixture();
  try {
    fs.rmSync(path.join(fx.project, 'local', 'workflow.json'));
    assert.deepEqual(pre(fx, 'Bash', { command: `ls ${fx.data}` }).json, {});
    assert.equal(pre(fx, 'Bash', { command: `ls ${fx.data}` }).context, '');
    // outside the project the domain rule decides (as before the catalog); the catalog adds nothing to it
    const w = pre(fx, 'Write', { file_path: path.join(fx.data, 'x.csv'), content: 'x' });
    assert.doesNotMatch(w.json.hookSpecificOutput?.permissionDecisionReason || '', /zdroja dát|katalóg/);
  } finally { fx.cleanup(); }
});

test('PreToolUse reminder: once per session, only Bash ls/find/grep/rg/cat over the source, not for Read/Glob/Grep or other paths', () => {
  const fx = catalogFixture();
  try {
    scanAll(fx.cfg());
    for (const [tool, input] of [['Read', { file_path: path.join(fx.data, 'export', 'objednavky.csv') }], ['Glob', { pattern: '**/*.csv', path: fx.data }], ['Grep', { pattern: 'x', path: fx.data }]]) {
      assert.equal(pre(fx, tool, input).context, '', `${tool} is not extended`);
    }
    assert.equal(pre(fx, 'Bash', { command: 'ls src' }).context, '');
    assert.equal(pre(fx, 'Bash', { command: `echo ${fx.data}` }).context, '', 'echo is not a reader');
    assert.equal(pre(fx, 'Bash', { command: `node ${path.join(fx.project, 'bin', 'catalog.mjs')} find x ${fx.data}` }).context, '', 'the catalog command itself is fine');
    const first = pre(fx, 'Bash', { command: `ls -R ${fx.data}` });
    assert.match(first.context, /^katalóg: pre dáta v data najprv node \S+\/bin\/catalog\.mjs find <slová> alebo show <cesta>; CSV dotazuj cez catalog\.mjs sql, nečítaj ich \(P-031\)$/);
    assert.equal(first.context.split('\n').length, 1);
    assert.equal(pre(fx, 'Bash', { command: `grep -r Acme ${fx.data}` }).context, '', 'only once per session');
    assert.equal(pre(fx, 'Bash', { command: `cat ${fx.data}/export/objednavky.csv` }, { env: { WORKFLOW_THREAD_ID: 'a1' } }).context, '');
  } finally { fx.cleanup(); }
});

test('PreToolUse reminder: other readers, a new session, switched off by catalog.reminder, and not before the source has an index', () => {
  const fx = catalogFixture();
  try {
    assert.equal(pre(fx, 'Bash', { command: `ls ${fx.data}` }).context, '', 'no index yet: nothing to recommend');
    scanAll(fx.cfg());
    for (const cmd of [`find ${fx.data} -name '*.csv'`, `rg Acme ${fx.data}`, `cat ${fx.data}/notes/readme.txt`]) {
      const t = fx.thread;
      fx.thread = t;
      const fresh = catalogFixture();
      try {
        scanAll(fresh.cfg());
        assert.match(pre(fresh, 'Bash', { command: cmd.replaceAll(fx.data, fresh.data) }).context, /^katalóg: /, cmd);
      } finally { fresh.cleanup(); }
    }
    fx.config({ sources: { data: { path: fx.data } }, reminder: false });
    assert.equal(pre(fx, 'Bash', { command: `ls ${fx.data}` }).context, '');
  } finally { fx.cleanup(); }
});
