// ttl: 2026-12-15
// Flow v2 spec 3.9, 4.2.2, 10.5, 10.6 item 4 (plan B6, O6, O23): the supervisor's overview without an agent reads the topic
// record and handover of every open topic of every domain of the machine (a brain in layout 2 and one in layout 3) and
// lists stuck steps, idle locks (inactivity from the last push of the topic state, not while otázka, hotovo or čakám before
// its alarm, after a missed alarm from its time) and topics hotovo without work; a topic in mode discussion and one the
// supervisor owes an answer to are not proposed for closing. The wake job mails the supervisor only on a new finding; the
// supervisor's session start shows the overview and its open obligations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv, setup } from './helpers.mjs';
import { persona2 } from './layout-2-helpers.mjs';
import { lockIdleSince, lockInactivity, topicFindings, overview } from '../scripts/overview.mjs';

const H = 3600_000;
const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const iso = (t) => new Date(t).toISOString();
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A domain folder under root with its marker and a brain of `layout` made by brain-init (no remote). */
function domain(root, name, layout) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic-domain'), JSON.stringify({ brain: 'brain' }));
  const brain = path.join(dir, 'brain');
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brain, '--layout', String(layout)], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return brain;
}

/** An open topic written directly into the brain (record and handover) and committed now. */
function topic(brain, layout, id, fields) {
  const dir = path.join(brain, layout === 2 ? 'temy' : 'topics', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.tema.json'), `${JSON.stringify({ id, subject: `Téma ${id}`, class: 'ops', kind: 'discussion', state: 'working', created: iso(Date.now()), mode: 'off', ...fields }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'handover.md'), '## Zadanie\n-\n## Hotové\n-\n## Ďalší krok\n- spusti migráciu\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n');
  git(brain, 'add', '-A');
  git(brain, 'commit', '-q', '-m', `topic ${id}`);
}

/** Machine root with domain Alfa (layout 2) and domain Beta (layout 3), each kind of finding and topics without one. */
function machine(base) {
  const root = path.join(base, 'machine');
  const now = Date.now();
  const a = domain(root, 'Alfa', 2);
  topic(a, 2, 'a-stuck', { holder: { thread: 't1', machine: 'm1' }, turn: { state: 'otázka', alarm_at: null, stuck: ['spusti migráciu'] } });
  topic(a, 2, 'a-idle', { holder: { thread: 't2', machine: 'm2' }, turn: { state: 'čakám', alarm_at: iso(now + H) } });
  topic(a, 2, 'a-wait', { holder: { thread: 't3', machine: 'm1' }, turn: { state: 'čakám', alarm_at: iso(now + 20 * H) } });
  topic(a, 2, 'a-free', { holder: {}, turn: { state: 'čakám', alarm_at: iso(now - H) } });
  const b = domain(root, 'Beta', 3);
  topic(b, 3, 'b-done', { holder: { thread: 't4', machine: 'm1' }, turn: { state: 'hotovo', alarm_at: null } });
  topic(b, 3, 'b-disc', { holder: { thread: 't5', machine: 'm1' }, mode: 'discussion', turn: { state: 'hotovo', alarm_at: null } });
  topic(b, 3, 'b-question', { holder: { thread: 't6', machine: 'm1' }, turn: { state: 'otázka', alarm_at: null } });
  topic(b, 3, 'b-nostate', { holder: { thread: 't7', machine: 'm1' } });
  return { root, a, b, now };
}

test('inactivity of a lock (4.2.2): not while otázka, hotovo or čakám before the alarm; after a missed alarm from its time', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const push = iso(now - 20 * H);
  assert.equal(lockIdleSince({ state: 'otázka', lastPush: push, now }), null);
  assert.equal(lockIdleSince({ state: 'hotovo', lastPush: push, now }), null);
  assert.equal(lockIdleSince({ state: 'čakám', alarmAt: iso(now + H), lastPush: push, now }), null);
  assert.equal(lockIdleSince({ state: 'čakám', alarmAt: iso(now - 5 * H), lastPush: push, now }), now - 5 * H, 'from the missed alarm');
  assert.equal(lockIdleSince({ state: 'čakám', alarmAt: iso(now - 30 * H), lastPush: push, now }), now - 20 * H, 'a push after the alarm counts');
  assert.equal(lockIdleSince({ state: null, lastPush: push, now }), now - 20 * H);
  assert.deepEqual(lockInactivity({ state: null, lastPush: push, now }, 12), { since: push, hours: 20 });
  assert.equal(lockInactivity({ state: 'čakám', alarmAt: iso(now - 5 * H), lastPush: push, now }, 12), null, 'under the threshold');
  // A topic the supervisor owes an answer to is not proposed for closing; mode discussion never is.
  const rec = (id, topicFields) => ({ id, topic: { subject: id, turn: { state: 'hotovo' }, mode: 'off', ...topicFields }, holder: {} });
  assert.deepEqual(topicFindings(rec('x'), { now }).map((f) => f.kind), ['done']);
  assert.deepEqual(topicFindings(rec('x'), { now, owed: [{ id: 'm1', from_topic: 'x' }] }), []);
  assert.deepEqual(topicFindings(rec('x', { mode: 'discussion' }), { now }), []);
  // turn.stuck is the list of step items (10.2, the wake writes it): an empty list or another shape is no stuck finding.
  assert.deepEqual(topicFindings(rec('s', { turn: { state: 'otázka', stuck: ['a', 'b'] } }), { now }).map((f) => [f.kind, f.items]), [['stuck', ['a', 'b']]]);
  assert.deepEqual(topicFindings(rec('s', { turn: { state: 'otázka', stuck: [] } }), { now }), []);
  assert.deepEqual(topicFindings(rec('s', { turn: { state: 'otázka', stuck: { steps: ['a'] } } }), { now }), []);
});

test('two domains in layout 2 and 3: each kind of finding, the discussion topic is not proposed for closing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ov-'));
  try {
    const m = machine(base);
    const res = overview({ root: m.root, now: m.now + 14 * H });
    assert.equal(res.brains, 2);
    assert.equal(res.topics, 8);
    const got = res.findings.map((f) => `${f.kind} ${f.domain}/${f.id}`).sort();
    assert.deepEqual(got, ['done Beta/b-done', 'lock Alfa/a-idle', 'lock Beta/b-nostate', 'stuck Alfa/a-stuck'].sort());
    assert.deepEqual(res.findings.find((f) => f.kind === 'stuck').items, ['spusti migráciu']);
    assert.equal(res.findings.find((f) => f.id === 'a-idle').hours, 13);
    // The same over the command, before the threshold only the stuck step and the done topic.
    const env = cleanEnv();
    let r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'overview.mjs'), '--root', m.root, '--now', iso(m.now + 14 * H)], { env, encoding: 'utf8', cwd: base });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^overview: 4 finding\(s\) in 8 open topic\(s\) of 2 brain\(s\)$/m);
    assert.match(r.stdout, /^stuck: Alfa\/brain\/a-stuck \(Téma a-stuck\): spusti migráciu; .*spec 3\.9\.1/m);
    assert.match(r.stdout, /^idle lock: Alfa\/brain\/a-idle \(Téma a-idle\) held by t2 on m2, inactive 13 h .*state čakám.*takeover/m);
    assert.match(r.stdout, /^idle lock: Beta\/brain\/b-nostate .*held by t7/m);
    assert.match(r.stdout, /^done without work: Beta\/brain\/b-done .*propose closing/m);
    assert.doesNotMatch(r.stdout, /b-disc|b-question|a-wait|a-free/);
    r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'overview.mjs'), '--root', m.root, '--now', iso(m.now + H)], { env, encoding: 'utf8', cwd: base });
    assert.match(r.stdout, /^overview: 2 finding\(s\)/m);
    assert.doesNotMatch(r.stdout, /idle lock/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the wake job mails the maintainer once per new finding (no supervisor by default); a failed mail is tried again', () => {
  const fx = setup();
  try {
    const m = machine(fx.root);
    const stateFile = path.join(fx.root, 'stub-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ sends: [], send_id: 'm-ov' }));
    const env = { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, WORKFLOW_OVERVIEW_STATE: path.join(fx.root, 'overview-state.json') };
    const sends = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends;
    const wake = (now) => fx.run('overview.mjs', ['wake', '--project', fx.project, '--root', m.root, '--now', iso(now)], { env });
    let r = wake(m.now + H);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /overview: 2 new finding\(s\) mailed to the maintainer/);
    assert.equal(sends().length, 1);
    const argv = sends()[0].argv || sends()[0];
    assert.ok(JSON.stringify(argv).includes('"--maintainer"') && JSON.stringify(argv).includes('"--supersede-key","overview"') && JSON.stringify(argv).includes('"assist"'), JSON.stringify(sends()[0]));
    assert.match(JSON.stringify(sends()[0]), /stuck: Alfa\/brain\/a-stuck/);
    // the same findings: no mail
    r = wake(m.now + 2 * H);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /2 finding\(s\), none new; the supervisor is not woken/);
    assert.equal(sends().length, 1);
    // a new finding (the locks went idle), the mail fails: exit 1, tried again at the next run
    fs.writeFileSync(stateFile, JSON.stringify({ sends: sends(), send_fail: true }));
    r = wake(m.now + 14 * H);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /2 new finding\(s\), mail to the maintainer failed/);
    fs.writeFileSync(stateFile, JSON.stringify({ sends: sends() }));
    r = wake(m.now + 14 * H);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /2 new finding\(s\) mailed/);
    assert.match(JSON.stringify(sends().at(-1)), /idle lock: Alfa\/brain\/a-idle/);
    r = wake(m.now + 15 * H);
    assert.match(r.stdout, /none new/, 'mailed once');
  } finally { fx.cleanup(); }
});

test('the session start of the supervisor shows the overview and its open obligations; another persona does not', () => {
  const fx = persona2({ thread: 'p1' });
  try {
    const m = machine(fx.root);
    const rootFile = path.join(fx.root, 'projects-root');
    fs.writeFileSync(rootFile, `${m.root}\n`);
    const stateFile = path.join(fx.root, 'stub-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ owed: [{ id: 'm-o1', level: 'assist', status: 'picked', from_project: 'beta', from_topic: 'b-done' }] }));
    const env = { WORKFLOW_ROOT_FILE: rootFile, WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile };
    let h = fx.hook('session-start.mjs', { source: 'startup' }, { env });
    assert.equal(h.status, 0, h.stderr);
    assert.doesNotMatch(h.context, /^overview:/m, 'the persona bob is not the supervisor');
    assert.equal(fx.run('brain.mjs', ['supervisor', '--persona', 'bob', '--comms', '@bob/main']).status, 0);
    h = fx.hook('session-start.mjs', { source: 'startup' }, { env });
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.context, /^overview: \d+ finding\(s\) in 8 open topic\(s\) of 2 brain\(s\)$/m);
    assert.match(h.context, /^stuck: Alfa\/brain\/a-stuck/m);
    // b-done waits for the supervisor's answer (owed from that topic): not proposed for closing
    assert.doesNotMatch(h.context, /done without work: Beta\/brain\/b-done/);
    assert.match(h.context, /^owed: m-o1 assist from beta\/b-done \(picked without an answer\)$/m);
  } finally { fx.cleanup(); }
});
