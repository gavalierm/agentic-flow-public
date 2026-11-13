// 3c.3 (D-0023): the reporter's open issues stay in the topic's handover until error.mjs confirm. The optional section
// "## Otvorené hlásenia" is written by code (save.mjs handover, also over --file) from local/reported-issues.json, counts
// into the line limit, and old handovers without it stay valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { REPORTS_SECTION, withReports, checkHandover, renderHandover, freeHandover } from '../scripts/brain-checks.mjs';

const URL1 = 'https://github.com/o/r/issues/1';
const URL2 = 'https://github.com/o/r/issues/2';

test('withReports: added after "## Otvorené otázky", replaced, removed; a handover without reports stays byte for byte', () => {
  const base = renderHandover({ task: 'T', done: 'a', next: 'n', files: 'f', questions: 'q' });
  assert.equal(withReports(base, []), base, 'nothing to add, nothing changes');
  const one = withReports(base, [`- ${URL1} (stav: čaká; od 2026-11-13)`]);
  const lines = one.trimEnd().split('\n');
  assert.equal(lines.at(-2), REPORTS_SECTION);
  assert.equal(lines.at(-1), `- ${URL1} (stav: čaká; od 2026-11-13)`);
  assert.equal(lines[lines.indexOf('## Otvorené otázky') + 2], REPORTS_SECTION, 'right after the questions');
  // An agent's own edit of the section is replaced by the records.
  const edited = one.replace('stav: čaká', 'stav: vyriešené agentom');
  const fixed = withReports(edited, [`- ${URL1} (stav: odpoveď; od 2026-11-13)`, `- ${URL2} (stav: zavreté; od 2026-11-13)`]);
  assert.equal(fixed.split('\n').filter((l) => l === REPORTS_SECTION).length, 1);
  assert.ok(!fixed.includes('vyriešené agentom'));
  assert.match(fixed, /issues\/2 \(stav: zavreté/);
  assert.equal(withReports(fixed, []), base, 'the last confirmed issue removes the section');
  // A section in the middle (an older edit) moves behind the questions.
  const middle = base.replace('## Ďalší krok', `${REPORTS_SECTION}\n- x\n## Ďalší krok`);
  const moved = withReports(middle, ['- y']).trimEnd().split('\n');
  assert.deepEqual(moved.slice(-2), [REPORTS_SECTION, '- y']);
  assert.ok(!moved.includes('- x'));
});

test('checkHandover: the section counts into the limit and the refusal names it; old handovers pass', () => {
  assert.deepEqual(checkHandover(freeHandover()), []);
  const old = renderHandover({ task: 'T', done: 'a; b; c; d; e; f', next: 'n' });
  assert.equal(old.trimEnd().split('\n').length, 15);
  assert.deepEqual(checkHandover(old), [], 'an old full handover stays valid');
  const withSection = renderHandover({ task: 'T', done: 'a; b; c; d', next: 'n', reports: [`- ${URL1} (stav: čaká; od 2026-11-13)`] });
  assert.deepEqual(checkHandover(withSection), []);
  const over = withReports(old, [`- ${URL1} (stav: čaká; od 2026-11-13)`]);
  const [err] = checkHandover(over);
  assert.match(err, /handover has 17 lines, limit 15/);
  assert.match(err, /the section "## Otvorené hlásenia" \(1 open issue\(s\), written by code until error\.mjs confirm\) 2, so --done, --files and --questions together hold at most 6 items/);
  assert.match(err, /cut 2/);
  assert.doesNotMatch(checkHandover(old + 'x\n')[0], /Otvorené hlásenia/, 'without the section the refusal is as before');
});

function fixture() {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 't1', '--class', 'discussion', '--subject', 'S']).status, 0);
  const rec = (n, topic, extra = {}) => ({ url: `https://github.com/o/r/issues/${n}`, repo: 'o/r', number: n, topic, status: 'waiting', state: 'open', last_comment_id: 0, created_at: '2026-11-13T08:00:00.000Z', ...extra });
  fx.records = (all) => { fs.mkdirSync(path.join(fx.brain, 'local'), { recursive: true }); fs.writeFileSync(path.join(fx.brain, 'local', 'reported-issues.json'), JSON.stringify(all)); };
  fx.records({ 'o/r#1': rec(1, 't1'), 'o/r#2': rec(2, 't1', { state: 'closed', last_comment_id: 5 }), 'o/r#3': rec(3, 'other'), 'o/r#4': rec(4, 't1', { status: 'confirmed' }) });
  fx.rec = rec;
  fx.handover = () => fx.read('topics/t1/handover.md');
  return fx;
}

test('save.mjs handover writes the open issues of the topic, also over --file; confirmed ones and other topics stay out', () => {
  const fx = fixture();
  try {
    let r = fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--next', 'y']);
    assert.equal(r.status, 0, r.out);
    let h = fx.handover();
    assert.match(h, new RegExp(`${REPORTS_SECTION}\\n- https://github\\.com/o/r/issues/1 \\(stav: čaká; od 2026-11-13\\)\\n- https://github\\.com/o/r/issues/2 \\(stav: zavreté; od 2026-11-13\\)\\n$`));
    assert.ok(!h.includes('issues/3') && !h.includes('issues/4'));
    // --file without the section (the agent rewrote the handover): the code adds it again.
    const file = path.join(fx.root, 'h.md');
    fs.writeFileSync(file, renderHandover({ task: 'x2', next: 'y2' }));
    r = fx.run('save.mjs', ['handover', 't1', '--file', file]);
    assert.equal(r.status, 0, r.out);
    h = fx.handover();
    assert.match(h, /## Zadanie\nx2\n/);
    assert.match(h, /issues\/1 \(stav: čaká/);
    // Confirmed (error.mjs confirm): the next save drops it; the last one drops the section.
    fx.records({ 'o/r#1': fx.rec(1, 't1', { status: 'confirmed' }), 'o/r#2': fx.rec(2, 't1', { status: 'confirmed' }) });
    r = fx.run('save.mjs', ['handover', 't1', '--file', file]);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.handover(), fs.readFileSync(file, 'utf8'));
  } finally { fx.cleanup(); }
});

test('save.mjs handover: the section counts into the 15 lines; the refusal names it and nothing is written', () => {
  const fx = fixture();
  try {
    assert.equal(fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--next', 'y']).status, 0);
    const before = fx.handover();
    const r = fx.run('save.mjs', ['handover', 't1', '--task', 'x', '--done', 'a; b; c; d; e', '--next', 'y']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /handover has 17 lines, limit 15 .*the section "## Otvorené hlásenia" \(2 open issue\(s\), written by code until error\.mjs confirm\) 3/);
    assert.equal(fx.handover(), before);
  } finally { fx.cleanup(); }
});
