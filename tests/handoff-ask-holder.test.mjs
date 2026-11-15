// keep: core
// agent-alice/D-0082, point 5 (observed 2026-11-15): the orchestrator asked the operator in a dialog the same thing the
// operator had already decided in the thread of topic domain-migrate. A dialog about the scope of an open topic another
// thread holds is refused (a judge compares the content, the dialog names no topic id, D-0039): the question goes to the
// holder by mail. A repeat in a bell turn is refused again; a turn the operator started lets it pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

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
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

test('a dialog about the scope of a topic another thread holds is refused, also when repeated; the judge decides by content', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén Alfa a Beta', '--for-thread', 't2']).status, 0);
    // the stall check of the handoff (D-0084) is a timer: with it a mail bell without mail ends quietly before any dialog
    assert.equal(fx.run('timer.mjs', ['cancel', '--all']).status, 0);
    const yes = judge(fx, 'yes', OVERLAP);
    // a bell turn (a turn the operator started passes, tests/ask-holder-turn.test.mjs)
    fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic orch' });
    let r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(r.json));
    assert.match(reason(r), /this question belongs to topic domain-migrate \(held by t2, scope: migrácia domén Alfa a Beta\)/);
    assert.match(reason(r), /comms send --to domain-migrate --level assist/);
    const prompt = fs.readFileSync(path.join(fx.root, 'yes.prompt'), 'utf8');
    assert.match(prompt, /domain-migrate/);
    assert.match(prompt, /ktorú doménu presunúť/);
    // no pass on a repeat
    r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.equal(r.json.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(reason(r), /belongs to topic domain-migrate/);
    // the judge finds nothing: not refused for it
    r = fx.hook('pre-tool-use.mjs', dialog, { env: judge(fx, 'no', '{"overlaps":[]}') });
    assert.doesNotMatch(reason(r), /belongs to topic/);
    // no judge: passes
    r = fx.hook('pre-tool-use.mjs', dialog, { env: { WORKFLOW_OVERLAP_JUDGE: 'off' } });
    assert.doesNotMatch(reason(r), /belongs to topic/);
    // the operator asked about the topic in this thread: the question passes
    fx.hook('user-prompt-submit.mjs', { prompt: 'ako je na tom domain-migrate? opýtaj sa ma, čo ďalej' });
    r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.doesNotMatch(reason(r), /belongs to topic/);
  } finally { fx.cleanup(); }
});

test('no topic of another thread: the judge is not asked', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    const yes = judge(fx, 'yes', OVERLAP);
    const r = fx.hook('pre-tool-use.mjs', dialog, { env: yes });
    assert.doesNotMatch(reason(r), /belongs to topic/);
    assert.ok(!fs.existsSync(path.join(fx.root, 'yes.prompt')));
  } finally { fx.cleanup(); }
});
