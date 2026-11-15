// ttl: 2026-12-15
// Steer into a running turn (workflow-dev step 4, P-061): a steer that comes while the thread works, also in a turn the
// operator started (a discussion, D-0015), is shown in the line after a tool, once, and the thread reads it in that turn;
// an assist still waits for the end of the discussion (D-0022). The waiting mail is the inbox of the mail's obligations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const skipMail = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';
const tool = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } };
const later = (fx) => {
  // the watch is throttled (WATCH_INTERVAL_MS): the next tool call is a later one
  const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), watch_at: 0 }));
};

test('a steer in a discussion turn is shown after a tool once; an assist is not', () => {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  fs.writeFileSync(stateFile, JSON.stringify({}));
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'poďme to prebrať' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8')).discussion, true);
    fs.writeFileSync(stateFile, JSON.stringify({ messages: [{ id: 'm-st1', level: 'steer', topic: 'alpha' }, { id: 'm-as1', level: 'assist', topic: 'alpha' }] }));
    later(fx);
    const r = fx.hook('post-tool-use.mjs', tool);
    assert.match(r.context, /mail waiting: m-st1 steer; read with comms receive --id <id>; steer: read it now/);
    assert.doesNotMatch(r.context, /m-as1/);
    later(fx);
    assert.doesNotMatch(fx.hook('post-tool-use.mjs', tool).context, /m-st1/, 'once per message');
  } finally { fx.cleanup(); }
});

test('the running thread picks the steer up in the same turn: the mail shows it read', { skip: skipMail }, async () => {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'poďme to prebrať' });
    const s = fx.runB('comms.mjs', ['send', '--level', 'steer', '--to', 'project/alpha', '--text', 'zmena priority: najprv B']);
    assert.equal(s.status, 0, s.out);
    const id = /sent (\S+) \(steer\)/.exec(s.stdout)[1];
    later(fx);
    assert.match(fx.hook('post-tool-use.mjs', tool).context, new RegExp(`mail waiting: ${id} steer;`));
    const got = fx.run('comms.mjs', ['receive', '--id', id]);
    assert.equal(got.status, 0, got.out);
    assert.match(got.stdout, /najprv B/);
    assert.match(fx.runB('comms.mjs', ['message', '--id', id]).stdout, /\| done\/read \|/);
  } finally { await comms.stop(); fx.cleanup(); }
});
