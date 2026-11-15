// ttl: 2026-12-15
// agent-alice/D-0082, point 5 (observed 2026-11-15, right after v1.7.4): the operator asked a question in the orchestrator's
// thread, in a turn the operator started; the dialog with the answer was refused twice as a question of topic close-after-bell
// ("send it to its holder"). And a topic thread with an orchestrator sends its operator question to the orchestrator (P-064),
// which could not ask it either: a deadlock. The dialog passes in a turn the operator started, and in a bell turn in which
// this thread received mail from that topic or its holder; a bell turn without it is refused as before. The handoff scope
// carries the topic's subject, not only --task ("Zadanie je v …task.md").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';
import { handoffView, readHandoffs } from '../scripts/handoff.mjs';

function judge(fx, name, body) {
  const f = path.join(fx.root, `${name}.sh`);
  fs.writeFileSync(f, `cat > ${JSON.stringify(path.join(fx.root, `${name}.prompt`))}\necho '${body}'\n`);
  return { WORKFLOW_OVERLAP_JUDGE: '', WORKFLOW_OVERLAP_JUDGE_CMD: `sh ${f}` };
}
const OVERLAP = '{"overlaps":[{"id":"domain-migrate","how":"pýta sa na domény Alfa a Beta"}]}';
const dialog = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{
    question: 'Migrácia domén na nový server pokračuje: ktorú doménu presunúť ako ďalšiu, keď Bratislava je už presunutá a beží?',
    header: 'Doména',
    options: [
      { label: 'Alfa (odporúčané)', description: 'presunie doménu Alfa, lebo má najmenej návštev a výpadok je lacný' },
      { label: 'Beta', description: 'presunie e-shop Beta ako ďalší' },
    ],
  }] },
};
const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || '';
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';
const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

function topics(fx) {
  assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
  const c = fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta', '--for-thread', 't2']);
  assert.equal(c.status, 0, c.out);
}

test('a turn the operator started: a dialog about the topic of another holder passes (the prompt names no topic)', () => {
  const fx = setup();
  try {
    topics(fx);
    const yes = judge(fx, 'yes', OVERLAP);
    fx.hook('user-prompt-submit.mjs', { prompt: 'aké záložné kontroly máš? navrhni, čo ďalej' });
    const r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.doesNotMatch(reason(r), /belongs to topic/, JSON.stringify(r.json));
    assert.notEqual(decision(r), 'deny');
  } finally { fx.cleanup(); }
});

test('a bell turn: refused without mail from that topic; passes after this thread received its question', { skip }, async () => {
  const fx = setup();
  const comms = await startComms(fx);
  try {
    topics(fx);
    const yes = judge(fx, 'yes', OVERLAP);
    const t2 = { WORKFLOW_THREAD_ID: 't2' };
    const send = fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project/orch', '--from', 'domain-migrate', '--text', 'otázka na operátora: ktorá doména ďalej? odporúčam Alfa'], { env: t2 });
    assert.equal(send.status, 0, send.out);
    const id = /sent (\S+) \(assist\)/.exec(send.stdout)?.[1];
    assert.ok(id, send.stdout);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic orch' });
    let r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.equal(decision(r), 'deny', 'a bell turn without the question of that topic is refused as before');
    assert.match(reason(r), /belongs to topic domain-migrate/);
    const recv = fx.run('comms.mjs', ['receive', '--id', id]);
    assert.equal(recv.status, 0, recv.out);
    r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.doesNotMatch(reason(r), /belongs to topic/, JSON.stringify(r.json));
    // the next bell turn is a new turn: the receive of the last one lets nothing pass (new mail waits, so the turn runs;
    // mail model 2: the picked message left the inbox, a bell without new mail ends without a model turn)
    assert.equal(fx.run('comms.mjs', ['send', '--level', 'assist', '--to', 'project/orch', '--from', 'domain-migrate', '--text', 'ešte jedna vec'], { env: t2 }).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic orch' });
    r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.match(reason(r), /belongs to topic domain-migrate/);
  } finally { await comms.stop(); fx.cleanup(); }
});

test('the handoff scope holds the subject with the task; the section shows the subject, not only the task file', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    const c = fx.run('topic.mjs', ['create', 'hook-fix', '--subject', 'Oprava hooku otázok', '--class', 'discussion', '--task', 'Zadanie je v /x/tmp/hook-fix-task.md', '--for-thread', 't2']);
    assert.equal(c.status, 0, c.out);
    const [rec] = readHandoffs(fx.brain, 'orch');
    assert.match(rec.scope, /Oprava hooku otázok/);
    assert.match(rec.scope, /hook-fix-task\.md/);
    assert.match(handoffView(fx.brain, 'orch').lines[0], /^- hook-fix: Oprava hooku otázok/);
  } finally { fx.cleanup(); }
});
