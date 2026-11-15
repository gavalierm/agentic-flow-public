// keep: core
// agent-alice/D-0082, point 2 (observed 2026-11-15): the orchestrator copied the state of topic domain-migrate into its own
// handover; the operator then gave the work in domain-migrate's own thread and the copy went stale without a warning.
// The giver's handover gets a section "## Odovzdané" written only by code from the target topic itself (refreshed at every
// save handover of the giver, shown at session start, a closed target once with its result), and a point of --next or --done
// that describes the state of another open topic gets a warning (agent-alice/D-0094, P-076: a warning, not a refusal; each
// point of the step is judged alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { checkHandover, withHandoffs, HANDOFFS_SECTION, renderHandover } from '../scripts/brain-checks.mjs';

const t2 = { env: { WORKFLOW_THREAD_ID: 't2' } };

function orchestrated() {
  const fx = setup();
  assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
  const r = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta', '--for-thread', 't2']);
  assert.equal(r.status, 0, r.out);
  const h = fx.run('save.mjs', ['handover', 'domain-migrate', '--task', 'migrácia domén', '--done', 'Bratislava', '--next', 'ďalšia doména Alfa'], t2);
  assert.equal(h.status, 0, h.out);
  return fx;
}

test('--next with the state of another open topic gets a warning; the own step is accepted and the section shows the live state', () => {
  const fx = orchestrated();
  try {
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'začať']).status, 0);
    let r = fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'ďalšia doména migrácie (Alfa, Beta) iba na pokyn operátora v téme domain-migrate']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^warning: --next ".*" describes the state of topic domain-migrate/m);
    assert.match(r.stdout, /## Odovzdané/);
    assert.match(r.stdout, /dohľad nad domain-migrate/);
    assert.match(r.stdout, /the handover is written/);
    assert.match(fx.read('topics/orch/handover.md'), /iba na pokyn operátora v téme domain-migrate/);
    // the same copy written without diacritics (pilot 2026-11-15: "dalšia" passed)
    r = fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'dalsia domena migracie (Alfa, Beta) zostava v teme domain-migrate']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /warning: --next ".*" describes the state of topic domain-migrate/);
    // --done items too, and the full subject counts as the topic
    r = fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané; Migrácia domén: Alfa zostáva', '--next', 'dohľad nad domain-migrate']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /warning: --done "Migrácia domén: Alfa zostáva" describes the state of topic domain-migrate/);
    // "dohľad" and "čakám" are no state words; a state word in another point than the topic is no copy
    r = fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'dohľad nad domain-migrate']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /warning:/);
    const text = fx.read('topics/orch/handover.md');
    assert.match(text, /^## Odovzdané$/m);
    const line = text.split('\n').find((l) => l.startsWith('- domain-migrate:'));
    assert.ok(line, text);
    assert.match(line, /^- domain-migrate: migrácia domén Alfa a Beta \| otvorená \| držiteľ t2 \| handover \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \| ďalej: ďalšia doména Alfa$/);
    // the target changes its next step: the giver's next save shows the new one (no copy)
    assert.equal(fx.run('save.mjs', ['handover', 'domain-migrate', '--task', 'migrácia domén', '--done', 'Alfa', '--next', 'Beta na pokyn operátora'], t2).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'dohľad nad domain-migrate']).status, 0);
    assert.match(fx.read('topics/orch/handover.md'), /\| ďalej: Beta na pokyn operátora$/m);
    // an own topic is not "another": the giver may describe itself
    r = fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'orch: ďalšia úloha zostáva']);
    assert.equal(r.status, 0, r.out);
    // session start shows the section, computed live
    const s = fx.hook('session-start.mjs', { source: 'startup' });
    assert.match(s.context, /## Odovzdané|Odovzdané/);
    assert.match(s.context, /- domain-migrate: migrácia domén Alfa a Beta \| otvorená \| držiteľ t2/);
  } finally { fx.cleanup(); }
});

test('an agent-written section is replaced over --file; a handover has no line limit, only its sections', () => {
  const fx = orchestrated();
  try {
    const file = path.join(fx.root, 'ho.md');
    fs.writeFileSync(file, `${renderHandover({ task: 'orchestrácia', done: 'zadané', next: 'dohľad nad domain-migrate' })}${HANDOFFS_SECTION}\n- domain-migrate: stará kópia | hotová\n`);
    const r = fx.run('save.mjs', ['handover', 'orch', '--file', file]);
    assert.equal(r.status, 0, r.out);
    const text = fx.read('topics/orch/handover.md');
    assert.doesNotMatch(text, /stará kópia/);
    assert.match(text, /- domain-migrate: migrácia domén Alfa a Beta \| otvorená/);
    // no line limit (agent-alice/D-0094): a long handover passes, a missing section does not
    const full = renderHandover({ task: 't', done: 'a; b; c; d; e; f; g; h; i', next: 'n', files: 'f1; f2', questions: 'q1; q2' });
    assert.ok(full.trim().split('\n').length > 15);
    assert.deepEqual(checkHandover(withHandoffs(full, ['- x: a | otvorená', '- y: b | otvorená', '- z: c | otvorená'])), []);
    assert.deepEqual(checkHandover(full.replace('## Súbory\n', '')), ['handover missing section "## Súbory" (P-011)']);
  } finally { fx.cleanup(); }
});

test('a closed target is shown once with its result, then left out', () => {
  const fx = orchestrated();
  try {
    const d = fx.run('done.mjs', ['--topic', '--topic-id', 'domain-migrate', '--knowledge', 'nic nové', '--verified', 'Alfa a Beta presunuté'], t2);
    assert.equal(d.status, 0, d.out);
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'skontrolovať výsledok']).status, 0);
    let text = fx.read('topics/orch/handover.md');
    assert.match(text, /^- domain-migrate: migrácia domén Alfa a Beta \| uzavretá \|.*výsledok: Alfa a Beta presunuté$/m);
    const recs = JSON.parse(fx.read('topics/orch/handoffs.json'));
    assert.equal(recs[0].closed_shown, true);
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'ďalej']).status, 0);
    text = fx.read('topics/orch/handover.md');
    assert.doesNotMatch(text, /domain-migrate/);
    assert.doesNotMatch(text, /## Odovzdané/);
  } finally { fx.cleanup(); }
});
