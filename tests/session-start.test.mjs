// keep: core
// P-021, P-022, P-024, P-026, P-017: SessionStart hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, initProject, cleanEnv } from './helpers.mjs';
import { BOOT_MARKERS, RULES_PART_CHARS, rulesParts, changedRules, rulesSections, stampBootPull, waitBootPull } from '../scripts/boot.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';

const ITEMS = BOOT_MARKERS.slice(1);
const rulesHook = (fx, source, part = 1) => fx.hook('session-start-rules.mjs', { source }, { args: [String(part)] });

function headings(text) {
  return text.split('\n').filter((l) => l.startsWith('## '));
}

test('startup: items 3-7 in order under 9 500 chars; item 1 from the rules hook in parts under 10 000 chars (P-021)', () => {
  const fx = setup();
  try {
    const r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(headings(r.context), ITEMS);
    assert.ok(r.context.length <= 9500, r.context.length);
    assert.doesNotMatch(r.context, /limit: boot context/);
    assert.match(r.context, /\nthread a1 \| topic - \(none\) \| mail: 0\n/);
    assert.match(r.context, /\nworkflow [0-9a-f]{7,}/);
    assert.doesNotMatch(r.context, /### P-001/, 'the rules come from their own hook');
    const parts = [1, 2].map((p) => rulesHook(fx, 'startup', p)).map((x) => { assert.equal(x.status, 0, x.stderr); return x.context; }).filter(Boolean);
    assert.ok(parts.length >= 1);
    for (const c of parts) {
      assert.ok(c.startsWith(BOOT_MARKERS[0]), c.slice(0, 40));
      assert.ok(c.length <= RULES_PART_CHARS + 100, c.length);
    }
    const all = parts.join('\n');
    assert.match(all, /### P-001/);
    assert.match(all, /Výnimky: žiadne/);
    const st = readThreadState(fx.brain, 'a1');
    assert.ok(st.rules_hash && st.rules_sections && st.rules_hook, 'the main hook records the hash and the sections');
  } finally { fx.cleanup(); }
});

test('resume and clear keep the same thread id; compact adds the handover of the held topic', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'work', '--subject', 'Work', '--class', 'discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'work', '--task', 'Do the thing', '--done', 'step 1', '--next', 'step 2', '--files', 'src/app.js', '--questions', '']).status, 0);
    for (const source of ['resume', 'clear']) {
      const r = fx.hook('session-start.mjs', { source });
      assert.match(r.context, /thread a1 \| topic work \(working, mode operator\) \| mail: 0/, source);
      assert.doesNotMatch(r.context, /Handover \(primárny podklad/);
      assert.doesNotMatch(r.context, /Po kompakcii \(P-019\)/);
    }
    const c = fx.hook('session-start.mjs', { source: 'compact' });
    assert.match(c.context, /Po kompakcii \(P-019\): pravidlá, výnimky a pokyny platia iba z kontextu tohto štartu/, 'the summary is no source of rules (agentic-flow-public#18)');
    assert.match(rulesHook(fx, 'compact').context, /### P-001/, 'the rules come again after a compaction');
    assert.match(c.context, /Handover \(primárny podklad, P-026\):\n### Zadanie\nDo the thing/);
    assert.match(c.context, /open: work \(working, a1, next: step 2\)/);
    assert.deepEqual(headings(c.context), ITEMS);
  } finally { fx.cleanup(); }
});

test('missing brain: one notice line proposing brain-init, nothing created', () => {
  const fx = setup();
  try {
    const lonely = path.join(fx.root, 'lonely');
    initProject(lonely, { brainRel: '../no-brain' });
    const r = fx.hook('session-start.mjs', { source: 'startup' }, { cwd: lonely });
    assert.deepEqual(headings(r.context), ITEMS);
    assert.match(r.context, /brain not found at \.\.\/no-brain; propose: node <plugin>\/bin\/brain-init\.mjs \.\.\/no-brain/);
    assert.ok(!fs.existsSync(path.join(fx.root, 'no-brain')));
    assert.match(r.context, /thread a1 \| topic - \(none\) \| mail: 0/);
  } finally { fx.cleanup(); }
});

// Several PCs on one brain (alice/main 2026-11-05): session start pulls what another machine pushed.
test('session start fast-forwards the brain to origin; a clone with own changes is reported, not touched', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.runB('save.mjs', ['memory', 'tool', 'from-b', '--content', 'pushed by machine B']).status, 0);
    const originHead = fx.git(fx.origin, 'rev-parse', 'main');
    let r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(r.context, /brain: updated from origin \(1 commit\(s\)/);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), originHead);
    assert.match(r.context, /from-b/, 'memory index of the boot is built after the pull');
    r = fx.hook('session-start.mjs', { source: 'resume' });
    assert.doesNotMatch(r.context, /brain: /);

    assert.equal(fx.runB('save.mjs', ['memory', 'tool', 'second', '--content', 'y']).status, 0);
    fs.appendFileSync(path.join(fx.brain, '.gitattributes'), '# local edit\n');
    const head = fx.git(fx.brain, 'rev-parse', 'HEAD');
    r = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(r.context, /brain: 1 commit\(s\) behind origin, not updated \(uncommitted changes: \.gitattributes\)/);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), head);
    assert.match(fx.read('.gitattributes'), /# local edit/);
  } finally { fx.cleanup(); }
});
