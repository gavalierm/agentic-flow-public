// ttl: 2026-12-15
// flow-1-8-1 (2026-11-15): `comms message --id` of a final message (undelivered, done/*) printed the old interim answer of
// the mail (`busy since …: … send nothing again and do not raise the level`) and the line `the answer is interim …; do not
// resend or escalate (P-061)` next to `undelivered: Thread … is archived`: the opposite of the undelivered bell. A final
// message shows neither; an undelivered one gets the step of the skill comms (promote, send elsewhere, ask the operator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const AT = '2026-11-15T11:17:00.000Z';

test('message --id of a final message prints no interim answer of the mail; undelivered names its step', () => {
  const fx = setup();
  try {
    const stateFile = path.join(fx.root, 'stub-state.json');
    Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile });
    fs.writeFileSync(stateFile, JSON.stringify({
      message: {
        'm-und': { id: 'm-und', status: 'undelivered', level: 'assist', to: 'agentic-flow/x', code_answer: 'busy', code_answer_at: AT, undelivered_reason: 'Thread mcp:t-1 is archived (T3 status)', wait_due_at: AT },
        'm-wd': { id: 'm-wd', status: 'done', resolution: 'withdrawn', level: 'steer', to: 'agentic-flow/x', code_answer: 'otázka', code_answer_at: AT },
        'm-busy': { id: 'm-busy', status: 'pending', level: 'assist', to: 'agentic-flow/x', code_answer: 'busy', code_answer_at: AT, wait_due_at: AT },
      },
    }));
    const und = fx.run('comms.mjs', ['message', '--id', 'm-und']);
    assert.equal(und.status, 0, und.out);
    assert.match(und.stdout, /^m-und \| assist \| to agentic-flow\/x \| undelivered \| not picked \| no answer \| undelivered: Thread mcp:t-1 is archived \(T3 status\)$/m);
    assert.doesNotMatch(und.stdout, /busy since|send nothing again|the answer is interim|do not resend|checks again/);
    assert.match(und.stdout, /^undelivered: .*promote it to blocker .*send it elsewhere, or ask the operator; a message no longer needed needs nothing \(P-047\)$/m);

    const wd = fx.run('comms.mjs', ['message', '--id', 'm-wd']);
    assert.equal(wd.status, 0, wd.out);
    assert.match(wd.stdout, /^m-wd \| steer \| to agentic-flow\/x \| done\/withdrawn \| not picked \| no answer$/m);
    assert.doesNotMatch(wd.stdout, /otázka since|the answer is interim/);

    // An open message keeps the interim answer of the mail and its line (P-061).
    const busy = fx.run('comms.mjs', ['message', '--id', 'm-busy']);
    assert.equal(busy.status, 0, busy.out);
    assert.match(busy.stdout, /\| busy since .*send nothing again and do not raise the level \(answer set by the mail\) \| the mail checks again /);
    assert.match(busy.stdout, /^the answer is interim: the mail rings you at its next check; do not resend or escalate \(P-061\)$/m);
  } finally { fx.cleanup(); }
});
