// ttl: 2026-12-15
// Flow v2 spec 10.6 (plan B14): `topic.mjs mode <id> discussion|off`. The mode is the field `mode` of the topic record,
// apart from the class, which never changes; discussion is set only over a handover without a next step and only by the
// holder; save handover reads only `mode` (a topic of class discussion with mode off takes a step, a topic of another
// class in mode discussion refuses one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { isDiscussionMode } from '../scripts/topic.mjs';

const record = (fx, id) => JSON.parse(fx.read(`topics/${id}/topic.json`));

test('mode discussion: refused over a step, set after the step went to the questions, --next refused, off takes it; class stays', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'web-x', '--subject', 'Web X', '--class', 'ops']).status, 0);
    assert.equal(record(fx, 'web-x').mode, 'off');
    assert.equal(fx.run('save.mjs', ['handover', 'web-x', '--task', 'T', '--next', 'nasadiť stránku']).status, 0);
    let r = fx.run('topic.mjs', ['mode', 'web-x', 'discussion']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /has a next step in its handover \("nasadiť stránku"\): mode discussion is set only over a handover without a step/);
    assert.equal(record(fx, 'web-x').mode, 'off');
    // The step moves into Otvorené otázky as a question; then the mode is set, the class stays.
    assert.equal(fx.run('save.mjs', ['handover', 'web-x', '--task', 'T', '--next', '', '--questions', 'Pokračovať v nasadení stránky?']).status, 0);
    r = fx.run('topic.mjs', ['mode', 'web-x', 'discussion']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /topic web-x mode discussion/);
    let t = record(fx, 'web-x');
    assert.equal(t.mode, 'discussion'); assert.equal(t.class, 'ops'); assert.equal(t.kind, 'discussion'); assert.equal(t.state, 'working');
    assert.ok(isDiscussionMode(t));
    assert.match(fx.git(fx.brain, 'log', '-1', '--format=%s'), /topic mode web-x discussion by a1/);
    r = fx.run('save.mjs', ['handover', 'web-x', '--task', 'T', '--next', 'nasadiť']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /mode discussion/);
    assert.match(fx.run('topic.mjs', ['mode', 'web-x', 'discussion']).stdout, /already in mode discussion/);
    // Order to work: mode off, the step is saved.
    assert.equal(fx.run('topic.mjs', ['mode', 'web-x', 'off']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'web-x', '--task', 'T', '--next', 'nasadiť']).status, 0);
    t = record(fx, 'web-x');
    assert.equal(t.mode, 'off'); assert.equal(t.class, 'ops');
  } finally { fx.cleanup(); }
});

test('only mode decides: class discussion with mode off takes a step; unknown mode and a foreign holder are refused', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'talk', '--subject', 'Talk', '--class', 'discussion']).status, 0);
    assert.equal(record(fx, 'talk').mode, 'discussion');
    assert.equal(fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--next', 'x']).status, 1);
    assert.equal(fx.run('topic.mjs', ['mode', 'talk', 'off']).status, 0);
    const t = record(fx, 'talk');
    assert.equal(t.mode, 'off'); assert.equal(t.class, 'discussion');
    assert.equal(isDiscussionMode(t), false);
    let r = fx.run('save.mjs', ['handover', 'talk', '--task', 'T', '--next', 'napísať návrh']);
    assert.equal(r.status, 0, r.out);
    r = fx.run('topic.mjs', ['mode', 'talk', 'chat']);
    assert.equal(r.status, 1); assert.match(r.stderr, /usage: topic\.mjs mode <id> discussion\|off/);
    fx.git(fx.brainB, 'pull', '-q', '--rebase', 'origin', 'main');
    r = fx.runB('topic.mjs', ['mode', 'talk', 'discussion']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /held by thread a1.*only its holder sets its mode/);
  } finally { fx.cleanup(); }
});
