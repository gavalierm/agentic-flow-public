// keep: core
// Mail not picked up is lost mail (operator 2026-11-17, critical): a thread whose session project has no brain (P-024)
// got the bell `you have mail in topic thread/<id>` for a reply to its message, and comms.mjs refused with "brain
// unavailable" while the bell hook said "mail unavailable … end the turn". The thread reads, picks up and answers its
// mail with the settings of its mail home: the brain it sent the message from (its thread state there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';

const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

test('a thread in a project without a brain reads, picks up and answers the reply to its message (its mail home)', { skip }, async () => {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    // b2 asks from project-b; the send records the brain as the thread's mail home.
    const send = fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/alpha', '--text', 'need the schema']);
    assert.equal(send.status, 0, send.out);
    const id = /sent (\S+) \(assist\)/.exec(send.stdout)?.[1];
    assert.ok(JSON.parse(fs.readFileSync(path.join(fx.brainB, 'local', 'threads', 'b2.json'), 'utf8')).mail_sent_at);
    assert.equal(fx.run('comms.mjs', ['receive', '--id', id]).status, 0);
    const reply = fx.run('comms.mjs', ['send', '--reply-to', id, '--state', 'hotovo', '--text', 'ANSWER users(id)']);
    assert.equal(reply.status, 0, reply.out);

    // b2 now runs in a folder without a brain (another cwd, the maintainer's workspace).
    const bare = path.join(fx.root, 'workspace');
    fs.mkdirSync(bare, { recursive: true });
    const pin = path.join(fx.root, 'pin.json');
    fs.writeFileSync(pin, JSON.stringify({ brains: { [fx.brain]: null, [fx.brainB]: null } }));
    const env = { ...fx.envB, WORKFLOW_PIN_FILE: pin, WORKFLOW_COMMS_CLIENT: comms.client };
    const run = (args) => fx.run('comms.mjs', args, { cwd: bare, env });

    const bell = fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic thread/b2' }, { cwd: bare, env });
    const rid = /turn started by a message \(wake\): mail: 1 waiting: (\S+) reply/.exec(bell.context)?.[1];
    assert.ok(rid, bell.context);
    assert.doesNotMatch(bell.context, /mail unavailable/);
    const list = run(['list']);
    assert.equal(list.status, 0, list.out);
    assert.match(list.stdout, new RegExp(`^${rid} \\|`, 'm'));
    assert.match(list.stderr, new RegExp(`mail of thread b2 with the settings of .*${path.basename(fx.brainB)}`));
    const recv = run(['receive', '--id', rid]);
    assert.equal(recv.status, 0, recv.out);
    assert.match(recv.stdout, /ANSWER users\(id\)/);
    assert.match(run(['list']).stdout, /no waiting messages/);
    // register needs the brain of the topic: still refused.
    assert.match(run(['register']).stderr, /brain unavailable/);
  } finally { await comms.stop(); fx.cleanup(); }
});
