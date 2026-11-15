// ttl: 2026-12-14
// Sorting of a topic's content (D-0058, D-0059, D-0060): done --topic needs --knowledge in both layouts; in layout 2 every
// topic with work files outside tmp/ is triaged, whoever gave it, by the classes dokument, zdroj, stav, pomocne; a triage
// without unclear files runs without a question; unclear files stop it until the operator confirms them (a dialog, or the
// orchestrator's reply with --confirmed-by); a topic left with only its handover goes to the hidden archive; a file with a
// clear class is promoted at once (save.mjs promote --as dokument|zdroj) without a dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { persona2 } from './layout-2-helpers.mjs';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { listTopicRecords } from '../scripts/topic-files.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const write = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const iso = (ms) => new Date(ms).toISOString();

function personaFx() {
  const p = persona2();
  const at = (rel) => path.join(p.dir, ...rel.split('/'));
  const fx = { ...p, thread: 'p1', brain: p.dir, project: p.dir, read: (rel) => fs.readFileSync(at(rel), 'utf8'), json: (rel) => JSON.parse(fs.readFileSync(at(rel), 'utf8')), exists: (rel) => fs.existsSync(at(rel)) };
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  fx.stub = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  fx.stub({});
  return fx;
}

/** Thread state: an operator turn, with or without a dialog answered in it, or a turn from a bell. */
function turn(fx, { wake = false, answered = false } = {}) {
  const now = Date.now();
  const file = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = {}; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { dialog_answered_at: _a, ...rest } = st;
  fs.writeFileSync(file, JSON.stringify({ ...rest, turn_source: wake ? 'wake' : 'operator', turn_started_at: iso(now - 60_000), ...(answered ? { dialog_answered_at: iso(now) } : {}) }));
}

/** Topic t1 (technical, as code creates it) with a note, a download, a log, a work in progress and tmp/. */
function topicWithFiles(fx, { assigned = 'technical', orchestrator = null } = {}) {
  assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Topic one', '--class', 'discussion']).status, 0);
  const tema = path.join(fx.brain, 'temy', 't1', '.tema.json');
  fs.writeFileSync(tema, JSON.stringify({ ...JSON.parse(fs.readFileSync(tema, 'utf8')), assigned_by: assigned, ...(orchestrator ? { orchestrator } : {}) }, null, 2) + '\n');
  write(fx.brain, 'temy/t1/analyza.md', '# Analyza\n\ntext\n');
  write(fx.brain, 'temy/t1/export.csv', 'a,b\n');
  write(fx.brain, 'temy/t1/beh.log', 'log\n');
  write(fx.brain, 'temy/t1/rozpracovane.md', '# Rozpracovane\n');
  fx.git(fx.brain, 'add', '-A'); fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'topic files');
  write(fx.brain, 'temy/t1/tmp/raw.json', '{}');
}

const listFile = (fx, text) => { const f = path.join(fx.root, 'triage.txt'); fs.writeFileSync(f, text); return f; };

test('done --topic without --knowledge is refused with the reason, in layout 1 and layout 2', () => {
  const fx1 = setup();
  try {
    assert.equal(fx1.run('topic.mjs', ['create', 'k1', '--subject', 'S', '--class', 'discussion']).status, 0);
    for (const extra of [[], ['--knowledge'], ['--knowledge', ' ']]) {
      const r = fx1.run('done.mjs', ['--topic', '--verified', 'observed', ...extra]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /needs --knowledge .*save/);
    }
    const r = fx1.run('done.mjs', ['--topic', '--verified', 'observed', '--knowledge', 'nic nové']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /knowledge: nic nové/);
  } finally { fx1.cleanup(); }
  const fx = personaFx();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'k2', '--subject', 'S', '--class', 'discussion']).status, 0);
    const r = fx.run('done.mjs', ['--topic', '--verified', 'observed']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /needs --knowledge/);
  } finally { fx.cleanup(); }
});

test('a technical topic with work files is triaged too: the list, then the classes applied without a dialog', () => {
  const fx = personaFx();
  try {
    topicWithFiles(fx);
    turn(fx);
    let r = fx.run('done.mjs', ['--topic', '--verified', 'observed', '--knowledge', 'nic nové']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /triage: topic t1 has 4 work file\(s\) outside tmp\/ and is not closed/);
    assert.match(r.out, /^\? analyza\.md$/m);
    assert.equal(fx.json('temy/t1/.tema.json').state, 'working');
    const list = listFile(fx, 'dokument analyza.md\nzdroj export.csv\npomocne beh.log\nstav rozpracovane.md\n');
    r = fx.run('done.mjs', ['--topic', '--verified', 'observed', '--knowledge', 'nic nové', '--triage', list]);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.read('vystupy/dokumenty/analyza.md'), '# Analyza\n\ntext\n');
    assert.equal(fx.read('zdroje/t1/export.csv'), 'a,b\n');
    assert.ok(!fx.exists('temy/t1/beh.log'), 'pomocne removed');
    assert.ok(fx.exists('temy/t1/rozpracovane.md'), 'stav stays');
    assert.equal(fx.json('temy/t1/.tema.json').state, 'closed', 'a stav file keeps the topic in temy/');
    assert.equal(fx.json('temy/t1/.tema.json').knowledge, 'nic nové');
    assert.ok(!fx.exists('temy/t1/tmp'), 'tmp/ removed');
    assert.match(fx.read('temy/t1/handover.md'), /triáž: dokument temy\/t1\/analyza\.md -> vystupy\/dokumenty\/analyza\.md/);
  } finally { fx.cleanup(); }
});

test('unclear files stop the triage; the operator confirms them in a dialog of a thread without an orchestrator', () => {
  const fx = personaFx();
  try {
    topicWithFiles(fx, { assigned: 'operator' });
    turn(fx);
    const head = fx.git(fx.brain, 'rev-parse', 'HEAD');
    let r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', listFile(fx, 'nejasne analyza.md\npomocne beh.log\n')]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /1 file\(s\) marked nejasne, nothing written.*AskUserQuestion/s);
    assert.equal(fx.git(fx.brain, 'rev-parse', 'HEAD'), head, 'nothing written');
    assert.ok(fx.exists('temy/t1/beh.log'), 'nothing removed');
    const confirmed = listFile(fx, 'nejasne:dokument analyza.md\npomocne beh.log\npomocne export.csv\npomocne rozpracovane.md\n');
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /no dialog in this turn/);
    assert.ok(fx.exists('temy/t1/beh.log'));
    turn(fx, { answered: true });
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('vystupy/dokumenty/analyza.md'));
  } finally { fx.cleanup(); }
});

test('a topic from an orchestrator: unclear files confirmed only by the orchestrator reply this thread received (--confirmed-by)', () => {
  const fx = personaFx();
  try {
    topicWithFiles(fx, { orchestrator: { project: 'alice', topic: 'orch', thread: 'o1' } });
    turn(fx);
    let r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', listFile(fx, 'nejasne analyza.md\n')]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /comms send --to alice\/orch --level assist/);
    const confirmed = listFile(fx, 'nejasne:dokument analyza.md\npomocne beh.log\nzdroj export.csv\npomocne rozpracovane.md\n');
    turn(fx, { answered: true });
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /does not ask the operator \(D-0031\).*--confirmed-by/s);
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed, '--confirmed-by', 'r1']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /did not receive that message as a reply/);
    // A reply from another topic is no confirmation.
    fx.stub({ messages: [{ id: 'r0', reply_to: 'q1', from_project: 'alice', from_topic: 'other', topic: 't1', level: 'assist', text: 'x' }], message: { q1: { id: 'q1', project: 'alice', topic: 'orch' } } });
    assert.equal(fx.run('comms.mjs', ['receive', '--id', 'r0']).status, 0);
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed, '--confirmed-by', 'r0']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /not from the orchestrator of topic t1/);
    assert.ok(fx.exists('temy/t1/beh.log'), 'nothing removed without the confirmation');
    fx.stub({ messages: [{ id: 'r1', reply_to: 'q1', from_project: 'alice', from_topic: 'orch', topic: 't1', level: 'assist', text: 'potvrdene' }], message: { q1: { id: 'q1', project: 'alice', topic: 'orch' } } });
    assert.equal(fx.run('comms.mjs', ['receive', '--id', 'r1']).status, 0);
    turn(fx);
    r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', confirmed, '--confirmed-by', 'r1']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('vystupy/dokumenty/analyza.md'));
  } finally { fx.cleanup(); }
});

test('a topic left with only handover and .tema.json goes to the hidden archive, outside INDEX.md; its closed record is found', () => {
  const fx = personaFx();
  try {
    topicWithFiles(fx);
    turn(fx);
    const r = fx.run('done.mjs', ['--topic', '--verified', 'o', '--knowledge', 'nic nové', '--triage', listFile(fx, 'dokument analyza.md\nzdroj export.csv\npomocne beh.log\npomocne rozpracovane.md\n')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /hidden archive \.brain\/archive\/topics\/t1\//);
    assert.ok(!fx.exists('temy/t1'), 'not in temy/');
    assert.equal(fx.json('.brain/archive/topics/t1/.tema.json').state, 'closed');
    assert.ok(fx.exists('.brain/archive/topics/t1/handover.md'));
    assert.ok(!fx.exists('.brain/archive/topics/t1/tmp'), 'tmp/ not archived');
    assert.doesNotMatch(fx.read('INDEX.md'), /archive/);
    assert.deepEqual(listTopicRecords(fx.brain, { closed: true }).map((t) => t.id), ['t1']);
    const f = fx.run('find.mjs', ['t1']);
    assert.match(f.out, /\.brain\/archive\/topics\/t1/);
  } finally { fx.cleanup(); }
});

test('save.mjs promote sorts a file with a clear class at once, without a dialog: a document or a source', () => {
  const fx = personaFx();
  try {
    topicWithFiles(fx);
    turn(fx);
    let r = fx.run('save.mjs', ['promote', 'analyza.md']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('vystupy/dokumenty/analyza.md'));
    r = fx.run('save.mjs', ['promote', 'export.csv', '--as', 'zdroj']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('zdroje/t1/export.csv'));
    r = fx.run('save.mjs', ['promote', 'beh.log', '--as', 'pomocne']);
    assert.equal(r.status, 1, r.out);
    turn(fx, { wake: true });
    r = fx.run('save.mjs', ['promote', 'rozpracovane.md']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /started by a message/);
  } finally { fx.cleanup(); }
});
