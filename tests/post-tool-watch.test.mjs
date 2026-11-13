// P-041, P-042: the PostToolUse watch tells the main thread once that a blocker or steer waits (ids and levels only),
// at most every 15 s; assist is not watched; a subagent is not watched; an outage is silent. Comms client is a stub
// (tests/fixtures/comms-stub.mjs), so no server is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';
import { watchLine, WATCH_INTERVAL_MS } from '../hooks/post-tool-use.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const BASH = { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } };

function stubbed(state) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  const set = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  set(state);
  const threadFile = path.join(fx.brain, 'local', 'threads', 'a1.json');
  // A throttle window passes: the watch runs again on the next tool call.
  const expired = () => {
    const st = fs.existsSync(threadFile) ? JSON.parse(fs.readFileSync(threadFile, 'utf8')) : {};
    fs.mkdirSync(path.dirname(threadFile), { recursive: true });
    fs.writeFileSync(threadFile, JSON.stringify({ ...st, watch_at: Date.now() - WATCH_INTERVAL_MS - 1 }));
  };
  return { fx, set, expired };
}

test('watchLine names only new blocker and steer ids; assist is not watched; each id once', () => {
  const items = [{ id: 'm1', level: 'blocker' }, { id: 'm2', level: 'assist' }, { id: 'm3', level: 'steer' }];
  const first = watchLine(items, []);
  assert.equal(first.line, 'mail waiting: m1 blocker, m3 steer; read with comms receive --id <id>; steer: read it now and adjust the work on the topic to it, then continue working; a message never stops the work (P-042, P-061)');
  assert.deepEqual(first.seen, ['m1', 'm3']);
  assert.equal(watchLine(items, first.seen), null, 'announced once');
  assert.equal(watchLine([{ id: 'm2', level: 'assist' }], []), null, 'assist is not watched');
});

test('PostToolUse watch: announced once per message, throttled to 15 s, silent on outage and for subagents', () => {
  const { fx, set, expired } = stubbed({ messages: [{ id: 'm1', level: 'blocker' }] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    expired();

    // A blocker waits: one line with its id and level.
    let r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, 'mail waiting: m1 blocker; read with comms receive --id <id> (P-042)');

    // The next tool call within 15 s does not run the watch at all.
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, '', 'throttled');

    // The same blocker after the window: announced once only.
    expired();
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, '', 'the same message is not announced again');

    // A steer arrives: only the new id is announced.
    set({ messages: [{ id: 'm1', level: 'blocker' }, { id: 'm4', level: 'steer' }] });
    expired();
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, 'mail waiting: m4 steer; read with comms receive --id <id>; steer: read it now and adjust the work on the topic to it, then continue working; a message never stops the work (P-042, P-061)');

    // Subagents are not watched.
    set({ messages: [{ id: 'm5', level: 'blocker' }] });
    expired();
    r = fx.hook('post-tool-use.mjs', { ...BASH, agent_id: 'sub1', agent_type: 'worker' });
    assert.equal(r.context, '', 'subagent: no watch');

    // Outage: silent, no line and no error.
    set({ down: true, messages: [{ id: 'm6', level: 'blocker' }] });
    expired();
    r = fx.hook('post-tool-use.mjs', BASH);
    assert.equal(r.context, '', 'silent on outage (P-041)');
    assert.equal(r.status, 0);
  } finally {
    fx.cleanup();
  }
});
