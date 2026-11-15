// ttl: 2026-12-15
// agent-alice/D-0082, point 1: a handoff is a record. topic.mjs create|thread for another thread and comms send --handoff
// write into the giver's topic (the topic this thread holds) topics/<giver>/handoffs.json: target, scope, not, time, via;
// the giver does not write it into its handover. topic.mjs auto (code without a thread) writes none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const noThreadStart = (fx) => fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: 'false' } }));
import { setup, startComms, commsClient } from './helpers.mjs';

const skipMail = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
const records = (fx, id) => { const f = path.join(fx.brain, 'topics', id, 'handoffs.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };

test('create for another thread and thread write a handoff record into the giver topic; own create and auto write none', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    let r = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta', '--not', 'DNS záznamy', '--for-thread', 't2']);
    assert.equal(r.status, 0, r.out);
    let list = records(fx, 'orch');
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.equal(list[0].to, 'domain-migrate');
    assert.equal(list[0].scope, 'migrácia domén Alfa a Beta');
    assert.equal(list[0].not, 'DNS záznamy');
    assert.equal(list[0].via, 'create');
    assert.ok(!Number.isNaN(Date.parse(list[0].at)));
    assert.ok(list[0].snapshot && typeof list[0].snapshot === 'object', 'an initial snapshot (baseline for point 4)');
    assert.ok(!('project' in list[0]), 'a topic of this project names no project');
    // committed by code, not by the agent
    assert.match(fx.git(fx.brain, 'ls-files', 'topics/orch/handoffs.json'), /handoffs\.json/);
    assert.doesNotMatch(fx.read('topics/orch/handover.md'), /domain-migrate/);
    // without --task the subject is the scope; --no-claim is for another thread too
    r = fx.run('topic.mjs', ['create', 'free-t', '--subject', 'Voľná práca na faktúrach', '--class', 'discussion', '--no-claim']);
    assert.equal(r.status, 0, r.out);
    list = records(fx, 'orch');
    assert.equal(list.length, 2);
    assert.equal(list[1].to, 'free-t');
    assert.equal(list[1].scope, 'Voľná práca na faktúrach');
    assert.equal(list[1].not, null);
    // thread: scope is the subject with --task (agent-alice/D-0082 point 2)
    r = fx.run('topic.mjs', ['thread', 'free-t', '--task', 'tlač faktúr za október', '--for-thread', 't3']);
    assert.equal(r.status, 0, r.out);
    list = records(fx, 'orch');
    assert.equal(list.length, 3);
    assert.equal(list[2].via, 'thread');
    assert.equal(list[2].scope, 'Voľná práca na faktúrach: tlač faktúr za október');
    // the thread takes its own topic: no handoff
    assert.equal(fx.run('topic.mjs', ['create', 'own', '--subject', 'Vlastná', '--class', 'discussion', '--here']).status, 0);
    assert.equal(records(fx, 'orch').length, 3);
    assert.equal(records(fx, 'own').length, 0);
    // auto: code without a thread holds nothing and records nothing
    noThreadStart(fx);
    fx.run('topic.mjs', ['auto', 'auto-x', '--subject', 'Automatická', '--class', 'discussion', '--task', 'vybav issue']);
    assert.equal(records(fx, 'orch').length, 3);
    assert.equal(records(fx, 'own').length, 0);
  } finally { fx.cleanup(); }
});

test('comms send --handoff: only assist or steer to a topic; the record goes into the giver topic', { skip: skipMail }, async () => {
  const fx = setup();
  const comms = await startComms(fx);
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén', '--for-thread', 't2']).status, 0);
    const before = records(fx, 'orch').length;
    let r = fx.run('comms.mjs', ['send', '--level', 'blocker', '--to', 'domain-migrate', '--handoff', 'doména Alfa', '--text', 'urob Alfa']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /--handoff/);
    assert.match(r.stderr, /assist|steer/);
    assert.equal(records(fx, 'orch').length, before);
    r = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'domain-migrate', '--handoff', 'doména Alfa', '--not', 'Beta', '--text', 'urob Alfa, Beta nie']);
    assert.equal(r.status, 0, r.out);
    const list = records(fx, 'orch');
    assert.equal(list.length, before + 1);
    const last = list.at(-1);
    assert.deepEqual([last.to, last.scope, last.not, last.via], ['domain-migrate', 'doména Alfa', 'Beta', 'comms']);
    // --not alone has no handoff to narrow
    r = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'domain-migrate', '--not', 'x', '--text', 'y']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /--handoff/);
  } finally { await comms.stop(); fx.cleanup(); }
});
